// 用无头 Chrome + CDP 截取本地演示页（npm run preview）的插件画面。
import { spawn } from "node:child_process";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = path.dirname(new URL(import.meta.url).pathname);
const profile = await mkdtemp(path.join(tmpdir(), "xrc-shot-"));
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9333", `--user-data-dir=${profile}`,
  "--hide-scrollbars", "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) {
  try { target = (await (await fetch("http://127.0.0.1:9333/json")).json()).find(t => t.type === "page"); } catch { await sleep(200); }
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", r));
let id = 0; const pending = new Map();
ws.addEventListener("message", e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async expr => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
const shot = async name => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(path.join(OUT, name), Buffer.from(r.result.data, "base64"));
  console.log("saved", name);
};

await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });
for (const [url, name] of [["http://127.0.0.1:5818/notifications", "notifications"], ["http://127.0.0.1:5818/home", "home"]]) {
  await send("Page.navigate", { url });
  await sleep(2500);
  await shot(`${name}.png`);
  // 打开第一条的「回复」，截回复框工具栏
  const clicked = await evaluate(`(() => { const b = [...document.querySelectorAll('[data-testid="reply"], .actions button')].find(x => /回复/.test(x.textContent) || x.dataset.testid === 'reply'); if (!b) return false; b.click(); return true; })()`);
  await sleep(1500);
  if (clicked) await shot(`${name}-composer.png`);
}
ws.close(); chrome.kill();
