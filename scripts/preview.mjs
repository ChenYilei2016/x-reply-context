import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../",import.meta.url));
const types = { ".html":"text/html", ".js":"text/javascript", ".mjs":"text/javascript", ".css":"text/css" };
http.createServer(async (request,response) => {
  try {
    const pathname = new URL(request.url,"http://127.0.0.1").pathname;
    if (pathname === "/") {
      response.writeHead(302,{ Location:"/notifications" }); response.end(); return;
    }
    const relative = ["/notifications","/home"].includes(pathname) ? "tests/demo.html" : "." + decodeURIComponent(pathname);
    const filename = path.resolve(root,relative);
    if (!filename.startsWith(root) || !types[path.extname(filename)]) throw new Error("Not found");
    const data = await readFile(filename);
    response.writeHead(200,{ "Content-Type":types[path.extname(filename)] + "; charset=utf-8","Cache-Control":"no-store" });
    response.end(data);
  } catch {
    response.writeHead(404); response.end("Not found");
  }
}).listen(5818,"127.0.0.1",() => console.log("本地模拟：http://127.0.0.1:5818/notifications 和 /home"));
