'use strict';
// Shared layout maths for the viewer AND the editor's layout designer, so the preview is exactly what the wall shows.
// Every function is pure. A "placement" is { ...widget, x, y, w, h } on a 12-column grid (x/y/w/h in cells).
(function (root) {
  const COLS = 12;
  const num = (v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

  // Auto-fit: keep the widget ORDER, group into rows (≤ 6 widgets, ≤ 12 columns of preferred width), stretch every row to
  // exactly 12 columns at one shared height. Returns placements with x/y so it can be drawn or rendered directly.
  function arrange(widgets) {
    const rows = []; let cur = [], sum = 0;
    const flush = () => { if (cur.length) rows.push(cur); cur = []; sum = 0; };
    for (const wd of widgets) {
      if (cur.length && (sum + wd.w > COLS || cur.length >= 6)) flush();
      cur.push(wd); sum += wd.w;
      if (sum >= COLS) flush();
    }
    flush();
    const out = []; let y = 0;
    for (const row of rows) {
      const total = row.reduce((n, x) => n + x.w, 0);
      const ws = row.map((x) => Math.max(2, Math.floor((x.w * COLS) / total)));
      let left = COLS - ws.reduce((n, x) => n + x, 0);
      const order = row.map((x, i) => [((x.w * COLS) / total) % 1, i]).sort((a, b) => b[0] - a[0]);
      for (let k = 0; left > 0; k++, left--) ws[order[k % order.length][1]]++;
      while (left < 0) { const i = ws.indexOf(Math.max(...ws)); ws[i]--; left++; }   // only if the 2-column minimum overshot
      const h = Math.max(...row.map((x) => x.h)); let x = 0;
      row.forEach((wd, i) => { out.push({ ...wd, x, y, w: ws[i], h }); x += ws[i]; });
      y += h;
    }
    return out;
  }

  const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const rowsNeeded = (list) => Math.max(1, ...list.map((p) => p.y + p.h));

  // Free placement: widgets that have x/y keep them; the rest are dropped into the first free slot (reading order).
  function freeFill(widgets) {
    const placed = []; const todo = [];
    widgets.forEach((wd, i) => {
      const w = Math.max(1, Math.min(COLS, Math.round(wd.w) || 3)), h = Math.max(1, Math.round(wd.h) || 2);
      const x = num(wd.x), y = num(wd.y);
      if (x !== null && y !== null) placed[i] = { ...wd, w, h, x: Math.max(0, Math.min(COLS - w, Math.round(x))), y: Math.max(0, Math.round(y)) };
      else todo.push(i);
    });
    const taken = () => placed.filter(Boolean);
    for (const i of todo) {
      const wd = widgets[i]; const w = Math.max(1, Math.min(COLS, Math.round(wd.w) || 3)), h = Math.max(1, Math.round(wd.h) || 2);
      let found = null;
      for (let y = 0; !found; y++) for (let x = 0; x + w <= COLS; x++) { const c = { x, y, w, h }; if (!taken().some((p) => overlaps(p, c))) { found = c; break; } }
      placed[i] = { ...wd, ...found };
    }
    return placed;
  }

  // What the wall draws: auto-fit tiling (order-driven) or the user's own positions. `forceAuto` is for screens whose
  // widgets are split across displays (each display tiles its share).
  function place(screen, widgets, forceAuto = false) {
    const list = (forceAuto || screen.auto !== false) ? arrange(widgets) : freeFill(widgets);
    return { list, rows: rowsNeeded(list) };
  }

  // ---- designer helpers ----
  // Put item `idx` where it is, then push every colliding item down (never sideways) until nothing overlaps.
  function resolve(items, idx) {
    const out = items.map((p) => ({ ...p })); const settled = [out[idx]];
    const order = out.map((_, i) => i).filter((i) => i !== idx).sort((a, b) => out[a].y - out[b].y || out[a].x - out[b].x);
    for (const i of order) { const it = out[i]; while (settled.some((p) => overlaps(p, it))) it.y++; settled.push(it); }
    return out;
  }
  // Pull every item up as far as it can go (removes vertical gaps) without changing columns or overlapping.
  function compact(items) {
    const out = items.map((p) => ({ ...p })); const order = out.map((_, i) => i).sort((a, b) => out[a].y - out[b].y || out[a].x - out[b].x); const settled = [];
    for (const i of order) { const it = out[i]; while (it.y > 0 && !settled.some((p) => overlaps(p, { ...it, y: it.y - 1 }))) it.y--; settled.push(it); }
    return out;
  }
  // Reading order of a set of placements (top-to-bottom, left-to-right) — used when going from free placement to auto-fit.
  const readingOrder = (items) => items.map((_, i) => i).sort((a, b) => items[a].y - items[b].y || items[a].x - items[b].x);

  const api = { COLS, arrange, freeFill, place, rowsNeeded, overlaps, resolve, compact, readingOrder };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.NocLayout = api;
})(typeof window !== 'undefined' ? window : globalThis);
