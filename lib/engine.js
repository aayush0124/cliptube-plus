'use strict';
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {validatePublicUrl,normalizeInfo,selectFormat,safeFilename,inside,friendlyError} = require('./media');

function runProcess(binary,args,{onLine,timeout=0,limit=16*1024*1024,capture=true}={}) {
  let child, timer, canceled=false, failure=null, stdout='', stderr='', pending='';
  const promise = new Promise((resolve,reject)=>{
    child = spawn(binary,args,{windowsHide:true,shell:false});
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',d=>{
      if(capture)stdout += d;
      if (stdout.length > limit) { failure=new Error('The engine returned too much metadata.');cancel();return; }
      pending += d;
      const lines = pending.split(/\r?\n/); pending=lines.pop();
      if(pending.length>limit){failure=new Error('The engine returned an oversized output line.');cancel();return;}
      for (const line of lines) {try{onLine?.(line);}catch(e){failure=e;cancel();}}
    });
    child.stderr.on('data',d=>{stderr=(stderr+d).slice(-16000);});
    child.on('error',reject);
    child.on('close',code=>{
      clearTimeout(timer);
      if (pending) {try{onLine?.(pending);}catch(e){failure=e;}}
      if(failure)reject(failure);
      else if (canceled) reject(Object.assign(new Error('Operation canceled.'),{canceled:true}));
      else if (code===0) resolve(stdout);
      else reject(new Error(stderr || `Download engine exited with code ${code}.`));
    });
    if (timeout) {timer=setTimeout(()=>{failure=new Error('The media source timed out.');cancel();},timeout);timer.unref();}
  });
  function cancel() {
    canceled=true;
    if (child && child.exitCode===null && child.pid) {
      if (process.platform==='win32') {
        // Only the process tree launched for this operation, including its FFmpeg child.
        const killer=spawn(path.join(process.env.SystemRoot || 'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,shell:false});
        killer.on('error',()=>{child.kill();});
        killer.on('close',code=>{if(code!==0 && child.exitCode===null)child.kill();});
        const fallback=setTimeout(()=>{if(child.exitCode===null)child.kill();if(killer.exitCode===null)killer.kill();},1500);
        fallback.unref();killer.on('close',()=>clearTimeout(fallback));
      } else child.kill('SIGTERM');
    }
  }
  return {promise,cancel};
}
class Engine {
  constructor(tools,{allowLoopback=false}={}) {this.tools=tools;this.allowLoopback=allowLoopback;}
  baseArgs() {
    return ['--ignore-config','--no-config-locations','--no-plugin-dirs','--no-remote-components','--xff','never','--no-playlist','--no-colors','--socket-timeout','20','--retries','2','--fragment-retries','2','--concurrent-fragments','1','--ffmpeg-location',this.tools.ffmpeg,
      ...(this.tools.node ? ['--no-js-runtimes','--js-runtimes',`node:${this.tools.node}`] : [])];
  }
  inspect(url) {
    let operation;
    let canceled=false;
    const promise=(async()=>{
      const valid=await validatePublicUrl(url,{allowLoopback:this.allowLoopback});
      if (canceled) throw Object.assign(new Error('Operation canceled.'),{canceled:true});
      operation=runProcess(this.tools.ytdlp,[...this.baseArgs(),'--dump-single-json','--skip-download','--',valid],{timeout:90000});
      const raw=JSON.parse(await operation.promise);
      // Generic direct links may omit dimensions or misclassify Ogg video as audio.
      // Probe only the validated pasted URL, never arbitrary extracted URLs.
      if(raw.direct && this.tools.ffprobe && raw.formats?.length===1 && !(raw.formats[0].width && raw.formats[0].height)) {
        if(canceled)throw Object.assign(new Error('Operation canceled.'),{canceled:true});
        operation=runProcess(this.tools.ffprobe,['-v','error','-rw_timeout','20000000','-show_streams','-show_format','-of','json',valid],{timeout:45000,limit:1024*1024});
        const probe=JSON.parse(await operation.promise),video=probe.streams?.find(s=>s.codec_type==='video'),audio=probe.streams?.find(s=>s.codec_type==='audio');
        if(video){Object.assign(raw.formats[0],{width:video.width,height:video.height,vcodec:video.codec_name,acodec:audio?.codec_name || 'none'});
          const [a,b]=String(video.avg_frame_rate || '0/1').split('/').map(Number);raw.formats[0].fps=b?a/b:0;}
        if(probe.format?.duration)raw.duration=Number(probe.format.duration);
      }
      return normalizeInfo(raw,valid);
    })();
    return {promise,cancel(){canceled=true;operation?.cancel();}};
  }
  download(info,choiceId,workDir,onProgress) {
    const choice=selectFormat(info,choiceId);
    fs.mkdirSync(workDir,{recursive:true});
    const produced=[];
    const op=runProcess(this.tools.ytdlp,[...this.baseArgs(),'--newline','--no-simulate','--windows-filenames','--no-overwrites','--no-continue','--no-mtime','--restrict-filenames','-f',choice.format,
      '--merge-output-format','mkv','--progress-template','download:CLIPTUBE_PROGRESS %(progress)j','--print','after_move:CLIPTUBE_FILE %(filepath)j','-o',path.join(workDir,'media.%(ext)s'),'--',info.url],{capture:false,onLine(line){
        if (line.startsWith('CLIPTUBE_PROGRESS ')) {
          try {const p=JSON.parse(line.slice(18));const total=p.total_bytes || p.total_bytes_estimate;
            onProgress({status:'downloading',progress:total?Math.min(99,Math.round((p.downloaded_bytes||0)/total*100)):null,stage:p.status==='finished'?'Downloaded stream; preparing output…':'Downloading source stream…',speed:p.speed||null,eta:p.eta ?? null});}catch{}
        } else if (line.startsWith('[Merger]')) onProgress({status:'merging',progress:null,stage:'Merging original video and audio without re-encoding…',speed:null,eta:null});
        else if (line.startsWith('CLIPTUBE_FILE ')) {try{produced.push(JSON.parse(line.slice(14)));}catch{}}
      }});
    return {cancel:op.cancel,promise:op.promise.then(()=>{
      if (produced.length!==1) throw new Error('Download completed but the output file was not reported.');
      const file=path.resolve(produced[0]), realDir=fs.realpathSync(workDir);
      if (!file.startsWith(realDir+path.sep) || !fs.statSync(file).isFile()) throw new Error('The engine returned an unsafe output path.');
      return file;
    })};
  }
  verify(file) {
    if(!this.tools.ffprobe)return {promise:Promise.resolve(null),cancel(){}};
    const op=runProcess(this.tools.ffprobe,['-v','error','-show_streams','-show_format','-of','json',file],{timeout:30000,limit:1024*1024});
    return {cancel:op.cancel,promise:op.promise.then(text=>{
      const info=JSON.parse(text),video=info.streams?.find(s=>s.codec_type==='video'),audio=info.streams?.find(s=>s.codec_type==='audio');
      if(!video)throw new Error('The downloaded file does not contain a video stream.');
      return {width:video.width,height:video.height,duration:Number(info.format?.duration)||null,videoCodec:video.codec_name,audioCodec:audio?.codec_name || null};
    })};
  }
}
class Queue {
  constructor({stateDir,outputDir,engine,onChange=()=>{}}) {
    this.stateDir=stateDir;this.stateFile=path.join(stateDir,'queue.json');this.engine=engine;this.onChange=onChange;this.running=null;this.closed=false;this.jobs=[];this.outputDir=path.resolve(outputDir);
    fs.mkdirSync(stateDir,{recursive:true});fs.mkdirSync(this.outputDir,{recursive:true});
    if (fs.existsSync(this.stateFile)) {
      let data;
      try {data=JSON.parse(fs.readFileSync(this.stateFile,'utf8'));} catch {fs.copyFileSync(this.stateFile,this.stateFile+'.corrupt-'+Date.now());data={};}
      if(!data || typeof data!=='object' || Array.isArray(data))data={};
      if (Array.isArray(data.jobs)) this.jobs=data.jobs.filter(j=>j && /^[a-f0-9-]{36}$/.test(j.id) && typeof j.url==='string' && typeof j.outputDir==='string' && path.isAbsolute(j.outputDir) && typeof j.choiceId==='string' && /^(best|[a-zA-Z0-9_.-]+)$/.test(j.choiceId) && ['queued','inspecting','downloading','merging','completed','failed','canceled','interrupted'].includes(j.status)).slice(-1000);
      if (typeof data.outputDir==='string' && path.isAbsolute(data.outputDir) && fs.existsSync(data.outputDir) && fs.statSync(data.outputDir).isDirectory()) this.outputDir=fs.realpathSync(data.outputDir);
      for (const j of this.jobs) if (['queued','inspecting','downloading','merging'].includes(j.status)) Object.assign(j,{status:'interrupted',progress:null,stage:'The previous session ended. Retry to start a fresh download.',error:null});
    }
    this.persist();
  }
  snapshot(){return {jobs:this.jobs.map(j=>({...j})),outputDir:this.outputDir,persistenceError:this.persistenceError || null};}
  persist(){const tmp=this.stateFile+'.tmp';fs.writeFileSync(tmp,JSON.stringify({version:1,...this.snapshot()},null,2));fs.renameSync(tmp,this.stateFile);}
  emit(){try{this.persist();this.persistenceError=null;}catch(e){this.persistenceError='Queue state could not be saved: '+friendlyError(e.message);}this.onChange(this.snapshot());}
  setFolder(folder){
    if (typeof folder!=='string' || !path.isAbsolute(folder)) throw new Error('Choose an absolute output folder.');
    const real=fs.realpathSync(folder);if(!fs.statSync(real).isDirectory()) throw new Error('Choose a folder, not a file.');
    fs.accessSync(real,fs.constants.W_OK);this.outputDir=real;this.emit();return real;
  }
  add(info,choiceId='best') {
    if(this.closed) throw new Error('The app is closing.');
    const choice=selectFormat(info,choiceId);
    if (this.jobs.filter(j=>['queued','inspecting','downloading','merging'].includes(j.status)).length>=50) throw new Error('The queue is full (50 pending items).');
    const job={id:crypto.randomUUID(),url:info.url,title:info.title,choiceId,qualityLabel:choice.label,outputDir:this.outputDir,status:'queued',progress:null,stage:'Waiting in queue…',error:null,file:null,attempt:0,updatedAt:new Date().toISOString(),speed:null,eta:null};
    this.jobs.push(job);this.emit();queueMicrotask(()=>this.pump());return {...job};
  }
  get(id){const j=this.jobs.find(j=>j.id===id);if(!j)throw new Error('Download not found.');return j;}
  cancel(id){
    const j=this.get(id);if(!['queued','inspecting','downloading','merging'].includes(j.status)) return {...j};
    j.status='canceled';j.progress=null;j.stage='Canceled. Retry starts a fresh download.';j.error=null;j.speed=null;j.eta=null;
    if(this.running?.id===id)this.running.operation?.cancel();this.emit();return {...j};
  }
  retry(id){
    const j=this.get(id);if(!['failed','canceled','interrupted'].includes(j.status))throw new Error('Only failed, canceled, or interrupted downloads can be retried.');
    if(this.running?.id===id) throw new Error('Cancellation is still finishing. Retry in a moment.');
    Object.assign(j,{status:'queued',progress:null,stage:'Waiting in queue…',error:null,file:null,speed:null,eta:null,updatedAt:new Date().toISOString()});this.emit();queueMicrotask(()=>this.pump());return {...j};
  }
  clearFinished(){this.jobs=this.jobs.filter(j=>['queued','inspecting','downloading','merging'].includes(j.status)||this.running?.id===j.id);this.emit();}
  async pump(){
    if(this.closed || this.running)return;
    const j=this.jobs.find(j=>j.status==='queued');if(!j)return;
    let workDir;
    this.running={id:j.id,operation:null};j.attempt++;Object.assign(j,{status:'inspecting',progress:null,stage:'Checking current source formats…',updatedAt:new Date().toISOString()});
    try {
      if(!path.isAbsolute(j.outputDir)||!fs.statSync(j.outputDir).isDirectory())throw new Error('The selected output folder is no longer available.');
      const partialRoot=path.join(j.outputDir,'.cliptube-partials');
      if(fs.existsSync(partialRoot) && fs.lstatSync(partialRoot).isSymbolicLink())throw new Error('The partial-download directory cannot be a symbolic link.');
      workDir=inside(partialRoot,j.id);
      if(fs.existsSync(workDir))fs.rmSync(workDir,{recursive:true,force:true});
      this.emit();
      let op=this.engine.inspect(j.url);this.running.operation=op;const info=await op.promise;
      if(this.closed || j.status==='canceled')return;
      const choice=selectFormat(info,j.choiceId);j.qualityLabel=choice.label;j.title=info.title;
      Object.assign(j,{status:'downloading',stage:'Downloading source media…'});this.emit();
      let lastEmit=0;
      op=this.engine.download(info,j.choiceId,workDir,progress=>{
        if(this.closed || j.status==='canceled')return;Object.assign(j,progress,{updatedAt:new Date().toISOString()});
        if(Date.now()-lastEmit>300 || progress.status==='merging'){lastEmit=Date.now();this.emit();}
      });this.running.operation=op;
      const produced=await op.promise;
      if(this.closed || j.status==='canceled')return;
      let verification=null;
      if(this.engine.verify){op=this.engine.verify(produced);this.running.operation=op;verification=await op.promise;}
      if(this.closed || j.status==='canceled')return;
      if(verification && choice.audioCodec && choice.audioCodec!=='audio unknown' && !verification.audioCodec)throw new Error('The output is missing the expected audio stream.');
      const ext=path.extname(produced).toLowerCase();if(!/^\.[a-z0-9]{1,8}$/.test(ext))throw new Error('The engine produced an invalid extension.');
      const target=inside(j.outputDir,`${safeFilename(j.title)} [${j.id.slice(0,8)}]${ext}`);
      fs.copyFileSync(produced,target,fs.constants.COPYFILE_EXCL);
      Object.assign(j,{file:target,status:'completed',progress:100,stage:verification?`Saved ${verification.width}×${verification.height}${verification.audioCodec?' with '+verification.audioCodec+' audio':', silent source'}.`:'Saved source media.',verification,error:null,speed:null,eta:null,updatedAt:new Date().toISOString()});this.emit();
    } catch(e) {
      if(j.status!=='canceled'){Object.assign(j,{status:this.closed?'interrupted':'failed',progress:null,stage:this.closed?'Session ended; retry to restart.':'Download stopped.',error:this.closed?null:friendlyError(e.message),speed:null,eta:null});this.emit();}
    } finally {
      // A UUID-owned per-job directory only; never delete outside this exact work directory.
      if(workDir && fs.existsSync(workDir) && path.basename(workDir)===j.id) {try{fs.rmSync(workDir,{recursive:true,force:true});}catch{}}
      this.running=null;if(!this.closed)queueMicrotask(()=>this.pump());
    }
  }
  close(){this.closed=true;if(this.running){const j=this.get(this.running.id);if(j.status!=='canceled')Object.assign(j,{status:'interrupted',progress:null,stage:'Session ended; retry to restart.',error:null});this.running.operation?.cancel();}for(const j of this.jobs)if(j.status==='queued')Object.assign(j,{status:'interrupted',stage:'Session ended; retry to restart.'});this.emit();}
}
module.exports={runProcess,Engine,Queue};
