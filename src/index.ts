#!/usr/bin/env node
import * as fs from 'fs-extra';
import * as glob from 'glob';
import chalk from 'chalk';
import {resolve, relative, join, basename} from 'path';
import {FSWatcher, watch} from 'chokidar';
import {onProcessExit, ThrottleTime} from "./utils";

function printUsage() {
    console.log('Usage: `cd` into your root package folder first, then execute');
    console.log('npm-local-development <package1-name> <package1-source> <package2-name> <package2-source> ... [--no-watcher]');
    console.log('or to use Lerna');
    console.log('npm-local-development lerna [--no-watcher]');
    console.log('or to read config .sync.json:');
    console.log('npm-local-development config [--no-watcher]');
}

async function sync(cwd: string, packageName: string, packageSource: string, watching = true) {
    const ignored: string[] = [];

    const packageJsonPath = join(cwd, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
        throw new Error(`package.json not found in current directory. Make sure you're in the right directory. (you're in ${cwd})`);
    }
    const rootPackage = fs.readJSONSync(packageJsonPath) || {};
    const rootPackageName = rootPackage['name'];
    const packagePathInRootNodeModules = resolve(cwd, 'node_modules', packageName);

    if (!packagePathInRootNodeModules) {
        throw new Error(`Dependency ${packageName} not found. Install it first.`);
    }

    if (!packageSource) {
        throw new Error(`Dependency source ${packageName} not defined.`);
    }

    if (!fs.existsSync(packageSource)) {
        throw new Error(`Dependency source ${packageName} in '${packageSource}' not found. Install it first.`);
    }

    let peerDeps = {};
    let peerDepsArray: string[] = [];

    function log(...args) {
        console.log(chalk.green(rootPackageName), ...args);
    }

    function readDeps() {
        const modulePackage = fs.readJSONSync(join(packageSource, 'package.json')) || {};
        peerDeps = modulePackage['peerDependencies'] || {};

        for (const i in peerDeps) {
            ignored.push(join(packageSource, 'node_modules', i) + '/**/*');
            peerDepsArray.push(i);
        }
    }

    let closed = false;
    const watchers: FSWatcher[] = [];

    readDeps();

    if (watching) {
        //we reset the state back when we had a watcher running
        onProcessExit(async () => {
            closed = true;
            for (const watcher of watchers) {
                watcher.close();
            }

            log(`Exiting, reverting directory structure for ${rootPackageName} (${packagePathInRootNodeModules})`);
            await fs.remove(packagePathInRootNodeModules);
            await fs.ensureSymlink(packageSource, packagePathInRootNodeModules);
        });
    }

    if (await fs.pathExists(packagePathInRootNodeModules)) {
        await fs.remove(packagePathInRootNodeModules);
    }

    async function updateNodeModulesSymLinks() {
        if (closed) return;

        await fs.remove(join(packagePathInRootNodeModules, 'node_modules'));

        const packageNodeModules = join(packageSource, 'node_modules');
        const rootNodeModules = join(packagePathInRootNodeModules, 'node_modules');

        for (const file of await fs.readdir(packageNodeModules)) {
            const stat = await fs.lstat(join(packageNodeModules, file));
            if (!stat.isDirectory()) {
                continue;
            }

            const packageJsonPath = join(packageNodeModules, file, 'package.json');
            if (await fs.pathExists(packageJsonPath)) {
                // log('symlink', join(packageNodeModules, file), join(rootNodeModules, file));
                fs.ensureSymlinkSync(join(packageNodeModules, file), join(rootNodeModules, file));
            } else {
                await fs.ensureDir(join(rootNodeModules, file));
                for (const subFile of await fs.readdir(join(packageNodeModules, file))) {
                    const stat = await fs.lstat(join(packageNodeModules, file, subFile));
                    if (!stat.isDirectory()) {
                        continue;
                    }

                    // log('symlink', join(packageNodeModules, file, subFile), join(rootNodeModules, file, subFile));
                    fs.ensureSymlinkSync(join(packageNodeModules, file, subFile), join(rootNodeModules, file, subFile));
                }
            }
        }

        for (const dep of peerDepsArray) {
            await fs.remove(join(rootNodeModules, dep));
        }
    }

    try {
        await fs.copy(packageSource, packagePathInRootNodeModules, {
            filter: (path, dest) => {
                if (-1 !== path.indexOf('/node_modules/')) {
                    return false;
                }
                return true;
            }
        });
    } catch (error) {
        console.error('Error in copying', packageSource, 'to', packagePathInRootNodeModules);
        console.error(error);
    }

    await updateNodeModulesSymLinks();

    if (watching) {
        const throttledUpdateNodeModulesSymLinks = ThrottleTime(() => updateNodeModulesSymLinks(), 1);

        /**
         * What for changes in the origin package source, e.g. '../core/package.json', this is important
         * to re-read peerDependencies.
         */
        watchers.push(watch(packageSource + '/package.json', {
            ignoreInitial: true,
            ignored: ['.git'],
            followSymlinks: false
        }).on('all', (event, path) => {
            log('package.json changed, reload.');
            readDeps();
            throttledUpdateNodeModulesSymLinks();
        }));


        /**
         * Watch for changes in origin package source, e.g. '../core/', so we can copy
         * files manually to our root package's node_modules/{packageName}/
         */
        watchers.push(watch(packageSource, {
            ignoreInitial: true,
            followSymlinks: false
        }).on('all', async (event, path) => {
            if (path.startsWith(resolve(join(packageSource, 'node_modules')))) return;

            const target = join(packagePathInRootNodeModules, relative(packageSource, path));

            // log(event, relative(cwd, path), '->', relative(packageSource, path));

            if (event === 'unlink') {
                fs.unlink(target);
            } else {
                fs.copy(path, target);
            }
        }));
    }
}

