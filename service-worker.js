const OFFSCREEN_URL = 'offscreen.html';

const networkSourcesByTab = new Map();
const networkNotifyTimers = new Map();
const MAX_NETWORK_SOURCES = 120;
const MAX_BROWSER_MERGE_BYTES = 4 * 1024 * 1024 * 1024;
const BRIDGE_SCRIPT_IDS = ['fbmd-main-world-bridge'];
const OBSOLETE_BRIDGE_SCRIPT_IDS = ['fbmd-main-world-proxy', 'fbmd-main-world-react'];
const FACEBOOK_MATCHES = ['https://www.facebook.com/*', 'https://web.facebook.com/*'];

async function registerMainWorldBridge() {
  const registered = await chrome.scripting.getRegisteredContentScripts({
    ids: [...BRIDGE_SCRIPT_IDS, ...OBSOLETE_BRIDGE_SCRIPT_IDS]
  });
  if (registered.length) await chrome.scripting.unregisterContentScripts({ids: registered.map((item) => item.id)});
  await chrome.scripting.registerContentScripts([{
    id: BRIDGE_SCRIPT_IDS[0],
    matches: FACEBOOK_MATCHES,
    js: ['page-bridge.js'],
    runAt: 'document_start',
    world: 'MAIN',
    persistAcrossSessions: true
  }]);
}

let bridgeRegistration = Promise.resolve();
function scheduleBridgeRegistration() {
  bridgeRegistration = bridgeRegistration.catch(() => {}).then(registerMainWorldBridge);
  bridgeRegistration.catch(console.error);
}

chrome.runtime.onInstalled.addListener(scheduleBridgeRegistration);
chrome.runtime.onStartup.addListener(scheduleBridgeRegistration);
scheduleBridgeRegistration();

chrome.webRequest.onBeforeRequest.addListener((details) => {
  if (details.tabId < 0) return;
  const source = networkSource(details.url);
  if (!source) return;
  const sources = networkSourcesByTab.get(details.tabId) || [];
  const index = sources.findIndex((item) => item.url === source.url);
  if (index >= 0) return;
  sources.push({...source, seenAt: Date.now()});
  if (sources.length > MAX_NETWORK_SOURCES) sources.splice(0, sources.length - MAX_NETWORK_SOURCES);
  networkSourcesByTab.set(details.tabId, sources);
  scheduleNetworkNotification(details.tabId);
}, {
  urls: ['https://*.fbcdn.net/*'],
  types: ['media', 'xmlhttprequest', 'other']
});

chrome.tabs.onRemoved.addListener((tabId) => {
  networkSourcesByTab.delete(tabId);
  const timer = networkNotifyTimers.get(tabId);
  if (timer) clearTimeout(timer);
  networkNotifyTimers.delete(tabId);
});

function scheduleNetworkNotification(tabId) {
  if (networkNotifyTimers.has(tabId)) return;
  const timer = setTimeout(() => {
    networkNotifyTimers.delete(tabId);
    chrome.tabs.sendMessage(tabId, {type: 'FBMD_NETWORK_UPDATED'}).catch(() => {});
  }, 150);
  networkNotifyTimers.set(tabId, timer);
}

function networkSource(rawUrl) {
  const meta = decodeNetworkEfg(rawUrl);
  const urlTag = new URL(rawUrl).searchParams.get('tag') || '';
  const tag = String(meta.vencode_tag || meta.encoding_tag || urlTag);
  if (!/\.mp4(?:\?|$)/i.test(rawUrl) && !tag && !meta.video_id && !meta.xpv_asset_id) return null;
  const videoId = meta.video_id ? String(meta.video_id) :
    meta.xpv_asset_id ? 'asset:' + meta.xpv_asset_id : 'network';
  const heightMatch = tag.match(/(?:_|\b)(\d{3,4})p(?:_|\b)/i);
  const kind = /audio/i.test(tag) ? 'audio' :
    /progressive/i.test(tag) ? 'progressive' :
    /dash|video/i.test(tag) ? 'video' : 'progressive';
  return {
    url: withoutByteRange(rawUrl),
    rangedUrl: rawUrl,
    videoId,
    kind,
    label: heightMatch ? heightMatch[1] + 'p' : kind === 'audio' ? 'Audio' : 'Video',
    height: heightMatch ? Number(heightMatch[1]) : 0,
    bitrate: Number(meta.bitrate) || 0,
    duration: Number(meta.duration_s || meta.duration) || 0,
    codec: tag
  };
}

function decodeNetworkEfg(rawUrl) {
  try {
    const encoded = new URL(rawUrl).searchParams.get('efg');
    if (!encoded) return {};
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch { return {}; }
}

function withoutByteRange(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.searchParams.delete('bytestart');
    url.searchParams.delete('byteend');
    return url.href;
  } catch { return rawUrl; }
}


