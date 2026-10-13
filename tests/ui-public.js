'use strict';
// Opt-in real UI test. The only public media URL is Blender's CC BY trailer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-output', 'ui-public');
const fixture = 'https://download.blender.org/peach/trailer/trailer_720x405.mov';
const {electron, puppeteer} = require('./ui-runtime')(root);
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
fs.mkdirSync(output, {recursive: true});
const report = {generatedAt: new Date().toISOString(), fixture, license: 'Blender Big Buck Bunny trailer, CC BY 3.0', passed: false, checks: [], existingHistoryRetried: false};
let child, browser, page, log = '', processError;
function passed(name, details) {report.checks.push({name, passed: true, ...(details ? {details} : {})}); process.stdout.write(`PASS ${name}\n`);}

async function launch() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  const port = server.address().port; await new Promise((resolve) => server.close(resolve));
  const env = {...process.env, CLIPTUBE_TEST_CDP: String(port)}; delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(electron, [root, '--disable-gpu'], {cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  const append = (chunk) => {log = (log + String(chunk)).slice(-12000);};
  child.stdout.on('data', append); child.stderr.on('data', append); child.on('error', (error) => {processError = error;});
  let endpoint; const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (processError) throw processError;
    if (child.exitCode !== null) throw new Error(`Owned app exited before its local test endpoint (${child.exitCode}). Another app instance may be open. ${log}`);
    try {const response = await fetch(`http://127.0.0.1:${port}/json/version`, {signal: AbortSignal.timeout(1000)}); if (response.ok) endpoint = (await response.json()).webSocketDebuggerUrl;} catch { }
    if (endpoint) break; await wait(150);
  }
  if (!endpoint) throw new Error('Owned app did not start its loopback test endpoint within 30 seconds.');
  browser = await puppeteer.connect({browserWSEndpoint: endpoint, defaultViewport: null});
  const rendererDeadline = Date.now() + 15000;
  while (Date.now() < rendererDeadline) {
    page = (await browser.pages()).find((item) => item.url().endsWith('/renderer/index.html') || item.url().endsWith('\\renderer\\index.html'));
    if (page) break; await wait(100);
  }
  if (!page) throw new Error('Owned app renderer did not appear.');
  page.setDefaultTimeout(10000);
  await page.waitForFunction(() => document.getElementById('tools-status')?.classList.contains('ready'), {timeout: 30000});
}
async function closeOwnedApp() {
  try {if (page && !page.isClosed()) await page.close();} catch { }
  const deadline = Date.now() + 5000;
  while (child && child.exitCode === null && Date.now() < deadline) await wait(100);
  if (child && child.exitCode === null) child.kill(); // Exact child PID from this script; never kills by process name.
  try {browser?.disconnect();} catch { }
}
async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

