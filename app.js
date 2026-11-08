/* WebP Forge — drop images, get WebP.
   Runs 100% in the browser with multi-core WASM encoding (libwebp + LibRaw). */

const $ = id => document.getElementById(id);
const el = {
  drop: $('drop'), files: $('files'), folder: $('folder'), folderBtn: $('folderBtn'),
  mode: $('mode'), quality: $('quality'), qualityField: $('qualityField'), qval: $('qval'),
  resizeMode: $('resizeMode'), maxw: $('maxw'),
  targetKB: $('targetKB'), chips: $('chips'), keyword: $('keyword'),
  urlPrefix: $('urlPrefix'), skipLarger: $('skipLarger'),
  convert: $('convert'), stop: $('stop'), clear: $('clear'),
  pickDest: $('pickDest'), resetDest: $('resetDest'), dest: $('dest'),
  barWrap: $('barWrap'), bar: $('bar'), summary: $('summary'), list: $('list'),
  after: $('after'), download: $('download'), copyHtml: $('copyHtml'), copyPicture: $('copyPicture'),
  toast: $('toast'), engine: $('engine'),
  modalBackdrop: $('modalBackdrop'), modalTitle: $('modalTitle'), modalMeta: $('modalMeta'),
  modalClose: $('modalClose'), modalStage: $('modalStage'), compareWrap: $('compareWrap'),
  imgAfter: $('imgAfter'), imgBefore: $('imgBefore'), compareBefore: $('compareBefore'),
  compareHandle: $('compareHandle'), badgeBefore: $('badgeBefore'), badgeAfter: $('badgeAfter'),
  modalDownload: $('modalDownload'),
};

const CORES = navigator.hardwareConcurrency || 4;
const WORKERS = Math.min(CORES, 12);
const DEFAULT_WIDTHS = [400, 640, 960, 1280, 1600];
const FS_ACCESS = typeof window.showDirectoryPicker === 'function';
const SIZES_ATTR = '(max-width: 768px) 100vw, 768px';

const PRESETS = {
  photo:    { effort: 4, lossless: false, sharpYuv: false, nearLossless: 100, alphaQuality: 100, imageHint: 2 },
  sharp:    { effort: 4, lossless: false, sharpYuv: true,  nearLossless: 100, alphaQuality: 100, imageHint: 3 },
  lossless: { effort: 4, lossless: true,  sharpYuv: false, nearLossless: 100, alphaQuality: 100, imageHint: 3 },
};

let queue = [];
let destHandle = null;
let running = false;
let cancelled = false;
let widths = new Set();
let customWidths = [];
let modalItem = null;

/* ── small helpers ───────────────────────────────────────────────────── */

function toast(msg, ms = 3000) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.toast.classList.remove('show'), ms);
}
function size(b) {
  if (!Number.isFinite(b) || b <= 0) return '0 KB';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return Math.max(1, Math.round(b / 1024)) + ' KB';
  return (b / (1024 * 1024)).toFixed(1) + ' MB';
}
function slug(s) {
  return (s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/['’`"]/g, '').replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-').replace(/^-|-$/g, '')) || 'image';
}
const stripExt = n => n.replace(/\.[^./\\]+$/, '');
const extOf = n => {
  const m = /\.([^./\\]+)$/.exec(n);
  return m ? '.' + m[1].toLowerCase() : '.webp';
};
const dirOf = p => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const RAW_RE = /\.(cr2|cr3|nef|arw|dng|raf)$/i;
const SVG_RE = /\.svg$/i;
const IMAGE_RE = /\.(png|jpe?g|gif|bmp|svg|webp|avif|tiff?|ico|cr2|cr3|nef|arw|dng|raf)$/i;

/* ── settings persistence ────────────────────────────────────────────── */

const KEY = 'image-forge:v4';
const FIELDS = ['mode', 'quality', 'resizeMode', 'maxw', 'targetKB', 'keyword', 'urlPrefix'];

