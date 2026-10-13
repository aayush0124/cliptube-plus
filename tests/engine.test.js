'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {Queue, Engine, runProcess} = require('../lib/engine');
const {normalizeInfo} = require('../lib/media');

function metadata(overrides = {}) {
  return normalizeInfo({title: 'Fixture video', duration: 1, formats: [
    {format_id: 'low', width: 320, height: 180, vcodec: 'h264', acodec: 'aac', ext: 'mp4'},
    {format_id: 'high', width: 640, height: 360, vcodec: 'h264', acodec: 'aac', ext: 'mp4'},
  ], ...overrides}, 'https://media.example.com/fixture.mp4');
}

function deferred({cancelImmediately = true} = {}) {
  let resolvePromise, rejectPromise;
  const op = {settled: false, cancelCount: 0};
  op.promise = new Promise((resolve, reject) => {resolvePromise = resolve; rejectPromise = reject;});
  op.resolve = value => {if (!op.settled) {op.settled = true; resolvePromise(value);}};
  op.reject = error => {if (!op.settled) {op.settled = true; rejectPromise(error);}};
  op.cancel = () => {
    op.cancelCount++;
    if (cancelImmediately) op.reject(Object.assign(new Error('Operation canceled.'), {canceled: true}));
  };
  return op;
}

class MockEngine {
  constructor(options) {this.options = options; this.inspections = []; this.downloads = []; this.events = [];}
  inspect(url) {
    const op = deferred(this.options);
    this.inspections.push({url, op}); this.events.push('inspect');
    return op;
  }
  download(info, choiceId, workDir, onProgress) {
    const op = deferred(this.options);
    this.downloads.push({info, choiceId, workDir, onProgress, op}); this.events.push('download');
    return op;
  }
}

