import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { zipSync, unzipSync } from "fflate";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");

export async function buildArchive(rootDir = root) {
  const source = join(rootDir, "extension");
  const manifest = JSON.parse(await readFile(join(source, "manifest.json"), "utf8"));
  const archive = {};
  async function add(directory, prefix = "") {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      // Skip hidden OS metadata files (e.g. .DS_Store) so release archives stay clean.
      if (entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      const name = prefix + entry.name;
      if (entry.isDirectory()) await add(path, name + "/");
      else archive[name] = [new Uint8Array(await readFile(path)), { mtime: new Date("2026-01-01T00:00:00Z") }];
    }
  }
  await add(source);
  const bytes = zipSync(archive, { level: 9 });
  const unpacked = unzipSync(bytes);
  if (!unpacked["manifest.json"] || !unpacked["background.js"] || !unpacked["icons/icon128.png"]) {
    throw new Error("Incomplete archive");
  }
  return { version: manifest.version, bytes, files: Object.keys(unpacked) };
}

async function main() {
  const { version, bytes, files } = await buildArchive(root);
  const out = join(root, "dist");
  await mkdir(out, { recursive: true });
  const name = `xdzk-recorder-${version}.zip`;
  await writeFile(join(out, name), bytes);
  await writeFile(join(out, "xdzk-recorder-latest.zip"), bytes);
  const sha = createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(out, `${name}.sha256`), `${sha}  ${name}\n`);
  console.log(`Built dist/${name} and dist/xdzk-recorder-latest.zip (${bytes.length} bytes, ${files.length} files)`);
  console.log(`SHA256 ${sha}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
