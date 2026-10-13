# ClipTube Plus

A local desktop app for saving permitted public videos at the quality actually exposed by their source. Inspect a URL, choose Best available or an exact format, and manage downloads in a persistent queue.

Features include source dimensions, FPS and codec labels; original-stream merging with FFmpeg; serial downloads; progress, cancellation and explicit retry; output-folder selection; safe filenames; and clear errors for unsupported or restricted media. No upscaling or forced MP4/H.264 preference is used for downloads.

## Requirements

- Node.js 22.12 or newer.
- Electron 43.4.0 and Puppeteer Core 25.7.0 (installed by `npm ci`; Puppeteer is needed only for UI tests).
- The official yt-dlp executable on PATH, or its absolute path in `CLIPTUBE_YTDLP`.
- FFmpeg and ffprobe on PATH, or their absolute paths in `CLIPTUBE_FFMPEG` and `CLIPTUBE_FFPROBE`.

Install these dependencies from their official distributions or your normal reputable package manager. [Official yt-dlp releases](https://github.com/yt-dlp/yt-dlp/releases) include bundled EJS components for sites that need JavaScript; this app enables Node 22+ as the runtime and disables remote-component fetching. No runtime binary, API key or paid service is bundled with this repository. Dependency versions are displayed in the app; nothing is updated automatically.

## Install and run

```sh
git clone https://github.com/aayush0124/cliptube-plus.git
cd cliptube-plus
npm ci
npm start
```

On Windows, after installing dependencies, double-click `Launch ClipTube Plus.cmd` or run `launch.ps1`. Other operating systems can use `npm start`; this release was verified on Windows. Set `CLIPTUBE_ELECTRON` only if a custom local Electron runtime is needed by the launcher/tests. `CLIPTUBE_NODE` may point to a custom Node.js executable.

Paste one public video URL, click Inspect, review the returned formats and select Best available or an exact source ID. Choose an output folder, then add the item to the queue. New items use the currently selected folder; existing items keep their destination. The app stores its own history in `.data` and defaults to a `downloads` folder beside the source, so run it from a writable checkout.

One download and one fragment worker run at a time. Cancel stops the owned download process and removes its job partial files. Retry starts a fresh download. After restarting, unfinished items become Interrupted and require an explicit Retry. Clearing finished history does not delete completed media files.

## Quality and output

The menu contains only returned accessible formats. Best available prioritizes the highest reported shorter dimension, then FPS, with extractor ordering breaking ties. It includes audio when an audiovisual option is available; higher silent choices remain explicitly selectable. Audio selection uses reported quality, bitrate and sample rate. Exact video-only formats are paired with selected source audio where available.

The app checks current formats again before downloading. If an exact format ID disappeared, the job fails instead of silently choosing a lower format. Best available may change if the source changed. Dimensions describe an exposed stream, not proof of the original upload master. Unknown dimensions are labeled; direct media links with incomplete metadata are probed with ffprobe.

Separate streams are merged into MKV without video or audio re-encoding; combined streams retain their source container. Completed files are probed for video and expected audio when ffprobe is available. Your player must support the downloaded codecs. Progress reflects the current stream and can restart when audio begins; merging is indeterminate because a reliable percentage is unavailable.

## Platform support and permitted use

yt-dlp lists extractors for YouTube, Vimeo, Dailymotion, TikTok, Instagram, Facebook, X, Internet Archive, PeerTube and many other sites. Extractor listings are not a guarantee of current URL support. Platforms change, impose rate limits or require authentication. Inspect the exact URL to see its current public formats; a failed request is reported honestly.

Save media you own, are licensed to download or otherwise have permission to save, and honor the platform's download rules. Public visibility does not itself grant download rights. See [YouTube's terms](https://www.youtube.com/static?template=terms) and [Vimeo's download rules](https://help.vimeo.com/hc/en-us/articles/12426502581265-How-to-download-a-video-on-Vimeo).

The app excludes DRM-marked, private/authenticated/paid media, live streams and playlists. It supplies no credentials, browser-cookie extraction, login harvesting, authentication grants, plugins, forwarded-IP evasion or custom extractor-client strategy. It ignores yt-dlp config files and disables remote-component fetching. Stock extraction may make ordinary metadata requests and retries. Access refusals remain failed; there is no app-level authentication workaround or alternative-client fallback.

Initial URL validation rejects credentials, non-web schemes and local/private network destinations. It is not a network sandbox around every later extractor/CDN redirect; use trusted public URLs. A local downloader is not an authorization check for a platform or rights holder.

Current backend documentation: [usage and format selection](https://github.com/yt-dlp/yt-dlp#format-selection), [supported extractors](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md), and [YouTube JS/EJS requirements](https://github.com/yt-dlp/yt-dlp/wiki/EJS).

## Tests

```sh
npm test
npm run test:integration
npm run test:ui
```

Unit tests use Node's built-in runner. Integration tests generate a small owned synthetic two-quality DASH fixture with CPU FFmpeg, serve it on a temporary loopback server, download/merge it, verify it with ffprobe and exercise real cancellation, failure, retry and persistence. No fixture binary is committed. The test server closes afterward.

UI tests exercise the real app bootstrap/security and deterministic mock-bridge interactions. They write local screenshots/reports under ignored `test-output`. Native folder-dialog selection is mocked in the automated interaction checks.

The following **opt-in** tests download the official Blender Big Buck Bunny trailer under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/):

```sh
npm run test:public
npm run test:ui-public
```

The licence is documented on [Blender's project page](https://peach.blender.org/about/). Attribution: © Blender Foundation | www.bigbuckbunny.org. These tests verify the permitted public source and preserve its credits; they do not claim every social platform currently works. Downloaded media and reports remain local and ignored.

Run `npm run audit:release` after staging a release to check staged files and history for prohibited local artifacts and suspicious credentials. Review remains necessary; pattern scans cannot prove the absence of every secret.

## Licence and attribution

Application source is MIT licensed. ClipTube Plus adapts the Electron architecture and warm visual direction of [ClipTube](https://github.com/aayush0124/cliptube), whose manifest declares MIT and credits Aayush Paliwal. Upstream dependencies retain their own licences. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
