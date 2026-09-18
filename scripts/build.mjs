import { mkdir, copyFile, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist');
if (path.dirname(output) !== path.resolve(root) || path.basename(output) !== 'dist') {
  throw new Error('Unexpected build output directory.');
}
await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, 'assets'), { recursive: true });
await copyFile(path.join(root, 'index.html'), path.join(output, 'index.html'));
for (const entry of await readdir(path.join(root, 'assets'), { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.webp')) {
    await copyFile(path.join(root, 'assets', entry.name), path.join(output, 'assets', entry.name));
  }
}
console.log('Built gallery files and photos only.');
