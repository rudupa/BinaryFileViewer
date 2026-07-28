'use strict';

/**
 * Hex Lens & Editor
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
let syncScroll = true; // in compare mode, keep the two panes scrolled together
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
 * @property {number} cursor        active byte (also the selection anchor)
 * @property {number} selEnd        other end of the selection (-1 = none)
 * @property {number} editedCount   in-place modified bytes (valid while length unchanged)
 * @property {boolean} structChanged true once a length-changing edit happened
 * @property {Array<{start:number,end:number}>} blocks
 */

function makeSlot(name, buffer) {
  const bytes = new Uint8Array(buffer);
  return {
    name,
    bytes,
    original: bytes.slice(),
    dv: new DataView(buffer),
    cursor: -1,
    selEnd: -1,
    editedCount: 0,
    structChanged: false,
    blocks: [],
    baseAddr: 0,       // memory address of bytes[0] (for S-record / Intel HEX)
    format: 'raw',     // 'raw' | 'S-record' | 'Intel HEX'
    parsed: false,     // true when blocks come from record coverage, not the gap heuristic
  };
}

// --- Selection / edit-state helpers ----------------------------------------

/** Inclusive selection bounds {lo, hi}, or null when nothing is selected. */
function selBounds(slot) {
  if (!slot || slot.cursor < 0) return null;
  const a = slot.cursor;
  const b = slot.selEnd < 0 ? a : slot.selEnd;
  return { lo: Math.min(a, b), hi: Math.max(a, b) };
}

/** Move the cursor and collapse any selection to that single byte. */
function setCursor(slot, off) { slot.cursor = off; slot.selEnd = off; }

function isEdited(slot, idx) {
  return !slot.structChanged && slot.bytes.length === slot.original.length &&
    slot.bytes[idx] !== slot.original[idx];
}

function isDirty(slot) { return slot.structChanged || slot.editedCount > 0; }

/** Full recount of in-place edits vs the original (used after range ops). */
function recountEdits(slot) {
  if (slot.bytes.length !== slot.original.length) { slot.editedCount = 0; return; }
  let c = 0;
  for (let i = 0; i < slot.bytes.length; i++) if (slot.bytes[i] !== slot.original[i]) c++;
  slot.editedCount = c;
}

