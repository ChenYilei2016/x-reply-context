// 创作工作台的后台入口：定时调度渠道、处理工作台页面发来的 CREATION_* 消息。
// background.js 负责在顶层注册事件监听，并把 CREATION_* 消息和定时器事件转发到这里。
(() => {
  "use strict";

  const ALARM = "creationChannels";
  const ALARM_PERIOD_MINUTES = 5;

  /** 0.27～0.28 的 X 浏览采集与流速标签已下线；升级时清除其素材、渠道状态和设置。 */
  const RETIRED_X_CHANNEL = "x-observed";
  const RETIRED_X_METRICS_SOURCE = "x_observed";
  const RETIRED_LOCAL_KEYS = Object.freeze(["creationXCaptureEnabled", "creationVelocityBadge"]);
  const RETIRED_SESSION_KEYS = Object.freeze(["creationPendingSaves"]);

  /** 0.26.0 旧版写作面板：草稿迁入草稿库，其余缓存（新闻、标记、偏好）随旧面板一起删除。 */
  const LEGACY_DRAFTS_KEY = "creationDrafts";
  const LEGACY_KEYS = Object.freeze([LEGACY_DRAFTS_KEY, "creationNews", "creationMarks", "creationPreferences"]);

  /** 去掉素材中的 X 浏览采集来源；只来自该渠道的素材删除，其余降为渠道报告的指标。 */
  function withoutRetiredXChannel(material) {
    if (!material.channelIds.includes(RETIRED_X_CHANNEL)) return material;
    const channelIds = material.channelIds.filter(id => id !== RETIRED_X_CHANNEL);
    if (!channelIds.length) return null;
    const downgrade = source => source === RETIRED_X_METRICS_SOURCE ? "channel_reported" : source;
    return {
      ...material, channelIds,
      metricsSource: downgrade(material.metricsSource),
      snapshots: material.snapshots.map(snapshot => ({ ...snapshot, source: downgrade(snapshot.source) }))
    };
  }

  function create(chrome) {
    const db = globalThis.XReplyMaterialDB.create();
    const scheduler = globalThis.XReplyChannelScheduler.create({
      chrome, db,
      channels: globalThis.XReplyChannels,
      model: globalThis.XReplyMaterialModel,
      http: globalThis.XReplyChannelHttp
    });
    const pagePrefix = chrome.runtime.getURL("creation/");

    async function ensureAlarm() {
      if (!await chrome.alarms.get(ALARM)) await chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: ALARM_PERIOD_MINUTES });
    }

    async function retireXCapture() {
      const result = await db.rewrite(withoutRetiredXChannel);
      await db.deleteChannelState(RETIRED_X_CHANNEL);
      await chrome.storage.local.remove([...RETIRED_LOCAL_KEYS]);
      await chrome.storage.session.remove([...RETIRED_SESSION_KEYS]);
      return result;
    }

    /** 旧草稿写入草稿库后再删除旧键；写入失败时旧数据保留，下次更新再试。重复执行不会产生重复草稿（编号固定）。 */
    async function migrateLegacyDrafts(now = Date.now()) {
      const saved = (await chrome.storage.local.get(LEGACY_DRAFTS_KEY))[LEGACY_DRAFTS_KEY];
      const drafts = (Array.isArray(saved) ? saved : []).map(old => globalThis.XReplyDraftRecord.fromLegacy(old, now)).filter(Boolean);
      if (drafts.length) await db.putDrafts(drafts);
      await chrome.storage.local.remove([...LEGACY_KEYS]);
      return drafts.length;
    }

    /** 安装或更新时：建立定时器（Chrome 持久保存，Service Worker 重启后仍在），清理已下线功能的数据，迁移旧草稿。 */
    async function handleInstalled() {
      await ensureAlarm();
      const retired = await retireXCapture();
      const migratedDrafts = await migrateLegacyDrafts();
      return { ...retired, migratedDrafts };
    }

    const runScheduled = () => scheduler.run();

    const fromCreationPage = sender => typeof sender.url === "string" && sender.url.startsWith(pagePrefix);

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
      CREATION_CHANNELS_STATUS: () => scheduler.status(),
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
      const handler = pageHandlers[message.type];
      if (!handler) return { ok: false, error: "不支持的创作操作" };
      if (!fromCreationPage(sender)) return { ok: false, error: "仅创作工作台页面可以执行此操作" };
      const result = await handler(message);
      return { ok: true, ...result };
    }

    return { handle, handleInstalled, ensureAlarm, runScheduled };
  }

  globalThis.XReplyCreationBackground = Object.freeze({ create, ALARM, withoutRetiredXChannel });
})();
