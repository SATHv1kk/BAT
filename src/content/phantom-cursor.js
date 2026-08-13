// Phantom cursor overlay — listens for UPDATE_PHANTOM_CURSOR from the agent.
(function () {
  if (window !== window.top) return;

  let cursor = null;
  let hideTimer = null;

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'UPDATE_PHANTOM_CURSOR') return;
    // Coordinates come straight from a message a page could spoof, and NaN /
    // strings / Infinity would end up verbatim inside a CSS transform. Clamp to
    // finite numbers before anything touches the DOM.
    const x = Number.isFinite(msg.x) ? Math.max(0, Math.round(msg.x)) : 0;
    const y = Number.isFinite(msg.y) ? Math.max(0, Math.round(msg.y)) : 0;
    const action = msg.action || 'move';

    if (action === 'hide') {
      cursor?.remove();
      cursor = null;
      return;
    }

    if (!cursor) {
      // run_at is document_idle, but a manually injected copy may fire before
      // <body> exists — never assume it.
      if (!document.body) return;
      cursor = document.createElement('div');
      cursor.id = 'bat-phantom-cursor';
      cursor.setAttribute('aria-hidden', 'true');
      cursor.style.cssText =
        'position:fixed;top:0;left:0;pointer-events:none;z-index:2147483646;' +
        'transform:translate3d(' + x + 'px,' + y + 'px,0);' +
        'transition:transform 180ms cubic-bezier(0.2,0,0,1);will-change:transform;';
      cursor.innerHTML =
        '<svg width="20" height="26" viewBox="0 0 20 26" style="overflow:visible;display:block">' +
          '<path d="M0 0 L0 18 L4.5 14 L7.5 21.5 L11 20 L8 13 L14 13 Z" stroke="white" stroke-width="3" fill="white"/>' +
          '<path d="M0 0 L0 18 L4.5 14 L7.5 21.5 L11 20 L8 13 L14 13 Z" fill="#d97757"/>' +
        '</svg>';
      document.body.appendChild(cursor);
    } else {
      cursor.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
    }

    if (action === 'click') {
      setTimeout(() => {
        if (!cursor) return;
        cursor.style.transform = 'translate3d(' + (x - 1) + 'px,' + (y - 1) + 'px,0) scale(0.88)';
        setTimeout(() => {
          if (cursor) cursor.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0) scale(1)';
        }, 80);
      }, 40);
    }

    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (cursor) {
        cursor.style.opacity = '0';
        setTimeout(() => { cursor?.remove(); cursor = null; }, 200);
      }
    }, 1200);
  });
})();