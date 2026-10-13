'use strict';
const {contextBridge,ipcRenderer}=require('electron');
const listen=(channel,callback)=>{const handler=(_event,payload)=>callback(payload);ipcRenderer.on(channel,handler);return()=>ipcRenderer.removeListener(channel,handler);};
contextBridge.exposeInMainWorld('cliptube',{
  bootstrap:()=>ipcRenderer.invoke('bootstrap'),inspect:url=>ipcRenderer.invoke('inspect',url),
  enqueue:options=>ipcRenderer.invoke('enqueue',options),cancel:id=>ipcRenderer.invoke('cancel',id),retry:id=>ipcRenderer.invoke('retry',id),
  chooseFolder:()=>ipcRenderer.invoke('choose-folder'),openFolder:()=>ipcRenderer.invoke('open-folder'),showFile:id=>ipcRenderer.invoke('show-file',id),
  clearFinished:()=>ipcRenderer.invoke('clear-finished'),onState:callback=>listen('queue-state',callback),onTools:callback=>listen('tools-state',callback)
});
