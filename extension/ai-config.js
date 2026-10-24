(() => {
  "use strict";
  const defaults = {
    enabled:false,baseUrl:"",apiKey:"",model:"",
    generatePrompt:"请为下面的 X 帖子写一句自然、简短的中文回复，尽量不超过12个字。语气轻松，不编造经历，不添加帖子没有表达的事实。只返回 <reply>回复内容</reply>。\n\n帖子：\n${post}",
    rewritePrompt:"请把下面的回复草稿改写成一句简短自然的中文。严格保留原意、立场和情绪强度，不增加评价、经历或额外观点。只返回 <reply>改写后的内容</reply>。\n\n帖子：\n${post}\n\n草稿：\n${draft}"
  };
  function endpoint(value) {
    const url = new URL(value);
    const local = ["localhost","127.0.0.1"].includes(url.hostname);
    if (!(url.protocol === "https:" || url.protocol === "http:" && local) || url.username || url.password || url.search || url.hash ||
        /(^|\.)(x\.com|twitter\.com)$/.test(url.hostname)) throw new Error("请输入 HTTPS 模型 Base URL，或本机 HTTP 地址；不能使用 X 地址。");
    url.pathname = url.pathname.replace(/\/+$/,"")+"/chat/completions";
    return url;
  }
  function normalize(raw) {
    const value = { ...defaults };
    for (const key of ["baseUrl","apiKey","model","generatePrompt","rewritePrompt"]) {
      if (typeof raw?.[key] === "string") value[key] = raw[key].trim();
    }
    value.enabled = raw?.enabled === true;
    if (value.baseUrl) endpoint(value.baseUrl);
    if (value.apiKey.length > 4096 || value.model.length > 256 || value.baseUrl.length > 2048 ||
        value.generatePrompt.length > 16000 || value.rewritePrompt.length > 16000) throw new Error("配置内容过长。");
    if (value.enabled && (!value.baseUrl || !value.apiKey || !value.model || !value.generatePrompt || !value.rewritePrompt)) {
      throw new Error("开启前请填写接口、Key、模型及两套 Prompt。");
    }
    return value;
  }
  globalThis.XReplyAIConfig = { defaults,endpoint,normalize,originPattern:url => `${url.protocol}//${url.hostname}/*` };
})();
