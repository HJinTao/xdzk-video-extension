import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";

const root = resolve(import.meta.dirname, "../extension");
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png" };
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    if (pathname === "/preview-mock.js") {
      response.writeHead(200, { "Content-Type": types[".js"], "Cache-Control": "no-store" });
      response.end(await readFile(resolve(import.meta.dirname, "preview-mock.js")));
      return;
    }
    const path = resolve(root, `.${pathname === "/" ? "/popup.html" : pathname}`);
    if (!path.startsWith(root + sep)) throw new Error("Invalid path");
    let content = await readFile(path);
    if (path.endsWith("popup.html") || path.endsWith("player.html")) content = Buffer.from(content.toString("utf8").replace("<head>", '<head><script src="/preview-mock.js"></script>').replace("<title>西电智课录播下载</title>", "<title>扩展界面演示 · 示例数据</title>"));
    response.writeHead(200, { "Content-Type": types[extname(path)] || "application/octet-stream", "Cache-Control": "no-store" });
    response.end(content);
  } catch {
    response.writeHead(404); response.end("Not found");
  }
});
server.listen(Number(process.env.XDZK_PREVIEW_PORT || 8849), "127.0.0.1", () => {
  console.log(`Preview (demo data): http://127.0.0.1:${server.address().port}/`);
});
