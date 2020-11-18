import type { SnowpackPluginFactory, SnowpackConfig } from 'snowpack';

import * as ts from 'typescript';
import * as http from 'http';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as colors from 'colors/safe';
import * as worker from 'worker_threads';

interface Options {
    // print extra debug info
    debug?: boolean;
    // alternate name for 'tsconfig.json'
    tsconfig?: string;
    // where to write temporary files for karma unset to disable
    // (relative to current dir)
    karmaOutput?: string;
    // Transform File before writing to karmaOutput
    karmaFilter?: (filename: string, content: string) => string;
    // alternate name for 'karma.config.js'
    karmaConf?: string;
    // don't start Karma
    karmaDisable?: boolean;
    // eslint pattern, defaults to './'
    eslintFiles?: string|string[];
    // switch eslint handling
    eslintRun?: 'never'|'force'|'normal';
}

const plugin: SnowpackPluginFactory<Options> = (snowpackConfig: SnowpackConfig, opt_in?: Options) => {
    const rootDir = ts.sys.getCurrentDirectory();
    const opt: Options = opt_in ?? {}

    let debug = function(..._args: any[]) {};
    if(opt.debug) {
	debug = function(...args: any[]) {
	    // white is grey ???
	    console.debug(colors.white('[ts-es-karma]'), ...args)
	};
    }
    function info(...args: any[]) {
	console.info(colors.green('[ts-es-karma]'), ...args);
    }
    function error(...args: any[]) {
	console.error(colors.red('[ts-es-karma]'), ...args);
    }

    // Map Watche Requests form Typescript to Snowpack
    let watched: Record<string, Function[]> = {};
    // register Typescript watch
    function addWatched(file: string, callback: Function): ts.FileWatcher {
	if(!watched[file]) {
	    watched[file] = [];
	}
	watched[file].push(callback);
	return { close: function() { /*TODO*/} };
    }
    // publish Snowpack change
    function onChanged(file: string) {
	if(watched[file]) {
	    for(const cb of watched[file]) {
		try {
		    cb(file, ts.FileWatcherEventKind.Changed);
		} catch(err) {
		    error(`Failed to execute typescript-watcher for ${file}`, err);
		}
	    }
	}
    }

    const host = 'http://'+ snowpackConfig.devOptions.hostname + ':' +snowpackConfig.devOptions.port + '/';
    let karmaOutput = opt.karmaOutput ? path.join(rootDir, opt.karmaOutput) : false;
    // delay karma start until first file is written
    let startKarmaServer: Function|null = null;
    function outputFileForKarma(file: string) {
	if(!karmaOutput) {
	    return;
	}
	debug('request file from snowpack builder', file);
	http.get(host + file, (res) => {
	    const { statusCode } = res;
	    if (statusCode !== 200) {
		error(`Can\'t generate file for karma. Got ${statusCode} for ${file} from snowpack-server`);
		res.resume();
		return;
	    }
	    res.setEncoding('utf8');
	    let rawData = '';
	    res.on('data', (chunk) => { rawData += chunk; });
	    res.on('end', async () => {
		let karmaFile = path.join(karmaOutput as string, file);
		debug('Write for karma', karmaFile);

		if(opt.karmaFilter) {
		    rawData = opt.karmaFilter(file, rawData);
		}

		try {
		    await fs.mkdir(path.dirname(karmaFile), {recursive:true})
		    await fs.writeFile(karmaFile, rawData, 'utf-8');
		    debug('Push to karma', karmaFile);
		} catch(err) {
		    error(`Can\'t write ${karmaFile} for karma`, err);
		}
		startKarmaServer && startKarmaServer();
	    });
	}).on('error', (e) => {
	    error(`Can\'t request ${file} for from snowpack-server`, e);
	});
    }

    function initKarma() {
	if(!karmaOutput || opt.karmaDisable) {
	    info('Karma Disabled (Only allowed in dev mode)');
	    return;
	}
	debug('start karma');
	const Karma = require('karma').Server
	const karmaConfig = { configFile: path.join(rootDir, opt.karmaConf ?? 'karma.conf.js') };
	const karma = new Karma(karmaConfig, function(exitCode: any) {
	    error('Karma has exited with ' + exitCode)
	});
	// On the first start there are no output-files available therefore
	// karama complains over non-matching patterns.
	// To work around this wait for the first file written (and a bit more)
	// before actually starting the server.
	//
	// Beside this it also is more 'sane' to start on after each other.
	startKarmaServer = function() {
	    setTimeout(function() {
		info('Start Karma');
		karma.start();
	    }, 50);
	    startKarmaServer = null;
	}
	// Handle SIGINT manually otherwise you need to press it twice to
	// first kill karma
	process.on('SIGINT', function() {
	    info('Exiting ...');
	    karma.stop();
	    process.exit();
	});
    }

    // Based on https://github.com/Microsoft/TypeScript/wiki/Using-the-Compiler-API
    // create a full typescript watch mode but don't emit files only diagnostics
    function initTypescript(finished: (ok: boolean)=>void) {
	debug('setup typescript');
	const tsconfig = opt.tsconfig ?? 'tsconfig.json';
	if (!ts.sys.fileExists(tsconfig)) {
	    throw new Error("Could not find a valid `${tsconfig}`.");
	}

	const formatHost = {
	    getCanonicalFileName: (file: string) => file,
	    getCurrentDirectory: ts.sys.getCurrentDirectory,
	    getNewLine: () => ts.sys.newLine
	};

	// Builder that will only recheck & remit changed files
	const createProgram = ts.createEmitAndSemanticDiagnosticsBuilderProgram;

	// Hook Watcher with snowpack watcher to keep everything
	// in sync (and avoid duplicate watching)
	//watchFile?(path: string, callback: FileWatcherCallback, pollingInterval?: number, options?: WatchOptions): FileWatcher;
	ts.sys.watchFile = function(file: string, callback: Function) {
	    return addWatched(file, callback);
	};
	// Snowpack does not include a Directory-Watcher ...
	// ignore it for now (need to restart on new file?)
	//watchDirectory?(file: string, callback: DirectoryWatcherCallback, recursive?: boolean, options?: WatchOptions): FileWatcher;
	ts.sys.watchDirectory = function(_file: string, _callback: Function) {
	    return { close: function() {} };
	};

	enum Status {
	    Running,
	    Done,
	    HasError
	}
	let status: Status = Status.Done;

	function reportDiagnostic(diagnostic: ts.Diagnostic) {
	    console.log(ts.formatDiagnosticsWithColorAndContext([diagnostic], formatHost).trimEnd());
	    if(diagnostic.category == 1) {
		status = Status.HasError;
	    }
	}
	function reportWatchStatusChanged(diagnostic: ts.Diagnostic) {
	    console.info(ts.formatDiagnosticsWithColorAndContext([diagnostic], formatHost).trimEnd());
	    if(diagnostic.code == 6032 || diagnostic.code == 6031) {
		// Just starting a new round ...
		return;
	    }
	    debug('Done typescript check.', Status.HasError ? 'With Errors' : 'Without Error');
	    finished(status !== Status.HasError);
	    flushWrites(status !== Status.HasError);
	}

	const host = ts.createWatchCompilerHost(
	    tsconfig, {},
	    ts.sys,
	    createProgram,
	    reportDiagnostic,
	    reportWatchStatusChanged
	);

	// XXX getSuggestionDiagnostics ?
	/* program. ...v
	//             getSyntacticDiagnostics,
            getOptionsDiagnostics,
            getGlobalDiagnostics,
            getSemanticDiagnostics,
            getCachedSemanticDiagnostics,
            getSuggestionDiagnostics,
            getDeclarationDiagnostics,
            getBindAndCheckDiagnostics,
            getProgramDiagnostics,
	    */

	const origCreateProgram = host.createProgram;
	host.createProgram = (rootNames, options, host, oldProgram) => {
	    info('Run typescript check ...');
	    status = Status.Running;
	    return origCreateProgram(rootNames, options, host, oldProgram);
	};

	const origAfterProgramCreate = host.afterProgramCreate;
	let absBuildDir = rootDir + path.sep;
	host.afterProgramCreate = (program) => {
	    const options = program.getCompilerOptions();
	    if(options && options.outDir) {
		// path is already absolute
		absBuildDir = options.outDir + path.sep;
	    }
	    origAfterProgramCreate && origAfterProgramCreate(program);
	    host.afterProgramCreate = origAfterProgramCreate;
	}

	let pendingWriteFiles: Record<string, boolean> = {};
	
	// Intercept emit to not emit anything but instead retrive the normal
	// build result from snowpack. This result is then saved to a temporary
	// directory where karma can pick it up.
	(host as any).writeFile = (file: string) => {
	    debug('Typescript Hook writeFile', file);
	    if(status === Status.Done) {
		error(`Unexpected write of ${file} from typescript postponed`);
	    }
	    // However: We can't write them out know for tow reasons
	    // a) the process is still busy doing typechecking and snowpack
	    //    can't react
	    // b) don't run karma if the code contains a critical error later on
	    pendingWriteFiles[file] = true;
	};

	// Do the real write for files collected in the writeFile Hook
	function flushWrites(ok: boolean) {
	    if(!ok) {
		debug('Skip karmaOutput because of Errors');
		return;
	    }
	    const todo = Object.keys(pendingWriteFiles);
	    pendingWriteFiles = {};
	    if(!todo.length) {
		info('No files changed');
		return;
	    }
	    info(`Write ${todo.length} files to Karma-Output`);
	    for(const file of todo) {
		let relfile = file.replace(absBuildDir, '');
		outputFileForKarma(relfile);
	    }
	}

	ts.createWatchProgram(host);
    }

    function initEslint(): (ok: boolean)=>Promise<void> {
	const mode = opt.eslintRun || 'normal';
	if(mode === 'never') {
	    return function(_ok) {return Promise.resolve();}
	}
	const cacheFile = path.join(rootDir, 'node_modules', '.cache', 'ts-es-karma_eslintcache')
	fs.mkdir(path.dirname(cacheFile)).catch(() => {/*ignore*/});

	debug('Start eslint worker thread');
	let workerUrl = new URL('./eslint.mjs', import.meta.url);

	// Execute eslint inside a worker Thread so it can't block creating
	// the karma output. Because for large projects it might take some time.
	const eslintWorker = new worker.Worker(workerUrl, {
	    workerData: {
		initOpt: {
		    cache: true, cacheLocation: cacheFile
		},
		runOpt: opt.eslintFiles ?? './',
		debug: opt.debug,
	    }
	} as any);

	let nextResolve: ()=>void|undefined;
	eslintWorker.on('message', (type) => {
	    if(type === 'done') {
		nextResolve && nextResolve();
	    }
	});

	return function(ok: boolean): Promise<void> {
	    if(!ok && mode === 'normal') {
		return Promise.resolve();
	    }
	    const ret = new Promise<void>((resolve) => {nextResolve = resolve});
	    eslintWorker.postMessage('run');
	    return ret;
	}
    }
    const eslintExecutor = initEslint();

    return {
	// shorter name tag here
	name: "ts-es-karma",

	config(realConfig: SnowpackConfig) {
	    snowpackConfig = realConfig;
	},
	run({isDev}) {
	    if(!isDev) {
		// Karma is not useful during build mode
		karmaOutput = false;
		opt.karmaDisable = true;
	    }

	    return new Promise(async (resolve) => {
		// slightly decouple this startup so snowpack can finish first
		await new Promise((resolve2) => resolve2())

		initTypescript(async (ok: boolean) => {
		    await eslintExecutor(ok);
		    // resolve run query once to allow snowpack to continue 
		    // when in build mode.
		    resolve();
		});
		initKarma();
	    });
	},
	onChange(arg) {
	    onChanged(arg.filePath);
	},
    };
};

export default plugin;
