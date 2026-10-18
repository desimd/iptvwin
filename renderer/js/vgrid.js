// Virtual grid: only the rows on screen exist in the DOM (the Android app got this from
// RecyclerView). Fixed item height; column count follows the width (or is fixed, e.g. 1 for lists).
// Handles keyboard navigation (arrows / Home / End / Page keys) with index math, so it works
// for rows that are not rendered yet.
(function () {
  'use strict';
  const { h, isTyping } = window.UI;

  class VirtualGrid {
    // o: { itemHeight, gap=8, minColWidth=280, columns=0, overscan=3, render(item,i)->Element,
    //      onClick(item,i,act,ev), onContext(item,i,ev), onKey(ev,item,i), onEdge(dir), draggable()->bool }
    constructor(o) {
      this.o = Object.assign({ gap: 8, minColWidth: 280, columns: 0, overscan: 3 }, o);
      this.items = [];
      this.cols = 1;
      this.range = [0, -1];
      this.focusIdx = -1;
      this.hasFocus = false;
      this._rendering = false;
      this._raf = 0;
      this.win = h('div', { class: 'vgrid-win' });
      this.inner = h('div', { class: 'vgrid-inner' }, this.win);
      this.el = h('div', { class: 'vgrid' + (this.o.columns === 1 ? ' one' : '') }, this.inner);

      this.el.addEventListener('scroll', () => this._schedule());
      new ResizeObserver(() => this._schedule(true)).observe(this.el);
      this.el.addEventListener('click', (e) => this._ev(e, 'click'));
      this.el.addEventListener('contextmenu', (e) => this._ev(e, 'context'));
      this.el.addEventListener('keydown', (e) => this._key(e));
      this.el.addEventListener('focusin', (e) => {
        const c = e.target.closest('[data-i]');
        if (c && this.win.contains(c)) { this.hasFocus = true; this.focusIdx = +c.dataset.i; }
      });
      this.el.addEventListener('focusout', (e) => {
        if (!this._rendering && !this.el.contains(e.relatedTarget)) this.hasFocus = false;
      });
    }

    get count() { return this.items.length; }

    setItems(items, keepScroll) {
      this.items = items;
      if (!keepScroll) this.el.scrollTop = 0;
      if (this.focusIdx >= items.length) this.focusIdx = items.length - 1;
      this._layout(true);
    }

    refresh() { this._layout(true); }

    refreshIndex(i) {
      const old = this.getEl(i);
      if (!old) return;
      const had = document.activeElement === old;
      const el = this._make(i);
      this._rendering = true;
      old.replaceWith(el);
      this._rendering = false;
      if (had) el.focus({ preventScroll: true });
    }

    getEl(i) { return this.win.querySelector(`[data-i="${i}"]`); }

    _make(i) {
      const el = this.o.render(this.items[i], i);
      el.dataset.i = i;
      el.tabIndex = i === (this.focusIdx >= 0 ? this.focusIdx : 0) ? 0 : -1;
      if (this.o.draggable) el.draggable = !!this.o.draggable();
      return el;
    }

    _schedule(force) {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => { this._raf = 0; this._layout(!!force); });
    }

    _metrics() {
      const w = this.inner.clientWidth || 1;
      const g = this.o.gap;
      const cols = this.o.columns || Math.max(1, Math.floor((w + g) / (this.o.minColWidth + g)));
      return { cols, rowH: this.o.itemHeight + g };
    }

    _layout(force) {
      if (!this.el.isConnected && !force) return;
      const { cols, rowH } = this._metrics();
      const n = this.items.length;
      const rows = Math.ceil(n / cols);
      this.inner.style.height = rows ? rows * rowH - this.o.gap + 'px' : '0px';
      const top = this.el.scrollTop, vh = this.el.clientHeight || 600;
      const first = Math.max(0, Math.floor(top / rowH) - this.o.overscan);
      const last = Math.min(rows - 1, Math.ceil((top + vh) / rowH) + this.o.overscan);
      if (!force && cols === this.cols && first === this.range[0] && last === this.range[1]) return;
      this.cols = cols;
      this.range = [first, last];

      this._rendering = true;
      this.win.style.top = first * rowH + 'px';
      this.win.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
      this.win.style.gap = this.o.gap + 'px';
      const frag = document.createDocumentFragment();
      for (let i = first * cols; i < Math.min(n, (last + 1) * cols); i++) frag.append(this._make(i));
      this.win.replaceChildren(frag);
      if (this.hasFocus && this.focusIdx >= 0) {
        const el = this.getEl(this.focusIdx);
        if (el) el.focus({ preventScroll: true });
      }
      this._rendering = false;
    }

    _ensureVisible(i, center) {
      const { cols, rowH } = this._metrics();
      const y = Math.floor(i / cols) * rowH;
      const vh = this.el.clientHeight;
      if (center) this.el.scrollTop = Math.max(0, y - (vh - this.o.itemHeight) / 2);
      else if (y < this.el.scrollTop) this.el.scrollTop = y;
      else if (y + this.o.itemHeight > this.el.scrollTop + vh) this.el.scrollTop = y + this.o.itemHeight - vh + 6;
      this._layout(false);
    }

    scrollToIndex(i, center) { if (i >= 0 && i < this.items.length) this._ensureVisible(i, center); }

    focusIndex(i, center) {
      if (!this.items.length) return false;
      i = Math.max(0, Math.min(this.items.length - 1, i));
      this.focusIdx = i;
      this._ensureVisible(i, center);
      this._layout(true);
      const el = this.getEl(i);
      if (el) {
        this.win.querySelectorAll('[tabindex="0"]').forEach((x) => { x.tabIndex = -1; });
        el.tabIndex = 0;
        el.focus({ preventScroll: true });
      }
      return !!el;
    }

    _ev(e, type) {
      const card = e.target.closest('[data-i]');
      if (!card || !this.win.contains(card)) return;
      const i = +card.dataset.i;
      if (type === 'context') {
        if (this.o.onContext) { e.preventDefault(); this.o.onContext(this.items[i], i, e); }
        return;
      }
      const actEl = e.target.closest('[data-act]');
      this.o.onClick && this.o.onClick(this.items[i], i, actEl ? actEl.dataset.act : null, e);
    }

    _key(e) {
      if (isTyping(e.target) || e.altKey || e.ctrlKey || e.metaKey) return;
      const n = this.items.length;
      const i = this.focusIdx;
      if (!n || i < 0 || !e.target.closest('[data-i]')) return;
      if (this.o.beforeKey && this.o.beforeKey(e, this.items[i], i) === true) return;
      const cols = this.cols;
      const vrows = Math.max(1, Math.floor((this.el.clientHeight || 400) / (this.o.itemHeight + this.o.gap)));
      let t = null;
      switch (e.key) {
        case 'ArrowRight': if (cols === 1) return; t = Math.min(n - 1, i + 1); break;
        case 'ArrowLeft': if (cols === 1) return; t = Math.max(0, i - 1); break;
        case 'ArrowDown': t = (Math.floor((n - 1) / cols) > Math.floor(i / cols)) ? Math.min(n - 1, i + cols) : i; break;
        case 'ArrowUp':
          if (i < cols) { if (this.o.onEdge) { e.preventDefault(); this.o.onEdge('up'); } return; }
          t = i - cols; break;
        case 'Home': t = 0; break;
        case 'End': t = n - 1; break;
        case 'PageDown': t = Math.min(n - 1, i + vrows * cols); break;
        case 'PageUp': t = Math.max(0, i - vrows * cols); break;
        case 'Enter': case ' ':
          if (e.target.closest('button[data-act]') && e.target.closest('button[data-act]') !== e.target.closest('[data-i]')) return;
          e.preventDefault();
          this.o.onClick && this.o.onClick(this.items[i], i, 'activate', e);
          return;
        default:
          if (this.o.onKey) this.o.onKey(e, this.items[i], i);
          return;
      }
      e.preventDefault();
      if (t !== i) this.focusIndex(t);
    }
  }

  window.VirtualGrid = VirtualGrid;
})();
