import { opt } from '../../../js/containers/app.js';

const config = JSON.parse(/** @type {HTMLElement} */ (document.getElementById('viewer-config'))?.dataset.config || '{}');
if (config.workers === 'fetch') opt.fetchWorkerScripts = true;

// Every open editor is its own page with its own worker pools, so their memory repeats per open document.
opt.workerN = 2;