/** Parse a hex string ("DE AD BE EF", "deadbeef", "de,ad") to bytes, or null. */
function parseHexBytes(str) {
  const clean = str.replace(/0x/gi, '').replace(/[\s,]+/g, '');
  if (clean.length === 0 || clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

// --- Record-file parsing (Motorola S-record / Intel HEX) -------------------

/**
 * Parse a Motorola S-record or Intel HEX text file into a flat memory image.
 * Returns { bytes, baseAddr, blocks, format } where blocks are array-relative
 * [start,end) ranges of actually-covered addresses, or null if not a record file.
 */
function parseRecordFile(buffer) {
  let text;
  try { text = new TextDecoder('latin1').decode(new Uint8Array(buffer)); }
  catch { return null; }
  const firstLine = (text.match(/\S.*/) || [''])[0].trim();
  if (/^S[0-9]/.test(firstLine)) return parseSRecord(text);
  if (firstLine.startsWith(':')) return parseIntelHex(text);
  return null;
}

const RE_HEX_LINE = /[^0-9a-fA-F]/;

function buildImage(records, format) {
  if (!records.length) return null;
  let min = Infinity, max = -Infinity;
  for (const r of records) {
    if (r.data.length === 0) continue;
    if (r.addr < min) min = r.addr;
    if (r.addr + r.data.length > max) max = r.addr + r.data.length;
  }
  if (!Number.isFinite(min) || max <= min) return null;
  const size = max - min;
  const bytes = new Uint8Array(size).fill(0xff);
  for (const r of records) bytes.set(r.data, r.addr - min);
  // Coverage-based blocks: merge contiguous/overlapping records, break on gaps.
  const sorted = records.filter((r) => r.data.length).sort((a, b) => a.addr - b.addr);
  const blocks = [];
  let bs = sorted[0].addr, be = sorted[0].addr + sorted[0].data.length;
  for (let i = 1; i < sorted.length; i++) {
    const s = sorted[i].addr, e = s + sorted[i].data.length;
    if (s <= be) { if (e > be) be = e; }
    else { blocks.push({ start: bs - min, end: be - min }); bs = s; be = e; }
  }
  blocks.push({ start: bs - min, end: be - min });
  return { bytes, baseAddr: min, blocks, format };
}

function parseSRecord(text) {
  const addrLen = { '1': 2, '2': 3, '3': 4 };
  const records = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (line.length < 4 || line[0] !== 'S') continue;
    const type = line[1];
    const al = addrLen[type];
    if (!al) continue; // header/count/termination records carry no image data
    const body = line.slice(2);
    if (RE_HEX_LINE.test(body)) continue;
    const count = parseInt(body.slice(0, 2), 16);
    if (!Number.isFinite(count)) continue;
    const addr = parseInt(body.slice(2, 2 + al * 2), 16);
    const dataHex = body.slice(2 + al * 2, 2 + count * 2 - 2); // drop trailing checksum byte
    const data = new Uint8Array(Math.max(0, dataHex.length / 2));
    for (let i = 0; i < data.length; i++) data[i] = parseInt(dataHex.substr(i * 2, 2), 16);
    records.push({ addr, data });
  }
  return buildImage(records, 'S-record');
}

function parseIntelHex(text) {
  const records = [];
  let upper = 0; // extended linear/segment base
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (line[0] !== ':') continue;
    const body = line.slice(1);
    if (RE_HEX_LINE.test(body) || body.length < 10) continue;
    const count = parseInt(body.slice(0, 2), 16);
    const off = parseInt(body.slice(2, 6), 16);
    const type = parseInt(body.slice(6, 8), 16);
    const dataHex = body.slice(8, 8 + count * 2);
    if (type === 0x00) {
      const data = new Uint8Array(count);
      for (let i = 0; i < count; i++) data[i] = parseInt(dataHex.substr(i * 2, 2), 16);
      records.push({ addr: upper + off, data });
    } else if (type === 0x04) {
      upper = parseInt(dataHex.slice(0, 4), 16) << 16;
    } else if (type === 0x02) {
      upper = parseInt(dataHex.slice(0, 4), 16) << 4;
    } else if (type === 0x01) {
      break; // EOF
    }
  }
  return buildImage(records, 'Intel HEX');
}

// --- Block / contiguity detection ------------------------------------------

function gapThreshold() {
  const v = parseInt($('gapInput').value, 10);
  return Number.isFinite(v) && v > 0 ? v : 64;
}

/**
 * Which byte value counts as unused padding.
 * @returns {number|null} the fill byte, or null for "none".
 */
function gapFillByte() {
  const mode = $('gapFill').value;
  if (mode === 'ff') return 0xff;
  if (mode === '00') return 0x00;
  if (mode === 'custom') {
    const v = parseInt($('gapCustom').value, 16);
    return Number.isFinite(v) ? (v & 0xff) : null;
  }
  return null; // 'none'
}

/** Recompute blocks for a slot, preserving record-derived blocks for parsed files. */
function recomputeBlocks(slot) {
  if (slot.parsed) return; // coverage blocks are fixed by the record addresses
  slot.blocks = computeBlocks(slot.bytes, gapThreshold(), gapFillByte());
}

/**
 * Split the file into data blocks. Runs of `fill` at least `threshold` bytes
 * long are treated as gaps. When `fill` is null, the whole file is one block
 * (raw files have no "missing" bytes — only record files have real gaps, and
 * those are computed from record coverage instead).
 */
