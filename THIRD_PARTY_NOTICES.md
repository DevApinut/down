# Third-party notices

This project bundles:

- ffmpeg.wasm JavaScript wrapper 0.12.15 — MIT License
  https://github.com/ffmpegwasm/ffmpeg.wasm
- @ffmpeg/core 0.12.10 / FFmpeg WebAssembly core
  https://github.com/ffmpegwasm/ffmpeg.wasm
- FFmpeg — primarily LGPL 2.1 or later, depending on build configuration
  https://ffmpeg.org/

The corresponding license and notice files are included in vendor/.

## ESUIT Relay proxy compatibility layer

`vendor/esuit-relay-proxy.js` is extracted from the locally installed
ESUIT Video Downloader for Facebook extension solely as a compatibility layer
for Facebook's private React/Relay module loader. Its upstream license was not
included in the installed extension package; redistribution rights should be
confirmed before publishing this project.

## Mediabunny

Mediabunny 1.49.0 is bundled for browser-native streaming MP4 muxing.
Copyright (c) 2026-present Vanilagy. Licensed under MPL-2.0.
See vendor/mediabunny/LICENSE-MPL-2.0.txt.
