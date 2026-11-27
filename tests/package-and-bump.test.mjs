import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildArchive } from "../scripts/package.mjs";
import { resolveNextVersion } from "../scripts/bump.mjs";

test("resolveNextVersion handles semver shortcuts and explicit versions", () => {
  assert.equal(resolveNextVersion("0.5.2", "patch"), "0.5.3");
  assert.equal(resolveNextVersion("0.5.2", "minor"), "0.6.0");
  assert.equal(resolveNextVersion("0.5.2", "major"), "1.0.0");
  assert.equal(resolveNextVersion("0.5.2", "v1.2.3"), "1.2.3");
  assert.throws(() => resolveNextVersion("0.5.2", "invalid"));
});

test("buildArchive packages only extension runtime files without docs screenshots or dotfiles", async () => {
  const { files, bytes } = await buildArchive();
  assert.ok(files.includes("manifest.json"));
  assert.ok(files.includes("player.html"));
  assert.ok(files.includes("popup.html"));
  assert.ok(files.every((name) => !name.startsWith("docs/") && !name.includes("/.") && !name.startsWith(".") && !name.endsWith(".d.ts")));
  assert.ok(bytes.length < 512 * 1024, `expected slim extension zip under 512 KB, got ${bytes.length} bytes`);
});

test("README avoids external shields.io badges and gitattributes excludes dev files from source archives", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const attrs = await readFile(new URL("../.gitattributes", import.meta.url), "utf8");
  assert.doesNotMatch(readme, /img\.shields\.io/);
  assert.match(readme, /github\.com\/Pais1ey\/xdzk-video-extension\/actions\/workflows\/ci\.yml\/badge\.svg/);
  assert.match(attrs, /^tests export-ignore$/m);
  assert.match(attrs, /^\.github export-ignore$/m);
  assert.match(attrs, /^tsconfig\.json export-ignore$/m);
  assert.match(attrs, /^types export-ignore$/m);
});
