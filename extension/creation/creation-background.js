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

  /** X 页面「改写」「选入」写入的素材渠道，以及与写作台共用的存储键。 */
  const PICK_CHANNEL = "x-pick";
  const PICK_ACTIONS = Object.freeze(["rewrite", "pick"]);
  const BASKET_KEY = "creationBasket";
  const BASKET_LIMIT = 3;
  const STUDIO_INTENT_KEY = "creationStudioIntent";
  const STUDIO_PAGE = "creation/studio.html";
  const X_PAGE = /^https:\/\/(?:x|twitter)\.com\//;

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
    /** 本扩展注入 X 页面的内容脚本（顶层框架）。 */
    const fromXPage = sender => sender.id === chrome.runtime.id && Boolean(sender.tab) && !sender.frameId && X_PAGE.test(sender.url || "");

    /** 切换到已打开的写作台标签页，没有时在当前标签页右侧新开。 */
    async function openStudio(sender) {
      const url = chrome.runtime.getURL(STUDIO_PAGE);
      const [existing] = chrome.runtime.getContexts ? await chrome.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [url] }) : [];
      if (existing?.tabId >= 0) {
        const tab = await chrome.tabs.update(existing.tabId, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        return;
      }
      await chrome.tabs.create({ url, index: sender.tab.index + 1, openerTabId: sender.tab.id });
    }

    /**
     * 用户在 X 上点「改写」或「选入」：帖子写入素材库并收藏（不会被低浏览规则清理）。
     * 改写：已选素材换成这一条，写作台切到改写模式并打开；选入：加入已选素材（最多 3 条）。
     */
    async function pickPost(message, sender) {
      if (!PICK_ACTIONS.includes(message.action)) throw new Error("未知操作");
      const { material, error } = globalThis.XReplyMaterialModel.normalize(message.post, { channelId: PICK_CHANNEL, now: Date.now() });
      if (!material || material.kind !== "x_post" || !/^x:\d{1,25}$/.test(material.id)) throw new Error(error || "帖子内容无效");
      await db.upsertMany([material]);
      await db.setMark(material.id, "saved", true);
      const saved = (await chrome.storage.local.get(BASKET_KEY))[BASKET_KEY];
      const basket = Array.isArray(saved) ? saved.filter(id => typeof id === "string").slice(0, BASKET_LIMIT) : [];
      const alreadyPicked = basket.includes(material.id);
      if (message.action === "rewrite") {
        await chrome.storage.local.set({ [BASKET_KEY]: [material.id], [STUDIO_INTENT_KEY]: { mode: "rewrite", materialId: material.id, at: Date.now() } });
        await openStudio(sender);
        return { basketCount: 1, alreadyPicked };
      }
      if (alreadyPicked) return { basketCount: basket.length, alreadyPicked };
      if (basket.length >= BASKET_LIMIT) throw new Error(`已选满 ${BASKET_LIMIT} 条，请先在写作台移出一条。`);
      await chrome.storage.local.set({ [BASKET_KEY]: [...basket, material.id] });
      return { basketCount: basket.length + 1, alreadyPicked };
    }

    /** X 页面内容脚本发来的消息处理表。 */
    const xPageHandlers = { CREATION_PICK_POST: pickPost };

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
      CREATION_CHANNELS_STATUS: async () => ({ ...await scheduler.status(), manualChannels: globalThis.XReplyChannels.MANUAL }),
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
      if (Object.hasOwn(xPageHandlers, message.type)) {
        if (!fromXPage(sender)) return { ok: false, error: "仅 X 页面可以执行此操作" };
        return { ok: true, ...await xPageHandlers[message.type](message, sender) };
      }
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
