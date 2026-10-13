'use strict';
// Test-only Electron host. It loads the real renderer with a deterministic mock bridge.
const {app, BrowserWindow, ipcMain} = require('electron');
const path = require('node:path');
app.disableHardwareAcceleration();
app.setPath('userData', path.join(__dirname, '..', 'test-output', 'ui', 'mock-profile'));
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
app.commandLine.appendSwitch('remote-debugging-port', process.env.CLIPTUBE_UI_CDP);
let win;
app.whenReady().then(async () => {
  win = new BrowserWindow({width: 1160, height: 870, minWidth: 600, backgroundColor: '#262624', autoHideMenuBar: true,
    webPreferences: {preload: path.join(__dirname, 'ui-preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true}});
  win.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  ipcMain.on('ui-test:close', (event) => {if (event.sender === win.webContents) win.close();});
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}).catch((error) => {process.stderr.write(error.stack + '\n'); app.quit();});
app.on('window-all-closed', () => app.quit());