function save() {
  const data = {
    widths: [...widths],
    customWidths: [...customWidths],
    skipLarger: el.skipLarger.checked,
  };
  for (const k of FIELDS) data[k] = el[k].value;
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch {}
}
function load() {
  let d;
  try { d = JSON.parse(localStorage.getItem(KEY) || localStorage.getItem('image-forge:v3') || 'null'); } catch {}
  if (!d) return;
  for (const k of FIELDS) if (d[k] !== undefined && el[k]) el[k].value = d[k];
  if (Array.isArray(d.widths)) widths = new Set(d.widths);
  if (Array.isArray(d.customWidths)) customWidths = d.customWidths.filter(n => Number.isFinite(n) && n > 0);
  if (typeof d.skipLarger === 'boolean') el.skipLarger.checked = d.skipLarger;
}

function syncModeUI() {
  const isLossless = el.mode.value === 'lossless';
  el.qualityField.classList.toggle('dim', isLossless);
  el.qval.textContent = isLossless ? 'Lossless' : el.quality.value;
}

/* ── SVG rasterizer (main thread) ────────────────────────────────────── */

function rasterizeSvg(file, targetMaxDim) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        let w = img.naturalWidth || 1024;
        let h = img.naturalHeight || 1024;
        if (targetMaxDim > 0 && w < targetMaxDim && h < targetMaxDim) {
          const scale = targetMaxDim / Math.max(w, h);
          w = Math.round(w * scale);
          h = Math.round(h * scale);
        }
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const cx = c.getContext('2d');
        cx.drawImage(img, 0, 0, w, h);
        c.toBlob(blob => {
          URL.revokeObjectURL(url);
          if (!blob) return reject(new Error('Failed to rasterize SVG'));
          resolve(new File([blob], file.name, { type: 'image/png' }));
        }, 'image/png');
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not load SVG'));
    };
    img.src = url;
  });
}

/* ── queue ───────────────────────────────────────────────────────────── */

function cleanupItem(item) {
  if (item.thumbUrl) { URL.revokeObjectURL(item.thumbUrl); item.thumbUrl = null; }
  if (item.afterUrl) { URL.revokeObjectURL(item.afterUrl); item.afterUrl = null; }
}

function add(entries) {
  const seen = new Set(queue.map(q => q.path + '|' + q.file.size));
  const fresh = [];
  let skipped = 0;
  for (const { file, path } of entries) {
    if (!(file.type.startsWith('image/') || IMAGE_RE.test(file.name))) { skipped++; continue; }
    if (seen.has(path + '|' + file.size)) { skipped++; continue; }
    seen.add(path + '|' + file.size);
    const isRaw = RAW_RE.test(file.name);
    const thumbUrl = !isRaw ? URL.createObjectURL(file) : null;
    const item = {
      id: crypto.randomUUID(), file, path, isRaw,
      thumbUrl, afterUrl: null,
      sourceW: 0, sourceH: 0,
      status: 'wait', error: null,
      outputs: [], outSize: 0, saved: [], stamp: null, row: null,
    };
    queue.push(item);
    fresh.push(item);
  }
  if (!fresh.length) { toast(skipped ? 'Already added those' : 'No supported images found'); return; }
  if (skipped) toast(`Added ${fresh.length}, skipped ${skipped}`);

  const frag = document.createDocumentFragment();
  for (const item of fresh) frag.appendChild(buildRow(item));
  el.list.appendChild(frag);
  syncButtons();
}

function walk(entry, prefix, out) {
  return new Promise(done => {
    if (entry.isFile) return entry.file(f => { out.push({ file: f, path: prefix + f.name }); done(); }, done);
    if (!entry.isDirectory) return done();
    const reader = entry.createReader();
    const found = [];
    const next = () => reader.readEntries(async batch => {
      if (!batch.length) {
        await Promise.all(found.map(e => walk(e, prefix + entry.name + '/', out)));
        return done();
      }
      found.push(...batch);
      next();
    }, done);
    next();
  });
}
async function fromDrop(dt) {
  const roots = [...dt.items].map(i => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
  if (!roots.length) return [...dt.files].map(f => ({ file: f, path: f.name }));
  const out = [];
  await Promise.all(roots.map(r => walk(r, '', out)));
  return out;
}

function syncButtons() {
  el.convert.disabled = el.clear.disabled = running || !queue.length;
  el.convert.textContent = queue.length ? `Convert (${queue.length})` : 'Convert';
  el.stop.style.display = running ? '' : 'none';
  el.after.style.display = !running && queue.some(q => q.outputs.length) ? '' : 'none';
}

function render() {
  el.list.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const item of queue) frag.appendChild(buildRow(item));
  el.list.appendChild(frag);
  syncButtons();
}

