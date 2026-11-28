import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { categorizeCommits, findPreviousTag, formatReleaseNotes } from "../scripts/release-notes.mjs";

test("categorizes conventional commits into features, fixes and other improvements", () => {
  const groups = categorizeCommits([
    { hash: "a53b2ff123", subject: "fix: prevent auto-pause after seeking" },
    { hash: "6894253456", subject: "feat(playlist): scrape course playlist" },
    { hash: "09f2a88789", subject: "docs: generalize README installation guide" },
    { hash: "c0ffee1234", subject: "feat：支持全角冒号与中文提交摘要" },
    { hash: "19f847a999", subject: "chore: release v0.7.0" },
    { hash: "29f847a888", subject: "chore(release): 发布 v0.7.0" },
    { hash: "deadbeef00", subject: "Merge pull request #1 from user/branch" }
  ]);
  assert.deepEqual(groups.features, [
    "- scrape course playlist (`6894253`)",
    "- 支持全角冒号与中文提交摘要 (`c0ffee1`)"
  ]);
  assert.deepEqual(groups.fixes, ["- prevent auto-pause after seeking (`a53b2ff`)"]);
  assert.deepEqual(groups.others, ["- generalize README installation guide (`09f2a88`)"]);
});

test("formats Chinese release notes with grouped changes, checksum and compare link", () => {
  const notes = formatReleaseNotes({
    version: "0.6.0",
    previousTag: "v0.5.2",
    commits: [
      { hash: "1111111", subject: "feat: add continuous playback" },
      { hash: "2222222", subject: "fix: stop pausing after seeking" }
    ],
    sha256: "abcdef0123456789",
    zipName: "xdzk-recorder-0.6.0.zip",
    repoUrl: "https://github.com/Pais1ey/xdzk-video-extension"
  });
  assert.match(notes, /## 西电智课 · 录播助手 v0\.6\.0/);
  assert.match(notes, /#### 新增功能/);
  assert.match(notes, /#### 问题修复/);
  assert.match(notes, /abcdef0123456789  xdzk-recorder-0\.6\.0\.zip/);
  assert.match(notes, /compare\/v0\.5\.2\.\.\.v0\.6\.0/);
});

test("README uses version-agnostic release links without hardcoded release versions", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /releases\/latest\/download\/xdzk-recorder-latest\.zip/);
  assert.match(readme, /releases\/latest\)/);
  assert.doesNotMatch(readme, /releases\/(?:download|tag)\/v\d+\.\d+\.\d+/);
  assert.doesNotMatch(readme, /xdzk-recorder-\d+\.\d+\.\d+\.(?:zip|crx)/);
});

test("findPreviousTag resolves the topologically closest ancestor tag even when an older tag has a higher semver", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "xdzk-tags-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const run = (args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  run(["init"]);
  run(["config", "user.name", "Tester"]);
  run(["config", "user.email", "tester@example.com"]);

  await writeFile(join(dir, "a.txt"), "1");
  run(["add", "."]);
  run(["commit", "-m", "initial"]);
  run(["tag", "v0.6.0"]);

  await writeFile(join(dir, "a.txt"), "2");
  run(["add", "."]);
  run(["commit", "-m", "release 0.5.2"]);
  run(["tag", "v0.5.2"]);

  await writeFile(join(dir, "a.txt"), "3");
  run(["add", "."]);
  run(["commit", "-m", "next feature"]);

  assert.equal(findPreviousTag("v0.6.0", dir), "v0.5.2");
  assert.equal(findPreviousTag("v0.5.3", dir), "v0.5.2");
});
