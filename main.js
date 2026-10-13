'use strict';
const {app,BrowserWindow,ipcMain,dialog,shell}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {Engine,Queue}=require('./lib/engine');
const {discover,status}=require('./lib/tools');
const root=__dirname;
app.disableHardwareAcceleration();
app.setPath('userData',path.join(root,'.data','electron'));
if(process.env.CLIPTUBE_TEST_CDP) {
  app.commandLine.appendSwitch('remote-debugging-address','127.0.0.1');
  app.commandLine.appendSwitch('remote-debugging-port',process.env.CLIPTUBE_TEST_CDP);
}
const single=app.requestSingleInstanceLock();
let win,queue,engine,toolStatus,closing=false;
const inspectionCache=new Map(),inspections=new Set();
if(!single)app.quit();
else {
  app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.focus();}});
  app.whenReady().then(async()=>{
    const tools=discover(root);toolStatus=await status(tools);engine=new Engine(tools);
    queue=new Queue({stateDir:path.join(root,'.data'),outputDir:path.join(root,'downloads'),engine,onChange:data=>{if(win&&!win.isDestroyed())win.webContents.send('queue-state',data);}});
    const origin=path.join(root,'renderer','index.html');
    function trusted(event){if(!win || event.sender!==win.webContents || event.senderFrame!==win.webContents.mainFrame)throw new Error('Untrusted app request.');}
    function handle(channel,fn){ipcMain.handle(channel,(event,...args)=>{trusted(event);return fn(...args);});}
    function requireTools(){if(!toolStatus.ready)throw new Error(toolStatus.issues.join(' '));}
    handle('bootstrap',()=>({...queue.snapshot(),tools:toolStatus}));
    handle('inspect',async url=>{
      requireTools();if(inspections.size>=2)throw new Error('An inspection is already running. Please wait.');
      const op=engine.inspect(url);inspections.add(op);
      try {
        const info=await op.promise,token=crypto.randomUUID();
        const now=Date.now();for(const [key,value] of inspectionCache)if(now-value.time>30*60*1000)inspectionCache.delete(key);
        if(inspectionCache.size>30)inspectionCache.delete(inspectionCache.keys().next().value);
        inspectionCache.set(token,{info,time:now});return {token,...info};
      } catch(e){const {friendlyError}=require('./lib/media');throw new Error(friendlyError(e.message));}
      finally{inspections.delete(op);}
    });
    handle('enqueue',opts=>{
      requireTools();if(!opts || typeof opts.token!=='string' || typeof opts.choiceId!=='string')throw new Error('Inspect a URL and select a format first.');
      const entry=inspectionCache.get(opts.token);if(!entry || Date.now()-entry.time>30*60*1000)throw new Error('The inspection expired. Inspect the URL again.');
      return queue.add(entry.info,opts.choiceId);
    });
    handle('cancel',id=>queue.cancel(id));handle('retry',id=>{requireTools();return queue.retry(id);});
    handle('choose-folder',async()=>{
      const result=await dialog.showOpenDialog(win,{title:'Choose download folder',defaultPath:queue.outputDir,properties:['openDirectory','createDirectory']});
      return result.canceled?null:queue.setFolder(result.filePaths[0]);
    });
    handle('open-folder',async()=>{const error=await shell.openPath(queue.outputDir);if(error)throw new Error(error);});
    handle('show-file',id=>{const job=queue.get(id);if(job.status!=='completed'||!job.file||!fs.existsSync(job.file))throw new Error('The saved file could not be found.');shell.showItemInFolder(job.file);});
    handle('clear-finished',()=>queue.clearFinished());
    win=new BrowserWindow({width:1160,height:870,minWidth:760,minHeight:620,title:'ClipTube Plus',backgroundColor:'#262624',autoHideMenuBar:true,
      webPreferences:{preload:path.join(root,'preload.js'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    win.webContents.on('will-navigate',event=>event.preventDefault());
    win.webContents.session.setPermissionRequestHandler((_webContents,_permission,callback)=>callback(false));
    await win.loadFile(origin);
  }).catch(error=>{dialog.showErrorBox('ClipTube Plus could not start',error.message);app.quit();});
}
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',()=>{
  if(closing)return;closing=true;for(const operation of inspections)operation.cancel();queue?.close();
});
