
import { ESLint } from 'eslint';
import * as worker from 'worker_threads';
import * as colors from 'colors/safe.js';
// some import troubles require this; Because this runs as esm in node
// because pika can't bundle the worker file
// See:	https://github.com/snowpackjs/builders/issues/15
//  and our special cp in the build action
const c = (colors as any).default;

if(!worker.parentPort) {
    throw new Error('Should be started as WebWorker!');
}

let debug = function(..._args: any[]) {};
if(worker.workerData.debug) {
    debug = function(...args: any[]) {
	console.debug(c.white('[ts-es-karma]'), ...args)
    };
}
function error(...args: any[]) {
    console.error(c.red('[ts-es-karma]'), ...args);
}

// API Doc: https://eslint.org/docs/developer-guide/nodejs-api
const eslint = new ESLint(worker.workerData.initOpt)
let formatter = {format: (_results: any) => error('missing eslint formatter') };
eslint.loadFormatter('stylish').then((res: any) => formatter = res);

worker.parentPort.on('message', (type) => {
    if(type === 'run') {
	let done = false;
	debug('start eslint');
	eslint.lintFiles(worker.workerData.runOpt).then((results) => {
	    if(!done) {
		done = true;
		console.log(formatter.format(results));
	    } else {
		debug('Strange duplicate resolve of eslint promise');
	    }
	    worker?.parentPort?.postMessage('done');
	}).catch((err) => {
	    error('Eslint Failed', err);
	});
    } else {
	error('Unknown message type');
    }
});

