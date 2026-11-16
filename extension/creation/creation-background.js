// 创作工作台的后台入口：定时调度渠道、处理工作台页面与 X 页面发来的 CREATION_* 消息。
// background.js 负责在顶层注册事件监听，并把 CREATION_* 消息和定时器事件转发到这里。
(() => {
  "use strict";

  const ALARM = "creationChannels";
  const ALARM_PERIOD_MINUTES = 5;
  /** X 浏览采集是推送型渠道，不在注册表中，单独记录状态。 */
  const X_CHANNEL = "x-observed";
  const X_CAPTURE_KEY = "creationXCaptureEnabled";
  const X_BATCH_LIMIT = 200;
  const X_ORIGINS = Object.freeze(["https://x.com", "https://twitter.com"]);
  /** 点击流速标签收藏时，帖子可能还在 5 秒批次里未入库；先暂存，入库后补标记。 */
  const PENDING_SAVES_KEY = "creationPendingSaves";
  const PENDING_SAVES_LIMIT = 200;

  function create(chrome) {
    const db = globalThis.XReplyMaterialDB.create();
    const scheduler = globalThis.XReplyChannelScheduler.create({
      chrome, db,
      channels: globalThis.XReplyChannels,
      model: globalThis.XReplyMaterialModel,
      http: globalThis.XReplyChannelHttp
    });
    const pagePrefix = chrome.runtime.getURL("creation/");

    /** 安装、更新或浏览器启动时调用；闹钟由 Chrome 持久保存，Service Worker 重启后仍在。 */
    async function ensureAlarm() {
      if (!await chrome.alarms.get(ALARM)) await chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: ALARM_PERIOD_MINUTES });
    }

    const runScheduled = () => scheduler.run();

    const fromCreationPage = sender => typeof sender.url === "string" && sender.url.startsWith(pagePrefix);
    const fromXTopFrame = sender => sender.frameId === 0 && typeof sender.url === "string" && X_ORIGINS.includes(new URL(sender.url).origin);

    async function xCaptureEnabled() {
      return (await chrome.storage.local.get(X_CAPTURE_KEY))[X_CAPTURE_KEY] !== false;
    }

    /** 入库页面采集的帖子：作者与当前登录账号相同则标记为自己的帖子。 */
    async function ingestXPosts(message) {
      if (!await xCaptureEnabled()) return { stored: 0, disabled: true };
      const model = globalThis.XReplyMaterialModel;
      const account = typeof message.account === "string" ? message.account.toLowerCase() : "";
      const now = Date.now();
      const context = { channelId: X_CHANNEL, now, metricsSource: model.MetricsSource.X_OBSERVED };
      const materials = [];
      for (const post of message.posts.slice(0, X_BATCH_LIMIT)) {
        const { material } = model.normalize(post, context);
        if (!material) continue;
        material.own = Boolean(account) && material.author?.handle.toLowerCase() === account;
        materials.push(material);
      }
      const { inserted } = await db.upsertMany(materials);
      await applyPendingSaves(materials.map(material => material.id));
      const previous = (await db.channelStates())[X_CHANNEL];
      await db.saveChannelState({
        channelId: X_CHANNEL, lastSuccessAt: now, lastRunAt: now, error: "", failures: 0,
        fetched: materials.length, inserted, totalInserted: (previous?.totalInserted || 0) + inserted
      });
      return { stored: materials.length, inserted };
    }

    async function pendingSaves() {
      return (await chrome.storage.session.get(PENDING_SAVES_KEY))[PENDING_SAVES_KEY] || [];
    }

    async function applyPendingSaves(ids) {
      const pending = await pendingSaves();
      const ready = pending.filter(id => ids.includes(id));
      if (!ready.length) return;
      await Promise.all(ready.map(id => db.setMark(id, "saved", true)));
      await chrome.storage.session.set({ [PENDING_SAVES_KEY]: pending.filter(id => !ready.includes(id)) });
    }

    /** 收藏 X 帖子为素材：已入库直接标记，否则暂存到下次入库。 */
    async function saveXPost(message) {
      const id = typeof message.postId === "string" && /^\d{1,25}$/.test(message.postId) ? `x:${message.postId}` : "";
      if (!id) throw new Error("帖子编号无效");
      if (await db.setMark(id, "saved", true)) return { saved: true };
      const pending = (await pendingSaves()).filter(item => item !== id);
      await chrome.storage.session.set({ [PENDING_SAVES_KEY]: [...pending, id].slice(-PENDING_SAVES_LIMIT) });
      return { saved: false, pending: true };
    }

    async function xCaptureStatus() {
      return { enabled: await xCaptureEnabled(), state: (await db.channelStates())[X_CHANNEL] || null };
    }

    /** 只接受开关和（允许配置的渠道的）地址；地址必须落在渠道声明的主机内。 */
    function channelSettingsPatch(message) {
      const patch = {};
      if (typeof message.enabled === "boolean") patch.enabled = message.enabled;
      if (message.url !== undefined) {
        const definition = globalThis.XReplyChannels.get(message.channelId);
        if (!definition?.configurableUrl) throw new Error("该渠道的地址不可修改");
        if (message.url !== "" && !globalThis.XReplyChannelHttp.allowedUrl(message.url, definition.hosts)) {
          throw new Error(`地址只能指向 ${definition.hosts.join(" 或 ")}`);
        }
        patch.url = message.url;
      }
      return patch;
    }

    /** 页面消息处理表：消息类型 → 处理函数。 */
    const pageHandlers = {
      CREATION_CHANNELS_STATUS: async () => ({ ...await scheduler.status(), xCapture: await xCaptureStatus() }),
      CREATION_X_CAPTURE_SETTINGS: async message => {
        if (typeof message.enabled !== "boolean") throw new Error("采集开关无效");
        await chrome.storage.local.set({ [X_CAPTURE_KEY]: message.enabled });
        return {};
      },
      CREATION_CHANNELS_RUN: message => scheduler.run({
        force: true,
        channelIds: Array.isArray(message.channelIds) ? message.channelIds.filter(id => typeof id === "string").slice(0, 50) : undefined
      }),
      CREATION_CHANNEL_SETTINGS: async message => {
        await scheduler.saveSettings(message.channelId, channelSettingsPatch(message));
        return {};
      }
    };

    async function handle(message, sender) {
      if (message.type === "CREATION_INGEST_X") {
        if (!fromXTopFrame(sender) || !Array.isArray(message.posts)) return { ok: false, error: "仅 X 页面可以提交浏览素材" };
        return { ok: true, ...await ingestXPosts(message) };
      }
      if (message.type === "CREATION_SAVE_X_POST") {
        if (!fromXTopFrame(sender)) return { ok: false, error: "仅 X 页面可以收藏帖子" };
        return { ok: true, ...await saveXPost(message) };
      }
      const handler = pageHandlers[message.type];
      if (!handler) return { ok: false, error: "不支持的创作操作" };
      if (!fromCreationPage(sender)) return { ok: false, error: "仅创作工作台页面可以执行此操作" };
      const result = await handler(message);
      return { ok: true, ...result };
    }

    return { handle, ensureAlarm, runScheduled };
  }

  globalThis.XReplyCreationBackground = Object.freeze({ create, ALARM });
})();
