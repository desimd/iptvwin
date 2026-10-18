// Card builders. Channel cards follow the Android item_channel layout: clean name, small country /
// quality chips (row keeps its height when empty so the grid stays aligned), and a star.
// Card style (badge / marker / wash) is pure CSS keyed on <html data-theme>.
(function () {
  'use strict';
  const { h, hueOf } = window.UI;

  // Brand code: 3-4 letter first word as is (BBC, GEO), longer -> first 3 letters, 1-2 letters -> initials.
  function brandOf(name) {
    const words = name.split(' ').filter(Boolean);
    const first = words[0];
    if (!first) return { code: '', hue: 0 };
    let code;
    if (first.length >= 3 && first.length <= 4) code = first;
    else if (first.length >= 5) code = first.slice(0, 3);
    else code = words.slice(0, 2).map((w) => w.slice(0, 1)).join('');
    code = code.toUpperCase();
    return { code, hue: hueOf(code) };
  }

  function initialsOf(name) {
    const words = name.split(/[ \-|:.]/).filter((w) => w && /[\p{L}\p{N}]/u.test(w[0]));
    if (!words.length) return '?';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
  }

  const parsed = (ch) => ch._p || (ch._p = window.ChannelNameParser.parse(ch.name));

  const starBtn = (on) => h('button', { class: 'star' + (on ? '' : ' off'), 'data-act': 'star', tabindex: '-1', title: on ? 'Remove from Favourites' : 'Add to Favourites', text: on ? '\u2605' : '\u2606' });

  // opts: { fav:boolean, prefix:string, grabbed:boolean }
  function channel(ch, opts) {
    const p = parsed(ch);
    const brand = brandOf(p.displayName);
    const sp = p.displayName.indexOf(' ');
    const first = sp < 0 ? p.displayName : p.displayName.slice(0, sp);
    const rest = sp < 0 ? '' : p.displayName.slice(sp);
    const tags = [];
    if (p.country) tags.push(h('span', { class: 'chip', text: p.country }));
    if (p.quality) tags.push(h('span', { class: 'chip q', text: p.quality }));
    return h('div', { class: 'card ch' + (opts.grabbed ? ' grabbed' : ''), style: { '--h': brand.hue, '--hb': hueOf(p.displayName) }, title: ch.name },
      h('div', { class: 'wash' }),
      h('div', { class: 'wm', text: brand.code }),
      h('div', { class: 'badge', text: initialsOf(p.displayName) }),
      h('div', { class: 'main' },
        h('div', { class: 'label' }, opts.prefix || '', h('span', { class: 'brand', text: first }), rest),
        h('div', { class: 'tags' + (tags.length ? '' : ' empty') }, tags)),
      starBtn(opts.fav));
  }

  // Compact row for the in-player channel overlay.
  function playerRow(ch, opts) {
    return h('div', { class: 'pitem' + (opts.playing ? ' playing' : '') },
      h('div', { class: 'nm', text: (opts.playing ? '\u25B6 ' : '') + parsed(ch).displayName }),
      h('button', { class: 'star' + (opts.fav ? '' : ' off'), 'data-act': 'star', tabindex: '-1', text: opts.fav ? '\u2605' : '\u2606' }));
  }

  // kind: 'fav' (default Favourites) | 'favlist' (a named favourite list: c = { id, name }) | 'pinned' | 'cat' | 'result'
  function category(kind, c, o = {}) {
    const lbl = h('div', { class: 'lbl' }, h('div', { class: 'nm', text: (o.grabbed ? '\u2195 ' : '') + (kind === 'fav' ? '\u2605 Favourites' : kind === 'favlist' ? '\u2605 ' + c.name : c.name) }));
    if (kind === 'fav' || kind === 'favlist') lbl.append(h('div', { class: 'sub', text: o.count === 1 ? '1 channel' : `${o.count || 0} channels` }));
    if (kind === 'result') lbl.append(h('div', { class: 'sub', text: 'Category' }));
    const card = h('div', { class: 'card cat-card ' + (kind === 'fav' || kind === 'favlist' ? 'fav' : kind === 'pinned' ? 'pinned' : '') + (o.grabbed ? ' grabbed' : ''), tabindex: '0', data: kind === 'fav' ? { id: '__FAVOURITES__' } : kind === 'favlist' ? { id: '__FL__' + c.id } : { id: c.id }, title: kind === 'fav' ? '' : c.name }, lbl);
    if (kind === 'pinned') card.append(starBtn(true));
    if (kind === 'cat' || kind === 'result') card.append(starBtn(!!o.starred));
    return card;
  }

  function source(src) {
    return h('div', { class: 'card src-card', tabindex: '0', data: { id: src.id } },
      h('button', { class: 'more', 'data-act': 'more', tabindex: '-1', title: 'Edit / Refresh / Delete', text: '\u22EF' }),
      h('div', { class: 't', text: src.name }),
      h('div', { class: 's', text: src.type === 'XTREAM' ? 'Xtream Codes' : 'M3U Playlist' }));
  }

  const addCard = () => h('div', { class: 'card src-card add-card', tabindex: '0', data: { add: '1' }, title: 'Add a source' },
    h('div', { text: '+' }), h('div', { class: 's', text: 'Add source' }));

  window.Cards = { channel, playerRow, category, source, addCard, brandOf, initialsOf, parsed };
})();
