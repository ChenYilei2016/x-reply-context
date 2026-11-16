// 渠道注册表。每个渠道是一个声明式适配器：
// {
//   id, name,
//   category          默认分类 id（条目未声明分类且关键词识别不出时使用）
//   intervalMinutes   拉取周期
//   origins           需要的主机权限匹配串
//   hosts             允许读取的主机名（含跳转）
//   maxItems          单次最多入库条数
//   url               地址，或 (渠道设置) => 地址
//   format            "text" | "json"
//   parse(body, {now}) → feed item[]   条目结构同 xrc.feed/v1 的 item
//   maxBytes?         响应大小上限
//   metricsSource?    指标来源 id，默认 channel_reported
// }
// 读取由注册表统一走受限 HTTP；校验、分类与合并统一交给素材模型。适配器只负责“解析 + 映射”。
(() => {
  "use strict";

  const REQUIRED = Object.freeze(["id", "name", "category", "intervalMinutes", "origins", "hosts", "maxItems", "url", "format", "parse"]);
  const definitions = new Map();

  function register(definition) {
    for (const field of REQUIRED) {
      if (definition[field] === undefined) throw new Error(`渠道 ${definition.id || "?"} 缺少 ${field}`);
    }
    if (!["text", "json"].includes(definition.format)) throw new Error(`渠道 ${definition.id} 的 format 无效`);
    if (definitions.has(definition.id)) throw new Error(`渠道 ${definition.id} 重复注册`);
    definitions.set(definition.id, Object.freeze({ ...definition }));
  }

  const list = () => [...definitions.values()];
  const get = id => definitions.get(id);
  const resolveUrl = (definition, settings) => typeof definition.url === "function" ? definition.url(settings) : definition.url;

  /**
   * 读取一个渠道并归一化为素材。
   * @returns {{materials: object[], rejected: number}}
   */
  async function collect(definition, { http, model, signal, now, settings = {} }) {
    const options = { hosts: definition.hosts, signal, maxBytes: definition.maxBytes };
    const url = resolveUrl(definition, settings);
    const body = definition.format === "json" ? await http.fetchJson(url, options) : await http.fetchText(url, options);
    const items = definition.parse(body, { now });
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

  globalThis.XReplyChannels = Object.freeze({ register, list, get, collect, resolveUrl });
})();
