import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const root = fileURLToPath(new URL("../../",import.meta.url));
const git = promisify(execFile);
const baseline = process.argv[2] || "f277bfa0022a4905487120ba1021d9c162f1ad0a";
const types = { ".html":"text/html", ".js":"text/javascript", ".mjs":"text/javascript", ".css":"text/css" };
http.createServer(async (request,response) => {
  try {
    const pathname = new URL(request.url,"http://localhost").pathname;
    const relative = pathname === "/notifications" ? "tests/demo.html" : decodeURIComponent(pathname).slice(1);
    const filename = path.resolve(root,relative);
    if (!filename.startsWith(root) || !types[path.extname(filename)] || !/^(tests|extension)\//.test(relative)) throw new Error("Not found");
    const body = relative.startsWith("extension/") ?
      (await git("git",["show",`${baseline}:${relative}`],{ cwd:root,maxBuffer:1024*1024 })).stdout : await readFile(filename);
    response.writeHead(200,{ "Content-Type":types[path.extname(filename)]+"; charset=utf-8","Cache-Control":"no-store" });
    response.end(body);
  } catch { response.writeHead(404); response.end("Not found"); }
}).listen(5830,"127.0.0.1",() => console.log(`Baseline ${baseline}: http://127.0.0.1:5830/notifications`));
