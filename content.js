(() => {
  const catalog = new Map();
  const cards = new Map();
  const selected = new Set();
  const jobStatuses = new Map();
  const fetchedPermalinkSources = new Set();
  const pendingPermalinkFetches = new Map();
  const TOOLBAR_COLLAPSED_KEY = 'fbmdToolbarCollapsed';
  let toolbar;
  let overlayRoot;
  let scanTimer;
  let positionFrame;
  let hoverFrame;
  let scrollEndTimer;
  let pointerX = -1;
  let pointerY = -1;
  let lastNetworkSync = 0;
  let lastNetworkSourceSeenAt = 0;
  let progressSyncActive = false;
  let bridgeDiagnostics = {players: 0, relaySources: 0, catalog: 0, directStore: false};

  function receiveMetadata(detail) {
    bridgeDiagnostics = {...bridgeDiagnostics, ...(detail?.diagnostics || {})};
    for (const item of detail?.videos || []) {
      if (!item?.videoId) continue;
      catalog.set(String(item.videoId), {...item, receivedAt: Date.now()});
    }
    trimCatalog();
    refreshCards();
  }

  window.addEventListener('FBMD_METADATA', (event) => {
    receiveMetadata(event.detail);
  });
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type === 'FBMD_METADATA_MESSAGE') {
      try { receiveMetadata(JSON.parse(event.data.detail)); } catch {}
    }
    if (event.data?.type === 'FBMD_EXACT_DOWNLOAD_MESSAGE') {
      downloadExactPlayerVideo(event.data.detail).catch((error) => showStatus(String(error), true));
    }
    if (event.data?.type === 'FBMD_EXACT_SOURCE_REQUEST') {
      provideExactSources(event.data.detail).catch(() => {});
    }
  });

  async function provideExactSources(detail) {
    const videoId = String(detail?.videoId || '');
    if (!videoId) return;
    await syncNetworkCatalog();
    const item = catalog.get(videoId);
    if (!hasDownloadableSource(item)) return;
    window.postMessage({
      type: 'FBMD_EXACT_SOURCE_RESPONSE',
      detail: {videoId, item}
    }, '*');
  }

  async function downloadExactPlayerVideo(detail) {
    const videoId = String(detail?.videoId || 'video');
    const caption = cleanCaptionText(detail?.caption || '');
    const quality = sanitizeFilename(String(detail?.label || '').toUpperCase());
    const base = caption || ('facebook-video-' + videoId);
    const filename = truncateFilenamePreserveExtension(
      sanitizeFilename(base + (quality ? ' [' + quality + ']' : '') + '.mp4'),
      150
    );
    if (detail?.url) {
      const response = await chrome.runtime.sendMessage({
        type: 'FBMD_DIRECT_DOWNLOAD', url: detail.url, filename, ensureExtension: '.mp4'
      });
      if (!response?.ok) throw new Error(response?.error || 'เริ่มดาวน์โหลดไม่สำเร็จ');
      showStatus('เริ่มดาวน์โหลด ' + filename);
      return;
    }
    if (detail?.video?.url && detail?.audio?.url) {
      const response = await chrome.runtime.sendMessage({
        type: 'FBMD_QUEUE_JOBS',
        concurrency: 1,
        jobs: [{
          id: crypto.randomUUID(), videoId, filename,
          resource: {withSound: false, mergeSmall: true, video: detail.video, audio: detail.audio,
            label: detail.label || 'DASH'}
        }]
      });
      if (!response?.ok) throw new Error(response?.error || 'เริ่มดาวน์โหลดไม่สำเร็จ');
      showStatus('กำลังรวมภาพและเสียง ' + (detail.label || 'คุณภาพสูง'));
      return;
    }
    const item = catalog.get(videoId);
    const resources = buildResources(item, videoId);
    const resource = resources.find((entry) => entry.withSound) || resources[0];
    if (!resource) throw new Error('Relay record นี้ไม่มีลิงก์ดาวน์โหลด');
    const response = await chrome.runtime.sendMessage({
      type: 'FBMD_QUEUE_JOBS',
      concurrency: 1,
      jobs: [{id: crypto.randomUUID(), videoId, filename, resource}]
    });
    if (!response?.ok) throw new Error(response?.error || 'เริ่มดาวน์โหลดไม่สำเร็จ');
    showStatus('เริ่มดาวน์โหลดวิดีโอ ' + videoId);
  }
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'FBMD_PROGRESS') updateProgress(message);
    if (message?.type === 'FBMD_NETWORK_UPDATED') syncNetworkCatalog().catch(() => {});
  });

  function scan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      ensureToolbar();
      ensureOverlayRoot();
      cleanupCards();
      const exactButtons = [...document.querySelectorAll('.fbmd-react-download')];
      const hasVisibleExactButton = exactButtons.some((button) => {
        const rect = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
          rect.top < innerHeight && rect.left < innerWidth && style.display !== 'none' &&
          style.visibility !== 'hidden';
      });
      if (hasVisibleExactButton) {
        for (const state of cards.values()) state.card.classList.add('is-hidden');
      } else {
        document.querySelectorAll('video').forEach(attachCard);
      }
      schedulePositionCards();
      window.dispatchEvent(new Event('FBMD_REQUEST_SNAPSHOT'));
    }, 400);
  }

  function ensureOverlayRoot() {
    if (overlayRoot?.isConnected || !document.body) return;
    overlayRoot = document.createElement('div');
    overlayRoot.id = 'fbmd-overlay-root';
    document.body.appendChild(overlayRoot);
    for (const state of cards.values()) overlayRoot.appendChild(state.card);
  }

  function attachCard(video) {
    if (cards.has(video) || video.offsetWidth < 180 || video.offsetHeight < 100) return;
    ensureOverlayRoot();
    if (!overlayRoot) return;

    const card = document.createElement('div');
    card.className = 'fbmd-video-card';
    card.innerHTML =
      '<button type="button" class="fbmd-launcher" title="แสดงตัวเลือกดาวน์โหลด" aria-label="แสดงตัวเลือกดาวน์โหลด">⇩</button>' +
      '<div class="fbmd-card-controls">' +
      '<label class="fbmd-check-wrap" title="เลือกสำหรับดาวน์โหลดหลายรายการ">' +
      '<input type="checkbox" class="fbmd-check"><span>เลือก</span></label>' +
      '<select class="fbmd-quality" title="ความละเอียด"><option>กำลังตรวจ...</option></select>' +
      '<button type="button" class="fbmd-download" title="ดาวน์โหลดวิดีโอนี้">ดาวน์โหลด</button>' +
      '</div>';
    overlayRoot.appendChild(card);

    const state = {
      video,
      card,
      videoId: '',
      resources: [],
      selectedResourceKey: '',
      hovered: false,
      cardHovered: false
    };
    cards.set(video, state);
    for (const eventName of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup']) {
      card.addEventListener(eventName, (event) => event.stopPropagation());
    }
    card.querySelector('.fbmd-check').addEventListener('change', (event) => {
      setStateSelected(state, event.target.checked);
    });
    card.querySelector('.fbmd-quality').addEventListener('change', (event) => {
      state.selectedResourceKey = event.target.value;
      updateToolbar();
    });
    card.querySelector('.fbmd-download').addEventListener('click', async (event) => {
      event.preventDefault();
      await queueStates([state], 'card');
    });
    card.querySelector('.fbmd-launcher').addEventListener('click', (event) => {
      event.preventDefault();
      card.classList.toggle('is-open');
      schedulePositionCards();
    });
    for (const eventName of ['loadedmetadata', 'loadeddata', 'durationchange', 'timeupdate']) {
      video.addEventListener(eventName, () => scheduleCardRefresh(state), {passive: true});
    }
    for (const eventName of ['play', 'playing', 'pause', 'ended', 'emptied']) {
      video.addEventListener(eventName, () => {
        updateCardVisibility(state);
        scheduleCardRefresh(state);
      }, {passive: true});
    }
    card.addEventListener('pointerenter', () => {
      state.cardHovered = true;
      updateCardVisibility(state);
      schedulePositionCards();
    });
    card.addEventListener('pointerleave', () => {
      state.cardHovered = false;
      updateHoveredCards(pointerX, pointerY);
    });
    card.addEventListener('focusin', () => updateCardVisibility(state));
    card.addEventListener('focusout', () => {
      setTimeout(() => updateCardVisibility(state), 0);
    });
    updateCard(state);
    updateCardVisibility(state);
    schedulePositionCards();
  }

  function isVideoPlaying(video) {
    return !video.paused && !video.ended && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
  }

  function updateCardVisibility(state) {
    const active = isVideoPlaying(state.video) || state.hovered || state.cardHovered ||
      state.card.matches(':focus-within');
    state.card.classList.toggle('is-dormant', !active);
  }

  function updateHoveredCards(clientX, clientY) {
    for (const state of cards.values()) {
      if (!state.video.isConnected) continue;
      const rect = state.video.getBoundingClientRect();
      const hovered = clientX >= rect.left && clientX <= rect.right &&
        clientY >= rect.top && clientY <= rect.bottom;
      if (state.hovered !== hovered) state.hovered = hovered;
      updateCardVisibility(state);
    }
  }

  function scheduleHoverUpdate(clientX, clientY) {
    pointerX = clientX;
    pointerY = clientY;
    if (hoverFrame) return;
    hoverFrame = requestAnimationFrame(() => {
      hoverFrame = 0;
      updateHoveredCards(pointerX, pointerY);
    });
  }

  function hideCardsWhileScrolling() {
    clearTimeout(scrollEndTimer);
    for (const state of cards.values()) {
      state.hovered = false;
      state.cardHovered = false;
      state.card.classList.remove('is-open');
      state.card.classList.add('is-scroll-hidden');
    }
    scrollEndTimer = setTimeout(() => {
      for (const state of cards.values()) {
        state.card.classList.remove('is-scroll-hidden');
        updateCardVisibility(state);
      }
      updateHoveredCards(pointerX, pointerY);
      schedulePositionCards();
    }, 140);
  }

  function scheduleCardRefresh(state, delay = 120) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(() => {
      if (!state.video.isConnected) return;
      updateCard(state);
      schedulePositionCards();
      updateToolbar();
      window.dispatchEvent(new Event('FBMD_REQUEST_SNAPSHOT'));
    }, delay);
  }

  function setStateSelected(state, checked) {
    const id = state.videoId;
    for (const video of [...selected]) {
      const other = cards.get(video);
      if (video === state.video || (id && other?.videoId === id)) selected.delete(video);
    }
    if (checked) selected.add(state.video);
    for (const other of cards.values()) {
      if (other === state || (id && other.videoId === id)) {
        other.card.querySelector('.fbmd-check').checked = checked;
      }
    }
    updateToolbar();
  }

  function reconcileSelection(state) {
    if (!state.videoId) return;
    const previousVideo = [...selected].find((video) => {
      const previous = cards.get(video);
      return video !== state.video && previous?.videoId === state.videoId;
    });
    if (previousVideo && !previousVideo.isConnected) {
      selected.delete(previousVideo);
      selected.add(state.video);
    }
    state.card.querySelector('.fbmd-check').checked = selected.has(state.video) || Boolean(previousVideo);
  }

  function schedulePositionCards() {
    if (positionFrame) return;
    positionFrame = requestAnimationFrame(() => {
      positionFrame = 0;
      positionCards();
    });
  }

  function positionCards() {
    for (const state of cards.values()) {
      const {video, card} = state;
      if (!video.isConnected) {
        card.classList.add('is-hidden');
        continue;
      }
      const rect = video.getBoundingClientRect();
      const visible = rect.width >= 180 && rect.height >= 100 &&
        rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
      card.classList.toggle('is-hidden', !visible);
      if (!visible) continue;
      const x = Math.max(4, Math.min(rect.right - card.offsetWidth - 16, innerWidth - card.offsetWidth - 4));
      const y = Math.max(4, Math.min(rect.top + 8, innerHeight - card.offsetHeight - 4));
      card.style.transform = 'translate3d(' + Math.round(x) + 'px,' + Math.round(y) + 'px,0)';
    }
  }

  function cleanupCards() {
    const now = Date.now();
    for (const [video, state] of cards) {
      if (video.isConnected) {
        state.disconnectedAt = 0;
        continue;
      }
      state.disconnectedAt ||= now;
      state.card.classList.add('is-hidden');
      if (!selected.has(video) && now - state.disconnectedAt > 2000) {
        state.card.remove();
        cards.delete(video);
      }
    }
  }

  function refreshCards() {
    cleanupCards();
    for (const state of cards.values()) if (state.video.isConnected) updateCard(state);
    schedulePositionCards();
    updateToolbar();
  }

  function refreshPendingCards() {
    let changed = false;
    for (const state of cards.values()) {
      if (!state.video.isConnected || state.resources.length) continue;
      updateCard(state);
      changed = true;
    }
    if (changed) {
      schedulePositionCards();
      updateToolbar();
      window.dispatchEvent(new Event('FBMD_REQUEST_SNAPSHOT'));
    }
  }

  function updateCard(state) {
    const ids = findVideoIds(state.video);
    const catalogId = ids.find((candidate) => hasDownloadableSource(catalog.get(candidate))) ||
      ids.find((candidate) => catalog.has(candidate));
    const id = catalogId || ids[0] || '';
    state.videoId = id;
    state.matchVerified = Boolean(catalogId && ids.includes(catalogId));
    reconcileSelection(state);
    let item = catalogId ? catalog.get(catalogId) : state.videoId ? catalog.get(state.videoId) : null;
    if (!hasDownloadableSource(item)) {
      const fallback = findFallbackCatalog(state.video, ids);
      if (fallback) {
        item = fallback;
        if (fallback.videoId) state.videoId = String(fallback.videoId);
        state.matchVerified = true;
      }
    }
    if (!item) {
      item = mediaElementCatalog(state.video);
      if (item) state.matchVerified = true;
    }
    state.resources = buildResources(item, state.videoId);
    const select = state.card.querySelector('.fbmd-quality');
    const previous = select.value;
    select.textContent = '';
    if (!state.resources.length) {
      loadPermalinkSources(state, ids);
      let waitingText = waitingReasonText(state, item, ids);
      if (item?.audioTracks?.length && !item?.videoTracks?.length) waitingText = 'พบเสียงแล้ว · กำลังรอภาพ';
      else if (item?.videoTracks?.length && !item?.audioTracks?.length) waitingText = 'พบภาพแล้ว · กำลังรอเสียง';
      select.add(new Option(waitingText, ''));
      state.card.querySelector('.fbmd-download').disabled = true;
      return;
    }
    state.resources.forEach((resource) => select.add(new Option(resource.display, resource.key)));
    const selectedKey = state.resources.some((resource) => resource.key === state.selectedResourceKey)
      ? state.selectedResourceKey
      : state.resources[0].key;
    select.value = selectedKey;
    state.selectedResourceKey = selectedKey;
    state.card.querySelector('.fbmd-download').disabled = false;
  }

  function findVideoId(video) {
    return findVideoIds(video)[0] || '';
  }

  function findVideoIds(video) {
    const ids = new Set();
    const add = (value) => {
      for (const id of idsFromText(value)) ids.add(id);
    };
    add(video.dataset.videoId || video.getAttribute('data-video-id'));
    add(video.getAttribute('data-fbmd-player-video-id'));
    const nearestMarkerId = findNearestPlayerMarkerId(video);
    if (nearestMarkerId) add(nearestMarkerId);
    let node = video;
    for (let depth = 0; node && depth < 18; depth++, node = node.parentElement) {
      const playerMarker = [...node.children || []].find((child) =>
        child.hasAttribute?.('data-fbmd-player-video-id'));
      if (playerMarker) add(playerMarker.getAttribute('data-fbmd-player-video-id'));
      add(node.getAttribute?.('data-video-id'));
      add(node.getAttribute?.('data-videoid'));
      add(node.getAttribute?.('data-fbmd-player-video-id'));
      if (node.matches?.('a[href]') && /\/(?:videos|reel|watch)\/|[?&]v=/i.test(node.href)) add(node.href);
    }
    const current = video.currentSrc || video.src || '';
    const meta = decodeEfg(current);
    if (meta.video_id) ids.add(String(meta.video_id));
    if (meta.xpv_asset_id) ids.add('asset:' + meta.xpv_asset_id);
    return [...ids];
  }

  function findNearestPlayerMarkerId(video) {
    let node = video.parentElement;
    for (let depth = 0; node && depth < 18; depth++, node = node.parentElement) {
      const markers = node.querySelectorAll?.('[data-fbmd-player-video-id]') || [];
      if (markers.length === 1) return markers[0].getAttribute('data-fbmd-player-video-id') || '';
      if (markers.length > 1) return '';
    }
    return '';
  }

  function idFromText(text) {
    return idsFromText(text)[0] || '';
  }

  function idsFromText(text) {
    if (!text) return [];
    const ids = [];
    const add = (id) => {
      if (/^\d{8,}$/.test(String(id || '')) && !ids.includes(String(id))) ids.push(String(id));
    };
    const urlId = idFromUrl(text);
    if (urlId) add(urlId);
    for (const match of String(text).matchAll(/(?:video_id|videoID|videoId|top_level_post_id|mf_story_key)["'=:\s]+(\d{8,})/gi)) {
      add(match[1]);
    }
    for (const match of String(text).matchAll(/\b(?:videos|reel|watch)\/?(?:\?v=)?(\d{8,})\b/gi)) {
      add(match[1]);
    }
    return ids;
  }

  function idFromUrl(rawUrl) {
    try {
      const url = new URL(rawUrl, location.href);
      const queryId = url.searchParams.get('v') || url.searchParams.get('video_id') ||
        url.searchParams.get('story_fbid');
      if (/^\d{8,}$/.test(queryId || '')) return queryId;
      const match = url.pathname.match(/\/(?:videos|reel|watch)\/?(\d{8,})?/i);
      return match?.[1] || '';
    } catch {
      return '';
    }
  }

  function findVideoPermalinks(video) {
    const urls = [];
    const add = (href) => {
      try {
        const url = new URL(href, location.href);
        if (!/facebook\.com$/i.test(url.hostname) && !/\.facebook\.com$/i.test(url.hostname)) return;
        if (!/(\/videos\/|\/reel\/|\/watch\/?|\?v=)/i.test(url.pathname + url.search)) return;
        url.hash = '';
        for (const param of [...url.searchParams.keys()]) {
          if (!/^(v|video_id|story_fbid|id|idorvanity|__cft__|__tn__|ref|mibextid)$/i.test(param)) {
            url.searchParams.delete(param);
          }
        }
        const clean = url.href;
        if (!urls.includes(clean)) urls.push(clean);
      } catch {}
    };
    let node = video;
    for (let depth = 0; node && depth < 18; depth++, node = node.parentElement) {
      if (node.matches?.('a[href]')) add(node.href);
      for (const anchor of node.querySelectorAll?.('a[href]') || []) add(anchor.href);
      for (const attr of node.getAttributeNames?.() || []) {
        if (/href|ajaxify|data-ft|data-store/i.test(attr)) add(node.getAttribute(attr) || '');
      }
    }
    return urls;
  }

  function loadPermalinkSources(state, ids) {
    const links = findVideoPermalinks(state.video);
    const url = links.find((link) => !fetchedPermalinkSources.has(link) && !pendingPermalinkFetches.has(link));
    if (!url) return;
    state.sourceFetchState = 'loading';
    const request = fetch(url, {credentials: 'include', cache: 'force-cache'})
      .then((response) => response.ok ? response.text() : '')
      .then((text) => {
        fetchedPermalinkSources.add(url);
        const item = extractPermalinkSources(text, url, ids);
        if (item) {
          for (const id of item.ids) mergeCatalogItem(id, item.patch);
          refreshCards();
        }
      })
      .catch(() => {
        fetchedPermalinkSources.add(url);
      })
      .finally(() => {
        pendingPermalinkFetches.delete(url);
        if (state.sourceFetchState === 'loading') state.sourceFetchState = '';
      });
    pendingPermalinkFetches.set(url, request);
  }

  function extractPermalinkSources(text, pageUrl, fallbackIds = []) {
    if (!text) return null;
    const ids = new Set([...fallbackIds, ...idsFromText(pageUrl), ...idsFromText(text)]);
    const progressive = [];
    const directPattern = /["'](?:playable_url(?:_quality_hd)?|browser_native_(?:sd|hd)_url|progressive_url|hd_src|sd_src|hdSrc|sdSrc)["']\s*:\s*["']((?:\\.|[^"'])+)["']/gi;
    for (const match of text.matchAll(directPattern)) {
      const url = decodeJsonString(match[1]);
      if (!/^https?:/i.test(url)) continue;
      progressive.push({
        url,
        withSound: true,
        label: inferDirectLabel(match[0], url, text.slice(match.index || 0, (match.index || 0) + 1200)),
        source: 'permalink-fetch',
        duration: durationFromUrl(url)
      });
    }
    if (!progressive.length || !ids.size) return null;
    return {ids: [...ids], patch: {progressive, videoTracks: [], audioTracks: []}};
  }

  function mergeCatalogItem(id, patch) {
    if (!id) return;
    const key = String(id);
    const item = catalog.get(key) || {
      videoId: key, progressive: [], videoTracks: [], audioTracks: [], updatedAt: 0
    };
    for (const field of ['progressive', 'videoTracks', 'audioTracks']) {
      for (const entry of patch[field] || []) {
        if (!entry?.url) continue;
        const identity = cleanRange(entry.url);
        if (!item[field].some((old) => cleanRange(old.url) === identity)) item[field].push(entry);
      }
    }
    item.updatedAt = Date.now();
    item.receivedAt = Date.now();
    catalog.set(key, item);
    trimCatalog();
  }

  function decodeJsonString(value) {
    try { return JSON.parse('"' + String(value).replace(/"/g, '\\"') + '"'); }
    catch {
      return String(value).replace(/\\\//g, '/').replace(/\\u0025/g, '%').replace(/&amp;/g, '&');
    }
  }

  function durationFromUrl(url) {
    const meta = decodeEfg(url);
    return Number(meta.duration_s || meta.duration || 0) || 0;
  }

  function inferDirectLabel(sourceText, url, context = '') {
    const text = String(sourceText || '') + ' ' + String(context || '');
    if (/(?:quality_hd|native_hd|browser_native_hd|hd_src|hdSrc|sve_hd|quality["']\s*:\s*["']HD)/i.test(text)) return 'HD';
    if (/(?:native_sd|browser_native_sd|sd_src|sdSrc|sve_sd|quality["']\s*:\s*["']SD)/i.test(text)) return 'SD';
    try {
      const decoded = decodeURIComponent(url);
      const efg = JSON.stringify(decodeEfg(url));
      const combined = decoded + ' ' + efg;
      const height = Number(combined.match(/(?:_|\.|=)(\d{3,4})p?\b/i)?.[1]) || 0;
      if (height >= 720) return 'HD';
      if (height > 0) return 'SD';
      if (/sve_hd|progressive.*720|C3\.720/i.test(combined)) return 'HD';
      if (/sve_sd|progressive.*360|C3\.360/i.test(combined)) return 'SD';
    } catch {}
    return 'SD';
  }

  function decodeEfg(rawUrl) {
    try {
      const encoded = new URL(rawUrl).searchParams.get('efg');
      if (!encoded) return {};
      const normalized = decodeURIComponent(encoded).replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
      const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return {};
    }
  }

  async function syncNetworkCatalog() {
    if (Date.now() - lastNetworkSync < 500) return;
    lastNetworkSync = Date.now();
    const response = await chrome.runtime.sendMessage({
      type: 'FBMD_GET_NETWORK_SOURCES', since: lastNetworkSourceSeenAt
    });
    if (!response?.ok || !response.sources?.length) return;
    let changed = false;
    for (const source of response.sources) {
      lastNetworkSourceSeenAt = Math.max(lastNetworkSourceSeenAt, Number(source.seenAt) || 0);
      const id = String(source.videoId || 'network');
      const item = catalog.get(id) || {
        videoId: id, progressive: [], videoTracks: [], audioTracks: [], updatedAt: 0
      };
      const entry = {
        url: source.url,
        rangedUrl: source.rangedUrl,
        label: source.label,
        height: source.height,
        bitrate: source.bitrate,
        codec: source.codec,
        duration: source.duration
      };
      const field = source.kind === 'audio' ? 'audioTracks' :
        source.kind === 'video' ? 'videoTracks' : 'progressive';
      if (!item[field].some((old) => cleanRange(old.url) === cleanRange(entry.url))) {
        if (field === 'progressive') item[field].push({...entry, withSound: true});
        else item[field].push({...entry, type: source.kind});
        changed = true;
      }
      item.updatedAt = Math.max(item.updatedAt, source.seenAt || Date.now());
      catalog.set(id, item);
    }
    trimCatalog();
    if (changed) refreshCards();
  }

  function trimCatalog() {
    while (catalog.size > 160) catalog.delete(catalog.keys().next().value);
  }

  function mediaElementCatalog(video) {
    const urls = [video.currentSrc, video.src,
      ...[...video.querySelectorAll('source[src]')].map((source) => source.src)]
      .filter((url) => /^https?:/i.test(url || ''));
    if (!urls.length) return null;
    return {
      progressive: urls.map((url) => ({
        url,
        withSound: true,
        label: video.videoHeight ? video.videoHeight + 'p' : 'วิดีโอ'
      })),
      videoTracks: [],
      audioTracks: []
    };
  }

  function findFallbackCatalog(video, ids = []) {
    const currentUrl = cleanRange(video.currentSrc || video.src || '');
    const aliases = new Set(ids.map(String));
    const meta = decodeEfg(currentUrl);
    if (meta.video_id) aliases.add(String(meta.video_id));
    if (meta.xpv_asset_id) aliases.add('asset:' + String(meta.xpv_asset_id));

    let best = null;
    let bestScore = -Infinity;
    for (const item of catalog.values()) {
      if (!hasDownloadableSource(item)) continue;
      const itemId = String(item.videoId || '');
      const entries = ['progressive', 'videoTracks', 'audioTracks']
        .flatMap((field) => item[field] || []);
      const exactUrl = currentUrl && entries.some((entry) => cleanRange(entry.url || '') === currentUrl);
      const aliasMatch = aliases.has(itemId);
      const score = exactUrl ? 10000 : aliasMatch ? 8000 : 0;
      if (!exactUrl && !aliasMatch) continue;
      if (score > bestScore) {
        best = item;
        bestScore = score;
      }
    }
    return best;
  }

  function hasDownloadableSource(item) {
    return Boolean(item?.progressive?.length || (item?.videoTracks?.length && item?.audioTracks?.length));
  }

  function waitingReasonText(state, item, ids) {
    const duration = Number(state.video.duration) || 0;
    const diagnostic = 'P' + Number(bridgeDiagnostics.players || 0) +
      ' R' + Number(bridgeDiagnostics.relaySources || 0) +
      ' C' + Number(bridgeDiagnostics.catalog || catalog.size) +
      ' I' + ids.length +
      (bridgeDiagnostics.directStore ? ' S1' : ' S0');
    if (state.sourceFetchState === 'loading') return 'กำลังดึงจากหน้าวิดีโอ · ' + diagnostic;
    if (!catalog.size) {
      if (!bridgeDiagnostics.players) return 'ยังไม่จับ VideoPlayerRelay · ' + diagnostic;
      if (!bridgeDiagnostics.directStore) return 'พบตัวเล่น · ยังไม่พบ Relay Store · ' + diagnostic;
      return 'พบ Relay Store · ยังไม่มีลิงก์ · ' + diagnostic;
    }
    if (!ids.length && !duration) return 'รอ id/เวลา วิดีโอ · ' + diagnostic;
    if (ids.length && !ids.some((candidate) => catalog.has(candidate)) && !duration) return 'เจอวิดีโอแล้ว · รอจับ id · ' + diagnostic;
    if (ids.length && !ids.some((candidate) => catalog.has(candidate))) return 'เจอวิดีโอแล้ว · รอจับคู่แหล่ง · ' + diagnostic;
    if (item && !hasDownloadableSource(item)) return 'เจอข้อมูลแล้ว · รอลิงก์โหลด · ' + diagnostic;
    return 'ไม่พบแหล่ง · ' + diagnostic;
  }

  function catalogItemDuration(item) {
    let best = 0;
    for (const field of ['progressive', 'videoTracks', 'audioTracks']) {
      for (const entry of item?.[field] || []) {
        const duration = Number(entry.duration || entry.duration_s || entry.durationSeconds) || 0;
        if (duration > best) best = duration;
      }
    }
    return best;
  }

  function buildResources(item, ownerVideoId = '') {
    if (!item) return [];
    const output = [];
    for (const direct of item.progressive || []) {
      const label = directQualityLabel(direct);
      output.push({
        withSound: true,
        ownerVideoId,
        url: direct.url,
        label,
        score: direct.height || scoreLabel(label) || direct.bitrate || 1,
        display: label + ' · พร้อมเสียง'
      });
    }
    const audio = [...(item.audioTracks || [])].sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
    if (audio) {
      for (const video of item.videoTracks || []) {
        const label = trackQualityLabel(video);
        const score = (video.height || scoreLabel(label)) * 10000000 + (video.bitrate || 0);
        output.push({
          withSound: false,
          ownerVideoId,
          video,
          audio,
          label,
          score,
          display: label + ' · ภาพและเสียงแยก'
        });
        output.push({
          withSound: false,
          mergeSmall: true,
          ownerVideoId,
          video,
          audio,
          label,
          score: score - 1,
          display: label + ' · รวมเป็นไฟล์เดียว'
        });
      }
    }
    const unique = new Map();
    for (const resource of output) {
      const key = resourceGroupKey(resource);
      const previous = unique.get(key);
      if (!previous || resource.score > previous.score) unique.set(key, {...resource, key});
    }
    return [...unique.values()].sort((a, b) =>
      Number(b.withSound) - Number(a.withSound) || b.score - a.score);
  }

  function resourceGroupKey(resource) {
    if (resource.withSound) return 'sound:' + String(resource.label || resource.display || 'video').toUpperCase();
    return (resource.mergeSmall ? 'merge:' : 'split:') + String(resource.label || resource.display || 'dash').toUpperCase();
  }

  function directQualityLabel(direct) {
    const raw = String(direct?.label || '').trim();
    if (/^HD$/i.test(raw)) return 'HD';
    if (/^SD$/i.test(raw)) return 'SD';
    const height = Number(direct?.height) || scoreLabel(raw);
    if (height >= 720) return 'HD';
    if (height > 0) return 'SD';
    if (/\d{3,4}p/i.test(raw)) return raw.match(/\d{3,4}p/i)[0];
    return 'HD';
  }

  function trackQualityLabel(track) {
    const raw = String(track?.label || '').trim();
    if (/\d{3,4}p/i.test(raw)) return raw.match(/\d{3,4}p/i)[0];
    const height = Number(track?.height) || scoreLabel(raw);
    if (height) return height + 'p';
    const bitrate = Number(track?.bitrate || track?.bandwidth) || 0;
    if (bitrate) return 'DASH ' + Math.round(bitrate / 1000) + ' kbps';
    return 'DASH video';
  }
  function scoreLabel(label) {
    const match = String(label || '').match(/(\d{3,4})p/i);
    if (match) return Number(match[1]);
    if (/hd/i.test(label || '')) return 720;
    if (/sd/i.test(label || '')) return 360;
    return 0;
  }

  function cleanRange(rawUrl) {
    try {
      const url = new URL(rawUrl);
      url.searchParams.delete('bytestart');
      url.searchParams.delete('byteend');
      return url.href;
    } catch { return rawUrl || ''; }
  }

  function ensureToolbar() {
    if (toolbar?.isConnected || !document.body) return;
    toolbar = document.createElement('aside');
    toolbar.id = 'fbmd-toolbar';
    toolbar.innerHTML =
      '<div class="fbmd-header"><div class="fbmd-title">ดาวน์โหลดวิดีโอ Facebook</div>' +
      '<button type="button" class="fbmd-collapse" title="ย่อแผง" aria-label="ย่อแผง">−</button></div>' +
      '<div class="fbmd-panel">' +
      '<div class="fbmd-row"><strong class="fbmd-count">เลือกแล้ว 0 รายการ</strong>' +
      '<button type="button" class="fbmd-select-visible">เลือกวิดีโอที่เห็น</button></div>' +
      '<div class="fbmd-row fbmd-file-row"><span class="fbmd-file-count">ไฟล์ที่เจอ 0 ไฟล์</span>' +
      '<button type="button" class="fbmd-download-files">โหลดไฟล์ที่เจอ</button></div>' +
      '<div class="fbmd-selection-list"><div class="fbmd-list-empty">ยังไม่ได้เลือกวิดีโอ</div></div>' +
      '<label>คุณภาพรวม<select class="fbmd-batch-quality">' +
      '<option value="highest">พร้อมเสียงสูงสุด (HD/SD)</option><option value="hd">HD พร้อมเสียง</option>' +
      '<option value="sd">SD พร้อมเสียง</option><option value="sharpest">ชัดสุดภาพ/เสียงแยก</option><option value="merge-small">ชัดสุด + รวมเป็นไฟล์เดียว</option></select></label>' +
      '<label>งานพร้อมกัน<select class="fbmd-concurrency">' +
      '<option value="1" selected>1 (ลื่นที่สุด)</option><option value="2">2 (เร็วขึ้น)</option></select></label>' +
      '<button type="button" class="fbmd-batch-download" disabled>ดาวน์โหลดที่เลือก</button>' +
      '<section class="fbmd-jobs"><div class="fbmd-jobs-title">คิวดาวน์โหลด</div>' +
      '<div class="fbmd-job-list"><div class="fbmd-job-empty">ยังไม่มีงานในคิว</div></div></section>' +
      '<div class="fbmd-status" aria-live="polite"></div></div>';
    document.body.appendChild(toolbar);
    for (const eventName of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup']) {
      toolbar.addEventListener(eventName, (event) => event.stopPropagation());
    }
    toolbar.querySelector('.fbmd-collapse').addEventListener('click', () => {
      setToolbarCollapsed(!toolbar.classList.contains('is-collapsed'), true);
    });
    toolbar.querySelector('.fbmd-select-visible').addEventListener('click', selectVisible);
    toolbar.querySelector('.fbmd-download-files').addEventListener('click', downloadGroupFiles);
    toolbar.querySelector('.fbmd-batch-quality').addEventListener('change', updateToolbar);
    toolbar.querySelector('.fbmd-batch-download').addEventListener('click', async () => {
      const states = [...selected].map((video) => cards.get(video)).filter(Boolean);
      await queueStates(states, 'batch');
    });
    chrome.storage.local.get({[TOOLBAR_COLLAPSED_KEY]: false}).then((settings) => {
      setToolbarCollapsed(Boolean(settings[TOOLBAR_COLLAPSED_KEY]), false);
    }).catch(() => {});
    updateToolbar();
    renderJobStatuses();
  }

  function setToolbarCollapsed(collapsed, persist) {
    if (!toolbar) return;
    toolbar.classList.toggle('is-collapsed', collapsed);
    const button = toolbar.querySelector('.fbmd-collapse');
    button.textContent = collapsed ? '+' : '−';
    button.title = collapsed ? 'ขยายแผง' : 'ย่อแผง';
    button.setAttribute('aria-label', button.title);
    if (persist) chrome.storage.local.set({[TOOLBAR_COLLAPSED_KEY]: collapsed}).catch(() => {});
  }

  function visibleStates() {
    return [...cards.entries()].filter(([video, state]) => {
      if (!video.isConnected || !state.resources.length || state.card.classList.contains('is-hidden')) return false;
      const style = getComputedStyle(video);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = video.getBoundingClientRect();
      return rect.width >= 180 && rect.height >= 100 && rect.bottom > 0 && rect.right > 0 &&
        rect.top < innerHeight && rect.left < innerWidth;
    });
  }

  function selectVisible() {
    const visible = visibleStates();
    if (!visible.length) {
      showStatus('ยังไม่มีวิดีโอที่มองเห็นและมีลิงก์พร้อม', true);
      return;
    }
    const shouldSelect = !visible.every(([video]) => selected.has(video));
    for (const state of cards.values()) state.card.querySelector('.fbmd-check').checked = false;
    selected.clear();
    if (shouldSelect) {
      for (const [video, state] of visible) {
        selected.add(video);
        state.card.querySelector('.fbmd-check').checked = true;
      }
    }
    updateToolbar();
  }

  function updateToolbar() {
    if (!toolbar?.isConnected) {
      toolbar = null;
      ensureToolbar();
      return;
    }
    toolbar.querySelector('.fbmd-count').textContent = 'เลือกแล้ว ' + selected.size + ' รายการ';
    toolbar.querySelector('.fbmd-batch-download').disabled = selected.size === 0;
    const files = collectGroupFiles();
    const fileButton = toolbar.querySelector('.fbmd-download-files');
    toolbar.querySelector('.fbmd-file-count').textContent = 'ไฟล์ที่เจอ ' + files.length + ' ไฟล์';
    fileButton.disabled = files.length === 0;

    const visible = visibleStates();
    const allVisibleSelected = visible.length > 0 && visible.every(([video]) => selected.has(video));
    toolbar.querySelector('.fbmd-select-visible').textContent = allVisibleSelected ? 'ยกเลิกที่เห็น' : 'เลือกวิดีโอที่เห็น';

    const list = toolbar.querySelector('.fbmd-selection-list');
    list.textContent = '';
    if (!selected.size) {
      const empty = document.createElement('div');
      empty.className = 'fbmd-list-empty';
      empty.textContent = 'ยังไม่ได้เลือกวิดีโอ';
      list.appendChild(empty);
      return;
    }

    const batchMode = toolbar.querySelector('.fbmd-batch-quality').value || 'highest';
    for (const video of selected) {
      const state = cards.get(video);
      if (!state) continue;
      const videoId = state.videoId || 'video';
      const resource = chooseBatchResource(state.resources, batchMode);
      const row = document.createElement('div');
      row.className = 'fbmd-list-item';
      const name = document.createElement('div');
      name.className = 'fbmd-list-name';
      name.textContent = buildFilename(video, videoId);
      name.title = name.textContent;
      const detail = document.createElement('div');
      detail.className = 'fbmd-list-detail';
      detail.textContent = resource?.display || state.card.querySelector('.fbmd-quality')?.selectedOptions?.[0]?.textContent || 'กำลังค้นหาแหล่งดาวน์โหลด';
      row.append(name, detail);
      list.appendChild(row);
    }
  }

  function collectGroupFiles() {
    const files = new Map();
    for (const anchor of document.querySelectorAll('a[href]')) {
      if (anchor.closest('#fbmd-toolbar, #fbmd-overlay-root')) continue;
      const file = fileFromAnchor(anchor);
      if (!file) continue;
      files.set(file.url, file);
    }
    return [...files.values()];
  }

  function fileFromAnchor(anchor) {
    try {
      const url = new URL(anchor.href, location.href);
      if (!/^https?:$/i.test(url.protocol)) return null;
      const text = [
        anchor.innerText,
        anchor.textContent,
        anchor.getAttribute('aria-label'),
        anchor.getAttribute('title'),
        anchor.getAttribute('download'),
        url.pathname,
        url.search
      ].filter(Boolean).join(' ');
      const looksLikeFilePage = /\/groups\/[^/]+\/files(?:\/|$)|\/files\/(?:files\/)?\d+/i.test(url.pathname);
      const looksLikeGroupFilePermalink = /\/groups\/[^/]+\/permalink\/\d+/i.test(url.pathname) &&
        fileExtensionFromText(text);
      const looksLikeDownload = /download|ดาวน์โหลด|attachment|preview|file|ไฟล์/i.test(text) ||
        /\/download(?:\/|$)|\/ajax\/.*download|\/attachment\.php/i.test(url.pathname);
      const hasKnownExtension = fileExtensionFromText(url.href);
      if (!looksLikeFilePage && !looksLikeGroupFilePermalink && !looksLikeDownload && !hasKnownExtension) return null;
      if (/\/photo\/|\/videos?\/|\/reel\/|\/watch\/|\/profile\.php/i.test(url.pathname)) return null;
      const filename = filenameFromAnchor(anchor, url);
      return {
        url: url.href,
        filename,
        optionButton: findFileOptionButton(anchor),
        needsResolve: looksLikeGroupFilePermalink && !looksLikeDownload && !hasKnownExtension
      };
    } catch {
      return null;
    }
  }

  function filenameFromAnchor(anchor, url) {
    const explicit = anchor.getAttribute('download') || '';
    const text = (explicit || anchor.innerText || anchor.textContent || '').trim();
    const fromText = text.match(fileNamePattern())?.[0];
    const fromPath = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '');
    const raw = fromText || (fileExtensionFromText(fromPath) ? fromPath : text) || 'facebook-group-file';
    return truncateFilenamePreserveExtension(sanitizeFilename(raw), 160) || 'facebook-group-file';
  }

  function fileNamePattern() {
    return /[\wก-๙][\wก-๙ .()[\]{}+&,_-]+\.(?:pdf|docx?|xlsx?|pptx?|zip|rar|7z|txt|csv|apk|exe|msi|jpg|jpeg|png|gif|webp|dwg|dxf|skp|rvt|rfa|ifc|3ds|max|psd|ai|eps)\b/i;
  }

  function fileExtensionFromText(text) {
    return String(text || '').match(/\.(?:pdf|docx?|xlsx?|pptx?|zip|rar|7z|txt|csv|apk|exe|msi|jpg|jpeg|png|gif|webp|dwg|dxf|skp|rvt|rfa|ifc|3ds|max|psd|ai|eps)(?:[?#\s]|$)/i)?.[0] || '';
  }

  function sanitizeFilename(value) {
    return String(value || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function truncateFilenamePreserveExtension(filename, maxLength) {
    const clean = sanitizeFilename(filename);
    if (clean.length <= maxLength) return clean;
    const match = clean.match(/(\.[a-z0-9]{2,5})$/i);
    if (!match) return clean.slice(0, maxLength).trim();
    const extension = match[1];
    const base = clean.slice(0, -extension.length).trim();
    return base.slice(0, Math.max(1, maxLength - extension.length)).trim() + extension;
  }

  function findFileOptionButton(anchor) {
    let node = anchor;
    for (let depth = 0; node && depth < 10; depth++, node = node.parentElement) {
      const button = [...node.querySelectorAll?.('[role="button"], button') || []].find((candidate) => {
        if (candidate.closest('#fbmd-toolbar, #fbmd-overlay-root')) return false;
        const label = [
          candidate.getAttribute('aria-label'),
          candidate.getAttribute('title'),
          candidate.innerText,
          candidate.textContent
        ].filter(Boolean).join(' ');
        return /ตัวเลือกไฟล์|file options|options/i.test(label);
      });
      if (button) return button;
    }
    return null;
  }

  async function downloadGroupFiles() {
    const files = collectGroupFiles();
    if (!files.length) {
      showStatus('ยังไม่เจอลิงก์ไฟล์ในหน้านี้ ลองเลื่อนให้รายการไฟล์โหลดก่อน', true);
      return;
    }
    const queuedAt = Date.now();
    const started = [];
    for (const [index, file] of files.entries()) {
      const jobId = 'file-' + crypto.randomUUID();
      jobStatuses.set(jobId, {
        id: jobId,
        filename: file.filename,
        state: 'queued',
        progress: 0,
        detail: 'ไฟล์กลุ่ม · รอส่งเข้า Chrome',
        createdAt: queuedAt + index,
        updatedAt: Date.now()
      });
      try {
        let downloadIds = [];
        let detail = 'Chrome เริ่มโหลดไฟล์แล้ว';
        try {
          const resolved = await resolveGroupFileDownload(file);
          const response = await chrome.runtime.sendMessage({
            type: 'FBMD_DIRECT_DOWNLOAD',
            url: resolved.url,
            filename: file.filename
          });
          if (!response?.ok) throw new Error(response?.error || 'download failed');
          downloadIds = [response.downloadId];
        } catch (resolveError) {
          const clicked = await clickFileDownloadFromMenu(file);
          if (!clicked) throw resolveError;
          detail = 'สั่งดาวน์โหลดผ่านเมนูตัวเลือกไฟล์แล้ว';
        }
        jobStatuses.set(jobId, {
          id: jobId,
          filename: file.filename,
          state: 'started',
          progress: 10,
          detail,
          downloadIds,
          createdAt: queuedAt + index,
          updatedAt: Date.now()
        });
        started.push(file);
      } catch (error) {
        jobStatuses.set(jobId, {
          id: jobId,
          filename: file.filename,
          state: 'error',
          progress: 0,
          detail: String(error?.message || error),
          createdAt: queuedAt + index,
          updatedAt: Date.now()
        });
      }
      renderJobStatuses();
      await waitMs(650);
    }
    updateToolbar();
    showStatus('ส่งไฟล์เข้า Chrome แล้ว ' + started.length + ' / ' + files.length + ' ไฟล์', started.length === 0);
  }

  async function resolveGroupFileDownload(file) {
    if (!file.needsResolve) return file;
    const response = await fetch(file.url, {credentials: 'include', cache: 'force-cache'});
    const text = response.ok ? await response.text() : '';
    const url = extractDownloadUrlFromHtml(text, file);
    if (!url) throw new Error('หา URL ดาวน์โหลดจริงไม่เจอในหน้าไฟล์');
    return {...file, url};
  }

  async function clickFileDownloadFromMenu(file) {
    if (!file.optionButton?.isConnected) return false;
    closeOpenMenus();
    file.optionButton.scrollIntoView({block: 'center', inline: 'center'});
    await waitMs(120);
    file.optionButton.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true, view: window}));
    file.optionButton.click();
    const item = await waitForDownloadMenuItem();
    if (!item) {
      closeOpenMenus();
      return false;
    }
    item.scrollIntoView({block: 'center', inline: 'center'});
    await waitMs(80);
    item.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true, view: window}));
    item.click();
    await waitMs(250);
    return true;
  }

  async function waitForDownloadMenuItem(timeout = 2500) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const item = findDownloadMenuItem();
      if (item) return item;
      await waitMs(80);
    }
    return null;
  }

  function findDownloadMenuItem() {
    const candidates = document.querySelectorAll(
      '[role="menu"] [role="menuitem"], [role="dialog"] [role="menuitem"], [role="menuitem"], [role="menuitemradio"], a[href]'
    );
    for (const candidate of candidates) {
      if (candidate.closest('#fbmd-toolbar, #fbmd-overlay-root')) continue;
      const text = [
        candidate.getAttribute('aria-label'),
        candidate.getAttribute('title'),
        candidate.innerText,
        candidate.textContent,
        candidate.getAttribute('href')
      ].filter(Boolean).join(' ');
      if (/ดาวน์โหลด|download/i.test(text) && !/อัปโหลด|upload|copy|คัดลอก/i.test(text)) return candidate;
    }
    return null;
  }

  function closeOpenMenus() {
    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', code: 'Escape', bubbles: true}));
  }

  function waitMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function extractDownloadUrlFromHtml(text, file) {
    if (!text) return '';
    const candidates = [];
    const hrefPattern = /href=(?:"|')([^"']+)(?:"|')/gi;
    for (const match of text.matchAll(hrefPattern)) candidates.push(decodeHtml(match[1]));
    const jsonUrlPattern = /["'](?:download_uri|download_url|url|uri)["']\s*:\s*["']((?:\\.|[^"'])+)["']/gi;
    for (const match of text.matchAll(jsonUrlPattern)) candidates.push(decodeJsonString(match[1]));
    const rawUrlPattern = /https?:\\?\/\\?\/[^"'<>\s]+/gi;
    for (const match of text.matchAll(rawUrlPattern)) candidates.push(decodeJsonString(match[0]));
    for (const raw of candidates) {
      const normalized = normalizeFacebookFileUrl(raw, file);
      if (normalized) return normalized;
    }
    return '';
  }

  function normalizeFacebookFileUrl(raw, file) {
    try {
      const url = new URL(decodeHtml(raw).replace(/\\\//g, '/'), location.href);
      const text = decodeURIComponent(url.href);
      const expectedExtension = String(fileExtensionFromText(file?.filename || '')).toLowerCase();
      const actualExtension = String(fileExtensionFromText(text)).toLowerCase();
      const isDownloadRoute = /\/download(?:\/|$)|\/ajax\/.*download|\/attachment\.php|\/file_download\//i.test(url.pathname);
      const isStaticAsset = /(^|\.)static\.xx\.fbcdn\.net$/i.test(url.hostname) || /\/rsrc\.php\//i.test(url.pathname);
      const isExpectedCdnFile = /(?:fbcdn|fbsbx)\.net$/i.test(url.hostname) &&
        !isStaticAsset &&
        actualExtension &&
        (!expectedExtension || actualExtension === expectedExtension);
      if (!isDownloadRoute && !isExpectedCdnFile) return '';
      if (isExpectedCdnFile && expectedExtension && actualExtension !== expectedExtension) return '';
      return url.href;
    } catch {
      return '';
    }
  }

  function decodeHtml(value) {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = String(value || '');
    return textarea.value;
  }

  async function queueStates(states, source) {
    const batchMode = toolbar?.querySelector('.fbmd-batch-quality').value || 'highest';
    const jobs = [];
    for (const state of states) {
      updateCard(state);
      if (!state.matchVerified) continue;
      const resource = source === 'card'
        ? resourceByKey(state.resources, state.card.querySelector('.fbmd-quality').value)
        : chooseBatchResource(state.resources, batchMode);
      if (!resource) continue;
      const videoId = state.videoId || 'video-' + Date.now();
      if (resource.ownerVideoId && state.videoId && resource.ownerVideoId !== state.videoId) continue;
      jobs.push({
        id: crypto.randomUUID(),
        videoId,
        filename: buildFilename(state.video, videoId),
        resource
      });
    }
    if (!jobs.length) {
      showStatus('ยังยืนยันไม่ได้ว่าลิงก์ตรงกับวิดีโอนี้ จึงยกเลิกเพื่อป้องกันการโหลดผิดไฟล์', true);
      return;
    }
    const queuedAt = Date.now();
    jobs.forEach((job, index) => jobStatuses.set(job.id, {
      id: job.id,
      filename: job.filename,
      state: 'queued',
      progress: 0,
      detail: 'รอเริ่มงาน',
      createdAt: queuedAt + index,
      updatedAt: queuedAt
    }));
    renderJobStatuses();
    const concurrency = Number(toolbar?.querySelector('.fbmd-concurrency').value) || 1;
    const response = await chrome.runtime.sendMessage({type: 'FBMD_QUEUE_JOBS', jobs, concurrency});
    if (!response?.ok) {
      for (const job of jobs) {
        const status = jobStatuses.get(job.id);
        if (status) Object.assign(status, {state: 'error', detail: response?.error || 'เริ่มงานไม่สำเร็จ', updatedAt: Date.now()});
      }
      renderJobStatuses();
      showStatus('เริ่มงานไม่สำเร็จ: ' + (response?.error || 'unknown error'), true);
    } else {
      showStatus('เพิ่มเข้าคิวแล้ว: ' + jobs.map((job) => job.filename).join(', '));
    }
  }

  function resourceByKey(resources, key) {
    return resources.find((resource) => resource.key === key) || resources[0];
  }

  function chooseBatchResource(resources, mode) {
    if (mode === 'merge-small') {
      const separate = [...resources].filter((x) => !x.withSound).sort((a, b) => b.score - a.score)[0];
      if (separate) return {...separate, mergeSmall: true};
      return [...resources].sort((a, b) => b.score - a.score)[0];
    }
    if (mode === 'sharpest') return [...resources].sort((a, b) =>
      b.score - a.score || Number(b.withSound) - Number(a.withSound))[0];
    const direct = resources.filter((x) => x.withSound);
    if (mode === 'highest') return direct.sort((a, b) => b.score - a.score)[0] || resources[0];
    if (!direct.length) return resources[0];
    if (mode === 'sd') return direct.sort((a, b) => a.score - b.score)[0];
    return direct.sort((a, b) => b.score - a.score)[0];
  }

  function buildFilename(video, videoId) {
    const article = video.closest('[role="article"], article') || video.parentElement;
    const preferred = article?.querySelector(
      '[data-ad-preview="message"], [data-ad-comet-preview="message"], [data-testid="post_message"]'
    );
    let caption = cleanCaptionText(preferred?.innerText || '') || findVideoCaption(video);
    if (!caption && article) {
      const candidates = [...article.querySelectorAll('[dir="auto"]')]
        .map((node) => cleanCaptionText(node.innerText || ''))
        .filter(isUsefulCaptionText);
      caption = candidates.sort((a, b) => b.length - a.length)[0] || '';
    }
    caption = caption || 'facebook-video-' + videoId;
    caption = cleanCaptionText(caption);
    return truncateFilenamePreserveExtension(caption + '.mp4', 150);
  }

  function findVideoCaption(video) {
    const preferredSelectors = [
      '[data-ad-preview="message"]',
      '[data-ad-comet-preview="message"]',
      '[data-testid="post_message"]',
      '[data-ad-rendering-role="story_message"]'
    ];
    const candidates = [];
    for (const selector of preferredSelectors) {
      for (const node of document.querySelectorAll(selector)) addCaptionCandidate(candidates, node, 100);
    }
    const roots = [
      video.closest('[role="dialog"]'),
      document.querySelector('[role="main"]'),
      document.body
    ].filter(Boolean);
    for (const root of roots) {
      for (const node of root.querySelectorAll('[dir="auto"], span, div')) {
        addCaptionCandidate(candidates, node, 0);
      }
    }
    candidates.sort((a, b) => b.score - a.score || b.text.length - a.text.length);
    return candidates[0]?.text || '';
  }

  function addCaptionCandidate(candidates, node, baseScore) {
    const text = cleanCaptionText(node?.innerText || node?.textContent || '');
    if (!isUsefulCaptionText(text) || !isElementVisible(node)) return;
    if (candidates.some((item) => item.text === text)) return;
    let score = baseScore;
    if (/^(บทเรียน|บทที่|ตอนที่|EP\.?\s*\d+|Lesson\s*\d+)/i.test(text)) score += 80;
    if (/(บทเรียน|ตอนที่|การสร้าง|Template|คอร์ส|course|lesson|AutoCAD|Revit|SketchUp)/i.test(text)) score += 35;
    if (/[.!?。]$/.test(text) || text.length > 25) score += 10;
    if (/ห้องเรียน|ผู้ดูแล|ผู้มีส่วนร่วม|ความคิดเห็น|แสดงความคิดเห็น|ดาวน์โหลดวิดีโอ|Facebook|Download history/i.test(text)) score -= 60;
    if (/^\d+$/.test(text) || /^\d+\s*(มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม)/i.test(text)) score -= 80;
    candidates.push({text, score});
  }

  function cleanCaptionText(value) {
    return String(value || '')
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isUsefulCaptionText(text) {
    if (!text || text.length < 8 || text.length > 260) return false;
    if (/^(ถูกใจ|แสดงความคิดเห็น|แชร์|ส่ง|ผู้ดูแล|ผู้มีส่วนร่วม|ยังไม่มีความคิดเห็น|เริ่มแสดงความคิดเห็น|ดาวน์โหลด|เลือก)$/i.test(text)) return false;
    return /[ก-๙A-Za-z]/.test(text);
  }

  function isElementVisible(node) {
    if (!(node instanceof Element)) return false;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' &&
      style.visibility !== 'hidden' && Number(style.opacity) !== 0;
  }

  function renderJobStatuses() {
    if (!toolbar?.isConnected) return;
    const list = toolbar.querySelector('.fbmd-job-list');
    if (!list) return;
    list.textContent = '';
    const jobs = [...jobStatuses.values()].sort((a, b) => {
      const rank = (job) => job.state === 'queued' ? 1 : ['started', 'error'].includes(job.state) ? 2 : 0;
      return rank(a) - rank(b) || a.createdAt - b.createdAt;
    });
    if (!jobs.length) {
      const empty = document.createElement('div');
      empty.className = 'fbmd-job-empty';
      empty.textContent = 'ยังไม่มีงานในคิว';
      list.appendChild(empty);
      return;
    }
    const labels = {
      queued: 'เข้าคิว', checking: 'กำลังตรวจขนาด', starting: 'กำลังเริ่ม', fetching: 'กำลังโหลด',
      fallback: 'กำลังดาวน์โหลดภาพ/เสียงแยก',
      started: 'กำลังดาวน์โหลด', complete: 'เสร็จแล้ว', error: 'ผิดพลาด'
    };
    for (const job of jobs) {
      const row = document.createElement('div');
      row.className = 'fbmd-job-item state-' + job.state;
      const name = document.createElement('div');
      name.className = 'fbmd-job-name';
      name.textContent = job.filename || 'ไฟล์วิดีโอ';
      name.title = name.textContent;
      const meta = document.createElement('div');
      meta.className = 'fbmd-job-meta';
      meta.textContent = (labels[job.state] || job.state) + ' · ' + Math.round(job.progress || 0) + '%' +
        (job.detail ? ' · ' + job.detail : '');
      const track = document.createElement('div');
      track.className = 'fbmd-job-progress';
      const bar = document.createElement('span');
      bar.style.width = Math.max(0, Math.min(100, Number(job.progress) || 0)) + '%';
      track.appendChild(bar);
      row.append(name, meta, track);
      list.appendChild(row);
    }
  }

  async function syncDownloadProgress() {
    if (progressSyncActive) return;
    const entries = [...jobStatuses.values()]
      .filter((job) => job.state === 'started' && job.downloadIds?.length)
      .map((job) => ({jobId: job.id, downloadIds: job.downloadIds}));
    if (!entries.length) return;

    progressSyncActive = true;
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'FBMD_GET_DOWNLOAD_PROGRESS',
        entries
      });
      for (const item of response?.items || []) {
        const current = jobStatuses.get(item.jobId);
        if (!current || ['complete', 'error'].includes(current.state)) continue;
        updateProgress({...item, filename: current.filename});
      }
    } catch {
    } finally {
      progressSyncActive = false;
    }
  }

  function updateProgress(message) {
    const current = jobStatuses.get(message.jobId);
    if (message.state === 'queued' && current && current.state !== 'queued') return;
    const now = Date.now();
    jobStatuses.set(message.jobId, {
      id: message.jobId,
      filename: message.filename || current?.filename || 'facebook-video.mp4',
      state: message.state || current?.state || 'queued',
      progress: Number(message.progress) || 0,
      detail: message.detail || current?.detail || '',
      downloadIds: message.downloadIds || current?.downloadIds || [],
      createdAt: current?.createdAt || now,
      updatedAt: now
    });
    renderJobStatuses();
    const filename = message.filename || current?.filename || 'ไฟล์วิดีโอ';
    const text = message.detail || message.state;
    showStatus(filename + ' · ' + String(message.progress || 0) + '% · ' + text, message.state === 'error');
  }

  function showStatus(text, isError = false) {
    ensureToolbar();
    const status = toolbar.querySelector('.fbmd-status');
    status.textContent = text;
    status.classList.toggle('is-error', isError);
  }

  const observer = new MutationObserver((mutations) => {
    const hasFacebookChange = mutations.some((mutation) => {
      const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
      return !target?.closest('#fbmd-toolbar, #fbmd-overlay-root');
    });
    if (hasFacebookChange) scan();
  });
  observer.observe(document.documentElement, {childList: true, subtree: true});
  addEventListener('scroll', () => {
    hideCardsWhileScrolling();
    schedulePositionCards();
    scan();
  }, {passive: true, capture: true});
  addEventListener('resize', schedulePositionCards, {passive: true});
  addEventListener('pointermove', (event) => {
    scheduleHoverUpdate(event.clientX, event.clientY);
  }, {passive: true, capture: true});
  addEventListener('pointerleave', () => scheduleHoverUpdate(-1, -1), {passive: true});
  document.addEventListener('DOMContentLoaded', scan, {once: true});
  scan();
  setInterval(refreshPendingCards, 2000);
  setInterval(() => syncDownloadProgress().catch(() => {}), 1000);
})();
