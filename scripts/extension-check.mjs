// 扩展冒烟检查：在无头 Chrome 中真实加载 extension/，验证后台启动、渠道注册、渠道页与雷达渲染、升级迁移、写作台、发布与复盘全流程。
// 用法：node scripts/extension-check.mjs
// 主机权限的授权弹窗无法在无头模式下确认：渠道实拉需在真实 Chrome 中授权后验证；
// 写作台改用本机模拟模型接口，并在后台把“域名已授权”的检查替换为通过（仅本检查进程内）。
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startChromeWithPipe, waitFor } from "./lib/headless-chrome.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok });
  console.log(`  ${ok ? "✔" : "✖"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
};

/** 模拟 Chat Completions 接口：按系统提示词判断是找角度还是成稿，返回固定 JSON；记录收到的请求。 */
function startMockModel() {
  const requests = [];
  const angles = { angles: [
    { type: "反常识", hook: "辞任 CEO 不等于离开英伟达", outline: ["先看公告原文", "再看接班安排"], evidence: ["M1"], risk: "", covered_by: ["R1"] },
    { type: "预测", hook: "接班人会是谁", outline: ["候选人"], evidence: ["M1"], risk: "事实不足，属于推测", covered_by: [] },
    { type: "吐槽", hook: "皮衣还穿吗", outline: ["梗"], evidence: ["M5"], risk: "", covered_by: [] }
  ] };
  const drafts = { drafts: [
    { hook_style: "反差", text: "黄仁勋辞任 CEO，但他没离开英伟达。" },
    { hook_style: "提问", text: "英伟达下一任 CEO 会是谁？" },
    { hook_style: "数字", text: "三十年，一家公司，一件皮衣。" }
  ] };
  const server = http.createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
    if (request.method === "OPTIONS") { response.end(); return; }
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push(parsed);
      const content = `<reply>${JSON.stringify(parsed.messages[0].content.includes("写作角度") ? angles : drafts)}</reply>`;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] }));
    });
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({ server, requests, port: server.address().port })));
}

/** X 页面固定内容：一条英文帖子（带一条引用帖），结构与 X 当前页面一致。 */
const X_FIXTURE = `<!doctype html><html><body><main data-testid="primaryColumn">
<article data-testid="tweet">
  <div data-testid="User-Name"><a href="/alice" role="link"><span>Alice</span></a><a href="/alice" role="link"><span>@alice</span></a>
    <a href="/alice/status/1890000000000000001" role="link"><time datetime="2026-11-16T09:30:00.000Z">Nov 16</time></a></div>
  <div data-testid="tweetText" lang="en"><span>Agents are eating software. Here is what changed this week.</span></div>
  <div role="link" tabindex="0"><div data-testid="tweetText"><span>quoted</span></div><div role="group" aria-label="1 reply"></div></div>
  <div role="group" aria-label="12 replies, 340 reposts, 12K likes, 250K views"><div>reply</div><div>like</div></div>
</article></main></body></html>`;

const mockModel = await startMockModel();
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

  const { targetId } = await chrome.send("Target.createTarget", { url: `chrome-extension://${id}/creation/channels.html` });
  const page = await chrome.attach(target => target.targetId === targetId);
  const summary = await waitFor(async () => {
    const text = await chrome.evaluate(page, "document.getElementById('summary')?.textContent || ''");
    return text.startsWith("素材库") && text;
  }, 10000, "渠道页未渲染").catch(error => error.message);
  check("渠道页渲染并读到素材总数", /素材库共 0 条/.test(summary), summary);
  const cards = await chrome.evaluate(page, "document.querySelectorAll('.channel').length");
  check("渠道页列出 10 个渠道", cards === 10, cards);

  // 升级迁移：0.27～0.28 X 浏览采集留下的素材在安装/更新时清除，多来源素材保留其他来源。
  await chrome.evaluate(worker, `(async () => {
    const now = Date.now();
    const db = XReplyMaterialDB.create();
    const base = { kind: "x_post", title: "", text: "旧采集", coverage: "full", lang: "", author: null, publishedAt: now, firstSeenAt: now, lastSeenAt: now,
      metrics: { views: 10 }, metricsSource: "x_observed", metricsAt: now, snapshots: [], media: [], tags: [], note: "", own: false, marks: {}, category: "other" };
    await db.upsertMany([
      { ...base, id: "x:1", url: "https://x.com/a/status/1", channelIds: ["x-observed"] },
      { ...base, id: "x:2", url: "https://x.com/a/status/2", channelIds: ["x-observed", "bot-feed"] }
    ]);
  })()`);
  await chrome.evaluate(worker, "chrome.storage.local.set({ creationXCaptureEnabled: true, creationVelocityBadge: true })");
  await chrome.evaluate(worker, "creationService().handleInstalled()");
  const migrated = await chrome.evaluate(worker, `(async () => {
    const db = XReplyMaterialDB.create();
    const settings = await chrome.storage.local.get(["creationXCaptureEnabled", "creationVelocityBadge"]);
    const kept = await db.get("x:2");
    return { removed: !(await db.get("x:1")), kept: kept?.channelIds.join(","), source: kept?.metricsSource, settings: Object.keys(settings).length };
  })()`);
  check("升级时清除 X 浏览采集的素材与设置", migrated.removed && migrated.kept === "bot-feed" && migrated.source === "channel_reported" && migrated.settings === 0,
    JSON.stringify(migrated));

  // 选题雷达：同一事件跨热榜、新闻和 X 帖子合并为一个话题，详情与选材可用。
  const { targetId: radarTarget } = await chrome.send("Target.createTarget", { url: `chrome-extension://${id}/creation/radar.html` });
  const radar = await chrome.attach(target => target.targetId === radarTarget);
  await waitFor(() => chrome.evaluate(radar, "typeof XReplyMaterialDB === 'object' && document.readyState === 'complete'").catch(() => false), 10000, "雷达页未加载");
  await chrome.evaluate(radar, `(async () => {
    const model = XReplyMaterialModel, now = Date.now(), hour = 3600000;
    const make = (raw, channelId) => model.normalize(raw, { channelId, now }).material;
    await XReplyMaterialDB.create().upsertMany([
      make({ id: "baidu:黄仁勋辞任英伟达CEO", kind: "hot_topic", url: "https://www.baidu.com/s?wd=1", title: "黄仁勋辞任英伟达CEO", metrics: { rank: 2 } }, "baidu-hot"),
      make({ id: "https://www.ithome.com/0/1.htm", kind: "article", url: "https://www.ithome.com/0/1.htm", title: "英伟达宣布黄仁勋辞任CEO，董事会启动接班", publishedAt: new Date(now - 3 * hour).toISOString() }, "ithome"),
      make({ id: "x:9101", kind: "x_post", url: "https://x.com/bob/status/9101", text: "黄仁勋辞任英伟达CEO了？太突然", publishedAt: new Date(now - 2 * hour).toISOString(),
        author: { handle: "bob", followers: 3000 }, metrics: { views: 240000 } }, "bot-feed"),
      make({ id: "https://www.ithome.com/0/2.htm", kind: "article", url: "https://www.ithome.com/0/2.htm", title: "某手机品牌秋季新品发布会定档", publishedAt: new Date(now - hour).toISOString() }, "ithome")
    ]);
    location.reload();
  })()`).catch(() => {});
  const radarReady = await waitFor(() => chrome.evaluate(radar, "document.querySelectorAll('#topics .topic').length").catch(() => 0), 10000, "雷达话题未渲染")
    .catch(error => error.message);
  check("雷达渲染话题列表", Number(radarReady) >= 3, radarReady);
  const first = await chrome.evaluate(radar, "(() => { const t = document.querySelector('#topics .topic'); return { title: t.querySelector('.topic-title').textContent, badges: t.querySelector('.topic-badges').textContent }; })()");
  check("跨渠道话题合并并排在第一", first.title === "黄仁勋辞任英伟达CEO" && first.badges.includes("3 个来源"), JSON.stringify(first));
  await chrome.evaluate(radar, "document.querySelector('#topics .topic .topic-title').click()");
  const drawer = await chrome.evaluate(radar, "({ hidden: document.getElementById('drawer').hidden, members: document.querySelectorAll('#drawer-members .member').length })");
  check("详情抽屉列出 3 条成员素材", !drawer.hidden && drawer.members === 3, JSON.stringify(drawer));
  await chrome.evaluate(radar, "document.querySelector('#drawer-members .member .pick').click()");
  const basket = await waitFor(() => chrome.evaluate(radar, "document.getElementById('basket').hidden ? '' : document.getElementById('basket-count').textContent"), 5000, "选材栏未出现")
    .catch(error => error.message);
  check("选入素材后出现选材栏", basket === "已选 1/3", basket);

  // 写作台：读取选材 → 找角度（对照同话题 X 帖子）→ 用某个角度出 3 个候选 → 编辑计数与首屏标线 → 重新打开后恢复进度。
  await chrome.evaluate(worker, `(async () => {
    chrome.permissions.contains = async () => true;
    await chrome.storage.local.set({ aiConfig: { enabled: false, activeProfileId: "mock", creationProfileIds: { angles: "mock" },
      profiles: [{ id: "mock", name: "模拟模型", baseUrl: "http://127.0.0.1:${mockModel.port}/v1", apiKey: "test", model: "mock-model" }] } });
  })()`);
  const { targetId: studioTarget } = await chrome.send("Target.createTarget", { url: `chrome-extension://${id}/creation/studio.html` });
  const studio = await chrome.attach(target => target.targetId === studioTarget);
  const studioReady = await waitFor(() => chrome.evaluate(studio,
    "document.querySelectorAll('#materials .material').length === 1 && document.querySelector('.model[data-step=angles]').textContent").catch(() => ""),
  10000, "写作台未读到选材").catch(error => error.message);
  check("写作台读到选材与各步骤模型", studioReady === "模拟模型 · mock-model", studioReady);
  const references = await chrome.evaluate(studio, "document.getElementById('references-summary').textContent");
  check("写作台找到同话题 X 帖作参考", references.startsWith("同话题 X 帖 1 条"), references);

  await chrome.evaluate(studio, "document.getElementById('find-angles').click()");
  const angleCards = await waitFor(() => chrome.evaluate(studio, "document.querySelectorAll('#angles .angle').length"), 15000, "角度未渲染")
    .catch(error => error.message);
  const firstAngle = await chrome.evaluate(studio, "(() => { const a = document.querySelector('#angles .angle'); return a ? { badges: a.querySelector('.angle-badges').textContent, potential: a.querySelector('.angle-potential').textContent, meta: a.querySelector('.angle-meta').textContent } : null; })()");
  check("找角度：3 个角度，对照参考帖标出已有人写与真实潜力", angleCards === 3 && firstAngle?.badges.includes("已有人写") &&
    firstAngle.potential.includes("24万") && !firstAngle.meta.includes("M5"), JSON.stringify({ angleCards, firstAngle }));

  await chrome.evaluate(studio, "document.querySelector('#angles .angle .use').click()");
  const candidates = await waitFor(() => chrome.evaluate(studio, "document.querySelectorAll('#candidates button').length"), 15000, "候选未渲染")
    .catch(error => error.message);
  const editor = await chrome.evaluate(studio, "({ text: document.getElementById('editor').value, meter: document.getElementById('meter').textContent })");
  const draftsRequest = mockModel.requests.at(-1)?.messages[0].content || "";
  check("成稿：按所选角度出 3 个候选并进入编辑区", candidates === 3 && editor.text.startsWith("黄仁勋辞任 CEO") &&
    draftsRequest.includes("辞任 CEO 不等于离开英伟达") && /加权字数 \d+/.test(editor.meter), JSON.stringify({ candidates, editor }));

  await chrome.evaluate(studio, `(() => { const editor = document.getElementById('editor'); editor.value = "中".repeat(150); editor.dispatchEvent(new Event("input")); })()`);
  const fold = await chrome.evaluate(studio, "({ line: Boolean(document.querySelector('#fold-preview .fold-line')), before: document.querySelector('#fold-preview span')?.textContent.length, meter: document.getElementById('meter').textContent })");
  check("编辑区：加权字数与首屏标线", fold.line && fold.before === 140 && fold.meter.includes("加权字数 300"), JSON.stringify(fold));

  await new Promise(resolve => setTimeout(resolve, 800));
  await chrome.evaluate(studio, "location.reload()").catch(() => {});
  const restored = await waitFor(() => chrome.evaluate(studio,
    "document.querySelectorAll('#candidates button').length === 3 && document.querySelectorAll('#angles .angle').length === 3 && document.getElementById('editor').value.length").catch(() => 0),
  10000, "进度未恢复").catch(error => error.message);
  check("重新打开写作台后恢复角度、候选和编辑内容", restored === 150, restored);

  const { targetId: settingsTarget } = await chrome.send("Target.createTarget", { url: `chrome-extension://${id}/ai-settings.html` });
  const settings = await chrome.attach(target => target.targetId === settingsTarget);
  const steps = await waitFor(() => chrome.evaluate(settings, `(() => {
    const angles = document.getElementById("creationProfile-angles"), drafts = document.getElementById("creationProfile-drafts");
    return angles && drafts && angles.options.length === 2 ? { angles: angles.value, drafts: drafts.value, open: document.getElementById("creationSettings").open } : null;
  })()`).catch(() => null), 10000, "AI 设置页未渲染创作模型").catch(error => error.message);
  check("AI 设置页为每个创作步骤提供 API 选择并回显已保存的值", steps?.angles === "mock" && steps.drafts === "" && steps.open === true, JSON.stringify(steps));

  // 发布与复盘：写作台「去 X 发布」→ 草稿待确认并打开预填发帖页；bot feed 带回自己的同文帖子 → 自动标为已发并显示数据。
  await chrome.evaluate(studio, "document.getElementById('publish').click()");
  const intent = await waitFor(async () => (await chrome.send("Target.getTargets")).targetInfos
    .find(target => target.url.startsWith("https://x.com/intent/post?text=")), 10000, "未打开发帖页").catch(error => error.message);
  check("去 X 发布打开预填正文的发帖页", typeof intent === "object" && decodeURIComponent(intent.url).includes("中".repeat(150)), intent?.url || intent);
  if (typeof intent === "object") await chrome.send("Target.closeTarget", { targetId: intent.targetId });
  const pending = await chrome.evaluate(worker, "XReplyMaterialDB.create().drafts().then(list => list.map(draft => draft.status + ':' + draft.text.length))");
  check("发布前保存为待确认草稿", JSON.stringify(pending) === JSON.stringify(["pending:150"]), JSON.stringify(pending));

  await chrome.evaluate(worker, `(async () => {
    const now = Date.now();
    const make = raw => XReplyMaterialModel.normalize(raw, { channelId: "bot-feed", now }).material;
    await XReplyMaterialDB.create().upsertMany([make({ id: "x:7001", kind: "x_post", own: true, url: "https://x.com/me/status/7001",
      text: "中".repeat(150) + " https://t.co/abc", publishedAt: new Date(now + 60000).toISOString(), metrics: { views: 5200, likes: 61 } })]);
    await chrome.storage.local.set({ creationDrafts: [{ id: "old", text: "0.26.0 的旧草稿", title: "旧", revision: 1, updatedAt: now - 86400000, materials: [] }] });
    await creationService().handleInstalled();
  })()`);
  const { targetId: draftsTarget } = await chrome.send("Target.createTarget", { url: `chrome-extension://${id}/creation/drafts.html` });
  const draftsPage = await chrome.attach(target => target.targetId === draftsTarget);
  const draftsView = await waitFor(() => chrome.evaluate(draftsPage, `(() => {
    const cards = [...document.querySelectorAll("#drafts .draft")];
    if (cards.length !== 2) return null;
    return { status: document.getElementById("status").textContent, heads: cards.map(card => card.querySelector(".draft-head").textContent),
      post: cards.map(card => card.querySelector(".draft-post").textContent).join("|"), tiles: document.getElementById("tiles").textContent };
  })()`).catch(() => null), 10000, "草稿页未渲染").catch(error => error.message);
  check("bot feed 带回自己的帖子后自动标为已发并显示数据", draftsView?.status?.includes("自动关联 1 条") &&
    draftsView.post.includes("5200") && draftsView.tiles.startsWith("1已发"), JSON.stringify(draftsView));
  check("0.26.0 旧草稿迁入草稿库", draftsView?.heads?.some(head => head.includes("旧版迁移")) &&
    !(await chrome.evaluate(worker, "chrome.storage.local.get('creationDrafts').then(saved => 'creationDrafts' in saved)")), JSON.stringify(draftsView?.heads));

  // X 页面「改写」「选入」：用 CDP 拦截 x.com 请求返回固定页面，真实内容脚本注入后点击按钮。
  const { targetId: xTarget } = await chrome.send("Target.createTarget", { url: "about:blank" });
  const xPage = await chrome.attach(target => target.targetId === xTarget);
  chrome.on("Fetch.requestPaused", (params, sessionId) => {
    if (sessionId !== xPage) return;
    const html = params.resourceType === "Document" ? X_FIXTURE : "";
    void chrome.send("Fetch.fulfillRequest", { requestId: params.requestId, responseCode: html ? 200 : 404,
      responseHeaders: [{ name: "content-type", value: "text/html; charset=utf-8" }], body: Buffer.from(html).toString("base64") }, xPage);
  });
  await chrome.send("Fetch.enable", { patterns: [{ urlPattern: "https://x.com/*" }] }, xPage);
  await chrome.send("Page.navigate", { url: "https://x.com/home" }, xPage);
  const buttons = await waitFor(() => chrome.evaluate(xPage, "document.querySelectorAll('.xrc-post-actions button').length").catch(() => 0),
    10000, "帖子下方没有出现按钮").catch(error => error.message);
  const inQuote = await chrome.evaluate(xPage, "document.querySelectorAll('div[role=link] .xrc-post-actions').length");
  check("X 帖子操作栏出现「改写」「选入」，引用帖内不加", buttons === 2 && inQuote === 0, `${buttons}/${inQuote}`);
  await chrome.evaluate(xPage, "document.querySelector('.xrc-post-rewrite').click()");
  const picked = await waitFor(() => chrome.evaluate(worker, `(async () => {
    const { creationBasket, creationStudioIntent } = await chrome.storage.local.get(["creationBasket", "creationStudioIntent"]);
    const material = await XReplyMaterialDB.create().get("x:1890000000000000001");
    return material && creationStudioIntent && { basket: creationBasket, intent: creationStudioIntent?.mode, channel: material.channelIds[0], saved: material.marks.saved,
      views: material.metrics?.views, text: material.text };
  })()`).catch(() => null), 10000, "点击后素材未入库").catch(error => error.message);
  check("点「改写」后帖子入库（X 手动选入、已收藏）并带入写作台", picked?.channel === "x-pick" && picked.saved === true && picked.views === 250000 &&
    JSON.stringify(picked.basket) === JSON.stringify(["x:1890000000000000001"]) && picked.intent === "rewrite" && picked.text.startsWith("Agents are"),
    JSON.stringify(picked));
  const toast = await waitFor(() => chrome.evaluate(xPage, "document.querySelector('.xrc-post-toast')?.textContent || ''"), 5000, "没有提示")
    .catch(error => error.message);
  check("点击后页面提示结果", toast.includes("已带入写作台"), toast);
  await chrome.evaluate(worker, "chrome.storage.local.set({ creationPostActions: false })");
  const removed = await waitFor(() => chrome.evaluate(xPage, "document.querySelectorAll('.xrc-post-actions').length === 0"), 5000, "关闭后按钮未移除")
    .catch(error => error.message);
  check("在弹窗关闭后按钮立即移除", removed === true, removed);
} finally {
  await chrome.stop();
  mockModel.server.close();
}
const failed = checks.filter(item => !item.ok).length;
console.log(failed ? `✖ ${failed} 项失败` : `✔ ${checks.length} 项全部通过`);
process.exitCode = failed ? 1 : 0;
