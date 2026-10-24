(() => {
  const fields = ["baseUrl","apiKey","model","generatePrompt","rewritePrompt"];
  const get = id => document.getElementById(id);
  const status = get("status");
  async function send(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || "扩展连接失败，请重新打开设置。");
    return response;
  }
  void send({type:"AI_CONFIG_GET"}).then(({config}) => {
    for (const field of fields) get(field).value = config[field];
    get("enabled").checked = config.enabled; get("save").disabled = false; status.textContent = "";
  }).catch(error => {status.textContent = error.message;});
  get("defaults").addEventListener("click",() => {
    get("generatePrompt").value = XReplyAIConfig.defaults.generatePrompt;
    get("rewritePrompt").value = XReplyAIConfig.defaults.rewritePrompt;
    status.textContent = "已填入默认 Prompt，点击保存后应用。";
  });
  get("settings").addEventListener("submit",async event => {
    event.preventDefault(); get("save").disabled = true;
    try {
      const raw = Object.fromEntries(fields.map(field => [field,get(field).value]));
      const config = XReplyAIConfig.normalize({...raw,enabled:get("enabled").checked});
      if (config.enabled && !await chrome.permissions.request({origins:[XReplyAIConfig.originPattern(XReplyAIConfig.endpoint(config.baseUrl))]})) {
        throw new Error("域名未授权，设置未保存。");
      }
      await send({type:"AI_CONFIG_SAVE",config});
      status.textContent = config.enabled ? "已保存并开启。请确认原 XReply 已停用；回复框可点击推荐评论；自动补全在扩展弹窗中单独开启。" : "已保存，AI 回复已关闭。";
    } catch (error) {status.textContent = error.message;}
    finally {get("save").disabled = false;}
  });
})();
