# Binary File Viewer

[![Live Demo](https://img.shields.io/badge/Live%20Demo-online-3fb950?style=flat)](https://rudupa.github.io/BinaryFileViewer/)
[![License: MIT](https://img.shields.io/badge/License-MIT-a371f7?style=flat)](LICENSE)
![Vanilla JS](https://img.shields.io/badge/Built%20with-Vanilla%20JS-d29922?style=flat)

A fast **hex viewer for any file**, right in your browser. Classic
offset / hex / ASCII layout with paging, plus a **data inspector** that decodes
the bytes at the cursor as int/float/string in both endiannesses. Built with
vanilla HTML/CSS/JavaScript — no build step, no dependencies, and **nothing is
uploaded**: the file is read locally with the `FileReader` API.

## Features

- Offset / hex / ASCII columns, 16 bytes per row.
- Paged view so large files stay responsive.
- Click any byte to inspect it: uint/int 8/16/32, float32/64, binary, and the
  ASCII string starting at that offset — little- and big-endian.
- Works with any file type.

## Roadmap

- [ ] Hex/ASCII search and go-to-offset.
- [ ] Virtualized scrolling for very large files.
- [ ] Byte highlighting for known formats (PNG, ELF, ZIP…).
- [ ] Editing and save-as.

## Run it

Open the [live demo](https://rudupa.github.io/BinaryFileViewer/), then drag in a
file. To run locally, just open `index.html` (no server needed). Your file never
leaves your machine.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Page structure, drop zone, hex view, inspector |
| `styles.css` | Dark theme |
| `app.js` | Hex rendering + data inspector |

## Author

**Ritesh Udupa** — [LinkedIn](https://www.linkedin.com/in/ritesh-udupa-4b694619/) · [GitHub](https://github.com/rudupa)

## License

MIT — see [LICENSE](LICENSE).
