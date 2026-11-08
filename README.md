# WebP Forge

**Fast, private, multi-core WebP image and camera RAW converter running 100% in your browser.**

[![Live Demo](https://img.shields.io/badge/Live_Demo-GitHub_Pages-c05f3c?style=for-the-badge)](https://malhar-jani.github.io/webp-forge/)
[![License: ISC](https://img.shields.io/badge/License-ISC-4b8a5f?style=for-the-badge)](./vendor/LICENSE)

**Live App:** [https://malhar-jani.github.io/webp-forge/](https://malhar-jani.github.io/webp-forge/)

Drop photos, folders, or camera RAW files in and get small, web-ready `.webp` files back. Everything runs locally across your CPU cores via WebAssembly (`libwebp` SIMD + `LibRaw`) — **no image is ever uploaded to a server**.

---

## Highlights

- **True Multi-Core WASM Encoding** — Spawns a dedicated Web Worker pool across your CPU cores powered by SIMD-accelerated `libwebp`.
- **Standard, Vector & Camera RAW Input** — Converts `JPG`, `PNG`, `GIF`, `BMP`, `SVG`, `WebP`, `AVIF`, `TIFF`, `ICO`, and camera RAW formats (`CR2`, `CR3`, `NEF`, `ARW`, `DNG`, `RAF`).
- **Three Purpose-Built Encoding Presets**:
  - **Photo (Smallest):** Balanced YUV420 lossy compression tuned for photographs.
  - **UI & Graphics (Sharp edges):** Enables Sharp YUV (`use_sharp_yuv`) to eliminate chroma subsampling blur on colored text, screenshots, and illustrations.
  - **Lossless (Pixel-perfect):** Exact lossless WebP encoding for logos, icons, and transparent UI assets.
- **Interactive Before / After Split Inspector** — Click any converted row to open a draggable side-by-side comparison slider between the original and WebP output, inspect dimensions and byte savings, and navigate your batch with `←` / `→` arrow keys.
- **Responsive `srcset` & `<picture>` Generator** — Optionally output multiple responsive breakpoint widths (`400px`, `640px`, `960px`, `1280px`, `1600px`, or custom widths) without upscaling, and copy ready-to-paste `<img>` or `<picture>` HTML with `width`, `height`, `srcset`, `sizes`, and `loading="lazy"`.
- **Hard Byte-Size Target** — Need every image under a strict limit (e.g. `150 KB`)? Set a target KB cap and `libwebp` runs multi-pass convergence to hit it.
- **Smart Size Guard** — Prevents accidental bloat by keeping the original file (with its original extension) if re-encoding an already-optimized image would increase its byte size, or toggle it off when strict `.webp` output is required.
- **Direct Folder Writing or ZIP Download** — Stream converted files straight into a local folder via the File System Access API (preserving nested subfolder hierarchies), download individual images per row, or grab the batch as a `.zip`.

---

## Quick Start

### 1. Use Online (Zero Install)
Open **[https://malhar-jani.github.io/webp-forge/](https://malhar-jani.github.io/webp-forge/)** in any modern browser.

### 2. Run Locally
Clone the repository and launch the built-in zero-dependency static server:

```bash
git clone https://github.com/Malhar-Jani/webp-forge.git
cd webp-forge
npm start
```

*(On Windows, you can also double-click **`start.cmd`**.)*

The app opens automatically at `http://localhost:4321/`. A local HTTP server is used because browsers restrict WebAssembly and ES module Web Workers on `file://` URLs.

---

## Smart File Naming & SEO Slugs

**Leave the keyword box empty** to automatically sanitize and slugify existing filenames:

```text
Beach Trip 2024.png        →  beach-trip-2024.webp
IMG_9931 (copy).JPG        →  img-9931-copy.webp
Café Ñandú — Photo #1.png  →  cafe-nandu-photo-1.webp
```

**Enter a keyword** to sequentially number the batch in queue order:

```text
keyword: running shoes     →  running-shoes-1.webp
                              running-shoes-2.webp
                              running-shoes-3.webp
```

**Enable responsive breakpoint widths** and each generated size is suffixed automatically:

```text
running-shoes-1-640.webp
running-shoes-1-1280.webp
running-shoes-1-1600.webp
```

Dropped folders retain their relative directory structure, and duplicate names automatically resolve with `-2`, `-3`, etc.

---

## Architecture

```text
webp-forge/
├── index.html            # UI layout, responsive styling, and comparison modal
├── app.js                # Queue management, worker pool, File System Access API, HTML snippets
├── encoder.worker.js     # Off-thread decoding, high-quality resampling, and WASM encoding
├── jszip.min.js          # Client-side ZIP archiving (STORE mode)
├── server.mjs            # Zero-dependency Node.js static server for local use
├── start.cmd             # One-click Windows launcher
├── scripts/
│   └── vendor.mjs        # Copies updated WASM codecs from node_modules into vendor/
└── vendor/
    ├── webp/             # SIMD-enabled libwebp WASM encoder (@jsquash/webp)
    └── rawconvert/       # LibRaw WASM decoder for camera RAW formats (rawconvert-wasm)
```

All WASM binaries are pre-vendored in `vendor/`, so the repository requires **no bundler or build step** to deploy to static hosts like GitHub Pages, Cloudflare Pages, or Vercel.
