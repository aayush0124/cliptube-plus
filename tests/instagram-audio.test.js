"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const {audioPageId,parseAudioPage,resolveAudioPage} = require('../lib/instagram-audio');
const {normalizeInfo,selectFormat,friendlyError} = require('../lib/media');
const page = 'https://www.instagram.com' + '/reels/audio/123456/';
const asset = {audio_asset_id:'123456',progressive_download_url:'https://audio.cdninstagram.com/fixture.m4a',original_audio_title:'Fixture audio'};
const html = value => `<script type="application/json">${JSON.stringify(value)}</script>`;
test('recognizes only Instagram numeric audio pages',()=>{
  assert.equal(audioPageId(page+'?example=1'), '123456');
  for(const url of [page.replace('www.instagram.com','instagram.com.example.org'),page.replace('123456','invalid'),page+'extra','https://www.instagram.com'+'/reel/fixture/']) assert.equal(audioPageId(url),null);
});
test('extracts matching original and licensed audio metadata, including escaped URLs',()=>{
  assert.equal(parseAudioPage(html({data:{original_audio_info:asset}}),'123456').title,'Fixture audio');
  assert.equal(parseAudioPage(html({music_asset_info:{...asset,audio_asset_id:undefined,id:'123456',title:'Track'}}),'123456').title,'Track');
  assert.equal(parseAudioPage('<script type="application/json">'+JSON.stringify({original_audio_info:asset}).replaceAll('/', '\\/')+'</script>','123456').url,asset.progressive_download_url);
});
test('refuses unrelated, ambiguous, unavailable and unsafe audio assets',()=>{
  for(const value of [{original_audio_info:{...asset,audio_asset_id:'999'}},
    {original_audio_info:{...asset,is_available:false}},
    {original_audio_info:{...asset,has_drm:true}},
    {original_audio_info:{...asset,progressive_download_url:'http://127.0.0.1/private'}},
    {original_audio_info:{...asset,progressive_download_url:'https://audio.cdninstagram.com.example.org/x'}},
    [{original_audio_info:asset},{original_audio_info:{...asset,progressive_download_url:'https://audio.cdninstagram.com/other.m4a'}}]]) {
    assert.throws(()=>parseAudioPage(html(value),'123456'),/Instagram audio:/);
  }
  assert.throws(()=>parseAudioPage('<html>Public shell</html>','123456'),/specific public reel/);
});
test('public fetch rejects refusals and redirects without alternate requests',async()=>{
  for(const status of [302,401,403,404,429]) {
    let calls=0;
    await assert.rejects(resolveAudioPage(page,{validate:async()=>{},fetchPage:async(url,options)=>{
      calls++;assert.equal(options.redirect,'manual');assert.equal(options.headers.Cookie,undefined);return new Response(null,{status});
    }}),new RegExp(`HTTP ${status}`));
    assert.equal(calls,1);
  }
});
test('resolver validates both public hosts, bounds metadata and supports cancellation',async()=>{
  const checked=[];
  const result=await resolveAudioPage(page,{validate:async url=>checked.push(url),fetchPage:async()=>new Response(html({original_audio_info:asset}))});
  assert.equal(result.url,asset.progressive_download_url);assert.deepEqual(checked,[page,asset.progressive_download_url]);
  await assert.rejects(resolveAudioPage(page,{validate:async()=>{},fetchPage:async()=>new Response('x'.repeat(8*1024*1024+1))}),/size limit/);
  const signal=AbortSignal.abort();
  await assert.rejects(resolveAudioPage(page,{signal,validate:async()=>{},fetchPage:async(url,options)=>{options.signal.throwIfAborted();}}),/abort/i);
});
test('audio-only formats retain exact choices and select highest bitrate',()=>{
  const info=normalizeInfo({formats:[{format_id:'high',vcodec:'none',acodec:'aac',abr:128},{format_id:'low',vcodec:'none',acodec:'aac',abr:64}]},'https://media.example.com/audio.m4a');
  assert.equal(selectFormat(info).id,'high');assert.equal(selectFormat(info,'low').format,'low');
  assert.match(info.bestLabel,/Audio only/);assert.ok(info.warnings.every(w=>!w.includes('dimensions')));
  assert.match(friendlyError('Instagram audio: login required. Paste a specific public reel URL.'),/specific public reel/);
});
