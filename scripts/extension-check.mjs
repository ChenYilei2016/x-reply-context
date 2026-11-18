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

const PNG_PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==";

/** 模拟 Chat Completions 与 Images 接口：按系统提示词判断是找角度还是成稿，返回固定 JSON；记录收到的请求。 */
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
  const style = { positioning: "AI 效率博主", topics: ["AI 工具"], hooks: [{ pattern: "先抛反常识结论", example: "模型越强，提示词越该写短" }],
    structure: "结论 → 理由 → 行动建议", tone: "口语短句", avoid: ["堆砌术语"] };
  const server = http.createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
    if (request.method === "OPTIONS") { response.end(); return; }
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push(parsed);
      if (request.url.endsWith("/images/generations")) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ data: [{ b64_json: PNG_PIXEL }], output_format: "png", size: parsed.size }));
        return;
      }
      const system = parsed.messages[0].content;
      const plain = system.includes("出图提示词") ? "深夜机房里一台发光的服务器，画面中不要出现文字" :
        system.includes("修改 <post>") ? "OpenAI 降价一半，小团队终于用得起 Agent 了。" : null;
      const result = system.includes("写作角度") ? angles : system.includes("拆解 <posts>") ? style : drafts;
      const content = plain ? `<reply>${plain}</reply>` : `<reply>${JSON.stringify(result)}</reply>`;
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

