// 用无头 Chrome 运行需要真实浏览器 API（IndexedDB 等）的检查页。
// 用法：node scripts/browser-check.mjs tests/material-db-check.html [...]
// 检查页通过 tests/browser-check-harness.js 暴露 BrowserCheck.done（结果 Promise），
// 本脚本经 Chrome DevTools 协议等待该 Promise，因此能覆盖 IndexedDB 等真实异步 I/O。
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PAGE_TIMEOUT = 60000;
const pages = process.argv.slice(2);
if (!pages.length) throw new Error("请指定检查页，例如 tests/material-db-check.html");

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(probe, timeout, message) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await delay(100);
  }
  throw new Error(message);
}

function startPreview() {
  const server = spawn(process.execPath, [path.join(root, "scripts/preview.mjs")], { stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("预览服务未在 5 秒内启动")), 5000);
    server.once("error", reject);
    server.stdout.once("data", () => { clearTimeout(timer); resolve(server); });
  });
}

async function startChrome() {
  const profile = mkdtempSync(path.join(tmpdir(), "xrc-check-"));
  const browser = spawn(chromePath, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"
  ], { stdio: "ignore" });
  const portFile = path.join(profile, "DevToolsActivePort");
  const port = await waitFor(() => existsSync(portFile) && readFileSync(portFile, "utf8").split("\n")[0], 15000, "Chrome 未启动调试端口");
  const exited = new Promise(resolve => browser.once("exit", resolve));
  return {
    port,
    async stop() {
      browser.kill();
      await exited;
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  };
}

/** 极简 CDP 客户端：按 id 匹配请求与响应。 */
async function connect(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  return {
    send(method, params = {}) {
      const id = ++sequence;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise(resolve => pending.set(id, resolve));
    },
    close() { socket.close(); }
  };
}

async function runPage(port, page) {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(`http://127.0.0.1:5818/${page}`)}`, { method: "PUT" })).json();
  const client = await connect(target.webSocketDebuggerUrl);
  try {
    await waitFor(async () => {
      const probe = await client.send("Runtime.evaluate", { expression: "Boolean(globalThis.BrowserCheck?.done)", returnByValue: true });
      return probe.result?.result?.value === true;
    }, 15000, "检查页没有加载 BrowserCheck");
    const evaluation = await Promise.race([
      client.send("Runtime.evaluate", { expression: "BrowserCheck.done", awaitPromise: true, returnByValue: true }),
      delay(PAGE_TIMEOUT).then(() => ({ timeout: true }))
    ]);
    if (evaluation.timeout) return { ok: false, error: "检查超时" };
    if (evaluation.result?.exceptionDetails) return { ok: false, error: evaluation.result.exceptionDetails.exception?.description || "页面异常" };
    return evaluation.result.result.value;
  } finally {
    client.close();
  }
}

const server = await startPreview();
const chrome = await startChrome();
let failed = 0;
try {
  for (const page of pages) {
    const result = await runPage(chrome.port, page);
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
