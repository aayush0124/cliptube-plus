# Third-party notices

This repository distributes application source only. It does not bundle Electron, Chromium, Node.js, yt-dlp, FFmpeg, Puppeteer, downloaded media or browser profiles. Installing or redistributing those components remains subject to their own licences and notices.

## ClipTube

ClipTube Plus adapts ClipTube's Electron main/preload/renderer architecture and warm palette/Georgia heading direction. The original [ClipTube manifest](https://github.com/aayush0124/cliptube/blob/main/package.json) declares MIT and credits Aayush Paliwal. Preserve the application's MIT notice in [LICENSE](LICENSE). The existing public ClipTube and this separate app are distinct repositories; this release does not overwrite it.

## Electron 43.4.0

Electron source is MIT licensed: [tagged licence](https://github.com/electron/electron/blob/v43.4.0/LICENSE). Its binary distribution incorporates Chromium and other third-party components with separate notices, supplied in `LICENSES.chromium.html` and other upstream licence files. Preserve the entire upstream notices if redistributing an Electron runtime or packaged app. No runtime is committed here.

## Puppeteer Core 25.7.0

Puppeteer is Apache-2.0 licensed: [tagged licence](https://github.com/puppeteer/puppeteer/blob/puppeteer-core-v25.7.0/LICENSE). It is a development-only UI test dependency installed from npm. This repository does not copy its source or distribution.

## Node.js

Node.js uses MIT licensing with additional third-party notices: [upstream licence](https://github.com/nodejs/node/blob/main/LICENSE). Node is an external runtime, not bundled here.

## yt-dlp

yt-dlp source is dedicated to the public domain under the Unlicense: [upstream licence](https://github.com/yt-dlp/yt-dlp/blob/master/LICENSE). Official standalone executables include third-party components whose licensing can differ, including GPL-licensed dependencies; consult the [upstream licensing section](https://github.com/yt-dlp/yt-dlp#license). Users install the official executable separately. No executable, updater, cookie store or runtime component is redistributed here.

## FFmpeg and ffprobe

FFmpeg's default source licence is LGPL-2.1-or-later, with optional components/configurations switching a build to GPL or other terms. See [FFmpeg legal guidance](https://ffmpeg.org/legal.html). This app calls separately installed FFmpeg/ffprobe executables and neither links their code into the app nor redistributes a binary. Check your specific build's licence and configure flags before distributing it; do not assume every build is LGPL.

## Optional public test media

The opt-in public download tests point to an official Blender Big Buck Bunny trailer. [The project licence](https://peach.blender.org/about/) is [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) with the exceptions described there. Attribution: © Blender Foundation | www.bigbuckbunny.org. No film file, thumbnail or soundtrack is committed to this repository. The synthetic integration fixture is generated locally from FFmpeg test patterns and a sine tone and uses no external media.
