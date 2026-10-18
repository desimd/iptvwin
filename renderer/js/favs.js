// Favourite lists UI shared by the channel lists, the player and the categories page (port of FavPicker.kt):
// ask for a list name, create a list, and the "which list?" picker for a channel.
(function () {
  'use strict';
  const { h, api, dialog, choose, toast } = window.UI;

  // -> Promise<string | null>
  function askName(title, initial) {
    return new Promise((resolve) => {
      let val = null;
      const inp = h('input', { class: 'input', value: initial || '', maxlength: '24', spellcheck: 'false', placeholder: 'List name (max 24 characters)' });
      const d = dialog({
        title, body: h('div', null, inp),
        buttons: [{ label: 'Cancel' }, { label: 'OK', primary: true, onClick: () => { val = inp.value.trim(); } }],
        onClose: () => resolve(val)
      });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); val = inp.value.trim(); d.close(); } });
      setTimeout(() => { inp.focus(); inp.select(); }, 0);
    });
  }

  // Asks for a name until it is valid (or cancelled) -> { id, name } | null
  async function create(source) {
    let name = '';
    for (;;) {
      name = await askName('New favourite list', name);
      if (name === null) return null;
      try { return await api('favlists.create', source.id, name); }
      catch (e) { toast(e.message, 3500); }
    }
  }

  // Star / F on a channel. With only the default list it just toggles; with more it shows the picker
  // (\u2605 = in it, \u2606 = not), the current list first, plus "New list...".  onChanged(listId, added) after a change.
  async function show(source, ch, opts = {}) {
    const { firstListId = 'default', onChanged } = opts;
    const plain = { name: ch.name, url: ch.url, group: ch.group || '' };
    const toggle = async (list) => {
      const now = await api('favourites.toggle', source.id, plain, list.id);
      toast(now ? `Added to ${list.name}` : `Removed from ${list.name}`, 1400);
      if (onChanged) await onChanged(list.id, now);
    };
    const lists = await api('favlists.get', source.id);
    if (lists.length === 1) return toggle(lists[0]);
    const inList = new Set(await api('favourites.membership', source.id, ch.url));
    const ordered = lists.slice().sort((a, b) => (a.id === firstListId ? 0 : 1) - (b.id === firstListId ? 0 : 1));
    const labels = ordered.map((l) => (inList.has(l.id) ? '\u2605 ' : '\u2606 ') + l.name).concat('\uFF0B New list\u2026');
    const i = await choose(ch.name, labels);
    if (i === null) return;
    if (i < ordered.length) return toggle(ordered[i]);
    const made = await create(source);
    if (made) await toggle(made);
  }

  window.FavPicker = { askName, create, show };
})();
