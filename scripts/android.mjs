import { copyFile, link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { prepareNative } from "./prepare-native.mjs";

const root = resolve(import.meta.dirname, ".."), source = join(root, "native/android");
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
const jdk = process.env.JAVA_HOME;
if (!sdk || !jdk) throw new Error("Set ANDROID_HOME (Android SDK 35) and JAVA_HOME (JDK 17 or later).");
const tools = join(sdk, "build-tools/35.0.0"), platform = join(sdk, "platforms/android-35/android.jar");
const work = await mkdtemp(join(tmpdir(), "xdzk-apk-")), assets = join(work, "assets"), classes = join(work, "classes");
const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
const versionCode = version.split(".").reduce((code, digit) => code * 100 + Number(digit), 0);
const win = process.platform === "win32" ? ".exe" : "";
const java = tool => join(jdk, "bin", tool + win);
function run(command, args) {
  const res = spawnSync(command, args, { cwd: work, stdio: "inherit", windowsHide: true });
  if (res.error || res.status !== 0) throw res.error || new Error("Build failed: " + command);
}
await prepareNative(assets);
const res = join(work, "res");
await mkdir(join(res, "xml"), { recursive: true }); await mkdir(join(res, "drawable"));
await copyFile(join(source, "res/xml/network.xml"), join(res, "xml/network.xml"));
await copyFile(join(root, "extension/icons/icon128.png"), join(res, "drawable/launcher.png"));
await mkdir(classes);
// Some Windows SDK tools require relative arguments when the user profile uses non-ASCII characters.
const aapt = join(tools, "aapt2" + win), unsigned = "unsigned.apk";
await link(platform, join(work, "android.jar")).catch(() => copyFile(platform, join(work, "android.jar")));
await copyFile(join(source, "AndroidManifest.xml"), join(work, "AndroidManifest.xml"));
run(aapt, ["compile", "--dir", "res", "-o", "resources.zip"]);
run(aapt, ["link", "-o", unsigned, "-I", "android.jar", "--manifest", "AndroidManifest.xml", "-A", "assets",
  "--min-sdk-version", "26", "--target-sdk-version", "35", "--version-code", String(versionCode), "--version-name", version, "resources.zip"]);
const boot = [platform, join(tools, "core-lambda-stubs.jar")].join(delimiter);
run(java("javac"), ["-encoding", "UTF-8", "-source", "8", "-target", "8", "-bootclasspath", boot, "-d", classes, join(source, "CourseActivity.java")]);
const pkg = join(classes, "io/github/pais1ey/xdzk");
const bytecode = (await readdir(pkg)).filter(n => n.endsWith(".class")).map(n => join(pkg, n));
run(java("java"), ["-cp", join(tools, "lib/d8.jar"), "com.android.tools.r8.D8", "--min-api", "26", "--lib", platform, "--output", work, ...bytecode]);
run(java("jar"), ["uf", unsigned, "-C", work, "classes.dex"]);
const aligned = "aligned.apk";
run(join(tools, "zipalign" + win), ["-f", "4", unsigned, aligned]);
// Reuse the standard private development key so local updates retain viewing history.
const keys = join(homedir(), ".android"), key = join(keys, "debug.keystore");
await mkdir(keys, { recursive: true });
if (!existsSync(key)) run(java("keytool"), ["-genkeypair", "-keystore", key, "-storepass", "android", "-keypass", "android",
  "-alias", "androiddebugkey", "-dname", "CN=Android Debug,O=Android,C=US", "-keyalg", "RSA", "-validity", "10000"]);
const out = join(root, "dist"), name = `xdzk-android-${version}.apk`, apk = join(out, name);
await mkdir(out, { recursive: true });
const signer = ["-jar", join(tools, "lib/apksigner.jar")];
run(java("java"), [...signer, "sign", "--ks", key, "--ks-key-alias", "androiddebugkey", "--ks-pass", "pass:android", "--key-pass", "pass:android", "--v4-signing-enabled", "false", "--out", apk, aligned]);
run(java("java"), [...signer, "verify", "--verbose", apk]);
const hash = createHash("sha256").update(await readFile(apk)).digest("hex");
await writeFile(apk + ".sha256", hash + "  " + name + "\n");
console.log(`Built dist/${name}, SHA256 ${hash}`);
if (dirname(resolve(work)) === resolve(tmpdir())) await rm(work, { recursive: true });
