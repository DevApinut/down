import {FFmpeg} from './vendor/ffmpeg/index.js';

const MAX_DEFAULT_BYTES = 4 * 1024 * 1024 * 1024;
let ffmpeg;
let ffmpegLoading;
const objectUrls = new Set();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'FBMD_OFFSCREEN' || message?.type !== 'FBMD_MERGE_SMALL') return;
  mergeSmall(message)
    .then((result) => sendResponse({ok: true, ...result}))
    .catch((error) => sendResponse({ok: false, error: cleanError(error)}));
  return true;
});

async function mergeSmall(message) {
  const {job, tabId, videoUrl, audioUrl} = message;
  const maxBytes = Number(message.maxBytes) || MAX_DEFAULT_BYTES;
  if (!videoUrl || !audioUrl) throw new Error('missing video/audio url');

  report(tabId, job, 'starting', 8, 'ตรวจขนาดไฟล์ก่อนรวมเป็นไฟล์เดียว');
  const estimated = await estimateTotalBytes([videoUrl, audioUrl]);
  if (estimated > maxBytes) {
    throw new Error('ไฟล์รวมประมาณ ' + formatBytes(estimated) + ' ใหญ่เกินที่ Chrome รวมในหน้าได้ ' + formatBytes(maxBytes));
  }

  report(tabId, job, 'starting', 15, 'กำลังโหลดภาพสำหรับรวมเป็นไฟล์เดียว');
  const video = await fetchBytes(videoUrl, maxBytes, (loaded) => {
    report(tabId, job, 'starting', 15 + Math.min(25, Math.round(loaded / Math.max(estimated || maxBytes, 1) * 25)),
      'โหลดภาพแล้ว ' + formatBytes(loaded));
  });

  report(tabId, job, 'starting', 42, 'กำลังโหลดเสียงสำหรับรวมเป็นไฟล์เดียว');
  const audio = await fetchBytes(audioUrl, maxBytes - video.byteLength, (loaded) => {
    report(tabId, job, 'starting', 42 + Math.min(18, Math.round(loaded / Math.max(estimated || maxBytes, 1) * 18)),
      'โหลดเสียงแล้ว ' + formatBytes(loaded));
  });

  const total = video.byteLength + audio.byteLength;
  if (total > maxBytes) {
    throw new Error('ไฟล์รวม ' + formatBytes(total) + ' ใหญ่เกินที่ Chrome รวมในหน้าได้ ' + formatBytes(maxBytes));
  }

  report(tabId, job, 'starting', 62, 'กำลังเปิด FFmpeg สำหรับรวมภาพกับเสียง');
  const muxer = await getFfmpeg();
  const prefix = String(job?.id || Date.now()).replace(/[^a-z0-9_-]/gi, '');
  const inputVideo = prefix + '-video.mp4';
  const inputAudio = prefix + '-audio.m4a';
  const output = prefix + '-merged.mp4';

  await muxer.writeFile(inputVideo, video);
  await muxer.writeFile(inputAudio, audio);

  report(tabId, job, 'starting', 72, 'กำลังรวมเป็นไฟล์เดียว');
  const resultCode = await muxer.exec([
    '-i', inputVideo,
    '-i', inputAudio,
    '-c', 'copy',
    '-movflags', '+faststart',
    output
  ], 120000);
  if (resultCode !== 0) throw new Error('FFmpeg รวมไฟล์ไม่สำเร็จ code ' + resultCode);

  const merged = await muxer.readFile(output);
  await cleanupFfmpegFiles(muxer, [inputVideo, inputAudio, output]);

  report(tabId, job, 'starting', 92, 'รวมเสร็จแล้ว กำลังส่งไฟล์เดียวไปยัง Chrome');
  const blob = new Blob([merged], {type: 'video/mp4'});
  const objectUrl = URL.createObjectURL(blob);
  objectUrls.add(objectUrl);
  setTimeout(() => revokeObjectUrl(objectUrl), 120000);

  const response = await chrome.runtime.sendMessage({
    type: 'FBMD_DIRECT_DOWNLOAD',
    url: objectUrl,
    filename: job?.filename || 'facebook-video.mp4',
    ensureExtension: '.mp4'
  });
  if (!response?.ok || !Number.isInteger(response.downloadId)) {
    revokeObjectUrl(objectUrl);
    throw new Error(response?.error || 'เริ่มดาวน์โหลดไฟล์ที่รวมแล้วไม่ได้');
  }

  return {downloadId: response.downloadId};
}

async function getFfmpeg() {
  if (ffmpeg?.loaded) return ffmpeg;
  if (!ffmpegLoading) {
    ffmpeg = new FFmpeg();
    ffmpegLoading = ffmpeg.load({
      coreURL: chrome.runtime.getURL('vendor/core/ffmpeg-core.js'),
      wasmURL: chrome.runtime.getURL('vendor/core/ffmpeg-core.wasm')
    });
  }
  await ffmpegLoading;
  return ffmpeg;
}

async function estimateTotalBytes(urls) {
  let total = 0;
  for (const url of urls) {
    const size = await getContentLength(url);
    if (!size) return 0;
    total += size;
  }
  return total;
}

async function getContentLength(url) {
  try {
    const response = await fetch(url, {method: 'HEAD', credentials: 'include'});
    if (!response.ok) return 0;
    return Number(response.headers.get('content-length')) || 0;
  } catch {
    return 0;
  }
}

async function fetchBytes(url, maxBytes, onProgress) {
  const response = await fetch(url, {credentials: 'include'});
  if (!response.ok) throw new Error('โหลดไฟล์ไม่สำเร็จ HTTP ' + response.status);
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw new Error('ไฟล์ใหญ่เกินที่ Chrome รวมในหน้าได้');
    return buffer;
  }

  const chunks = [];
  let loaded = 0;
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    loaded += value.byteLength;
    if (loaded > maxBytes) {
      try { await reader.cancel(); } catch {}
      throw new Error('ไฟล์ใหญ่เกินที่ Chrome รวมในหน้าได้');
    }
    chunks.push(value);
    onProgress?.(loaded);
  }

  const output = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function cleanupFfmpegFiles(muxer, files) {
  for (const file of files) {
    try { await muxer.deleteFile(file); } catch {}
  }
}

function report(tabId, job, state, progress, detail) {
  if (!tabId || !job?.id) return;
  chrome.runtime.sendMessage({
    type: 'FBMD_PROGRESS',
    sourceTabId: tabId,
    jobId: job.id,
    videoId: job.videoId,
    filename: job.filename,
    state,
    progress,
    detail
  }).catch(() => {});
}

function revokeObjectUrl(url) {
  if (!objectUrls.delete(url)) return;
  try { URL.revokeObjectURL(url); } catch {}
}

function cleanError(error) {
  return String(error?.message || error || 'unknown').replace(/^Error:\s*/, '');
}

function formatBytes(bytes) {
  const mib = Number(bytes || 0) / (1024 * 1024);
  if (mib < 1024) return mib.toFixed(1) + ' MB';
  return (mib / 1024).toFixed(2) + ' GB';
}