function buildRow(item) {
  const row = document.createElement('div');
  row.className = 'row';

  const thumb = document.createElement('div');
  thumb.className = 'thumb';

  const nm = document.createElement('div');
  nm.className = 'nm';
  const title = document.createElement('span');
  title.textContent = item.file.name;
  const sub = document.createElement('small');
  nm.append(title, sub);

  const sz = document.createElement('div');
  sz.className = 'sz';

  const tag = document.createElement('div');
  tag.className = 'tag wait';
  tag.textContent = 'Waiting';

  const btns = document.createElement('div');
  btns.className = 'row-btns';

  const cmpBtn = document.createElement('button');
  cmpBtn.className = 'icon-btn';
  cmpBtn.textContent = '↔';
  cmpBtn.title = 'Compare original vs WebP';
  cmpBtn.style.display = 'none';
  cmpBtn.onclick = e => { e.stopPropagation(); openModal(item); };

  const dlBtn = document.createElement('button');
  dlBtn.className = 'icon-btn';
  dlBtn.textContent = '↓';
  dlBtn.title = 'Download converted file';
  dlBtn.style.display = 'none';
  dlBtn.onclick = e => { e.stopPropagation(); downloadSingle(item); };

  const x = document.createElement('button');
  x.className = 'icon-btn del';
  x.textContent = '×';
  x.title = 'Remove';
  x.onclick = e => {
    e.stopPropagation();
    if (running) return;
    cleanupItem(item);
    queue = queue.filter(q => q !== item);
    render();
  };

  btns.append(cmpBtn, dlBtn, x);
  row.append(thumb, nm, sz, tag, btns);

  row.onclick = () => {
    if (item.outputs.length && (item.status === 'done' || item.status === 'same')) {
      openModal(item);
    }
  };

  item.row = { thumb, sub, sz, tag, cmpBtn, dlBtn, root: row };
  paint(item);
  return row;
}

function paint(item) {
  const r = item.row;
  if (!r) return;

  // Thumbnail
  const displayUrl = item.afterUrl || item.thumbUrl;
  if (displayUrl) {
    if (!r.thumb.querySelector('img') || r.thumb.querySelector('img').src !== displayUrl) {
      r.thumb.innerHTML = `<img src="${displayUrl}" alt="" loading="lazy" />`;
    }
  } else {
    r.thumb.textContent = extOf(item.file.name).slice(1).toUpperCase() || 'IMG';
  }

  r.sz.innerHTML = item.outSize
    ? `<s>${size(item.file.size)}</s> → ${size(item.outSize)}`
    : size(item.file.size);

  // Sub-label: dimensions + output name or multi-size summary
  const parts = [];
  if (item.sourceW && item.outputs.length) {
    const big = item.outputs[item.outputs.length - 1];
    if (big.width !== item.sourceW || big.height !== item.sourceH) {
      parts.push(`${item.sourceW}×${item.sourceH} → ${big.width}×${big.height}`);
    } else {
      parts.push(`${big.width}×${big.height}`);
    }
  }
  if (item.outputs.length > 1) {
    parts.push(`${item.outputs.length} sizes (${item.outputs.map(o => o.width + 'w').join(', ')})`);
  } else if (item.outputs.length === 1) {
    parts.push(item.outputs[0].rel);
  } else if (dirOf(item.path)) {
    parts.push(dirOf(item.path));
  }
  r.sub.textContent = parts.join(' · ');

  const hasResult = item.outputs.length > 0 && (item.status === 'done' || item.status === 'same');
  r.root.classList.toggle('clickable', hasResult);
  r.cmpBtn.style.display = hasResult ? '' : 'none';
  r.dlBtn.style.display = hasResult && item.saved.length ? '' : 'none';

  if (item.status === 'wait') {
    r.tag.className = 'tag wait';
    r.tag.textContent = 'Waiting';
    r.root.title = '';
  } else if (item.status === 'busy') {
    r.tag.className = 'tag wait';
    r.tag.textContent = 'Converting…';
  } else if (item.status === 'error') {
    r.tag.className = 'tag err';
    r.tag.textContent = 'Failed';
    r.root.title = item.error || '';
  } else if (item.status === 'same') {
    r.tag.className = 'tag same';
    r.tag.textContent = 'Kept original';
    r.root.title = 'Converting would have made this larger, so the original file was kept';
  } else {
    const pct = Math.round((1 - item.outSize / item.file.size) * 100);
    if (pct >= 0) {
      r.tag.className = 'tag ok';
      r.tag.textContent = pct + '% smaller';
    } else {
      r.tag.className = 'tag same';
      r.tag.textContent = `WebP (+${Math.abs(pct)}%)`;
    }
    r.root.title = 'Click to compare original vs WebP';
  }
}

