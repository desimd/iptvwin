// App core: shared state, the screen stack (Home -> Categories -> Channels -> Player), colour / card
// themes, global keys, "where was I" session restore and startup.
(function () {
  'use strict';
  const { h, api, toast, progress, dialog } = window.UI;

  const App = {
    source: null,   // the source being browsed
    list: null,     // { channels (what the list shows and the player surfs), provider, spec, title }
    ui: {},         // saved display prefs
    proxyBase: '',
    fullscreen: false,
    isLight: () => ['mist', 'paper'].includes(App.ui.appColors),

    applyUi() {
      const r = document.documentElement;
      r.dataset.colors = App.ui.appColors || 'ember';
      r.dataset.theme = App.ui.channelTheme || 'marker';
    },
    async setUi(patch) {
      Object.assign(App.ui, patch);
      App.applyUi();
      await api('ui.set', patch);
    }
  };

  const Nav = {
    stack: [],
    top() { return this.stack[this.stack.length - 1]; },
    push(s) {
      const t = this.top();
      if (t) t.el.classList.add('under');
      document.getElementById('screens').append(s.el);
      this.stack.push(s);
      if (s.onShow) s.onShow();
    },
    pop() {
      const s = this.stack.pop();
      if (!s) return;
      if (s.onHide) s.onHide();
      if (s.destroy) s.destroy();
      s.el.remove();
      const t = this.top();
      if (t) { t.el.classList.remove('under'); if (t.onShow) t.onShow(); }
    },
    back() {
      const t = this.top();
      if (!t) return;
      if (t.onBack && t.onBack() === true) return; // screen handled it (closed a panel, left reorder mode...)
      if (this.stack.length > 1) this.pop();
    }
  };

  // ---------- keyboard help ----------
  function showHelp() {
    const rows = [
      ['Esc / Backspace / mouse Back', 'Go back (closes panels first)'],
      ['Arrow keys, Enter', 'Move between cards, open / play'],
      ['Right-click', 'Menu: favourite, EZ List, star a category'],
      ['Ctrl+F', 'Filter the channel list'],
      ['F  /  E  (on a channel)', 'Toggle favourite  /  add to EZ List'],
      ['In the player', ''],
      ['Up / Down', 'Previous / next channel'],
      ['Left', 'Channel list panel'],
      ['Right  or  Z', 'EZ List panel (1-5 jump to a slot)'],
      ['Enter', 'Show the control bar (then Left/Right + Enter)'],
      ['Space  /  media keys', 'Play / pause'],
      ['A', 'Aspect: Fit / Stretch / Zoom'],
      ['M  /  mouse wheel', 'Mute / volume'],
      ['F11  /  double-click', 'Full screen']
    ];
    dialog({
      title: 'Keyboard & mouse', wide: true,
      body: h('table', null, rows.map(([k, v]) => h('tr', null, h('td', { text: k }), h('td', { text: v })))),
      buttons: [{ label: 'Close', primary: true }]
    });
  }

  // ---------- global keys ----------
  document.addEventListener('keydown', (e) => {
    if (window.UI.modalOpen()) return;
    const top = Nav.top();
    if (!top) return;
    if (top.onKey && top.onKey(e) === true) return;
    const typing = window.UI.isTyping(e.target);
    if (e.key === 'F11') { e.preventDefault(); api('win.toggleFullscreen'); return; }
    if (e.key === 'F1' || (e.key === '?' && !typing)) { e.preventDefault(); showHelp(); return; }
    if (e.key === 'f' && e.ctrlKey && top.onFind) { e.preventDefault(); top.onFind(); return; }
    if (e.key === 'Escape' || (e.key === 'Backspace' && !typing)) {
      if (typing && e.key === 'Escape' && e.target.value) { e.target.value = ''; e.target.dispatchEvent(new Event('input')); return; }
      e.preventDefault();
      if (typing) e.target.blur();
      Nav.back();
      return;
    }
    if (!typing && /^Arrow/.test(e.key) && top.navScope && !e.altKey && !e.ctrlKey) {
      if (window.UI.geoNav(top.navScope(), '.card, .row, .toggle-all', e.key)) e.preventDefault();
    }
  });
  window.addEventListener('mouseup', (e) => { if (e.button === 3) { e.preventDefault(); Nav.back(); } });
  window.addEventListener('auxclick', (e) => { if (e.button === 3 || e.button === 4) e.preventDefault(); });
  document.addEventListener('contextmenu', (e) => { if (!window.UI.isTyping(e.target)) e.preventDefault(); });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());

  // ---------- rebuild the back stack after a restart ----------
  async function restoreSession(s) {
    const sources = await api('sources.list');
    const source = sources.find((x) => x.id === s.sourceId);
    if (!source) return false;
    const spec = s.spec;
    App.source = source;
    if (s.screen === 'categories' || !spec) {
      Nav.push(window.Screens.categories(source));
      return true;
    }
    progress(true);
    let loaded;
    try { loaded = await api('list.load', source.id, spec); }
    catch (e) { toast("Couldn't restore where you left off"); return false; }
    finally { progress(false); }
    // Same order the list will have on screen, so the playing channel's index matches.
    let channels = (spec.kind === 'favourites' || spec.kind === 'recent') ? loaded : window.ChannelSort.apply(App.ui.channelSort || 'default', loaded);
    let playIndex = -1;
    if (s.screen === 'player' && s.channelUrl) {
      playIndex = channels.findIndex((c) => c.url === s.channelUrl);
      if (playIndex < 0) { channels = [{ name: s.channelName, url: s.channelUrl, group: '' }].concat(channels); playIndex = 0; }
    }
    Nav.push(window.Screens.categories(source));
    Nav.push(window.Screens.channelList({ source, spec, title: spec.title, provider: loaded, channels }));
    if (playIndex >= 0 && window.RESTORE_PLAYER !== false) Nav.push(window.Screens.player({ index: playIndex }));
    return true;
  }

  async function boot() {
    const info = await api('info');
    App.proxyBase = info.proxyBase;
    App.ui = await api('ui.get');
    App.applyUi();
    window.api.onFullscreen((on) => { App.fullscreen = on; document.dispatchEvent(new CustomEvent('fs-changed', { detail: on })); });
    App.fullscreen = await api('win.isFullscreen');
    const session = await api('session.load');
    // Like the Android app: the source used last is the main page (its categories); the sources grid is just a
    // switch, reached with the layers button. A saved session (left from a deeper screen) wins.
    const home = window.Screens.home();
    Nav.push(home);
    let restored = false;
    if (session) restored = await restoreSession(session);
    if (!restored) {
      const list = await api('sources.list');
      if (list.length) await home.openSource(list[0]);
    }
  }

  window.App = App;
  window.Nav = Nav;
  window.showHelp = showHelp;
  window.addEventListener('DOMContentLoaded', () => boot().catch((e) => { document.body.append(h('pre', { style: { color: '#f88', padding: '20px', userSelect: 'text' }, text: 'Startup error: ' + (e && e.stack || e) })); }));
})();
