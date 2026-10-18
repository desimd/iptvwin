// Screens (ports of MainActivity, AddSourceActivity, CategoryListActivity, ManageCategoriesActivity,
// ChannelListActivity). Each returns { el, onShow, onHide, onBack?, onKey?, navScope? } for Nav.
(function () {
  'use strict';
  const { h, api, ibtn, icon, toast, withProgress, contextMenu, choose, confirmDialog, dialog, segmented, isTyping } = window.UI;
  const Screens = {};
  window.Screens = Screens;

  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const plain = (ch) => ({ name: ch.name, url: ch.url, group: ch.group || '' });
  const sortList = (list) => window.ChannelSort.apply(window.App.ui.channelSort || 'default', list);
  const backBtn = () => ibtn('back', 'Back (Esc)', () => window.Nav.back());
  // Enter / Space presses a focused card or row.
  function enterClicks(root) {
    root.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.card, .row') && !isTyping(e.target)) { e.preventDefault(); e.target.click(); }
    });
  }
  // Layers button: shows the source in use (first word, 6 letters at most, small) and goes back to the sources grid.
  function sourceButton(source) {
    const first = (source.name || '').trim().split(/\s+/)[0] || '';
    const label = first.length > 6 ? first.slice(0, 6) + '\u2026' : first || 'Sources';
    return h('button', { class: 'srcbtn', title: `Switch source (now: ${source.name})`, 'aria-label': 'Switch source',
      onclick: () => { while (window.Nav.stack.length > 1) window.Nav.pop(); } }, icon('layers'), h('span', { class: 'sn', text: label }));
  }
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s);

  // ============================== HOME ==============================
  Screens.home = function () {
    const grid = h('div', { class: 'grid src' });
    const body = h('div', { class: 'body' }, grid);
    const el = h('div', { class: 'screen' },
      h('div', { class: 'hdr' }, h('img', { class: 'logo', src: 'logo.png', alt: 'TaZ IPTV' }), h('div', { class: 'grow' }),
        ibtn('backup', 'Backup & restore', (ev) => {
          const r = ev.currentTarget.getBoundingClientRect();
          contextMenu([{ label: 'Export backup\u2026', onClick: exportBackup }, { label: 'Import backup\u2026', onClick: importBackup }], r.right - 190, r.bottom);
        }),
        h('button', { class: 'ibtn', title: 'Keyboard & mouse (F1)', text: '?', onclick: () => window.showHelp() })),
      body);
    let sources = [];

    async function refresh() {
      sources = await api('sources.list');
      const hadFocus = el.contains(document.activeElement);
      grid.replaceChildren(...sources.map(window.Cards.source), window.Cards.addCard());
      if (hadFocus || !document.activeElement || document.activeElement === document.body) grid.firstElementChild.focus({ preventScroll: true });
    }

    // ---- Backup & restore (favourite lists, starred/hidden categories, EZ List, EPG shift; no logins) ----
    const note = (title, text) => window.UI.dialog({ title, body: h('div', { class: 'msg', style: { whiteSpace: 'pre-line' }, text }), buttons: [{ label: 'OK', primary: true }] });
    async function exportBackup() {
      const i = await choose('Export backup', ['With logins \u2014 restores everything, sources included', 'Without logins \u2014 safer to share']);
      if (i === null) return;
      const includeLogins = i === 0;
      const r = await withProgress(() => api('backup.export', { includeLogins }), 'Backup failed: ');
      if (!r || r.canceled) return;
      note('Backup saved', includeLogins
        ? `${r.path}\n\nIt holds your sources WITH their server, username and password (or playlist URL) in plain text, plus favourite lists, starred and hidden categories, EZ List and EPG shift. Importing it on any PC re-creates the sources exactly. Keep this file private.`
        : `${r.path}\n\nIt holds your favourite lists, starred and hidden categories, EZ List and EPG shift, but no logins. To restore it on another device, add the same sources there first, then import.`);
    }
    async function importBackup() {
      const r = await withProgress(() => api('backup.import'), 'Import failed: ');
      if (r && !r.canceled) note('Backup imported', r.summary);
    }

    // ---- Download as M3U: confirm -> choose file -> progress -> summary ----
    let exportSink = null;
    window.api.onExportProgress((p) => { if (exportSink) exportSink(p); });
    const fmtBytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

    async function downloadM3u(src) {
      const msg = src.type === 'XTREAM'
        ? 'Selected categories will be downloaded: every category ticked in Manage categories (not only favourites). This can be thousands of channels, so the file may be large and take a while to prepare.\n\nEach channel is saved with just its name, category and link. The links contain your login, so keep the file private.'
        : 'The whole playlist will be downloaded as a compact M3U with just channel names, categories and links. The links may contain your login, so keep the file private.';
      if (!(await confirmDialog(`Download \u201C${src.name}\u201D as M3U?`, msg, 'Continue'))) return;

      const text = h('div', { class: 'msg', text: 'Choose where to save the file\u2026' });
      const fill = h('i');
      const detail = h('div', { class: 'msg pdetail', text: '' });
      let running = true;
      const dlg = dialog({
        title: 'Preparing playlist', body: h('div', null, text, h('div', { class: 'pbar' }, fill), detail),
        buttons: [{ label: 'Cancel' }],
        onClose: () => { if (running) api('export.cancel'); } // Cancel button or Esc
      });
      exportSink = (p) => {
        if (!running) return;
        if (!p.total) { text.textContent = 'Preparing\u2026'; fill.classList.add('busy'); return; }
        fill.classList.remove('busy');
        fill.style.width = Math.round((p.done / p.total) * 100) + '%';
        text.textContent = `Category ${Math.min(p.done + 1, p.total)} of ${p.total}`;
        detail.textContent = `${p.channels.toLocaleString()} channels so far` + (p.group ? ` \u00B7 ${p.group}` : '');
      };
      let r = null, err = null;
      try { r = await api('export.m3u', src.id); } catch (e) { err = e; }
      running = false; exportSink = null;
      dlg.close();
      if (err) { toast('Export failed: ' + (err.message || err), 5000); return; }
      if (!r || r.canceled) return;
      if (r.cancelled) { toast('Export cancelled'); return; }
      const lines = [`${r.channels.toLocaleString()} channels from ${r.categories} ${r.categories === 1 ? 'category' : 'categories'} \u00B7 ${fmtBytes(r.bytes)}`, r.path];
      if (r.skipped.length) lines.push(`\n${r.skipped.length} could not be loaded and were skipped: ${r.skipped.slice(0, 5).join(', ')}${r.skipped.length > 5 ? '\u2026' : ''}`);
      dialog({
        title: 'Playlist saved', body: h('div', { class: 'msg', style: { whiteSpace: 'pre-line', wordBreak: 'break-all' }, text: lines.join('\n') }),
        buttons: [{ label: 'Show in folder', onClick: () => api('export.reveal', r.path) }, { label: 'Done', primary: true }]
      });
    }

    function menu(src, x, y) {
      contextMenu([
        { label: 'Edit', onClick: () => window.Nav.push(Screens.addSource(src)) },
        { label: 'Download as M3U\u2026', onClick: () => downloadM3u(src) },
        { label: 'Refresh (clear cache)', onClick: async () => {
          await api('sources.refresh', src.id);
          toast(src.type === 'XTREAM' ? `Cache cleared for "${src.name}" \u2014 search index rebuilding in the background` : `Cache cleared for "${src.name}" \u2014 it'll refresh next time you open it`, 3500);
        } },
        { label: 'Delete\u2026', onClick: async () => {
          if (await confirmDialog(`Remove "${src.name}"?`, 'This also removes its favourites, starred categories, and cached data.', 'Remove')) {
            await api('sources.remove', src.id);
            refresh();
          }
        } }
      ], x, y);
    }

    async function open(src) {
      window.App.source = src;
      await api('sources.markUsed', src.id);
      window.Nav.push(Screens.categories(src)); // M3U too: its groups are the categories
    }

    grid.addEventListener('click', (e) => {
      const card = e.target.closest('.card');
      if (!card) return;
      if (card.dataset.add) { window.Nav.push(Screens.addSource()); return; }
      const src = sources.find((s) => s.id === card.dataset.id);
      if (!src) return;
      if (e.target.closest('[data-act="more"]')) { const r = e.target.getBoundingClientRect(); menu(src, r.left, r.bottom); return; }
      open(src);
    });
    grid.addEventListener('contextmenu', (e) => {
      const card = e.target.closest('.card');
      const src = card && sources.find((s) => s.id === card.dataset.id);
      if (src) { e.preventDefault(); menu(src, e.clientX, e.clientY); }
    });
    grid.addEventListener('keydown', (e) => {
      const card = e.target.closest('.card');
      const src = card && sources.find((s) => s.id === card.dataset.id);
      if (src && (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) { const r = card.getBoundingClientRect(); menu(src, r.left + 20, r.top + 40); }
    });
    enterClicks(grid);

    return {
      el, navScope: () => body,
      openSource: open, // used at startup to go straight into the source used last
      onShow() { api('session.clear'); refresh(); } // being on Home = nothing to resume
    };
  };

  // ============================== ADD / EDIT SOURCE ==============================
  Screens.addSource = function (editing) {
    let type = editing ? editing.type : 'XTREAM';
    const inp = (ph, val, t) => h('input', { class: 'input', placeholder: ph, value: val || '', type: t || 'text', spellcheck: 'false', autocomplete: 'off' });
    const name = inp('Name (optional)', editing && editing.name);
    const ua = inp('User-Agent', editing ? editing.userAgent : 'VLC/3.0.18');
    const server = inp('Server, e.g. http://host:8080', editing && editing.server);
    const user = inp('Username', editing && editing.user);
    const pass = inp('Password', editing && editing.pass, 'password');
    const m3u = inp('M3U URL (or a path to a .m3u file)', editing && editing.m3uUrl);
    const status = h('div', { class: 'field-error' });
    const xBox = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, server, user, pass);
    const mBox = h('div', null, m3u);
    const save = h('button', { class: 'btn primary', text: editing ? 'Save changes' : 'Save', onclick: doSave });
    function sync() { xBox.style.display = type === 'XTREAM' ? '' : 'none'; mBox.style.display = type === 'XTREAM' ? 'none' : ''; }
    sync();

    async function doSave() {
      status.style.color = '';
      status.textContent = 'Checking\u2026';
      save.disabled = true;
      try {
        await api('sources.save', { id: editing && editing.id, type, name: name.value, userAgent: ua.value, server: server.value, user: user.value, pass: pass.value, m3uUrl: m3u.value });
        window.Nav.pop();
      } catch (e) {
        status.textContent = e.message;
        save.disabled = false;
      }
    }
    const form = h('div', { class: 'form', onkeydown: (e) => { if (e.key === 'Enter' && isTyping(e.target)) { e.preventDefault(); doSave(); } } },
      h('h2', { text: editing ? 'Edit source' : 'Add source' }),
      editing ? null : segmented([['XTREAM', 'Xtream Codes'], ['M3U', 'M3U Playlist']], type, (v) => { type = v; sync(); }),
      name, ua, xBox, mBox, status,
      h('div', { class: 'acts', style: { display: 'flex', gap: '10px', justifyContent: 'flex-end' } }, h('button', { class: 'btn', text: 'Cancel', onclick: () => window.Nav.pop() }), save));
    const el = h('div', { class: 'screen' }, h('div', { class: 'hdr' }, backBtn()), h('div', { class: 'body center' }, form));
    return { el, onShow() { (type === 'XTREAM' ? server : m3u).focus(); } };
  };

  // ============================== CATEGORIES (Xtream) ==============================
  Screens.categories = function (source) {
    let favLists = [], all = [], starred = [], hidden = new Set(), expanded = false, reorder = false, grabbed = null, loaded = false;
    const FAV = '__FAVOURITES__';
    const search = h('input', { class: 'input', placeholder: 'Search channels\u2026 (press Enter)', spellcheck: 'false', onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } } });
    const pinned = h('div', { class: 'grid' });
    const allGrid = h('div', { class: 'grid', style: { display: 'none' } });
    const toggle = h('button', { class: 'card toggle-all', text: '\u25BC Show all categories', onclick: () => setExpanded(!expanded) });
    const recentGrid = h('div', { class: 'grid recent' });
    const recentWrap = h('div', { class: 'recent-wrap', style: { display: 'none' } }, h('div', { class: 'sec-t', text: 'Recently played' }), recentGrid); // one compact boxed row
    let recentList = [];
    // M3U only: the whole playlist as one list (no cap here, the list is virtualised).
    const showAll = source.type === 'M3U' ? h('button', { class: 'card toggle-all', text: 'Show all channels', onclick: () => openAllChannels() }) : null;
    const body = h('div', { class: 'body' }, recentWrap, pinned, showAll, toggle, allGrid);
    const reorderBtn = ibtn('reorder', 'Reorder starred categories', () => setReorder(!reorder));
    const el = h('div', { class: 'screen' },
      h('div', { class: 'hdr' }, // the source button replaces Back + the source name (it goes to the sources page too)
        sourceButton(source), h('div', { class: 'searchbox wide' }, search, ibtn('search', 'Search', doSearch)),
        h('button', { class: 'ibtn emoji', title: 'Live games', text: '\u26BD\uFE0E', onclick: () => { setReorder(false); openGames(); } }),
        reorderBtn,
        ibtn('manage', 'Manage', (ev) => { // settings-style button: last, top right
          setReorder(false);
          const r = ev.currentTarget.getBoundingClientRect();
          contextMenu([
            { label: 'Manage categories', onClick: () => window.Nav.push(Screens.manage(source, all, hidden, rebuild)) },
            { label: 'Add new favourite list', onClick: newList }
          ], r.left, r.bottom);
        })),
      body);

    const visible = () => all.filter((c) => !hidden.has(c.id));
    const cardById = (grid, id) => grid.querySelector(`[data-id="${esc(id)}"]`);
    const favCard = () => window.Cards.category('fav', null, { count: 0 });
    const listCard = (l) => window.Cards.category('favlist', l, { count: l.count });

    const countText = (n) => (n === 1 ? '1 channel' : `${n} channels`);
    // Reads the favourite lists (default first). Same set as shown -> only the counts change (focus stays put);
    // otherwise the pinned row is rebuilt.
    async function refreshFavLists(forceRebuild) {
      let lists;
      try { lists = await api('favlists.get', source.id); } catch (e) { return; }
      const extras = lists.slice(1);
      const same = !forceRebuild && extras.length === favLists.length && extras.every((l, i) => l.id === favLists[i].id && l.name === favLists[i].name);
      favLists = extras;
      if (!same) {
        const fid = pinned.contains(document.activeElement) ? document.activeElement.dataset.id : null;
        buildPinned();
        const c = fid && cardById(pinned, fid);
        if (c) c.focus({ preventScroll: true });
        return;
      }
      lists.forEach((l) => {
        const card = cardById(pinned, l.id === 'default' ? FAV : '__FL__' + l.id);
        const sub = card && card.querySelector('.sub');
        if (sub) sub.textContent = countText(l.count);
      });
    }
    const updateFavCount = () => refreshFavLists(false);
    async function newList() {
      const made = await window.FavPicker.create(source);
      if (!made) return;
      await refreshFavLists(true);
      toast(`List \u201C${made.name}\u201D created`);
      const c = cardById(pinned, '__FL__' + made.id);
      if (c) c.focus();
    }
    async function renameList(id) {
      const cur = favLists.find((l) => l.id === id);
      if (!cur) return;
      for (let name = cur.name;;) {
        name = await window.FavPicker.askName('Rename list', name);
        if (name === null) return;
        try { await api('favlists.rename', source.id, id, name); break; } catch (e) { toast(e.message, 3500); }
      }
      await refreshFavLists(true);
    }
    async function deleteList(id) {
      const cur = favLists.find((l) => l.id === id);
      if (!cur || !(await confirmDialog(`Delete \u201C${cur.name}\u201D?`, 'The list is removed. The channels stay in your other lists.', 'Delete'))) return;
      await api('favlists.delete', source.id, id);
      await refreshFavLists(true);
    }

    // The last 3 channels played on this source, most recent first, as small cards above the categories.
    async function loadRecent() {
      let l = [];
      try { l = await api('recent.get', source.id); } catch (e) { /* none */ }
      recentList = l;
      recentGrid.replaceChildren(...l.map((ch, i) => {
        const c = window.Cards.channel(ch, { fav: false });
        c.classList.add('sm'); c.tabIndex = 0; c.dataset.ri = i;
        return c;
      }));
      recentWrap.style.display = l.length ? '' : 'none';
    }
    recentGrid.addEventListener('click', (e) => {
      const c = e.target.closest('.card[data-ri]');
      if (!c) return;
      const spec = { kind: 'recent', id: '', title: 'Recently played', query: '' };
      window.App.source = source;
      window.App.list = { channels: recentList, provider: recentList, spec, title: spec.title };
      window.Nav.push(Screens.player({ index: +c.dataset.ri }));
    });
    enterClicks(recentGrid);

    function buildPinned() {
      const byId = new Map(visible().map((c) => [c.id, c]));
      pinned.replaceChildren(favCard(), ...favLists.map(listCard), ...starred.filter((id) => byId.has(id)).map((id) => window.Cards.category('pinned', byId.get(id))));
      updateFavCount();
    }
    function buildAll() {
      allGrid.replaceChildren(...visible().map((c) => window.Cards.category('cat', c, { starred: starred.includes(c.id) })));
    }
    function setExpanded(on) {
      expanded = on;
      if (on && !allGrid.children.length) buildAll();
      allGrid.style.display = on ? '' : 'none';
      toggle.textContent = on ? '\u25B2 Hide categories' : '\u25BC Show all categories';
    }
    function rebuild(newHidden) { // after Manage: the category SET may have changed -> full rebuild
      if (newHidden) hidden = new Set(newHidden);
      allGrid.replaceChildren();
      buildPinned();
      setExpanded(false);
      body.scrollTop = 0;
      pinned.firstElementChild.focus({ preventScroll: true });
    }

    async function load() {
      const d = await withProgress(() => api('categories.get', source.id), 'Failed to load categories: ');
      if (!d) return;
      all = d.categories; starred = d.starred; hidden = new Set(d.hidden); loaded = true;
      buildPinned();
      pinned.firstElementChild.focus({ preventScroll: true });
    }

    function setStarLook(card, on) {
      const s = card && card.querySelector('.star');
      if (!s) return;
      s.textContent = on ? '\u2605' : '\u2606';
      s.classList.toggle('off', !on);
    }

    async function toggleStar(id) {
      const cat = all.find((c) => c.id === id);
      if (!cat) return null;
      const now = await api('categories.toggleStar', source.id, id);
      toast(now ? 'Category starred' : 'Category unstarred');
      if (now) {
        starred.push(id);
        pinned.append(window.Cards.category('pinned', cat));
      } else {
        starred = starred.filter((x) => x !== id);
        const c = cardById(pinned, id);
        if (c) {
          const had = c === document.activeElement;
          const next = c.nextElementSibling || c.previousElementSibling;
          c.remove();
          if (had && next) next.focus(); // focus goes to whatever slides into its place, never back to the top
        }
      }
      if (expanded) setStarLook(cardById(allGrid, id), now); // same card stays, scroll never moves
      return now;
    }

    async function open(id, name, focusUrl) {
      const A = window.App, N = window.Nav;
      if (id === FAV || id.startsWith('__FL__')) {
        const listId = id === FAV ? 'default' : id.slice(6);
        const title = id === FAV ? 'Favourites' : ((favLists.find((l) => l.id === listId) || {}).name || name);
        const list = await withProgress(() => api('favourites.get', source.id, listId), 'Failed to load list: ');
        if (!list) return;
        N.push(Screens.channelList({ source, spec: { kind: 'favourites', id: listId, title }, title, provider: list, channels: list }));
        return;
      }
      const spec = { kind: 'category', id, title: name };
      const list = await withProgress(() => api('list.load', source.id, spec), 'Failed to load channels: ');
      if (!list) return;
      A.source = source;
      N.push(Screens.channelList({ source, spec, title: name, provider: list, channels: sortList(list), focusUrl }));
    }

    // Live games page; "Open category" on a game's stream results opens the category here (results stay underneath).
    function openGames() {
      window.App.source = source;
      window.Nav.push(Screens.games({
        source,
        categoryOf: (ch) => (ch.catId && all.find((c) => c.id === ch.catId)) || null,
        openCategory: (cat, ch) => open(cat.id, cat.name, ch.url)
      }));
    }

    async function openAllChannels() {
      const spec = { kind: 'm3u', id: '', title: 'All channels', query: '' };
      const list = await withProgress(() => api('list.load', source.id, spec), 'Failed to load playlist: ');
      if (!list) return;
      window.App.source = source;
      window.Nav.push(Screens.channelList({ source, spec, title: spec.title, provider: list, channels: sortList(list) }));
    }

    async function doSearch() {
      const q = search.value.trim();
      if (!q) return;
      const words = window.SearchTerms.tokens(q); // same all-words, any-order match as the channels
      const matches = visible().filter((c) => window.SearchTerms.matches(c.name, words));
      const spec = { kind: 'search', query: q, title: 'Search: ' + q };
      const list = await withProgress(() => api('list.load', source.id, spec), 'Search failed: ');
      if (!list) return;
      window.Nav.push(Screens.channelList({
        source, spec, title: spec.title, provider: list, channels: sortList(list), catMatches: matches,
        onOpenCategory: (id, name) => { window.Nav.pop(); open(id, name); },
        // star a category straight from the results (-> new state), and its current state
        isCatStarred: (id) => starred.includes(id),
        onToggleCatStar: (id) => toggleStar(id),
        // category a search hit belongs to (null if unknown / not available), and open it on that channel;
        // the results stay underneath, so Back returns to them
        categoryOf: (ch) => (ch.catId && all.find((c) => c.id === ch.catId)) || null,
        openCategoryOf: (ch, cat) => open(cat.id, cat.name, ch.url)
      }));
    }

    // ---- reorder starred categories (drag with the mouse, or Enter / arrows / Enter) ----
    function setGrabbed(id) {
      grabbed = id;
      pinned.querySelectorAll('.card.pinned').forEach((c) => {
        const on = c.dataset.id === id;
        c.classList.toggle('grabbed', on);
        const nm = c.querySelector('.nm');
        nm.textContent = (on ? '\u2195 ' : '') + nm.textContent.replace(/^\u2195 /, '');
      });
    }
    function setReorder(on) {
      if (on && pinned.querySelectorAll('.card.pinned').length < 2) { toast('Star at least two categories to reorder them'); return; }
      reorder = on;
      reorderBtn.classList.toggle('on', on);
      reorderBtn.replaceChildren(icon(on ? 'check' : 'reorder'));
      pinned.classList.toggle('reordering', on);
      pinned.querySelectorAll('.card.pinned').forEach((c) => { c.draggable = on; });
      if (!on) setGrabbed(null);
      else { toast('Reorder: drag a starred category, or press Enter to pick up, arrows to move, Enter to drop. Esc when done.', 6000); const f = pinned.querySelector('.card.pinned'); if (f) f.focus(); }
    }
    function saveOrder() {
      const shown = [...pinned.querySelectorAll('.card.pinned')].map((c) => c.dataset.id);
      starred = shown.concat(starred.filter((x) => !shown.includes(x))); // hidden ones keep their place
      api('categories.saveStarOrder', source.id, starred);
    }
    let dragEl = null;
    const clearMarks = () => pinned.querySelectorAll('.dragover-l,.dragover-r').forEach((c) => c.classList.remove('dragover-l', 'dragover-r'));
    pinned.addEventListener('dragstart', (e) => {
      const c = e.target.closest('.card.pinned');
      if (!reorder || !c) { e.preventDefault(); return; }
      dragEl = c; c.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', c.dataset.id);
    });
    pinned.addEventListener('dragover', (e) => {
      const c = e.target.closest('.card.pinned');
      if (!dragEl || !c || c === dragEl) return;
      e.preventDefault(); clearMarks();
      const r = c.getBoundingClientRect();
      c.classList.add(e.clientX > r.left + r.width / 2 ? 'dragover-r' : 'dragover-l');
    });
    pinned.addEventListener('drop', (e) => {
      const c = e.target.closest('.card.pinned');
      if (!dragEl || !c || c === dragEl) return;
      e.preventDefault();
      const r = c.getBoundingClientRect();
      pinned.insertBefore(dragEl, e.clientX > r.left + r.width / 2 ? c.nextSibling : c);
      saveOrder();
    });
    pinned.addEventListener('dragend', () => { clearMarks(); if (dragEl) dragEl.classList.remove('dragging'); dragEl = null; });

    function moveGrabbed(card, key) {
      const kids = [...pinned.children];
      const idx = kids.indexOf(card);
      const cols = Math.max(1, getComputedStyle(pinned).gridTemplateColumns.split(' ').length);
      const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[key];
      const t = Math.max(Math.max(1, kids.findIndex((k) => k.classList.contains('pinned'))), Math.min(kids.length - 1, idx + delta)); // Favourites + lists stay first
      if (t === idx) return;
      pinned.insertBefore(card, t > idx ? kids[t].nextSibling : kids[t]);
      saveOrder();
      card.focus();
      card.scrollIntoView({ block: 'nearest' });
    }

    body.addEventListener('click', (e) => {
      const card = e.target.closest('.card[data-id]');
      if (!card) return;
      const id = card.dataset.id;
      if (e.target.closest('[data-act="star"]')) { e.stopPropagation(); toggleStar(id); return; }
      if (reorder) return;
      open(id, (card.title || '').trim() || id);
    });
    body.addEventListener('contextmenu', (e) => {
      const card = e.target.closest('.card[data-id]');
      if (!card || card.dataset.id === FAV) return;
      e.preventDefault();
      if (card.dataset.id.startsWith('__FL__')) {
        const id = card.dataset.id.slice(6);
        contextMenu([{ label: 'Rename\u2026', onClick: () => renameList(id) }, { label: 'Delete\u2026', onClick: () => deleteList(id) }], e.clientX, e.clientY);
      } else toggleStar(card.dataset.id);
    });
    enterClicks(body);

    return {
      el, navScope: () => body,
      onShow() {
        window.App.source = source;
        api('session.save', { screen: 'categories', sourceId: source.id });
        loadRecent(); // may have changed after playing something
        if (loaded) updateFavCount(); // favourites may have changed in a channel list
        else load();
      },
      onBack() { if (reorder) { setReorder(false); return true; } return false; },
      onKey(e) {
        if (!reorder) return false;
        const a = document.activeElement;
        const card = a && a.closest && a.closest('.card.pinned');
        if (e.key === 'Enter' || e.key === ' ') {
          if (card) { e.preventDefault(); setGrabbed(grabbed ? null : card.dataset.id); return true; }
          if (a && a.closest && a.closest('.card.fav')) { e.preventDefault(); toast('Only starred categories can be reordered'); return true; }
          return false;
        }
        if (grabbed && card && /^Arrow/.test(e.key)) { e.preventDefault(); moveGrabbed(card, e.key); return true; }
        return false;
      }
    };
  };

  // ============================== MANAGE CATEGORIES ==============================
  Screens.manage = function (source, categories, hiddenInit, onDone) {
    const hidden = new Set(hiddenInit);
    const persist = () => api('categories.setHidden', source.id, [...hidden]);
    const rows = categories.map((c) => h('div', { class: 'row', tabindex: '0', data: { id: c.id } },
      h('span', { class: 'chk', text: hidden.has(c.id) ? '\u2610' : '\u2611' }), h('span', { text: c.name })));
    const body = h('div', { class: 'body' }, rows.length ? rows : h('div', { class: 'empty-note', text: 'No categories' }));
    const setAll = (visible) => {
      hidden.clear();
      if (!visible) categories.forEach((c) => hidden.add(c.id));
      rows.forEach((r) => { r.querySelector('.chk').textContent = visible ? '\u2611' : '\u2610'; });
      persist();
    };
    body.addEventListener('click', (e) => {
      const r = e.target.closest('.row');
      if (!r) return;
      const id = r.dataset.id;
      if (hidden.has(id)) hidden.delete(id); else hidden.add(id);
      r.querySelector('.chk').textContent = hidden.has(id) ? '\u2610' : '\u2611'; // in place: scroll + focus stay
      persist();
    });
    enterClicks(body);
    const el = h('div', { class: 'screen' },
      h('div', { class: 'hdr' }, backBtn(), h('h1', { text: 'Manage categories' }), h('div', { class: 'grow' }),
        h('button', { class: 'btn', text: 'Select all', onclick: () => setAll(true) }),
        h('button', { class: 'btn', text: 'Clear all', onclick: () => setAll(false) })),
      body);
    return { el, navScope: () => body, onShow() { if (rows[0]) rows[0].focus({ preventScroll: true }); }, onHide() { onDone(hidden); } };
  };

  // ============================== SETTINGS DIALOG ==============================
  const SHIFT_STEP = 30, SHIFT_MAX = 720; // minutes
  function fmtShift(min) {
    if (!min) return 'Off (0)';
    const a = Math.abs(min), hh = Math.floor(a / 60), mm = a % 60;
    return (min > 0 ? '+' : '\u2212') + (hh ? hh + 'h' : '') + (hh && mm ? ' ' : '') + (mm ? mm + 'm' : '');
  }

  // EPG shift for one playlist: minutes added to every programme time (+ later, \u2212 earlier).
  function epgShiftRow(source) {
    let val = 0, saving = Promise.resolve();
    const label = h('span', { class: 'shift-val', text: '\u2026' });
    const render = () => { label.textContent = fmtShift(val); label.classList.toggle('on', val !== 0); minus.disabled = val <= -SHIFT_MAX; plus.disabled = val >= SHIFT_MAX; reset.disabled = val === 0; };
    const change = (next) => {
      val = Math.max(-SHIFT_MAX, Math.min(SHIFT_MAX, next));
      render();
      saving = saving.then(() => api('epgShift.set', source.id, val)).catch(() => {}); // saved in order, applied to this playlist only
    };
    const minus = h('button', { class: 'btn', title: 'Earlier (programmes move earlier)', 'aria-label': 'Shift EPG earlier', text: '\u2212', onclick: () => change(val - SHIFT_STEP) });
    const plus = h('button', { class: 'btn', title: 'Later (programmes move later)', 'aria-label': 'Shift EPG later', text: '+', onclick: () => change(val + SHIFT_STEP) });
    const reset = h('button', { class: 'btn', text: 'Reset', onclick: () => change(0) });
    minus.disabled = plus.disabled = reset.disabled = true;
    api('epgShift.get', source.id).then((v) => { val = Number(v) || 0; render(); }).catch(() => { label.textContent = '?'; });
    return h('div', { class: 'setrow' },
      h('div', { class: 'k', text: 'EPG shift (this playlist only, 30 min steps)' }),
      h('div', { class: 'shift' }, minus, label, plus, reset));
  }

  function openSettings({ showSort, onSort, source }) {
    const A = window.App;
    const body = h('div', null);
    if (showSort) {
      body.append(h('div', { class: 'setrow' }, h('div', { class: 'k', text: 'Sort channels' }),
        segmented([['default', 'Default'], ['az', 'Alphabetical']], A.ui.channelSort || 'default', (v) => { A.setUi({ channelSort: v }); onSort(v); })));
    }
    body.append(
      h('div', { class: 'setrow' }, h('div', { class: 'k', text: 'Channel card style' }),
        segmented([['badge', 'Badge'], ['marker', 'Marker'], ['colorwash', 'Wash']], A.ui.channelTheme || 'marker', (v) => A.setUi({ channelTheme: v }))),
      h('div', { class: 'setrow' }, h('div', { class: 'k', text: 'App colours' }),
        segmented([['ember', 'Ember'], ['cool_water', 'Cool Water'], ['mist', 'Mist'], ['paper', 'Paper']], A.ui.appColors || 'ember', (v) => A.setUi({ appColors: v }))));
    if (source && source.type === 'XTREAM') body.append(epgShiftRow(source)); // M3U sources have no EPG
    dialog({ title: 'Settings', body, buttons: [{ label: 'Done', primary: true }] });
  }

  // ============================== PROGRAMME GUIDE (Xtream) ==============================
  // One row per channel: Now / Next / After next. Rows load top to bottom (2 requests at a time, rows
  // on screen jump the queue when you scroll). Click a row to watch; Back returns here.
  Screens.guide = function ({ source, title, channels, sessionSpec, onPlay, getLastPlayed }) {
    const fmt = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const data = new Map();          // url -> { pending } | { e: {now,next,after}|null, at }
    let stopped = false, workers = 0, tick = 0, firstShow = true;
    const status = h('span', { class: 'count' });

    function cell(d, key) {
      if (!d || d.pending) return h('div', { class: 'g-cell dim', text: '\u2026' });
      const p = d.e && d.e[key];
      if (!p) return h('div', { class: 'g-cell dim', text: key === 'now' ? 'No programme info' : '\u2014' });
      const kids = [h('div', { class: 't', text: `${fmt(p.start)}\u2013${fmt(p.stop)}` }), h('div', { class: 'p', text: p.title })];
      if (key === 'now') {
        const pct = Math.max(0, Math.min(100, ((Date.now() - p.start) / (p.stop - p.start)) * 100));
        kids.push(h('div', { class: 'bar' }, h('i', { style: { width: pct.toFixed(0) + '%' } })));
      }
      return h('div', { class: 'g-cell', title: `${fmt(p.start)}\u2013${fmt(p.stop)}  ${p.title}` }, kids);
    }

    const grid = new window.VirtualGrid({
      itemHeight: 66, gap: 6, columns: 1,
      render: (ch) => {
        const p = window.Cards.parsed(ch);
        const d = data.get(ch.url);
        const tags = [];
        if (p.country) tags.push(h('span', { class: 'chip', text: p.country }));
        if (p.quality) tags.push(h('span', { class: 'chip q', text: p.quality }));
        return h('div', { class: 'card g-row', title: ch.name },
          h('div', { class: 'g-ch' }, h('div', { class: 'nm', text: p.displayName }), tags.length ? h('div', { class: 'tags' }, tags) : null),
          cell(d, 'now'), cell(d, 'next'), cell(d, 'after'));
      },
      onClick: (ch, i) => onPlay(i)
    });

    const needs = (i) => !data.has(channels[i].url);
    function pick() {
      const n = channels.length;
      const lo = Math.max(0, grid.range[0]), hi = Math.min(n - 1, grid.range[1]); // one column: row index = item index
      for (let i = lo; i <= hi; i++) if (needs(i)) return i;
      for (let i = 0; i < n; i++) if (needs(i)) return i;
      return -1;
    }
    function updateStatus() {
      let done = 0;
      for (const d of data.values()) if (!d.pending) done++;
      status.textContent = done >= channels.length ? `${channels.length} channels` : `Loading ${done} / ${channels.length}`;
    }
    async function worker() {
      while (!stopped) {
        const i = pick();
        if (i < 0) break;
        const ch = channels[i];
        data.set(ch.url, { pending: true });
        let e = null;
        try { e = await api('epg.get', source.id, ch.url); } catch (err) { /* channel without EPG */ }
        if (stopped) return;
        data.set(ch.url, { e, at: Date.now() });
        grid.refreshIndex(i); // no-op when the row is not on screen
        updateStatus();
      }
      workers--;
    }
    function pump() { while (!stopped && workers < 2 && pick() >= 0) { workers++; worker(); } }

    grid.el.addEventListener('scroll', debounce(pump, 120));
    // Once a minute: move the "now" bars along and re-fetch rows whose programme just ended.
    tick = setInterval(() => {
      const t = Date.now();
      for (const [url, d] of data) {
        if (d.pending) continue;
        if (d.e && d.e.now ? d.e.now.stop <= t : t - d.at > 5 * 60 * 1000) data.delete(url);
      }
      grid.refresh();
      pump();
    }, 60000);

    const head = h('div', { class: 'g-head' }, h('div', { text: 'Channel' }), h('div', { text: 'Now' }), h('div', { text: 'Next' }), h('div', { text: 'After next' }));
    const el = h('div', { class: 'screen' },
      h('div', { class: 'hdr' }, backBtn(), h('h1', { text: 'Guide \u00B7 ' + title }), status),
      head, grid.el);

    return {
      el,
      onShow() {
        window.App.source = source;
        api('session.save', { screen: 'channels', sourceId: source.id, spec: sessionSpec }); // restart lands on the list
        if (firstShow) {
          firstShow = false;
          grid.setItems(channels);
          updateStatus();
          pump();
          if (channels.length) setTimeout(() => grid.focusIndex(0), 0);
        } else {
          grid.refresh();
          const lp = getLastPlayed();
          if (lp >= 0) setTimeout(() => grid.focusIndex(lp), 0); // back from the player: focus what was playing
        }
      },
      destroy() { stopped = true; clearInterval(tick); }
    };
  };

  // ============================== CHANNEL LIST ==============================
  // opts: { source, spec:{kind,id?,query?,title}, title, provider (provider order), channels (as shown),
  //         catMatches?, onOpenCategory? }.  Favourites: provider === channels (one shared, reorderable list).
  Screens.channelList = function (opts) {
    const { source, spec, title } = opts;
    const isFav = spec.kind === 'favourites';
    const isSearch = spec.kind === 'search';
    const sessionSpec = { kind: spec.kind, id: spec.id || '', title: spec.title || title, query: spec.query || '' };
    let provider = opts.provider;
    let sorted = isFav ? opts.channels.slice() : opts.channels; // favourites: own mutable copy shared with the player
    let view = sorted;
    let favSet = new Set(), listCount = 1;
    const curList = isFav ? (spec.id || 'default') : 'default'; // the favourite list being shown (quick remove)
    let lastPlayed = -1, reorder = false, grabbedUrl = null, dragFrom = -1, firstShow = true, query = '';

    const count = h('span', { class: 'count' });
    const updateCount = () => { count.textContent = `${view.length.toLocaleString()} channel${view.length === 1 ? '' : 's'}`; };

    const catOf = (ch) => (isSearch && opts.categoryOf ? opts.categoryOf(ch) : null);

    const grid = new window.VirtualGrid({
      itemHeight: 68, gap: 8, minColWidth: 300,
      render: (ch, i) => window.Cards.channel(ch, { fav: favSet.has(ch.url), prefix: grabbedUrl === ch.url ? '\u2195 ' : '', grabbed: grabbedUrl === ch.url }),
      draggable: () => reorder,
      onClick: (ch, i, act) => {
        if (act === 'star') { toggleFav(ch, i); return; }
        if (reorder) { if (act === 'activate') setGrabbed(grabbedUrl ? null : ch.url); return; }
        play(i);
      },
      onContext: (ch, i, e) => contextMenu([
        { label: 'Play', onClick: () => play(i) },
        { label: listCount > 1 ? 'Favourite lists\u2026' : favSet.has(ch.url) ? 'Remove from Favourites' : 'Add to Favourites', onClick: () => toggleFav(ch, i) },
        { label: 'Add to EZ List\u2026', onClick: () => addToEz(ch) },
        ...(catOf(ch) ? [{ label: 'Open category', onClick: () => opts.openCategoryOf(ch, catOf(ch)) }] : [])
      ], e.clientX, e.clientY),
      beforeKey: (e, ch, i) => {
        if (reorder && grabbedUrl && /^Arrow/.test(e.key)) {
          const cols = grid.cols;
          const t = { ArrowLeft: i - 1, ArrowRight: i + 1, ArrowUp: i - cols, ArrowDown: i + cols }[e.key];
          if (t >= 0 && t < sorted.length && t !== i) moveFav(i, t);
          e.preventDefault();
          return true;
        }
        return false;
      },
      onKey: (e, ch, i) => {
        if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleFav(ch, i); }
        else if (e.key === 'e' || e.key === 'E') { e.preventDefault(); addToEz(ch); }
        else if ((e.key === 'g' || e.key === 'G') && guideBtn) { e.preventDefault(); openGuide(); }
      }
    });

    const filterInput = h('input', { class: 'input', placeholder: 'Filter this list\u2026 (Ctrl+F)', spellcheck: 'false', style: { maxWidth: '260px' } });
    const applyFilter = () => {
      view = query ? sorted.filter((c) => c.name.toLowerCase().includes(query)) : sorted;
      grid.setItems(view);
      updateCount();
    };
    filterInput.addEventListener('input', debounce(() => { query = filterInput.value.trim().toLowerCase(); applyFilter(); }, 120));
    filterInput.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); grid.focusIndex(0); }
    });

    const reorderBtn = isFav ? ibtn('reorder', 'Reorder favourites', () => setReorder(!reorder)) : null;
    const guideBtn = source.type === 'XTREAM'
      ? h('button', { class: 'ibtn txt', title: 'Programme guide (G)', 'aria-label': 'Programme guide', text: 'G', onclick: () => openGuide() })
      : null;
    const refreshBtn = isSearch && source.type === 'XTREAM' ? ibtn('refresh', 'Rebuild the search index and search again', refreshSearch) : null;
    const catStrip = opts.catMatches && opts.catMatches.length
      ? h('div', { class: 'grid', style: { padding: '2px 18px 8px', flex: '0 0 auto', maxHeight: '34%', overflowY: 'auto' } },
        opts.catMatches.map((c) => window.Cards.category('result', c, { starred: !!(opts.isCatStarred && opts.isCatStarred(c.id)) })))
      : null;
    if (catStrip) {
      catStrip.addEventListener('click', async (e) => {
        const c = e.target.closest('.card[data-id]');
        if (!c) return;
        if (e.target.closest('[data-act="star"]')) { // star / unstar the category, stay on the results
          e.stopPropagation();
          if (!opts.onToggleCatStar) return;
          const now = await opts.onToggleCatStar(c.dataset.id);
          const st = c.querySelector('.star');
          if (st && now !== null && now !== undefined) { st.textContent = now ? '\u2605' : '\u2606'; st.classList.toggle('off', !now); }
          return;
        }
        if (opts.onOpenCategory) opts.onOpenCategory(c.dataset.id, c.title);
      });
      enterClicks(catStrip);
    }
    const el = h('div', { class: 'screen' },
      h('div', { class: 'hdr' }, backBtn(), h('h1', { text: title }), count, h('div', { class: 'grow' }),
        isFav ? null : filterInput, refreshBtn, reorderBtn, guideBtn,
        ibtn('gear', 'Settings', () => openSettings({ showSort: !isFav, onSort, source })),),
      catStrip, grid.el);

    // ---- actions ----
    function openGuide() {
      if (!view.length) { toast('No channels to show'); return; }
      window.Nav.push(Screens.guide({ source, title, channels: view, sessionSpec, onPlay: (i) => play(i), getLastPlayed: () => lastPlayed }));
    }
    function play(i) {
      lastPlayed = i;
      window.App.list = { channels: view, provider, spec: sessionSpec, title };
      window.Nav.push(Screens.player({ index: i }));
    }

    function toggleFav(ch, i) {
      return window.FavPicker.show(source, ch, {
        firstListId: curList,
        onChanged: async (listId, added) => {
          favSet = new Set(await api('favourites.allUrls', source.id)); // a star = in any list
          if (isFav && listId === curList && !added) {
            const k = sorted.findIndex((c) => c.url === ch.url);
            if (k >= 0) sorted.splice(k, 1); // removed in place: scroll position stays
            view = sorted;
            grid.setItems(view, true);
            updateCount();
            if (view.length) grid.focusIndex(Math.min(i, view.length - 1));
            else if (reorderBtn) reorderBtn.focus();
          } else {
            grid.refreshIndex(i);
          }
        }
      });
    }

    async function addToEz(ch) {
      const slots = await api('ez.get', source.id);
      const labels = slots.map((s, i) => `Slot ${i + 1}: ${s ? s.name : '(empty)'}`);
      const idx = await choose(`Add "${ch.name}" to EZ List`, labels);
      if (idx === null) return;
      await api('ez.set', source.id, idx, plain(ch));
      toast(`Added to EZ List slot ${idx + 1}`);
    }

    function onSort(mode) {
      sorted = window.ChannelSort.apply(mode, provider);
      lastPlayed = -1;
      applyFilter();
      grid.focusIndex(0);
    }

    async function refreshSearch() {
      const r = await withProgress(() => api('list.refreshSearch', source.id, spec.query), 'Refresh failed: ');
      if (!r) return;
      provider = r;
      sorted = sortList(r);
      lastPlayed = -1;
      applyFilter();
      toast(`Search refreshed: ${r.length} channels`);
      grid.focusIndex(0);
    }

    // ---- favourites reorder ----
    function setGrabbed(url) { grabbedUrl = url; grid.refresh(); }
    function setReorder(on) {
      if (on && sorted.length < 2) { toast('Add at least two favourites to reorder them'); return; }
      reorder = on;
      reorderBtn.classList.toggle('on', on);
      reorderBtn.replaceChildren(icon(on ? 'check' : 'reorder'));
      if (!on) grabbedUrl = null;
      else toast('Reorder: drag a channel, or press Enter to pick up, arrows to move, Enter to drop. Esc when done.', 6000);
      grid.refresh();
      if (on) grid.focusIndex(0);
    }
    function moveFav(from, to) {
      sorted.splice(to, 0, sorted.splice(from, 1)[0]);
      view = sorted;
      api('favourites.saveOrder', source.id, sorted.map(plain), curList);
      grid.setItems(view, true);
      grid.focusIndex(to);
    }
    grid.el.addEventListener('dragstart', (e) => {
      const c = e.target.closest('[data-i]');
      if (!reorder || !c) { e.preventDefault(); return; }
      dragFrom = +c.dataset.i;
      e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(dragFrom));
    });
    grid.el.addEventListener('dragover', (e) => { if (dragFrom >= 0) e.preventDefault(); });
    grid.el.addEventListener('drop', (e) => {
      const c = e.target.closest('[data-i]');
      if (dragFrom < 0 || !c) return;
      e.preventDefault();
      const to = +c.dataset.i;
      if (to !== dragFrom) moveFav(dragFrom, to);
      dragFrom = -1;
    });
    grid.el.addEventListener('dragend', () => { dragFrom = -1; });

    return {
      el,
      onFind() { if (!isFav) filterInput.focus(); },
      onBack() { if (reorder) { setReorder(false); return true; } return false; },
      async onShow() {
        const A = window.App;
        A.source = source;
        A.list = { channels: view, provider, spec: sessionSpec, title };
        api('session.save', { screen: 'channels', sourceId: source.id, spec: sessionSpec });
        favSet = new Set(await api('favourites.allUrls', source.id)); // may have changed in the player
        listCount = (await api('favlists.get', source.id)).length;
        if (firstShow) {
          firstShow = false;
          grid.setItems(view);
          updateCount();
          const at = opts.focusUrl ? view.findIndex((c) => c.url === opts.focusUrl) : -1; // "Open category": land on that channel
          if (view.length) setTimeout(() => grid.focusIndex(at >= 0 ? at : 0, at >= 0), 0);
        } else {
          grid.refresh();
          if (lastPlayed >= 0) setTimeout(() => grid.focusIndex(lastPlayed), 0); // back from the player: focus what was playing
        }
      }
    };
  };
})();