/* ── output naming ───────────────────────────────────────────────────── */

function name(item, index, width, multi, used, keptOriginal = false) {
  const kw = el.keyword.value.trim();
  const base = kw ? `${kw}-${index + 1}` : stripExt(item.file.name);
  const stem = slug(base) + (multi ? '-' + width : '');
  const dir = dirOf(item.path);
  const ext = keptOriginal ? extOf(item.file.name) : '.webp';
  let rel = `${dir}${stem}${ext}`;
  let n = 2;
  while (used.has(rel)) rel = `${dir}${stem}-${n++}${ext}`;
  used.add(rel);
  return rel;
}

/* ── worker pool ─────────────────────────────────────────────────────── */

function makePool(size) {
  const idle = [], waiting = [], inflight = new Map(), all = [];
  let nextId = 1;
  const dispatch = () => {
    while (idle.length && waiting.length) {
      const w = idle.pop(), task = waiting.shift(), id = nextId++;
      inflight.set(id, task);
      w._job = id;
      if (task.onStart) task.onStart();
      w.postMessage({ id, ...task.job });
    }
  };
  const free = (w, id, fn) => {
    const task = inflight.get(id);
    inflight.delete(id);
    w._job = null;
    if (!idle.includes(w)) idle.push(w);
    dispatch();
    if (task) fn(task);
  };
  for (let i = 0; i < size; i++) {
    const w = new Worker('./encoder.worker.js', { type: 'module' });
    w.onmessage = e => free(w, e.data.id, t =>
      e.data.ok ? t.resolve(e.data) : t.reject(new Error(e.data.error || 'failed')));
    w.onerror = ev => free(w, w._job, t => t.reject(new Error(ev.message || 'worker crashed')));
    all.push(w);
    idle.push(w);
  }
  return {
    run: (job, onStart) => new Promise((resolve, reject) => {
      waiting.push({ job, resolve, reject, onStart });
      dispatch();
    }),
    cancelWaiting: () => {
      while (waiting.length) {
        const t = waiting.pop();
        const err = new Error('Cancelled');
        err.cancelled = true;
        t.reject(err);
      }
    },
  };
}

let pool = null;
const getPool = () => (pool || (pool = makePool(WORKERS)));

/* ── destination ─────────────────────────────────────────────────────── */

const IDB = {
  open: () => new Promise((res, rej) => {
    const r = indexedDB.open('image-forge', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }),
  async set(k, v) {
    const db = await IDB.open();
    await new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      if (v === null) tx.objectStore('kv').delete(k);
      else tx.objectStore('kv').put(v, k);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
    db.close();
  },
  async get(k) {
    const db = await IDB.open();
    const v = await new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readonly');
      const q = tx.objectStore('kv').get(k);
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    });
    db.close();
    return v;
  },
};

function showDest() {
  el.dest.innerHTML = destHandle ? `Saving to <b>${esc(destHandle.name)}</b>` : 'Saving as a zip';
  el.pickDest.textContent = destHandle ? 'Change folder' : 'Save to folder';
  el.pickDest.style.display = FS_ACCESS ? '' : 'none';
  el.resetDest.style.display = FS_ACCESS && destHandle ? '' : 'none';
}

