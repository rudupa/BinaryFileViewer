'use strict';

/**
 * Binary File Viewer & Editor
 *
 * Fully client-side hex tool: offset / hex / ASCII with smooth virtualized
 * scrolling over the whole file (no paging), a data inspector, in-browser byte
 * editing with download of the modified file, a block / contiguity map, and a
 * side-by-side compare of two files that highlights differing bytes.
 *
 * Everything runs locally — files are never uploaded.
 */

const $ = (id) => document.getElementById(id);

const BPR = 16;        // bytes per row
const ROW_H = 20;      // px, must match .hex-row line-height in CSS
const BUFFER = 8;      // extra rows rendered above/below the viewport

const hex2 = (n) => n.toString(16).padStart(2, '0');
const hex8 = (n) => n.toString(16).padStart(8, '0');
const printable = (b) => (b >= 0x20 && b <= 0x7e);
const escChar = (c) => (c === '<' ? '&lt;' : c === '&' ? '&amp;' : c);

// --- State -----------------------------------------------------------------

/** @type {{A: Slot|null, B: Slot|null}} */
const slots = { A: null, B: null };
let active = 'A';
let compare = false;
let syncing = false;   // guard against scroll-sync feedback loop

const panes = {
  A: paneRefs('paneA'),
  B: paneRefs('paneB'),
};

function paneRefs(id) {
  const el = $(id);
  return { el, spacer: el.querySelector('.hexspacer'), win: el.querySelector('.hexwin') };
}

/**
 * @typedef {Object} Slot
 * @property {string} name
 * @property {Uint8Array} bytes     mutable working copy (reflects edits)
 * @property {Uint8Array} original  pristine copy for diff / revert
 * @property {DataView} dv
 * @property {Set<number>} edits    offsets changed from original
 * @property {number} cursor
 * @property {Array<{start:number,end:number}>} blocks
 */

function makeSlot(name, buffer) {
  const bytes = new Uint8Array(buffer);
  return {
    name,
    bytes,
    original: bytes.slice(),
    dv: new DataView(buffer),
    edits: new Set(),
    cursor: -1,
    blocks: [],
  };
}

// --- Block / contiguity detection ------------------------------------------

function gapThreshold() {
  const v = parseInt($('gapInput').value, 10);
  return Number.isFinite(v) && v > 0 ? v : 64;
}

/** Split the file into data blocks separated by long runs of 0x00 / 0xFF. */
function computeBlocks(bytes, threshold) {
  const blocks = [];
  const n = bytes.length;
  let i = 0;
  let start = null;
  while (i < n) {
    const b = bytes[i];
    let j = i;
    while (j < n && bytes[j] === b) j++;
    const runLen = j - i;
    const isGap = (b === 0x00 || b === 0xff) && runLen >= threshold;
    if (isGap) {
      if (start !== null) { blocks.push({ start, end: i }); start = null; }
    } else if (start === null) {
      start = i;
    }
    i = j;
  }
  if (start !== null) blocks.push({ start, end: n });
  return blocks;
}

// --- Hex rendering (virtualized) -------------------------------------------

function rowHtml(slot, other, rowIdx) {
  const off = rowIdx * BPR;
  const end = Math.min(off + BPR, slot.bytes.length);
  let hexPart = '';
  let asciiPart = '';
  for (let i = 0; i < BPR; i++) {
    const idx = off + i;
    if (idx < end) {
      const b = slot.bytes[idx];
      const cls = [];
      if (idx === slot.cursor) cls.push('cur');
      if (slot.edits.has(idx)) cls.push('edt');
      if (other && (idx >= other.bytes.length || other.bytes[idx] !== b)) cls.push('dif');
      const c = cls.length ? ` class="${cls.join(' ')}"` : '';
      hexPart += `<span data-off="${idx}"${c}>${hex2(b)}</span>${i === 7 ? '  ' : ' '}`;
      const pr = printable(b);
      const ac = ['a']; if (!pr) ac.push('na'); if (cls.length) ac.push(...cls);
      asciiPart += `<span data-off="${idx}" class="${ac.join(' ')}">${pr ? escChar(String.fromCharCode(b)) : '.'}</span>`;
    } else {
      hexPart += i === 7 ? '    ' : '   ';
      asciiPart += ' ';
    }
  }
  return `<div class="hex-row"><span class="hex-offset">${hex8(off)}</span>` +
    `<span class="hex-sep">  </span><span class="hex-bytes">${hexPart}</span>` +
    `<span class="hex-sep"> |</span><span class="hex-asciis">${asciiPart}</span><span class="hex-sep">|</span></div>`;
}

