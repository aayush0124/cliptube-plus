'use strict';

// Real yt-dlp/FFmpeg coverage using only an owned, CPU-light synthetic fixture.
// Loopback is enabled on this test's Engine instance only. Evidence is retained.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {Engine, Queue} = require('../lib/engine');
const {selectFormat} = require('../lib/media');
const {discover, status} = require('../lib/tools');

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, '..');
const runDir = path.join(root, 'test-output', 'integration', 'run-' + new Date().toISOString().replace(/[:.]/g, '-'));
const fixtureDir = path.join(runDir, 'fixture');
const outputDir = path.join(runDir, 'downloads');
const stateDir = path.join(runDir, 'state');
const report = {startedAt: new Date().toISOString(), fixture: 'Owned synthetic FFmpeg test pattern and sine tone; no external media', runDir, tests: []};
const snapshots = [], requests = [];
const tools = discover(root);
let server, queue;
let retryAvailable = true, slowBytesSent = 0;

function save(name, value) {
  fs.writeFileSync(path.join(runDir, name), JSON.stringify(value, null, 2));
}
function pause(milliseconds) {return new Promise(resolve => setTimeout(resolve, milliseconds));}
async function until(predicate, message, timeout = 30000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error('Timed out: ' + message);
    await pause(25);
  }
}
async function check(name, fn) {
  const started = Date.now();
  try {
    const evidence = await fn();
    report.tests.push({name, passed: true, milliseconds: Date.now() - started, evidence});
    process.stdout.write('PASS ' + name + '\n');
    return evidence;
  } catch (error) {
    report.tests.push({name, passed: false, milliseconds: Date.now() - started, error: error.stack || String(error)});
    throw error;
  }
}
async function probe(file) {
  const {stdout} = await execFileAsync(tools.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], {windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024});
  return JSON.parse(stdout);
}
function assertMerged(probed) {
  const video = probed.streams.find(stream => stream.codec_type === 'video');
  const audio = probed.streams.find(stream => stream.codec_type === 'audio');
  assert.ok(video, 'The output must contain video');
  assert.ok(audio, 'The output must contain the separately downloaded audio');
  assert.equal(video.width, 320);
  assert.equal(video.height, 180);
  assert.equal(video.codec_name, 'h264');
  assert.equal(audio.codec_name, 'aac');
  assert.equal(video.r_frame_rate, '24/1');
  const duration = Number(probed.format.duration);
  assert.ok(duration >= 1.9 && duration <= 2.3, 'Expected roughly two seconds, got ' + duration);
  return {width: video.width, height: video.height, fps: video.r_frame_rate, videoCodec: video.codec_name, audioCodec: audio.codec_name, duration, bytes: Number(probed.format.size)};
}

async function createFixture() {
  fs.mkdirSync(fixtureDir, {recursive: true});
  fs.mkdirSync(outputDir, {recursive: true});
  const args = [
    '-hide_banner', '-loglevel', 'warning', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
    '-filter_complex', '[0:v]split=2[vhigh][vlo];[vlo]scale=160:90[vlow]',
    '-map', '[vhigh]', '-map', '[vlow]', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-threads:v', '1',
    '-pix_fmt', 'yuv420p', '-g', '24', '-sc_threshold', '0',
    '-b:v:0', '240k', '-b:v:1', '90k', '-c:a', 'aac', '-b:a', '64k',
    '-t', '2', '-f', 'dash', '-seg_duration', '1', '-use_template', '1',
    '-use_timeline', '1', '-adaptation_sets', 'id=0,streams=v id=1,streams=a',
    'manifest.mpd',
  ];
  const result = await execFileAsync(tools.ffmpeg, args, {cwd: fixtureDir, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024});
  fs.writeFileSync(path.join(runDir, 'fixture-generation.log'), result.stderr || 'FFmpeg fixture generation succeeded.\n');
  save('fixture-command.json', {binary: tools.ffmpeg, cwd: fixtureDir, args});
  const files = fs.readdirSync(fixtureDir);
  assert.ok(files.includes('manifest.mpd'));
  const totalBytes = files.reduce((sum, name) => sum + fs.statSync(path.join(fixtureDir, name)).size, 0);
  assert.ok(totalBytes < 1024 * 1024, 'The test fixture must stay smaller than 1 MiB');
  return {files, totalBytes, maxSourceWidth: 320, maxSourceHeight: 180, duration: 2};
}