async function until(predicate, message = 'expected queue transition') {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`);
    await new Promise(resolve => setImmediate(resolve));
  }
}

function setup(t, {mockOptions, seed} = {}) {
  const tempBase = path.join(__dirname, '.tmp');
  fs.mkdirSync(tempBase, {recursive: true});
  const root = fs.mkdtempSync(path.join(tempBase, 'cliptube-unit-'));
  const stateDir = path.join(root, 'state'), outputDir = path.join(root, 'output');
  const engine = new MockEngine(mockOptions), changes = [];
  fs.mkdirSync(stateDir, {recursive: true});
  if (seed !== undefined) fs.writeFileSync(path.join(stateDir, 'queue.json'), typeof seed === 'string' ? seed : JSON.stringify(seed));
  let queue;
  t.after(async () => {
    queue?.close();
    for (const {op} of [...engine.inspections, ...engine.downloads]) op.reject(Object.assign(new Error('Test cleanup.'), {canceled: true}));
    await until(() => !queue?.running, 'test operation cleanup');
    assert.ok(path.resolve(root).startsWith(path.resolve(tempBase) + path.sep));
    fs.rmSync(root, {recursive: true, force: true});
  });
  queue = new Queue({stateDir, outputDir, engine, onChange: state => changes.push(state)});
  return {root, stateDir, outputDir, engine, queue, changes};
}

async function reachDownload(queue, engine, index = 0, info = metadata()) {
  await until(() => engine.inspections.length > index, 'inspection starts');
  const downloadIndex = engine.downloads.length;
  engine.inspections[index].op.resolve(info);
  await until(() => engine.downloads.length > downloadIndex, 'download starts');
  return engine.downloads[downloadIndex];
}

function writeProduced(download, extension = '.mp4', bytes = Buffer.from('local fixture bytes')) {
  fs.mkdirSync(download.workDir, {recursive: true});
  const produced = path.join(download.workDir, 'media' + extension);
  fs.writeFileSync(produced, bytes);
  return produced;
}

test('engine base arguments disable config, external code, playlists and excess parallelism', () => {
  const engine = new Engine({ytdlp: 'ytdlp', ffmpeg: 'ffmpeg', node: process.execPath});
  const args = engine.baseArgs();
  for (const expected of ['--ignore-config', '--no-config-locations', '--no-remote-components', '--no-playlist', '--no-js-runtimes']) assert.ok(args.includes(expected));
  assert.equal(args[args.indexOf('--concurrent-fragments') + 1], '1');
  assert.equal(args[args.indexOf('--ffmpeg-location') + 1], 'ffmpeg');
  assert.equal(args[args.indexOf('--js-runtimes') + 1], `node:${process.execPath}`);
  assert.equal(args.some(arg => /cookie|password|username|browser|extractor-args|impersonate/.test(arg)), false);
});

test('runProcess reports complete lines and refuses nonzero subprocess exit', async () => {
  const lines = [];
  const op = runProcess(process.execPath, ['-e', "process.stdout.write('first\\nsecond');"], {onLine: line => lines.push(line)});
  assert.equal(await op.promise, 'first\nsecond');
  assert.deepEqual(lines, ['first', 'second']);
  await assert.rejects(runProcess(process.execPath, ['-e', "process.stderr.write('fixture failure');process.exitCode=7;" ]).promise, /fixture failure/);
});

test('runProcess cancellation terminates only its owned fixture operation', async () => {
  let ready = false;
  // The child also exits on its own, so a broken cancel path cannot leak a test process.
  const op = runProcess(process.execPath, ['-e', "process.stdout.write('ready\\n');setTimeout(()=>{},1800);"], {onLine: line => {if (line === 'ready') ready = true;}});
  await until(() => ready, 'fixture child is ready');
  const canceledAt = Date.now();
  op.cancel();
  await assert.rejects(op.promise, error => error.canceled === true && /canceled/.test(error.message));
  assert.ok(Date.now() - canceledAt < 1500, 'cancellation should stop the process before its natural exit');
});

test('queue persists requested quality and snapshots do not expose mutable job objects', t => {
  const {queue, stateDir, changes} = setup(t);
  const added = queue.add(metadata(), 'low');
  assert.equal(added.status, 'queued');
  assert.equal(added.attempt, 0);
  assert.equal(added.choiceId, 'low');
  assert.match(added.qualityLabel, /320[x×]180/);
  added.status = 'completed';
  const snapshot = queue.snapshot(); snapshot.jobs[0].title = 'changed externally';
  assert.equal(queue.get(added.id).status, 'queued');
  assert.equal(queue.get(added.id).title, 'Fixture video');
  const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'queue.json'), 'utf8'));
  assert.equal(saved.version, 1);
  assert.equal(saved.jobs[0].choiceId, 'low');
  assert.equal(changes.length, 1);
  assert.throws(() => queue.add(metadata(), 'missing'), /no longer available/);
  assert.equal(queue.jobs.length, 1);
  assert.throws(() => queue.get('missing'), /not found/);
});

test('serial scheduling completes with safe filenames, unique output and partial cleanup', async t => {
  const {queue, engine, outputDir} = setup(t);
  const first = queue.add(metadata({title: '../../CON:<public>| fixture.'}), 'high');
  const second = queue.add(metadata({title: 'Second fixture'}), 'low');
  const download = await reachDownload(queue, engine);
  assert.equal(engine.inspections.length, 1);
  assert.equal(queue.get(second.id).status, 'queued');
  assert.equal(download.choiceId, 'high');
  download.onProgress({status: 'downloading', progress: 40, stage: 'Downloading.', speed: 300, eta: 2});
  assert.equal(queue.get(first.id).progress, 40);
  download.onProgress({status: 'merging', progress: null, stage: 'Merging.', speed: null, eta: null});
  assert.equal(queue.get(first.id).status, 'merging');
  const bytes = Buffer.from('small owned test payload');
  download.op.resolve(writeProduced(download, '.mkv', bytes));
  await until(() => queue.get(first.id).status === 'completed' && engine.inspections.length === 2, 'first completes and next starts');
  const done = queue.get(first.id);
  assert.equal(done.progress, 100);
  assert.equal(done.attempt, 1);
  assert.equal(done.error, null);
  assert.equal(path.dirname(done.file), outputDir);
  assert.match(path.basename(done.file), new RegExp(`\\[${first.id.slice(0, 8)}\\]\\.mkv$`));
  assert.doesNotMatch(path.basename(done.file), /[<>:"|?*]/);
  assert.deepEqual(fs.readFileSync(done.file), bytes);
  assert.equal(fs.existsSync(download.workDir), false);
  assert.deepEqual(engine.events, ['inspect', 'download', 'inspect']);
  assert.throws(() => queue.retry(first.id), /Only failed, canceled, or interrupted/);
  queue.cancel(second.id);
  await until(() => !queue.running);
});

test('queued cancellation skips inspection and retry restarts a fresh attempt', async t => {
  const {queue, engine} = setup(t);
  const first = queue.add(metadata());
  const second = queue.add(metadata());
  queue.cancel(second.id);
  assert.equal(queue.get(second.id).status, 'canceled');
  await until(() => engine.inspections.length === 1);
  assert.equal(queue.get(first.id).status, 'inspecting');
  assert.equal(queue.get(second.id).attempt, 0);
  assert.throws(() => queue.retry(first.id), /Only failed, canceled, or interrupted/);
  queue.cancel(first.id);
  await until(() => !queue.running);
  assert.equal(engine.inspections.length, 1);
  queue.retry(second.id);
  await until(() => engine.inspections.length === 2);
  assert.equal(queue.get(second.id).attempt, 1);
  queue.cancel(second.id);
  await until(() => !queue.running);
});

test('active inspection cancellation prevents download and cannot retry until cancel settles', async t => {
  const {queue, engine} = setup(t, {mockOptions: {cancelImmediately: false}});
  const job = queue.add(metadata());
  await until(() => engine.inspections.length === 1);
  queue.cancel(job.id);
  assert.equal(engine.inspections[0].op.cancelCount, 1);
  assert.equal(queue.get(job.id).status, 'canceled');
  assert.throws(() => queue.retry(job.id), /Cancellation is still finishing/);
  engine.inspections[0].op.resolve(metadata());
  await until(() => !queue.running);
  assert.equal(engine.downloads.length, 0);
  queue.retry(job.id);
  await until(() => engine.inspections.length === 2);
  assert.equal(queue.get(job.id).attempt, 2);
  queue.cancel(job.id); engine.inspections[1].op.reject(new Error('Canceled fixture.'));
  await until(() => !queue.running);
});

test('active download cancellation ignores late progress, saves no file and cleans partials', async t => {
  const {queue, engine, outputDir} = setup(t, {mockOptions: {cancelImmediately: false}});
  const job = queue.add(metadata());
  const download = await reachDownload(queue, engine);
  const produced = writeProduced(download);
  queue.cancel(job.id);
  assert.equal(download.op.cancelCount, 1);
  download.onProgress({status: 'merging', progress: 99, stage: 'Late progress.'});
  assert.equal(queue.get(job.id).status, 'canceled');
  assert.equal(queue.get(job.id).progress, null);
  download.op.resolve(produced);
  await until(() => !queue.running);
  assert.equal(queue.get(job.id).file, null);
  assert.equal(fs.existsSync(download.workDir), false);
  assert.deepEqual(fs.readdirSync(outputDir).filter(name => name !== '.cliptube-partials'), []);
});

test('failed inspection stores a helpful error and retry replaces it without losing selected quality', async t => {
  const {queue, engine, stateDir} = setup(t);
  const job = queue.add(metadata(), 'low');
  await until(() => engine.inspections.length === 1);
  engine.inspections[0].op.reject(new Error('HTTP Error 403: Forbidden'));
  await until(() => !queue.running && queue.get(job.id).status === 'failed');
  assert.match(queue.get(job.id).error, /refused public access/);
  assert.equal(queue.get(job.id).progress, null);
  assert.equal(engine.downloads.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, 'queue.json'))).jobs[0].status, 'failed');
  queue.retry(job.id);
  assert.equal(queue.get(job.id).error, null);
  const download = await reachDownload(queue, engine, 1);
  assert.equal(download.choiceId, 'low');
  download.op.resolve(writeProduced(download));
  await until(() => !queue.running && queue.get(job.id).status === 'completed');
  assert.equal(queue.get(job.id).attempt, 2);
});

test('explicit quality missing on reinspection fails without falling back to best', async t => {
  const {queue, engine} = setup(t);
  const job = queue.add(metadata(), 'low');
  await until(() => engine.inspections.length === 1);
  const current = metadata(); current.choices = current.choices.filter(choice => choice.id !== 'low');
  engine.inspections[0].op.resolve(current);
  await until(() => !queue.running && queue.get(job.id).status === 'failed');
  assert.match(queue.get(job.id).error, /no longer available/);
  assert.equal(engine.downloads.length, 0);
  assert.equal(queue.get(job.id).choiceId, 'low');
});

test('download failures and invalid extensions become failed states and remove partials', async t => {
  const {queue, engine} = setup(t);
  const first = queue.add(metadata());
  const download = await reachDownload(queue, engine);
  writeProduced(download);
  download.op.reject(new Error('ENOSPC: no space left on device'));
  await until(() => !queue.running && queue.get(first.id).status === 'failed');
  assert.match(queue.get(first.id).error, /not enough disk space/);
  assert.equal(fs.existsSync(download.workDir), false);
  const second = queue.add(metadata());
  const invalid = await reachDownload(queue, engine, 1);
  invalid.op.resolve(writeProduced(invalid, '.invalid-extension'));
  await until(() => !queue.running && queue.get(second.id).status === 'failed');
  assert.match(queue.get(second.id).error, /invalid extension/);
  assert.equal(queue.get(second.id).file, null);
  assert.equal(fs.existsSync(invalid.workDir), false);
});

test('output verification is persisted and missing expected audio fails before final copy', async t => {
  const {queue, engine, outputDir} = setup(t);
  const verifications = [];
  engine.verify = file => {const op = deferred(); verifications.push({file, op}); return op;};
  const first = queue.add(metadata());
  const download = await reachDownload(queue, engine);
  download.op.resolve(writeProduced(download));
  await until(() => verifications.length === 1);
  const verified = {width: 640, height: 360, duration: 1, videoCodec: 'h264', audioCodec: 'aac'};
  verifications[0].op.resolve(verified);
  await until(() => !queue.running && queue.get(first.id).status === 'completed');
  assert.deepEqual(queue.get(first.id).verification, verified);
  assert.match(queue.get(first.id).stage, /640[x×]360.*aac/);
  const second = queue.add(metadata());
  const noAudio = await reachDownload(queue, engine, 1);
  noAudio.op.resolve(writeProduced(noAudio));
  await until(() => verifications.length === 2);
  verifications[1].op.resolve({...verified, audioCodec: null});
  await until(() => !queue.running && queue.get(second.id).status === 'failed');
  assert.match(queue.get(second.id).error, /missing the expected audio/);
  assert.equal(queue.get(second.id).file, null);
  assert.equal(fs.readdirSync(outputDir).filter(name => name !== '.cliptube-partials').length, 1);
});

test('cancellation during output verification cannot save the completed download', async t => {
  const {queue, engine, outputDir} = setup(t);
  const verification = deferred();
  engine.verify = () => verification;
  const job = queue.add(metadata());
  const download = await reachDownload(queue, engine);
  download.op.resolve(writeProduced(download));
  await until(() => queue.running?.operation === verification);
  queue.cancel(job.id);
  await until(() => !queue.running);
  assert.equal(verification.cancelCount, 1);
  assert.equal(queue.get(job.id).status, 'canceled');
  assert.equal(queue.get(job.id).file, null);
  assert.deepEqual(fs.readdirSync(outputDir).filter(name => name !== '.cliptube-partials'), []);
});

test('recovery marks unfinished queue jobs interrupted without automatically starting them', async t => {
  const jobs = ['queued', 'inspecting', 'downloading', 'merging', 'completed', 'failed', 'canceled'].map(status => ({
    id: crypto.randomUUID(), url: 'https://media.example.com/fixture.mp4', title: 'Saved',
    status, progress: 50, choiceId: 'best', outputDir: os.tmpdir(), attempt: 1,
  }));
  const {queue, engine, stateDir} = setup(t, {seed: {version: 1, jobs}});
  assert.deepEqual(queue.jobs.map(job => job.status), ['interrupted', 'interrupted', 'interrupted', 'interrupted', 'completed', 'failed', 'canceled']);
  assert.ok(queue.jobs.slice(0, 4).every(job => job.progress === null && job.error === null));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(engine.inspections.length, 0);
  const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'queue.json')));
  assert.equal(saved.jobs[0].status, 'interrupted');
  queue.retry(queue.jobs[0].id);
  await until(() => engine.inspections.length === 1);
  queue.cancel(queue.jobs[0].id);
  await until(() => !queue.running);
});

test('corrupt queue JSON is preserved and replaced with a valid empty state', t => {
  const corrupt = '{"jobs":[broken JSON';
  const {queue, stateDir} = setup(t, {seed: corrupt});
  assert.deepEqual(queue.jobs, []);
  const backups = fs.readdirSync(stateDir).filter(name => name.startsWith('queue.json.corrupt-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(stateDir, backups[0]), 'utf8'), corrupt);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, 'queue.json'))).jobs, []);
  assert.equal(fs.existsSync(path.join(stateDir, 'queue.json.tmp')), false);
});

test('structurally invalid saved JSON recovers to an empty queue', t => {
  const {queue} = setup(t, {seed: 'null'});
  assert.deepEqual(queue.jobs, []);
});

test('saved job validation discards invalid IDs, relative paths and format selector syntax', t => {
  const valid = {
    id: crypto.randomUUID(), url: 'https://media.example.com/fixture.mp4', title: 'Saved',
    status: 'failed', choiceId: 'best', outputDir: os.tmpdir(), attempt: 1,
  };
  const invalid = [
    {...valid, id: '../../escape'}, {...valid, id: crypto.randomUUID(), outputDir: '../relative'},
    {...valid, id: crypto.randomUUID(), choiceId: 'bestvideo/best'},
    {...valid, id: crypto.randomUUID(), status: 'unexpected'}, null,
  ];
  const {queue} = setup(t, {seed: {jobs: [valid, ...invalid]}});
  assert.deepEqual(queue.jobs.map(job => job.id), [valid.id]);
});

test('a removed output folder becomes a failed job before inspection starts', async t => {
  const {queue, engine, outputDir} = setup(t);
  const job = queue.add(metadata());
  fs.rmdirSync(outputDir);
  await until(() => !queue.running && queue.get(job.id).status === 'failed');
  assert.equal(engine.inspections.length, 0);
  assert.ok(queue.get(job.id).error);
});

test('folder changes persist and only affect new queued jobs', t => {
  const {queue, engine, root, stateDir, outputDir} = setup(t);
  const first = queue.add(metadata());
  const chosen = path.join(root, 'chosen'); fs.mkdirSync(chosen);
  assert.equal(queue.setFolder(chosen), fs.realpathSync(chosen));
  const second = queue.add(metadata());
  assert.equal(queue.get(first.id).outputDir, outputDir);
  assert.equal(queue.get(second.id).outputDir, fs.realpathSync(chosen));
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, 'queue.json'))).outputDir, fs.realpathSync(chosen));
  queue.cancel(first.id); queue.cancel(second.id);
  const restored = new Queue({stateDir, outputDir, engine});
  assert.equal(restored.outputDir, fs.realpathSync(chosen)); restored.close();
  assert.throws(() => queue.setFolder('relative-folder'), /absolute output folder/);
  const file = path.join(root, 'regular-file'); fs.writeFileSync(file, 'fixture');
  assert.throws(() => queue.setFolder(file), /folder, not a file/);
});

test('closing cancels the active operation, interrupts pending jobs and prevents new work', async t => {
  const {queue, engine} = setup(t);
  const first = queue.add(metadata()); const second = queue.add(metadata());
  await until(() => engine.inspections.length === 1);
  queue.close();
  assert.equal(engine.inspections[0].op.cancelCount, 1);
  assert.equal(queue.get(first.id).status, 'interrupted');
  assert.equal(queue.get(second.id).status, 'interrupted');
  assert.throws(() => queue.add(metadata()), /closing/);
  await until(() => !queue.running);
  assert.equal(engine.inspections.length, 1);
  assert.equal(queue.get(first.id).error, null);
});

test('late inspection success after shutdown cannot launch a new download', async t => {
  const {queue, engine} = setup(t, {mockOptions: {cancelImmediately: false}});
  const job = queue.add(metadata());
  await until(() => engine.inspections.length === 1);
  queue.close();
  engine.inspections[0].op.resolve(metadata());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(engine.downloads.length, 0);
  assert.equal(queue.get(job.id).status, 'interrupted');
  assert.equal(queue.running, null);
});

test('late download success and progress after shutdown cannot save a file or undo interruption', async t => {
  const {queue, engine, outputDir} = setup(t, {mockOptions: {cancelImmediately: false}});
  const job = queue.add(metadata());
  const download = await reachDownload(queue, engine);
  const produced = writeProduced(download);
  queue.close();
  download.onProgress({status: 'downloading', progress: 99, stage: 'Late progress.'});
  assert.equal(queue.get(job.id).status, 'interrupted');
  download.op.resolve(produced);
  await until(() => !queue.running);
  assert.equal(queue.get(job.id).status, 'interrupted');
  assert.equal(queue.get(job.id).file, null);
  assert.deepEqual(fs.readdirSync(outputDir).filter(name => name !== '.cliptube-partials'), []);
});

test('clearFinished retains active and pending work, and pending queue is capped at 50', async t => {
  const {queue, engine} = setup(t);
  const first = queue.add(metadata()); const second = queue.add(metadata());
  queue.cancel(second.id);
  await until(() => engine.inspections.length === 1);
  queue.clearFinished();
  assert.deepEqual(queue.jobs.map(job => job.id), [first.id]);
  for (let i = 1; i < 50; i++) queue.add(metadata());
  assert.throws(() => queue.add(metadata()), /queue is full/);
  assert.equal(queue.jobs.length, 50);
  for (const job of queue.jobs) queue.cancel(job.id);
  await until(() => !queue.running);
  queue.clearFinished();
  assert.deepEqual(queue.jobs, []);
});
