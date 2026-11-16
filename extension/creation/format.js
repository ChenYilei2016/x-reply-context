// 创作页面共用的数字与时间格式化（中文单位）。
(() => {
  "use strict";

  const MINUTE = 60 * 1000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  /** 12345 → 1.2万，340000000 → 3.4亿；小于一万原样显示。 */
  function count(value) {
    if (value === null || value === undefined || !Number.isFinite(value)) return "—";
    const abs = Math.abs(value);
    const scaled = (number, unit) => `${number >= 100 ? Math.round(number) : Number(number.toFixed(1))}${unit}`;
    if (abs >= 1e8) return scaled(value / 1e8, "亿");
    if (abs >= 1e4) return scaled(value / 1e4, "万");
    return String(Math.round(value));
  }

  const velocity = value => value === null || value === undefined ? "—" : `${count(value)}/h`;

  /** 爆文倍数：保留一位小数，过大时取整。 */
  function ratio(value) {
    if (value === null || value === undefined || !Number.isFinite(value)) return "—";
    return value >= 100 ? `${Math.round(value)}x` : `${Number(value.toFixed(1))}x`;
  }

  function ago(timestamp, now = Date.now()) {
    if (!timestamp) return "时间未知";
    const elapsed = Math.max(0, now - timestamp);
    if (elapsed < MINUTE) return "刚刚";
    if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} 分钟前`;
    if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} 小时前`;
    return `${Math.floor(elapsed / DAY)} 天前`;
  }

  function time(timestamp) {
    if (!timestamp) return "—";
    return new Date(timestamp).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  globalThis.XReplyFormat = Object.freeze({ count, velocity, ratio, ago, time });
})();