async function run() {
    if (!process.argv[2] || process.argv[2] === '-h' || process.argv[2] === '--help') {
        printUsage();
        return;
    }

    const watching = process.argv.filter(v => v === '--no-watcher').length === 0;
    process.argv = process.argv.filter(v => v !== '--no-watcher');

    const cwd = process.cwd();
    if ('lerna' === process.argv[2]) {
        const lernaConfig = fs.readJSONSync(join(cwd, 'lerna.json'));
        if (!lernaConfig) {
            throw new Error(`Could not find lerna.json`);
        }

        if (!lernaConfig['packages']) {
            throw new Error(`No 'packages' defined in lerna.json`);
        }

        //name to package dir
        const packages: { [name: string]: string } = {};

        for (const packageGlob of lernaConfig['packages']) {
            const thisPkgs = glob.sync(packageGlob, {
                ignore: ['node_modules']
            });

            for (const pkg of thisPkgs) {
                const pkgConfig = fs.readJSONSync(join(cwd, pkg, 'package.json'));
                packages[pkgConfig['name']] = pkg;
            }
        }

        const promises: Promise<void>[] = [];
        for (const pkg in packages) {
            const path = packages[pkg];

            try {
                const pkgConfig = fs.readJSONSync(join(cwd, path, 'package.json'));

                const deps = pkgConfig['dependencies'] || {};
                const devDeps = pkgConfig['devDependencies'] || {};
                const depsToSync: { [name: string]: string } = {};

                for (const pkgDep in packages) {
                    if (deps[pkgDep]) {
                        depsToSync[pkgDep] = packages[pkgDep];
                    } else if (devDeps[pkgDep]) {
                        depsToSync[pkgDep] = packages[pkgDep];
                    }
                }

                for (const depToSync in depsToSync) {
                    console.log(`${chalk.green(packages[pkg])} -> ${chalk.green(depToSync)} (${depsToSync[depToSync]})`);
                    promises.push(sync(join(cwd, packages[pkg]), depToSync, join(cwd, depsToSync[depToSync]), watching));
                }
            } catch (error) {
                throw new Error(`Could not read package.json of ${path}`);
            }
        }

        if (promises.length === 0) {
            console.error('No packages deps found.');
            process.exit(1);
            return;
        }

        await Promise.all(promises);
        console.log('Ready');

    } else if ('config' === process.argv[2]) {
        console.log("Read .sync.json ...");
        //read .sync.json
        if (!fs.existsSync(join(cwd, '.sync.json'))) {
            throw new Error(`No .sync.json file found in current directory.`);
        }

        const syncConfig = fs.readJSONSync(join(cwd, '.sync.json'));
        const promises: Promise<void>[] = [];

        for (const cwd in syncConfig) {
            console.log(`${chalk.green(cwd)}`);
            for (const i in syncConfig[cwd]) {
                const packageName = i;
                const packageSource = syncConfig[cwd][i];
                console.log(`  ${chalk.green(packageName)} -> ${chalk.green(packageSource)}`);
                promises.push(sync(cwd, packageName, packageSource, watching));
            }
        }

        await Promise.all(promises);
        console.log('Ready');

    } else if (process.argv.length > 2) {
        const names = process.argv.slice(2);
        const packages: { [name: string]: string } = {};

        for (let i = 0; i < names.length; i += 2) {
            packages[names[i]] = names[i + 1];
        }

        const promises: Promise<void>[] = [];

        for (const i in packages) {
            console.log(`${chalk.green(i)} -> ${chalk.green(packages[i])}`);
            promises.push(sync(cwd, i, packages[i], watching));
        }

        await Promise.all(promises);
        console.log('Ready');
    }
}

run();