function renderPane(key) {
  const slot = slots[key];
  const p = panes[key];
  if (!slot) { p.win.innerHTML = ''; p.spacer.style.height = '0'; return; }
  const other = compare ? slots[key === 'A' ? 'B' : 'A'] : null;
  const totalRows = Math.max(1, Math.ceil(slot.bytes.length / BPR));
  p.spacer.style.height = totalRows * ROW_H + 'px';
  const st = p.el.scrollTop;
  const vh = p.el.clientHeight || 400;
  const first = Math.max(0, Math.floor(st / ROW_H) - BUFFER);
  const rowsInView = Math.ceil(vh / ROW_H) + BUFFER * 2;
  const last = Math.min(totalRows, first + rowsInView);
  let html = '';
  for (let r = first; r < last; r++) html += rowHtml(slot, other, r);
  p.win.style.transform = `translateY(${first * ROW_H}px)`;
  p.win.innerHTML = html;
}

function scrollToOffset(key, off) {
  const p = panes[key];
  const row = Math.floor(off / BPR);
  p.el.scrollTop = Math.max(0, row * ROW_H - p.el.clientHeight / 2);
  renderPane(key);
}

// --- Inspector -------------------------------------------------------------

function renderInspector() {
  const slot = slots[active];
  const kv = $('inspectorKv');
  const editRow = $('editRow');
  if (!slot || slot.cursor < 0) {
    kv.innerHTML = '<div class="k">—</div><div class="v">Click a byte above.</div>';
    $('cursorOff').textContent = '';
    editRow.classList.add('hidden');
    return;
  }
  const cur = slot.cursor;
  const dv = slot.dv;
  $('cursorOff').textContent = `@ 0x${hex8(cur)} (${cur}) · file ${active}`;

  const remain = slot.bytes.length - cur;
  const rows = [];
  const add = (k, v) => rows.push(`<div class="k">${k}</div><div class="v">${v}</div>`);
  const b = slot.bytes[cur];
  add('uint8', b);
  add('int8', dv.getInt8(cur));
  add('binary', b.toString(2).padStart(8, '0'));
  if (remain >= 2) {
    add('uint16 (LE / BE)', `${dv.getUint16(cur, true)} / ${dv.getUint16(cur, false)}`);
    add('int16 (LE / BE)', `${dv.getInt16(cur, true)} / ${dv.getInt16(cur, false)}`);
  }
  if (remain >= 4) {
    add('uint32 (LE / BE)', `${dv.getUint32(cur, true)} / ${dv.getUint32(cur, false)}`);
    add('int32 (LE / BE)', `${dv.getInt32(cur, true)} / ${dv.getInt32(cur, false)}`);
    add('float32 (LE / BE)', `${dv.getFloat32(cur, true).toPrecision(7)} / ${dv.getFloat32(cur, false).toPrecision(7)}`);
  }
  if (remain >= 8) {
    add('float64 (LE / BE)', `${dv.getFloat64(cur, true).toPrecision(10)} / ${dv.getFloat64(cur, false).toPrecision(10)}`);
  }
  let s = '';
  for (let i = cur; i < slot.bytes.length && s.length < 24; i++) {
    if (!printable(slot.bytes[i])) break;
    s += String.fromCharCode(slot.bytes[i]);
  }
  add('ASCII string', s ? `"${s.replace(/</g, '&lt;')}"` : '(none)');
  if (compare && slots.A && slots.B) {
    const oKey = active === 'A' ? 'B' : 'A';
    const o = slots[oKey];
    add(`file ${oKey} here`, cur < o.bytes.length ? `0x${hex2(o.bytes[cur])} (${o.bytes[cur]})` : '(past end)');
  }
  kv.innerHTML = rows.join('');

  editRow.classList.remove('hidden');
  $('editOff').textContent = `0x${hex8(cur)}`;
  $('editHex').value = hex2(b);
  $('btnRevertByte').disabled = !slot.edits.has(cur);
}