function computeBlocks(bytes, threshold, fill) {
  const n = bytes.length;
  if (fill == null) return n ? [{ start: 0, end: n }] : [];
  const blocks = [];
  let i = 0;
  let start = null;
  while (i < n) {
    const b = bytes[i];
    let j = i;
    while (j < n && bytes[j] === b) j++;
    const runLen = j - i;
    const isGap = b === fill && runLen >= threshold;
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
  const sel = selBounds(slot);
  let hexPart = '';
  let asciiPart = '';
  for (let i = 0; i < BPR; i++) {
    const idx = off + i;
    if (idx < end) {
      const b = slot.bytes[idx];
      const cls = [];
      if (idx === slot.cursor) cls.push('cur');
      if (sel && sel.hi > sel.lo && idx >= sel.lo && idx <= sel.hi) cls.push('sel');
      if (isEdited(slot, idx)) cls.push('edt');
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
  return `<div class="hex-row"><span class="hex-offset">${hex8(slot.baseAddr + off)}</span>` +
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
  updateMarker(key);
  if (key === active) positionSelUI();
}

/** Position the scrubber marker at the byte currently centered in the pane. */
function updateMarker(key) {
  const slot = slots[key];
  const marker = $('blockMaps').querySelector(`.block-bar[data-file="${key}"] .blk-marker`);
  if (!slot || !marker) return;
  const p = panes[key];
  const centerByte = ((p.el.scrollTop + p.el.clientHeight / 2) / ROW_H) * BPR;
  const frac = Math.min(1, Math.max(0, centerByte / (slot.bytes.length || 1)));
  marker.style.left = frac * 100 + '%';
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
  if (!slot || slot.cursor < 0) {
    kv.innerHTML = '<div class="k">—</div><div class="v">Click a byte above.</div>';
    $('cursorOff').textContent = '';
    return;
  }
  const cur = slot.cursor;
  const dv = slot.dv;
  const sel = selBounds(slot);
  const selCount = sel.hi - sel.lo + 1;
  $('cursorOff').textContent = selCount > 1
    ? `0x${hex8(slot.baseAddr + sel.lo)} – 0x${hex8(slot.baseAddr + sel.hi)} · ${selCount} bytes · file ${active}`
    : `@ 0x${hex8(slot.baseAddr + cur)} (${slot.baseAddr + cur}) · file ${active}`;

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
}

// --- Editing ---------------------------------------------------------------

/** Replace bytes [lo..hi] (inclusive) with `repl`; may change file length. */
function replaceRange(slot, lo, hi, repl) {
  const removed = hi - lo + 1;
  if (repl.length === removed) {
    // In-place overwrite — length unchanged.
    slot.bytes.set(repl, lo);
    slot.dv = new DataView(slot.bytes.buffer);
    recountEdits(slot);
  } else {
    const next = new Uint8Array(slot.bytes.length - removed + repl.length);
    next.set(slot.bytes.subarray(0, lo), 0);
    next.set(repl, lo);
    next.set(slot.bytes.subarray(hi + 1), lo + repl.length);
    slot.bytes = next;
    slot.dv = new DataView(next.buffer);
    slot.structChanged = true;
    slot.editedCount = 0;
  }
  const newCursor = Math.min(lo, slot.bytes.length - 1);
  setCursor(slot, slot.bytes.length ? newCursor : -1);
  recomputeBlocks(slot);
}

function cutSelection(slot) {
  const sel = selBounds(slot);
  if (!sel) return;
  replaceRange(slot, sel.lo, sel.hi, new Uint8Array(0));
}

function revertAll(slot) {
  slot.bytes = slot.original.slice();
  slot.dv = new DataView(slot.bytes.buffer);
  slot.editedCount = 0;
  slot.structChanged = false;
  if (slot.cursor >= slot.bytes.length) setCursor(slot, slot.bytes.length - 1);
  recomputeBlocks(slot);
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
      setCursor(slots.A, i); setCursor(slots.B, i);
      scrollToOffset('A', i);
      if (compare) { syncing = true; panes.B.el.scrollTop = panes.A.el.scrollTop; syncing = false; renderPane('B'); }
      renderPane('A');
      renderInspector();
      return;
    }
  }
}

// --- Block map UI ----------------------------------------------------------

/** Contiguous ranges (over the longer file) where A and B differ. */
function computeDiffRanges() {
  if (!slots.A || !slots.B) return [];
  const maxLen = Math.max(slots.A.bytes.length, slots.B.bytes.length);
  const ranges = [];
  let start = -1;
  for (let i = 0; i < maxLen; i++) {
    if (isDiffAt(i)) { if (start < 0) start = i; }
    else if (start >= 0) { ranges.push({ start, end: i }); start = -1; }
  }
  if (start >= 0) ranges.push({ start, end: maxLen });
  return ranges;
}

function blockMapHtml(key, diffRanges, labelled) {
  const slot = slots[key];
  const n = slot.bytes.length || 1;
  const blocks = slot.blocks;
  let verdict, vcls;
  if (blocks.length <= 1) {
    verdict = blocks.length === 0 ? 'Empty / all-fill — no data blocks' : 'Contiguous — 1 data block';
    vcls = 'ok';
  } else {
    verdict = `Non-contiguous — ${blocks.length} data blocks (${blocks.length - 1} gap${blocks.length - 1 > 1 ? 's' : ''})`;
    vcls = 'warn';
  }
  const segs = blocks.map((bl, i) => {
    const left = (bl.start / n) * 100;
    const w = ((bl.end - bl.start) / n) * 100;
    return `<span class="blk-seg" data-file="${key}" data-blk="${i}" style="left:${left}%;width:${Math.max(w, 0.3)}%" title="Block ${i} · 0x${hex8(slot.baseAddr + bl.start)}–0x${hex8(slot.baseAddr + bl.end - 1)}"></span>`;
  }).join('');
  let diffSegs = '';
  if (diffRanges && diffRanges.length) {
    diffSegs = diffRanges.map((r) => {
      const left = (r.start / n) * 100;
      const w = ((r.end - r.start) / n) * 100;
      return `<span class="blk-diff" data-file="${key}" data-off="${r.start}" style="left:${left}%;width:${Math.max(w, 0.3)}%" title="Diff 0x${hex8(slot.baseAddr + r.start)}–0x${hex8(slot.baseAddr + r.end - 1)}"></span>`;
    }).join('');
  }
  const list = blocks.map((bl, i) =>
    `<div class="blk-item" data-file="${key}" data-blk="${i}"><span class="blk-idx">#${i}</span>` +
    `<span class="mono">0x${hex8(slot.baseAddr + bl.start)} – 0x${hex8(slot.baseAddr + bl.end - 1)}</span>` +
    `<span class="blk-size">${(bl.end - bl.start).toLocaleString()} B</span></div>`
  ).join('') || '<div class="blk-item muted">no data blocks</div>';
  const head = labelled
    ? `<div class="block-map-head"><span class="blk-label"><span class="blk-file">${key}</span> ${slot.name}</span>` +
      `<span class="verdict ${vcls}">${verdict}</span></div>`
    : `<div class="block-map-head"><span class="verdict ${vcls}">${verdict}</span></div>`;
  return `<div class="block-map">${head}` +
    `<div class="block-bar" data-file="${key}" title="Click or drag to scrub through the file">${segs}${diffSegs}<span class="blk-marker"></span></div>` +
    `<div class="block-list">${list}</div></div>`;
}

function renderBlocks() {
  const host = $('blockMaps');
  const legend = $('cmpLegend');
  if (!slots.A && !slots.B) { host.innerHTML = ''; legend.classList.add('hidden'); return; }
  const both = compare && slots.A && slots.B;
  const keys = both ? ['A', 'B'] : [active];
  const diffRanges = both ? computeDiffRanges() : null;
  host.innerHTML = keys.map((k) => blockMapHtml(k, diffRanges, both)).join('');
  legend.classList.toggle('hidden', !both);
  keys.forEach(updateMarker);
}


// --- Tabs / toolbar --------------------------------------------------------

function renderTabs() {
  const tabs = $('fileTabs');
  const html = [];
  for (const key of ['A', 'B']) {
    const s = slots[key];
    if (!s) continue;
    const cls = key === active ? 'file-tab active' : 'file-tab';
    const dot = isDirty(s) ? ' <span class="edt-dot">●</span>' : '';
    html.push(`<button class="${cls}" data-tab="${key}" title="${s.name}">${key}: ${s.name}${dot}</button>`);
  }
  tabs.innerHTML = html.join('');
}

function renderToolbar() {
  const slot = slots[active];
  $('fname').textContent = slot ? slot.name : '—';
  $('fsize').textContent = slot
    ? `${slot.bytes.length.toLocaleString()} bytes${slot.parsed ? ` · ${slot.format} @ 0x${hex8(slot.baseAddr)}` : ''}`
    : '—';
  const ec = $('editCount');
  const btnRevertAll = $('btnRevertAll');
  if (slot && isDirty(slot)) {
    ec.textContent = slot.structChanged
      ? `modified (${slot.original.length.toLocaleString()} → ${slot.bytes.length.toLocaleString()} B)`
      : `${slot.editedCount} edit${slot.editedCount > 1 ? 's' : ''}`;
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
      const parsed = parseRecordFile(reader.result);
      if (parsed) {
        const slot = makeSlot(file.name, parsed.bytes.buffer);
        slot.baseAddr = parsed.baseAddr;
        slot.format = parsed.format;
        slot.parsed = true;
        slot.blocks = parsed.blocks;
        slots[key] = slot;
      } else {
        slots[key] = makeSlot(file.name, reader.result);
        recomputeBlocks(slots[key]);
      }
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
    if (compare && syncScroll) {
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

// Byte selection — click to place the cursor, click-drag or shift-click to
// select a range. Double-click opens the in-place hex editor.
let dragSel = null;                       // { key, anchor } while dragging
let lastClick = { key: null, off: -1, t: 0 };

function cellOffAtPoint(x, y) {
  const el = document.elementFromPoint(x, y);
  const cell = el && el.closest && el.closest('span[data-off]');
  return cell ? parseInt(cell.getAttribute('data-off'), 10) : null;
}

function mirrorSelection(key) {
  if (!(compare && slots.A && slots.B)) return;
  const src = slots[key];
  const dst = slots[key === 'A' ? 'B' : 'A'];
  dst.cursor = src.cursor;
  dst.selEnd = src.selEnd;
}

function panePointerDown(key) {
  return (e) => {
    if (e.button !== 0) return;
    const cell = e.target.closest && e.target.closest('span[data-off]');
    if (!cell) return;
    const idx = parseInt(cell.getAttribute('data-off'), 10);
    active = key;
    const slot = slots[key];
    const now = performance.now();
    const isDouble = lastClick.key === key && lastClick.off === idx && (now - lastClick.t) < 400;
    lastClick = { key, off: idx, t: now };

    if (e.shiftKey && slot.cursor >= 0) {
      slot.selEnd = idx;                  // extend from the existing anchor
    } else {
      setCursor(slot, idx);
      dragSel = { key, anchor: idx };
      try { panes[key].el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    }
    hideSelEditor();
    mirrorSelection(key);
    renderAll();

    if (isDouble && !e.shiftKey) { dragSel = null; openSelEditor(); }
  };
}

function panePointerMove(key) {
  return (e) => {
    if (!dragSel || dragSel.key !== key) return;
    const idx = cellOffAtPoint(e.clientX, e.clientY);
    if (idx == null) return;
    const slot = slots[key];
    slot.cursor = dragSel.anchor;
    slot.selEnd = idx;
    mirrorSelection(key);
    renderPane(key);
    if (compare) renderPane(key === 'A' ? 'B' : 'A');
    renderInspector();
  };
}

function panePointerUp(key) {
  return (e) => {
    if (dragSel && dragSel.key === key) {
      try { panes[key].el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      dragSel = null;
      positionSelUI();
    }
  };
}

for (const key of ['A', 'B']) {
  panes[key].el.addEventListener('pointerdown', panePointerDown(key));
  panes[key].el.addEventListener('pointermove', panePointerMove(key));
  panes[key].el.addEventListener('pointerup', panePointerUp(key));
  panes[key].el.addEventListener('pointercancel', panePointerUp(key));
}

// --- Floating selection UI: edit / cut icons + in-place hex editor ----------

const selBar = document.createElement('div');
selBar.className = 'sel-toolbar hidden';
selBar.innerHTML =
  `<button class="sel-ico" data-act="edit" title="Edit selected bytes">✎</button>` +
  `<button class="sel-ico" data-act="cut" title="Cut selected bytes">✂</button>`;
document.body.appendChild(selBar);

let selEditorEl = null; // floating hex editor while editing

function hideSelEditor() { if (selEditorEl) { selEditorEl.remove(); selEditorEl = null; } }
function hideSelUI() { selBar.classList.add('hidden'); hideSelEditor(); }

/** Anchor the toolbar (and open editor) to the end of the selection, if visible. */
function positionSelUI() {
  const slot = slots[active];
  if (!slot || slot.cursor < 0 || dragSel) { selBar.classList.add('hidden'); return; }
  const sel = selBounds(slot);
  const cell = panes[active].win.querySelector(`.hex-bytes span[data-off="${sel.hi}"]`);
  const paneRect = panes[active].el.getBoundingClientRect();
  if (!cell) { selBar.classList.add('hidden'); hideSelEditor(); return; }
  const rect = cell.getBoundingClientRect();
  if (rect.bottom < paneRect.top || rect.top > paneRect.bottom) {
    selBar.classList.add('hidden'); hideSelEditor(); return;
  }
  selBar.classList.remove('hidden');
  selBar.style.left = `${rect.right + 6}px`;
  selBar.style.top = `${rect.top}px`;
  if (selEditorEl) {
    selEditorEl.style.left = `${Math.min(rect.right + 6, window.innerWidth - 320)}px`;
    selEditorEl.style.top = `${rect.bottom + 4}px`;
  }
}

selBar.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.getAttribute('data-act');
  const slot = slots[active];
  if (!slot || slot.cursor < 0) return;
  if (act === 'edit') openSelEditor();
  else if (act === 'cut') { cutSelection(slot); hideSelEditor(); renderAll(); }
});

function openSelEditor() {
  hideSelEditor();
  const slot = slots[active];
  const sel = selBounds(slot);
  if (!sel) return;
  const count = sel.hi - sel.lo + 1;
  const hex = [];
  for (let i = sel.lo; i <= sel.hi; i++) hex.push(hex2(slot.bytes[i]));

  const wrap = document.createElement('div');
  wrap.className = 'sel-editor';
  wrap.innerHTML =
    `<textarea class="sel-hex mono" spellcheck="false"></textarea>` +
    `<div class="sel-ed-hint"><span class="sel-ed-count"></span>` +
    `<span>Enter applies (length must match) · Esc cancels</span></div>`;
  document.body.appendChild(wrap);
  selEditorEl = wrap;

  const ta = wrap.querySelector('.sel-hex');
  const countEl = wrap.querySelector('.sel-ed-count');
  ta.value = hex.join(' ');

  const refresh = () => {
    const parsed = parseHexBytes(ta.value);
    if (!parsed) { countEl.textContent = 'invalid hex'; countEl.className = 'sel-ed-count bad'; ta.classList.add('bad'); return null; }
    ta.classList.remove('bad');
    const ok = parsed.length === count;
    countEl.textContent = `${parsed.length} / ${count} bytes`;
    countEl.className = 'sel-ed-count ' + (ok ? 'ok' : 'bad');
    return ok ? parsed : null;
  };
  refresh();

  ta.addEventListener('input', refresh);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const parsed = refresh();
      if (parsed) { replaceRange(slot, sel.lo, sel.hi, parsed); hideSelEditor(); renderAll(); }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hideSelEditor();
    }
  });
  positionSelUI();
  ta.focus();
  ta.select();
}

// Tabs
$('fileTabs').addEventListener('click', (e) => {
  const key = e.target.closest('[data-tab]')?.getAttribute('data-tab');
  if (!key) return;
  active = key;
  renderAll();
});

// Block map scrubber: click or drag anywhere on the bar to scrub through the
// file; clicking a block-list item jumps to that block's start.
let scrub = null; // { key, bar } while dragging

function scrubToClientX(key, bar, clientX) {
  const slot = slots[key];
  if (!slot) return;
  const rect = bar.getBoundingClientRect();
  const frac = Math.min(0.999999, Math.max(0, (clientX - rect.left) / rect.width));
  const off = Math.floor(frac * slot.bytes.length);
  active = key;
  scrollToOffset(key, off);
  if (compare && syncScroll && slots.A && slots.B) {
    const other = key === 'A' ? 'B' : 'A';
    syncing = true; panes[other].el.scrollTop = panes[key].el.scrollTop; syncing = false;
    renderPane(other);
  }
  renderToolbar();
}

const blockMaps = $('blockMaps');
blockMaps.addEventListener('pointerdown', (e) => {
  const bar = e.target.closest('.block-bar');
  if (bar) {
    const key = bar.getAttribute('data-file') || active;
    if (!slots[key]) return;
    scrub = { key, bar };
    try { bar.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    scrubToClientX(key, bar, e.clientX);
    e.preventDefault();
    return;
  }
  const item = e.target.closest('.blk-item[data-blk]');
  if (item) {
    const key = item.getAttribute('data-file') || active;
    const slot = slots[key];
    const bl = slot && slot.blocks[+item.getAttribute('data-blk')];
    if (!bl) return;
    active = key;
    setCursor(slot, bl.start);
    if (compare && slots.A && slots.B) setCursor(slots[key === 'A' ? 'B' : 'A'], bl.start);
    scrollToOffset(key, bl.start);
    if (compare && syncScroll && slots.A && slots.B) {
      const other = key === 'A' ? 'B' : 'A';
      syncing = true; panes[other].el.scrollTop = panes[key].el.scrollTop; syncing = false;
      renderPane(other);
    }
    renderInspector();
    renderTabs();
    renderToolbar();
  }
});
blockMaps.addEventListener('pointermove', (e) => {
  if (!scrub) return;
  scrubToClientX(scrub.key, scrub.bar, e.clientX);
});
function endScrub() { scrub = null; }
blockMaps.addEventListener('pointerup', endScrub);
blockMaps.addEventListener('pointercancel', endScrub);


// Compare toggle
$('cmpToggle').addEventListener('change', (e) => {
  compare = e.target.checked && !!(slots.A && slots.B);
  $('syncToggle').disabled = !compare;
  if (compare && syncScroll) { syncing = true; panes.B.el.scrollTop = panes.A.el.scrollTop; syncing = false; }
  renderAll();
});

// Sync-scroll toggle
$('syncToggle').addEventListener('change', (e) => {
  syncScroll = e.target.checked;
  if (compare && syncScroll) {
    syncing = true; panes.B.el.scrollTop = panes.A.el.scrollTop; syncing = false;
    renderPane('A'); renderPane('B');
  }
});

// Diff navigation
$('btnNextDiff').addEventListener('click', () => gotoDiff(1));
$('btnPrevDiff').addEventListener('click', () => gotoDiff(-1));

// Go to offset
$('gotoInput').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const raw = e.target.value.trim();
  if (!raw) return;
  const addr = raw.toLowerCase().startsWith('0x') ? parseInt(raw, 16) : parseInt(raw, 10);
  const slot = slots[active];
  if (!slot || !Number.isFinite(addr)) return;
  const off = addr - slot.baseAddr; // input is a memory address (== file offset when baseAddr is 0)
  if (off < 0 || off >= slot.bytes.length) return;
  setCursor(slot, off);
  if (compare && slots.A && slots.B) setCursor(slots[active === 'A' ? 'B' : 'A'], off);
  scrollToOffset(active, off);
  if (compare && syncScroll) { syncing = true; panes.B.el.scrollTop = panes.A.el.scrollTop; syncing = false; renderPane('B'); }
  renderInspector();
  renderTabs();
});

// Byte editing is handled by the floating selection toolbar (edit / cut icons)
// and the in-place hex editor; see the pane pointer handlers above.
$('btnRevertAll').addEventListener('click', () => {
  const slot = slots[active];
  if (slot) { revertAll(slot); renderAll(); }
});

// Delete / Backspace cuts the current selection (unless typing in an input).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
  const slot = slots[active];
  if (!slot || slot.cursor < 0) return;
  e.preventDefault();
  cutSelection(slot);
  renderAll();
});

// Gap detection recompute (fill-byte mode, custom value, or min-run length)
function recomputeAllBlocks() {
  for (const key of ['A', 'B']) if (slots[key]) recomputeBlocks(slots[key]);
  renderBlocks();
}
$('gapInput').addEventListener('input', recomputeAllBlocks);
$('gapCustom').addEventListener('input', recomputeAllBlocks);
$('gapFill').addEventListener('change', () => {
  $('gapCustom').classList.toggle('hidden', $('gapFill').value !== 'custom');
  recomputeAllBlocks();
});

// Save / download
$('btnSave').addEventListener('click', () => {
  const slot = slots[active];
  if (!slot) return;
  const blob = new Blob([slot.bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = isDirty(slot) ? `edited-${slot.name}` : slot.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
