'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  privateAddress, validateUrl, validatePublicUrl, safeFilename, inside,
  normalizeInfo, selectFormat, friendlyError,
} = require('../lib/media');

const publicUrl = 'https://media.example.com/video';
function source(overrides = {}) {
  return {
    id: 'fixture', title: 'Public fixture', uploader: 'Fixture owner', duration: 12,
    extractor_key: 'Generic', availability: 'public',
    formats: [
      {format_id: '18', width: 640, height: 360, fps: 30, vcodec: 'h264', acodec: 'aac', ext: 'mp4', filesize: 1000},
      {format_id: '136', width: 1280, height: 720, fps: 30, vcodec: 'h264', acodec: 'none', ext: 'mp4', filesize: 2000},
      {format_id: '137', width: 1920, height: 1080, fps: 30, vcodec: 'h264', acodec: 'none', ext: 'mp4', filesize: 3000},
      {format_id: '140', vcodec: 'none', acodec: 'aac', ext: 'm4a', filesize: 400},
    ], ...overrides,
  };
}

test('HTTP URL normalization trims surrounding whitespace and removes fragments', () => {
  assert.equal(validateUrl('  https://MEDIA.example.com/watch?v=abc#player  '), 'https://media.example.com/watch?v=abc');
  assert.equal(validateUrl('http://93.184.216.34/video.mp4'), 'http://93.184.216.34/video.mp4');
});

test('URL validation rejects malformed, non-web, credential-bearing, and multiple URLs', () => {
  for (const input of [null, 7, '', 'not a URL', 'file:///tmp/media.mp4', 'ftp://media.example.com/a',
    'javascript:alert(1)', 'https://user:password@media.example.com/a',
    'https://media.example.com/a\nhttps://media.example.com/b',
    'https://media.example.com/a b', 'https://media.example.com/' + 'a'.repeat(4096)]) {
    assert.throws(() => validateUrl(input), Error, String(input));
  }
});

test('URL validation rejects private addresses, local hostnames, and custom ports', () => {
  for (const host of ['localhost', 'video.localhost', 'nas.local', 'intranet',
    '127.0.0.1', '10.2.3.4', '172.16.0.1', '172.31.9.9', '192.168.1.1',
    '169.254.0.1', '100.64.0.1', '0.0.0.0', '198.18.0.1',
    '[::1]', '[::]', '[fc00::1]', '[fd12::1]', '[fe80::1]', '[ff02::1]',
    '[::ffff:127.0.0.1]', '[::ffff:7f00:1]']) {
    assert.throws(() => validateUrl(`https://${host}/video`), /Local and private/, host);
  }
  assert.throws(() => validateUrl('https://media.example.com:8080/video'), /standard public web/);
});

test('literal public IPv6 URLs are supported', () => {
  assert.equal(validateUrl('https://[2606:4700:4700::1111]/media.mp4'), 'https://[2606:4700:4700::1111]/media.mp4');
});

test('privateAddress distinguishes local IPv4/IPv6 from public addresses', () => {
  for (const ip of ['0.1.2.3', '10.0.0.1', '127.255.1.2', '169.254.8.9',
    '172.16.0.0', '172.31.255.255', '192.168.1.2', '100.64.1.2',
    '100.127.255.254', '198.18.0.1', '198.19.255.255', '224.0.0.1', '255.255.255.255',
    '::', '::1', 'fdab::1', 'fc00::1', 'fe80::1%12', 'febf::1', 'ff02::1',
    '2001:db8::2', '::ffff:10.0.0.1', '::ffff:c0a8:101']) {
    assert.equal(privateAddress(ip), true, ip);
  }
  for (const ip of ['93.184.216.34', '8.8.8.8', '172.15.0.1', '172.32.0.1',
    '100.63.255.255', '100.128.0.1', '2606:4700:4700::1111', '::ffff:0808:0808']) {
    assert.equal(privateAddress(ip), false, ip);
  }
});

test('fully expanded IPv6 loopback cannot pass private address checks', () => {
  assert.equal(privateAddress('0:0:0:0:0:0:0:1'), true);
  assert.equal(privateAddress('0:0:0:0:0:0:0:0'), true);
  assert.equal(privateAddress('0:0:0:0:0:ffff:7f00:1'), true);
});

test('DNS validation checks every returned address and refuses empty resolution', async () => {
  let requested;
  const lookup = async (hostname, options) => {
    requested = {hostname, options};
    return [{address: '93.184.216.34', family: 4}, {address: '2606:4700::1111', family: 6}];
  };
  assert.equal(await validatePublicUrl(publicUrl, {lookup}), publicUrl);
  assert.deepEqual(requested, {hostname: 'media.example.com', options: {all: true}});
  await assert.rejects(validatePublicUrl(publicUrl, {lookup: async () => [{address: '93.184.216.34'}, {address: '10.0.0.1'}]}), /local or private/);
  await assert.rejects(validatePublicUrl(publicUrl, {lookup: async () => [{address: '::ffff:c0a8:101'}]}), /local or private/);
  await assert.rejects(validatePublicUrl(publicUrl, {lookup: async () => []}), /local or private/);
  await assert.rejects(validatePublicUrl(publicUrl, {lookup: async () => {throw new Error('ENOTFOUND');}}), /ENOTFOUND/);
});

