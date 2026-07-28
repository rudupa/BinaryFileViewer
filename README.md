# Binary File Viewer

[![Live Demo](https://img.shields.io/badge/Live%20Demo-online-3fb950?style=flat)](https://rudupa.github.io/BinaryFileViewer/)
[![License: MIT](https://img.shields.io/badge/License-MIT-a371f7?style=flat)](LICENSE)
![Vanilla JS](https://img.shields.io/badge/Built%20with-Vanilla%20JS-d29922?style=flat)

A fast **hex viewer & editor for any file**, right in your browser. Offset / hex /
ASCII layout with **smooth full-file scrolling** (no paging), a **data inspector**
that decodes the bytes at the cursor as int/float/string in both endiannesses,
**in-browser byte editing with download**, a **block / contiguity map**, and
**side-by-side compare of two files** with byte-diff highlighting. Built with
vanilla HTML/CSS/JavaScript — no build step, no dependencies, and **nothing is
uploaded**: files are read locally with the `FileReader` API.

## Features

- Offset / hex / ASCII columns, 16 bytes per row.
- **Virtualized scrolling** — scroll the entire file smoothly, no pages.
- **Open up to two files** (A / B) and switch between them with tabs.
- **Compare A/B** side by side with differing bytes highlighted, plus
  prev/next-diff navigation and a diff count.
- **Block map** — detects whether the file's data is contiguous or split into
  multiple blocks by long runs of `0x00` / `0xFF` fill (configurable gap
  threshold); click a block to jump to it.
- **Edit bytes** in the data inspector and **download** the modified file — all
  client-side; edited bytes are highlighted and revertible.
- Click any byte to inspect it: uint/int 8/16/32, float32/64, binary, and the
  ASCII string starting at that offset — little- and big-endian.
- Go-to-offset (hex or decimal). Works with any file type.

## Roadmap

- [ ] Hex/ASCII search.
- [ ] Byte highlighting for known formats (PNG, ELF, ZIP…).
- [ ] Insert / delete bytes (not just overwrite).

## Run it

Open the [live demo](https://rudupa.github.io/BinaryFileViewer/), then drag in a
file. To run locally, just open `index.html` (no server needed). Your file never
leaves your machine.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Page structure, drop zone, tabs, block map, hex panes, inspector |
| `styles.css` | Dark theme |
| `app.js` | Virtualized hex rendering, block detection, compare, editing, save |

## Author

**Ritesh Udupa** — [LinkedIn](https://www.linkedin.com/in/ritesh-udupa-4b694619/) · [GitHub](https://github.com/rudupa)

## License

MIT — see [LICENSE](LICENSE).
