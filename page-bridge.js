(() => {
  if (window.__FBMD_BRIDGE__) return;
  window.__FBMD_BRIDGE__ = true;

  const catalog = new Map();
  let emitTimer;
  let looseSequence = 0;
  let performanceCursor = 0;
  let performanceObserver;
  let relaySourceProxy;
  const relaySources = new Set();
  const CAPTURE_PAGE_RESPONSES = true;
  const CAPTURE_MEDIA_PERFORMANCE = true;
  const RELAY_WRAPPED = Symbol('fbmd-relay-wrapped');
  const DEFINE_WRAPPED = Symbol('fbmd-define-wrapped');
  const PLAYER_WRAPPED = Symbol('fbmd-player-wrapped');
  const REQUIRE_WRAPPED = Symbol('fbmd-require-wrapped');
  const activePlayerVideoIds = new Set();

  if (typeof window.___sf !== 'function') installRelayCapture();
  installExactPlayerProxy();

  function installExactPlayerProxy() {
    if (typeof window.___pt !== 'function' || typeof window.___km !== 'function') return;
    const key = 'VideoPlayerRelay.react|facebook-multi-downloader';
    try {
      window.___pt(key);
      window.___km(key, (context) => {
        const rawId = context?.payload?.video?.__id;
        const id = String(rawId || '').replace(/^(?:Video|CometVideo|SVDVideo):/i, '');
        if (!id) return context?.lastCmp;
        try {
          const React = window.require?.('react');
          const control = typeof React?.jsx === 'function'
            ? React.jsx(FBMDReactControl, {videoId: id})
            : React?.createElement?.(FBMDReactControl, {videoId: id});
          return control ? [control, context.lastCmp] : context.lastCmp;
        } catch {
          return context?.lastCmp;
        }
      });
    } catch {}
  }

  function FBMDReactControl({videoId}) {
    try {
      const React = window.require?.('react');
      const props = {
        type: 'button',
        className: 'fbmd-react-download',
        title: 'ดาวน์โหลดวิดีโอนี้',
        'aria-label': 'ดาวน์โหลดวิดีโอนี้',
        style: {
          position: 'absolute', right: 16, top: 16, zIndex: 2,
          width: 26, height: 26, padding: 0, border: 0, borderRadius: '50%',
          color: '#fff', background: '#1877f2', cursor: 'pointer',
          fontSize: 19, fontWeight: 700, lineHeight: '26px'
        },
        onClick: (event) => {
          event.stopPropagation();
          event.preventDefault();
          openQualityMenu(event.currentTarget, videoId);
        },
        children: '⇩'
      };
      return typeof React?.jsx === 'function'
        ? React.jsx('button', props)
        : React?.createElement?.('button', props, '⇩') || null;
    } catch {
      return null;
    }
  }

  function installRelayCapture() {
    const wrapDefine = (define) => {
      if (typeof define !== 'function' || define[DEFINE_WRAPPED]) return define;
      const wrapped = new Proxy(define, {
        apply(target, thisArg, args) {
          const moduleName = typeof args[0] === 'string' ? args[0] : '';
          if (/RelayRecordSourceProxy/i.test(moduleName)) {
            const factoryIndex = args.findIndex((value, index) => index > 0 && typeof value === 'function');
            if (factoryIndex >= 0) args[factoryIndex] = wrapRelayFactory(args[factoryIndex]);
          } else if (/RelayPublishQueue/i.test(moduleName)) {
            const factoryIndex = args.findIndex((value, index) => index > 0 && typeof value === 'function');
            if (factoryIndex >= 0) {
              const patched = patchPublishQueueFactory(args[factoryIndex]);
              args[factoryIndex] = wrapPublishQueueFactory(patched);
            }
          } else if (/VideoPlayerRelay/i.test(moduleName)) {
            const factoryIndex = args.findIndex((value, index) => index > 0 && typeof value === 'function');
            if (factoryIndex >= 0) args[factoryIndex] = wrapVideoPlayerFactory(args[factoryIndex]);
          }
          return Reflect.apply(target, thisArg, args);
        }
      });
      Object.defineProperty(wrapped, DEFINE_WRAPPED, {value: true});
      return wrapped;
    };

    const descriptor = Object.getOwnPropertyDescriptor(window, '__d');
    if (!descriptor || descriptor.configurable) {
      let current = wrapDefine(window.__d);
      Object.defineProperty(window, '__d', {
        configurable: true,
        enumerable: descriptor?.enumerable ?? true,
        get: () => current,
        set: (value) => { current = wrapDefine(value); }
      });
      return;
    }

    const timer = setInterval(() => {
      if (typeof window.__d !== 'function' || window.__d[DEFINE_WRAPPED]) return;
      try { window.__d = wrapDefine(window.__d); } catch {}
    }, 10);
    setTimeout(() => clearInterval(timer), 15000);
  }

  function wrapRelayFactory(factory) {
    if (factory[RELAY_WRAPPED]) return factory;
    const wrappedFactory = function(...args) {
      const result = Reflect.apply(factory, this, args);
      try {
        for (const exportsObject of findExportContainers(args)) wrapRelayConstructor(exportsObject);
      } catch {}
      return result;
    };
    Object.defineProperty(wrappedFactory, RELAY_WRAPPED, {value: true});
    return wrappedFactory;
  }

  function findExportContainers(args) {
    const containers = new Set();
    for (const value of args) {
      if (!value || typeof value !== 'object') continue;
      if (typeof value.default === 'function') containers.add(value);
      if (value.exports && typeof value.exports === 'object') containers.add(value.exports);
    }
    return [...containers];
  }

  function wrapRelayConstructor(exportsObject) {
    const Original = exportsObject?.default;
    if (typeof Original !== 'function' || Original[RELAY_WRAPPED]) return;
    let Wrapped;
    Wrapped = new Proxy(Original, {
      construct(target, constructorArgs, newTarget) {
        const instance = Reflect.construct(target, constructorArgs, newTarget === Wrapped ? target : newTarget);
        relaySourceProxy = instance;
        rememberRelaySource(instance);
        for (const candidate of constructorArgs) rememberRelaySource(candidate);
        queueMicrotask(scanRelayStore);
        return instance;
      }
    });
    Object.defineProperty(Wrapped, RELAY_WRAPPED, {value: true});
    exportsObject.default = Wrapped;
  }

  function wrapPublishQueueFactory(factory) {
    if (factory[RELAY_WRAPPED]) return factory;
    const wrappedFactory = function(...args) {
      for (const index of [2, 3]) {
        const originalRequire = args[index];
        if (typeof originalRequire !== 'function' || originalRequire[REQUIRE_WRAPPED]) continue;
        const wrappedRequire = new Proxy(originalRequire, {
          apply(target, thisArg, requireArgs) {
            const loaded = Reflect.apply(target, thisArg, requireArgs);
            if (!/RelayRecordSourceProxy/i.test(String(requireArgs[0] || ''))) return loaded;
            if (typeof loaded === 'function') return relayConstructorProxy(loaded);
            if (loaded && typeof loaded.default === 'function') {
              try { loaded.default = relayConstructorProxy(loaded.default); } catch {}
            }
            return loaded;
          }
        });
        Object.defineProperty(wrappedRequire, REQUIRE_WRAPPED, {value: true});
        args[index] = wrappedRequire;
      }
      return Reflect.apply(factory, this, args);
    };
    Object.defineProperty(wrappedFactory, RELAY_WRAPPED, {value: true});
    return wrappedFactory;
  }

  function patchPublishQueueFactory(factory) {
    try {
      const source = Function.prototype.toString.call(factory);
      const patchedSource = source.replace(
        /,(\w+)=new\((\w+)\("relay-runtime\/mutations\/RelayRecordSourceProxy"\)/,
        ',window.__FBMD_RELAY_SOURCE__=$1=new($2("relay-runtime/mutations/RelayRecordSourceProxy")'
      );
      if (patchedSource === source) return factory;
      return compilePageFunction(patchedSource) || factory;
    } catch {
      return factory;
    }
  }

  function compilePageFunction(source) {
    const cacheName = '__FBMD_FACTORY_CACHE__';
    const key = 'factory_' + Date.now().toString(36) + Math.random().toString(36).slice(2);
    window[cacheName] ||= Object.create(null);
    const script = document.createElement('script');
    const nonceSource = document.currentScript || document.querySelector('script[nonce]');
    const nonce = nonceSource?.nonce || nonceSource?.getAttribute?.('nonce') || '';
    if (nonce) script.setAttribute('nonce', nonce);
    script.textContent = 'window.' + cacheName + '[' + JSON.stringify(key) + ']=(' + source + ');';
    (document.head || document.documentElement).appendChild(script);
    script.remove();
    const compiled = window[cacheName][key];
    delete window[cacheName][key];
    return typeof compiled === 'function' ? compiled : null;
  }

  function relayConstructorProxy(Original) {
    if (Original[RELAY_WRAPPED]) return Original;
    let Wrapped;
    Wrapped = new Proxy(Original, {
      construct(target, constructorArgs, newTarget) {
        const instance = Reflect.construct(target, constructorArgs, newTarget === Wrapped ? target : newTarget);
        relaySourceProxy = instance;
        rememberRelaySource(instance);
        for (const candidate of constructorArgs) rememberRelaySource(candidate);
        queueMicrotask(scanRelayStore);
        return instance;
      }
    });
    Object.defineProperty(Wrapped, RELAY_WRAPPED, {value: true});
    return Wrapped;
  }

  function wrapVideoPlayerFactory(factory) {
    if (factory[PLAYER_WRAPPED]) return factory;
    const wrappedFactory = function(...args) {
      const result = Reflect.apply(factory, this, args);
      try {
        for (const exportsObject of findExportContainers(args)) {
          const Original = exportsObject.default;
          if (typeof Original !== 'function' || Original[PLAYER_WRAPPED]) continue;
          const Wrapped = new Proxy(Original, {
            apply(target, thisArg, componentArgs) {
              const result = Reflect.apply(target, thisArg, componentArgs);
              let id = '';
              try { id = capturePlayerVideoId(componentArgs[0]); } catch {}
              return markPlayerResult(result, id);
            }
          });
          Object.defineProperty(Wrapped, PLAYER_WRAPPED, {value: true});
          exportsObject.default = Wrapped;
        }
      } catch {}
      return result;
    };
    Object.defineProperty(wrappedFactory, PLAYER_WRAPPED, {value: true});
    return wrappedFactory;
  }

  function capturePlayerVideoId(payload) {
    const raw = payload?.video?.__id || payload?.video?.id || payload?.videoId || payload?.video_id;
    const id = String(raw || '').replace(/^(?:Video|CometVideo|SVDVideo):/i, '');
    if (!/^\d{8,}$/.test(id)) return '';
    activePlayerVideoIds.delete(id);
    activePlayerVideoIds.add(id);
    while (activePlayerVideoIds.size > 30) activePlayerVideoIds.delete(activePlayerVideoIds.values().next().value);
    const progressive = extractProgressiveFields(payload);
    if (progressive.length) {
      recordWithAliases(id, {progressive, videoTracks: [], audioTracks: []});
    }
    queueMicrotask(scanRelayStore);
    scheduleEmit();
    return id;
  }

  function scanVideoReactFibers() {
    let changed = false;
    for (const video of document.querySelectorAll('video')) {
      if (video.hasAttribute('data-fbmd-player-video-id')) continue;
      const fiberKey = Object.getOwnPropertyNames(video).find((name) =>
        name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'));
      let fiber = fiberKey ? video[fiberKey] : null;
      let id = '';
      for (let depth = 0; fiber && depth < 60 && !id; depth++, fiber = fiber.return) {
        id = videoIdFromReactProps(fiber.memoizedProps) || videoIdFromReactProps(fiber.pendingProps);
      }
      if (!id) continue;
      video.setAttribute('data-fbmd-player-video-id', id);
      activePlayerVideoIds.delete(id);
      activePlayerVideoIds.add(id);
      changed = true;
    }
    if (changed) {
      scanRelayStore();
      scheduleEmit();
    }
  }

  function videoIdFromReactProps(props) {
    if (!props || typeof props !== 'object') return '';
    const candidates = [
      props.video?.__id,
      props.video?.id,
      props.videoId,
      props.video_id,
      props.media?.video?.__id,
      props.storyData?.video?.__id
    ];
    for (const candidate of candidates) {
      const id = String(candidate || '').replace(/^(?:Video|CometVideo|SVDVideo):/i, '');
      if (/^\d{8,}$/.test(id)) return id;
    }
    return '';
  }

  function markPlayerResult(result, id) {
    if (!id || !result) return result;
    try {
      const React = window.require?.('react');
      if (typeof React?.jsx === 'function') {
        const marker = React.jsx('button', {
          type: 'button',
          className: 'fbmd-react-download',
          'data-fbmd-player-video-id': id,
          title: 'ดาวน์โหลดวิดีโอนี้',
          'aria-label': 'ดาวน์โหลดวิดีโอนี้',
          style: {
            position: 'absolute', right: 16, top: 16, zIndex: 2,
            width: 26, height: 26, padding: 0, border: 0, borderRadius: '50%',
            color: '#fff', background: '#1877f2', cursor: 'pointer',
            fontSize: 19, fontWeight: 700, lineHeight: '26px'
          },
          onClick: (event) => {
            event.stopPropagation();
            event.preventDefault();
            openQualityMenu(event.currentTarget, id);
          },
          children: '⇩'
        });
        return React.jsx(React.Fragment || Symbol.for('react.fragment'), {children: [marker, result]});
      }
      if (!React?.createElement || !React?.Fragment) return result;
      return React.createElement(
        React.Fragment,
        null,
        React.createElement('span', {
          'data-fbmd-player-video-id': id,
          style: {display: 'none'},
          'aria-hidden': true
        }),
        result
      );
    } catch {
      return result;
    }
  }

  function availableQualitySources(videoId) {
    const item = catalog.get(String(videoId));
    const choices = new Map();
    for (const source of item?.progressive || []) {
      if (!source?.url) continue;
      const height = Number(source.height) || Number(String(source.label || '').match(/(\d{3,4})p/i)?.[1]) || 0;
      const label = height ? height + 'p' : (/SD/i.test(source.label || '') ? 'SD' : 'HD');
      const key = 'direct:' + label.toUpperCase();
      const previous = choices.get(key);
      if (!previous || (Number(source.bitrate) || 0) > (Number(previous.source?.bitrate) || 0)) {
        choices.set(key, {label, score: height || (/HD/i.test(label) ? 720 : 360), source});
      }
    }
    const audio = [...(item?.audioTracks || [])].sort((a, b) =>
      (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0))[0];
    if (audio?.url) {
      for (const video of item?.videoTracks || []) {
        if (!video?.url) continue;
        const height = Number(video.height) || Number(String(video.label || '').match(/(\d{3,4})p/i)?.[1]) || 0;
        const label = height ? height + 'p' : String(video.label || 'DASH');
        const key = 'dash:' + label.toUpperCase();
        const previous = choices.get(key);
        if (!previous || (Number(video.bitrate) || 0) > (Number(previous.video?.bitrate) || 0)) {
          choices.set(key, {label, score: height || Number(video.bitrate) || 1, video, audio});
        }
      }
    }
    return [...choices.values()].sort((a, b) => b.score - a.score);
  }

  function postCaptionFromTrigger(trigger) {
    const root = trigger?.closest?.('[role="article"], article, [role="dialog"]') || trigger?.parentElement;
    if (!root) return '';
    const preferred = root.querySelector(
      '[data-ad-preview="message"], [data-ad-comet-preview="message"], ' +
      '[data-testid="post_message"], [data-ad-rendering-role="story_message"]'
    );
    const preferredText = String(preferred?.innerText || preferred?.textContent || '').trim();
    if (preferredText) return preferredText;
    const ignored = /^(?:like|comment|share|send|follow|download|ถูกใจ|แสดงความคิดเห็น|แชร์|ส่ง|ติดตาม|ดาวน์โหลด)$/i;
    return [...root.querySelectorAll('[dir="auto"]')]
      .map((node) => String(node.innerText || node.textContent || '').trim())
      .filter((text) => text.length >= 2 && text.length <= 500 && !ignored.test(text))
      .sort((a, b) => b.length - a.length)[0] || '';
  }

  function requestCatalogDownload(videoId, choice, caption) {
    window.postMessage({
      type: 'FBMD_EXACT_DOWNLOAD_MESSAGE',
      detail: {
        videoId: String(videoId),
        url: choice?.source?.url || '',
        video: choice?.video || null,
        audio: choice?.audio || null,
        label: choice?.label || choice?.source?.label || '',
        caption: String(caption || '')
      }
    }, '*');
  }

  function openQualityMenu(trigger, videoId, attempt = 0) {
    document.getElementById('fbmd-quality-menu')?.remove();
    const sources = availableQualitySources(videoId);
    const caption = postCaptionFromTrigger(trigger);
    const menu = document.createElement('div');
    menu.id = 'fbmd-quality-menu';
    menu.dataset.videoId = String(videoId);
    menu.__fbmdTrigger = trigger;
    Object.assign(menu.style, {
      position: 'fixed', zIndex: '2147483647', minWidth: '116px', padding: '6px',
      borderRadius: '9px', background: '#242526', boxShadow: '0 4px 16px rgba(0,0,0,.35)',
      color: '#fff', font: '600 13px Arial, sans-serif'
    });
    if (!sources.length) {
      const waiting = document.createElement('div');
      waiting.textContent = 'กำลังค้นหาคุณภาพ · ลองกดอีกครั้ง';
      Object.assign(waiting.style, {
        padding: '9px 10px', color: '#e4e6eb', fontWeight: '500', whiteSpace: 'nowrap'
      });
      menu.appendChild(waiting);
      scanRelayStore();
      scheduleEmit();
      window.postMessage({
        type: 'FBMD_EXACT_SOURCE_REQUEST', detail: {videoId: String(videoId)}
      }, '*');
      if (attempt < 8) {
        setTimeout(() => {
          if (menu.isConnected && trigger?.isConnected) openQualityMenu(trigger, videoId, attempt + 1);
        }, 250);
      }
    }
    for (const source of sources) {
      const option = document.createElement('button');
      option.type = 'button';
      option.textContent = 'ดาวน์โหลด ' + (source.label || 'วิดีโอ') +
        (source.video ? ' · รวมเสียง' : ' · พร้อมเสียง');
      Object.assign(option.style, {
        display: 'block', width: '100%', padding: '8px 10px', border: '0',
        borderRadius: '6px', background: 'transparent', color: '#fff',
        cursor: 'pointer', textAlign: 'left', whiteSpace: 'nowrap'
      });
      option.addEventListener('mouseenter', () => { option.style.background = '#3a3b3c'; });
      option.addEventListener('mouseleave', () => { option.style.background = 'transparent'; });
      option.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        menu.remove();
        requestCatalogDownload(videoId, source, caption);
      });
      menu.appendChild(option);
    }
    document.body.appendChild(menu);
    const rect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(innerWidth - menuRect.width - 8, rect.right - menuRect.width)) + 'px';
    menu.style.top = Math.max(8, rect.top - menuRect.height - 6) + 'px';
    const close = (event) => {
      if (event?.type === 'pointerdown' && (menu.contains(event.target) || trigger.contains(event.target))) return;
      menu.remove();
      document.removeEventListener('pointerdown', close, true);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close, true);
    };
    setTimeout(() => document.addEventListener('pointerdown', close, true), 0);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close, true);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.type !== 'FBMD_EXACT_SOURCE_RESPONSE') return;
    const detail = event.data.detail;
    const videoId = String(detail?.videoId || '');
    if (!videoId || !detail?.item) return;
    recordWithAliases(videoId, detail.item);
    const menu = document.getElementById('fbmd-quality-menu');
    if (menu?.dataset.videoId === videoId && menu.__fbmdTrigger?.isConnected) {
      openQualityMenu(menu.__fbmdTrigger, videoId, 8);
    }
  });

  function record(id, patch) {
    if (!id) return;
    const key = String(id);
    const existed = catalog.has(key);
    const item = catalog.get(key) || {
      videoId: key, progressive: [], videoTracks: [], audioTracks: [], updatedAt: 0
    };
    let changed = !existed;
    for (const field of ['progressive', 'videoTracks', 'audioTracks']) {
      for (const entry of patch[field] || []) {
        if (!entry?.url) continue;
        const list = item[field];
        const identity = cleanRange(entry.url);
        const oldIndex = list.findIndex((x) => cleanRange(x.url) === identity);
        if (oldIndex < 0) {
          list.push(entry);
          changed = true;
          continue;
        }
        const previous = list[oldIndex];
        const merged = {...previous, ...entry};
        if (Object.keys(entry).some((name) => previous[name] !== merged[name])) {
          list[oldIndex] = merged;
          changed = true;
        }
      }
    }
    if (!changed) return;
    item.updatedAt = Date.now();
    catalog.set(key, item);
    while (catalog.size > 120) catalog.delete(catalog.keys().next().value);
    scheduleEmit();
  }

  function recordWithAliases(id, patch) {
    record(id, patch);
    const aliases = new Set();
    for (const field of ['progressive', 'videoTracks', 'audioTracks']) {
      for (const entry of patch[field] || []) {
        const meta = decodeEfg(entry?.url || '');
        if (meta.video_id) aliases.add(String(meta.video_id));
        if (meta.xpv_asset_id) aliases.add('asset:' + String(meta.xpv_asset_id));
      }
    }
    aliases.delete(String(id));
    for (const alias of aliases) record(alias, patch);
  }

  function scheduleEmit() {
    clearTimeout(emitTimer);
    emitTimer = setTimeout(() => {
      const detail = {
        videos: [...catalog.values()].slice(-100),
        playerVideoIds: [...activePlayerVideoIds],
        diagnostics: {
          players: activePlayerVideoIds.size,
          relaySources: relaySources.size,
          catalog: catalog.size,
          directStore: Boolean(relaySourceProxy || window.__FBMD_RELAY_SOURCE__ || window.___rs)
        }
      };
      window.dispatchEvent(new CustomEvent('FBMD_METADATA', {detail}));
      window.postMessage({type: 'FBMD_METADATA_MESSAGE', detail: JSON.stringify(detail)}, '*');
    }, 120);
  }

  function decodeEfg(rawUrl) {
    try {
      const encoded = new URL(rawUrl).searchParams.get('efg');
      if (!encoded) return {};
      const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
      const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return {};
    }
  }

  function cleanRange(rawUrl) {
    try {
      const url = new URL(rawUrl);
      url.searchParams.delete('bytestart');
      url.searchParams.delete('byteend');
      return url.href;
    } catch {
      return rawUrl;
    }
  }

  function scanRelayStore() {
    const source = relaySourceProxy || window.__FBMD_RELAY_SOURCE__ || window.___rs;
    rememberRelaySource(source);
    rememberRelaySource(window.__FBMD_RELAY_SOURCE__);
    rememberRelaySource(window.___rs);

    for (const currentSource of relaySources) {
      if (!currentSource) continue;
      scanRelayPlayableRecords(currentSource);
      if (typeof currentSource.get !== 'function') continue;

      for (const id of new Set([...activePlayerVideoIds, ...collectRelayVideoIds()])) {
        const videoRecord = getRelayVideoRecord(currentSource, id);
        if (!videoRecord) continue;

        recordRelayVideo(id, videoRecord);
      }
    }
  }

  function rememberRelaySource(source) {
    if (!source || typeof source !== 'object') return;
    if (typeof source.get === 'function' || relayRawRecords(source)) relaySources.add(source);
    const nested = source._recordSource || source.__recordSource || source.source || source.__source;
    if (nested && nested !== source && (typeof nested.get === 'function' || relayRawRecords(nested))) {
      relaySources.add(nested);
    }
  }

  function recordRelayVideo(id, videoRecord) {
    const progressive = [];
    const sd = relayValue(videoRecord, 'playable_url');
    const hd = relayValue(videoRecord, 'playable_url', {quality: 'HD'});
    if (/^https?:/i.test(sd || '')) {
      progressive.push({url: sd, withSound: true, label: 'SD', source: 'relay',
        duration: durationFromUrl(sd)});
    }
    if (/^https?:/i.test(hd || '')) {
      progressive.push({url: hd, withSound: true, label: 'HD', source: 'relay',
        duration: durationFromUrl(hd)});
    }
    progressive.push(...extractProgressiveFields(videoRecord));

    let manifest = relayValue(videoRecord, 'playlist', {scrubbing_preference: 'MPEG_DASH'});
    const request = {
      video_delivery_request: {
        dash_manifest_requests: [{}],
        dash_manifest_url_requests: [{}],
        hls_playlist_url_requests: [{}],
        progressive_url_requests: [{quality: 'SD'}, {quality: 'HD'}]
      }
    };
    const delivery = relayLinked(videoRecord, 'video_delivery_response', request);
    if (!manifest && delivery) {
      const manifests = relayLinkedMany(delivery, 'dash_manifests');
      manifest = relayValue(manifests?.[0], 'manifest_xml');
    }

    if (delivery) {
      for (const item of relayLinkedMany(delivery, 'progressive_urls') || []) {
        const metadata = relayLinked(item, 'metadata');
        const quality = String(relayValue(metadata, 'quality') || 'SD').toUpperCase();
        const url = relayValue(item, 'progressive_url');
        if (/^https?:/i.test(url || '')) {
          progressive.push({url, withSound: true, label: quality, source: 'relay-delivery',
            duration: durationFromUrl(url)});
        }
      }
    }

    const parsed = typeof manifest === 'string' ? parseManifest(manifest) :
      {videoTracks: [], audioTracks: []};
    if (progressive.length || parsed.videoTracks.length || parsed.audioTracks.length) {
      recordWithAliases(id, {
        progressive,
        videoTracks: parsed.videoTracks,
        audioTracks: parsed.audioTracks
      });
    }
  }
  function getRelayVideoRecord(source, id) {
    const candidates = [
      id,
      'Video:' + id,
      'CometVideo:' + id,
      'Story:' + id,
      'SVDVideo:' + id,
      'video:' + id
    ];
    const fallback = [];
    for (const key of candidates) {
      try {
        const record = source.get(key);
        if (hasRelayPlayableUrl(record)) return record;
        if (isRelayVideoRecord(record)) fallback.push(record);
      } catch {}
    }

    for (const record of scanRelayRecords(source, id)) {
      if (hasRelayPlayableUrl(record)) return record;
      if (isRelayVideoRecord(record)) fallback.push(record);
    }
    return fallback[0] || null;
  }

  function hasRelayPlayableUrl(record) {
    if (!record) return false;
    const sd = relayValue(record, 'playable_url');
    const hd = relayValue(record, 'playable_url', {quality: 'HD'});
    return /^https?:/i.test(sd || '') || /^https?:/i.test(hd || '');
  }

  function isRelayVideoRecord(record) {
    if (!record) return false;
    if (hasRelayPlayableUrl(record)) return true;
    const manifest = relayValue(record, 'playlist', {scrubbing_preference: 'MPEG_DASH'});
    return typeof manifest === 'string' && /<MPD|<AdaptationSet|<Representation/i.test(manifest);
  }

  function scanRelayRecords(source, id) {
    const output = [];
    const raw = relayRawRecords(source);
    if (raw instanceof Map) {
      for (const [key, record] of raw) {
        if (String(key).includes(id) || relayRecordHasId(record, id)) output.push(record);
        if (output.length >= 12) break;
      }
      return output;
    }
    if (raw && typeof raw === 'object') {
      for (const key of Object.keys(raw)) {
        if (String(key).includes(id) || relayRecordHasId(raw[key], id)) output.push(raw[key]);
        if (output.length >= 12) break;
      }
    }
    return output;
  }

  function scanRelayPlayableRecords(source) {
    const raw = relayRawRecords(source);
    if (!raw) return;
    let count = 0;
    const visit = (key, record) => {
      if (count >= 80 || !hasRelayPlayableUrl(record)) return;
      const id = relayRecordId(record) || String(key || '');
      if (!id) return;
      count++;
      recordRelayVideo(id, record);
    };
    if (raw instanceof Map) {
      for (const [key, record] of raw) visit(key, record);
      return;
    }
    if (typeof raw === 'object') {
      for (const key of Object.keys(raw)) visit(key, raw[key]);
    }
  }

  function relayRawRecords(source) {
    return source.__recordMap || source._records || source.records || source.__records ||
      source._recordSource?._records || source.__recordSource?._records;
  }

  function relayRecordId(record) {
    try {
      const id = relayValue(record, 'id') || relayValue(record, 'video_id');
      if (id) return String(id);
    } catch {}
    return '';
  }

  function relayRecordHasId(record, id) {
    try {
      return relayRecordId(record).includes(id);
    } catch {
      return false;
    }
  }
  function relayValue(record, field, args) {
    try {
      if (typeof record?.getValue === 'function') return record.getValue(field, args);
    } catch {}
    try {
      if (!record || typeof record !== 'object') return undefined;
      if (args) {
        const exact = field + '(' + JSON.stringify(args) + ')';
        if (record[exact] !== undefined) return record[exact];
        const prefix = field + '(';
        const key = Object.keys(record).find((name) => name.startsWith(prefix));
        if (key) return record[key];
      }
      if (record[field] !== undefined) return record[field];
      if (record.__data && record.__data[field] !== undefined) return record.__data[field];
    } catch {}
    return undefined;
  }

  function extractProgressiveFields(value, seen = new Set()) {
    const output = [];
    if (!value || typeof value !== 'object' || seen.has(value)) return output;
    seen.add(value);
    const directFields = [
      ['playable_url_quality_hd', 'HD'],
      ['browser_native_hd_url', 'HD'],
      ['hd_src', 'HD'],
      ['hdSrc', 'HD'],
      ['playable_url', 'SD'],
      ['browser_native_sd_url', 'SD'],
      ['sd_src', 'SD'],
      ['sdSrc', 'SD'],
      ['progressive_url', 'HD']
    ];
    for (const [field, label] of directFields) {
      const url = value[field] || value.__data?.[field];
      if (/^https?:/i.test(url || '')) {
        output.push({url, withSound: true, label, source: 'relay-fields',
          duration: durationFromUrl(url)});
      }
    }
    for (const key of Object.keys(value)) {
      const child = value[key];
      if (typeof child === 'string') {
        const lowerKey = key.toLowerCase();
        if (/^https?:/i.test(child) && /playable|progressive|browser_native|hd_src|sd_src|hdsrc|sdsrc/i.test(key)) {
          output.push({
            url: child,
            withSound: true,
            label: /hd|quality.*hd|720|1080/i.test(lowerKey + child) ? 'HD' : 'SD',
            source: 'relay-fields',
            duration: durationFromUrl(child)
          });
        }
      } else if (child && typeof child === 'object' && output.length < 40) {
        output.push(...extractProgressiveFields(child, seen));
      }
    }
    return output;
  }

  function relayLinked(record, field, args) {
    try { return record?.getLinkedRecord?.(field, args); } catch { return undefined; }
  }

  function relayLinkedMany(record, field, args) {
    try { return record?.getLinkedRecords?.(field, args); } catch { return undefined; }
  }

  function collectRelayVideoIds() {
    const ids = new Set([...catalog.keys()].filter((id) => /^\d{8,}$/.test(id)));
    for (const node of document.querySelectorAll(
      '[data-video-id], [data-videoid], [data-ft], [data-store], a[href*="/videos/"], a[href*="/reel/"], a[href*="/watch"], a[href*="?v="], video'
    )) {
      const direct = node.getAttribute?.('data-video-id') || node.getAttribute?.('data-videoid');
      const directMatch = String(direct || '').match(/\d{8,}/);
      if (directMatch) ids.add(directMatch[0]);
      for (const value of [
        node.getAttribute?.('href'),
        node.getAttribute?.('data-ft'),
        node.getAttribute?.('data-store'),
        node.currentSrc,
        node.src
      ]) {
        collectIdsFromText(value, ids);
      }
    }
    return [...ids].slice(-150);
  }

  function collectIdsFromText(value, ids) {
    if (!value) return;
    const text = String(value);
    try {
      const url = new URL(text, location.href);
      const queryId = url.searchParams.get('v') || url.searchParams.get('video_id');
      const pathId = url.pathname.match(/\/(?:videos|reel|watch)\/?(\d{8,})?/i)?.[1];
      if (/^\d{8,}$/.test(queryId || '')) ids.add(queryId);
      if (/^\d{8,}$/.test(pathId || '')) ids.add(pathId);
      const meta = decodeEfg(url.href);
      if (meta.video_id) ids.add(String(meta.video_id));
    } catch {}
    for (const match of text.matchAll(/(?:video_id|videoID|videoId|top_level_post_id|mf_story_key)["'=:\s]+(\d{8,})/gi)) {
      ids.add(match[1]);
    }
    for (const match of text.matchAll(/\b(?:videos|reel|watch)\/?(?:\?v=)?(\d{8,})\b/gi)) {
      ids.add(match[1]);
    }
  }

  function scanPerformance(entries) {
    if (!CAPTURE_MEDIA_PERFORMANCE) return;
    const grouped = new Map();
    for (const entry of entries) {
      if (!/\.fbcdn\.net/i.test(entry.name)) continue;
      const meta = decodeEfg(entry.name);
      const tag = String(meta.vencode_tag || '');
      if (!/\.mp4(?:\?|$)/i.test(entry.name) && !tag && !meta.video_id && !meta.xpv_asset_id) continue;
      const id = meta.video_id || (meta.xpv_asset_id ? 'asset:' + meta.xpv_asset_id : 'performance');
      const item = grouped.get(String(id)) || {progressive: [], videoTracks: [], audioTracks: []};
      const common = {
        url: cleanRange(entry.name),
        bitrate: Number(meta.bitrate) || 0,
        duration: Number(meta.duration_s) || 0,
        codec: tag
      };
      if (/progressive/i.test(tag)) {
        item.progressive.push({...common, withSound: true, label: qualityLabel(tag, meta.bitrate)});
      } else if (/audio/i.test(tag)) {
        item.audioTracks.push({...common, type: 'audio', label: 'audio'});
      } else if (/dash_/i.test(tag)) {
        item.videoTracks.push({...common, type: 'video', label: qualityLabel(tag, meta.bitrate),
          height: heightFromText(tag)});
      } else {
        item.progressive.push({...common, withSound: true, label: qualityLabel(tag, meta.bitrate)});
      }
      grouped.set(String(id), item);
    }
    for (const [id, patch] of grouped) recordWithAliases(id, patch);
  }

  function scanBufferedPerformance() {
    const entries = performance.getEntriesByType('resource');
    if (entries.length < performanceCursor) performanceCursor = 0;
    if (entries.length === performanceCursor) return;
    const fresh = entries.slice(performanceCursor);
    performanceCursor = entries.length;
    scanPerformance(fresh);
  }

  function heightFromText(text) {
    const match = String(text).match(/(?:_|\b)(\d{3,4})p(?:_|\b)/i);
    return match ? Number(match[1]) : 0;
  }

  function qualityLabel(text, bitrate) {
    const height = heightFromText(text);
    if (height) return height + 'p';
    if (bitrate) return Math.round(Number(bitrate) / 1000) + ' kbps';
    return /hd/i.test(text) ? 'HD' : /sd/i.test(text) ? 'SD' : 'Video';
  }

  function parseResponseText(text) {
    if (!CAPTURE_PAGE_RESPONSES) return;
    if (!text || text.length > 20_000_000) return;
    const cleaned = text.replace(/^for\s*\(;;\);?/, '');
    const candidates = [cleaned, ...cleaned.split(/\r?\n/)].filter(Boolean);
    for (const candidate of candidates) {
      try {
        walk(JSON.parse(candidate), '');
      } catch {}
    }
    extractLooseResponse(text);
  }

  function scanPageDataScripts() {
    if (!CAPTURE_PAGE_RESPONSES) return;
    let scanned = 0;
    for (const script of document.querySelectorAll('script')) {
      const text = script.textContent || '';
      if (!text || text.length > 5_000_000) continue;
      if (!/playable_url|playable_url_quality_hd|browser_native_(?:sd|hd)_url|video_delivery_response|manifest_xml/i.test(text)) {
        continue;
      }
      scanned++;
      parseResponseText(text);
      if (scanned >= 25) break;
    }
  }

  function extractLooseResponse(text) {
    const idMatch = text.match(/["'](?:video_id|videoId)["']\s*:\s*["']?(\d{8,})/i);
    const id = idMatch?.[1] || 'response:' + (++looseSequence);
    const progressive = [];
    const directPattern = /["'](?:playable_url(?:_quality_hd)?|browser_native_(?:sd|hd)_url|progressive_url|hd_src|sd_src|hdSrc|sdSrc)["']\s*:\s*["']((?:\\.|[^"'])+)["']/gi;
    for (const match of text.matchAll(directPattern)) {
      const url = decodeJsonString(match[1]);
      if (/^https?:/i.test(url)) progressive.push({
        url,
        withSound: true,
        label: inferProgressiveLabel(match[0], url, text.slice(match.index || 0, (match.index || 0) + 1500)),
        duration: durationFromUrl(url)
      });
    }
    const videoTracks = [];
    const audioTracks = [];
    const manifestPattern = /["'](?:manifest_xml|dash_manifest|playlist)["']\s*:\s*["']((?:\\.|[^"'])+)["']/gi;
    for (const match of text.matchAll(manifestPattern)) {
      const manifest = decodeJsonString(match[1]);
      if (!/<MPD|<AdaptationSet|<Representation/i.test(manifest)) continue;
      const parsed = parseManifest(manifest);
      videoTracks.push(...parsed.videoTracks);
      audioTracks.push(...parsed.audioTracks);
    }
    if (progressive.length || videoTracks.length || audioTracks.length) {
      recordWithAliases(id, {progressive, videoTracks, audioTracks});
    }
  }

  function decodeJsonString(value) {
    try { return JSON.parse('"' + value.replace(/"/g, '\\"') + '"'); }
    catch {
      return value.replace(/\\\//g, '/').replace(/\\u0025/gi, '%').replace(/\\u0026/gi, '&');
    }
  }

  function durationFromUrl(url) {
    const meta = decodeEfg(url);
    return Number(meta.duration_s || meta.duration || 0) || 0;
  }

  function inferProgressiveLabel(sourceText, url, context = '') {
    const text = String(sourceText || '') + ' ' + String(context || '');
    const quality = text.match(/["']quality["']\s*:\s*["'](HD|SD)["']/i)?.[1];
    if (quality) return quality.toUpperCase();
    if (/(?:quality_hd|native_hd|browser_native_hd|hd_src|hdSrc|sve_hd)/i.test(text)) return 'HD';
    if (/(?:native_sd|browser_native_sd|sd_src|sdSrc|sve_sd)/i.test(text)) return 'SD';
    try {
      const parsed = new URL(url);
      const tag = parsed.searchParams.get('tag') || '';
      const meta = decodeEfg(url);
      const encoded = String(meta.vencode_tag || tag);
      const height = heightFromText(encoded) || heightFromText(tag);
      if (height >= 720) return 'HD';
      if (height > 0) return 'SD';
      if (/sve_hd|progressive.*720|C3\.720/i.test(encoded)) return 'HD';
      if (/sve_sd|progressive.*360|C3\.360/i.test(encoded)) return 'SD';
    } catch {}
    return 'SD';
  }

  function walk(value, inheritedId) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const child of value) walk(child, inheritedId);
      return;
    }

    let id = inheritedId;
    const typename = String(value.__typename || value.typename || '');
    if (value.video_id) id = String(value.video_id);
    else if (value.videoId) id = String(value.videoId);
    else if (/video/i.test(typename) && /^\d{8,}$/.test(String(value.id || ''))) id = String(value.id);

    const progressive = [];
    const videoTracks = [];
    const audioTracks = [];

    const directFields = [
      ['playable_url', 'SD'],
      ['playable_url_quality_hd', 'HD'],
      ['browser_native_sd_url', 'SD'],
      ['browser_native_hd_url', 'HD'],
      ['hd_src', 'HD'],
      ['sd_src', 'SD'],
      ['hdSrc', 'HD'],
      ['sdSrc', 'SD'],
      ['progressive_url', value.metadata?.quality || value.quality || 'HD']
    ];
    for (const [field, label] of directFields) {
      if (typeof value[field] === 'string' && /^https?:/i.test(value[field])) {
        progressive.push({url: value[field], withSound: true, label: String(label).toUpperCase()});
      }
    }

    const manifest = value.manifest_xml || value.dash_manifest || value.playlist;
    if (typeof manifest === 'string' && /<MPD|<AdaptationSet|<Representation/i.test(manifest)) {
      const parsed = parseManifest(manifest);
      videoTracks.push(...parsed.videoTracks);
      audioTracks.push(...parsed.audioTracks);
    }

    if (id && (progressive.length || videoTracks.length || audioTracks.length)) {
      recordWithAliases(id, {progressive, videoTracks, audioTracks});
    }

    for (const child of Object.values(value)) walk(child, id);
  }

  function parseManifest(xmlText) {
    const result = {videoTracks: [], audioTracks: []};
    try {
      const xml = new DOMParser().parseFromString(xmlText, 'application/xml');
      const manifestDuration = isoDurationSeconds(xml.querySelector('MPD')?.getAttribute('mediaPresentationDuration') || '');
      for (const adaptation of xml.querySelectorAll('AdaptationSet')) {
        const adaptationMime = adaptation.getAttribute('mimeType') || '';
        const contentType = adaptation.getAttribute('contentType') || '';
        for (const rep of adaptation.querySelectorAll(':scope > Representation')) {
          const base = rep.querySelector(':scope > BaseURL')?.textContent?.trim();
          if (!base) continue;
          const mime = rep.getAttribute('mimeType') || adaptationMime;
          const type = /audio/i.test(mime + contentType) ? 'audio' : 'video';
          const common = {
            url: base,
            bandwidth: Number(rep.getAttribute('bandwidth')) || 0,
            bitrate: Number(rep.getAttribute('bandwidth')) || 0,
            codec: rep.getAttribute('codecs') || rep.getAttribute('FBEncodingTag') || '',
            height: Number(rep.getAttribute('height')) || 0,
            width: Number(rep.getAttribute('width')) || 0,
            duration: manifestDuration
          };
          if (type === 'audio') result.audioTracks.push({...common, type, label: 'Audio'});
          else result.videoTracks.push({...common, type,
            label: common.height ? common.height + 'p' : qualityLabel(common.codec, common.bitrate)});
        }
      }
    } catch {}
    return result;
  }

  function isoDurationSeconds(value) {
    const match = String(value || '').match(/PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?/i);
    if (!match) return 0;
    return (Number(match[1]) || 0) * 3600 + (Number(match[2]) || 0) * 60 + (Number(match[3]) || 0);
  }

  const nativeFetch = window.fetch;
  window.fetch = async function(...args) {
    const response = await nativeFetch.apply(this, args);
    try {
      const url = String(args[0]?.url || args[0] || '');
      if (isFacebookDataRequest(url)) {
        response.clone().text().then(parseResponseText).catch(() => {});
      }
    } catch {}
    return response;
  };

  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__fbmdUrl = String(url);
    return nativeOpen.call(this, method, url, ...rest);
  };
  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(...args) {
    if (isFacebookDataRequest(this.__fbmdUrl || '')) {
      this.addEventListener('load', () => {
        try { if (typeof this.responseText === 'string') parseResponseText(this.responseText); } catch {}
      }, {once: true});
    }
    return nativeSend.apply(this, args);
  };

  function isFacebookDataRequest(rawUrl) {
    try {
      const url = new URL(String(rawUrl || ''), location.href);
      if (!/(^|\.)facebook\.com$/i.test(url.hostname)) return false;
      return /^\/(?:api\/graphql|ajax\/|graphql\/|api\/)/i.test(url.pathname);
    } catch {
      return /^\/(?:api\/graphql|ajax\/|graphql\/|api\/)/i.test(String(rawUrl || ''));
    }
  }

  window.addEventListener('FBMD_REQUEST_SNAPSHOT', () => {
    scanVideoReactFibers();
    scanPageDataScripts();
    scanRelayStore();
    scheduleEmit();
  });

  scanPageDataScripts();
  scanVideoReactFibers();
  scanRelayStore();
  setInterval(() => {
    scanVideoReactFibers();
    scanRelayStore();
  }, 1000);
  if (CAPTURE_MEDIA_PERFORMANCE) {
    scanBufferedPerformance();
    try {
      performanceObserver = new PerformanceObserver((list) => scanPerformance(list.getEntries()));
      performanceObserver.observe({type: 'resource', buffered: true});
    } catch {
      setInterval(scanBufferedPerformance, 10000);
    }
  }
})();
