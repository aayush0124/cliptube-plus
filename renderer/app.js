'use strict';

(() => {
  const api = window.cliptube;
  const $ = (id) => document.getElementById(id);
  const el = {
    form: $('inspect-form'), url: $('url-input'), inspect: $('inspect-button'),
    loading: $('inspection-loading'), inspectionError: $('inspection-error'),
    result: $('inspection-result'), title: $('video-title'), platform: $('video-platform'),
    meta: $('video-meta'), quality: $('quality-select'), qualityDetail: $('quality-detail'),
    warnings: $('inspection-warnings'), enqueue: $('enqueue-button'), notice: $('app-notice'),
    folder: $('output-folder'), chooseFolder: $('choose-folder-button'), openFolder: $('open-folder-button'),
    clear: $('clear-finished-button'), queue: $('queue-list'), empty: $('queue-empty'),
    count: $('queue-count'), summary: $('queue-summary'), tools: $('tools-status'),
    toolsText: $('tools-status-text'), issues: $('tools-issues'), issueList: $('tools-issue-list'),
    versions: $('tool-versions'), live: $('screen-reader-status'),
  };
  const state = { tools: { ready: false }, jobs: [], outputDir: '', inspection: null, inspectedUrl: '', inspecting: false, enqueuing: false };
  const jobElements = new Map();
  const pendingActions = new Set();
  const lastStatuses = new Map();
  let inspectionGeneration = 0;
  let noticeTimer;
  let receivedState = false;
  let receivedTools = false;
  const terminalStates = new Set(['completed', 'failed', 'canceled', 'interrupted']);
  const activeStates = new Set(['queued', 'inspecting', 'downloading', 'merging']);
  const statusNames = { queued: 'Queued', inspecting: 'Inspecting', downloading: 'Downloading', merging: 'Merging', completed: 'Completed', failed: 'Failed', canceled: 'Canceled', interrupted: 'Interrupted' };

  function errorText(error) {
    const text=error && typeof error.message === 'string' ? error.message : typeof error === 'string' ? error : 'The action could not be completed. Please try again.';
    return text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'');
  }
  function notify(message, isError = false) {
    clearTimeout(noticeTimer);
    el.notice.textContent = String(message);
    el.notice.classList.toggle('error', isError);
    el.notice.hidden = false;
    if (!isError) noticeTimer = setTimeout(() => { el.notice.hidden = true; }, 7000);
  }
  function currentUrl() { return el.url.value.trim(); }
  function plausibleUrl(value) {
    try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password; }
    catch { return false; }
  }
  function updateComposeButtons() {
    el.inspect.disabled = !api || !state.tools.ready || state.inspecting || !plausibleUrl(currentUrl());
    el.inspect.textContent = state.inspecting ? 'Inspecting…' : 'Inspect';
    el.enqueue.disabled = !state.tools.ready || state.enqueuing || !state.inspection || state.inspectedUrl !== currentUrl() || !el.quality.value;
    el.enqueue.querySelector('span').textContent = state.enqueuing ? 'Adding to queue…' : 'Add to download queue';
  }
  function invalidateInspection() {
    inspectionGeneration += 1;
    state.inspection = null;
    state.inspectedUrl = '';
    state.inspecting = false;
    el.loading.hidden = true;
    el.result.hidden = true;
    el.inspectionError.hidden = true;
    updateComposeButtons();
  }
  function formatDuration(seconds) {
    if (!Number.isFinite(Number(seconds)) || seconds == null) return '';
    const value = Math.max(0, Math.round(Number(seconds)));
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor(value % 3600 / 60);
    const rest = String(value % 60).padStart(2, '0');
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
  }
  function formatBytes(bytes) {
    if (!Number.isFinite(Number(bytes)) || Number(bytes) <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = Number(bytes), index = 0;
    while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
    return `${value.toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
  }
  function qualityDetail() {
    const inspection = state.inspection;
    if (!inspection) return;
    const choice = el.quality.value === 'best' ? inspection.choices.find((item) => String(item.id) === 'best') || inspection.choices[0] : inspection.choices.find((item) => String(item.id) === el.quality.value);
    if (el.quality.value === 'best') {
      el.qualityDetail.textContent = choice && choice.audioCodec && choice.audioCodec !== 'none' ? 'Uses the best available source video with audio, combined when needed. No upscaling.' : 'Uses the best available source video. This choice has no audio track. No upscaling.';
      return;
    }
    if (!choice) { el.qualityDetail.textContent = ''; return; }
    const details = [];
    if (choice.width && choice.height) details.push(`${choice.width} × ${choice.height} source`);
    else if (choice.height) details.push(`${choice.height}p source`);
    if (choice.fps) details.push(`${choice.fps} fps`);
    if (choice.videoCodec && choice.videoCodec !== 'none') details.push(String(choice.videoCodec));
    if (choice.audioCodec && choice.audioCodec !== 'none') details.push(String(choice.audioCodec));
    const size = formatBytes(choice.estimatedBytes);
    if (size) details.push(`about ${size}`);
    el.qualityDetail.textContent = `${details.join(' · ')}${details.length ? '. ' : ''}${choice.merge ? 'Video and audio will be combined.' : 'Saved in its source format.'}`;
  }
  function renderInspection(inspection) {
    el.title.textContent = inspection.title || 'Untitled video';
    el.platform.textContent = inspection.platform || 'PUBLIC VIDEO';
    el.meta.textContent = [inspection.channel, formatDuration(inspection.duration)].filter(Boolean).join(' · ') || 'Available formats from this public URL';
    el.quality.replaceChildren();
    const best = document.createElement('option');
    best.value = 'best';
    const providedBest = inspection.choices.find((item) => String(item.id) === 'best');
    best.textContent = providedBest ? providedBest.label : `Best available${inspection.bestLabel ? ` · ${inspection.bestLabel}` : ''}`;
    el.quality.append(best);
    for (const choice of inspection.choices) {
      if (String(choice.id) === 'best') continue;
      const option = document.createElement('option');
      option.value = String(choice.id); option.textContent = choice.label || String(choice.id);
      el.quality.append(option);
    }
    el.quality.value = 'best';
    el.warnings.replaceChildren();
    for (const warning of inspection.warnings || []) {
      const item = document.createElement('li'); item.textContent = String(warning); el.warnings.append(item);
    }
    el.warnings.hidden = !el.warnings.childElementCount;
    el.result.hidden = false;
    qualityDetail();
  }
  async function inspect(event) {
    event.preventDefault();
    if (!api || !state.tools.ready || state.inspecting) return;
    const url = currentUrl();
    if (!plausibleUrl(url)) {
      el.inspectionError.textContent = 'Enter a complete public video URL starting with https:// or http://.';
      el.inspectionError.hidden = false;
      return;
    }
    const generation = ++inspectionGeneration;
    state.inspection = null; state.inspectedUrl = ''; state.inspecting = true;
    el.result.hidden = true; el.inspectionError.hidden = true; el.loading.hidden = false;
    updateComposeButtons();
    try {
      const inspection = await api.inspect(url);
      if (generation !== inspectionGeneration || currentUrl() !== url) return;
      if (!inspection || !inspection.token || !Array.isArray(inspection.choices) || !inspection.choices.length) throw new Error('This URL did not expose any downloadable public video formats.');
      state.inspection = inspection; state.inspectedUrl = url;
      renderInspection(inspection);
      el.live.textContent = `Video inspected: ${inspection.title || 'Untitled video'}. Available source quality choices are ready.`;
    } catch (error) {
      if (generation !== inspectionGeneration || currentUrl() !== url) return;
      el.inspectionError.textContent = errorText(error); el.inspectionError.hidden = false;
    } finally {
      if (generation === inspectionGeneration) { state.inspecting = false; el.loading.hidden = true; updateComposeButtons(); }
    }
  }
  async function enqueue() {
    if (el.enqueue.disabled) return;
    const inspection = state.inspection;
    const choiceId = el.quality.value;
    state.enqueuing = true; updateComposeButtons();
    try {
      const job = await api.enqueue({ token: inspection.token, choiceId });
      if (job && job.id && !state.jobs.some((item) => item.id === job.id)) { state.jobs.push(job); renderQueue(); }
      notify(`Added “${(job && job.title) || inspection.title || 'video'}” to the download queue.`);
    } catch (error) { notify(errorText(error), true); }
    finally { state.enqueuing = false; updateComposeButtons(); }
  }
  function makeJob(job) {
    const row = document.createElement('li'); row.className = 'job'; row.dataset.jobId = job.id;
    const header = document.createElement('div'); header.className = 'job-header';
    const heading = document.createElement('div');
    const title = document.createElement('h3'); title.className = 'job-title';
    const meta = document.createElement('p'); meta.className = 'job-meta';
    heading.append(title, meta);
    const status = document.createElement('span'); status.className = 'job-status';
    header.append(heading, status);
    const progress = document.createElement('progress'); progress.className = 'job-progress'; progress.max = 100;
    const detail = document.createElement('div'); detail.className = 'job-detail';
    const stage = document.createElement('span'); stage.className = 'job-stage';
    const percent = document.createElement('span'); percent.className = 'job-percent';
    detail.append(stage, percent);
    const error = document.createElement('p'); error.className = 'job-error';
    const actions = document.createElement('div'); actions.className = 'job-actions';
    const buttons = {};
    for (const [action, label] of [['cancel', 'Cancel'], ['retry', 'Retry'], ['show', 'Show in folder']]) {
      const button = document.createElement('button'); button.type = 'button'; button.className = `job-action ${action}`; button.dataset.action = action; button.textContent = label;
      button.addEventListener('click', () => runJobAction(job.id, action));
      buttons[action] = button; actions.append(button);
    }
    row.append(header, progress, detail, error, actions);
    return { row, title, meta, status, progress, stage, percent, error, actions, buttons };
  }
  function stageText(job) {
    if (job.status === 'completed') return 'Saved successfully';
    if (job.status === 'canceled') return 'Download canceled';
    if (job.status === 'interrupted') return 'Interrupted when the app closed. Retry to download again.';
    if (job.status === 'failed') return job.stage || 'Download could not finish';
    if (job.status === 'queued') return job.stage || 'Waiting for its turn';
    if (job.status === 'merging') return job.stage || 'Combining source video and audio';
    const speed = typeof job.speed === 'number' ? job.speed > 0 ? `${formatBytes(job.speed)}/s` : '' : job.speed;
    return [job.stage || statusNames[job.status] || 'Working', speed, job.eta == null ? '' : typeof job.eta === 'number' ? `${formatDuration(job.eta)} remaining` : job.eta].filter(Boolean).join(' · ');
  }
  function updateJob(node, job) {
    node.row.dataset.status = job.status;
    node.title.textContent = job.title || 'Untitled video';
    node.meta.textContent = [job.qualityLabel, Number(job.attempt) > 1 ? `Attempt ${job.attempt}` : ''].filter(Boolean).join(' · ');
    node.status.textContent = statusNames[job.status] || job.status || 'Unknown';
    node.progress.hidden = !['downloading', 'merging', 'completed'].includes(job.status);
    node.progress.setAttribute('aria-label', `Download progress for ${job.title || 'video'}`);
    const value = job.status === 'completed' ? 100 : typeof job.progress === 'number' ? Math.max(0, Math.min(100, job.progress)) : null;
    if (value === null) node.progress.removeAttribute('value'); else node.progress.value = value;
    node.percent.textContent = value === null || node.progress.hidden ? '' : `${Math.round(value)}%`;
    node.stage.textContent = stageText(job);
    node.error.textContent = job.error ? String(job.error) : '';
    node.error.hidden = !job.error;
    node.buttons.cancel.hidden = !activeStates.has(job.status);
    node.buttons.retry.hidden = !['failed', 'canceled', 'interrupted'].includes(job.status);
    node.buttons.show.hidden = job.status !== 'completed' || !job.file;
    for (const [action, button] of Object.entries(node.buttons)) {
      button.disabled = pendingActions.has(job.id);
      button.setAttribute('aria-label', `${action === 'show' ? 'Show in folder' : action === 'retry' ? 'Retry' : 'Cancel'}: ${job.title || 'video'}`);
    }
    node.actions.hidden = Object.values(node.buttons).every((button) => button.hidden);
  }
  function renderQueue() {
    const ids = new Set(state.jobs.map((job) => job.id));
    for (const [id, node] of jobElements) if (!ids.has(id)) { node.row.remove(); jobElements.delete(id); lastStatuses.delete(id); }
    state.jobs.forEach((job, index) => {
      let node = jobElements.get(job.id);
      if (!node) { node = makeJob(job); jobElements.set(job.id, node); }
      updateJob(node, job);
      const existingAtPosition = el.queue.children[index];
      if (existingAtPosition !== node.row) el.queue.insertBefore(node.row, existingAtPosition || null);
      const previous = lastStatuses.get(job.id);
      if (previous && previous !== job.status && terminalStates.has(job.status)) el.live.textContent = `${job.title || 'Video'}: ${statusNames[job.status] || job.status}.`;
      lastStatuses.set(job.id, job.status);
    });
    el.count.textContent = String(state.jobs.length);
    el.empty.hidden = state.jobs.length > 0;
    const active = state.jobs.filter((job) => activeStates.has(job.status)).length;
    const completed = state.jobs.filter((job) => job.status === 'completed').length;
    el.summary.textContent = state.jobs.length ? [active ? `${active} active` : '', completed ? `${completed} saved` : '', `${state.jobs.length} total`].filter(Boolean).join(' · ') : 'No downloads yet';
    el.clear.disabled = !state.jobs.some((job) => terminalStates.has(job.status));
  }
  async function runJobAction(id, action) {
    if (pendingActions.has(id)) return;
    pendingActions.add(id); renderQueue();
    try {
      if (action === 'cancel') await api.cancel(id);
      if (action === 'retry') await api.retry(id);
      if (action === 'show') await api.showFile(id);
    } catch (error) { notify(errorText(error), true); }
    finally { pendingActions.delete(id); renderQueue(); }
  }
  function updateFolder(folder) {
    state.outputDir = typeof folder === 'string' ? folder : '';
    el.folder.textContent = state.outputDir || 'Choose a download folder';
    el.folder.title = state.outputDir;
    el.openFolder.disabled = !state.outputDir;
  }
  function applyTools(tools) {
    state.tools = tools && typeof tools === 'object' ? tools : { ready: false };
    const issues = Array.isArray(state.tools.issues) ? state.tools.issues : [];
    el.tools.classList.toggle('ready', Boolean(state.tools.ready));
    el.tools.classList.toggle('needs-attention', !state.tools.ready);
    el.toolsText.textContent = state.tools.ready ? issues.length ? 'Tools ready · setup notes below' : 'Download tools ready' : 'Download tools need setup';
    el.issueList.replaceChildren();
    for (const issue of issues) { const item = document.createElement('li'); item.textContent = typeof issue === 'string' ? issue : issue.message || String(issue); el.issueList.append(item); }
    el.issues.hidden = !issues.length;
    const ffmpegVersion = state.tools.ffmpegVersion ? String(state.tools.ffmpegVersion).replace(/^ffmpeg version\s+/i, '').split(/\s+/)[0] : '';
    el.versions.textContent = [state.tools.ytDlpVersion ? `yt-dlp ${state.tools.ytDlpVersion}` : '', ffmpegVersion ? `FFmpeg ${ffmpegVersion}` : ''].filter(Boolean).join(' · ') || 'Local downloads · powered by yt-dlp + FFmpeg';
    updateComposeButtons();
  }
  function applyState(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    if(snapshot.persistenceError) notify(snapshot.persistenceError, true);
    if (Array.isArray(snapshot.jobs)) { state.jobs = snapshot.jobs; renderQueue(); }
    if (typeof snapshot.outputDir === 'string') updateFolder(snapshot.outputDir);
  }
  async function buttonAction(button, action) {
    if (!api || button.disabled) return;
    button.disabled = true;
    try { await action(); } catch (error) { notify(errorText(error), true); }
    finally {
      button.disabled = false;
      if (button === el.openFolder) button.disabled = !state.outputDir;
      if (button === el.clear) renderQueue();
    }
  }
  el.form.addEventListener('submit', inspect);
  el.url.addEventListener('input', invalidateInspection);
  el.quality.addEventListener('change', () => { qualityDetail(); updateComposeButtons(); });
  el.enqueue.addEventListener('click', enqueue);
  el.chooseFolder.addEventListener('click', () => buttonAction(el.chooseFolder, async () => { const folder = await api.chooseFolder(); if (folder) updateFolder(folder); }));
  el.openFolder.addEventListener('click', () => buttonAction(el.openFolder, () => api.openFolder()));
  el.clear.addEventListener('click', () => buttonAction(el.clear, () => api.clearFinished()));

  async function initialize() {
    if (!api) {
      applyTools({ ready: false, issues: ['The local app bridge is unavailable. Launch ClipTube Plus with its Start script instead of opening this HTML file directly.'] });
      updateFolder(''); el.chooseFolder.disabled = true;
      return;
    }
    try {
      api.onState((snapshot) => { receivedState = true; applyState(snapshot); });
      api.onTools((tools) => { receivedTools = true; applyTools(tools && tools.tools ? tools.tools : tools); });
      const snapshot = await api.bootstrap();
      if (!receivedState) applyState(snapshot);
      if (!receivedTools) applyTools(snapshot.tools);
    } catch (error) {
      applyTools({ ready: false, issues: [errorText(error)] });
      notify('The app could not initialize. Check the tool setup message above.', true);
    }
  }
  initialize();
})();
