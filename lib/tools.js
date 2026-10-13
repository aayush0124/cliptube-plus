'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {execFile}=require('node:child_process');
function firstFile(candidates){return candidates.find(p=>p && fs.existsSync(p) && fs.statSync(p).isFile()) || null;}
function fromPath(name){for(const dir of (process.env.PATH || '').split(path.delimiter)){const candidate=path.join(dir,name);if(fs.existsSync(candidate))return candidate;}return null;}
function discover(root){
  const win=process.platform==='win32', exe=win?'.exe':'';
  return {
    ytdlp:firstFile([process.env.CLIPTUBE_YTDLP,path.join(root,'tools','yt-dlp'+exe),fromPath('yt-dlp'+exe)]),
    ffmpeg:firstFile([process.env.CLIPTUBE_FFMPEG,fromPath('ffmpeg'+exe)]),
    ffprobe:firstFile([process.env.CLIPTUBE_FFPROBE,fromPath('ffprobe'+exe)]),
    node:firstFile([process.env.CLIPTUBE_NODE,fromPath('node'+exe)])
  };
}
function version(binary,args){return new Promise(resolve=>{if(!binary)return resolve(null);execFile(binary,args,{windowsHide:true,timeout:10000,maxBuffer:1024*128},(err,out)=>resolve(err?null:String(out).split(/\r?\n/)[0].trim()));});}
async function status(tools){
  const [ytDlpVersion,ffmpegVersion,ffprobeVersion,nodeVersion]=await Promise.all([version(tools.ytdlp,['--version']),version(tools.ffmpeg,['-version']),version(tools.ffprobe,['-version']),version(tools.node,['--version'])]);
  const issues=[];
  if(!ytDlpVersion)issues.push('yt-dlp is missing or cannot run. See README for local setup.');
  if(!ffmpegVersion)issues.push('FFmpeg is missing or cannot run; best video + audio merging requires it.');
  if(!ffprobeVersion)issues.push('ffprobe is unavailable; output verification will be limited.');
  if(!nodeVersion || Number(nodeVersion.replace(/^v/,'').split('.')[0])<22)issues.push('Node.js 22+ is unavailable; some platforms such as YouTube may require this JavaScript runtime.');
  return {ready:!!ytDlpVersion && !!ffmpegVersion,ytDlpVersion,ffmpegVersion,ffprobeVersion,nodeVersion,issues};
}
module.exports={discover,status};