async function serveFixture() {
  const allowedFiles = new Set(fs.readdirSync(fixtureDir));
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const match = /^\/(fixture|slow|retry)\/([A-Za-z0-9_.-]+)$/.exec(url.pathname);
    const entry = {at: new Date().toISOString(), method: req.method, path: url.pathname, range: req.headers.range || null};
    requests.push(entry);
    if (!match || !allowedFiles.has(match[2]) || !['GET', 'HEAD'].includes(req.method)) {
      entry.status = 404; res.writeHead(404); res.end('Owned fixture file not found.'); return;
    }
    if (match[1] === 'retry' && !retryAvailable) {
      entry.status = 403; res.writeHead(403); res.end('Intentional test-only public access refusal.'); return;
    }
    const file = path.join(fixtureDir, match[2]);
    const stat = fs.statSync(file);
    let start = 0, end = stat.size - 1;
    const headers = {'Content-Type': match[2].endsWith('.mpd') ? 'application/dash+xml' : 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store'};
    if (req.headers.range) {
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
      if (!range) {entry.status = 416; res.writeHead(416); res.end(); return;}
      start = Number(range[1]); end = range[2] ? Math.min(Number(range[2]), end) : end;
      if (start > end || start >= stat.size) {entry.status = 416; res.writeHead(416); res.end(); return;}
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    }
    headers['Content-Length'] = end - start + 1;
    entry.status = req.headers.range ? 206 : 200;
    res.writeHead(entry.status, headers);
    if (req.method === 'HEAD') {res.end(); return;}
    if (match[1] !== 'slow' || match[2].endsWith('.mpd')) {
      fs.createReadStream(file, {start, end}).pipe(res); return;
    }
    // Only a bounded local fixture is read into memory. Slow bytes make cancellation observable.
    const payload = fs.readFileSync(file).subarray(start, end + 1);
    let offset = 0;
    const timer = setInterval(() => {
      if (res.destroyed) {clearInterval(timer); return;}
      const next = payload.subarray(offset, Math.min(offset + 256, payload.length));
      slowBytesSent += next.length; offset += next.length; res.write(next);
      if (offset >= payload.length) {clearInterval(timer); res.end();}
    }, 50);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  return 'http://127.0.0.1:' + server.address().port;
}

async function main() {
  fs.mkdirSync(runDir, {recursive: true});
  report.tools = await status(tools);
  assert.ok(report.tools.ready && report.tools.ffprobeVersion, 'Real yt-dlp, FFmpeg and ffprobe are required. ' + report.tools.issues.join(' '));
  report.fixtureEvidence = await check('Generate a small owned two-quality DASH fixture', createFixture);
  const base = await serveFixture();
  const engine = new Engine(tools, {allowLoopback: true});
  const info = await check('Inspect actual source formats and select original-resolution best video plus audio', async () => {
    const result = await engine.inspect(base + '/fixture/manifest.mpd').promise;
    save('inspected-formats.json', result);
    const dimensions = result.choices.map(choice => [choice.width, choice.height]);
    assert.deepEqual(dimensions, [[320, 180], [160, 90]]);
    assert.ok(result.choices.every(choice => choice.merge && choice.audioCodec));
    assert.ok(result.choices.every(choice => !/upscal|720|1080|2160/.test(choice.label)));
    const best = selectFormat(result, 'best');
    assert.equal(best.width, 320); assert.equal(best.height, 180); assert.ok(best.merge);
    assert.match(best.format, /\+/);
    assert.match(best.label, /320[x×]180/);
    return result;
  });
  queue = new Queue({stateDir, outputDir, engine, onChange: snapshot => snapshots.push({at: new Date().toISOString(), ...snapshot})});
  const completed = await check('Queue a real best-quality download and merge; ffprobe validates video, audio and duration', async () => {
    const added = queue.add(info, 'best');
    await until(() => ['completed', 'failed'].includes(queue.get(added.id).status) && !queue.running, 'real merge completes', 60000);
    const job = queue.get(added.id);
    assert.equal(job.status, 'completed', job.error || job.stage);
    assert.equal(job.attempt, 1); assert.equal(job.progress, 100);
    assert.equal(path.extname(job.file), '.mkv');
    assert.equal(path.dirname(job.file), outputDir);
    const probed = await probe(job.file); save('merged-ffprobe.json', probed);
    const verification = assertMerged(probed);
    assert.equal(fs.existsSync(path.join(outputDir, '.cliptube-partials', job.id)), false);
    assert.ok(snapshots.some(snapshot => snapshot.jobs.find(candidate => candidate.id === job.id)?.status === 'downloading'));
    assert.ok(requests.some(request => /chunk-stream0/.test(request.path)), 'The video fragments must have been requested');
    assert.ok(requests.some(request => /chunk-stream2/.test(request.path)), 'The audio fragments must have been requested');
    return {...job, verification};
  });
  const canceled = await check('Cancel a real throttled download, settle its child and clean owned partials', async () => {
    const slowInfo = await engine.inspect(base + '/slow/manifest.mpd').promise;
    const added = queue.add(slowInfo, 'best');
    await until(() => queue.get(added.id).status === 'downloading' && slowBytesSent >= 512, 'the real downloader receives slow fixture bytes', 30000);
    const before = {...queue.get(added.id)};
    const start = Date.now(); queue.cancel(added.id);
    assert.equal(queue.get(added.id).status, 'canceled');
    await until(() => !queue.running, 'owned canceled subprocess settles', 15000);
    const job = queue.get(added.id);
    assert.equal(job.status, 'canceled'); assert.equal(job.file, null); assert.equal(job.error, null);
    assert.equal(fs.existsSync(path.join(outputDir, '.cliptube-partials', job.id)), false);
    assert.equal(fs.readdirSync(outputDir).filter(name => name !== '.cliptube-partials').length, 1);
    return {before, after: {...job}, cancellationMilliseconds: Date.now() - start, slowBytesSent};
  });
  const retried = await check('Public-access failure persists; explicit retry after restoring fixture succeeds', async () => {
    const retryInfo = await engine.inspect(base + '/retry/manifest.mpd').promise;
    retryAvailable = false;
    const added = queue.add(retryInfo, 'best');
    await until(() => queue.get(added.id).status === 'failed' && !queue.running, 'fixture access refusal fails the job', 45000);
    const failed = {...queue.get(added.id)};
    assert.match(failed.error, /refused public access/);
    assert.equal(failed.attempt, 1); assert.equal(failed.file, null);
    assert.equal(JSON.parse(fs.readFileSync(queue.stateFile, 'utf8')).jobs.find(job => job.id === added.id).status, 'failed');
    save('failed-job.json', failed);
    retryAvailable = true;
    queue.retry(added.id);
    await until(() => ['completed', 'failed'].includes(queue.get(added.id).status) && !queue.running, 'explicit retry completes', 60000);
    const job = queue.get(added.id);
    assert.equal(job.status, 'completed', job.error || job.stage);
    assert.equal(job.attempt, 2); assert.equal(job.error, null);
    const probed = await probe(job.file); save('retry-ffprobe.json', probed);
    return {failed, after: {...job}, verification: assertMerged(probed)};
  });
  await check('Real queue result and selected quality survive a fresh Queue instance', async () => {
    queue.close();
    const restored = new Queue({stateDir, outputDir, engine});
    try {
      assert.equal(restored.get(completed.id).status, 'completed');
      assert.equal(restored.get(canceled.after.id).status, 'canceled');
      assert.equal(restored.get(retried.after.id).status, 'completed');
      assert.equal(restored.get(retried.after.id).attempt, 2);
      assert.ok(restored.snapshot().jobs.every(job => job.choiceId === 'best'));
      assert.ok(restored.snapshot().jobs.filter(job => job.status === 'completed').every(job => fs.existsSync(job.file)));
      return restored.snapshot();
    } finally {restored.close();}
  });
  report.passed = true;
}

main().catch(error => {
  report.passed = false; report.error = error.stack || String(error);
  process.stderr.write(report.error + '\n'); process.exitCode = 1;
}).finally(async () => {
  if (queue) {
    queue.close();
    try {await until(() => !queue.running, 'queue cleanup', 15000);} catch (error) {report.cleanupError = String(error); process.exitCode = 1;}
  }
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  report.finishedAt = new Date().toISOString();
  save('queue-snapshots.json', snapshots);
  save('http-requests.json', requests);
  save('report.json', report);
  process.stdout.write('Integration evidence: ' + runDir + '\n');
});
