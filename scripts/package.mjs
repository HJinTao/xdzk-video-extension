import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { createHash } from "node:crypto";
import { zipSync, strToU8, unzipSync } from "fflate";
import { mobileAssets } from "./mobile-server.mjs";
import { replayReader } from "./prepare-native.mjs";

const root = resolve(import.meta.dirname, "..");
const source = join(root, "extension");
const manifest = JSON.parse(await readFile(join(source, "manifest.json"), "utf8"));
const desktop = {}, mobile = {}, ios = {};
const options = { mtime: new Date("2026-01-01T00:00:00Z") };
async function add(archive, name, path) {
  archive[name] = [new Uint8Array(await readFile(path)), options];
}
async function collect(directory) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else await add(desktop, relative(source, path).replaceAll("\\", "/"), path);
  }
}
await collect(source);
await add(desktop, "使用说明.md", join(root, "README.md"));
for (const file of mobileAssets) mobile["extension/" + file] = desktop[file];
mobile["extension/index.html"] = desktop["mobile.html"];
for (const file of ["start-mobile.cmd", "scripts/mobile-server.mjs"]) await add(mobile, file, join(root, file));
mobile["使用说明.md"] = desktop["使用说明.md"];
for (const file of ["project.yml", "ShareGroup.entitlements", "Shared.swift", "App/App.swift", "Share/ShareController.swift"]) {
  await add(ios, file, join(root, "native/ios", file));
}
for (const file of mobileAssets) ios["Resources/web/" + file] = desktop[file];
ios["Resources/reader.js"] = [strToU8(replayReader), options];
ios["使用说明.md"] = desktop["使用说明.md"];
const out = join(root, "dist");
await mkdir(out, { recursive: true });
async function build(name, files, required) {
  const bytes = zipSync(files, { level: 9 });
  const unpacked = unzipSync(bytes);
  if (!required.every(path => unpacked[path]?.length)) throw new Error("Incomplete archive: " + name);
  await writeFile(join(out, name), bytes);
  const sha = createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(out, name + ".sha256"), `${sha}  ${name}\n`);
  console.log(`Built dist/${name} (${bytes.length} bytes, ${Object.keys(unpacked).length} files), SHA256 ${sha}`);
}
await build(`xdzk-recorder-${manifest.version}.zip`, desktop, ["manifest.json", "background.js", "popup.html", "icons/icon128.png"]);
await build(`xdzk-mobile-${manifest.version}.zip`, mobile, Object.keys(mobile));
await build(`xdzk-ios-source-${manifest.version}.zip`, ios, Object.keys(ios));
