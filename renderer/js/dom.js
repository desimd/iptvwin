// Small UI toolkit shared by every screen (no framework): element builder, icons, toast,
// progress bar, modal dialogs, context menu, and the Java-compatible hash the Android app used
// for brand colours (so each channel keeps the same colour it had on the TV).
(function () {
  'use strict';

  const api = (name, ...args) => window.api.call(name, ...args);

  // h('div', {class:'x', onclick: fn, data:{i:1}}, 'text', childEl, ...)
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; } }
      else if (k === 'data') for (const [dk, dv] of Object.entries(v)) el.dataset[dk] = dv;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const ICONS = {
    search: 'M15.5 14h-.8l-.3-.3A6.5 6.5 0 1 0 14 15.5l.3.3v.8l5 5 1.5-1.5-5-5zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z',
    manage: 'M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z',
    reorder: 'M3 15h18v-2H3v2zm0 4h18v-2H3v2zm0-8h18V9H3v2zm0-6v2h18V5H3z',
    check: 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z',
    refresh: 'M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
    gear: 'M19.4 13a7.8 7.8 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.6 7.6 0 0 0-1.7-1L15 3h-4l-.4 2.9a7.6 7.6 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.8 7.8 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.7 1.7 1L11 21h4l.4-2.9c.6-.3 1.2-.6 1.7-1l2.5 1 2-3.5L19.4 13zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z',
    back: 'M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z',
    ball: 'M12 2a10 10 0 1 1 0 20 10 10 0 1 1 0-20zm0 2a8 8 0 1 0 0 16 8 8 0 1 0 0-16zM12 8.8l3.04 2.21-1.16 3.58h-3.76l-1.16-3.58z',
    layers: 'M11.99 18.54l-7.37-5.73L3 14.07l9 7 9-7-1.63-1.27-7.38 5.74zM12 16l7.36-5.73L21 9l-9-7-9 7 1.63 1.27L12 16z',
    backup: 'M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z',
    play: 'M8 5v14l11-7z',
    pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
    fullscreen: 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z',
    volume: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4z',
    mute: 'M16.5 12A4.5 4.5 0 0 0 14 8v2.2l2.5 2.5V12zM19 12a6.9 6.9 0 0 1-.6 2.8l1.5 1.5A8.9 8.9 0 0 0 21 12a9 9 0 0 0-7-8.8v2.1a7 7 0 0 1 5 6.7zM4.3 3 3 4.3 7.7 9H3v6h4l5 5v-6.7l4.3 4.3c-.7.5-1.4.9-2.3 1.2v2.1a9 9 0 0 0 3.6-1.8l2 2 1.3-1.3L4.3 3zM12 4 9.9 6.1 12 8.2V4z'
  };
  function icon(name) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', ICONS[name]);
    s.append(p);
    return s;
  }
  const ibtn = (name, title, onclick, extra) => h('button', Object.assign({ class: 'ibtn', title, 'aria-label': title, onclick }, extra), icon(name));

  // ---- toast / progress ----
  function toast(msg, ms = 2600) {
    const box = document.getElementById('toast');
    const t = h('div', { text: msg });
    box.append(t);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => t.remove(), ms);
  }
  let busy = 0;
  function progress(on) {
    busy = Math.max(0, busy + (on ? 1 : -1));
    document.getElementById('progress').classList.toggle('on', busy > 0);
  }
  // Runs fn with the progress bar on; shows an error toast (with prefix) on failure and returns undefined.
  async function withProgress(fn, errPrefix) {
    progress(true);
    try { return await fn(); }
    catch (e) { toast((errPrefix || '') + (e && e.message ? e.message : e), 4500); }
    finally { progress(false); }
  }

  // ---- modal dialogs ----
  const modals = [];
  const modalOpen = () => modals.length > 0;

  function dialog({ title, body, buttons, onClose, wide }) {
    const prevFocus = document.activeElement;
    const dlg = h('div', { class: 'dlg', role: 'dialog', style: wide ? { maxWidth: 'min(760px,92vw)' } : null },
      title ? h('h3', { text: title }) : null, body,
      buttons && buttons.length ? h('div', { class: 'acts' }, buttons.map((b) => h('button', {
        class: 'btn' + (b.primary ? ' primary' : ''), text: b.label,
        onclick: () => { if (b.onClick) b.onClick(); if (b.close !== false) close(); }
      }))) : null);
    const scrim = h('div', { class: 'scrim', onmousedown: (e) => { if (e.target === scrim) close(); } }, dlg);
    let closed = false;
    function close(result) {
      if (closed) return;
      closed = true;
      const i = modals.indexOf(api_);
      if (i >= 0) modals.splice(i, 1);
      scrim.remove();
      if (prevFocus && prevFocus.focus && document.contains(prevFocus)) prevFocus.focus({ preventScroll: true });
      if (onClose) onClose(result);
    }
    const api_ = { close };
    scrim.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const items = [...dlg.querySelectorAll('.item, .btn, .seg button, input')];
        if (e.target.matches('input[type=text],input[type=password],input:not([type])')) return;
        const i = items.indexOf(document.activeElement);
        if (items.length && !e.target.closest('.seg')) {
          e.preventDefault();
          items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
        }
      }
    });
    document.getElementById('overlay-root').append(scrim);
    modals.push(api_);
    const first = dlg.querySelector('.item.cur, .item, .btn.primary, .btn, input');
    if (first) first.focus({ preventScroll: true });
    return api_;
  }

  // Single choice from a list -> Promise<index | null>
  function choose(title, labels, current) {
    return new Promise((resolve) => {
      let picked = null;
      const body = h('div', null, labels.map((l, i) => h('button', {
        class: 'item' + (i === current ? ' cur' : ''), text: l,
        onclick: () => { picked = i; d.close(); }
      })));
      const d = dialog({ title, body, onClose: () => resolve(picked) });
    });
  }

  function confirmDialog(title, message, okLabel) {
    return new Promise((resolve) => {
      let ok = false;
      dialog({
        title, body: h('div', { class: 'msg', text: message }),
        buttons: [{ label: 'Cancel' }, { label: okLabel || 'OK', primary: true, onClick: () => { ok = true; } }],
        onClose: () => resolve(ok)
      });
    });
  }

  // Segmented control; onPick(value) is called on change.
  function segmented(options, current, onPick) {
    const seg = h('div', { class: 'seg' });
    options.forEach(([value, label]) => {
      const b = h('button', {
        class: value === current ? 'on' : '', text: label,
        onclick: () => { seg.querySelectorAll('button').forEach((x) => x.classList.remove('on')); b.classList.add('on'); onPick(value); }
      });
      seg.append(b);
    });
    return seg;
  }

  // ---- context menu ----
  let ctxEl = null;
  function closeMenu() { if (ctxEl) { ctxEl.remove(); ctxEl = null; } }
  function contextMenu(items, x, y) {
    closeMenu();
    const prev = document.activeElement;
    ctxEl = h('div', { class: 'ctx' }, items.map((it) => h('button', {
      text: it.label,
      onclick: () => { closeMenu(); if (prev && prev.focus) prev.focus({ preventScroll: true }); it.onClick(); }
    })));
    document.getElementById('overlay-root').append(ctxEl);
    const r = ctxEl.getBoundingClientRect();
    ctxEl.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
    ctxEl.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
    ctxEl.firstChild.focus();
    ctxEl.addEventListener('keydown', (e) => {
      const bs = [...ctxEl.children], i = bs.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); bs[(i + 1) % bs.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); bs[(i - 1 + bs.length) % bs.length].focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); if (prev && prev.focus) prev.focus({ preventScroll: true }); }
    });
  }
  document.addEventListener('mousedown', (e) => { if (ctxEl && !ctxEl.contains(e.target)) closeMenu(); }, true);
  window.addEventListener('blur', closeMenu);

  // Java String.hashCode, so brand hues match the Android app exactly.
  function javaHash(s) {
    let x = 0;
    for (let i = 0; i < s.length; i++) x = (Math.imul(31, x) + s.charCodeAt(i)) | 0;
    return x;
  }
  const hueOf = (s) => (javaHash(s) & 0x7fffffff) % 360;

  // Arrow-key movement between cards in a plain (non-virtual) grid / list: nearest in that direction.
  function geoNav(scope, selector, key) {
    const cur = document.activeElement && document.activeElement.closest(selector);
    const items = [...scope.querySelectorAll(selector)].filter((e) => e.offsetParent !== null);
    if (!items.length) return false;
    if (!cur || !scope.contains(cur)) { items[0].focus(); return true; }
    const a = cur.getBoundingClientRect(), ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    let best = null, bestScore = Infinity;
    for (const el of items) {
      if (el === cur) continue;
      const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2, dx = cx - ax, dy = cy - ay;
      let ok, score;
      if (key === 'ArrowDown') { ok = dy > 8; score = dy + 2 * Math.abs(dx); }
      else if (key === 'ArrowUp') { ok = dy < -8; score = -dy + 2 * Math.abs(dx); }
      else if (key === 'ArrowRight') { ok = dx > 8 && Math.abs(dy) < a.height * 0.6; score = dx + 2 * Math.abs(dy); }
      else { ok = dx < -8 && Math.abs(dy) < a.height * 0.6; score = -dx + 2 * Math.abs(dy); }
      if (ok && score < bestScore) { best = el; bestScore = score; }
    }
    if (best) { best.focus(); best.scrollIntoView({ block: 'nearest' }); return true; }
    return false;
  }

  const isTyping = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && !['range', 'button', 'checkbox', 'radio'].includes(t.type);

  window.UI = { api, h, icon, ibtn, toast, progress, withProgress, dialog, choose, confirmDialog, segmented, contextMenu, closeMenu, modalOpen, javaHash, hueOf, geoNav, isTyping };
})();
