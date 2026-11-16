// 扩展冒烟检查：在无头 Chrome 中真实加载 extension/，验证后台启动、渠道注册、渠道页渲染与素材入库链路。
// 用法：node scripts/extension-check.mjs
// 主机权限的授权弹窗无法在无头模式下确认，渠道实拉需在真实 Chrome 中授权后验证。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startChromeWithPipe, waitFor } from "./lib/headless-chrome.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok });
  console.log(`  ${ok ? "✔" : "✖"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
};

const chrome = await startChromeWithPipe();
try {
  const { id } = await chrome.send("Extensions.loadUnpacked", { path: path.join(root, "extension") });
  console.log(`扩展已加载：${id}`);
  const worker = await chrome.attach(target => target.type === "service_worker" && target.url === `chrome-extension://${id}/background.js`);

  // 目标出现时脚本可能尚未执行完，等待全局对象就绪。
  await waitFor(() => chrome.evaluate(worker, "typeof creationService === 'function' && typeof XReplyChannels === 'object'").catch(() => false),
    10000, "后台脚本未就绪");
  const registered = await chrome.evaluate(worker, "XReplyChannels.list().map(channel => channel.id)");
  check("后台启动并注册 10 个拉取渠道", registered.length === 10, registered.join(","));
  const alarm = await waitFor(() => chrome.evaluate(worker, "chrome.alarms.get('creationChannels').then(alarm => alarm?.periodInMinutes)"), 10000, "定时器未创建")
    .catch(error => error.message);
  check("安装后创建 5 分钟周期的定时器", alarm === 5, alarm);

  const posts = JSON.stringify([
    { id: "x:9001", kind: "x_post", url: "https://x.com/alice/status/9001", text: "OpenAI 发布新模型", coverage: "full",
      publishedAt: new Date(Date.now() - 3600_000).toISOString(), author: { handle: "alice", followers: 1000 },
      metrics: { views: 50000, likes: 900, observedAt: new Date().toISOString() } },
    { id: "x:9002", kind: "x_post", url: "https://x.com/me/status/9002", text: "我的帖子", coverage: "full",
      publishedAt: new Date().toISOString(), author: { handle: "me" } }
  ]);
  const ingest = await chrome.evaluate(worker,
    `creationService().handle({ type: "CREATION_INGEST_X", account: "me", posts: ${posts} }, { frameId: 0, url: "https://x.com/home" })`);
  check("X 浏览采集写入真实 IndexedDB", ingest.ok && ingest.stored === 2, JSON.stringify(ingest));

  const { targetId } = await chrome.send("Target.createTarget", { url: `chrome-extension://${id}/creation/channels.html` });
  const page = await chrome.attach(target => target.targetId === targetId);
  const summary = await waitFor(async () => {
    const text = await chrome.evaluate(page, "document.getElementById('summary')?.textContent || ''");
    return text.startsWith("素材库") && text;
  }, 10000, "渠道页未渲染").catch(error => error.message);
  check("渠道页渲染并读到素材总数", /素材库共 2 条/.test(summary), summary);
  const cards = await chrome.evaluate(page, "document.querySelectorAll('.channel').length");
  check("渠道页列出 10 个渠道", cards === 10, cards);
  const capture = await chrome.evaluate(page, "document.getElementById('x-capture-state').textContent");
  check("X 浏览采集显示累计入库", /累计新增 2 条/.test(capture), capture);

} finally {
  await chrome.stop();
}
const failed = checks.filter(item => !item.ok).length;
console.log(failed ? `✖ ${failed} 项失败` : `✔ ${checks.length} 项全部通过`);
process.exitCode = failed ? 1 : 0;
