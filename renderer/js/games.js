// Games page (port of GamesActivity / GameAdapter): Live tab (everything on now) and Upcoming tab
// (Today / Tomorrow / Next 7 days, league picker on the left). Everything is fetched once (and on Refresh);
// switching tabs, days or leagues just re-filters memory. Enter on a live game searches the playlist for its stream.
(function () {
  'use strict';
  const { h, api, ibtn, toast, progress, withProgress, segmented, hueOf, isTyping } = window.UI;

  const REFRESH_MS = 90000, FULL_REFRESH_MS = 15 * 60000;
  const timeFmt = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
  const dayFmt = new Intl.DateTimeFormat([], { weekday: 'short' });
  const startOfDay = (off) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + off); return d.getTime(); };
  const sortList = (l) => window.ChannelSort.apply(window.App.ui.channelSort || 'default', l);
  const keyOf = (g) => g.league + ':' + g.id;
  const initials = (t) => {
    const a = (t.abbr || '').trim();
    if (a) return a.slice(0, 3).toUpperCase();
    return t.name.split(' ').filter(Boolean).slice(0, 3).map((w) => w[0]).join('').toUpperCase();
  };

  // opts: { source, categoryOf?(ch) -> category|null, openCategory?(cat, ch) }
  window.Screens.games = function (opts) {
    const { source } = opts;
    const durOf = (id) => (leagues.find((l) => l.id === id) || {}).dur || 120;
    const inWindow = (g, now) => window.GameWindow.inLiveWindow(g, now, durOf(g.league)); // needs this screen's leagues
    let leagues = [], byKey = new Map(), tab = 'live', day = 'today', leagueFilter = null;
    let failed = 0, backup = [], lastError = null, everLoaded = false, loadingMore = false;
    let updatedAt = 0, fullLoadedAt = 0, token = 0, started = false, lastKey = null, shown = [];

    const tabsEl = h('div', { class: 'gm-tabs' });
    const daysEl = h('div', { class: 'gm-days' });
    const upd = h('span', { class: 'count gm-upd' });
    const leagueBox = h('div', { class: 'gm-leagues' });
    const grid = h('div', { class: 'grid games' });
    const note = h('div', { class: 'empty-note' });
    const main = h('div', { class: 'gm-main' }, grid, note);
    let tabSeg, daySeg;
    const el = h('div', { class: 'screen' },
      h('div', { class: 'hdr' }, ibtn('back', 'Back (Esc)', () => window.Nav.back()), h('h1', { text: '\u26BD\uFE0E Games' }), tabsEl, daysEl, h('div', { class: 'grow' }), upd,
        ibtn('refresh', 'Refresh', () => load(false))),
      h('div', { class: 'gm-wrap' }, leagueBox, main));

    tabSeg = segmented([['live', 'Live'], ['upcoming', 'Upcoming']], tab, (v) => { tab = v; render(true); });
    daySeg = segmented([['today', 'Today'], ['tomorrow', 'Tomorrow'], ['week', 'Next 7 days']], day, (v) => { day = v; render(true); });
    tabsEl.append(tabSeg); daysEl.append(daySeg);

    // Live tab = 30 min before kick-off until 30 min after the end; the same window is when a stream can be searched.
    const liveGames = () => { const now = Date.now(); return [...byKey.values()].filter((g) => inWindow(g, now)); };
    const searchable = (g) => inWindow(g, Date.now());

    function card(g, i) {
      const lg = leagues.find((l) => l.id === g.league);
      const can = searchable(g);
      const mins = Math.floor((g.startMs - Date.now()) / 60000);
      const t = timeFmt.format(new Date(g.startMs));
      const status = g.finished ? h('span', { class: 'gm-time gm-ended', text: 'ENDED' })
        : g.live ? h('span', { class: 'gm-live', text: '\u25CF LIVE' })
        : h('span', { class: 'gm-time', text: mins >= 1 && mins <= 59 ? `${t} \u00B7 in ${mins} min` : (tab === 'upcoming' && day === 'week' ? dayFmt.format(new Date(g.startMs)) + ' ' : '') + t });
      const team = (tm) => h('div', { class: 'gm-team' },
        h('div', { class: 'gm-badge', text: initials(tm), style: { background: `hsl(${hueOf(tm.name)} 38% 40%)` } }),
        h('div', { class: 'gm-name', text: tm.name }));
      return h('div', { class: 'card game', tabindex: '0', data: { key: keyOf(g), i }, title: can ? 'Enter: find a stream in this playlist' : '' },
        h('div', { class: 'gm-top' }, h('div', { class: 'gm-lg', text: (lg ? lg.label : g.league).toUpperCase() + (can ? '  \u00B7  Enter: find stream' : '') }), status),
        team(g.home), team(g.away));
    }

    function render(resetScroll) {
      const now = Date.now();
      const order = new Map(leagues.map((l, i) => [l.id, i]));
      const live = liveGames().sort((a, b) => (order.get(a.league) - order.get(b.league)) || (a.startMs - b.startMs));
      let empty;
      if (tab === 'live') {
        shown = live;
        empty = 'No games are live or about to start.\nOpen Upcoming to see what is next.';
      } else {
        const from = day === 'tomorrow' ? startOfDay(1) : now - 15 * 60000;
        const to = day === 'today' ? startOfDay(1) : day === 'tomorrow' ? startOfDay(2) : startOfDay(8);
        const inRange = [...byKey.values()].filter((g) => !g.live && !g.finished && !inWindow(g, now) && g.startMs >= from && g.startMs < to).sort((a, b) => a.startMs - b.startMs);
        shown = leagueFilter ? inRange.filter((g) => g.league === leagueFilter) : inRange;
        for (const row of leagueBox.children) {
          const id = row.dataset.id || null;
          const n = id ? inRange.filter((g) => g.league === id).length : inRange.length;
          const label = id ? leagues.find((l) => l.id === id).label : 'All leagues';
          row.textContent = n ? `${label}  \u00B7  ${n}` : label;
          row.classList.toggle('sel', id === leagueFilter);
        }
        const where = leagueFilter ? leagues.find((l) => l.id === leagueFilter).label + ' games' : 'games';
        empty = day === 'today' ? `No more ${where} today.\nTry Tomorrow or Next 7 days.` : day === 'tomorrow' ? `No ${where} tomorrow.\nTry Next 7 days.` : `No ${where} in the next 7 days.`;
      }
      tabSeg.children[0].textContent = live.length ? `Live \u00B7 ${live.length}` : 'Live';
      tabSeg.children[0].classList.toggle('on', tab === 'live');
      tabSeg.children[1].classList.toggle('on', tab === 'upcoming');
      [...daySeg.children].forEach((b, i) => b.classList.toggle('on', ['today', 'tomorrow', 'week'][i] === day));
      daysEl.style.display = leagueBox.style.display = tab === 'upcoming' ? '' : 'none';

      const fk = grid.contains(document.activeElement) ? document.activeElement.dataset.key : null;
      grid.replaceChildren(...shown.map(card));
      if (resetScroll) main.scrollTop = 0;
      if (fk) { const c = [...grid.children].find((x) => x.dataset.key === fk); if (c) c.focus({ preventScroll: true }); }

      const allFailed = failed >= leagues.length && leagues.length > 0;
      note.textContent = allFailed && !everLoaded ? 'Couldn\u2019t load games.\nCheck the connection and choose Refresh.' + (lastError ? `\n\n(${lastError})` : '') : empty;
      note.style.display = shown.length && !(allFailed && !everLoaded) ? 'none' : '';
      const u = 'Updated ' + timeFmt.format(new Date(updatedAt));
      upd.textContent = !everLoaded ? '' : failed > 0 ? `${u} \u00B7 ${failed} of ${leagues.length} leagues unavailable`
        : backup.length ? `${u} \u00B7 backup source for ${backup.join(', ')} (shorter window, live status may lag)`
        : loadingMore ? `${u} \u00B7 loading the rest of the week\u2026` : u;
    }

    // Phase 1 (yesterday..tomorrow) fills the page fast, phase 2 adds the rest of the week.
    async function load(silent) {
      const my = ++token;
      loadingMore = true;
      if (!silent) progress(true);
      let near;
      try { near = await api('sports.near'); }
      catch (e) { near = { games: [], failed: leagues.length, backup: [], error: e.message, okLeagues: [] }; }
      if (!silent) progress(false);
      if (my !== token) return;
      failed = near.failed; backup = near.backup; lastError = near.error;
      if (near.failed < leagues.length) {
        const old = byKey;
        byKey = new Map(near.games.map((g) => [keyOf(g), g]));
        for (const [k, g] of byKey) { const o = old.get(k); if (o && o.endedAt && g.finished) g.endedAt = o.endedAt; }
        everLoaded = true; updatedAt = Date.now();
      }
      render();
      if (near.okLeagues.length) {
        let rest = null;
        try { rest = await api('sports.rest', near.okLeagues); } catch (e) { /* keep phase 1 */ }
        if (my !== token) return;
        if (rest) rest.games.forEach((g) => byKey.set(keyOf(g), g));
      }
      loadingMore = false; fullLoadedAt = Date.now();
      render();
    }

    // Light refresh of what is live (7 small requests): replaces live/today info, keeps the rest.
    async function refreshLive() {
      if (loadingMore) return;
      let fresh = null;
      try { fresh = await api('sports.live'); } catch (e) { return; }
      if (!fresh || loadingMore) return;
      const now = Date.now();
      const keys = new Set(fresh.map(keyOf));
      for (const [k, g] of [...byKey]) {
        if (g.live && !keys.has(k)) { g.live = false; g.finished = true; g.endedAt = now; } // fell off the scoreboard = it ended
      }
      for (const g of fresh) {
        const o = byKey.get(keyOf(g));
        if (g.finished) g.endedAt = (o && o.endedAt) || (o && o.live ? now : undefined); // seen live, now finished = ended just now
        byKey.set(keyOf(g), g);
      }
      updatedAt = Date.now();
      render();
    }

    async function findStreams(g) {
      const r = await withProgress(() => api('sports.find', source.id, g), 'Search failed: ');
      if (r === undefined) return; // error toast already shown
      if (!r) { toast(`No streams found for ${g.home.name} vs ${g.away.name} in ${source.name}`, 4500); return; }
      window.App.source = source;
      const spec = { kind: 'search', query: r.firstQuery, title: 'Search: ' + r.label };
      toast(`Showing results for \u201C${r.label}\u201D`, 3500);
      window.Nav.push(window.Screens.channelList({
        source, spec, title: spec.title, provider: r.channels, channels: sortList(r.channels),
        categoryOf: opts.categoryOf, openCategoryOf: opts.openCategory
      }));
    }

    grid.addEventListener('click', (e) => {
      const c = e.target.closest('.card.game');
      if (!c) return;
      const g = byKey.get(c.dataset.key);
      if (!g) return;
      lastKey = c.dataset.key;
      if (searchable(g)) findStreams(g);
      else toast('Streams can be searched once the game is live or about to start (within 30 min)');
    });
    el.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.card, .row') && !isTyping(e.target)) { e.preventDefault(); e.target.click(); }
    });

    // League picker: "All leagues" + one row per league (built from the list, so a new league needs no change here).
    function buildLeagues() {
      const mk = (id) => h('div', { class: 'row', tabindex: '0', data: id ? { id } : null, onclick: () => { leagueFilter = id; render(true); } });
      leagueBox.replaceChildren(mk(null), ...leagues.map((l) => mk(l.id)));
    }

    const focusFirst = () => {
      const c = grid.firstElementChild;
      if (c) c.focus({ preventScroll: true }); else tabSeg.children[tab === 'live' ? 0 : 1].focus({ preventScroll: true });
    };
    // Also on the Upcoming tab: games move into / out of the Live window as time passes.
    const timer = setInterval(() => { if (window.Nav.top() === screen && everLoaded) refreshLive(); }, REFRESH_MS);

    const screen = {
      el,
      navScope: () => el,
      async onShow() {
        if (!started) {
          started = true;
          try { leagues = await api('sports.leagues'); } catch (e) { leagues = []; }
          buildLeagues(); render(); load(false); focusFirst();
          return;
        }
        // Coming back after a while: don't show stale games.
        if (everLoaded && Date.now() - fullLoadedAt > FULL_REFRESH_MS) load(true);
        else if (everLoaded && Date.now() - updatedAt > REFRESH_MS) refreshLive();
        const c = lastKey && [...grid.children].find((x) => x.dataset.key === lastKey);
        if (c) c.focus({ preventScroll: true }); else focusFirst();
      },
      destroy() { clearInterval(timer); token++; }
    };
    return screen;
  };
})();
