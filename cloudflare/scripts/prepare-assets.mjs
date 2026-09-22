import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const expected = {
  'postgres.wasm': '6c6868d702be0ef05f3985b3dc5248fe314cdc656bffae7d4cca861b9785cb00',
  'vfs.img': '8e05ecc9b33bd425623eee4e45bb9994cacab7b9e49ddbbf693715efcaceaa08',
  'vfs.json': '87ba0d51a8edf40be6927d8168953850a91eb290067d73907a1cc11dabf170dc',
};
await mkdir(`${root}generated`, { recursive: true });
await mkdir(`${root}public/seed`, { recursive: true });
const files = {};
for (const [name, digest] of Object.entries(expected)) {
  let bytes;
  if (process.env.PGRUST_ASSET_DIR) bytes = await readFile(`${process.env.PGRUST_ASSET_DIR}/${name}`);
  else {
    const response = await fetch(`https://pgrust.com/assets/${name}`);
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== digest) throw new Error(`${name} checksum mismatch: upstream assets changed. Review before updating the pinned hashes.`);
  files[name] = bytes;
  await writeFile(`${root}generated/${name}`, bytes);
  console.log(`${name}: ${bytes.length} bytes, SHA-256 verified`);
}
const manifest = JSON.parse(files['vfs.json']);
manifest.chunks = [];
for (let offset = 0, index = 0; offset < files['vfs.img'].length; offset += 1048576, index++) {
  const name = `${String(index).padStart(3, '0')}.bin`;
  await writeFile(`${root}public/seed/${name}`, files['vfs.img'].subarray(offset, offset + 1048576));
  manifest.chunks.push(name);
}
await writeFile(`${root}public/seed/manifest.json`, JSON.stringify(manifest));
