import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { categorizeCommits, formatReleaseNotes } from "../scripts/release-notes.mjs";

test("categorizes conventional commits into features, fixes and other improvements", () => {
  const groups = categorizeCommits([
    { hash: "a53b2ff123", subject: "fix: prevent auto-pause after seeking" },
    { hash: "6894253456", subject: "feat(playlist): scrape course playlist" },
    { hash: "09f2a88789", subject: "docs: generalize README installation guide" },
    { hash: "deadbeef00", subject: "Merge pull request #1 from user/branch" }
  ]);
  assert.deepEqual(groups.features, ["- scrape course playlist (`6894253`)"]);
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