let writeChain = Promise.resolve();
function writeTo(dirHandle, rel, data) {
  const task = writeChain.then(async () => {
    const parts = rel.split('/').filter(Boolean);
    const file = parts.pop();
    let dir = dirHandle;
    for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true });
    const fh = await dir.getFileHandle(file, { create: true });
    const s = await fh.createWritable();
    await s.write(data);
    await s.close();
  });
  writeChain = task.catch(() => {});
  return task;
}

/* ── convert ─────────────────────────────────────────────────────────── */

function plan() {
  const preset = PRESETS[el.mode.value] || PRESETS.photo;
  return {
    ...preset,
    quality: Number(el.quality.value),
    targetKB: Math.max(0, Number(el.targetKB.value) || 0),
    widths: [...widths].sort((a, b) => a - b),
    maxWidth: Math.max(0, parseInt(el.maxw.value, 10) || 0),
    resizeMode: el.resizeMode.value || 'width',
    skipIfLarger: el.skipLarger.checked,
  };
}

el.stop.addEventListener('click', () => {
  if (!running) return;
  cancelled = true;
  if (pool) pool.cancelWaiting();
  toast('Stopping after active workers finish…');
});

el.convert.addEventListener('click', async () => {
  if (running || !queue.length) return;

  if (destHandle) {
    const opts = { mode: 'readwrite' };
    let ok = (await destHandle.queryPermission(opts)) === 'granted';
    if (!ok) ok = (await destHandle.requestPermission(opts)) === 'granted';
    if (!ok) { destHandle = null; showDest(); toast('No folder access — saving a zip instead'); }
  }

  const p = plan();
  const stamp = JSON.stringify(p) + '|' + el.keyword.value.trim() + '|' + Boolean(destHandle);

  const todo = queue.filter(it =>
    it.stamp !== stamp || (it.status !== 'done' && it.status !== 'same'));

  if (!todo.length) { toast('Everything here is already converted'); return; }

  running = true;
  cancelled = false;
  syncButtons();
  el.barWrap.style.display = '';
  el.bar.style.width = '0%';
  el.summary.style.display = 'none';

  const redo = new Set(todo);
  for (const item of todo) {
    if (item.afterUrl) { URL.revokeObjectURL(item.afterUrl); item.afterUrl = null; }
    item.status = 'wait'; item.error = null; item.outputs = []; item.outSize = 0; item.saved = [];
    paint(item);
  }

  const used = new Set();
  for (const it of queue) if (!redo.has(it)) it.outputs.forEach(o => used.add(o.rel));

  const t0 = performance.now();
  let done = 0, failed = 0, kept = 0, stopped = 0;

  await Promise.all(todo.map(item => (async () => {
    if (cancelled) { stopped++; return; }
    const index = queue.indexOf(item);
    try {
      const isSvg = SVG_RE.test(item.file.name) || item.file.type === 'image/svg+xml';
      const inputFile = isSvg ? await rasterizeSvg(item.file, p.maxWidth) : item.file;

      const res = await getPool().run({ file: inputFile, plan: p, isSvg }, () => {
        item.status = 'busy';
        paint(item);
      });

      if (cancelled) {
        item.status = 'wait';
        stopped++;
        paint(item);
        return;
      }

      item.sourceW = res.sourceW;
      item.sourceH = res.sourceH;
      const multi = res.outputs.length > 1;
      for (const o of res.outputs) {
        const rel = name(item, index, o.width, multi, used, o.keptOriginal);
        const data = o.keptOriginal ? item.file : new Blob([o.buffer], { type: 'image/webp' });
        if (destHandle) await writeTo(destHandle, rel, data);
        item.saved.push({ rel, data, width: o.width, height: o.height });
        item.outputs.push({ width: o.width, height: o.height, size: o.size, rel, keptOriginal: o.keptOriginal });
        item.outSize += o.size;
        if (o.keptOriginal) kept++;
      }
      const primary = item.saved[item.saved.length - 1];
      if (primary) item.afterUrl = URL.createObjectURL(primary.data);

      item.status = item.outputs.some(o => o.keptOriginal) ? 'same' : 'done';
      item.stamp = stamp;
    } catch (err) {
      if (err && err.cancelled) {
        item.status = 'wait';
        stopped++;
      } else {
        item.status = 'error';
        item.error = (err && err.message) || String(err);
        failed++;
      }
    }
    done++;
    el.bar.style.width = (done / todo.length) * 100 + '%';
    paint(item);
  })()));

  const completed = todo.filter(q => q.status === 'done' || q.status === 'same');
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  const inB = completed.reduce((s, q) => s + q.file.size, 0);
  const outB = completed.reduce((s, q) => s + q.outSize, 0);
  const written = completed.reduce((s, q) => s + q.outputs.length, 0);
  const skipped = queue.length - todo.length;
  const saved = inB > 0 ? Math.round((1 - outB / inB) * 100) : 0;

  let text = `Converted <b>${completed.length}</b> · ${size(inB)} → <b>${size(outB)}</b> · <b>${saved}% smaller</b> · ${secs}s`;
  if (written !== completed.length) text += ` · ${written} files`;
  if (skipped) text += ` · ${skipped} already done`;
  if (stopped) text += ` · <span class="w">${stopped} cancelled</span>`;
  if (kept) text += ` · <span class="w">${kept} kept original (smaller than WebP)</span>`;
  if (failed) text += ` · <span class="e">${failed} failed</span>`;
  el.summary.innerHTML = text;
  el.summary.style.display = '';

  if (destHandle && written) {
    toast(`Saved ${written} file${written === 1 ? '' : 's'} to ${destHandle.name}`);
  }

  running = false;
  cancelled = false;
  el.download.style.display = destHandle ? 'none' : '';
  syncButtons();
});

