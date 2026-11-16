// 创作工作台的后台入口：定时调度渠道、处理工作台页面与 X 页面发来的 CREATION_* 消息。
// background.js 负责在顶层注册事件监听，并把 CREATION_* 消息和定时器事件转发到这里。
(() => {
  "use strict";

  const ALARM = "creationChannels";
  const ALARM_PERIOD_MINUTES = 5;

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

    /** 页面消息处理表：消息类型 → 处理函数。 */
    const pageHandlers = {
      CREATION_CHANNELS_STATUS: () => scheduler.status(),
      CREATION_CHANNELS_RUN: message => scheduler.run({
        force: true,
        channelIds: Array.isArray(message.channelIds) ? message.channelIds.filter(id => typeof id === "string").slice(0, 50) : undefined
      }),
      CREATION_CHANNEL_SETTINGS: message => {
        const patch = {};
        if (typeof message.enabled === "boolean") patch.enabled = message.enabled;
        return scheduler.saveSettings(message.channelId, patch).then(() => ({ ok: true }));
      }
    };

    async function handle(message, sender) {
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