const trackedDownloads = new Map();

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state?.current || !['complete', 'interrupted'].includes(delta.state.current)) return;
  const group = trackedDownloads.get(delta.id);
  if (!group) return;
  trackedDownloads.delete(delta.id);
  group.remaining--;
  if (delta.state.current === 'interrupted') group.interrupted = true;
  if (group.remaining > 0) return;
  if (group.interrupted) {
    sendProgress(group.tabId, group.job, 'error', 0, 'Chrome ยกเลิกการดาวน์โหลดบางไฟล์');
  } else {
    sendProgress(group.tabId, group.job, 'complete', 100,
      group.separate ? 'ดาวน์โหลดภาพและเสียงแยกครบแล้ว' : 'ดาวน์โหลดเสร็จแล้ว');
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'FBMD_GET_NETWORK_SOURCES') {
    const sources = networkSourcesByTab.get(sender.tab?.id) || [];
    const since = Number(message.since) || 0;
    sendResponse({ok: true, sources: sources.filter((source) => source.seenAt > since)});
    return;
  }

  if (message?.type === 'FBMD_QUEUE_JOBS') {
    const tabId = sender.tab?.id;
    queueJobs(message.jobs || [], tabId, message.concurrency)
      .then((result) => sendResponse({ok: true, ...result}))
      .catch((error) => sendResponse({ok: false, error: String(error)}));
    return true;
  }

  if (message?.type === 'FBMD_GET_DOWNLOAD_PROGRESS') {
    getDownloadProgress(message.entries || [])
      .then((items) => sendResponse({ok: true, items}))
      .catch((error) => sendResponse({ok: false, error: String(error)}));
    return true;
  }

  if (message?.type === 'FBMD_DIRECT_DOWNLOAD') {
    startDownload(message.url, message.filename, message.ensureExtension)
      .then((downloadId) => sendResponse({ok: true, downloadId}))
      .catch((error) => sendResponse({ok: false, error: String(error)}));
    return true;
  }

  if (message?.type === 'FBMD_PROGRESS' && message.sourceTabId) {
    chrome.tabs.sendMessage(message.sourceTabId, message).catch(() => {});
  }
});

async function queueJobs(jobs, tabId, requestedConcurrency) {
  const limit = Math.max(1, Math.min(2, Number(requestedConcurrency) || 1));
  let cursor = 0;
  let started = 0;
  let failed = 0;

  const workers = Array.from({length: Math.min(limit, jobs.length)}, async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      try {
        await launchJob(job, tabId);
        started++;
      } catch (error) {
        failed++;
        sendProgress(tabId, job, 'error', 0, String(error));
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
  await Promise.all(workers);
  return {started, failed};
}

async function launchJob(job, tabId) {
  if (job.resource?.withSound) {
    if (!job.resource.url) throw new Error('ไม่พบ URL วิดีโอพร้อมเสียง');
    sendProgress(tabId, job, 'starting', 5, 'กำลังส่งวิดีโอพร้อมเสียงไปยัง Chrome');
    const downloadId = await startDownload(cleanRange(job.resource.url), job.filename, '.mp4');
    const group = {job, tabId, remaining: 1, interrupted: false, separate: false};
    trackedDownloads.set(downloadId, group);
    sendProgress(tabId, job, 'started', 10, 'Chrome เริ่มดาวน์โหลดแล้ว', {
      downloadIds: [downloadId]
    });
    return;
  }

  const videoUrl = job.resource?.video?.url;
  const audioUrl = job.resource?.audio?.url;
  if (!videoUrl || !audioUrl) throw new Error('ไม่พบคู่ภาพและเสียงสำหรับคุณภาพนี้');

  if (job.resource?.mergeSmall) {
    sendProgress(tabId, job, 'starting', 5,
      'โหมดรวมเป็นไฟล์เดียว · กำลังตรวจขนาดและเตรียมรวมภาพกับเสียง');
    try {
      await mergeSmallInOffscreen(job, tabId, videoUrl, audioUrl);
      return;
    } catch (error) {
      sendProgress(tabId, job, 'fallback', 2,
        'รวมไฟล์เดียวไม่สำเร็จ: ' + cleanError(error) + ' · โหลดแยกแทน');
    }
  } else {
    sendProgress(tabId, job, 'fallback', 2,
      'คุณภาพนี้เป็นภาพและเสียงแยก · กำลังส่งทั้งสองไฟล์ไปยัง Chrome');
  }
  const videoFilename = addFilenameSuffix(job.filename, ' [video]', '.mp4');
  const audioFilename = addFilenameSuffix(job.filename, ' [audio]', '.m4a');
  const [videoId, audioId] = await Promise.all([
    startDownload(cleanRange(videoUrl), videoFilename),
    startDownload(cleanRange(audioUrl), audioFilename)
  ]);
  const group = {job, tabId, remaining: 2, interrupted: false, separate: true};
  trackedDownloads.set(videoId, group);
  trackedDownloads.set(audioId, group);
  sendProgress(tabId, job, 'started', 10, 'Chrome เริ่มดาวน์โหลดภาพและเสียงแล้ว', {
    downloadIds: [videoId, audioId]
  });
}

async function mergeSmallInOffscreen(job, tabId, videoUrl, audioUrl) {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    target: 'FBMD_OFFSCREEN',
    type: 'FBMD_MERGE_SMALL',
    job: {id: job.id, videoId: job.videoId, filename: job.filename},
    tabId,
    videoUrl: cleanRange(videoUrl),
    audioUrl: cleanRange(audioUrl),
    maxBytes: MAX_BROWSER_MERGE_BYTES
  });
  if (!response?.ok) throw new Error(response?.error || 'offscreen merge failed');
  const group = {job, tabId, remaining: 1, interrupted: false, separate: false, mergedSmall: true};
  trackedDownloads.set(response.downloadId, group);
  sendProgress(tabId, job, 'started', 10, 'รวมไฟล์เสร็จแล้ว · Chrome เริ่มดาวน์โหลดไฟล์เดียว', {
    downloadIds: [response.downloadId]
  });
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen?.createDocument) throw new Error('Chrome นี้ยังไม่รองรับ offscreen document');
  if (chrome.offscreen.hasDocument && await chrome.offscreen.hasDocument()) return;
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['BLOBS'],
      justification: 'Merge Facebook DASH video and audio files before download'
    });
  } catch (error) {
    if (!/Only a single offscreen|already exists/i.test(String(error))) throw error;
  }
}