/* ── HTML & Downloads ────────────────────────────────────────────────── */

function snippetImg(item) {
  if (!item.outputs.length) return '';
  const prefix = el.urlPrefix.value;
  const outs = [...item.outputs].sort((a, b) => a.width - b.width);
  const big = outs[outs.length - 1];
  const pad = '\n     ';
  return `<img src="${prefix}${big.rel}"` +
    (outs.length > 1
      ? `${pad}srcset="${outs.map(o => `${prefix}${o.rel} ${o.width}w`).join(', ')}"${pad}sizes="${SIZES_ATTR}"`
      : '') +
    `${pad}width="${big.width}" height="${big.height}"` +
    `${pad}alt="" loading="lazy" decoding="async">`;
}

function snippetPicture(item) {
  if (!item.outputs.length) return '';
  const prefix = el.urlPrefix.value;
  const outs = [...item.outputs].sort((a, b) => a.width - b.width);
  const big = outs[outs.length - 1];
  const srcset = outs.map(o => `${prefix}${o.rel} ${o.width}w`).join(', ');
  return `<picture>\n` +
    `  <source type="image/webp" srcset="${srcset}"${outs.length > 1 ? ` sizes="${SIZES_ATTR}"` : ''}>\n` +
    `  <img src="${prefix}${big.rel}" width="${big.width}" height="${big.height}" alt="" loading="lazy" decoding="async">\n` +
    `</picture>`;
}

el.copyHtml.addEventListener('click', async () => {
  const all = queue.map(snippetImg).filter(Boolean).join('\n\n');
  if (!all) return toast('Nothing to copy');
  await navigator.clipboard.writeText(all);
  toast('<img> HTML copied — fill in the alt text');
});

el.copyPicture.addEventListener('click', async () => {
  const all = queue.map(snippetPicture).filter(Boolean).join('\n\n');
  if (!all) return toast('Nothing to copy');
  await navigator.clipboard.writeText(all);
  toast('<picture> HTML copied — fill in the alt text');
});

function grab(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 8000);
}

function downloadSingle(item) {
  if (!item.saved.length) return;
  const primary = item.saved[item.saved.length - 1];
  const baseName = primary.rel.split('/').pop();
  grab(primary.data, baseName);
}