// --- Editing ---------------------------------------------------------------

function applyEdit(slot, off, val) {
  slot.bytes[off] = val & 0xff;
  if (slot.bytes[off] === slot.original[off]) slot.edits.delete(off);
  else slot.edits.add(off);
  slot.blocks = computeBlocks(slot.bytes, gapThreshold());
}

function revertByte(slot, off) {
  slot.bytes[off] = slot.original[off];
  slot.edits.delete(off);
  slot.blocks = computeBlocks(slot.bytes, gapThreshold());
}

function revertAll(slot) {
  slot.bytes.set(slot.original);
  slot.edits.clear();
  slot.blocks = computeBlocks(slot.bytes, gapThreshold());
}

// --- Compare / diff ---------------------------------------------------------

function diffStats() {
  const a = slots.A, b = slots.B;
  if (!a || !b) return { count: 0, minLen: 0, maxLen: 0 };
  const minLen = Math.min(a.bytes.length, b.bytes.length);
  const maxLen = Math.max(a.bytes.length, b.bytes.length);
  let count = maxLen - minLen; // trailing bytes present in only one file
  for (let i = 0; i < minLen; i++) if (a.bytes[i] !== b.bytes[i]) count++;
  return { count, minLen, maxLen };
}

function isDiffAt(off) {
  const a = slots.A, b = slots.B;
  if (off >= Math.max(a.bytes.length, b.bytes.length)) return false;
  if (off >= a.bytes.length || off >= b.bytes.length) return true;
  return a.bytes[off] !== b.bytes[off];
}

function gotoDiff(dir) {
  if (!compare || !slots.A || !slots.B) return;
  const maxLen = Math.max(slots.A.bytes.length, slots.B.bytes.length);
  let off = slots[active].cursor;
  off = off < 0 ? (dir > 0 ? -1 : maxLen) : off;
  for (let i = off + dir; i >= 0 && i < maxLen; i += dir) {
    if (isDiffAt(i)) {
      slots.A.cursor = slots.B.cursor = i;
      scrollToOffset('A', i);
      if (compare) { syncing = true; panes.B.el.scrollTop = panes.A.el.scrollTop; syncing = false; renderPane('B'); }
      renderPane('A');
      renderInspector();
      return;
    }
  }
}

// --- Block map UI ----------------------------------------------------------

function renderBlocks() {
  const slot = slots[active];
  const bar = $('blockBar');
  const list = $('blockList');
  const verdict = $('blockVerdict');
  if (!slot) { bar.innerHTML = ''; list.innerHTML = ''; verdict.textContent = ''; return; }
  const n = slot.bytes.length;
  const blocks = slot.blocks;
  if (blocks.length <= 1) {
    verdict.textContent = blocks.length === 0 ? 'Empty / all-fill — no data blocks' : 'Contiguous — 1 data block';
    verdict.className = 'verdict ok';
  } else {
    verdict.textContent = `Non-contiguous — ${blocks.length} data blocks (${blocks.length - 1} gap${blocks.length - 1 > 1 ? 's' : ''})`;
    verdict.className = 'verdict warn';
  }
  bar.innerHTML = blocks.map((bl, i) => {
    const left = (bl.start / n) * 100;
    const w = ((bl.end - bl.start) / n) * 100;
    return `<span class="blk-seg" data-blk="${i}" style="left:${left}%;width:${Math.max(w, 0.3)}%" title="Block ${i} · 0x${hex8(bl.start)}–0x${hex8(bl.end)}"></span>`;
  }).join('');
  list.innerHTML = blocks.map((bl, i) =>
    `<div class="blk-item" data-blk="${i}"><span class="blk-idx">#${i}</span>` +
    `<span class="mono">0x${hex8(bl.start)} – 0x${hex8(bl.end)}</span>` +
    `<span class="blk-size">${(bl.end - bl.start).toLocaleString()} B</span></div>`
  ).join('') || '<div class="blk-item muted">no data blocks</div>';
}

