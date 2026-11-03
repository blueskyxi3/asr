import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('browser-dist', { recursive: true });
await build({ entryPoints: ['browser/index.mjs'], outfile: 'browser-dist/plugin.js', bundle: true, format: 'esm', target: 'es2022', minify: true });
await build({ entryPoints: ['browser/voice-worker.mjs'], outfile: 'browser-dist/voice-worker.js', bundle: true, format: 'iife', target: 'es2022', minify: true });
await copyFile('browser/voice-capture.js', 'browser-dist/voice-capture.js');