el.download.addEventListener('click', async () => {
  const files = queue.flatMap(q => q.saved || []);
  if (!files.length) return toast('Nothing converted yet');
  if (files.length === 1) {
    grab(files[0].data, files[0].rel.split('/').pop());
    return;
  }
  const label = el.download.textContent;
  el.download.disabled = true;
  el.download.textContent = 'Zipping…';
  try {
    const zip = new JSZip();
    for (const f of files) zip.file(f.rel, f.data);
    grab(await zip.generateAsync({ type: 'blob', compression: 'STORE' }),
      `images-${new Date().toISOString().slice(0, 10)}.zip`);
  } catch (err) {
    toast('Zip failed: ' + err.message, 5000);
  } finally {
    el.download.disabled = false;
    el.download.textContent = label;
  }
});

/* ── Before / After Comparison Modal ─────────────────────────────────── */

function setSplit(pct) {
  const clamped = Math.max(0, Math.min(100, pct));
  el.compareBefore.style.clipPath = `inset(0 ${100 - clamped}% 0 0)`;
  el.compareHandle.style.left = clamped + '%';
}

function openModal(item) {
  if (!item || !item.outputs.length || !item.afterUrl) return;
  modalItem = item;
  const big = item.outputs[item.outputs.length - 1];
  const pct = Math.round((1 - item.outSize / item.file.size) * 100);
  const savingsText = item.status === 'same'
    ? 'Kept original file'
    : (pct >= 0 ? `${pct}% smaller` : `+${Math.abs(pct)}% larger`);

  el.modalTitle.textContent = `${item.file.name} → ${big.rel}`;
  el.modalMeta.textContent = `${big.width}×${big.height} · ${size(item.file.size)} → ${size(item.outSize)} (${savingsText})`;

  el.imgAfter.src = item.afterUrl;
  el.badgeAfter.textContent = `${big.keptOriginal ? 'Original' : 'WebP'} · ${size(big.size)}`;

  if (item.thumbUrl && !item.isRaw) {
    el.imgBefore.src = item.thumbUrl;
    el.compareBefore.style.display = '';
    el.compareHandle.style.display = '';
    el.badgeBefore.style.display = '';
    el.badgeBefore.textContent = `Original · ${size(item.file.size)}`;
    setSplit(50);
  } else {
    el.compareBefore.style.display = 'none';
    el.compareHandle.style.display = 'none';
    el.badgeBefore.style.display = 'none';
  }

  el.modalBackdrop.classList.add('open');
}

function closeModal() {
  el.modalBackdrop.classList.remove('open');
  modalItem = null;
}

el.modalClose.addEventListener('click', closeModal);
el.modalBackdrop.addEventListener('click', e => { if (e.target === el.modalBackdrop) closeModal(); });
el.modalDownload.addEventListener('click', () => { if (modalItem) downloadSingle(modalItem); });

let draggingSplit = false;
function updateSplitFromEvent(e) {
  if (!modalItem || modalItem.isRaw) return;
  const rect = el.compareWrap.getBoundingClientRect();
  if (!rect.width) return;
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  setSplit(((clientX - rect.left) / rect.width) * 100);
}
el.modalStage.addEventListener('mousedown', e => { draggingSplit = true; updateSplitFromEvent(e); });
window.addEventListener('mousemove', e => { if (draggingSplit) updateSplitFromEvent(e); });
window.addEventListener('mouseup', () => { draggingSplit = false; });
el.modalStage.addEventListener('touchstart', e => { draggingSplit = true; updateSplitFromEvent(e); }, { passive: true });
window.addEventListener('touchmove', e => { if (draggingSplit) updateSplitFromEvent(e); }, { passive: true });
window.addEventListener('touchend', () => { draggingSplit = false; });

window.addEventListener('keydown', e => {
  if (!el.modalBackdrop.classList.contains('open')) return;
  if (e.key === 'Escape') return closeModal();
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    const converted = queue.filter(q => q.outputs.length && q.afterUrl);
    if (converted.length < 2) return;
    const idx = converted.indexOf(modalItem);
    const nextIdx = (idx + (e.key === 'ArrowRight' ? 1 : -1) + converted.length) % converted.length;
    openModal(converted[nextIdx]);
  }
});

/* ── responsive width chips ──────────────────────────────────────────── */

