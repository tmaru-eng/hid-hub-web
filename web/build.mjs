// Only these browser assets are published. Tests and firmware stay out of dist.
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
const output = new URL('../dist/', import.meta.url);
const assets = ['index.html', 'app.js', 'protocol.js', 'styles.css'];
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const asset of assets) {
  await copyFile(new URL(asset, import.meta.url), new URL(asset, output));
}
console.log('Static site:', (await readdir(output)).join(', '));
