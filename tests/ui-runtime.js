'use strict';
// Resolve installed project dependencies; never fall back to another application.
const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');

module.exports = function uiRuntime(root) {
  const localRequire = createRequire(path.join(root, 'package.json'));
  let electron = process.env.CLIPTUBE_ELECTRON;
  if (!electron) {
    try {electron = localRequire('electron');}
    catch {throw new Error('Electron is unavailable. Run npm install in this application folder, or set CLIPTUBE_ELECTRON to your Electron executable.');}
  }
  if (typeof electron !== 'string') throw new Error('Run UI tests with Node.js rather than inside Electron.');
  electron = path.resolve(root, electron);
  if (!fs.existsSync(electron) || !fs.statSync(electron).isFile()) throw new Error('The configured Electron executable does not exist. Run npm install or check CLIPTUBE_ELECTRON.');
  let puppeteer;
  try {puppeteer = localRequire('puppeteer-core');}
  catch {throw new Error('puppeteer-core is unavailable. Run npm install in this application folder before running UI tests.');}
  return {electron, puppeteer, puppeteerPath: 'project dependency: puppeteer-core'};
};