function renderChips() {
  el.chips.innerHTML = '';
  const allWidths = [...new Set([...DEFAULT_WIDTHS, ...customWidths])].sort((a, b) => a - b);
  for (const w of allWidths) {
    const c = document.createElement('div');
    c.className = 'chip' + (widths.has(w) ? ' on' : '');
    c.textContent = w + 'px';
    c.onclick = () => {
      widths.has(w) ? widths.delete(w) : widths.add(w);
      c.classList.toggle('on');
      save();
    };
    el.chips.appendChild(c);
  }

  const addWrap = document.createElement('div');
  addWrap.className = 'chip-add';
  const inp = document.createElement('input');
  inp.type = 'number';
  inp.min = '16';
  inp.max = '8192';
  inp.placeholder = '+ px';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ghost';
  btn.textContent = 'Add';
  const addCustom = () => {
    const v = parseInt(inp.value, 10);
    if (!v || v < 16 || v > 8192) return toast('Enter a width between 16 and 8192 px');
    if (!DEFAULT_WIDTHS.includes(v) && !customWidths.includes(v)) customWidths.push(v);
    widths.add(v);
    inp.value = '';
    save();
    renderChips();
  };
  btn.onclick = addCustom;
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addCustom(); } });
  addWrap.append(inp, btn);
  el.chips.appendChild(addWrap);
}

/* ── wiring ──────────────────────────────────────────────────────────── */

['dragenter', 'dragover'].forEach(e =>
  el.drop.addEventListener(e, ev => { ev.preventDefault(); el.drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(e =>
  el.drop.addEventListener(e, ev => { ev.preventDefault(); el.drop.classList.remove('over'); }));
el.drop.addEventListener('drop', async e => add(await fromDrop(e.dataTransfer)));
el.drop.addEventListener('click', e => { if (e.target !== el.folderBtn) el.files.click(); });
el.folderBtn.addEventListener('click', e => { e.stopPropagation(); el.folder.click(); });
el.files.addEventListener('change', e => {
  add([...e.target.files].map(f => ({ file: f, path: f.name })));
  e.target.value = '';
});
el.folder.addEventListener('change', e => {
  add([...e.target.files].map(f => ({ file: f, path: f.webkitRelativePath || f.name })));
  e.target.value = '';
});
document.addEventListener('paste', e => {
  if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
  const f = [...(e.clipboardData?.files || [])];
  if (f.length) add(f.map((x, i) => ({ file: x, path: x.name || `pasted-${i + 1}.png` })));
});

el.clear.addEventListener('click', () => {
  if (running) return;
  queue.forEach(cleanupItem);
  queue = [];
  render();
  el.summary.style.display = 'none';
  el.barWrap.style.display = 'none';
});

el.pickDest.addEventListener('click', async () => {
  try {
    destHandle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'image-forge-out' });
    IDB.set('dest', destHandle).catch(() => {});
    showDest();
  } catch { /* cancelled */ }
});

el.resetDest.addEventListener('click', () => {
  destHandle = null;
  IDB.set('dest', null).catch(() => {});
  showDest();
  toast('Switched back to saving a zip');
});

el.mode.addEventListener('change', () => { syncModeUI(); save(); });
el.quality.addEventListener('input', () => { syncModeUI(); save(); });
el.skipLarger.addEventListener('change', save);
for (const k of FIELDS) el[k].addEventListener('change', save);

/* ── boot ────────────────────────────────────────────────────────────── */

(async function boot() {
  load();
  syncModeUI();
  renderChips();

  if (FS_ACCESS) {
    try {
      const saved = await IDB.get('dest');
      if (saved && (await saved.queryPermission({ mode: 'readwrite' })) === 'granted') destHandle = saved;
    } catch {}
  }
  showDest();
  render();

  // Warm the worker pool with a 1×1 probe encode.
  try {
    const png = await (await fetch('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')).blob();
    await getPool().run({
      file: new File([png], 'probe.png', { type: 'image/png' }),
      plan: { ...PRESETS.photo, quality: 80, targetKB: 0, widths: [], maxWidth: 0, resizeMode: 'width', skipIfLarger: false },
    });
  } catch {
    el.engine.textContent = 'Encoder failed to load — open this via a local server (start.cmd / npm start) or GitHub Pages, not file://.';
    toast('Encoder failed to load', 6000);
  }
})();
