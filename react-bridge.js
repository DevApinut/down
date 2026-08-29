(() => {
  if (window.__FBMD_REACT_BRIDGE__) return;
  window.__FBMD_REACT_BRIDGE__ = true;

  const hookKey = 'VideoPlayerRelay.react|facebook-multi-downloader';

  function requestDownload(videoId) {
    try {
      const hd = window.___sf?.(videoId, 'playable_url{$1}', {$1: {quality: 'HD'}});
      const sd = window.___sf?.(videoId, 'playable_url');
      const url = /^https?:/i.test(hd || '') ? hd : /^https?:/i.test(sd || '') ? sd : '';
      window.postMessage({
        type: 'FBMD_EXACT_DOWNLOAD_MESSAGE',
        detail: {videoId, url, label: url === hd ? 'HD' : url === sd ? 'SD' : ''}
      }, '*');
    } catch {}
  }

  function DownloadControl({videoId}) {
    try {
      const React = window.require('react');
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
        onClick(event) {
          event.stopPropagation();
          event.preventDefault();
          requestDownload(videoId);
        },
        children: '⇩'
      };
      return typeof React.jsx === 'function'
        ? React.jsx('button', props)
        : React.createElement('button', props, '⇩');
    } catch {
      return null;
    }
  }

  function install() {
    if (typeof window.___pt !== 'function' || typeof window.___km !== 'function' ||
        typeof window.require !== 'function') return false;
    try {
      window.___pt(hookKey);
      window.___km(hookKey, (context) => {
        const raw = context?.payload?.video?.__id;
        const videoId = String(raw || '').replace(/^(?:Video|CometVideo|SVDVideo):/i, '');
        if (!videoId) return context.lastCmp;
        const React = window.require('react');
        const control = typeof React.jsx === 'function'
          ? React.jsx(DownloadControl, {videoId})
          : React.createElement(DownloadControl, {videoId});
        return [control, context.lastCmp];
      });
      return true;
    } catch {
      return false;
    }
  }

  if (!install()) {
    const timer = setInterval(() => {
      if (install()) clearInterval(timer);
    }, 50);
    setTimeout(() => clearInterval(timer), 15000);
  }
})();
