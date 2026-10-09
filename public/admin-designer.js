'use strict';
// Visual layout designer for the screen being edited. Uses SC(), cur, catalog, render(), $, esc from admin.js and NocLayout.
// Two modes, matching the wall exactly:
//   Auto-fit  — you choose the ORDER (drag blocks past each other) and size hints; rows are tiled with no gaps.
//   Free      — every widget has its own x/y/w/h on the 12-column grid; drag anywhere, drag the corner to resize.
const dz = { open: false, sel: -1, undo: [], drag: null };
const RH = 36;   // preview pixels per grid row
const hue = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const titleOf = (w) => (catalog.find((c) => c.type === w.type) || { title: w.type, group: '' });

const dzScreen = () => SC()[cur];
const dzFree = () => dzScreen().auto === false;
// Placement of every widget right now (what the wall would draw), indexed like screen.widgets.
const dzPlacements = () => NocLayout.place(dzScreen(), dzScreen().widgets).list;
const snapshot = () => JSON.stringify({ auto: dzScreen().auto, widgets: dzScreen().widgets });
function pushUndo() { dz.undo.push(snapshot()); if (dz.undo.length > 30) dz.undo.shift(); }
function restore(txt) { const o = JSON.parse(txt); dzScreen().auto = o.auto; dzScreen().widgets = o.widgets; dz.sel = Math.min(dz.sel, o.widgets.length - 1); }

function blockStyle(p) { return `left:${(p.x / 12) * 100}%;top:${p.y * RH}px;width:${(p.w / 12) * 100}%;height:${p.h * RH}px`; }
function renderDesigner() {
  const el = $('#designer'); if (!el) return;
  if (!dz.open) { el.innerHTML = ''; return; }
  const s = dzScreen(); const free = dzFree(); const items = dzPlacements(); const rows = Math.max(NocLayout.rowsNeeded(items) + 3, 12);
  const split = (s.displays || 1) > 1;
  el.innerHTML = `<div class="dz">
    <div class="dz-bar"><strong>Layout designer — ${esc(s.name)}</strong>
      <label class="inline"><input type="radio" name="dzmode" value="auto" ${!free ? 'checked' : ''}> Auto-fit <span class="dz-sub">— drag to reorder, resize for a size hint, rows tile with no gaps</span></label>
      <label class="inline"><input type="radio" name="dzmode" value="free" ${free ? 'checked' : ''}> Free placement <span class="dz-sub">— drag anywhere, drag the corner to resize</span></label>
      <span style="flex:1"></span><button id="dzUndo" ${dz.undo.length ? '' : 'disabled'}>↶ Undo</button><button id="dzTidy" ${free ? '' : 'disabled'} title="Pull everything up to close vertical gaps">Close gaps</button><button id="dzAdd">+ Add widget</button><button id="dzClose" class="primary">Done</button></div>
    ${split ? `<div class="dz-note">This screen is spread across ${s.displays} displays, so each display tiles its own share automatically; free placement applies when Displays = 1 (or in a playlist). The preview below shows the whole screen.</div>` : ''}
    <div class="dz-wrap"><div class="dz-canvas ${free ? 'free' : ''}" id="dzCanvas" tabindex="0" style="height:${rows * RH}px">
      ${items.map((p, i) => { const w = s.widgets[i]; const t = titleOf(w); return `<div class="dz-b ${i === dz.sel ? 'sel' : ''}" data-i="${i}" style="${blockStyle(p)};--h:${hue(t.group)}"><div class="dz-t">${esc(w.title || t.title)}</div><div class="dz-m">${p.w}×${p.h}${w.venue ? ' · venue' : ''}${w.match ? ` · “${esc(w.match)}”` : ''}</div><span class="dz-h" title="Drag to resize"></span></div>`; }).join('')}
    </div></div>
    <div class="dz-insp">${inspectorHtml(items)}</div></div>`;
}
function inspectorHtml(items) {
  const i = dz.sel; const w = dzScreen().widgets[i]; if (!w) return '<span style="color:var(--muted)">Click a block to select it. Arrow keys move it, <b>Shift</b>+arrows resize, <b>Delete</b> removes it.</span>';
  const p = items[i]; const free = dzFree();
  return `<strong>${esc(titleOf(w).title)}</strong>
    <label>Width<input id="dzW" type="number" min="1" max="12" value="${p.w}" style="width:4.2rem"></label><label>Height<input id="dzH" type="number" min="1" max="10" value="${p.h}" style="width:4.2rem"></label>
    ${free ? `<label>Column<input id="dzX" type="number" min="1" max="12" value="${p.x + 1}" style="width:4.2rem"></label><label>Row<input id="dzY" type="number" min="1" value="${p.y + 1}" style="width:4.2rem"></label>`
           : `<button data-dz="earlier">◀ Earlier</button><button data-dz="later">Later ▶</button><span style="color:var(--muted)">position ${i + 1} of ${items.length}</span>`}
    <button data-dz="dup">Duplicate</button><button data-dz="opts" title="Jump to this widget's options (venue, thresholds, …)">Options ↓</button><button data-dz="rm" class="danger">Remove</button>`;
}

