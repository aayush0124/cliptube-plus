"use strict";
const {validatePublicUrl} = require('./media');

function audioPageId(value) {
  let url;
  try {url = new URL(value);} catch {return null;}
  if (!['instagram.com', 'www.instagram.com', 'm.instagram.com'].includes(url.hostname)) return null;
  return /^\/reels?\/audio\/(\d+)\/?$/.exec(url.pathname)?.[1] || null;
}
const unavailable = 'Instagram audio: this page does not expose a public audio file. It may require login, be unavailable in your region, or have changed. Paste a specific public reel URL using the sound instead; only the audio exposed by this page can be saved.';
function audioError(detail) {return new Error('Instagram audio: ' + detail + ' Try again later or paste a specific public reel URL using the sound.');}

// Read only explicitly identified audio assets, never soundtracks of related reels.
function parseAudioPage(html, id) {
  const candidates = [];
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/(?:ld\+)?json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    let root;
    try {root = JSON.parse(match[1]);} catch {continue;}
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      for (const key of ['original_audio_info', 'music_asset_info']) {
        const asset = node[key];
        if (!asset || typeof asset !== 'object') continue;
        if (![asset.audio_asset_id, asset.audio_cluster_id, asset.id].some(value => String(value) === id)) continue;
        if (asset.has_drm || asset.is_drm_protected || asset.is_explicitly_unavailable || asset.is_restricted || asset.is_available === false) throw audioError('The source marks this audio unavailable.');
        if (typeof asset.progressive_download_url === 'string') candidates.push({
          url: asset.progressive_download_url,
          title: asset.title || asset.original_audio_title || `Instagram audio ${id}`,
        });
      }
      stack.push(...Object.values(node).filter(value => value && typeof value === 'object'));
    }
  }
  const unique = [...new Map(candidates.map(item => [item.url, item])).values()];
  if (unique.length !== 1) throw new Error(unavailable);
  const result = unique[0];
  let media;
  try {media = new URL(result.url);} catch {throw new Error(unavailable);}
  if (media.protocol !== 'https:' || media.username || media.password || media.port ||
      !['cdninstagram.com', 'fbcdn.net'].some(domain => media.hostname.endsWith('.' + domain))) throw new Error(unavailable);
  return result;
}
async function resolveAudioPage(url, {signal, fetchPage = fetch, validate = validatePublicUrl} = {}) {
  const id = audioPageId(url);
  if (!id) throw new Error('Invalid Instagram audio page URL.');
  // No cookies, private API, login, impersonation or redirect fallback.
  const pageUrl = new URL(`/reels/audio/${id}/`, 'https://www.instagram.com').href;
  await validate(pageUrl);
  const response = await fetchPage(pageUrl, {
    signal, redirect: 'manual', headers: {Accept: 'text/html'},
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw audioError(`Public access failed (HTTP ${response.status}); no authentication or access workaround was attempted.`);
  }
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8 * 1024 * 1024) throw audioError('The public page exceeds the metadata size limit.');
      chunks.push(Buffer.from(value));
    }
  } finally {await reader.cancel();}
  const result = parseAudioPage(Buffer.concat(chunks).toString('utf8'), id);
  await validate(result.url);
  return result;
}
module.exports = {audioPageId, parseAudioPage, resolveAudioPage};
