// Re-copy the libwebp encoder out of node_modules into vendor/.
// Only needed if you want a newer libwebp:  npm install && npm run vendor
// The app reads vendor/ only, so node_modules can be deleted afterwards.
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [
  ['node_modules/@jsquash/webp/codec/enc/webp_enc_simd.js', 'vendor/webp/webp_enc_simd.js'],
  ['node_modules/@jsquash/webp/codec/enc/webp_enc_simd.wasm', 'vendor/webp/webp_enc_simd.wasm'],
  ['node_modules/rawconvert-wasm/dist/rawconvert-core.js', 'vendor/rawconvert/rawconvert-core.js'],
  ['node_modules/rawconvert-wasm/dist/rawconvert-core.wasm', 'vendor/rawconvert/rawconvert-core.wasm'],
  ['node_modules/rawconvert-wasm/dist/index.js', 'vendor/rawconvert/index.js'],
];

for (const [from, to] of FILES) {
  const dest = join(ROOT, to);
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(join(ROOT, from), dest);
  if (to === 'vendor/rawconvert/rawconvert-core.js') {
    const fs = await import('node:fs/promises');
    await fs.appendFile(dest, '\nexport default createRawConvertCore;\n');
  }
  if (to === 'vendor/rawconvert/index.js') {
    const fs = await import('node:fs/promises');
    let src = await fs.readFile(dest, 'utf8');
    src = src.replace(
      "if (typeof g.importScripts === 'function') {\n        g.importScripts(url); // classic worker realm\n    }",
      "if (typeof g.importScripts === 'function') {\n        try { g.importScripts(url); } catch { const mod = await import(url); if (typeof (mod.default ?? mod) === 'function') return (mod.default ?? mod); }\n    }"
    );
    await fs.writeFile(dest, src, 'utf8');
  }
  console.log('  ' + to);
}
console.log('\nVendored ' + FILES.length + ' files.');
