/* Encoding worker: decode off-thread, resample, encode with libwebp (WASM).
   One of these runs per CPU core, so encoding is genuinely parallel. */

let webp = null;

async function encoder() {
  if (!webp) {
    const factory = (await import('./vendor/webp/webp_enc_simd.js')).default;
    webp = await factory({ noInitialRun: true });
  }
  return webp;
}

function config(o, targetBytes) {
  return {
    quality: o.lossless ? 100 : o.quality,
    target_size: targetBytes || 0,
    target_PSNR: 0,
    // libwebp needs several passes to converge on a byte target.
    pass: targetBytes ? 8 : 1,
    method: o.effort ?? 4,
    sns_strength: 50,
    filter_strength: 60,
    filter_sharpness: 0,
    filter_type: 1,
    partitions: 0,
    segments: 4,
    show_compressed: 0,
    preprocessing: 0,
    autofilter: 0,
    partition_limit: 0,
    alpha_compression: 1,
    alpha_filtering: 1,
    alpha_quality: o.alphaQuality ?? 100,
    lossless: o.lossless ? 1 : 0,
    // exact=0 lets libwebp rewrite RGB under fully-transparent pixels; smaller files.
    exact: 0,
    image_hint: o.imageHint ?? 0,
    emulate_jpeg_size: 0,
    thread_level: 0,
    low_memory: 0,
    near_lossless: o.nearLossless ?? 100,
    use_delta_palette: 0,
    use_sharp_yuv: o.sharpYuv ? 1 : 0,
  };
}

async function encode(imageData, plan) {
  const mod = await encoder();
  const target = !plan.lossless && plan.targetKB > 0 ? Math.round(plan.targetKB * 1024) : 0;
  const result = mod.encode(imageData.data, imageData.width, imageData.height, config(plan, target));
  if (!result) throw new Error('encoder returned nothing');
  // Emscripten hands back a fresh array, but guard against a heap view anyway.
  return result.byteLength === result.buffer.byteLength ? result.buffer : result.slice().buffer;
}

let canvas = null;
let ctx = null;

function pixelsFrom(bitmap) {
  if (!canvas) {
    canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    ctx = canvas.getContext('2d', { alpha: true, willReadFrequently: true });
  }
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  ctx.clearRect(0, 0, bitmap.width, bitmap.height);
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

/* Widths to actually produce: never upscale, always dedupe, always sorted. */
function planWidths(sourceW, sourceH, requested, maxDim, resizeMode = 'width') {
  let effectiveMaxW = sourceW;
  if (maxDim > 0) {
    if (resizeMode === 'height') {
      effectiveMaxW = Math.round(sourceW * (maxDim / sourceH));
    } else if (resizeMode === 'long') {
      effectiveMaxW = sourceW >= sourceH
        ? maxDim
        : Math.round(sourceW * (maxDim / sourceH));
    } else {
      effectiveMaxW = maxDim;
    }
  }
  const cap = Math.max(1, Math.min(effectiveMaxW, sourceW));
  const set = new Set();
  for (const w of requested) if (w > 0 && w < cap) set.add(w);
  set.add(cap);
  return [...set].sort((a, b) => a - b);
}

let rawconvert = null;

async function getRawConvert() {
  if (!rawconvert) {
    const [{ RawConvert }, coreMod] = await Promise.all([
      import('./vendor/rawconvert/index.js'),
      import('./vendor/rawconvert/rawconvert-core.js'),
    ]);
    globalThis.createRawConvertCore = coreMod.default ?? coreMod;
    rawconvert = await RawConvert.init({
      coreUrl: new URL('./vendor/rawconvert/rawconvert-core.js', import.meta.url).href,
      wasmUrl: new URL('./vendor/rawconvert/rawconvert-core.wasm', import.meta.url).href,
    });
  }
  return rawconvert;
}

async function run({ file, plan, isSvg }) {
  let source;
  let sourceW, sourceH;

  const isRaw = /\.(cr2|cr3|nef|arw|dng|raf)$/i.test(file.name);
  if (isRaw) {
    const rc = await getRawConvert();
    const buffer = await file.arrayBuffer();
    try {
      rc.load(buffer, file.name);
      const processed = rc.process({ halfSize: false, colorSpace: 'srgb', outputBps: 8 });
      const rgba = new Uint8ClampedArray(processed.width * processed.height * 4);
      const src = processed.data;
      if (processed.colors === 4) {
        rgba.set(src);
      } else {
        let j = 0;
        for (let i = 0; i < src.length; i += 3) {
          rgba[j++] = src[i];
          rgba[j++] = src[i + 1];
          rgba[j++] = src[i + 2];
          rgba[j++] = 255;
        }
      }
      const imageData = new ImageData(rgba, processed.width, processed.height);
      source = await createImageBitmap(imageData);
      sourceW = source.width;
      sourceH = source.height;
    } finally {
      try { rc.reset(); } catch {}
    }
  } else {
    source = await createImageBitmap(file, { imageOrientation: 'from-image' });
    sourceW = source.width;
    sourceH = source.height;
  }

  if (!sourceW || !sourceH) throw new Error('zero dimensions');

  const outputs = [];
  const targetWidths = planWidths(sourceW, sourceH, plan.widths, plan.maxWidth, plan.resizeMode);

  for (const width of targetWidths) {
    const height = Math.max(1, Math.round(sourceH * (width / sourceW)));
    let bitmap = source;
    let temporary = false;
    if (width !== sourceW) {
      bitmap = await createImageBitmap(source, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
      temporary = true;
    }

    let imageData;
    try {
      imageData = pixelsFrom(bitmap);
    } finally {
      if (temporary) bitmap.close();
    }

    const buffer = await encode(imageData, plan);

    // Re-encoding an already-optimised source can grow it. If skipIfLarger is
    // enabled (and it's not a camera RAW or vector SVG), keep the original file.
    const grew = plan.skipIfLarger && !isRaw && !isSvg && width === sourceW && buffer.byteLength >= file.size;
    outputs.push({
      width,
      height,
      buffer: grew ? null : buffer,
      size: grew ? file.size : buffer.byteLength,
      keptOriginal: grew,
    });
  }

  source.close();
  // The canvas keeps a backing store as big as the last image it handled. With
  // a worker per core that adds up fast, so hand the memory back between jobs.
  if (canvas) { canvas.width = 1; canvas.height = 1; }
  return { sourceW, sourceH, outputs };
}

self.onmessage = async e => {
  const job = e.data;
  try {
    const result = await run(job);
    self.postMessage({ id: job.id, ok: true, ...result }, result.outputs.map(o => o.buffer).filter(Boolean));
  } catch (err) {
    self.postMessage({ id: job.id, ok: false, error: (err && err.message) || String(err) });
  }
};
