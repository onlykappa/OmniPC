// Bundles the Electron main + preload processes with esbuild.
// Native / binary-shipping modules stay external and are packaged by electron-builder.
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const external = ['electron', 'better-sqlite3', '7zip-bin', 'yauzl', 'yazl', '@anthropic-ai/sdk'];

await rm(resolve(root, 'dist/main'), { recursive: true, force: true });

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  external,
  alias: { '@shared': resolve(root, 'src/shared') },
  logLevel: 'info',
};

await build({ ...common, entryPoints: [resolve(root, 'src/main/index.ts')], outfile: resolve(root, 'dist/main/index.js') });
await build({ ...common, entryPoints: [resolve(root, 'src/main/preload.ts')], outfile: resolve(root, 'dist/main/preload.js') });

// Emulator manifests and diagnostic rules are JSON imported by the bundle.

if (watch) console.log('watch mode is handled by scripts/dev.mjs');
