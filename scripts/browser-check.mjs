// 用无头 Chrome 运行需要真实浏览器 API（IndexedDB 等）的检查页。
// 用法：node scripts/browser-check.mjs tests/material-db-check.html [...]
// 检查页通过 tests/browser-check-harness.js 暴露 BrowserCheck.done（结果 Promise），
// 本脚本经 Chrome DevTools 协议等待该 Promise，因此能覆盖 IndexedDB 等真实异步 I/O。
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startChrome, connect, waitFor, delay } from "./lib/headless-chrome.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const PAGE_TIMEOUT = 60000;
const pages = process.argv.slice(2);
if (!pages.length) throw new Error("请指定检查页，例如 tests/material-db-check.html");

function startPreview() {
  const server = spawn(process.execPath, [path.join(root, "scripts/preview.mjs")], { stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("预览服务未在 5 秒内启动")), 5000);
    server.once("error", reject);
    server.stdout.once("data", () => { clearTimeout(timer); resolve(server); });
  });
}

async function runPage(chrome, page) {
  const target = await chrome.open(`http://127.0.0.1:5818/${page}`);
  const client = await connect(target.webSocketDebuggerUrl);
  try {
    await waitFor(() => client.evaluate("Boolean(globalThis.BrowserCheck?.done)").catch(() => false), 15000, "检查页没有加载 BrowserCheck");
    const result = await Promise.race([client.evaluate("BrowserCheck.done"), delay(PAGE_TIMEOUT).then(() => null)]);
    return result || { ok: false, error: "检查超时" };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    client.close();
  }
}

const server = await startPreview();
const chrome = await startChrome();
let failed = 0;
try {
  for (const page of pages) {
    const result = await runPage(chrome, page);
    console.log(`${result.ok ? "✔" : "✖"} ${page}`);
    for (const line of result.checks || []) console.log(`  ${line.ok ? "✔" : "✖"} ${line.name}${line.detail ? ` — ${line.detail}` : ""}`);
    if (result.error) console.log(`  错误：${result.error}`);
    if (!result.ok) failed++;
  }
} finally {
  await chrome.stop();
  server.kill();
}
process.exitCode = failed ? 1 : 0;
