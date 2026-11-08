/**
 * `rawconvert-core.js` is a classic (non-ESM) Emscripten script: loading it defines
 * a `createRawConvertCore` global. It is deliberately not an ES module so the same
 * file can be `importScripts()`-ed by the classic worker in `worker.ts`.
 */
function coreFactoryFromGlobal() {
    const g = globalThis;
    return typeof g.createRawConvertCore === 'function' ? g.createRawConvertCore : undefined;
}
function loadClassicScript(url) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = url;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Failed to load RawConvert core script: ${url}`));
        (document.head || document.documentElement).appendChild(script);
    });
}
async function loadCoreFactory(coreUrl) {
    // Already loaded — e.g. the consumer added their own <script> tag, or a
    // previous init() in this realm brought it in.
    const preloaded = coreFactoryFromGlobal();
    if (preloaded)
        return preloaded;
    const url = coreUrl ?? new URL('./rawconvert-core.js', import.meta.url).href;
    const g = globalThis;
    if (typeof g.importScripts === 'function') {
        try {
            g.importScripts(url); // classic worker realm
        }
        catch {
            const mod = await import(/* @vite-ignore */ url);
            const factory = (mod.default ?? mod);
            if (typeof factory === 'function')
                return factory;
        }
    }
    else if (typeof g.document !== 'undefined') {
        await loadClassicScript(url); // browser main thread
    }
    else {
        // Non-browser ESM host (Node). `dist/package.json` marks dist/ as
        // CommonJS, so the glue script's `module.exports` lands on `default`.
        const mod = await import(/* @vite-ignore */ url);
        const factory = (mod.default ?? mod);
        if (typeof factory !== 'function') {
            throw new Error(`Loaded ${url} but it did not export createRawConvertCore`);
        }
        return factory;
    }
    const factory = coreFactoryFromGlobal();
    if (!factory) {
        throw new Error(`Loaded ${url} but it did not define the createRawConvertCore global`);
    }
    return factory;
}
export const COLOR_SPACE_MAP = {
    raw: 0, srgb: 1, adobe: 2, 'wide-gamut': 3, prophoto: 4, xyz: 5,
};
export const INTERPOLATION_MAP = {
    linear: 0, vng: 1, ppg: 2, ahd: 3, dcb: 4, dht: 11, aahd: 12,
};
export function toInternalOptions(opts) {
    return {
        colorSpace: COLOR_SPACE_MAP[opts?.colorSpace ?? 'srgb'] ?? 1,
        interpolation: INTERPOLATION_MAP[opts?.interpolation ?? 'ahd'] ?? 3,
        outputBps: opts?.outputBps ?? 8,
        halfSize: opts?.halfSize ?? false,
        autoWhiteBalance: opts?.autoWhiteBalance ?? false,
        cameraWhiteBalance: opts?.cameraWhiteBalance ?? true,
        brightness: opts?.brightness ?? 1.0,
        highlightMode: opts?.highlightMode ?? 0,
        noiseReduction: opts?.noiseReduction ?? 0,
        medianPasses: opts?.medianPasses ?? 0,
    };
}
export class RawConvert {
    constructor(module) {
        this.module = module;
        this.processor = new module.RawProcessor();
    }
    static async init(options) {
        const factory = await loadCoreFactory(options?.coreUrl);
        const moduleArgs = {};
        const wasmUrl = options?.wasmUrl;
        if (wasmUrl) {
            moduleArgs.locateFile = (path) => (path.endsWith('.wasm') ? wasmUrl : path);
        }
        const module = await factory(moduleArgs);
        return new RawConvert(module);
    }
    load(data, filename) {
        const uint8 = new Uint8Array(data);
        const ext = filename?.split('.').pop()?.toLowerCase() || 'raw';
        const path = `/tmp/input.${ext}`;
        try {
            this.module.FS.writeFile(path, uint8);
            const ok = this.processor.loadFromFile(path);
            if (!ok)
                throw new Error(this.processor.getLastError() || 'Failed to load RAW file');
            return this.processor.getMetadata();
        }
        finally {
            try {
                this.module.FS.unlink(path);
            }
            catch { /* ignore */ }
        }
    }
    getMetadata() {
        if (!this.processor.isLoaded())
            throw new Error('No file loaded');
        return this.processor.getMetadata();
    }
    getThumbnail() {
        if (!this.processor.isLoaded())
            throw new Error('No file loaded');
        const thumbPath = '/tmp/thumbnail.jpg';
        const ok = this.processor.extractThumbnail(thumbPath);
        if (!ok)
            throw new Error(this.processor.getLastError() || 'Failed to extract thumbnail');
        try {
            const thumbData = this.module.FS.readFile(thumbPath);
            const thumbInfo = this.processor.getThumbnailInfo();
            return {
                width: thumbInfo.width,
                height: thumbInfo.height,
                format: thumbInfo.format === 0 ? 'jpeg' : 'bitmap',
                data: new Uint8Array(thumbData),
            };
        }
        finally {
            try {
                this.module.FS.unlink(thumbPath);
            }
            catch { /* ignore */ }
        }
    }
    process(options) {
        if (!this.processor.isLoaded())
            throw new Error('No file loaded');
        const internalOpts = toInternalOptions(options);
        const ok = this.processor.process(internalOpts);
        if (!ok)
            throw new Error(this.processor.getLastError() || 'Failed to process RAW file');
        const pixelsPath = '/tmp/pixels.bin';
        const exported = this.processor.exportRawPixels(pixelsPath);
        if (!exported)
            throw new Error(this.processor.getLastError() || 'Failed to export pixels');
        try {
            const rawData = this.module.FS.readFile(pixelsPath);
            const view = new DataView(rawData.buffer, rawData.byteOffset, rawData.byteLength);
            const width = view.getUint32(0, true);
            const height = view.getUint32(4, true);
            const bps = view.getUint16(8, true);
            const colors = view.getUint8(10);
            const pixelData = rawData.slice(11);
            let data;
            if (bps === 16) {
                data = new Uint16Array(pixelData.buffer, pixelData.byteOffset, pixelData.byteLength / 2);
            }
            else {
                data = new Uint8Array(pixelData);
            }
            return { width, height, colors, bitsPerSample: bps, data };
        }
        finally {
            try {
                this.module.FS.unlink(pixelsPath);
            }
            catch { /* ignore */ }
        }
    }
    convert(data, options) {
        this.load(data);
        return this.process(options);
    }
    reset() {
        this.processor.reset();
    }
    dispose() {
        this.processor.delete();
    }
}
