// Player (port of PlayerActivity). Video goes: stream -> local proxy -> mpegts.js (live MPEG-TS) or
// hls.js (.m3u8) or the plain <video> (mp4/webm) -> <video>. Up/Down surf channels, Left = channel
// list panel, Right = EZ List panel, Enter = control bar, Esc = back (panels -> bar -> fullscreen -> leave).
(function () {
  'use strict';
  const { h, api, ibtn, icon, toast, choose } = window.UI;

  // ---- tunables (same values as the Android app where one existed) ----
  const BAR_HIDE_MS = 4000;
  const EZ_AUTO_CLOSE_MS = 30000;
  const IDLE_STOP_MS = 120 * 60 * 1000;   // no input at all for 2h -> stop (someone fell asleep)
  const MAX_RETRIES = 3;
  const RETRY_MS = 2000;
  const START_TIMEOUT_MS = 20000;         // nothing playing after this -> treat as an error and retry
  const SWITCH_DEBOUNCE_MS = 200;         // channel-surfing: providers ban rapid reconnects
  const PAUSE_RELEASE_MS = 60000;         // paused this long -> drop the stream, resume at live
  const ASPECTS = ['Fit', 'Stretch', 'Zoom'];
  const EPG_PREFETCH_COUNT = 5;           // channels ahead (in the direction of travel) to warm EPG for
  const EPG_PREFETCH_DELAY_MS = 800;      // wait until the viewer stops surfing before prefetching
  const EPG_RETRY_MS = 5 * 60 * 1000;     // nothing known for this channel: look again later
  const STALL_JUMP_MS = 3000;             // picture frozen this long after it started: try hopping over a gap in the buffer
  const STALL_RESTART_MS = 12000;         // still frozen: restart the stream (other engine on the next try)
  const NO_PICTURE_MS = 7000;             // time moves (sound plays) but no video frame was produced this long: can't decode it
  const STATS_MS = 1000;                  // how often the video stats are re-read
  const CC_STALE_MS = 8000;               // captions on screen this long without an update: clear them (nothing is being said)
  const SHOW_BAR_ON_SWITCH = true;        // pop the info bar (with EPG) up whenever the channel changes

  function guessKind(url) {
    const p = url.split('?')[0].toLowerCase();
    if (p.includes('.m3u8')) return 'hls';
    if (/\.(mp4|m4v|webm|mov)$/.test(p)) return 'native';
    return 'ts';
  }
  // Attempt 0 uses the guess; retries alternate with the other engine (a wrong guess self-heals).
  function pickKind(url, attempt) {
    const base = guessKind(url);
    if (attempt % 2 === 0) return base;
    return base === 'ts' ? 'hls' : base === 'hls' ? 'ts' : 'ts';
  }

  // Xtream panels serve the same live stream as /ID.ts and /ID.m3u8. When one form fails, the retry tries the other.
  function swapLiveExt(url) {
    const m = /^(.*\/live\/[^/?#]+\/[^/?#]+\/[^/?#.]+)\.(ts|m3u8)(\?.*)?$/i.exec(url);
    return m ? m[1] + (m[2].toLowerCase() === 'ts' ? '.m3u8' : '.ts') + (m[3] || '') : null;
  }
  const hexText = (h) => (h ? ' (first bytes: ' + h + ')' : '');
  const KIND_OF = { hls: 'hls', ts: 'ts', mp4: 'native' };
  const KIND_NAME = { hls: 'HLS', ts: 'Live TS', native: 'Direct video' };
  function httpText(status) {
    if (status === 401 || status === 403) return `The provider refused the stream (HTTP ${status}): login/subscription problem, or this IP or device is blocked.`;
    if (status === 404) return `The provider does not have this stream (HTTP 404): the channel may have been removed or renamed.`;
    if (status === 429 || status === 509 || status === 458) return `Too many connections for this account (HTTP ${status}). Close it on other devices and try again.`;
    return `The provider answered HTTP ${status}.`;
  }
  // Asks the local proxy what the address really serves (also keeps that connection for the engine to reuse).
  async function probeStream(url, ua) {
    const r = await fetch(`${window.App.proxyBase}/probe?u=${encodeURIComponent(url)}&ua=${encodeURIComponent(ua || '')}`);
    return r.json();
  }
  function dropProbe(url, ua) {
    fetch(`${window.App.proxyBase}/drop?u=${encodeURIComponent(url)}&ua=${encodeURIComponent(ua || '')}`).catch(() => {});
  }

  function createEngine(kind, url, ua, video, onError) {
    const src = `${window.App.proxyBase}/p?u=${encodeURIComponent(url)}&ua=${encodeURIComponent(ua || '')}`;
    if (kind === 'ts') {
      if (!window.mpegts || !mpegts.isSupported()) { setTimeout(() => onError('This system cannot play live TS'), 0); return { destroy() {} }; }
      const p = mpegts.createPlayer({ type: 'mpegts', isLive: true, url: src, cors: true }, {
        enableWorker: false, enableStashBuffer: true, stashInitialSize: 384, lazyLoad: false,
        liveBufferLatencyChasing: false,           // pausing a live stream keeps you behind live, like ExoPlayer did
        autoCleanupSourceBuffer: true, autoCleanupMaxBackwardDuration: 30, autoCleanupMinBackwardDuration: 15,
        fixAudioTimestampGap: true
      });
      p.attachMediaElement(video);
      let mi = null, speed = 0; // what the demuxer read from the stream / measured download speed (KB/s)
      p.on(mpegts.Events.MEDIA_INFO, (m) => { mi = m; });
      p.on(mpegts.Events.STATISTICS_INFO, (st) => { if (st && st.speed >= 0) speed = st.speed; });
      p.on(mpegts.Events.ERROR, (type, detail, info) => onError(`${type}: ${detail}${info && info.code ? ' (' + info.code + ')' : ''}`));
      p.on(mpegts.Events.LOADING_COMPLETE, () => onError('The stream ended'));
      p.load();
      const pr = p.play();
      if (pr && pr.catch) pr.catch(() => {});
      return {
        info: () => ({ codec: mi && mi.videoCodec, audioCodec: mi && mi.audioCodec, hasVideo: mi ? mi.hasVideo : undefined, hasAudio: mi ? mi.hasAudio : undefined, fps: mi && mi.fps, bps: speed * 1024 * 8 }),
        destroy() { for (const f of ['pause', 'unload', 'detachMediaElement', 'destroy']) { try { p[f](); } catch (e) { /* already gone */ } } }
      };
    }
    if (kind === 'hls') {
      if (!window.Hls || !Hls.isSupported()) { setTimeout(() => onError('This system cannot play HLS'), 0); return { destroy() {} }; }
      const hls = new Hls({ liveSyncDurationCount: 3, maxBufferLength: 30, manifestLoadingMaxRetry: 1, levelLoadingMaxRetry: 1, fragLoadingMaxRetry: 2 });
      let recovered = false;
      hls.on(Hls.Events.ERROR, (ev, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) { recovered = true; hls.recoverMediaError(); return; }
        onError(data.details === 'manifestParsingError' ? "The address did not return an HLS playlist (manifestParsingError)" : `${data.type}: ${data.details}`);
      });
      let hlsCodec = '', hlsAudio = '', fragBps = 0; // codec from the parsed stream; bitrate = bytes of each fragment / its duration
      hls.on(Hls.Events.BUFFER_CODECS, (ev, d) => {
        if (d && d.video) hlsCodec = d.video.codec || d.video.levelCodec || hlsCodec;
        if (d && d.audio) hlsAudio = d.audio.codec || d.audio.levelCodec || hlsAudio;
      });
      hls.on(Hls.Events.FRAG_LOADED, (ev, d) => {
        const f = d && d.frag, st = f && (f.stats || d.stats);
        if (f && f.type === 'main' && st && st.total > 0 && f.duration > 0) { const b = (st.total * 8) / f.duration; fragBps = fragBps ? fragBps * 0.6 + b * 0.4 : b; }
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => { const pr = video.play(); if (pr && pr.catch) pr.catch(() => {}); });
      hls.loadSource(src);
      hls.attachMedia(video);
      return {
        info: () => {
          const lv = hls.levels && hls.levels[hls.currentLevel];
          const fr = lv && lv.attrs && parseFloat(lv.attrs['FRAME-RATE']);
          return { codec: hlsCodec || (lv && lv.videoCodec), audioCodec: hlsAudio || (lv && lv.audioCodec), fps: fr || 0, bps: fragBps || (lv && lv.bitrate) || 0 };
        },
        destroy() { try { hls.destroy(); } catch (e) { /* ignore */ } }
      };
    }
    video.src = src;
    const pr = video.play();
    if (pr && pr.catch) pr.catch(() => {});
    return { info: () => ({}), destroy() { try { video.removeAttribute('src'); video.load(); } catch (e) { /* ignore */ } } };
  }

  window.Screens.player = function ({ index }) {
    const A = window.App, N = window.Nav;
    const source = A.source;
    const spec = A.list.spec;
    let channels = A.list.channels;
    let idx = index;
    let ch = channels[idx];

    let video = null, engine = null;
    let attempt = 0, retries = 0, launchId = 0;
    let lastKind = '', tried = []; // tried: what each attempt said, shown if all of them fail
    let barTimer = 0, ezTimer = 0, idleTimer = 0, retryTimer = 0, switchTimer = 0, recentTimer = 0, watchdog = 0, pauseTimer = 0, lblTimer = 0, clickTimer = 0, volSave = 0;
    let overlayOn = false, ezOn = false, suspended = false, destroyed = false;
    let aspectIdx = A.ui.aspectIndex || 0;
    let volume = typeof A.ui.volume === 'number' ? A.ui.volume : 1;
    let muted = !!A.ui.muted;
    let favSet = new Set();
    const hasEpg = source.type === 'XTREAM';
    let epgReq = 0, epgTimer = 0, epgPrefetchTimer = 0;
    let dir = -1;   // direction of the last channel change: -1 = Up (previous), +1 = Down (next). Starts as Up.

    // ---------- DOM ----------
    const label = h('div', { class: 'p-label' });
    const backBtn = ibtn('back', 'Back to channels (Esc)', () => N.pop());
    const top = h('div', { class: 'p-top' }, backBtn, label);
    const badge = h('div', { class: 'p-badge' }); // one small in-place indicator for volume / aspect / mute
    const spinner = h('div', { class: 'spinner' });
    const msg = h('div', { class: 'p-msg', style: { whiteSpace: 'pre-line' } });
    const wrap = h('div', { style: { position: 'absolute', inset: '0' } });

    const playBtn = ibtn('pause', 'Play / Pause (Space)', () => togglePause());
    const nameEl = h('div', { class: 'cname' });
    const epgNow = h('div', { class: 'epg' });
    const epgNext = h('div', { class: 'epg epg-next' });
    const epgBox = h('div', { class: 'epg-box' }, epgNow, epgNext);
    epgBox.hidden = !hasEpg; // M3U sources have no Xtream EPG
    const statVideo = h('span', { class: 'sv' }), statBit = h('span', { class: 'sb' });
    const stats = h('div', { class: 'vstats' }, statVideo, statBit); // above the channel name, so it never squeezes the guide lines
    stats.hidden = true;
    const info = h('div', { class: 'cinfo' }, stats, nameEl, epgBox);
    // Icon-box buttons (same set as the Android bar): an outlined box over a small label.
    const barBtn = (box, label, title, onclick) => h('button', { class: 'bbtn', title, 'aria-label': label, onclick }, h('span', { class: 'ibox', text: box }), h('span', { class: 'blabel', text: label }));
    const aspectBtn = barBtn('16:9', 'Aspect', 'Aspect ratio (A)', () => cycleAspect());
    const ccBtn = barBtn('CC', 'Captions', 'Captions (C)', () => toggleCaptions());
    const chBtn = barBtn('\u2630', 'Channels', 'Channel list (Left)', () => { hideBar(); openOverlay(); });
    const ezBtn = barBtn('EZ', 'Add to EZ', 'Add this channel to the EZ List', () => addToEz(ch));
    const ccBox = h('div', { class: 'p-cc' }); // the caption text itself, over the picture
    const muteBtn = ibtn('volume', 'Mute (M)', () => toggleMute());
    const vol = h('input', { type: 'range', min: 0, max: 100, value: Math.round(volume * 100), title: 'Volume', tabindex: '-1',
      oninput: () => { volume = vol.value / 100; muted = false; applyVolume(true); flash('Volume ' + Math.round(volume * 100) + '%'); } });
    const fsBtn = ibtn('fullscreen', 'Full screen (F11)', () => api('win.toggleFullscreen'));
    const barButtons = [playBtn, aspectBtn, ccBtn, chBtn, ezBtn, muteBtn, fsBtn];
    const ctl = h('div', { class: 'ctl' }, playBtn, h('span', { class: 'live', text: 'LIVE' }), info, h('div', { class: 'grow' }), aspectBtn, ccBtn, chBtn, ezBtn, muteBtn, vol, fsBtn);

    const ovGrid = new window.VirtualGrid({
      itemHeight: 46, gap: 2, columns: 1,
      render: (c, i) => window.Cards.playerRow(c, { playing: i === idx, fav: favSet.has(c.url) }),
      onClick: (c, i, act) => {
        if (act === 'star') { toggleFav(c, i); return; }
        idx = i; closeOverlay(); startPlayback(false);
      }
    });
    const overlay = h('div', { class: 'panel left' }, h('h4', { text: 'Channels' }), ovGrid.el);

    const ezList = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } });
    const ezAspect = h('button', { class: 'tbtn', onclick: () => cycleAspect() });
    const ezPanel = h('div', { class: 'panel right' }, h('h4', { text: 'EZ List' }), ezList,
      h('div', { class: 'hint', text: 'Keys 1\u20135 jump to a slot. Right / Esc closes.' }), h('div', { style: { flex: 1 } }), ezAspect);
    ezPanel.addEventListener('keydown', (e) => {
      const items = [...ezPanel.querySelectorAll('.pitem, .tbtn')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); }
      else if ((e.key === 'Enter' || e.key === ' ') && i >= 0) { e.preventDefault(); items[i].click(); }
    });

    const root = h('div', { class: 'screen player', tabindex: '-1' }, wrap, ccBox, spinner, msg, top, badge, overlay, ezPanel, ctl);
    root.dataset.aspect = String(aspectIdx);

    // ---------- helpers ----------
    const displayName = (c) => window.Cards.parsed(c).displayName;
    const barVisible = () => root.classList.contains('bar');
    const inBar = () => ctl.contains(document.activeElement);
    function updateCursor() { root.classList.toggle('nocursor', !barVisible() && !overlayOn && !ezOn); }
    function aspectText() { ezAspect.textContent = 'Aspect: ' + ASPECTS[aspectIdx]; } // (the bar's own button is just the 16:9 icon + "Aspect")
    aspectText();
    function updatePlayIcon() { playBtn.replaceChildren(icon(video && !video.paused ? 'pause' : 'play')); }
    function updateMuteIcon() { muteBtn.replaceChildren(icon(muted || volume === 0 ? 'mute' : 'volume')); }
    updateMuteIcon();

    let badgeTimer = 0;
    function flash(text) { // updates the same badge, so fast changes never stack popups
      badge.textContent = text;
      badge.classList.add('on');
      clearTimeout(badgeTimer);
      badgeTimer = setTimeout(() => badge.classList.remove('on'), 900);
    }
    function applyVolume(save) {
      if (video) { video.volume = volume; video.muted = muted; }
      vol.value = Math.round((muted ? 0 : volume) * 100);
      updateMuteIcon();
      if (save) { clearTimeout(volSave); volSave = setTimeout(() => A.setUi({ volume, muted }), 400); }
    }
    function toggleMute() { muted = !muted; applyVolume(true); flash(muted ? 'Muted' : 'Volume ' + Math.round(volume * 100) + '%'); }
    function cycleAspect() {
      aspectIdx = (aspectIdx + 1) % ASPECTS.length;
      root.dataset.aspect = String(aspectIdx);
      aspectText();
      A.setUi({ aspectIndex: aspectIdx });
      toast('Aspect: ' + ASPECTS[aspectIdx], 1200); // short toast, like the Android app
    }

    // ---------- captions (CC) ----------
    // The proxy reads the channel's CEA-608 captions out of the video and streams them to us as text lines.
    // The on/off choice is saved: once on it stays on for every channel and every session until switched off.
    let ccOn = !!A.ui.captionsOn, ccAvail = false, ccSrc = null, ccStale = 0, ccDue = 0;
    const ccTimers = new Set();
    function updateCcButton() {
      ccBtn.disabled = !ccAvail;                       // greyed out (and skipped by the keys) on channels without captions
      ccBtn.classList.toggle('on', ccOn && ccAvail);   // box filled gold while captions are showing
      if (!ccAvail || !ccOn) showCaptionText([]);
    }
    function showCaptionText(lines) {
      clearTimeout(ccStale);
      ccBox.replaceChildren(...lines.map((t) => h('div', { text: t })));
      ccBox.classList.toggle('on', !!lines.length && ccOn && ccAvail);
      if (lines.length) ccStale = setTimeout(() => showCaptionText([]), CC_STALE_MS);
    }
    function ccLag() { // how far the picture is behind what the proxy just read: hold the text back by that much
      try { const b = video && video.buffered; if (b && b.length) return Math.max(0, Math.min(8, b.end(b.length - 1) - video.currentTime - 0.1)); } catch (e) { /* no video yet */ }
      return 0;
    }
    function ccEvent(o) {
      if (destroyed) return;
      if (o.t === 'avail') { ccAvail = !!o.on; updateCcButton(); return; }
      if (o.t !== 'cc') return;
      if (!o.lines.length) { showCaptionText([]); return; }
      const due = Math.max(ccDue + 1, Date.now() + ccLag() * 1000); // keeps the order, even when the lag changes
      ccDue = due;
      const t = setTimeout(() => { ccTimers.delete(t); if (!destroyed) showCaptionText(o.lines); }, due - Date.now());
      ccTimers.add(t);
    }
    function startCaptions() {
      if (typeof EventSource === 'undefined') return;
      ccSrc = new EventSource(`${A.proxyBase}/cc`);
      ccSrc.onmessage = (m) => { try { ccEvent(JSON.parse(m.data)); } catch (e) { /* ignore a bad line */ } };
    }
    function resetCaptions() { // new channel: forget the old one's captions (the proxy says again if this one has some)
      ccTimers.forEach(clearTimeout); ccTimers.clear(); ccDue = 0;
      ccAvail = false;
      updateCcButton();
      fetch(`${A.proxyBase}/ccreset`).catch(() => {});
    }
    function toggleCaptions() {
      if (!ccAvail) return;
      ccOn = !ccOn;
      A.setUi({ captionsOn: ccOn }); // remembered for every channel and future sessions
      updateCcButton();
      toast(ccOn ? 'Captions on' : 'Captions off', 1200);
      if (barVisible()) restartBarTimer();
    }
    updateCcButton();

    // ---------- bar / panels ----------
    function showBar(focus) {
      root.classList.add('bar');
      updateCursor();
      if (focus) playBtn.focus();
      restartBarTimer();
    }
    function hideBar() {
      root.classList.remove('bar');
      if (inBar()) root.focus();
      updateCursor();
    }
    function restartBarTimer() {
      clearTimeout(barTimer);
      barTimer = setTimeout(() => { if (ctl.matches(':hover')) restartBarTimer(); else hideBar(); }, BAR_HIDE_MS);
    }
    function flashLabel() {
      root.classList.add('lbl');
      clearTimeout(lblTimer);
      lblTimer = setTimeout(() => root.classList.remove('lbl'), BAR_HIDE_MS);
    }
    function openOverlay() {
      closeEz();
      overlayOn = true;
      overlay.classList.add('on');
      ovGrid.setItems(channels);
      ovGrid.focusIndex(idx, true);
      updateCursor();
    }
    function closeOverlay() {
      if (!overlayOn) return;
      overlayOn = false;
      overlay.classList.remove('on');
      root.focus();
      updateCursor();
    }
    function restartEzTimer() { clearTimeout(ezTimer); ezTimer = setTimeout(closeEz, EZ_AUTO_CLOSE_MS); }
    async function openEz() {
      closeOverlay(); hideBar();
      const slots = await api('ez.get', source.id);
      ezList.replaceChildren();
      slots.forEach((c, i) => {
        if (!c) return;
        ezList.append(h('div', { class: 'pitem' + (ch && c.url === ch.url ? ' playing' : ''), tabindex: '0', data: { slot: i }, onclick: () => playEz(c) },
          h('span', { class: 'num', text: i + 1 }), h('span', { class: 'nm', text: displayName(c) })));
      });
      if (!ezList.children.length) ezList.append(h('div', { class: 'hint', text: 'Nothing here yet. Use "Add to EZ" on a channel.' }));
      ezOn = true;
      ezPanel.classList.add('on');
      (ezList.querySelector('.pitem') || ezAspect).focus();
      restartEzTimer();
      updateCursor();
    }
    function closeEz() {
      if (!ezOn) return;
      ezOn = false;
      clearTimeout(ezTimer);
      ezPanel.classList.remove('on');
      root.focus();
      updateCursor();
    }
    function playEz(c) {
      closeEz();
      let i = channels.findIndex((x) => x.url === c.url);
      if (i < 0) { channels = [c].concat(channels); i = 0; } // not in this list: play it on its own, list keeps working
      idx = i;
      startPlayback(false);
    }

    function toggleFav(c, i) {
      return window.FavPicker.show(source, c, {
        firstListId: spec && spec.kind === 'favourites' ? (spec.id || 'default') : 'default',
        onChanged: async () => { favSet = new Set(await api('favourites.allUrls', source.id)); ovGrid.refreshIndex(i); }
      });
    }
    async function addToEz(c) {
      const slots = await api('ez.get', source.id);
      const labels = slots.map((s, i) => `Slot ${i + 1}: ${s ? s.name : '(empty)'}`);
      const pick = await choose(`Add "${c.name}" to EZ List`, labels);
      if (pick === null) return;
      await api('ez.set', source.id, pick, { name: c.name, url: c.url, group: c.group || '' });
      toast(`Added to EZ List slot ${pick + 1}`);
      if (barVisible()) restartBarTimer();
    }

    // ---------- EPG (Now / Next under the channel name) ----------
    const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    function setEpgLine(el, tag, p) {
      el.replaceChildren();
      if (!p) return;
      el.append(h('span', { class: 'tag', text: tag }), h('span', { class: 'tm', text: fmtTime(p.start) }), p.title);
      el.title = `${fmtTime(p.start)}\u2013${fmtTime(p.stop)}  ${p.title}`;
    }
    function clearEpg() { epgNow.replaceChildren(); epgNext.replaceChildren(); epgNow.title = epgNext.title = ''; }
    async function loadEpg(soft) {
      if (!hasEpg || !ch) return;
      const my = ++epgReq;
      clearTimeout(epgTimer);
      if (!soft) clearEpg();
      let e = null;
      try { e = await api('epg.get', source.id, ch.url); } catch (err) { /* no EPG is fine */ }
      if (my !== epgReq || destroyed) return; // viewer already moved on to another channel
      if (e && (e.now || e.next)) {
        setEpgLine(epgNow, 'NOW', e.now);
        setEpgLine(epgNext, 'NEXT', e.next);
        if (!e.now) epgNow.append(h('span', { class: 'tag', text: 'NOW' }), 'No programme info');
      } else {
        clearEpg();
        epgNow.append(h('span', { class: 'tag', text: 'NOW' }), 'No programme info');
      }
      // Refresh right when the current programme ends (so Next becomes Now), else look again later.
      const wait = e && e.now ? Math.max(5000, e.now.stop - Date.now() + 2000) : EPG_RETRY_MS;
      epgTimer = setTimeout(() => loadEpg(true), Math.min(wait, 60 * 60 * 1000));
    }
    // Warm the next few channels in the direction the viewer is heading, so the info is already there.
    function prefetchEpg() {
      if (!hasEpg || channels.length < 2) return;
      const urls = [];
      for (let i = 1; i <= EPG_PREFETCH_COUNT && i < channels.length; i++) {
        const c = channels[((idx + dir * i) % channels.length + channels.length) % channels.length];
        if (c && c.url !== ch.url) urls.push(c.url);
      }
      api('epg.prefetch', source.id, urls).catch(() => {});
    }

    // ---------- video stats (true values from the stream / decoder, never from the title) ----------
    const sampler = new window.StreamStats.Sampler(4000);
    let statsTimer = 0;
    function clearStats() {
      sampler.reset();
      statVideo.textContent = statBit.textContent = stats.title = '';
      stats.hidden = true;
    }
    function updateStats() {
      if (!video || !engine || destroyed) { clearStats(); return; }
      if (!video.paused && video.readyState >= 3) {
        const q = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
        if (q) sampler.push(performance.now(), q.totalVideoFrames, typeof video.webkitVideoDecodedByteCount === 'number' ? video.webkitVideoDecodedByteCount : null);
      }
      checkHealth(video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null);
      if (destroyed || !video || !engine) return; // the check may have restarted the stream
      const r = window.StreamStats.summarize({ width: video.videoWidth, height: video.videoHeight }, sampler.rates(), engine.info ? engine.info() : {});
      stats.hidden = !r.video;
      statVideo.textContent = r.video ? 'Video: ' + r.video : '';
      statBit.textContent = r.bitrate ? 'BitR: ' + r.bitrate : '';
      stats.title = r.title;
    }
    // ---------- health: tells a frozen / undecodable stream from a slow one, and says why ----------
    let launchAt = 0;
    let playing = false, playingAt = 0, healthFails = 0; // healthFails: consecutive frozen / no-picture restarts
    const health = { time: -1, timeSince: 0, frames: -1, framesSince: 0, jumps: 0 };
    function resetHealth() { health.time = -1; health.timeSince = health.framesSince = 0; health.frames = -1; }
    function whyText() {
      const d = window.StreamStats.diagnose(engine && engine.info ? engine.info() : {}, typeof MediaSource !== 'undefined' ? (t) => MediaSource.isTypeSupported(t) : null);
      return d.text;
    }
    function jumpGap() { // buffered data exists just ahead of the playhead (timestamp gap): hop over it
      const b = video.buffered, t = video.currentTime;
      for (let i = 0; i < b.length; i++) if (b.start(i) > t && b.start(i) - t < 8) { video.currentTime = b.start(i) + 0.1; return true; }
      return false;
    }
    function healthFail(m) { // 3 in a row -> stop retrying and show the reason instead of looping forever
      if (++healthFails >= 3) retries = MAX_RETRIES;
      onEngineError(m);
    }
    function checkHealth(q) {
      const now = performance.now();
      if (!playing && !video.paused) {
        const since = now - launchAt, b = video.buffered;
        if (b.length && since > 2500) {
          const t0 = video.currentTime, start = b.start(0), end = b.end(b.length - 1);
          if (start > t0 + 0.05 && health.jumps < 3) { health.jumps++; video.currentTime = start + 0.05; return; } // data starts a little after the playhead (A/V start offset)
          // stuck with plenty buffered (e.g. the stream began mid-GOP): it is live, so go to the live edge
          if (since > 6000 && end - t0 > 3 && health.jumps < 6) { health.jumps++; video.currentTime = Math.max(start, end - 1.5); return; }
        }
        return;
      }
      if (!playing || video.paused || video.seeking || suspended) { resetHealth(); return; }
      const t = video.currentTime;
      if (healthFails && now - playingAt > 30000) healthFails = 0; // it has run fine for a while
      if (health.time < 0 || t !== health.time) { health.time = t; health.timeSince = now; }
      else {
        const frozen = now - health.timeSince;
        if (frozen >= STALL_RESTART_MS) { healthFail('The picture froze'); return; }
        if (frozen >= STALL_JUMP_MS && health.jumps < 3 && jumpGap()) { health.jumps++; health.timeSince = now; return; }
      }
      const f = q ? q.totalVideoFrames : -1;
      if (f < 0) return;
      if (health.frames < 0 || f !== health.frames) { health.frames = f; health.framesSince = now; }
      else if (t !== health.time || now - health.timeSince < 1500) {
        // playback time is moving but the decoder produced no picture
        if (now - health.framesSince >= NO_PICTURE_MS) healthFail('No picture is being decoded');
      }
    }
    function startStats() { clearInterval(statsTimer); statsTimer = setInterval(updateStats, STATS_MS); }

    // ---------- playback ----------
    function setBuffering(on) { root.classList.toggle('buffering', on); }
    function showMsg(text) { msg.textContent = text || ''; root.classList.toggle('errored', !!text); }
    function armWatchdog() {
      clearTimeout(watchdog);
      const id = launchId;
      watchdog = setTimeout(() => { if (id === launchId) onEngineError('Timed out waiting for the stream'); }, START_TIMEOUT_MS);
    }

    function makeVideo() {
      const v = h('video', { autoplay: true, playsinline: true });
      v.addEventListener('playing', () => { clearTimeout(watchdog); if (!playing) playingAt = performance.now(); playing = true; retries = 0; setBuffering(false); showMsg(''); updatePlayIcon(); });
      v.addEventListener('waiting', () => { setBuffering(true); armWatchdog(); });
      v.addEventListener('pause', updatePlayIcon);
      v.addEventListener('play', updatePlayIcon);
      v.addEventListener('error', () => onEngineError('Media error ' + (v.error ? v.error.code : '')));
      v.volume = volume; v.muted = muted;
      return v;
    }

    function teardown() {
      launchId++;
      playing = false; resetHealth();
      clearStats();
      clearTimeout(watchdog); clearTimeout(retryTimer);
      if (engine) { engine.destroy(); engine = null; }
    }

    async function launch(n) {
      if (destroyed) return;
      if (window.AdultFilter.isBlocked(ch)) { toast("This channel can't be played"); return; } // last line of defence
      teardown();
      attempt = n;
      video = makeVideo();
      wrap.replaceChildren(video);
      updatePlayIcon();
      setBuffering(true);
      const id = launchId;
      launchAt = performance.now(); health.jumps = 0;
      const ua = source.userAgent;
      const alt = n % 2 ? swapLiveExt(ch.url) : null; // odd attempts: the other form of the same Xtream address
      const url = alt || ch.url;
      // 1. look at what the address really serves, so the right engine is used
      let kind = alt ? guessKind(alt) : pickKind(ch.url, n);
      try {
        const pr = await probeStream(url, ua);
        if (id !== launchId || destroyed) { dropProbe(url, ua); return; }
        lastKind = '';
        if (pr.error) { onEngineError('Cannot reach the provider: ' + pr.error); return; }
        if (pr.status >= 400) { onEngineError(httpText(pr.status)); return; }
        if (pr.kind === 'text') { onEngineError('The provider sent a message instead of video' + (pr.text ? ': \u201C' + pr.text + '\u201D' : '') + ' (' + (pr.contentType || 'no content type') + ')'); return; }
        if (pr.status < 400 && !pr.bytes) { onEngineError('The provider answered but sent no data (empty response' + (alt ? ', tried ' + alt.split('.').pop() : '') + '). The channel may be offline, or the account is at its connection limit.'); return; }
        if (KIND_OF[pr.kind]) kind = KIND_OF[pr.kind];
        else if (pr.kind === 'unknown') tried.push('Unrecognised data from the provider' + hexText(pr.head) + ' (' + (pr.contentType || 'no content type') + ')');
      } catch (e) {
        if (id !== launchId || destroyed) return; // probing is optional: fall back to guessing the engine
      }
      // 2. play it
      lastKind = kind;
      engine = createEngine(kind, url, ua, video, (m) => { if (id === launchId) onEngineError(m); });
      armWatchdog();
    }

    // What the player knew at the moment of failure: is data arriving, is a picture decoded, what is buffered?
    function stateText() {
      if (!video) return '';
      const b = video.buffered, rng = [];
      for (let i = 0; i < b.length; i++) rng.push(b.start(i).toFixed(1) + '\u2013' + b.end(i).toFixed(1) + 's');
      const inf = engine && engine.info ? engine.info() : {};
      return [inf.bps > 0 ? 'data is arriving' : 'no data arriving', video.videoWidth ? `picture ${video.videoWidth}\u00D7${video.videoHeight}` : 'no picture decoded', 'buffered: ' + (rng.join(', ') || 'none'),
        `t=${video.currentTime.toFixed(1)}s ready=${video.readyState}${video.paused ? ' paused' : ''}${video.error ? ' err=' + video.error.code : ''}`].join(' \u00B7 ');
    }

    function onEngineError(m) {
      if (destroyed) return;
      const why = whyText(); // read the stream's codecs and state before the engine is torn down
      const state = stateText();
      const line = (lastKind ? (KIND_NAME[lastKind] || lastKind) + ': ' : '') + m;
      if (!tried.includes(line)) tried.push(line);
      teardown();
      if (retries < MAX_RETRIES) {
        retries++;
        setBuffering(true);
        retryTimer = setTimeout(() => launch(attempt + 1), RETRY_MS);
      } else {
        setBuffering(false);
        showMsg("Can't play this channel\n" + tried.slice(0, 4).join('\n') + (why ? '\n' + why : '') + (state ? '\n' + state : ''));
        toast('Playback error: ' + m, 4500);
      }
    }

    function startPlayback(immediate) {
      ch = channels[idx];
      nameEl.textContent = displayName(ch);
      label.textContent = displayName(ch);
      flashLabel();
      loadEpg(false);
      clearTimeout(epgPrefetchTimer);
      epgPrefetchTimer = setTimeout(prefetchEpg, EPG_PREFETCH_DELAY_MS);
      if (SHOW_BAR_ON_SWITCH && hasEpg) showBar(false);
      document.title = displayName(ch) + ' \u2014 TaZ IPTV';
      if (navigator.mediaSession) { try { navigator.mediaSession.metadata = new MediaMetadata({ title: displayName(ch), artist: source.name }); } catch (e) { /* optional */ } }
      api('session.save', { screen: 'player', sourceId: source.id, spec, channelName: ch.name, channelUrl: ch.url });
      clearTimeout(switchTimer); clearTimeout(pauseTimer);
      // "Recently played" only counts channels watched a couple of seconds, not ones surfed past.
      clearTimeout(recentTimer);
      const played = { name: ch.name, url: ch.url, group: '' };
      recentTimer = setTimeout(() => api('recent.add', source.id, played).catch(() => {}), 2000);
      suspended = false; retries = 0; tried = [];
      teardown();
      resetCaptions();
      showMsg('');
      setBuffering(true);
      switchTimer = setTimeout(() => launch(0), immediate ? 0 : SWITCH_DEBOUNCE_MS);
      if (overlayOn) ovGrid.refresh();
    }

    const next = () => { if (channels.length) { dir = 1; idx = (idx + 1) % channels.length; startPlayback(false); } };
    const prev = () => { if (channels.length) { dir = -1; idx = (idx - 1 + channels.length) % channels.length; startPlayback(false); } };

    function togglePause() {
      if (!video) return;
      clearTimeout(pauseTimer);
      if (suspended) { suspended = false; launch(0); return; }
      if (video.paused) { const pr = video.play(); if (pr && pr.catch) pr.catch(() => {}); return; }
      video.pause();
      // Like ExoPlayer's bounded buffer: after a minute paused, drop the stream and resume at live.
      pauseTimer = setTimeout(() => { teardown(); suspended = true; }, PAUSE_RELEASE_MS);
    }

    // ---------- navigation ----------
    function back() {
      if (ezOn) { closeEz(); return; }
      if (overlayOn) { closeOverlay(); return; }
      if (barVisible()) { hideBar(); return; }
      if (A.fullscreen) { api('win.setFullscreen', false); return; }
      N.pop();
    }
    function moveBar(d) { // skips inactive buttons (Captions on a channel that has none)
      let i = barButtons.indexOf(document.activeElement);
      if (i < 0) i = 0;
      do { i += d; } while (i >= 0 && i < barButtons.length && barButtons[i].disabled);
      if (i >= 0 && i < barButtons.length) barButtons[i].focus();
    }
    function resetIdle() { clearTimeout(idleTimer); idleTimer = setTimeout(() => { toast('Stopped after 2 hours without activity'); N.pop(); }, IDLE_STOP_MS); }

    // ---------- mouse ----------
    root.addEventListener('mousemove', () => { resetIdle(); if (!overlayOn && !ezOn) showBar(false); });
    wrap.addEventListener('click', () => {
      resetIdle();
      if (overlayOn) { closeOverlay(); return; }
      if (ezOn) { closeEz(); return; }
      clearTimeout(clickTimer);
      clickTimer = setTimeout(togglePause, 250); // wait to see if it is a double click
    });
    wrap.addEventListener('dblclick', () => { clearTimeout(clickTimer); api('win.toggleFullscreen'); });
    root.addEventListener('wheel', (e) => {
      if (overlayOn && overlay.contains(e.target)) return;
      e.preventDefault();
      resetIdle();
      volume = Math.max(0, Math.min(1, volume + (e.deltaY < 0 ? 0.05 : -0.05)));
      muted = false;
      applyVolume(true);
      flash('Volume ' + Math.round(volume * 100) + '%');
    }, { passive: false });

    // ---------- screen API ----------
    return {
      el: root,
      onBack() { back(); return true; },
      onKey(e) {
        resetIdle();
        if (e.ctrlKey || e.altKey || e.metaKey) return false;
        const panelOpen = overlayOn || ezOn;
        if (inBar()) restartBarTimer();
        if (ezOn) restartEzTimer();
        switch (e.key) {
          case 'Escape': case 'Backspace': e.preventDefault(); back(); return true;
          case 'ArrowLeft':
            e.preventDefault();
            if (inBar() && !panelOpen) { moveBar(-1); return true; }
            hideBar(); closeEz();
            if (overlayOn) closeOverlay(); else openOverlay();
            return true;
          case 'ArrowRight': case 'z': case 'Z':
            e.preventDefault();
            if (e.key === 'ArrowRight' && inBar() && !panelOpen) { moveBar(1); return true; }
            hideBar(); closeOverlay();
            if (ezOn) closeEz(); else openEz();
            return true;
          case 'ArrowDown': case 'PageDown': if (panelOpen && e.key === 'ArrowDown') return false; e.preventDefault(); next(); return true;
          case 'ArrowUp': case 'PageUp': if (panelOpen && e.key === 'ArrowUp') return false; e.preventDefault(); prev(); return true;
          case 'Enter':
            if (panelOpen || inBar()) return false; // the focused item / button handles it
            e.preventDefault(); showBar(true); return true;
          case ' ':
            if (panelOpen || (inBar() && document.activeElement.tagName === 'BUTTON')) return false;
            e.preventDefault(); togglePause(); return true;
          case 'MediaPlayPause': e.preventDefault(); togglePause(); return true;
          case 'a': case 'A': cycleAspect(); return true;
          case 'c': case 'C': toggleCaptions(); return true;
          case 'm': case 'M': toggleMute(); return true;
          case 'f': case 'F': e.preventDefault(); api('win.toggleFullscreen'); return true;
          case '1': case '2': case '3': case '4': case '5':
            api('ez.get', source.id).then((slots) => { const c = slots[+e.key - 1]; if (c) playEz(c); else toast(`EZ slot ${e.key} is empty`, 1200); });
            return true;
          default: return false;
        }
      },
      async onShow() {
        if (video) return;
        api('player.active', true); // keep the screen awake
        favSet = new Set(await api('favourites.allUrls', source.id));
        if (navigator.mediaSession) {
          const set = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch (e) { /* unsupported */ } };
          set('play', togglePause); set('pause', togglePause); set('nexttrack', next); set('previoustrack', prev);
        }
        resetIdle();
        startCaptions();
        startStats();
        startPlayback(true);
        root.focus();
        updateCursor();
        window.__player = { state: () => ({ idx, name: ch && ch.name, paused: video && video.paused, t: video && video.currentTime, w: video && video.videoWidth, h: video && video.videoHeight, retries, attempt, err: msg.textContent, bar: barVisible(), overlayOn, ezOn }), next, prev, openEz, openOverlay, showBar };
      },
      destroy() {
        destroyed = true;
        [epgTimer, epgPrefetchTimer, barTimer, ezTimer, idleTimer, retryTimer, switchTimer, watchdog, pauseTimer, lblTimer, clickTimer, volSave, badgeTimer].forEach(clearTimeout);
        clearInterval(statsTimer);
        ccTimers.forEach(clearTimeout); clearTimeout(ccStale);
        if (ccSrc) { ccSrc.close(); ccSrc = null; }
        teardown();
        api('player.active', false);
        api('ui.set', { volume, muted });
        document.title = 'TaZ IPTV';
        if (navigator.mediaSession) for (const a of ['play', 'pause', 'nexttrack', 'previoustrack']) { try { navigator.mediaSession.setActionHandler(a, null); } catch (e) { /* ignore */ } }
        window.__player = null;
      }
    };
  };
})();
