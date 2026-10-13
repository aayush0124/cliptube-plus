'use strict';
const {contextBridge, ipcRenderer} = require('electron');
const copy = (value) => JSON.parse(JSON.stringify(value));
let state = {jobs: [], outputDir: '/mock/ClipTube UI fixtures'};
let tools = {ready: true, ytDlpVersion: 'mock-2026.10', ffmpegVersion: 'ffmpeg version mock-8.0', issues: []};
let calls = [];
let requestId = 0;
let jobId = 0;
let chooseResult = '/mock/ClipTube UI fixtures/Selected output';
const listeners = new Set();
const toolListeners = new Set();
const pending = new Map();
const inspected = new Map();
const failures = new Map();
const emit = () => {for (const callback of listeners) callback(copy(state));};
function call(action, value) {
  calls.push({action, value: value === undefined ? null : copy(value)});
  if (failures.has(action)) throw new Error(failures.get(action));
}
function getJob(id) {const job = state.jobs.find((item) => item.id === id); if (!job) throw new Error('Mock job does not exist.'); return job;}
contextBridge.exposeInMainWorld('cliptube', {
  bootstrap: async () => ({...copy(state), tools: copy(tools)}),
  inspect: (url) => {call('inspect', url); return new Promise((resolve, reject) => {pending.set(++requestId, {url, resolve, reject});});},
  enqueue: async (options) => {
    call('enqueue', options);
    const info = inspected.get(options.token);
    if (!info) throw new Error('Inspect the mock fixture first.');
    const choice = options.choiceId === 'best' ? info.choices[0] : info.choices.find((item) => item.id === options.choiceId);
    if (!choice) throw new Error('Mock format does not exist.');
    const job = {id: `mock-job-${++jobId}`, title: info.title, url: info.url, qualityLabel: choice.label, status: 'queued', progress: null, stage: 'Waiting in queue…', error: null, file: null, attempt: 1, updatedAt: new Date().toISOString(), speed: null, eta: null};
    state.jobs.push(job); emit(); return copy(job);
  },
  cancel: async (id) => {call('cancel', id); const job = getJob(id); Object.assign(job, {status: 'canceled', progress: null, stage: 'Canceled.', speed: null, eta: null, error: null}); emit(); return copy(job);},
  retry: async (id) => {call('retry', id); const job = getJob(id); Object.assign(job, {status: 'queued', attempt: (job.attempt || 0) + 1, progress: null, stage: 'Waiting in queue…', error: null, file: null, speed: null, eta: null}); emit(); return copy(job);},
  chooseFolder: async () => {call('chooseFolder'); if (chooseResult !== null) {state.outputDir = chooseResult; emit();} return chooseResult;},
  openFolder: async () => {call('openFolder');},
  showFile: async (id) => {call('showFile', id);},
  clearFinished: async () => {call('clearFinished'); state.jobs = state.jobs.filter((job) => !['completed', 'failed', 'canceled', 'interrupted'].includes(job.status)); emit();},
  onState: (callback) => {listeners.add(callback); return () => listeners.delete(callback);},
  onTools: (callback) => {toolListeners.add(callback); return () => toolListeners.delete(callback);},
});
contextBridge.exposeInMainWorld('__uiTest', {
  pending: () => [...pending].map(([id, entry]) => ({id, url: entry.url})),
  resolveInspection: (id, info) => {const entry = pending.get(id); if (!entry) throw new Error('Missing pending inspection.'); pending.delete(id); inspected.set(info.token, copy(info)); entry.resolve(copy(info));},
  rejectInspection: (id, message) => {const entry = pending.get(id); if (!entry) throw new Error('Missing pending inspection.'); pending.delete(id); entry.reject(new Error(message));},
  setState: (snapshot) => {state = {...state, ...copy(snapshot)}; emit();},
  getState: () => copy(state),
  setTools: (value) => {tools = copy(value); for (const callback of toolListeners) callback(copy(tools));},
  calls: () => copy(calls),
  clearCalls: () => {calls = [];},
  failAction: (action, message) => {if (message === null) failures.delete(action); else failures.set(action, message);},
  setChooseResult: (folder) => {chooseResult = folder;},
  close: () => ipcRenderer.send('ui-test:close'),
});