// ---- writing a layout back into the screen ----
function writeFree(list) { const ws = dzScreen().widgets; list.forEach((p, i) => { ws[i].x = p.x; ws[i].y = p.y; ws[i].w = p.w; ws[i].h = p.h; }); }
function commit() { render(); }   // refreshes the widget rows (sizes) and the designer

function setMode(mode) {
  const s = dzScreen(); if ((mode === 'free') === dzFree()) return; pushUndo();
  if (mode === 'free') { const arr = NocLayout.arrange(s.widgets); s.auto = false; writeFree(arr); }            // freeze today's tiling so nothing jumps
  else { const order = NocLayout.readingOrder(dzPlacements()); s.widgets = order.map((k) => s.widgets[k]); s.auto = true; s.widgets.forEach((w) => { delete w.x; delete w.y; }); dz.sel = -1; }
  commit();
}

// ---- dragging ----
function pointerGrid(e, canvasRect) { return { col: ((e.clientX - canvasRect.left) / canvasRect.width) * 12, row: (e.clientY - canvasRect.top) / RH }; }
function paintBlocks(posByIndex) { for (const b of document.querySelectorAll('#dzCanvas .dz-b')) { const p = posByIndex[Number(b.dataset.i)]; if (!p) continue; b.style.cssText = `${blockStyle(p)};--h:${b.style.getPropertyValue('--h')}`; b.querySelector('.dz-m').firstChild.textContent = `${p.w}×${p.h}`; } }

document.addEventListener('pointerdown', (e) => {
  const canvas = $('#dzCanvas'); if (!canvas || !canvas.contains(e.target)) return;
  const b = e.target.closest('.dz-b'); if (!b) { dz.sel = -1; renderDesigner(); return; }
  const i = Number(b.dataset.i); const resize = Boolean(e.target.closest('.dz-h')); const rect = canvas.getBoundingClientRect(); const orig = dzPlacements();
  const g = pointerGrid(e, rect); if (dz.sel !== i) { dz.sel = i; document.querySelectorAll('#dzCanvas .dz-b').forEach((x) => x.classList.toggle('sel', Number(x.dataset.i) === i)); $('.dz-insp').innerHTML = inspectorHtml(orig); }
  dz.drag = { i, resize, rect, orig, grabCol: g.col - orig[i].x, grabRow: g.row - orig[i].y, order: orig.map((_, k) => k), moved: false, snap: snapshot() };
  e.preventDefault();
});
window.addEventListener('pointermove', (e) => {
  const d = dz.drag; if (!d) return; d.moved = true; const { col, row } = pointerGrid(e, d.rect); const free = dzFree(); const ws = dzScreen().widgets;
  if (d.resize) {
    const base = d.orig[d.i]; const w = Math.max(1, Math.min(free ? 12 - base.x : 12, Math.round(col - base.x))); const h = Math.max(1, Math.min(10, Math.round(row - base.y)));
    if (free) { const items = d.orig.map((p) => ({ ...p })); items[d.i] = { ...base, w, h }; d.preview = NocLayout.resolve(items, d.i); }
    else { const copy = ws.map((x, k) => (k === d.i ? { ...x, w, h } : x)); const arr = NocLayout.arrange(d.order.map((k) => copy[k])); d.preview = []; d.order.forEach((k, j) => (d.preview[k] = arr[j])); }
  } else if (free) {
    const base = d.orig[d.i]; const x = Math.max(0, Math.min(12 - base.w, Math.round(col - d.grabCol))); const y = Math.max(0, Math.round(row - d.grabRow));
    const items = d.orig.map((p) => ({ ...p })); items[d.i] = { ...base, x, y }; d.preview = NocLayout.resolve(items, d.i);
  } else {   // auto-fit: dragging reorders — find the block the pointer is over and take its slot
    const arrNow = NocLayout.arrange(d.order.map((k) => ws[k])); let target = -1;
    arrNow.forEach((p, j) => { if (col >= p.x && col < p.x + p.w && row >= p.y && row < p.y + p.h) target = j; });
    const from = d.order.indexOf(d.i); if (target >= 0 && target !== from) { d.order.splice(from, 1); d.order.splice(target, 0, d.i); }
    const arr = NocLayout.arrange(d.order.map((k) => ws[k])); d.preview = []; d.order.forEach((k, j) => (d.preview[k] = arr[j]));
  }
  paintBlocks(d.preview);
});
window.addEventListener('pointerup', () => {
  const d = dz.drag; if (!d) return; dz.drag = null; if (!d.moved || !d.preview) return;
  dz.undo.push(d.snap); if (dz.undo.length > 30) dz.undo.shift();
  const s = dzScreen();
  if (dzFree()) writeFree(d.preview);
  else { const ws = s.widgets; if (d.resize) { ws[d.i].w = d.preview[d.i].w; ws[d.i].h = d.preview[d.i].h; } const next = d.order.map((k) => ws[k]); dz.sel = d.order.indexOf(d.i); s.widgets = next; }
  commit();
});

