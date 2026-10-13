'use strict';
// No media/network requests: real-app startup + private-URL rejection, then a mock bridge.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const {spawn} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-output', 'ui');
const {electron, puppeteer, puppeteerPath} = require('./ui-runtime')(root);
fs.mkdirSync(output, {recursive: true});
const results = [];
const sessions = new Set();
const mockOnly = process.argv.includes('--mock-only');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function check(name, run) {
  const started = Date.now();
  try {await run(); results.push({name, passed: true, milliseconds: Date.now() - started}); process.stdout.write(`PASS ${name}\n`);}
  catch (error) {results.push({name, passed: false, milliseconds: Date.now() - started, error: error.message}); process.stdout.write(`FAIL ${name}: ${error.message}\n`); throw error;}
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function start(mock) {
  const port = await freePort();
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
  env[mock ? 'CLIPTUBE_UI_CDP' : 'CLIPTUBE_TEST_CDP'] = String(port);
  const child = spawn(electron, [mock ? path.join(__dirname, 'ui-host.js') : root, '--disable-gpu'], {cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  let log = ''; let childError;
  const append = (chunk) => {log = (log + String(chunk)).slice(-12000);};
  child.stdout.on('data', append); child.stderr.on('data', append); child.on('error', (error) => {childError = error;});
  const session = {child, browser: null, page: null, mock, log: () => log}; sessions.add(session);
  const deadline = Date.now() + 30000;
  let endpoint;
  while (Date.now() < deadline) {
    if (childError) throw childError;
    if (child.exitCode !== null) throw new Error(`Owned ${mock ? 'mock' : 'production'} app exited before CDP connected (${child.exitCode}). Another production instance may already be open. ${log}`);
    try {const response = await fetch(`http://127.0.0.1:${port}/json/version`, {signal: AbortSignal.timeout(1000)}); if (response.ok) {endpoint = (await response.json()).webSocketDebuggerUrl; if (endpoint) break;}}
    catch { /* The owned child may still be starting. */ }
    await wait(150);
  }
  if (!endpoint) throw new Error(`Owned Electron app did not expose its loopback test endpoint within 30 seconds. ${log}`);
  session.browser = await puppeteer.connect({browserWSEndpoint: endpoint, defaultViewport: null});
  const pageDeadline = Date.now() + 15000;
  while (Date.now() < pageDeadline) {
    session.page = (await session.browser.pages()).find((page) => page.url().endsWith('/renderer/index.html') || page.url().endsWith('\\renderer\\index.html'));
    if (session.page) break;
    await wait(100);
  }
  if (!session.page) throw new Error(`The owned app renderer did not appear. ${log}`);
  session.page.setDefaultTimeout(10000);
  await session.page.waitForSelector('#url-input');
  return session;
}
async function stop(session) {
  if (!session) return;
  try {if (session.page && !session.page.isClosed()) {if (session.mock) await session.page.evaluate(() => window.__uiTest.close()); else await session.page.close();}}
  catch { /* Fall back only to this exact spawned child. */ }
  const deadline = Date.now() + 5000;
  while (session.child.exitCode === null && Date.now() < deadline) await wait(100);
  if (session.child.exitCode === null) session.child.kill(); // Exact PID returned by our own spawn; never process-name kills.
  try {session.browser?.disconnect();} catch { }
  sessions.delete(session);
}
async function input(page, url) {
  await page.$eval('#url-input', (element, value) => {element.value = value; element.dispatchEvent(new Event('input', {bubbles: true}));}, url);
}
async function pending(page, url) {
  await page.waitForFunction((value) => window.__uiTest.pending().some((request) => request.url === value), {}, url);
  return page.evaluate((value) => window.__uiTest.pending().find((request) => request.url === value).id, url);
}
function info(url, token = 'mock-inspection', title = 'Owned sample — original quality') {
  return {token, url, title, channel: 'Local fixture creator', duration: 95, platform: 'Mock public fixture', bestLabel: '1920 × 1080 · 30 fps · merged audio',
    choices: [{id: 'v1080', label: '1920 × 1080 · 30 fps · h264 + AAC (merged)', width: 1920, height: 1080, fps: 30, videoCodec: 'h264', audioCodec: 'aac', merge: true, estimatedBytes: 20 * 1024 * 1024},
      {id: 'v720', label: '1280 × 720 · 30 fps · h264 + AAC', width: 1280, height: 720, fps: 30, videoCodec: 'h264', audioCodec: 'aac', merge: false, estimatedBytes: 10 * 1024 * 1024}], warnings: ['Dimensions are reported by the source. No upscaling.']};
}
async function resolve(page, id, value) {await page.evaluate((requestId, inspection) => window.__uiTest.resolveInspection(requestId, inspection), id, value);}
async function inspectFixture(page, value) {
  await input(page, value.url); await page.click('#inspect-button'); await resolve(page, await pending(page, value.url), value);
  await page.waitForFunction(() => !document.getElementById('inspection-result').hidden && !document.getElementById('enqueue-button').disabled);
}
async function updateJob(page, id, changes) {
  await page.evaluate((jobId, patch) => {const snapshot = window.__uiTest.getState(); Object.assign(snapshot.jobs.find((job) => job.id === jobId), patch); window.__uiTest.setState(snapshot);}, id, changes);
  if (changes.status) await page.waitForSelector(`[data-job-id="${id}"][data-status="${changes.status}"]`);
}
async function enabled(page, selector) {return page.$eval(selector, (element) => !element.disabled);}
async function screenshot(page, filename, width, height) {
  await page.setViewport({width, height});
  await page.screenshot({path: path.join(output, filename), fullPage: true});
  const overflow = await page.evaluate(() => ({scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth}));
  assert.ok(overflow.scroll <= overflow.client + 1, `${width}px layout has horizontal overflow: ${JSON.stringify(overflow)}`);
}

(async () => {
  let production, mock;
  try {
    if (!mockOnly) {
    await check('production app launch', async () => {production = await start(false);});
    const page = production.page;
    await check('production startup, tools ready, disabled empty form', async () => {
      await page.waitForFunction(() => document.getElementById('tools-status').classList.contains('ready'), {timeout: 30000});
      assert.equal(await enabled(page, '#inspect-button'), false); assert.equal(await enabled(page, '#enqueue-button'), false);
      assert.match(await page.$eval('#tools-status', (element) => element.textContent), /ready/i);
    });
    await check('production isolated bridge and CSP', async () => {
      const security = await page.evaluate(() => ({require: typeof window.require, process: typeof window.process, mock: typeof window.__uiTest, bridge: typeof window.cliptube.inspect, csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content}));
      assert.deepEqual({require: security.require, process: security.process, mock: security.mock, bridge: security.bridge}, {require: 'undefined', process: 'undefined', mock: 'undefined', bridge: 'function'});
      assert.match(security.csp, /connect-src 'none'/); assert.doesNotMatch(security.csp, /unsafe-eval|unsafe-inline/);
    });
    await check('production private URL rejected without media access', async () => {
      await input(page, 'http://127.0.0.1/fixture.mp4'); await page.click('#inspect-button');
      await page.waitForFunction(() => !document.getElementById('inspection-error').hidden);
      assert.match(await page.$eval('#inspection-error', (element) => element.textContent), /local|private network/i);
      assert.equal(await enabled(page, '#enqueue-button'), false);
    });
    await input(page, '');
    await screenshot(page, 'production-desktop.png', 1160, 870);
    await stop(production); production = null;
    }

    await check('mock app launch', async () => {mock = await start(true);}); const ui = mock.page;
    await ui.waitForFunction(() => document.getElementById('tools-status').classList.contains('ready'));
    await check('mock inspection shows actual formats and best choice', async () => {
      await inspectFixture(ui, info('https://fixture.example/owned-sample'));
      const rendered = await ui.evaluate(() => ({title: document.getElementById('video-title').textContent, meta: document.getElementById('video-meta').textContent, choices: [...document.getElementById('quality-select').options].map((option) => ({id: option.value, label: option.textContent})), selected: document.getElementById('quality-select').value}));
      assert.equal(rendered.title, 'Owned sample — original quality'); assert.match(rendered.meta, /1:35/);
      assert.deepEqual(rendered.choices.map((choice) => choice.id), ['best', 'v1080', 'v720']); assert.equal(rendered.selected, 'best');
      assert.match(rendered.choices[1].label, /1920 × 1080/); assert.doesNotMatch(rendered.choices.map((choice) => choice.label).join(' '), /4K|2160|upscal/i);
    });
    await check('mock explicit quality selection and queued download', async () => {
      await ui.select('#quality-select', 'v720');
      assert.match(await ui.$eval('#quality-detail', (element) => element.textContent), /1280 × 720 source/);
      await ui.click('#enqueue-button'); await ui.waitForSelector('[data-job-id="mock-job-1"][data-status="queued"]');
      const call = await ui.evaluate(() => window.__uiTest.calls().find((entry) => entry.action === 'enqueue'));
      assert.equal(call.value.choiceId, 'v720'); assert.equal(call.value.token, 'mock-inspection');
    });
    await check('mock download progress, merge, completion, and file action', async () => {
      await updateJob(ui, 'mock-job-1', {status: 'downloading', progress: 42, speed: 2048, eta: 30, stage: 'Downloading source stream…'});
      assert.equal(await ui.$eval('[data-job-id="mock-job-1"] progress', (element) => element.value), 42);
      assert.match(await ui.$eval('[data-job-id="mock-job-1"] .job-detail', (element) => element.textContent), /2 KB\/s.*0:30 remaining/);
      await updateJob(ui, 'mock-job-1', {status: 'merging', progress: null, speed: null, eta: null, stage: 'Combining source video and audio'});
      assert.equal(await ui.$eval('[data-job-id="mock-job-1"] progress', (element) => element.hasAttribute('value')), false);
      await updateJob(ui, 'mock-job-1', {status: 'completed', progress: 100, file: '/mock/ClipTube UI fixtures/Owned sample.mkv'});
      await ui.click('[data-job-id="mock-job-1"] [data-action="show"]');
      assert.ok(await ui.evaluate(() => window.__uiTest.calls().some((entry) => entry.action === 'showFile' && entry.value === 'mock-job-1')));
    });
    await check('mock cancel, canceled retry, failed retry, interrupted retry', async () => {
      await ui.click('#enqueue-button'); await ui.waitForSelector('[data-job-id="mock-job-2"]');
      await ui.click('[data-job-id="mock-job-2"] [data-action="cancel"]'); await ui.waitForSelector('[data-job-id="mock-job-2"][data-status="canceled"]');
      await ui.click('[data-job-id="mock-job-2"] [data-action="retry"]'); await ui.waitForSelector('[data-job-id="mock-job-2"][data-status="queued"]');
      await updateJob(ui, 'mock-job-2', {status: 'failed', error: 'Fixture request failed clearly.'});
      assert.match(await ui.$eval('[data-job-id="mock-job-2"] .job-error', (element) => element.textContent), /failed clearly/);
      await ui.click('[data-job-id="mock-job-2"] [data-action="retry"]'); await ui.waitForSelector('[data-job-id="mock-job-2"][data-status="queued"]');
      assert.equal(await ui.$eval('[data-job-id="mock-job-2"] .job-error', (element) => element.hidden), true);
      await updateJob(ui, 'mock-job-2', {status: 'interrupted', stage: 'Session ended.'});
      assert.match(await ui.$eval('[data-job-id="mock-job-2"] .job-stage', (element) => element.textContent), /Retry/);
      await ui.click('[data-job-id="mock-job-2"] [data-action="retry"]'); await ui.waitForSelector('[data-job-id="mock-job-2"][data-status="queued"]');
      assert.match(await ui.$eval('[data-job-id="mock-job-2"] .job-meta', (element) => element.textContent), /Attempt 4/);
    });
    await check('mock folder choice reflected and canceled choice preserves it', async () => {
      await ui.click('#choose-folder-button');
      await ui.waitForFunction(() => document.getElementById('output-folder').textContent.endsWith('Selected output'));
      await ui.evaluate(() => window.__uiTest.setChooseResult(null)); await ui.click('#choose-folder-button');
      assert.match(await ui.$eval('#output-folder', (element) => element.textContent), /Selected output$/);
      await ui.click('#open-folder-button'); assert.ok(await ui.evaluate(() => window.__uiTest.calls().some((entry) => entry.action === 'openFolder')));
    });
    await check('mock action failures surface without removing queue state', async () => {
      await ui.evaluate(() => window.__uiTest.failAction('retry', 'Retry failed: <b>fixture error</b>'));
      await updateJob(ui, 'mock-job-2', {status: 'failed', error: 'Ready to retry.'});
      await ui.click('[data-job-id="mock-job-2"] [data-action="retry"]');
      await ui.waitForFunction(() => !document.getElementById('app-notice').hidden && document.getElementById('app-notice').textContent.includes('Retry failed:'));
      assert.equal(await ui.$eval('#app-notice', (element) => element.querySelector('b')), null);
      assert.equal(await ui.$eval('[data-job-id="mock-job-2"]', (element) => element.dataset.status), 'failed');
      await ui.evaluate(() => window.__uiTest.failAction('retry', null));
    });
    await check('mock desktop and compact layouts have no horizontal overflow', async () => {
      await ui.evaluate(() => {document.getElementById('app-notice').hidden = true;});
      await screenshot(ui, 'mock-desktop.png', 1160, 870); await screenshot(ui, 'mock-compact-800.png', 800, 950);
      await ui.setViewport({width: 1160, height: 870});
    });
    await check('mock stale inspection result cannot enable changed URL', async () => {
      const oldUrl = 'https://fixture.example/slow-old'; const newUrl = 'https://fixture.example/current-new';
      await input(ui, oldUrl); await ui.click('#inspect-button'); const oldId = await pending(ui, oldUrl);
      await input(ui, newUrl);
      assert.equal(await enabled(ui, '#enqueue-button'), false);
      await ui.click('#inspect-button'); const newId = await pending(ui, newUrl);
      await resolve(ui, newId, info(newUrl, 'new-token', 'Current result')); await ui.waitForFunction(() => document.getElementById('video-title').textContent === 'Current result');
      await resolve(ui, oldId, info(oldUrl, 'old-token', 'Stale result'));
      assert.equal(await ui.$eval('#video-title', (element) => element.textContent), 'Current result');
      await input(ui, 'https://fixture.example/another-edit'); assert.equal(await enabled(ui, '#enqueue-button'), false);
      assert.equal(await ui.$eval('#inspection-result', (element) => element.hidden), true);
    });
    await check('mock hostile title and errors render only as text', async () => {
      const title = '<img src=x onerror="window.__injected=1"> owned fixture';
      await inspectFixture(ui, info('https://fixture.example/text-only', 'malicious-token', title));
      assert.equal(await ui.$eval('#video-title', (element) => element.textContent), title);
      assert.equal(await ui.$eval('#video-title', (element) => element.children.length), 0);
      await ui.click('#enqueue-button'); await ui.waitForSelector('[data-job-id="mock-job-3"]');
      await updateJob(ui, 'mock-job-3', {status: 'failed', error: '<script>window.__injected=2</script> error as text'});
      assert.equal(await ui.$eval('[data-job-id="mock-job-3"] .job-error', (element) => element.children.length), 0);
      assert.equal(await ui.evaluate(() => window.__injected), undefined);
      await input(ui, 'https://fixture.example/inspect-error'); await ui.click('#inspect-button'); const id = await pending(ui, 'https://fixture.example/inspect-error');
      await ui.evaluate((requestId) => window.__uiTest.rejectInspection(requestId, '<b>Inspection failed</b> as text'), id);
      await ui.waitForFunction(() => !document.getElementById('inspection-error').hidden);
      assert.equal(await ui.$eval('#inspection-error', (element) => element.children.length), 0);
      assert.match(await ui.$eval('#inspection-error', (element) => element.textContent), /<b>Inspection failed<\/b>/);
    });
    await check('mock silent source and tool notes are truthful', async () => {
      const silent = info('https://fixture.example/silent-source', 'silent-token', 'Owned silent fixture'); silent.choices = [{...silent.choices[0], audioCodec: null, merge: false, label: '1920 × 1080 · silent / no audio available'}]; silent.bestLabel = silent.choices[0].label;
      await inspectFixture(ui, silent); assert.match(await ui.$eval('#quality-detail', (element) => element.textContent), /no audio track/i);
      await ui.evaluate(() => window.__uiTest.setTools({ready: true, ytDlpVersion: 'mock', ffmpegVersion: 'ffmpeg version mock', issues: ['ffprobe is unavailable; verification will be limited.']}));
      assert.equal(await ui.$eval('#tools-issues', (element) => element.hidden), false);
      assert.match(await ui.$eval('#tools-issues', (element) => element.textContent), /verification will be limited/);
    });
    await check('mock clear finished preserves active items', async () => {
      await updateJob(ui, 'mock-job-2', {status: 'queued', error: null}); await ui.click('#clear-finished-button');
      await ui.waitForFunction(() => document.querySelectorAll('#queue-list > li').length === 1);
      assert.equal(await ui.$eval('#queue-list > li', (element) => element.dataset.jobId), 'mock-job-2');
    });
  } catch (error) {
    try {const session = mock || production; if (session?.page && !session.page.isClosed()) await session.page.screenshot({path: path.join(output, 'failure.png'), fullPage: true});} catch { }
    process.stderr.write(error.stack + '\n'); process.exitCode = 1;
  } finally {
    for (const session of [...sessions]) await stop(session);
    const report = {generatedAt: new Date().toISOString(), scope: mockOnly ? 'mock only' : 'production smoke and mock UI', passed: results.filter((result) => result.passed).length, failed: results.filter((result) => !result.passed).length, mediaRequests: 0, runtime: {electron, puppeteer: puppeteerPath}, results};
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(`UI checks: ${report.passed} passed, ${report.failed} failed. Screenshots/report: ${output}\n`);
  }
})();
