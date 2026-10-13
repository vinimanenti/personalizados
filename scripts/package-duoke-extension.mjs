import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = ['manifest.json', 'popup.html', 'popup.css', 'popup.js', 'worker.js', 'studio-bridge.js', 'collector.js', 'duoke-content.js', 'README.md'];
const zip = new JSZip();
for (const file of files) zip.file(file, await readFile(path.join(root, 'extension', 'duoke-bridge', file)), { date: new Date('2026-01-01T00:00:00Z') });
const folder = path.join(root, 'public', 'downloads');
await mkdir(folder, { recursive: true });
const output = path.join(folder, 'duoke-bridge.zip');
await writeFile(output, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
console.log(`Duoke extension packaged: ${files.length} allowlisted files → public/downloads/duoke-bridge.zip`);
