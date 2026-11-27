import { readFile, readdir, access } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const extension = join(root, "extension");
const manifest = JSON.parse(await readFile(join(extension, "manifest.json"), "utf8"));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (manifest.manifest_version !== 3 || manifest.version !== pkg.version) throw new Error("Manifest/version mismatch");
if (manifest.host_permissions.some((host) => host.includes("<all_urls>") || host.includes("*://*"))) throw new Error("Overbroad host permissions");
if (manifest.permissions.includes("cookies")) throw new Error("Cookie access is not required");
const references = [manifest.background.service_worker, manifest.action.default_popup,
  ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon),
  ...manifest.content_scripts.flatMap((script) => script.js)];
for (const file of references) await access(join(extension, file));
async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    files.push(...(entry.isDirectory() ? await walk(path) : [path]));
  }
  return files;
}
const files = (await walk(extension)).filter((file) => file.endsWith(".js"));
for (const file of files) {
  const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (check.status !== 0) throw new Error(`${relative(root, file)}: ${check.stderr}`);
}
for (const page of ["popup.html", "player.html"]) {
  const html = await readFile(join(extension, page), "utf8");
  if (/<script[^>]+src=["']https?:/i.test(html)) throw new Error("Remote executable code is not allowed");
  for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) await access(join(extension, match[1]));
}
const tscBin = join(root, "node_modules", "typescript", "bin", "tsc");
const typecheck = spawnSync(process.execPath, [tscBin, "-p", join(root, "tsconfig.json")], { encoding: "utf8" });
if (typecheck.status !== 0) {
  throw new Error(`TypeScript check failed:\n${typecheck.stdout}${typecheck.stderr}`);
}
console.log(`Manifest, permissions, assets, ${files.length} JavaScript files and TypeScript checkJs: OK`);