// ---- toolbar / inspector / keyboard ----
document.addEventListener('change', (e) => {
  if (e.target.name === 'dzmode') { setMode(e.target.value); return; }
  const id = e.target.id; if (!['dzW', 'dzH', 'dzX', 'dzY'].includes(id) || dz.sel < 0) return;
  pushUndo(); const ws = dzScreen().widgets; const w = ws[dz.sel]; const p = dzPlacements()[dz.sel]; const v = Number(e.target.value) || 1;
  if (dzFree()) {
    const list = dzPlacements().map((q) => ({ ...q })); const q = list[dz.sel];
    if (id === 'dzW') q.w = Math.max(1, Math.min(12 - q.x, v)); if (id === 'dzH') q.h = Math.max(1, Math.min(10, v)); if (id === 'dzX') q.x = Math.max(0, Math.min(12 - q.w, v - 1)); if (id === 'dzY') q.y = Math.max(0, v - 1);
    writeFree(NocLayout.resolve(list, dz.sel));
  } else { if (id === 'dzW') w.w = Math.max(1, Math.min(12, v)); if (id === 'dzH') w.h = Math.max(1, Math.min(10, v)); }
  commit();
});
document.addEventListener('click', (e) => {
  const t = e.target.closest('button, [data-act="design"]'); if (!t) return;
  if (t.dataset.act === 'design') { dz.open = !dz.open; dz.sel = -1; renderDesigner(); if (dz.open) $('#designer').scrollIntoView({ block: 'nearest' }); return; }
  if (t.id === 'dzClose') { dz.open = false; renderDesigner(); return; }
  if (t.id === 'dzUndo') { if (dz.undo.length) { restore(dz.undo.pop()); commit(); } return; }
  if (t.id === 'dzTidy') { pushUndo(); writeFree(NocLayout.compact(dzPlacements())); commit(); return; }
  if (t.id === 'dzAdd') { showPicker = true; render(); const pk = document.querySelector('.picker-head'); if (pk) pk.scrollIntoView({ block: 'start' }); return; }
  const a = t.dataset.dz; if (!a || dz.sel < 0) return; const s = dzScreen(); const ws = s.widgets; const i = dz.sel;
  if (a === 'rm') { pushUndo(); ws.splice(i, 1); dz.sel = -1; commit(); }
  else if (a === 'dup') { pushUndo(); const c = JSON.parse(JSON.stringify(ws[i])); if (dzFree()) { delete c.x; delete c.y; } ws.splice(i + 1, 0, c); dz.sel = i + 1; commit(); }
  else if (a === 'earlier' && i > 0) { pushUndo(); [ws[i - 1], ws[i]] = [ws[i], ws[i - 1]]; dz.sel = i - 1; commit(); }
  else if (a === 'later' && i < ws.length - 1) { pushUndo(); [ws[i + 1], ws[i]] = [ws[i], ws[i + 1]]; dz.sel = i + 1; commit(); }
  else if (a === 'opts') { const row = document.querySelector(`.wrow[data-i="${i}"]`); if (row) { row.scrollIntoView({ block: 'center' }); row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 1400); } }
});
document.addEventListener('keydown', (e) => {
  const canvas = $('#dzCanvas'); if (!canvas || document.activeElement !== canvas || dz.sel < 0) return;
  const s = dzScreen(); const ws = s.widgets; const i = dz.sel; const free = dzFree(); const k = e.key;
  if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); pushUndo(); ws.splice(i, 1); dz.sel = -1; commit(); return; }
  if (!k.startsWith('Arrow')) return; e.preventDefault(); pushUndo();
  const dx = k === 'ArrowRight' ? 1 : k === 'ArrowLeft' ? -1 : 0, dy = k === 'ArrowDown' ? 1 : k === 'ArrowUp' ? -1 : 0;
  if (free) { const list = dzPlacements().map((q) => ({ ...q })); const q = list[i]; if (e.shiftKey) { q.w = Math.max(1, Math.min(12 - q.x, q.w + dx)); q.h = Math.max(1, Math.min(10, q.h + dy)); } else { q.x = Math.max(0, Math.min(12 - q.w, q.x + dx)); q.y = Math.max(0, q.y + dy); } writeFree(NocLayout.resolve(list, i)); }
  else if (e.shiftKey) { ws[i].w = Math.max(1, Math.min(12, ws[i].w + dx)); ws[i].h = Math.max(1, Math.min(10, ws[i].h + dy)); }
  else { const j = i + (dx + dy); if (j >= 0 && j < ws.length) { [ws[j], ws[i]] = [ws[i], ws[j]]; dz.sel = j; } }
  commit(); const c = $('#dzCanvas'); if (c) c.focus();
});
