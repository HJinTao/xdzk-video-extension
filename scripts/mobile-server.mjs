import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { resolve, extname } from "node:path";
import { pathToFileURL } from "node:url";

// These same public files can also be served by an ordinary static HTTPS host.
export const mobileAssets = [
  "mobile.html", "mobile.js", "mobile.css", "player.html", "player.js", "player.css", "history.css", "theme.css", "playback.css", "subtitles.css",
  "icons/icon32.png", "vendor/artplayer/artplayer.js", "vendor/artplayer/LICENSE.txt", "vendor/artplayer/LICENSE-option-validator.txt",
  ...["media", "sync-player", "playback-speed", "lecture-player", "subtitles", "paired-subtitles", "transcript", "watch-history", "web-playback", "phone-lesson", "replay-bookmark"].map(name => `lib/${name}.js`)
];
const routes = new Set(mobileAssets);
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png" };

export function mobileServer(root) {
  return createServer(async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { Allow: "GET, HEAD" }).end(); return; }
    const route = req.url.split("?")[0].slice(1) || "mobile.html";
    if (!routes.has(route)) { res.writeHead(404).end(); return; }
    try {
      const data = await readFile(resolve(root, route));
      res.writeHead(200, { "Content-Type": mime[extname(route)] || "text/plain", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache" });
      res.end(req.method === "HEAD" ? undefined : data);
    } catch { res.writeHead(404).end(); }
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const interfaces = Object.entries(networkInterfaces()).flatMap(([name, group]) => group
    .filter(ip => ip.family === "IPv4" && !ip.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip.address))
    .map(ip => ({ name, address: ip.address })));
  interfaces.sort((a, b) => Number(/wi-?fi|wlan|无线|ethernet|以太/i.test(b.name)) - Number(/wi-?fi|wlan|无线|ethernet|以太/i.test(a.name)));
  const host = process.env.XDZK_MOBILE_HOST || interfaces[0]?.address || "127.0.0.1";
  if (host !== "127.0.0.1" && !interfaces.some(ip => ip.address === host)) throw new Error("请选择本机的局域网 IPv4 地址。");
  const port = Number(process.env.XDZK_MOBILE_PORT || 8860);
  const server = mobileServer(resolve(import.meta.dirname, "../extension"));
  server.on("error", error => { console.error("手机版启动失败", error.message); process.exitCode = 1; });
  server.listen(port, host, () => {
    console.log(`手机版网址  http://${host}:${server.address().port}/mobile.html`);
    console.log(host === "127.0.0.1" ? "当前只有本机可访问。连接 Wi-Fi 后重新启动，即可用手机访问。" : "手机和电脑连接同一局域网，在手机 Chrome 或必应中打开上方网址。");
    console.log("观看期间请保持窗口打开。按 Ctrl+C 停止。");
  });
}
