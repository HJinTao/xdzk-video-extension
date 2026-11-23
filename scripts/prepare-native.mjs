import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mobileAssets } from "./mobile-server.mjs";
import { collectReplay } from "../extension/lib/replay-bookmark.js";
export const replayReader = "(" + collectReplay.toString() + ")(document)";

export async function prepareNative(destination) {
  const source = resolve(import.meta.dirname, "../extension");
  for (const name of mobileAssets) {
    const file = join(destination, "web", name);
    await mkdir(dirname(file), { recursive: true });
    await copyFile(join(source, name), file);
  }
  await writeFile(join(destination, "reader.js"), replayReader);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await prepareNative(resolve(process.argv[2] || "native/ios/Resources"));
}