function cleanError(error) {
  return String(error?.message || error || 'unknown').replace(/^Error:\s*/, '');
}
function startDownload(url, filename, ensureExtension = '') {
  return chrome.downloads.download({
    url,
    filename: ensureFilenameExtension(filename, ensureExtension),
    conflictAction: 'uniquify',
    saveAs: false
  });
}

function ensureFilenameExtension(filename, extension) {
  const fallback = extension ? 'facebook-video' + extension : 'facebook-download';
  const value = String(filename || fallback).trim().replace(/[. ]+$/, '');
  if (!extension) return value || fallback;
  const normalized = extension.startsWith('.') ? extension : '.' + extension;
  return value.toLowerCase().endsWith(normalized.toLowerCase()) ? value : value + normalized;
}

async function getDownloadProgress(entries) {
  const output = [];
  for (const entry of entries.slice(0, 100)) {
    const ids = (entry.downloadIds || []).filter(Number.isInteger);
    const found = [];
    for (const id of ids) {
      const [item] = await chrome.downloads.search({id});
      if (item) found.push(item);
    }
    if (!found.length) continue;

    const interrupted = found.some((item) => item.state === 'interrupted');
    const complete = found.length === ids.length && found.every((item) => item.state === 'complete');
    const received = found.reduce((sum, item) => sum + Math.max(0, Number(item.bytesReceived) || 0), 0);
    const totals = found.map((item) => Number(item.totalBytes) || 0);
    const hasTotals = totals.length === ids.length && totals.every((total) => total > 0);
    const total = hasTotals ? totals.reduce((sum, value) => sum + value, 0) : 0;
    const progress = total > 0 ? Math.max(10, Math.min(99, Math.floor(received / total * 100))) : 10;

    output.push({
      jobId: entry.jobId,
      state: interrupted ? 'error' : complete ? 'complete' : 'started',
      progress: complete ? 100 : interrupted ? 0 : progress,
      detail: interrupted ? 'Chrome ยกเลิกการดาวน์โหลด' :
        complete ? 'ดาวน์โหลดเสร็จแล้ว' :
        total > 0 ? formatBytes(received) + ' / ' + formatBytes(total) : 'Chrome กำลังดาวน์โหลด'
    });
  }
  return output;
}

function sendProgress(tabId, job, state, progress, detail, extra = {}) {
  if (!Number.isInteger(tabId)) return;
  chrome.tabs.sendMessage(tabId, {
    type: 'FBMD_PROGRESS',
    sourceTabId: tabId,
    jobId: job.id,
    videoId: job.videoId,
    filename: job.filename,
    state,
    progress,
    detail,
    ...extra
  }).catch(() => {});
}

function formatBytes(bytes) {
  const mib = bytes / (1024 * 1024);
  if (mib < 1024) return mib.toFixed(1) + ' MB';
  return (mib / 1024).toFixed(2) + ' GB';
}

function addFilenameSuffix(filename, suffix, extension) {
  const base = String(filename || 'facebook-video.mp4').replace(/.[^.]+$/, '');
  return base + suffix + extension;
}

function cleanRange(rawUrl) {
  const url = new URL(rawUrl);
  url.searchParams.delete('bytestart');
  url.searchParams.delete('byteend');
  return url.href;
}
