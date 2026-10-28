/** Link host capabilities for development; never changes the host checkout. */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.DSH_SOURCE) throw new Error('Set DSH_SOURCE to a prepared deepseek-harness checkout.');
const host = resolve(process.env.DSH_SOURCE);
const root = fileURLToPath(new URL('..', import.meta.url));
if (!existsSync(join(host, 'node_modules')) || !existsSync(join(root, 'node_modules/typescript'))) {
  throw new Error('Install host dependencies and run npm ci in this repository first.');
}
const folders = [];
for (const group of readdirSync(join(host, 'packages'), { withFileTypes: true })) {
  if (!group.isDirectory()) continue;
  for (const pkg of readdirSync(join(host, 'packages', group.name), { withFileTypes: true })) {
    if (pkg.isDirectory()) folders.push(join(host, 'packages', group.name, pkg.name));
  }
}
for (const pkg of readdirSync(join(host, 'vendor'), { withFileTypes: true })) {
  if (pkg.isDirectory()) folders.push(join(host, 'vendor', pkg.name));
}
let linked = 0;
for (const folder of folders) {
  if (!existsSync(join(folder, 'package.json'))) continue;
  const { name } = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'));
  if (typeof name !== 'string' || !name.startsWith('@deepseek-ai/')) continue;
  const target = join(root, 'node_modules', name);
  mkdirSync(dirname(target), { recursive: true });
  rmSync(target, { recursive: true, force: true });
  symlinkSync(folder, target, process.platform === 'win32' ? 'junction' : 'dir');
  linked++;
}
console.log(`Linked ${linked} host development packages inside this repository's node_modules.`);
