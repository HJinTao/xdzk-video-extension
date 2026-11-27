import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");

function stripPrefix(subject) {
  return String(subject || "")
    .replace(/^(?:feat|fix|docs|chore|ci|build|refactor|style|test|perf|revert)(?:\([^)]+\))?!?:\s*/i, "")
    .trim();
}

export function categorizeCommits(commits = []) {
  const groups = { features: [], fixes: [], others: [] };
  for (const entry of commits) {
    const subject = String(entry?.subject || "").trim();
    if (!subject || /^Merge\s+(?:pull request|branch)\b/i.test(subject)) continue;
    const hash = entry?.hash ? String(entry.hash).slice(0, 7) : "";
    const text = stripPrefix(subject) || subject;
    const line = hash ? `- ${text} (\`${hash}\`)` : `- ${text}`;
    if (/^feat(?:\([^)]+\))?!?:/i.test(subject)) groups.features.push(line);
    else if (/^fix(?:\([^)]+\))?!?:/i.test(subject)) groups.fixes.push(line);
    else groups.others.push(line);
  }
  return groups;
}

export function formatReleaseNotes({
  version,
  previousTag = "",
  commits = [],
  sha256 = "",
  zipName = `xdzk-recorder-${version}.zip`,
  repoUrl = ""
}) {
  const groups = categorizeCommits(commits);
  const sections = [];

  sections.push(`## 西电智课 · 录播助手 v${version}`);
  sections.push("");
  sections.push("### 本次更新内容");
  sections.push("");

  const hasEntries = groups.features.length || groups.fixes.length || groups.others.length;
  if (!hasEntries) {
    sections.push("- 常规维护与打包发布。");
    sections.push("");
  } else {
    if (groups.features.length) {
      sections.push("#### 新增功能");
      sections.push(...groups.features, "");
    }
    if (groups.fixes.length) {
      sections.push("#### 问题修复");
      sections.push(...groups.fixes, "");
    }
    if (groups.others.length) {
      sections.push("#### 其他改进与文档");
      sections.push(...groups.others, "");
    }
  }

  sections.push("### 安装与升级");
  sections.push("");
  sections.push(`1. 下载本页附件中的 **\`${zipName}\`**（或固定链接 \`xdzk-recorder-latest.zip\`）并解压到长期保留的文件夹。`);
  sections.push("2. 打开浏览器扩展管理页（`chrome://extensions/` 或 `edge://extensions/`），开启**开发者模式**。");
  sections.push("3. **首次安装**：点击「加载已解压的扩展程序」，选择直接包含 `manifest.json` 的文件夹。");
  sections.push("4. **旧版升级**：用新版解压文件覆盖原目录，在扩展管理页点击该扩展的「重新加载」，并刷新已打开的课程回放页。");
  sections.push("");

  if (sha256) {
    sections.push("### 校验信息（SHA-256）");
    sections.push("");
    sections.push("```text");
    sections.push(`${sha256.trim()}  ${zipName}`);
    sections.push("```");
    sections.push("");
  }

  if (repoUrl && previousTag) {
    sections.push(`**完整变更对比**：${repoUrl.replace(/\/$/, "")}/compare/${previousTag}...v${version}`);
    sections.push("");
  }

  return sections.join("\n").trim() + "\n";
}

function git(args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

export function findPreviousTag(currentTag) {
  const tags = git(["tag", "--merged", "HEAD", "--list", "v*", "--sort=-v:refname"]).split(/\r?\n/).filter(Boolean);
  return tags.find((tag) => tag !== currentTag) || "";
}

export function collectCommits(previousTag) {
  const range = previousTag ? `${previousTag}..HEAD` : "HEAD";
  const output = git(["log", range, "--no-merges", "--pretty=format:%H%x1f%s"]);
  if (!output) return [];
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [hash, subject] = line.split("\x1f");
    return { hash, subject };
  });
}

async function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const outPath = outIndex >= 0 ? args[outIndex + 1] : "";

  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const version = pkg.version;
  const currentTag = `v${version}`;
  const previousTag = findPreviousTag(currentTag);
  const commits = collectCommits(previousTag);
  const zipName = `xdzk-recorder-${version}.zip`;

  let sha256 = "";
  try {
    const shaFile = await readFile(join(root, "dist", `${zipName}.sha256`), "utf8");
    sha256 = shaFile.trim().split(/\s+/)[0] || "";
  } catch { /* Build may not have run yet. */ }

  const server = process.env.GITHUB_SERVER_URL || "https://github.com";
  const repo = process.env.GITHUB_REPOSITORY || "";
  const repoUrl = repo ? `${server}/${repo}` : "";

  const notes = formatReleaseNotes({ version, previousTag, commits, sha256, zipName, repoUrl });
  if (outPath) {
    await writeFile(resolve(root, outPath), notes, "utf8");
    console.log(`Generated release notes at ${outPath}`);
  } else {
    process.stdout.write(notes);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
