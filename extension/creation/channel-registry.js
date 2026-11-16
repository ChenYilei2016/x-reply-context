// 渠道注册表。每个渠道是一个适配器定义：
// {
//   id, name, category(默认分类 id), intervalMinutes, origins(权限匹配串), hosts(允许读取的主机), maxItems,
//   metricsSource?(MetricsSource id，默认渠道报告),
//   fetchItems({ http, signal, now, settings }) → Promise<feed item[]>   // 条目结构同 xrc.feed/v1 的 item
// }
// 适配器只负责“读取 + 映射成 feed item”，校验、分类与合并统一交给素材模型。
(() => {
  "use strict";

  const definitions = new Map();

  function register(definition) {
    for (const field of ["id", "name", "category", "intervalMinutes", "origins", "hosts", "maxItems", "fetchItems"]) {
      if (definition[field] === undefined) throw new Error(`渠道 ${definition.id || "?"} 缺少 ${field}`);
    }
    if (definitions.has(definition.id)) throw new Error(`渠道 ${definition.id} 重复注册`);
    definitions.set(definition.id, Object.freeze({ ...definition }));
  }

  const list = () => [...definitions.values()];
  const get = id => definitions.get(id);

  /**
   * 读取一个渠道并归一化为素材。
   * @returns {{materials: object[], rejected: number}}
   */
  async function collect(definition, { http, model, signal, now, settings }) {
    const items = await definition.fetchItems({ http, signal, now, settings });
    const context = {
      channelId: definition.id, now,
      defaultCategory: model.MaterialCategory.from(definition.category),
      metricsSource: model.MetricsSource.from(definition.metricsSource || "channel_reported")
    };
    const materials = [];
    let rejected = 0;
    for (const item of items.slice(0, definition.maxItems)) {
      const result = model.normalize(item, context);
      if (result.material) materials.push(result.material);
      else rejected++;
    }
    return { materials, rejected };
  }

  globalThis.XReplyChannels = Object.freeze({ register, list, get, collect });
})();
