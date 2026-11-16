// 渠道读取用的受限 HTTP：只访问渠道声明的主机，不带 Cookie，限制大小和时长，支持取消。
(() => {
  "use strict";

  const DEFAULT_TIMEOUT = 15000;
  const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
  const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

  /** 只允许 HTTPS；本机地址允许 HTTP（用于本机 feed 服务）。主机必须在白名单内。 */
  function allowedUrl(value, hosts) {
    try {
      const url = new URL(value);
      const secure = url.protocol === "https:" || url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);
      if (!secure || url.username || url.password || !hosts.includes(url.hostname)) return null;
      return url;
    } catch {
      return null;
    }
  }

  async function readLimited(response, maxBytes) {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) throw new Error(`内容超过 ${Math.round(maxBytes / 1024 / 1024)} MB，已停止读取`);
        text += decoder.decode(chunk.value, { stream: true });
      }
      return text + decoder.decode();
    } finally {
      void reader.cancel().catch(() => {});
    }
  }

  /**
   * @param url 目标地址
   * @param options.hosts 允许的主机名（含跳转后的地址）
   * @param options.signal 外部取消信号
   */
  async function fetchText(url, { hosts, signal, timeout = DEFAULT_TIMEOUT, maxBytes = DEFAULT_MAX_BYTES, headers } = {}) {
    if (!allowedUrl(url, hosts)) throw new Error("地址不在渠道允许的范围内");
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeout);
    try {
      if (signal?.aborted) abort();
      const response = await fetch(url, { signal: controller.signal, credentials: "omit", referrerPolicy: "no-referrer", headers });
      if (!allowedUrl(response.url || url, hosts)) throw new Error("来源跳转到了不允许的站点");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await readLimited(response, maxBytes);
    } catch (error) {
      if (controller.signal.aborted) throw new Error(signal?.aborted ? "已取消" : "读取超时");
      if (error instanceof TypeError) throw new Error("无法连接");
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  async function fetchJson(url, options) {
    const text = await fetchText(url, options);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("返回内容不是有效 JSON");
    }
  }

  globalThis.XReplyChannelHttp = Object.freeze({ allowedUrl, fetchText, fetchJson });
})();
