(() => {
  "use strict";
  const defaults = {
    enabled:false,baseUrl:"",apiKey:"",model:"",typingDelayMin:35,typingDelayMax:100,maxReplyLength:12000,
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
    for(const key of ["typingDelayMin","typingDelayMax"]) {
      value[key]=raw?.[key] ?? defaults[key];
      if(!Number.isInteger(value[key]) || value[key]<0 || value[key]>1000)throw new Error("逐字间隔请输入0～1000毫秒的整数。");
    }
    if(value.typingDelayMin>value.typingDelayMax)throw new Error("逐字间隔最小值不能大于最大值。");
    value.maxReplyLength = raw?.maxReplyLength ?? defaults.maxReplyLength;
    if (!Number.isInteger(value.maxReplyLength) || value.maxReplyLength < 1 || value.maxReplyLength > defaults.maxReplyLength) {
      throw new Error("回复最大字符数请输入 1～12000 的整数。");
    }
    if (value.baseUrl) endpoint(value.baseUrl);
    if (value.apiKey.length > 4096 || value.model.length > 256 || value.baseUrl.length > 2048 ||
        value.generatePrompt.length > 16000 || value.rewritePrompt.length > 16000) throw new Error("配置内容过长。");
    if (value.enabled && (!value.baseUrl || !value.apiKey || !value.model || !value.generatePrompt || !value.rewritePrompt)) {
      throw new Error("开启前请填写接口、Key、模型及两套 Prompt。");
    }
    return value;
  }
  const openAIPreset = {id:"openai",name:"OpenAI / ChatGPT",baseUrl:"https://api.openai.com/v1",apiKey:"",model:"gpt-6-luna",serviceTier:"auto",reasoningEffort:"auto"};
  const profileFields=["baseUrl","apiKey","model"];
  function normalizeProfiles(raw) {
    if (raw?.profiles !== undefined && !Array.isArray(raw.profiles)) throw new Error("API 配置列表无效。");
    let profiles=raw?.profiles,activeProfileId=raw?.activeProfileId;
    if (!profiles) {
      const old=normalize(raw);
      const hasExisting=profileFields.some(key=>old[key]);
      profiles=hasExisting?[{id:"current",name:"原有配置",...Object.fromEntries(profileFields.map(key=>[key,old[key]]))},{...openAIPreset}]:[{...openAIPreset}];
      activeProfileId=profiles[0].id;
    }
    if (!profiles.length || profiles.length>10) throw new Error("请保留1～10组 API 配置。");
    const ids=new Set();
    profiles=profiles.map(profile=>{
      if (typeof profile?.id!=="string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(profile.id) || ids.has(profile.id)) throw new Error("API 配置编号无效或重复。");
      ids.add(profile.id);
      const name=typeof profile.name==="string"?profile.name.trim():"";
      if(!name || name.length>60)throw new Error("配置名称需为1～60个字符。");
      const value=normalize({...profile,enabled:false});
      const serviceTier=profile.serviceTier ?? "auto";
      if(!["auto","default","fast"].includes(serviceTier))throw new Error("OpenAI 处理模式无效。");
      const reasoningEffort=profile.reasoningEffort ?? "auto";
      if(!["auto","none","minimal","low","medium","high","xhigh","max"].includes(reasoningEffort))throw new Error("OpenAI 推理强度无效。");
      return {id:profile.id,name,...Object.fromEntries(profileFields.map(key=>[key,value[key]])),serviceTier,reasoningEffort};
    });
    const selected=profiles.find(profile=>profile.id===activeProfileId);
    if(!selected)throw new Error("请选择有效的 API 配置。");
    const shared=normalize({...raw,...selected});
    return {enabled:shared.enabled,typingDelayMin:shared.typingDelayMin,typingDelayMax:shared.typingDelayMax,maxReplyLength:shared.maxReplyLength,
      generatePrompt:shared.generatePrompt,rewritePrompt:shared.rewritePrompt,activeProfileId,profiles};
  }
  function activeConfig(value) {
    return {...value.profiles.find(profile=>profile.id===value.activeProfileId),enabled:value.enabled,
      generatePrompt:value.generatePrompt,rewritePrompt:value.rewritePrompt,typingDelayMin:value.typingDelayMin,typingDelayMax:value.typingDelayMax,
      maxReplyLength:value.maxReplyLength};
  }
  function isOpenAI(value) {
    try {return new URL(value).origin==="https://api.openai.com";} catch {return false;}
  }
  globalThis.XReplyAIConfig = { isOpenAI,defaults,endpoint,normalize,normalizeProfiles,activeConfig,openAIPreset,originPattern:url => `${url.protocol}//${url.hostname}/*` };
})();
