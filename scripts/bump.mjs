import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");

export function resolveNextVersion(current, target) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(current || "").trim());
  if (!match) throw new Error(`Invalid current version: ${current}`);
  let [major, minor, patch] = match.slice(1).map(Number);
  const input = String(target || "").trim().replace(/^v/i, "");
  if (input === "patch") return `${major}.${minor}.${patch + 1}`;
  if (input === "minor") return `${major}.${minor + 1}.0`;
  if (input === "major") return `${major + 1}.0.0`;
  if (/^\d+\.\d+\.\d+$/.test(input)) return input;
  throw new Error(`Invalid target version "${target}". Use patch, minor, major, or x.y.z.`);
}

async function updateJsonVersion(filePath, nextVersion, { lockfile = false } = {}) {
  const raw = await readFile(filePath, "utf8");
  const data = JSON.parse(raw);
  data.version = nextVersion;
  if (lockfile && data.packages?.[""]) data.packages[""].version = nextVersion;
  await writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: npm run version:bump -- <patch|minor|major|x.y.z>");
    process.exit(1);
  }
  const pkgPath = join(root, "package.json");
  const manifestPath = join(root, "extension", "manifest.json");
  const lockPath = join(root, "package-lock.json");

  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  const nextVersion = resolveNextVersion(pkg.version, target);

  await updateJsonVersion(pkgPath, nextVersion);
  await updateJsonVersion(manifestPath, nextVersion);
  try {
    await updateJsonVersion(lockPath, nextVersion, { lockfile: true });
  } catch { /* package-lock.json is optional */ }

  console.log(`Updated version: ${pkg.version} -> ${nextVersion}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
