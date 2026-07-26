'use strict';

/**
 * Binary File Viewer (starter scaffold)
 *
 * A classic hex viewer for any file: offset / hex / ASCII columns, paged so
 * large files stay responsive, plus a data inspector that decodes the bytes at
 * the clicked offset as int/float/string in both endiannesses.
 *
 * Everything runs locally — the file is never uploaded.
 *
 * Extend from here: search (hex/ASCII), go-to-offset, editing + save, byte
 * highlighting for known formats, and virtualized scrolling for huge files.
 */

const $ = (id) => document.getElementById(id);

const BYTES_PER_ROW = 16;
const ROWS_PER_PAGE = 32;              // 512 bytes per page
const PAGE_SIZE = BYTES_PER_ROW * ROWS_PER_PAGE;

let bytes = null;      // Uint8Array
let dv = null;         // DataView
let page = 0;
let cursor = -1;       // absolute byte offset selected

const hex2 = (n) => n.toString(16).padStart(2, '0');
const hex8 = (n) => n.toString(16).padStart(8, '0');
const printable = (b) => (b >= 0x20 && b <= 0x7e);

function renderHex() {
  const start = page * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, bytes.length);
  const view = $('hexview');
  const rows = [];

  for (let off = start; off < end; off += BYTES_PER_ROW) {
    let hexPart = '';
    let asciiPart = '';
    for (let i = 0; i < BYTES_PER_ROW; i++) {
      const idx = off + i;
      if (idx < end) {
        const b = bytes[idx];
        const sel = idx === cursor ? ' style="color:var(--sel);font-weight:700"' : '';
        hexPart += `<span data-off="${idx}"${sel}>${hex2(b)}</span> `;
        const ch = printable(b) ? String.fromCharCode(b) : '.';
        const cls = printable(b) ? 'hex-ascii' : 'hex-nonascii';
        asciiPart += `<span class="${cls}" data-off="${idx}"${sel}>${ch === '<' ? '&lt;' : ch === '&' ? '&amp;' : ch}</span>`;
      } else {
        hexPart += '   ';
        asciiPart += ' ';
      }
      if (i === 7) hexPart += ' ';
    }
    rows.push(
      `<div class="hex-row"><span class="hex-offset">${hex8(off)}</span>` +
      `<span class="hex-sep">  </span><span class="hex-bytes">${hexPart}</span>` +
      `<span class="hex-sep"> |</span>${asciiPart}<span class="hex-sep">|</span></div>`
    );
  }
  view.innerHTML = rows.join('');

  const totalPages = Math.max(1, Math.ceil(bytes.length / PAGE_SIZE));
  $('pageInfo').textContent = `Page ${page + 1} / ${totalPages} · offset ${hex8(start)}`;
  $('btnPrev').disabled = page === 0;
  $('btnNext').disabled = page >= totalPages - 1;
}

function renderInspector() {
  const kv = $('inspectorKv');
  if (cursor < 0) { kv.innerHTML = '<div class="k">—</div><div class="v">Click a byte above.</div>'; $('cursorOff').textContent = ''; return; }
  $('cursorOff').textContent = `@ 0x${hex8(cursor)} (${cursor})`;

  const remain = bytes.length - cursor;
  const rows = [];
  const add = (k, v) => rows.push(`<div class="k">${k}</div><div class="v">${v}</div>`);

  const b = bytes[cursor];
  add('uint8', b);
  add('int8', dv.getInt8(cursor));
  add('binary', b.toString(2).padStart(8, '0'));
  if (remain >= 2) {
    add('uint16 (LE / BE)', `${dv.getUint16(cursor, true)} / ${dv.getUint16(cursor, false)}`);
    add('int16 (LE / BE)', `${dv.getInt16(cursor, true)} / ${dv.getInt16(cursor, false)}`);
  }
  if (remain >= 4) {
    add('uint32 (LE / BE)', `${dv.getUint32(cursor, true)} / ${dv.getUint32(cursor, false)}`);
    add('int32 (LE / BE)', `${dv.getInt32(cursor, true)} / ${dv.getInt32(cursor, false)}`);
    add('float32 (LE / BE)', `${dv.getFloat32(cursor, true).toPrecision(7)} / ${dv.getFloat32(cursor, false).toPrecision(7)}`);
  }
  if (remain >= 8) {
    add('float64 (LE / BE)', `${dv.getFloat64(cursor, true).toPrecision(10)} / ${dv.getFloat64(cursor, false).toPrecision(10)}`);
  }
  // ASCII string starting here (up to 24 printable chars).
  let s = '';
  for (let i = cursor; i < bytes.length && s.length < 24; i++) {
    if (!printable(bytes[i])) break;
    s += String.fromCharCode(bytes[i]);
  }
  add('ASCII string', s ? `"${s.replace(/</g, '&lt;')}"` : '(none)');

  kv.innerHTML = rows.join('');
}

$('hexview').addEventListener('click', (e) => {
  const off = e.target.getAttribute && e.target.getAttribute('data-off');
  if (off === null || off === undefined) return;
  cursor = parseInt(off, 10);
  renderHex();
  renderInspector();
});

function render() {
  $('dropzone').classList.add('hidden');
  $('output').classList.remove('hidden');
  renderHex();
  renderInspector();
}

$('btnPrev').addEventListener('click', () => { if (page > 0) { page--; renderHex(); } });
$('btnNext').addEventListener('click', () => { page++; renderHex(); });

// --- File loading ----------------------------------------------------------

function handleFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    bytes = new Uint8Array(reader.result);
    dv = new DataView(reader.result);
    page = 0; cursor = -1;
    $('fname').textContent = file.name;
    $('fsize').textContent = `${bytes.length.toLocaleString()} bytes`;
    render();
  };
  reader.readAsArrayBuffer(file);
}

const dz = $('dropzone');
$('btnPick').addEventListener('click', () => $('fileInput').click());
dz.addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); });

['dragenter', 'dragover'].forEach((ev) =>
  dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) =>
  dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
dz.addEventListener('drop', (e) => { if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
