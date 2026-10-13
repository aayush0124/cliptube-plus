'use strict';
const net = require('node:net');
const dns = require('node:dns').promises;
const path = require('node:path');

function privateAddress(address) {
  let ip = address.toLowerCase().split('%')[0];
  if(net.isIP(ip)===6){try{ip=new URL('http://['+ip+']/').hostname.slice(1,-1);}catch{}}
  if (net.isIP(ip) === 4) {
    const [a,b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224 || (a === 198 && [18,19].includes(b));
  }
  if (net.isIP(ip) === 6) {
    if (ip.startsWith('::ffff:')) {
      const mapped = ip.slice(7);
      if (net.isIP(mapped) === 4) return privateAddress(mapped);
      const pieces = mapped.split(':');
      if (pieces.length === 2) {
        const n = parseInt(pieces[0],16) * 65536 + parseInt(pieces[1],16);
        return privateAddress([n>>>24,(n>>>16)&255,(n>>>8)&255,n&255].join('.'));
      }
    }
    return ip === '::' || ip === '::1' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || ip.startsWith('ff') || ip.startsWith('2001:db8:');
  }
  return false;
}
function validateUrl(input, {allowLoopback = false} = {}) {
  if (typeof input !== 'string' || input.length > 4096 || /[\x00-\x20\x7f]/.test(input.trim())) throw new Error('Paste one complete public HTTP or HTTPS video URL.');
  let url;
  try { url = new URL(input.trim()); } catch { throw new Error('That is not a valid URL.'); }
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use a public HTTP or HTTPS URL without login credentials.');
  const host = url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  if (!allowLoopback && (privateAddress(host) || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || (!net.isIP(host) && !host.includes('.')))) throw new Error('Local and private network URLs are not supported.');
  if (!allowLoopback && url.port) throw new Error('Use the platform’s standard public web URL.');
  if (!host) throw new Error('The URL needs a hostname.');
  url.hash = '';
  return url.href;
}
async function validatePublicUrl(input, options = {}) {
  const normalized = validateUrl(input, options);
  if (!options.allowLoopback) {
    const addresses = await (options.lookup || dns.lookup)(new URL(normalized).hostname.replace(/^\[|\]$/g,''), {all:true});
    if (!addresses.length || addresses.some(x => privateAddress(x.address))) throw new Error('The URL resolves to a local or private address.');
  }
  return normalized;
}
function safeFilename(title) {
  let name = String(title || 'Untitled video').normalize('NFKC').replace(/[<>:"/\\|?*%\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim().replace(/[. ]+$/g,'');
  name = Array.from(name).slice(0,100).join('').replace(/[. ]+$/g,'') || 'Untitled video';
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) name = '_' + name;
  return name;
}
function inside(directory, filename) {
  const root = path.resolve(directory), target = path.resolve(root, filename);
  const relative=path.relative(root,target);
  if (!relative || relative==='..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative)) throw new Error('Unsafe output path.');
  return target;
}
function humanBytes(n) { return !Number.isFinite(n) || n <= 0 ? 'size unknown' : n > 1024**3 ? (n/1024**3).toFixed(1)+' GB' : (n/1024**2).toFixed(1)+' MB'; }
function normalizeInfo(info, url) {
  if (info._type === 'playlist' || info.entries) throw new Error('Paste a single video URL; playlists are not supported.');
  if (info.is_live || ['is_live','is_upcoming','post_live'].includes(info.live_status)) throw new Error('Live and upcoming streams are not supported. Try a finished video.');
  if (info.has_drm || info._has_drm || ['private','premium_only','subscriber_only','needs_auth'].includes(info.availability)) throw new Error('This media requires authentication, payment, or DRM access and is not supported.');
  const formats = (info.formats || (info.url ? [info] : [])).filter(f => !f.has_drm && !/mhtml|images/.test(f.protocol || '') && f.format_id != null && /^[a-zA-Z0-9_.-]+$/.test(String(f.format_id)));
  const audios = formats.filter(f => f.acodec && f.acodec !== 'none' && f.vcodec === 'none');
  const audio = audios.sort((a,b)=>(a.quality ?? -1)-(b.quality ?? -1) || (a.abr || a.tbr || 0)-(b.abr || b.tbr || 0) || (a.asr || 0)-(b.asr || 0)).at(-1);
  const videos = formats.filter(f => f.vcodec !== 'none' && (f.vcodec || /^(mp4|webm|mkv|mov|ogg|ogv|m3u8|mpd)$/.test(f.ext || '')));
  const choices = videos.map(f => {
    const unknownAudio = !f.acodec;
    const hasAudio = !!f.acodec && f.acodec !== 'none';
    const merge = !hasAudio && !unknownAudio && !!audio;
    const format = String(f.format_id) + (merge ? '+' + audio.format_id : '');
    const width = Number(f.width) || null, height = Number(f.height) || null;
    const estimatedBytes = (f.filesize || f.filesize_approx || 0) + (merge ? audio.filesize || audio.filesize_approx || 0 : 0) || null;
    const dimensions = width && height ? `${width}×${height}` : height ? `${height}p` : 'resolution unknown';
    const audioCodec = hasAudio ? f.acodec : merge ? audio.acodec : unknownAudio ? 'audio unknown' : null;
    return {id:String(f.format_id), format, label:`${dimensions} · ${f.fps ? f.fps+' fps · ' : ''}${f.vcodec || 'codec unknown'} · ${audioCodec ? audioCodec + (merge ? ' (merged)' : '') : 'silent / no audio available'} · ${humanBytes(estimatedBytes)} · ID ${f.format_id}`,
      width,height,fps:f.fps || null,videoCodec:f.vcodec,audioCodec,merge,estimatedBytes,ext:f.ext};
  }).reverse().sort((a,b)=>{
    const resolution=f=>f.width && f.height ? Math.min(f.width,f.height) : f.height || f.width || 0;
    return resolution(b)-resolution(a) || (b.fps || 0)-(a.fps || 0);
  });
  if (!choices.length) throw new Error('No accessible non-DRM video formats were returned. This platform or direct URL may not expose video metadata.');
  const warnings = ['Dimensions are reported by the source. No upscaling or re-encoding is performed.'];
  if (choices.some(f=>!f.audioCodec)) warnings.push('Some source formats contain no audio. Silent choices are labeled.');
  if (choices.some(f=>!f.width || !f.height)) warnings.push('Some source dimensions are unknown until the file is downloaded and probed.');
  const best=choices.find(f=>f.audioCodec) || choices[0];
  if(best!==choices[0])warnings.push('Best available selects the highest quality that includes audio; higher silent formats remain selectable.');
  return {url,title:info.title || info.id || 'Untitled video',channel:info.channel || info.uploader || '',duration:info.duration || null,platform:info.extractor_key || info.extractor || new URL(url).hostname,choices,bestChoiceId:best.id,bestLabel:best.label,warnings};
}
function selectFormat(info, id = 'best') {
  const selected = id === 'best' ? info.choices.find(f=>f.id===info.bestChoiceId) || info.choices.find(f=>f.audioCodec) || info.choices[0] : info.choices.find(f=>f.id === id);
  if (!selected) throw new Error('That format is no longer available. Inspect the URL again and choose an available format.');
  return selected;
}
function friendlyError(raw) {
  const s = String(raw || 'Unknown download error');
  if(/Local and private network URLs|resolves to a local or private|standard public web URL|not a valid URL|one complete public HTTP|without login credentials|needs a hostname/i.test(s))return s.slice(0,700);
  if (/DRM|encrypted media/i.test(s)) return 'DRM-protected media is not supported.';
  if (/sign ?in|log ?in|cookies|not a bot|authentication|age.restricted|confirm your age|private video|members.only|premium|paywall/i.test(s)) return 'The platform requires login, age verification, membership, or other restricted access. This app does not supply authentication or bypass access restrictions.';
  if (/403|401|429|forbidden|access denied/i.test(s)) return 'The platform refused public access or imposed a rate limit. The app stopped without trying alternate clients or authentication.';
  if (/Unsupported URL|No video formats|not supported/i.test(s)) return 'No supported public video was found at this URL. Platform support can change.';
  if (/ENOSPC|no space left|disk.*full/i.test(s)) return 'There is not enough disk space in the selected output folder.';
  if (/ENOTFOUND|getaddrinfo|unable to resolve|name resolution|network.*unreachable|timed? ?out/i.test(s)) return 'Could not reach the media source. Check connectivity and try again when available.';
  return s.replace(/https?:\/\/[^\s]+/g,'[remote URL]').replace(/^ERROR:\s*/i,'').slice(0,700);
}
module.exports = {privateAddress,validateUrl,validatePublicUrl,safeFilename,inside,normalizeInfo,selectFormat,friendlyError};
