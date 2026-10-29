import { mkdir, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { resolve, join } from "node:path";

// Draw a small vector-style download mark and encode PNGs without external tools.
const table = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  table[n] = c;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([name, data])) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0); name.copy(result, 4); data.copy(result, 8);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 8);
  return result;
}
function distance(x, y, ax, ay, bx, by) {
  const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay));
}
const strokes = [[12, 5.5, 12, 14], [8.5, 10.5, 12, 14], [12, 14, 15.5, 10.5], [6, 15, 6, 18], [6, 18, 18, 18], [18, 15, 18, 18]];
function pixel(x, y) {
  const dx = Math.max(3.8 - x, 0, x - 20.2), dy = Math.max(3.8 - y, 0, y - 20.2);
  if (Math.hypot(dx, dy) > 3.5) return [0, 0, 0, 0];
  const white = strokes.some((line) => distance(x, y, ...line) < 1.05);
  return white ? [255, 255, 255, 255] : [22, 127, 122, 255];
}
await mkdir(resolve(import.meta.dirname, "../extension/icons"), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const raw = Buffer.alloc((1 + size * 4) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const rgba = [0, 0, 0, 0];
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const color = pixel((x + (sx + .5) / 4) / size * 24, (y + (sy + .5) / 4) / size * 24);
      for (let c = 0; c < 4; c++) rgba[c] += color[c] / 16;
    }
    for (let c = 0; c < 4; c++) raw[y * (1 + size * 4) + 1 + x * 4 + c] = Math.round(rgba[c]);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  await writeFile(join(resolve(import.meta.dirname, "../extension/icons"), `icon${size}.png`), png);
}
console.log("Created extension icons: 16, 32, 48, 128 px");
