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
      const previous = (await db.channelStates())[X_CHANNEL];
      await db.saveChannelState({
        channelId: X_CHANNEL, lastSuccessAt: now, lastRunAt: now, error: "", failures: 0,
        fetched: materials.length, inserted, totalInserted: (previous?.totalInserted || 0) + inserted
      });
      return { stored: materials.length, inserted };
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
