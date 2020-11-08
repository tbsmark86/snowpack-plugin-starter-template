import type { SnowpackPluginFactory, SnowpackConfig } from 'snowpack';

import * as ts from 'typescript';
import { ESLint } from 'eslint';
import * as http from 'http';
import * as fs from 'fs/promises';
import * as path from 'path';

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
    // eslint pattern, defaults to './'
    eslintFiles?: string|string[];
}


const plugin: SnowpackPluginFactory<Options> = (snowpackConfig: SnowpackConfig, opt?: Options) => {
    const rootDir = ts.sys.getCurrentDirectory();

    let debug = function(..._args: any[]) {};
    if(opt?.debug) {
	debug = function(...args: any[]) {console.debug(...args)};
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
		    console.error(`Failed to execute typescript-watcher for ${file}`, err);
		}
	    }
	}
    }

    const host = 'http://'+ snowpackConfig.devOptions.hostname + ':' +snowpackConfig.devOptions.port + '/';
    const karmaOutput = opt?.karmaOutput ? path.join(rootDir, opt.karmaOutput) : false;
    function outputFileForKarma(file: string) {
	if(!karmaOutput) {
	    return;
	}
	http.get(host + file, (res) => {
	    const { statusCode } = res;
	    if (statusCode !== 200) {
		console.error(`Can\'t generate file for karma. Got ${statusCode} for ${file} from snowpack-server`);
		res.resume();
		return;
	    }
	    res.setEncoding('utf8');
	    let rawData = '';
	    res.on('data', (chunk) => { rawData += chunk; });
	    res.on('end', async () => {
		let karmaFile = path.join(karmaOutput, file);
		debug('Write for karma', karmaFile);

		if(opt?.karmaFilter) {
		    rawData = opt?.karmaFilter(file, rawData);
		}

		try {
		    await fs.mkdir(path.dirname(karmaFile), {recursive:true})
		    await fs.writeFile(karmaFile, rawData, 'utf-8');
		    debug('Push to karma', karmaFile);
		} catch(err) {
		    console.error(`Can\'t write ${karmaFile} for karma`, err);
		}
	    });
	}).on('error', (e) => {
	    console.error(`Can\'t request ${file} for from snowpack-server`, e);
	});
    }

    function initKarma() {
	if(!karmaOutput) {
	    debug('karma disabled');
	    return;
	}
	debug('start karma');
	const Karma = require('karma').Server
	const karmaConfig = { configFile: path.join(rootDir, opt?.karmaConf ?? 'karma.conf.js') };
	const karma = new Karma(karmaConfig, function(exitCode: any) {
	    console.error('Karma has exited with ' + exitCode)
	});
	karma.start()
    }

    // Based on https://github.com/Microsoft/TypeScript/wiki/Using-the-Compiler-API
    // create a full typescript watch mode but don't emit files only diagnostics
    function initTypescript(finished: Function) {
	debug('setup typescript');
	const tsconfig = opt?.tsconfig ?? 'tsconfig.json';
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
	    if(status !== Status.HasError) {
		finished();
	    }
	    status = Status.Done;
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
	    console.log('[ts-es-karma] Run typescript check ...');
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


	// Intercept emit to not emit anything but instead retrive the normal
	// build result from snowpack. This result is then saved to a temporary
	// directory where karma can pick it up.
	(host as any).writeFile = (file: string) => {
	    let relfile = file.replace(absBuildDir, '');
	    debug('Typescript Hook writeFile', file, relfile);
	    outputFileForKarma(relfile);
	};

	ts.createWatchProgram(host);
    }

    function initEslint() {
	// API Doc: https://eslint.org/docs/developer-guide/nodejs-api
	const eslint = new ESLint({
	    cache: true,
	    cacheLocation: path.join(rootDir, 'node_modules', 'ts-es-karma_eslintcache')
	});
	let formatter = {format: (_results: any) => console.error('missing eslint formatter') };
	eslint.loadFormatter('stylish').then((res) => formatter = res);

	return function() {
	    let done = false;
	    debug('start eslint');
	    eslint.lintFiles(opt?.eslintFiles ?? './').then((results) => {
		if(!done) {
		    done = true;
		    console.log(formatter.format(results));
		} else {
		    debug('Strange duplicate resolve of eslint promise');
		}
	    }).catch((err) => {
		console.error('Eslint Failed', err);
	    });
	}
    }
    const eslintExecutor = initEslint();

    return {
	// shorter name tag here
	name: "ts-es-karma",

	config(realConfig: SnowpackConfig) {
	    snowpackConfig = realConfig;
	},
	run() {
	    // slightly decouple this startup so snowpack can finish first
	    new Promise((resolve) => resolve()).then(() => {
		initTypescript(eslintExecutor);
		initKarma();
	    });
	    return new Promise(() => {});
	},
	onChange(arg) {
	    onChanged(arg.filePath);
	},
    };
};

export default plugin;