// --- Tabs / toolbar --------------------------------------------------------

function renderTabs() {
  const tabs = $('fileTabs');
  const html = [];
  for (const key of ['A', 'B']) {
    const s = slots[key];
    if (!s) continue;
    const cls = key === active ? 'file-tab active' : 'file-tab';
    const dot = s.edits.size ? ' <span class="edt-dot">●</span>' : '';
    html.push(`<button class="${cls}" data-tab="${key}" title="${s.name}">${key}: ${s.name}${dot}</button>`);
  }
  tabs.innerHTML = html.join('');
}

function renderToolbar() {
  const slot = slots[active];
  $('fname').textContent = slot ? slot.name : '—';
  $('fsize').textContent = slot ? `${slot.bytes.length.toLocaleString()} bytes` : '—';
  const ec = $('editCount');
  const btnRevertAll = $('btnRevertAll');
  if (slot && slot.edits.size) {
    ec.textContent = `${slot.edits.size} edit${slot.edits.size > 1 ? 's' : ''}`;
    ec.classList.remove('hidden');
    btnRevertAll.classList.remove('hidden');
  } else {
    ec.classList.add('hidden');
    btnRevertAll.classList.add('hidden');
  }
  const diffNav = $('diffNav');
  if (compare && slots.A && slots.B) {
    const d = diffStats();
    $('diffCount').textContent = `${d.count.toLocaleString()} diff${d.count === 1 ? '' : 's'}`;
    diffNav.classList.remove('hidden');
  } else {
    diffNav.classList.add('hidden');
  }
}

// --- Master render ----------------------------------------------------------

function renderAll() {
  panes.B.el.hidden = !compare;
  $('viewwrap').classList.toggle('cmp', compare);
  renderPane('A');
  if (compare) renderPane('B');
  renderTabs();
  renderToolbar();
  renderBlocks();
  renderInspector();
  $('btnSave').disabled = !slots[active];
}

// --- File loading ----------------------------------------------------------

function loadFiles(fileList) {
  const files = Array.from(fileList).slice(0, 2);
  let firstKey = null;
  const readNext = (i) => {
    if (i >= files.length) {
      if (firstKey) active = firstKey;
      $('dropzone').classList.add('hidden');
      $('output').classList.remove('hidden');
      $('cmpToggle').disabled = !(slots.A && slots.B);
      renderAll();
      return;
    }
    const file = files[i];
    const reader = new FileReader();
    reader.onload = () => {
      // Fill an empty slot first (A then B); otherwise replace the active slot.
      let key = !slots.A ? 'A' : !slots.B ? 'B' : active;
      slots[key] = makeSlot(file.name, reader.result);
      slots[key].blocks = computeBlocks(slots[key].bytes, gapThreshold());
      if (!firstKey) firstKey = key;
      readNext(i + 1);
    };
    reader.readAsArrayBuffer(file);
  };
  readNext(0);
}

// --- Event wiring -----------------------------------------------------------

const dz = $('dropzone');
$('btnPick').addEventListener('click', () => $('fileInput').click());
dz.addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', (e) => { if (e.target.files.length) loadFiles(e.target.files); e.target.value = ''; });

['dragenter', 'dragover'].forEach((ev) =>
  dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) =>
  dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
dz.addEventListener('drop', (e) => { if (e.dataTransfer.files.length) loadFiles(e.dataTransfer.files); });

// Pane scroll (virtualization + compare sync)
function onScroll(key) {
  return () => {
    if (syncing) return;
    if (compare) {
      const other = key === 'A' ? 'B' : 'A';
      syncing = true;
      panes[other].el.scrollTop = panes[key].el.scrollTop;
      syncing = false;
      renderPane(other);
    }
    renderPane(key);
  };
}
panes.A.el.addEventListener('scroll', onScroll('A'));
panes.B.el.addEventListener('scroll', onScroll('B'));

