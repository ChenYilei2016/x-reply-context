// Usage: node tests/diagnostics/draft-editor-server.mjs /absolute/test-dependencies/node_modules
import http from 'node:http';
import {readFile,access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const repo = fileURLToPath(new URL('../../',import.meta.url));
const vendor = process.argv[2] && path.resolve(process.argv[2]);
if (!vendor) throw new Error('请传入独立测试依赖的 node_modules 目录，勿使用生产安装目录');
const vendors = new Set(['react/umd/react.development.js','react-dom/umd/react-dom.development.js',
  'immutable/dist/immutable.js','draft-js/dist/Draft.js','draft-js/dist/Draft.css']);
for (const file of vendors) await access(path.join(vendor,file));
http.createServer(async (request,response) => {
  try {
    const pathname = new URL(request.url,'http://localhost').pathname;
    let base = repo, relative = pathname.slice(1);
    if (pathname.startsWith('/vendor/')) {
      base = vendor; relative = pathname.slice(8);
      if (!vendors.has(relative)) throw new Error('Not found');
    } else if (!['tests/draft-quick-replies.html','tests/draft-quick-replies.mjs','tests/ai-replies.html','tests/ai-replies.mjs','tests/like-send.html','tests/like-send.mjs',
      'extension/ai-replies.js','extension/editor.js','extension/continuous.js','extension/content.css'].includes(relative)) throw new Error('Not found');
    const file = path.join(base,relative);
    response.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html; charset=utf-8':
      file.endsWith('.css')?'text/css':'text/javascript','Cache-Control':'no-store'});
    response.end(await readFile(file));
  } catch { response.writeHead(404); response.end('not found'); }
}).listen(0,'127.0.0.1',function() {
  console.log(`http://127.0.0.1:${this.address().port}/tests/draft-quick-replies.html`);
});
