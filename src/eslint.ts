
import { ESLint } from 'eslint';
import * as worker from 'worker_threads';

if(!worker.parentPort) {
    throw new Error('Should be started as WebWorker!');
}

function error(...args: any[]) {
    console.error('[ts-es-karma]', ...args);
}

// API Doc: https://eslint.org/docs/developer-guide/nodejs-api
const eslint = new ESLint(worker.workerData.initOpt)
let formatter = {format: (_results: any) => error('missing eslint formatter') };
eslint.loadFormatter('stylish').then((res: any) => formatter = res);

worker.parentPort.on('message', (type) => {
    if(type === 'run') {
	let done = false;
	//console.debug('start eslint');
	eslint.lintFiles(worker.workerData.runOpt).then((results) => {
	    if(!done) {
		done = true;
		console.log(formatter.format(results));
	    } else {
		//console.debug('Strange duplicate resolve of eslint promise');
	    }
	    worker?.parentPort?.postMessage('done');
	}).catch((err) => {
	    error('Eslint Failed', err);
	});
    } else {
	error('Unknown message type');
    }
});