// Byte selection
function paneClick(key) {
  return (e) => {
    const off = e.target.getAttribute && e.target.getAttribute('data-off');
    if (off == null) return;
    active = key;
    const idx = parseInt(off, 10);
    slots[key].cursor = idx;
    if (compare && slots.A && slots.B) {
      slots[key === 'A' ? 'B' : 'A'].cursor = idx;
    }
    renderAll();
  };
}
panes.A.el.addEventListener('click', paneClick('A'));
panes.B.el.addEventListener('click', paneClick('B'));

// Tabs
$('fileTabs').addEventListener('click', (e) => {
  const key = e.target.closest('[data-tab]')?.getAttribute('data-tab');
  if (!key) return;
  active = key;
  renderAll();
});

// Block map → scroll to block start
function blockClick(e) {
  const el = e.target.closest('[data-blk]');
  if (!el) return;
  const slot = slots[active];
  const bl = slot && slot.blocks[+el.getAttribute('data-blk')];
  if (!bl) return;
  slot.cursor = bl.start;
  if (compare && slots.A && slots.B) slots[active === 'A' ? 'B' : 'A'].cursor = bl.start;
  scrollToOffset(active, bl.start);
  if (compare) { syncing = true; panes.B.el.scrollTop = panes.A.el.scrollTop; syncing = false; renderPane('B'); }
  renderInspector();
  renderTabs();
}
$('blockBar').addEventListener('click', blockClick);
$('blockList').addEventListener('click', blockClick);

// Compare toggle
$('cmpToggle').addEventListener('change', (e) => {
  compare = e.target.checked && !!(slots.A && slots.B);
  if (compare) { syncing = true; panes.B.el.scrollTop = panes.A.el.scrollTop; syncing = false; }
  renderAll();
});

// Diff navigation
$('btnNextDiff').addEventListener('click', () => gotoDiff(1));
$('btnPrevDiff').addEventListener('click', () => gotoDiff(-1));

// Go to offset
$('gotoInput').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const raw = e.target.value.trim();
  if (!raw) return;
  const off = raw.toLowerCase().startsWith('0x') ? parseInt(raw, 16) : parseInt(raw, 10);
  const slot = slots[active];
  if (!slot || !Number.isFinite(off) || off < 0 || off >= slot.bytes.length) return;
  slot.cursor = off;
  if (compare && slots.A && slots.B) slots[active === 'A' ? 'B' : 'A'].cursor = off;
  scrollToOffset(active, off);
  if (compare) { syncing = true; panes.B.el.scrollTop = panes.A.el.scrollTop; syncing = false; renderPane('B'); }
  renderInspector();
  renderTabs();
});

// Byte editing
function commitEdit() {
  const slot = slots[active];
  if (!slot || slot.cursor < 0) return;
  const raw = $('editHex').value.trim();
  const val = parseInt(raw, 16);
  if (!/^[0-9a-fA-F]{1,2}$/.test(raw) || !Number.isFinite(val)) { $('editHex').classList.add('bad'); return; }
  $('editHex').classList.remove('bad');
  applyEdit(slot, slot.cursor, val);
  renderAll();
}
$('btnApplyEdit').addEventListener('click', commitEdit);
$('editHex').addEventListener('keydown', (e) => { if (e.key === 'Enter') commitEdit(); });
$('btnRevertByte').addEventListener('click', () => {
  const slot = slots[active];
  if (slot && slot.cursor >= 0) { revertByte(slot, slot.cursor); renderAll(); }
});
$('btnRevertAll').addEventListener('click', () => {
  const slot = slots[active];
  if (slot) { revertAll(slot); renderAll(); }
});

// Gap threshold recompute
$('gapInput').addEventListener('input', () => {
  const th = gapThreshold();
  for (const key of ['A', 'B']) if (slots[key]) slots[key].blocks = computeBlocks(slots[key].bytes, th);
  renderBlocks();
});

// Save / download
$('btnSave').addEventListener('click', () => {
  const slot = slots[active];
  if (!slot) return;
  const blob = new Blob([slot.bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = slot.edits.size ? `edited-${slot.name}` : slot.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