(async () => {
  const began = Date.now();
  try {
    await launch(); passed('real app launch and local tools ready');
    const before = await page.evaluate(() => window.cliptube.bootstrap());
    const knownIds = new Set(before.jobs.map((job) => job.id));
    const relativeOutput = path.relative(root, path.resolve(before.outputDir));
    assert.ok(relativeOutput && relativeOutput !== '..' && !relativeOutput.startsWith('..' + path.sep) && !path.isAbsolute(relativeOutput), 'This isolated test requires the app\'s existing output folder to remain inside its workspace. No folder override was attempted.');
    report.existingJobsIgnored = knownIds.size;
    await page.$eval('#url-input', (element, url) => {element.value = url; element.dispatchEvent(new Event('input', {bubbles: true}));}, fixture);
    await page.click('#inspect-button');
    const inspectDeadline = Date.now() + 60000;
    let inspection;
    while (Date.now() < inspectDeadline) {
      inspection = await page.evaluate(() => ({ready: !document.getElementById('inspection-result').hidden, error: document.getElementById('inspection-error').hidden ? null : document.getElementById('inspection-error').textContent,
        title: document.getElementById('video-title').textContent, metadata: document.getElementById('video-meta').textContent,
        options: [...document.getElementById('quality-select').options].map((option) => ({id: option.value, label: option.textContent})), sourceLabel: document.querySelector('label[for="quality-select"]').textContent}));
      if (inspection.error) throw new Error(inspection.error);
      if (inspection.ready) break; await wait(500);
    }
    assert.ok(inspection?.ready, 'Public fixture inspection did not finish within 60 seconds.');
    assert.ok(inspection.options.length >= 2, 'Expected a best choice and at least one actual source format.');
    assert.ok(inspection.options.some((option) => /720\s*[x×]\s*405/.test(option.label)), 'Actual source dimensions should be 720x405.');
    assert.match(inspection.metadata, /0:33/); assert.match(inspection.sourceLabel, /source quality/i);
    assert.doesNotMatch(inspection.options.map((option) => option.label).join(' '), /2160|1080p|upscal/i);
    report.inspection = inspection; passed('real DOM inspection exposes 720x405 source format and 33-second duration', {sourceFormats: inspection.options.length - 1});
    await page.select('#quality-select', 'best');
    assert.equal(await page.$eval('#enqueue-button', (element) => element.disabled), false);
    await page.click('#enqueue-button');
    const completionDeadline = Date.now() + 120000;
    let job, lastStatus;
    while (Date.now() < completionDeadline) {
      const snapshot = await page.evaluate(() => window.cliptube.bootstrap());
      job = snapshot.jobs.find((item) => !knownIds.has(item.id) && item.url === fixture);
      if (job && job.status !== lastStatus) {process.stdout.write(`New owned fixture job: ${job.status}\n`); lastStatus = job.status;}
      if (job?.status === 'completed') break;
      if (job && ['failed', 'canceled', 'interrupted'].includes(job.status)) throw new Error(`New fixture job ${job.status}: ${job.error || job.stage}`);
      const notice = await page.evaluate(() => {const element = document.getElementById('app-notice'); return !element.hidden && element.classList.contains('error') ? element.textContent : null;});
      if (!job && notice) throw new Error(notice);
      await wait(1000);
    }
    assert.ok(job, 'Real DOM enqueue did not create a new job.');
    assert.equal(job.status, 'completed', 'New fixture download did not complete within 120 seconds.');
    assert.equal(job.choiceId, 'best');
    assert.equal(await page.$eval(`[data-job-id="${job.id}"]`, (element) => element.dataset.status), 'completed');
    passed('real DOM best-quality enqueue completes through main, preload, and backend');
    assert.ok(job.verification, 'The completed job should include ffprobe verification.');
    assert.equal(job.verification.width, 720); assert.equal(job.verification.height, 405);
    assert.equal(job.verification.audioCodec, 'aac'); assert.equal(job.verification.videoCodec, 'h264');
    assert.ok(Math.abs(job.verification.duration - 33.023333) < 0.02, `Unexpected verified duration: ${job.verification.duration}`);
    assert.ok(job.file && fs.existsSync(job.file), 'Completed fixture output must exist.');
    const saved = fs.statSync(job.file); assert.ok(saved.isFile() && saved.size > 0);
    report.job = {id: job.id, status: job.status, choiceId: job.choiceId, qualityLabel: job.qualityLabel, file: job.file, sizeBytes: saved.size, sha256: await hashFile(job.file), verification: job.verification};
    passed('saved source verified as 720x405 H.264, AAC, 33.0233 seconds', report.job.verification);
    report.passed = true;
  } catch (error) {
    report.error = error.message; process.stderr.write(error.stack + '\n'); process.exitCode = 1;
    try {if (page && !page.isClosed()) await page.screenshot({path: path.join(output, 'failure.png'), fullPage: true});} catch { }
  } finally {
    await closeOwnedApp(); report.milliseconds = Date.now() - began;
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(`Public UI E2E ${report.passed ? 'PASS' : 'FAIL'}. Report: ${path.join(output, 'report.json')}\n`);
  }
})();
