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
    if (pathname === "/tests/ai-settings-preview.html") {
      const template = await readFile(path.join(root,"extension/ai-settings.html"),"utf8");
      response.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"});
      response.end(template.replace('src="ai-config.js"','src="/extension/ai-config.js"')
        .replace('<script src="ai-settings.js"></script>','<script src="/tests/ai-settings-fixture.js"></script><script src="/extension/ai-settings.js"></script>'));
      return;
    }
    if (pathname === "/tests/popup-preview.html") {
      const template=await readFile(path.join(root,"extension/popup.html"),"utf8");
      response.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"});
      response.end(template.replace('href="popup.css"','href="/extension/popup.css"').replace('src="timed-replies.js"','src="/extension/timed-replies.js"')
        .replace('<script src="popup.js"></script>','<script src="/tests/popup-fixture.js"></script><script src="/extension/popup.js"></script>'));
      return;
    }
    const relative = ["/notifications","/home","/carol","/carol/with_replies","/search","/hashtag/%E6%B5%87%E6%9C%8B%E5%8F%8B"].includes(pathname) ? "tests/demo.html" : "." + decodeURIComponent(pathname);
    const filename = path.resolve(root,relative);
    if (!filename.startsWith(root) || !types[path.extname(filename)]) throw new Error("Not found");
    const data = await readFile(filename);
    response.writeHead(200,{ "Content-Type":types[path.extname(filename)] + "; charset=utf-8","Cache-Control":"no-store" });
    response.end(data);
  } catch {
    response.writeHead(404); response.end("Not found");
  }
}).listen(5818,"127.0.0.1",() => console.log("本地模拟：http://127.0.0.1:5818/notifications 和 /home"));
