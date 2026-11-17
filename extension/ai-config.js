(() => {
  "use strict";
  const defaults = {
    enabled:false,baseUrl:"",apiKey:"",model:"",typingDelayMin:35,typingDelayMax:100,maxReplyLength:12000,
    generatePrompt:"请为下面的 X 帖子写一句自然、简短的中文回复，尽量不超过12个字。语气轻松，不编造经历，不添加帖子没有表达的事实。只返回 <reply>回复内容</reply>。\n\n帖子：\n${post}",
    rewritePrompt:"请把下面的回复草稿改写成一句简短自然的中文。严格保留原意、立场和情绪强度，不增加评价、经历或额外观点。只返回 <reply>改写后的内容</reply>。\n\n帖子：\n${post}\n\n草稿：\n${draft}",
    polishPrompt:"参考当前帖子，把候选回复润色得简短、自然。保留原意、立场和说话语气，删去套话。不要新增经历、事实或评价。首稿已经合适时可以原样保留。只返回 <reply>润色后的回复</reply>。"
  };
  function endpoint(value) {
    const url = new URL(value);
    const local = ["localhost","127.0.0.1"].includes(url.hostname);
    if (!(url.protocol === "https:" || url.protocol === "http:" && local) || url.username || url.password || url.search || url.hash ||
        /(^|\.)(x\.com|twitter\.com)$/.test(url.hostname)) throw new Error("请输入 HTTPS 模型 Base URL，或本机 HTTP 地址；不能使用 X 地址。");
    const path = url.pathname.replace(/\/+$/,"");
    const suffix = "/chat/completions";
    url.pathname = path.endsWith(suffix) ? path : path + suffix;
    return url;
  }
  function normalize(raw) {
    const value = { ...defaults };
    for (const key of ["baseUrl","apiKey","model","generatePrompt","rewritePrompt","polishPrompt"]) {
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
        [value.generatePrompt,value.rewritePrompt,value.polishPrompt].some(prompt=>prompt.length>16000)) throw new Error("配置内容过长。");
    if (value.enabled && (!value.baseUrl || !value.apiKey || !value.model || !value.generatePrompt || !value.rewritePrompt)) {
      throw new Error("开启前请填写接口、Key、模型及两套 Prompt。");
    }
    return value;
  }
  /** 创作工作台的步骤：每步可单独指定 API 配置，未指定时跟随当前配置。 */
  const creationSteps = Object.freeze([
    Object.freeze({id:"angles",label:"找角度"}),
    Object.freeze({id:"drafts",label:"成稿"}),
    Object.freeze({id:"styles",label:"拆解风格"}),
    Object.freeze({id:"images",label:"配图"})
  ]);
  /** 写作台的任务及其使用哪个步骤的 API：改写与成稿共用「成稿」。 */
  const creationTasks = Object.freeze({angles:"angles",drafts:"drafts",rewrite:"drafts",revise:"drafts",styles:"styles",image_prompt:"drafts"});
  /**
   * 两层配置：API 连接（profiles：地址、Key、默认模型）由各功能共用；每个功能选一个连接，并可单独填模型名。
   * 功能的模型留空时用连接的默认模型；配图的模型是出图模型（对话模型不能出图），留空时用 gpt-image-2。
   */
  const features = Object.freeze([
    Object.freeze({id:"reply",group:"reply",label:"生成回复"}),
    Object.freeze({id:"polish",group:"reply",label:"二次润色"}),
    ...creationSteps.map(step=>Object.freeze({...step,group:"creation"}))
  ]);
  const imageDefaults = Object.freeze({imageModel:"gpt-image-2",imageQuality:"medium"});
  const IMAGE_QUALITIES = Object.freeze(["medium","low","high","auto"]);
  const MODEL_NAME = /^[A-Za-z0-9][\w.:/@+-]{0,255}$/;
  /** 各功能单独指定的模型名；旧版的 imageModel 迁入 models.images。 */
  function featureModels(raw) {
    const source = {...(raw?.models && typeof raw.models === "object" ? raw.models : {})};
    if (source.images === undefined && typeof raw?.imageModel === "string" && raw.imageModel.trim() !== imageDefaults.imageModel) source.images = raw.imageModel;
    return Object.fromEntries(features.map(feature=>{
      const model = typeof source[feature.id] === "string" ? source[feature.id].trim() : "";
      if (model && !MODEL_NAME.test(model)) throw new Error(`「${feature.label}」的模型名只能包含字母、数字和 . _ - : / @ +。`);
      return [feature.id,model];
    }));
  }
  function imageQuality(raw) {
    const quality = raw?.imageQuality ?? imageDefaults.imageQuality;
    if (!IMAGE_QUALITIES.includes(quality)) throw new Error("出图质量无效。");
    return quality;
  }
  /** 连接加上功能单独指定的模型。 */
  const withModel = (profile,model) => profile && model ? {...profile,model} : profile;
  /** 出图模型。 */
  const imageModel = value => value.models?.images || imageDefaults.imageModel;
  /** 出图接口地址：与对话接口同一个 Base URL，路径换成 /images/generations。 */
  function imagesEndpoint(value) {
    const url = endpoint(value);
    url.pathname = url.pathname.replace(/\/chat\/completions$/,"/images/generations");
    return url;
  }
  /** 只保留仍然存在的配置编号；配置被删除后该步骤回到“跟随当前配置”。 */
  function creationProfileIds(raw,profiles) {
    return Object.fromEntries(creationSteps.map(step=>{
      const id=raw?.[step.id];
      return [step.id,typeof id==="string" && profiles.some(profile=>profile.id===id) ? id : ""];
    }));
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
    const models=featureModels(raw);
    const shared=normalize({...raw,...selected,model:models.reply || selected.model});
    const polishEnabled=raw?.polishEnabled===true;
    const polish=profiles.find(profile=>profile.id===raw?.polishProfileId);
    if(polishEnabled && (!polish?.baseUrl || !polish.apiKey || !(models.polish || polish.model) || !shared.polishPrompt)) {
      throw new Error("开启二次润色前，请选择已填写接口、Key 和模型的 API 配置，并填写润色 Prompt。");
    }
    return {enabled:shared.enabled,typingDelayMin:shared.typingDelayMin,typingDelayMax:shared.typingDelayMax,maxReplyLength:shared.maxReplyLength,
      generatePrompt:shared.generatePrompt,rewritePrompt:shared.rewritePrompt,activeProfileId,profiles,
      polishEnabled,polishProfileId:polish?.id || "",polishPrompt:shared.polishPrompt,
      creationProfileIds:creationProfileIds(raw?.creationProfileIds,profiles),models,imageQuality:imageQuality(raw)};
  }
  function activeConfig(value) {
    return {...withModel(value.profiles.find(profile=>profile.id===value.activeProfileId),value.models?.reply),enabled:value.enabled,
      generatePrompt:value.generatePrompt,rewritePrompt:value.rewritePrompt,typingDelayMin:value.typingDelayMin,typingDelayMax:value.typingDelayMax,
      maxReplyLength:value.maxReplyLength};
  }
  function isOpenAI(value) {
    try {return new URL(value).origin==="https://api.openai.com";} catch {return false;}
  }
  const originPattern = url => `${url.protocol}//${url.hostname}/*`;
  const polishProfile = value => value.polishEnabled ? withModel(value.profiles.find(profile=>profile.id===value.polishProfileId),value.models?.polish) : undefined;
  /** 某个创作步骤实际使用的 API 配置。 */
  function creationProfile(value,stepId) {
    const id=value.creationProfileIds?.[stepId];
    const profile = value.profiles.find(profile=>profile.id===id) || value.profiles.find(profile=>profile.id===value.activeProfileId);
    return stepId === "images" ? {...profile,model:imageModel(value)} : withModel(profile,value.models?.[stepId]);
  }
  /** 保存时需要授权的模型域名：开启 AI 回复时的回复与润色配置，以及创作步骤单独指定且已填地址的配置。 */
  function requiredOrigins(value) {
    const replyProfiles = value.enabled ? [activeConfig(value),polishProfile(value)] : [];
    const creationProfiles = creationSteps.filter(step=>value.creationProfileIds?.[step.id]).map(step=>creationProfile(value,step.id))
      .filter(profile=>profile?.baseUrl);
    const profiles = [...replyProfiles,...creationProfiles].filter(Boolean);
    return [...new Set(profiles.map(profile=>originPattern(endpoint(profile.baseUrl))))];
  }
  globalThis.XReplyAIConfig = { isOpenAI,defaults,endpoint,normalize,normalizeProfiles,activeConfig,openAIPreset,originPattern,polishProfile,requiredOrigins,
    creationSteps,creationTasks,creationProfile,features,imageDefaults,IMAGE_QUALITIES,imageModel,imagesEndpoint };
})();
