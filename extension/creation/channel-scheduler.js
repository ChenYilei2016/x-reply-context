// 渠道调度：决定哪些渠道到期、并发读取、记录状态与失败退避，并定期清理素材库。
// 由后台在 chrome.alarms 触发时调用；工作台的“立即刷新”也走这里。
(() => {
  "use strict";

  const MINUTE = 60 * 1000;
  /** 连续失败的退避时长（分钟），超过后保持最后一档。 */
  const BACKOFF_MINUTES = Object.freeze([15, 30, 60]);
  const CONCURRENCY = 2;
  const PRUNE_INTERVAL = 6 * 60 * MINUTE;
  const SETTINGS_KEY = "creationChannelSettings";
  const PRUNE_KEY = "creationLastPruneAt";
  const LOCK = "xreply-creation-channels";

  const SkipReason = Object.freeze({ DISABLED: "disabled", PERMISSION: "permission", NOT_DUE: "not_due" });

  const isEnabled = (definition, settings) => settings?.[definition.id]?.enabled !== false;

  const isDue = (state, now) => !state?.nextRunAt || now >= state.nextRunAt;

  function backoffMinutes(failures) {
    return BACKOFF_MINUTES[Math.min(failures, BACKOFF_MINUTES.length) - 1];
  }

  function stateAfterSuccess(definition, previous, now, { fetched, inserted, rejected }) {
    return {
      channelId: definition.id, lastRunAt: now, lastSuccessAt: now, lastErrorAt: previous?.lastErrorAt || null,
      error: "", failures: 0, fetched, inserted, rejected,
      nextRunAt: now + definition.intervalMinutes * MINUTE
    };
  }

  function stateAfterFailure(definition, previous, now, error) {
    const failures = (previous?.failures || 0) + 1;
    const wait = Math.max(definition.intervalMinutes, backoffMinutes(failures));
    return {
      ...previous, channelId: definition.id, lastRunAt: now, lastErrorAt: now,
      error: String(error?.message || error).slice(0, 300), failures,
      nextRunAt: now + wait * MINUTE
    };
  }

  /** 以固定并发执行任务，单个任务失败不影响其他任务。 */
  async function runPool(tasks, limit) {
    const results = new Array(tasks.length);
    let next = 0;
    async function worker() {
      while (next < tasks.length) {
        const index = next++;
        results[index] = await tasks[index]();
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
    return results;
  }

  /**
   * @param deps.chrome chrome API（permissions、storage.local）
   * @param deps.db XReplyMaterialDB 实例
   * @param deps.channels XReplyChannels
   * @param deps.model XReplyMaterialModel
   * @param deps.http XReplyChannelHttp
   * @param deps.clock 返回当前毫秒时间
   */
  function create({ chrome, db, channels, model, http, clock = Date.now, locks = globalThis.navigator?.locks }) {
    async function settings() {
      return (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] || {};
    }

    const permitted = definition => chrome.permissions.contains({ origins: definition.origins });

    async function runChannel(definition, previous, channelSettings) {
      const now = clock();
      try {
        const { materials, rejected } = await channels.collect(definition, { http, model, now, settings: channelSettings[definition.id] || {} });
        const { inserted } = await db.upsertMany(materials);
        const state = stateAfterSuccess(definition, previous, now, { fetched: materials.length, inserted, rejected });
        await db.saveChannelState(state);
        return { channelId: definition.id, ok: true, fetched: materials.length, inserted, rejected };
      } catch (error) {
        await db.saveChannelState(stateAfterFailure(definition, previous, now, error));
        return { channelId: definition.id, ok: false, error: String(error?.message || error) };
      }
    }

    async function pruneIfStale() {
      const now = clock();
      const last = (await chrome.storage.local.get(PRUNE_KEY))[PRUNE_KEY] || 0;
      if (now - last < PRUNE_INTERVAL) return 0;
      const removed = await db.prune(now);
      await chrome.storage.local.set({ [PRUNE_KEY]: now });
      return removed;
    }

    /**
     * 运行到期的渠道。
     * @param options.force 忽略到期时间（仍遵守开关与权限）
     * @param options.channelIds 只运行指定渠道
     */
    async function runDue({ force = false, channelIds } = {}) {
      const [channelSettings, states] = await Promise.all([settings(), db.channelStates()]);
      const now = clock();
      const skipped = [];
      const runnable = [];
      for (const definition of channels.list()) {
        if (channelIds && !channelIds.includes(definition.id)) continue;
        if (!isEnabled(definition, channelSettings)) skipped.push({ channelId: definition.id, skipped: SkipReason.DISABLED });
        else if (!force && !isDue(states[definition.id], now)) skipped.push({ channelId: definition.id, skipped: SkipReason.NOT_DUE });
        else if (!await permitted(definition)) skipped.push({ channelId: definition.id, skipped: SkipReason.PERMISSION });
        else runnable.push(definition);
      }
      const results = await runPool(runnable.map(definition => () => runChannel(definition, states[definition.id], channelSettings)), CONCURRENCY);
      const pruned = results.length ? await pruneIfStale() : 0;
      return { results, skipped, pruned };
    }

    /** 同一时间只允许一轮调度；已有一轮在跑时直接返回 busy。 */
    function run(options) {
      if (!locks) return runDue(options);
      return locks.request(LOCK, { ifAvailable: true }, lock => lock ? runDue(options) : { busy: true });
    }

    async function status() {
      const [channelSettings, states, total] = await Promise.all([settings(), db.channelStates(), db.count()]);
      const rows = await Promise.all(channels.list().map(async definition => ({
        id: definition.id, name: definition.name, category: definition.category,
        intervalMinutes: definition.intervalMinutes, origins: definition.origins,
        enabled: isEnabled(definition, channelSettings), permitted: await permitted(definition),
        settings: channelSettings[definition.id] || {}, state: states[definition.id] || null
      })));
      return { channels: rows, total };
    }

    async function saveSettings(channelId, patch) {
      if (!channels.get(channelId)) throw new Error("未知渠道");
      const current = await settings();
      await chrome.storage.local.set({ [SETTINGS_KEY]: { ...current, [channelId]: { ...current[channelId], ...patch } } });
    }

    return { run, status, saveSettings };
  }

  globalThis.XReplyChannelScheduler = Object.freeze({
    create, isDue, isEnabled, backoffMinutes, stateAfterSuccess, stateAfterFailure, runPool, SkipReason, BACKOFF_MINUTES, SETTINGS_KEY
  });
})();
