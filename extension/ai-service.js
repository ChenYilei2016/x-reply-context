(() => {
  "use strict";
  const LIMIT = 1024*1024;
  const TIMEOUT = 25000;
  function output(text) {
    const match = text.match(/<reply>([\s\S]*?)<\/reply>/i);
    const clean = (match ? match[1] : text.replace(/<\/?[a-z][a-z0-9-]*>/gi,"")).trim().replace(/。+$/,"");
    if (!clean || clean.length > 12000) throw new Error("模型返回为空或过长，请调整 Prompt。");
    return clean;
  }
  async function readResponse(response,signal) {
    if (!response.ok) throw new Error(({401:"Key 无效或未授权。",403:"模型接口拒绝访问。",429:"模型额度不足或请求过于频繁。"})[response.status] || `模型请求失败（HTTP ${response.status}），请检查接口和模型。`);
    if (!response.body) throw new Error("模型接口没有返回内容。");
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let bytes = 0, buffer = "", text = "", finished = false;
    const sse = /text\/event-stream/i.test(response.headers.get("content-type") || "");
    function line(value) {
      if (!value.startsWith("data:")) return;
      const data = value.slice(5).trim();
      if (data === "[DONE]") return true;
      if (!data) return;
      const parsed = JSON.parse(data);
      if (parsed.error) throw new Error("模型接口返回错误，请检查配置或额度。");
      const delta = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content;
      if (typeof delta === "string") text += delta;
    }
    try {
      for (;;) {
        if (signal.aborted) throw new DOMException("Cancelled","AbortError");
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > LIMIT) throw new Error("模型响应过大，已停止读取。");
        buffer += decoder.decode(chunk.value,{stream:true});
        if (sse) {
          const lines = buffer.split(/\r?\n/); buffer = lines.pop();
          for (const item of lines) if (line(item.trim())) {finished=true;break;}
          if (finished) break;
        }
      }
      buffer += decoder.decode();
      if (sse) {if (!finished) line(buffer.trim());}
      else {
        const data = JSON.parse(buffer);
        if (data.error) throw new Error("模型接口返回错误，请检查配置或额度。");
        text = data.choices?.[0]?.message?.content;
      }
      if (typeof text !== "string") throw new Error("模型响应格式不兼容。");
      return output(text);
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  function create() {
    const config = globalThis.XReplyAIConfig;
    let cached, active = 0;
    const waiting = [], jobs = new Map();
    const owner = sender => `${sender.tab?.id ?? "settings"}:${sender.frameId || 0}:${sender.documentId || sender.url}`;
    const settingsPage = sender => sender.url === chrome.runtime.getURL("ai-settings.html");
    const load = () => cached ||= chrome.storage.local.get("aiConfig").then(saved => config.normalize(saved.aiConfig)).catch(error => {cached=undefined;throw error;});
    function cancel(job) {
      job.cancelled = true; clearTimeout(job.timer); job.controller.abort();
      const index = waiting.indexOf(job);
      if (index >= 0) { waiting.splice(index,1); jobs.delete(job.key); job.resolve({ok:false,cancelled:true}); }
    }
    chrome.storage.onChanged.addListener((changes,area) => {
      if (area !== "local" || !changes.aiConfig) return;
      cached = undefined;
      for (const job of [...jobs.values()]) cancel(job);
    });
    async function execute(job) {
      try {
        if (job.cancelled) return {ok:false,cancelled:true};
        const saved = await load();
        if (!saved.enabled) throw new Error("AI 回复未开启，请先打开 AI 设置。");
        const url = config.endpoint(saved.baseUrl);
        if (!await chrome.permissions.contains({origins:[config.originPattern(url)]})) throw new Error("模型域名尚未授权，请在 AI 设置中保存配置。");
        if (job.cancelled) return {ok:false,cancelled:true};
        const template = job.message.kind === "rewrite" ? saved.rewritePrompt : saved.generatePrompt;
        const values = {post:job.message.post,draft:job.message.kind === "rewrite" ? job.message.draft : ""};
        const prompt = template.replace(/\$\{(post|draft)\}/g,(_,key) => values[key]);
        const response = await fetch(url.href,{
          method:"POST",redirect:"error",credentials:"omit",signal:job.controller.signal,
          headers:{"Content-Type":"application/json",Authorization:`Bearer ${saved.apiKey}`},
          body:JSON.stringify({model:saved.model,messages:[{role:"system",content:prompt},{role:"user",content:"开始。"}],temperature:1.2,stream:true})
        });
        const text = await readResponse(response,job.controller.signal);
        return job.cancelled ? {ok:false,cancelled:true} : {ok:true,text};
      } catch (error) {
        if (job.cancelled) return {ok:false,cancelled:true};
        if (job.timedOut) return {ok:false,error:"模型响应超时，请稍后重试。"};
        return {ok:false,error:error instanceof TypeError || error instanceof SyntaxError ? "模型连接或响应格式异常，请检查接口配置。" : error.message};
      } finally { clearTimeout(job.timer); }
    }
    function drain() {
      while (active < 3 && waiting.length) {
        const job = waiting.shift(); active++;
        void execute(job).then(job.resolve).finally(() => {active--;jobs.delete(job.key);drain();});
      }
    }
    async function handle(message,sender) {
      if (message.type === "AI_OPEN_SETTINGS") { await chrome.runtime.openOptionsPage(); return {ok:true}; }
      if (message.type === "AI_STATUS") {
        const saved = await load();
        const {aiAutoComplete} = await chrome.storage.local.get("aiAutoComplete");
        return {ok:true,enabled:saved.enabled,autoComplete:aiAutoComplete === true,configured:Boolean(saved.baseUrl && saved.apiKey && saved.model)};
      }
      if (message.type === "AI_CONFIG_GET" || message.type === "AI_CONFIG_SAVE") {
        if (!settingsPage(sender)) return {ok:false,error:"仅设置页可以操作 AI 配置。"};
        if (message.type === "AI_CONFIG_GET") return {ok:true,config:await load()};
        const saved = config.normalize(message.config);
        if (saved.enabled && !await chrome.permissions.contains({origins:[config.originPattern(config.endpoint(saved.baseUrl))]})) throw new Error("请先授权模型域名。");
        await chrome.storage.local.set({aiConfig:saved});
        return {ok:true};
      }
      if (message.type === "AI_CANCEL") {
        for (const id of Array.isArray(message.ids) ? message.ids.slice(0,32) : []) {
          const job = jobs.get(`${owner(sender)}:${id}`); if (job) cancel(job);
        }
        return {ok:true};
      }
      if (message.type !== "AI_REQUEST" || !["generate","rewrite"].includes(message.kind) ||
          typeof message.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(message.id) ||
          typeof message.post !== "string" || !message.post.trim() || message.post.length > 20000 ||
          typeof message.draft !== "string" || message.draft.length > 10000) return {ok:false,error:"AI 请求内容无效或过长。"};
      const key = `${owner(sender)}:${message.id}`;
      if (jobs.has(key)) return {ok:false,error:"重复的 AI 请求。"};
      if (waiting.length >= 12) return {ok:false,error:"AI 请求较多，请稍后重试。"};
      return new Promise(resolve => {
        const job = {key,message,resolve,controller:new AbortController(),cancelled:false};
        job.timer = setTimeout(() => {
          job.timedOut=true; job.controller.abort();
          const index=waiting.indexOf(job);
          if (index>=0) {waiting.splice(index,1);jobs.delete(key);resolve({ok:false,error:"AI 请求等待超时，请稍后重试。"});}
        },TIMEOUT);
        jobs.set(key,job); waiting.push(job); drain();
      });
    }
    return {handle};
  }
  globalThis.XReplyAIService = {create};
})();