test('public IPv6 DNS lookup receives an unbracketed address', async () => {
  let requested;
  const input = 'https://[2606:4700:4700::1111]/media.mp4';
  assert.equal(await validatePublicUrl(input, {lookup: async host => {requested = host; return [{address: host, family: 6}];}}), input);
  assert.equal(requested, '2606:4700:4700::1111');
});

test('explicit loopback fixture option avoids DNS and permits only web URL schemes', async () => {
  let called = false;
  assert.equal(await validatePublicUrl('http://127.0.0.1:9876/video.mp4', {allowLoopback: true, lookup: async () => {called = true;}}), 'http://127.0.0.1:9876/video.mp4');
  assert.equal(called, false);
  assert.throws(() => validateUrl('file:///tmp/video.mp4', {allowLoopback: true}), /HTTP or HTTPS/);
});

test('safe filenames normalize Unicode, reserved devices, illegal characters, and length', () => {
  assert.equal(safeFilename('  Public <clip>: /test\\?*|%\x00  .  '), 'Public clip test');
  assert.equal(safeFilename('Ｆｕｌｌｗｉｄｔｈ／title'), 'Fullwidth title');
  assert.equal(safeFilename('CON'), '_CON');
  assert.equal(safeFilename('nul.txt'), '_nul.txt');
  assert.equal(safeFilename('LPT1.avi'), '_LPT1.avi');
  assert.equal(safeFilename('COM9'), '_COM9');
  assert.equal(safeFilename('...'), 'Untitled video');
  assert.equal(safeFilename(null), 'Untitled video');
  assert.equal(Array.from(safeFilename('😀'.repeat(130))).length, 100);
  assert.equal(safeFilename('news..  '), 'news');
  assert.doesNotMatch(safeFilename('../../unsafe.mp4'), /[/\\<>:"|?*%\x00-\x1f]/);
});

test('output path containment rejects traversal, siblings, absolute paths, and root itself', () => {
  const root = path.resolve('fixture-output');
  assert.equal(inside(root, 'clip.mp4'), path.join(root, 'clip.mp4'));
  assert.equal(inside(root, path.join('subfolder', 'clip.mp4')), path.join(root, 'subfolder', 'clip.mp4'));
  for (const filename of ['..', '.', '', path.join('..', 'fixture-output-sibling', 'clip.mp4'), path.resolve('other-output', 'clip.mp4')]) {
    assert.throws(() => inside(root, filename), /Unsafe output path/, filename);
  }
});

test('available source choices report original dimensions and select exact video plus audio IDs', () => {
  const info = normalizeInfo(source(), publicUrl);
  assert.equal(info.title, 'Public fixture');
  assert.equal(info.channel, 'Fixture owner');
  assert.equal(info.duration, 12);
  assert.equal(info.platform, 'Generic');
  assert.equal(selectFormat(info).format, '137+140');
  assert.equal(selectFormat(info).height, 1080);
  assert.equal(selectFormat(info).width, 1920);
  assert.equal(selectFormat(info).estimatedBytes, 3400);
  assert.equal(selectFormat(info).merge, true);
  assert.match(info.bestLabel, /1920[x×]1080/);
  assert.match(info.bestLabel, /aac \(merged\)/);
  assert.equal(selectFormat(info, '136').format, '136+140');
  assert.equal(selectFormat(info, '18').format, '18');
  assert.equal(selectFormat(info, '18').merge, false);
  assert.ok(info.warnings.some(w => /No upscaling or re-encoding/.test(w)));
  assert.throws(() => selectFormat(info, 'stale-format'), /no longer available/);
});

test('best quality is selected from actual dimensions even when formats are unordered', () => {
  const fixtures = source().formats;
  const info = normalizeInfo(source({formats: [fixtures[2], fixtures[3], fixtures[0], fixtures[1]]}), publicUrl);
  assert.equal(selectFormat(info).id, '137');
});

test('best available audio does not depend on input order', () => {
  const formats = source().formats;
  formats.push({format_id: 'audio-low', vcodec: 'none', acodec: 'aac', abr: 48, ext: 'm4a', filesize: 100});
  formats[3].abr = 128;
  assert.equal(selectFormat(normalizeInfo(source({formats}), publicUrl), '137').format, '137+140');
});

test('source dimensions and frame rate rank best quality without manufacturing a larger resolution', () => {
  const info = normalizeInfo(source({formats: [
    {format_id: 'portrait720', width: 720, height: 1280, fps: 60, vcodec: 'h264', acodec: 'aac'},
    {format_id: '1080slow', width: 1920, height: 1080, fps: 24, vcodec: 'h264', acodec: 'aac'},
    {format_id: '1080fast', width: 1920, height: 1080, fps: 60, vcodec: 'h264', acodec: 'aac'},
  ]}), publicUrl);
  assert.equal(selectFormat(info).id, '1080fast');
  assert.equal(info.choices.length, 3);
  assert.ok(info.choices.every(choice => choice.height <= 1280 && choice.width <= 1920));
});

test('automatic best includes audio and higher silent choices remain explicit', () => {
  const info = normalizeInfo(source({formats: [
    {format_id: 'withAudio', width: 1280, height: 720, vcodec: 'h264', acodec: 'aac'},
    {format_id: 'silentHigh', width: 1920, height: 1080, vcodec: 'h264', acodec: 'none'},
  ]}), publicUrl);
  assert.equal(selectFormat(info).id, 'withAudio');
  assert.equal(selectFormat(info, 'silentHigh').audioCodec, null);
  assert.ok(info.warnings.some(warning => /silent formats remain selectable/.test(warning)));
});

test('silent source formats and unknown dimensions are labeled truthfully', () => {
  const info = normalizeInfo(source({formats: [{format_id: 'video', vcodec: 'h264', acodec: 'none', ext: 'mp4'}]}), publicUrl);
  assert.equal(info.choices[0].audioCodec, null);
  assert.equal(info.choices[0].merge, false);
  assert.match(info.choices[0].label, /resolution unknown/);
  assert.match(info.choices[0].label, /silent/);
  assert.ok(info.warnings.some(w => /no audio/.test(w)));
  assert.ok(info.warnings.some(w => /dimensions are unknown/.test(w)));
});

test('DRM, live, playlists, and restricted media are refused', () => {
  for (const override of [{has_drm: true}, {availability: 'private'}, {availability: 'premium_only'}, {availability: 'subscriber_only'}, {availability: 'needs_auth'}]) {
    assert.throws(() => normalizeInfo(source(override), publicUrl), /authentication, payment, or DRM/);
  }
  for (const override of [{is_live: true}, {live_status: 'is_live'}, {live_status: 'is_upcoming'}, {live_status: 'post_live'}]) {
    assert.throws(() => normalizeInfo(source(override), publicUrl), /Live and upcoming/);
  }
  for (const override of [{_type: 'playlist'}, {entries: []}]) {
    assert.throws(() => normalizeInfo(source(override), publicUrl), /single video/);
  }
});

test('DRM, image-only and unsafe format selectors never become downloadable choices', () => {
  const formats = [
    {format_id: 'drm', vcodec: 'h264', acodec: 'aac', has_drm: true},
    {format_id: 'storyboard', vcodec: 'images', acodec: 'none', protocol: 'mhtml'},
    {format_id: 'best/video', vcodec: 'h264', acodec: 'aac'},
    {format_id: '140', vcodec: 'none', acodec: 'aac'},
  ];
  assert.throws(() => normalizeInfo(source({formats}), publicUrl), /No accessible non-DRM video formats/);
  formats.push(source().formats[0]);
  assert.deepEqual(normalizeInfo(source({formats}), publicUrl).choices.map(f => f.id), ['18']);
});

test('completed live recordings and public direct video metadata can be inspected', () => {
  assert.equal(normalizeInfo(source({live_status: 'was_live'}), publicUrl).choices.length, 3);
  const direct = normalizeInfo({url: publicUrl, format_id: 'mp4', title: 'Direct', width: 320, height: 180, vcodec: 'h264', acodec: 'aac'}, publicUrl);
  assert.equal(selectFormat(direct).format, 'mp4');
});

test('friendly errors explain blocked access, network and disk failures without URLs', () => {
  const cases = [
    ['ERROR: DRM encrypted media', /DRM-protected/],
    ['Sign in with cookies to confirm your age', /does not supply authentication/],
    ['HTTP Error 403: Forbidden', /stopped without trying alternate clients/],
    ['HTTP Error 429: Too many requests', /rate limit/],
    ['Unsupported URL', /Platform support can change/],
    ['ENOSPC: no space left on device', /not enough disk space/],
    ['getaddrinfo ENOTFOUND media.example.com', /Check connectivity/],
    ['Connection timed out', /Check connectivity/],
  ];
  for (const [raw, pattern] of cases) assert.match(friendlyError(raw), pattern);
  const sanitized = friendlyError('ERROR: unexpected download error from https://media.example.com/video?signature=secret');
  assert.equal(sanitized, 'unexpected download error from [remote URL]');
  assert.equal(friendlyError('x'.repeat(900)).length, 700);
});

module.exports = {source, publicUrl};