/** 文章链接固定内容（写作台粘贴链接时由 CDP 返回）。 */
const ARTICLE_FIXTURE = `<!doctype html><html><head><meta property="og:title" content="某公司开源新模型，价格只有一半"></head><body>
<nav>导航</nav><article><p>某公司今天开源了新一代大模型，推理成本只有同类闭源模型的一半。</p>
<p>开发者可以直接下载权重，在自己的服务器上部署，许可证允许商用。</p></article><footer>版权所有</footer></body></html>`;

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
    "document.querySelectorAll('#source-chips .chip.basket').length === 1 && document.querySelector('.model[data-step=angles]').textContent").catch(() => ""),
  10000, "写作台未读到选材").catch(error => error.message);
  check("写作台把已选素材列为来源，并显示各步骤模型", studioReady === "模拟模型 · mock-model", studioReady);

  await chrome.evaluate(studio, "document.querySelector('#compose-modes [data-mode=angle]').click(); document.getElementById('find-angles').click()");
  const angleCards = await waitFor(() => chrome.evaluate(studio, "document.querySelectorAll('#angles .angle').length"), 15000, "角度未渲染")
    .catch(error => error.message);
  const firstAngle = await chrome.evaluate(studio, "(() => { const a = document.querySelector('#angles .angle'); return a ? { badges: a.querySelector('.angle-badges').textContent, potential: a.querySelector('.angle-potential').textContent, meta: a.querySelector('.angle-meta').textContent } : null; })()");
  check("找角度：3 个角度，对照参考帖标出已有人写与真实潜力", angleCards === 3 && firstAngle?.badges.includes("已有人写") &&
    firstAngle.potential.includes("24万") && !firstAngle.meta.includes("M5"), JSON.stringify({ angleCards, firstAngle }));
  const references = await chrome.evaluate(studio, "document.getElementById('references-summary').textContent");
  check("找角度时用素材库里同话题的 X 帖作参考", references.startsWith("同话题 X 帖 1 条"), references);

  await chrome.evaluate(studio, "document.querySelector('#angles .angle .use').click(); document.getElementById('write').click()");
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
    return angles && drafts && angles.options.length === 2 ? { angles: angles.value, drafts: drafts.value, reply: document.getElementById("replyProfile").value,
      models: ["reply", "polish", "angles", "drafts", "styles", "images"].every(id => document.getElementById("model-" + id)),
      imagePlaceholder: document.getElementById("model-images").placeholder } : null;
  })()`).catch(() => null), 10000, "AI 设置页未渲染创作模型").catch(error => error.message);
  check("AI 设置页分为连接、回复、创作台，每个功能可选连接和模型并回显已保存的值", steps?.angles === "mock" && steps.drafts === "" &&
    steps.reply === "mock" && steps.models && steps.imagePlaceholder === "默认：gpt-image-2", JSON.stringify(steps));
  await chrome.evaluate(settings, `(() => {
    chrome.permissions.request = async () => true; // 检查进程内：无头模式无法确认域名授权弹窗
    const model = document.getElementById("model-angles");
    model.value = "deep-reasoner"; model.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("save").click();
  })()`);
  const savedModels = await waitFor(() => chrome.evaluate(worker, "chrome.storage.local.get('aiConfig').then(saved => saved.aiConfig?.models?.angles || '')"), 5000, "模型未保存")
    .catch(error => error.message);
  const angleStatus = await chrome.evaluate(studio, "chrome.runtime.sendMessage({ type: 'AI_STUDIO_STATUS' }).then(status => status.steps.find(step => step.id === 'angles').model)");
  check("找角度单独填模型并保存后，同一连接按该模型请求", savedModels === "deep-reasoner" && angleStatus === "deep-reasoner", `${savedModels}/${angleStatus}`);
  await chrome.evaluate(worker, `chrome.storage.local.get("aiConfig").then(({ aiConfig }) => chrome.storage.local.set({ aiConfig: { ...aiConfig, models: { ...aiConfig.models, angles: "" } } }))`);

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
    const { creationBasket } = await chrome.storage.local.get("creationBasket");
    const material = await XReplyMaterialDB.create().get("x:1890000000000000001");
    // 改写意图由写作台读取后即删除，这里以已选素材换成这一条作为完成标志；写作台切换模式在后面单独检查。
    return material && creationBasket?.[0] === material.id && { basket: creationBasket, channel: material.channelIds[0], saved: material.marks.saved,
      views: material.metrics?.views, text: material.text };
  })()`).catch(() => null), 10000, "点击后素材未入库").catch(error => error.message);
  check("点「改写」后帖子入库（X 手动选入、已收藏）并带入写作台", picked?.channel === "x-pick" && picked.saved === true && picked.views === 250000 &&
    JSON.stringify(picked.basket) === JSON.stringify(["x:1890000000000000001"]) && picked.text.startsWith("Agents are"),
    JSON.stringify(picked));
  const toast = await waitFor(() => chrome.evaluate(xPage, "document.querySelector('.xrc-post-toast')?.textContent || ''"), 5000, "没有提示")
    .catch(error => error.message);
  check("点击后页面提示结果", toast.includes("已带入写作台"), toast);
  await chrome.evaluate(worker, "chrome.storage.local.set({ creationPostActions: false })");
  const removed = await waitFor(() => chrome.evaluate(xPage, "document.querySelectorAll('.xrc-post-actions').length === 0"), 5000, "关闭后按钮未移除")
    .catch(error => error.message);
  check("在弹窗关闭后按钮立即移除", removed === true, removed);

  // 写作台改写模式：从 X 点「改写」后自动切到改写；英文原文提示本地化；生成后保存的草稿记录改写风格。
  const rewriteMode = await waitFor(() => chrome.evaluate(studio, `(() => {
    const selected = document.querySelector("#compose-modes [aria-selected=true]")?.dataset.mode;
    const materials = document.querySelectorAll("#source-chips .chip.basket").length;
    return selected === "rewrite" && materials === 1 && { hint: document.getElementById("source-summary").textContent,
      styleVisible: !document.getElementById("rewrite-style").closest("[data-mode-only]").hidden, status: document.getElementById("status").textContent };
  })()`).catch(() => null), 10000, "写作台没有切到改写模式").catch(error => error.message);
  check("从 X 点「改写」后写作台切到改写模式，英文原文提示本地化", rewriteMode?.styleVisible && rewriteMode.hint.includes("本地化") &&
    rewriteMode.status.includes("已带入 X 帖子"), JSON.stringify(rewriteMode));
  await chrome.evaluate(studio, `(() => {
    window.confirm = () => true; // 检查进程内替换确认框，页面原有候选会被替换
    document.querySelector("#rewrite-style [data-value=hook]").click();
    document.getElementById("write").click();
  })()`);
  const rewritten = await waitFor(() => chrome.evaluate(studio, `(() => {
    const tabs = document.querySelectorAll("#candidates button");
    return tabs.length === 3 && document.getElementById("editor").value.startsWith("黄仁勋") &&
      { originalityHidden: document.getElementById("originality").hidden };
  })()`).catch(() => null), 15000, "改写候选未出现").catch(error => error.message);
  const rewriteRequest = mockModel.requests.at(-1)?.messages[0].content || "";
  check("改写出 3 个候选：提示词含风格、原创约束与本地化，跨语言不算重合度", rewritten?.originalityHidden === true &&
    rewriteRequest.includes("风格「钩子开头」") && rewriteRequest.includes("不是同义改写") && rewriteRequest.includes("地道的中文"),
    JSON.stringify(rewritten));
  await chrome.evaluate(studio, "document.getElementById('save-draft').click()");
  const rewriteDraft = await waitFor(() => chrome.evaluate(worker,
    "XReplyMaterialDB.create().drafts().then(list => list.find(draft => draft.rewrite)?.rewrite?.style || '')"), 5000, "改写草稿未保存")
    .catch(error => error.message);
  check("保存的改写草稿记录改写风格（复盘按“改写 · 风格”分组）", rewriteDraft === "hook", rewriteDraft);

  // 对标风格：素材库里同一博主的 3 条帖子 → 拆解成模板（示例原句可在帖子中找到）→ 写作台套用。
  await chrome.evaluate(worker, `(async () => {
    const now = Date.now();
    const texts = ["AI 不会取代你，但会用 AI 的人会。", "别再收藏提示词了，真正拉开差距的是工作流。", "一个反常识：模型越强，提示词越该写短。"];
    await XReplyMaterialDB.create().upsertMany(texts.map((text, index) => XReplyMaterialModel.normalize({ id: "x:880" + index, kind: "x_post",
      url: "https://x.com/bob/status/880" + index, text, author: { handle: "bob", name: "鲍勃" }, metrics: { views: 1000 * (index + 1) } },
      { channelId: "x-pick", now }).material));
  })()`);
  const { targetId: stylesTarget } = await chrome.send("Target.createTarget", { url: `chrome-extension://${id}/creation/styles.html` });
  const stylesPage = await chrome.attach(target => target.targetId === stylesTarget);
  const author = await waitFor(() => chrome.evaluate(stylesPage,
    "document.getElementById('author').value === 'bob' && document.querySelectorAll('#posts input:checked').length >= 3 && !document.getElementById('distill').disabled")
    .catch(() => false), 10000, "对标风格页没有列出博主").catch(error => error.message);
  check("对标风格页按博主列出素材库里的帖子并默认勾选", author === true, author);
  await chrome.evaluate(stylesPage, "document.getElementById('distill').click()");
  const template = await waitFor(() => chrome.evaluate(stylesPage, `(() => {
    const card = document.querySelector("#templates .template");
    return card && { name: card.querySelector(".template-name").textContent, open: card.querySelector("details").open,
      hooks: card.querySelector(".field-hooks").value, examples: card.querySelector(".examples").textContent };
  })()`).catch(() => null), 15000, "模板未生成").catch(error => error.message);
  check("拆解出风格模板，示例原句来自所选帖子", template?.name === "@bob 的风格" && template.open && template.hooks === "先抛反常识结论" &&
    template.examples.includes("模型越强"), JSON.stringify(template));
  const benchmarkOption = await waitFor(() => chrome.evaluate(studio,
    "[...document.getElementById('benchmark').options].find(option => option.textContent.includes('@bob 的风格'))?.value || ''"), 5000, "写作台没有出现模板")
    .catch(error => error.message);
  await chrome.evaluate(studio, `(() => {
    const select = document.getElementById("benchmark");
    select.value = ${JSON.stringify(benchmarkOption)}; select.dispatchEvent(new Event("change"));
    document.getElementById("write").click();
  })()`);
  await waitFor(() => mockModel.requests.at(-1)?.messages[0].content.includes("参考对标风格") || null, 15000, "套用模板的请求未发出").catch(() => {});
  const benchmarkRequest = mockModel.requests.at(-1)?.messages[0].content || "";
  check("写作台选用风格模板后，提示词带上写法规则但不带示例原句", benchmarkRequest.includes("参考对标风格「@bob 的风格」") &&
    benchmarkRequest.includes("开头手法：先抛反常识结论") && !benchmarkRequest.includes("模型越强"), benchmarkRequest.slice(0, 120));

  // AI 配图：成稿模型写出图提示词 → 出图接口（配图步骤的 API、出图模型、按比例的尺寸）→ 页面显示图片。
  await waitFor(() => chrome.evaluate(studio, "!document.getElementById('image-generate').disabled").catch(() => false), 15000, "生图按钮不可用").catch(() => {});
  await chrome.evaluate(studio, `(() => {
    const style = document.getElementById("image-style");
    style.value = "news"; style.dispatchEvent(new Event("change"));
    const prompt = document.getElementById("image-prompt");
    prompt.value = "已有的手写提示"; prompt.dispatchEvent(new Event("input"));
    document.getElementById("image-compose").click();
  })()`);
  const shown = await waitFor(() => chrome.evaluate(studio,
    "!document.getElementById('image-result').hidden && document.getElementById('image-preview').naturalWidth === 1 && document.getElementById('image-meta').textContent"),
  15000, "图片未显示").catch(error => error.message);
  const imageRequest = mockModel.requests.at(-1);
  const promptRequest = mockModel.requests.at(-2)?.messages?.[0].content || "";
  const imagePrompt = await chrome.evaluate(studio, "document.getElementById('image-prompt').value");
  check("一键生图：先按正文写出图提示词（可修改）再出图", imagePrompt.includes("发光的服务器") && promptRequest.includes("新闻快讯"), imagePrompt);
  check("出图：发往 /images/generations，带出图模型、16:9 精确尺寸和风格，页面显示图片", shown === "1536x864 · gpt-image-2" &&
    imageRequest.model === "gpt-image-2" && imageRequest.size === "1536x864" && imageRequest.prompt.includes("【渲染风格】新闻快讯"), JSON.stringify({ shown, size: imageRequest.size }));

  // 换了候选：自动写的出图提示词和图片标为基于之前的正文，再点生图时先按当前正文重写提示词。
  await chrome.evaluate(studio, "document.querySelectorAll('#candidates button')[1].click()");
  const staleImage = await chrome.evaluate(studio, `({ summary: document.getElementById("image-prompt-summary").textContent,
    meta: document.getElementById("image-meta").textContent, text: document.getElementById("editor").value })`);
  const requestsBefore = mockModel.requests.length;
  await chrome.evaluate(studio, "document.getElementById('image-generate').click()");
  await waitFor(() => mockModel.requests.length >= requestsBefore + 2 || null, 15000, "未重写提示词并出图").catch(() => {});
  await waitFor(() => chrome.evaluate(studio, "!document.getElementById('image-generate').disabled"), 15000, "出图未结束").catch(() => {});
  const rewrittenPrompt = mockModel.requests[requestsBefore]?.messages?.[1]?.content || "";
  const freshImage = await chrome.evaluate(studio, `({ summary: document.getElementById("image-prompt-summary").textContent, meta: document.getElementById("image-meta").textContent })`);
  check("换候选后出图提示词和图片标为基于之前的正文，生图时先按当前正文重写提示词", staleImage.summary.includes("基于之前的正文") &&
    staleImage.meta.includes("基于之前的正文") && rewrittenPrompt.includes(staleImage.text) && freshImage.summary.includes("按当前正文") &&
    !freshImage.meta.includes("基于之前的正文"), JSON.stringify({ staleImage, freshImage }));
  // 左边的内容改了：候选上方提示基于之前的内容，可一键按新内容重新生成。
  await chrome.evaluate(studio, `(() => { const source = document.getElementById("source-text"); source.value += "\\n补充一句"; source.dispatchEvent(new Event("input")); })()`);
  const staleCandidates = await chrome.evaluate(studio, "!document.getElementById('candidates-stale').hidden");
  check("左边内容变化后提示候选基于之前的内容", staleCandidates === true, staleCandidates);

  // 直接粘贴：不选素材，粘贴正文和一个文章链接 → 读取链接正文 → 改写；写作要求可修改并生效。
  chrome.on("Fetch.requestPaused", (params, sessionId) => {
    if (sessionId !== studio) return;
    void chrome.send("Fetch.fulfillRequest", { requestId: params.requestId, responseCode: 200, body: Buffer.from(ARTICLE_FIXTURE).toString("base64"),
      responseHeaders: [{ name: "content-type", value: "text/html; charset=utf-8" }, { name: "access-control-allow-origin", value: "*" }] }, studio);
  });
  await chrome.send("Fetch.enable", { patterns: [{ urlPattern: "https://news.example/*" }] }, studio);
  await chrome.evaluate(worker, "chrome.storage.local.set({ creationBasket: [] })");
  await chrome.evaluate(studio, `(async () => {
    chrome.permissions.contains = async () => true; // 检查进程内：无头模式无法确认“读取网页”授权弹窗
    const guide = document.getElementById("guide-task");
    guide.value = "rewrite"; guide.dispatchEvent(new Event("change"));
    const text = document.getElementById("guide-text");
    text.value = "每句话都要短，像发朋友圈。"; text.dispatchEvent(new Event("input"));
    await new Promise(resolve => setTimeout(resolve, 900));
    const source = document.getElementById("source-text");
    source.value = "我自己的一段看法：开源模型的价格战才刚开始。\\nhttps://news.example/a";
    source.dispatchEvent(new Event("input"));
    document.getElementById("write").click();
  })()`);
  await waitFor(() => mockModel.requests.at(-1)?.messages?.[1]?.content.includes("开源模型的价格战才刚开始") || null, 20000, "粘贴内容的请求未发出").catch(() => {});
  const pasted = await waitFor(() => chrome.evaluate(studio, `(() => {
    const chips = [...document.querySelectorAll("#source-chips .chip")].map(chip => chip.textContent);
    return !document.getElementById("write").disabled && { chips };
  })()`).catch(() => null), 15000, "粘贴内容未生成").catch(error => error.message);
  const pastedRequest = mockModel.requests.at(-1)?.messages || [];
  check("不选素材：粘贴正文和文章链接直接改写，链接正文被读取，未知字段不写进提示词", pasted?.chips?.length === 1 && pasted.chips[0].includes("已读取") &&
    pastedRequest[1]?.content.includes('<material id="M1" coverage=') && !pastedRequest[1].content.includes("未知") && pastedRequest[1].content.includes("某公司开源新模型，价格只有一半") &&
    pastedRequest[1].content.includes("https://news.example/a"), JSON.stringify({ pasted, content: pastedRequest[1]?.content.slice(0, 200) }));
  check("写作设置里修改的写作要求进入提示词，固定规则保留", pastedRequest[0]?.content.includes("<writing_guide>\n每句话都要短，像发朋友圈。") &&
    pastedRequest[0].content.includes("只写 <materials> 里有的事实") && pastedRequest[0].content.includes("读者看不到你收到的资料"), (pastedRequest[0]?.content || "").slice(0, 160));

  // 勾选“粘贴的正文是我自己写的”：粘贴内容带 origin="mine"，模型按我的经历和态度写。
  const beforeMine = mockModel.requests.length;
  await chrome.evaluate(studio, `(() => {
    const mine = document.getElementById("source-mine");
    mine.checked = true; mine.dispatchEvent(new Event("change"));
    document.getElementById("write").click();
  })()`);
  await waitFor(() => mockModel.requests.length > beforeMine || null, 15000, "勾选后的请求未发出").catch(() => {});
  await waitFor(() => chrome.evaluate(studio, "!document.getElementById('write').disabled"), 15000, "生成未结束").catch(() => {});
  const mineRequest = mockModel.requests.at(-1)?.messages || [];
  check("勾选“粘贴的正文是我自己写的”后，粘贴内容带 origin=\"mine\"，规则说明其中的“我”就是我", mineRequest[1]?.content.includes('origin="mine"') &&
    !pastedRequest[1]?.content.includes("origin=") && mineRequest[0]?.content.includes("其中的“我”就是我"), (mineRequest[1]?.content || "").slice(0, 160));

  // 正文自查与精修：正文里提到“素材”、用了 AI 套话 → 列出问题 → 「修掉问题」把自查结果交给成稿模型 → 结果替换正文，可撤销。
  await chrome.evaluate(studio, `(() => {
    const editor = document.getElementById("editor");
    editor.value = "素材称 OpenAI 降价了。值得注意的是，这是信号。"; editor.dispatchEvent(new Event("input"));
  })()`);
  const lint = await chrome.evaluate(studio, `(() => {
    const fix = document.querySelector("#revise-actions .fix");
    return { items: [...document.querySelectorAll("#lint li")].map(item => item.textContent), fix: fix?.textContent, hidden: fix?.hidden,
      badge: document.querySelector("#candidates [aria-selected=true] .badge.warn")?.textContent };
  })()`);
  check("正文自查列出提到资料与 AI 套话，候选卡片和精修按钮同步提示", lint.items.length === 2 && lint.fix === "修掉 2 处问题" && !lint.hidden &&
    lint.badge === "2 处待改", JSON.stringify(lint));
  await chrome.evaluate(studio, "document.querySelector('#revise-actions .fix').click()");
  const revised = await waitFor(() => chrome.evaluate(studio, `(() => document.getElementById("editor").value.startsWith("OpenAI 降价一半") &&
    { lintHidden: document.getElementById("lint").hidden, undo: !document.getElementById("revise-undo").hidden })()`).catch(() => null), 15000, "精修结果未出现")
    .catch(error => error.message);
  const reviseRequest = mockModel.requests.at(-1)?.messages || [];
  check("「修掉问题」把自查结果发给成稿模型，结果替换正文且可撤销", revised?.lintHidden === true && revised.undo &&
    reviseRequest[0]?.content.includes("修掉 <issues> 里列出的问题") && reviseRequest[1]?.content.includes("提到了资料本身"), JSON.stringify(revised));
  await chrome.evaluate(studio, "document.getElementById('revise-undo').click()");
  const undone = await chrome.evaluate(studio, "document.getElementById('editor').value");
  check("撤销精修恢复修改前的正文", undone.startsWith("素材称"), undone);
} finally {
  await chrome.stop();
  mockModel.server.close();
}
const failed = checks.filter(item => !item.ok).length;
console.log(failed ? `✖ ${failed} 项失败` : `✔ ${checks.length} 项全部通过`);
process.exitCode = failed ? 1 : 0;
