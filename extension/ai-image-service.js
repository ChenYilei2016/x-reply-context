// 后台出图服务：写作台发来出图请求，用 AI 设置中「配图」步骤的 API 配置和出图模型调用 OpenAI 兼容的 /images/generations。
// 与对话请求分开：不流式、返回体更大（base64 图片）、耗时更长；同时最多 2 张，可取消。
(() => {
  "use strict";

  const STUDIO_PAGE = "creation/studio.html";
  const TIMEOUT = 180000;
  /** base64 图片的返回体上限（高清 PNG 约 3～8 MB）。 */
  const RESPONSE_LIMIT = 30 * 1024 * 1024;
  const CONCURRENCY = 2;
  const HTTP_HINTS = Object.freeze({
    401: "API Key 无效或未授权（HTTP 401）。", 403: "出图接口拒绝访问（HTTP 403），请确认 Key 有图像模型权限。",
    404: "出图接口或模型不存在（HTTP 404），请核对 Base URL 和出图模型名。", 429: "出图额度不足或请求过于频繁（HTTP 429）。"
  });

  async function readLimited(response, signal) {
    const declared = Number(response.headers.get("content-length"));
    if (declared > RESPONSE_LIMIT) throw new Error("出图接口返回的数据过大。");
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > RESPONSE_LIMIT) throw new Error("出图接口返回的数据过大。");
        chunks.push(value);
      }
    } finally {
      void reader.cancel().catch(() => {});
    }
    return new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
  }

  /** 接口错误：优先用返回体里的 error.message（例如内容审核拒绝），其次按状态码提示。 */
  function failure(status, text) {
    let detail = "";
    try { detail = JSON.parse(text)?.error?.message || ""; } catch { /* 返回的不是 JSON */ }
    const hint = HTTP_HINTS[status] || `出图失败（HTTP ${status}）。`;
    return new Error(detail ? `${hint}${detail.slice(0, 300)}` : hint);
  }

  function create() {
    const config = globalThis.XReplyAIConfig;
    const imageModel = globalThis.XReplyImageModel;
    const jobs = new Map();
    const studioPage = sender => sender.url === chrome.runtime.getURL(STUDIO_PAGE);
    const owner = sender => `${sender.tab?.id ?? "page"}:${sender.documentId || sender.url}`;

    async function generate(message, sender) {
      if (typeof message.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(message.id)) return { ok: false, error: "出图请求无效。" };
      const key = `${owner(sender)}:${message.id}`;
      if (jobs.has(key)) return { ok: false, error: "重复的出图请求。" };
      if (jobs.size >= CONCURRENCY) return { ok: false, error: "正在出图，请等当前图片完成。" };
      const settings = config.normalizeProfiles((await chrome.storage.local.get("aiConfig")).aiConfig);
      const profile = config.creationProfile(settings, "images");
      if (!profile.baseUrl || !profile.apiKey) return { ok: false, error: "请先在 AI 设置中为「配图」选择填好地址和 Key 的 API 配置。" };
      const url = config.imagesEndpoint(profile.baseUrl);
      if (!await chrome.permissions.contains({ origins: [config.originPattern(url)] })) return { ok: false, error: "模型域名尚未授权。", origin: config.originPattern(url) };
      let body;
      try { body = imageModel.generationBody(message.input, { model: settings.imageModel, quality: settings.imageQuality }); }
      catch (error) { return { ok: false, error: error.message }; }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new DOMException("timeout", "TimeoutError")), TIMEOUT);
      jobs.set(key, controller);
      try {
        let response;
        try {
          response = await fetch(url.href, {
            method: "POST", redirect: "error", credentials: "omit", signal: controller.signal,
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${profile.apiKey}` }, body: JSON.stringify(body)
          });
        } catch (error) {
          if (controller.signal.aborted) throw error;
          throw new Error("无法连接出图接口，请检查网络、代理和 Base URL。");
        }
        const text = await readLimited(response, controller.signal);
        if (!response.ok) throw failure(response.status, text);
        let data;
        try { data = JSON.parse(text); } catch { throw new Error("出图接口返回的不是 JSON，请核对 Base URL（通常以 /v1 结尾）。"); }
        return { ok: true, image: imageModel.imageFromResponse(data), model: body.model, size: body.size };
      } catch (error) {
        if (controller.signal.aborted) {
          return controller.signal.reason?.name === "TimeoutError" ? { ok: false, error: "出图超时（3 分钟），请稍后重试或降低质量。" } : { ok: false, cancelled: true };
        }
        return { ok: false, error: error.message };
      } finally {
        clearTimeout(timer);
        jobs.delete(key);
      }
    }

    async function handle(message, sender) {
      if (!studioPage(sender)) return { ok: false, error: "仅写作台可以出图。" };
      if (message.type === "AI_IMAGE_GENERATE") return generate(message, sender);
      if (message.type === "AI_IMAGE_CANCEL") {
        for (const id of Array.isArray(message.ids) ? message.ids.slice(0, 8) : []) jobs.get(`${owner(sender)}:${id}`)?.abort();
        return { ok: true };
      }
      return { ok: false, error: "不支持的出图操作。" };
    }

    return { handle };
  }

  globalThis.XReplyAIImageService = Object.freeze({ create });
})();
