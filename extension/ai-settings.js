(() => {
  const profileFields=["baseUrl","apiKey","model","serviceTier"];
  const promptFields=["generatePrompt","rewritePrompt"];
  const get=id=>document.getElementById(id);
  const status=get("status");
  let config,selectedId,dirty=false,saving=false;
  async function send(message) {
    const response=await chrome.runtime.sendMessage(message);
    if(!response?.ok)throw new Error(response?.error || "扩展连接失败，请重新打开设置。");
    return response;
  }
  function remember() {
    const profile=config.profiles.find(item=>item.id===selectedId);
    if(!profile)return;
    profile.name=get("profileName").value;
    for(const field of profileFields)profile[field]=get(field).value;
  }
  function renderProcessing() {
    const supported=XReplyAIConfig.isOpenAI(get("baseUrl").value);
    get("openaiMode").hidden=!supported;get("serviceTier").disabled=!supported||saving;
  }
  function renderProfiles() {
    get("profile").replaceChildren(...config.profiles.map(profile=>{
      const option=document.createElement("option");option.value=profile.id;
      option.textContent=profile.name || "未命名配置";return option;
    }));
    get("profile").value=selectedId;
    const profile=config.profiles.find(item=>item.id===selectedId);
    get("profileName").value=profile.name;
    for(const field of profileFields)get(field).value=profile[field] ?? (field==="serviceTier"?"auto":"");
    renderProcessing();
    get("removeProfile").disabled=config.profiles.length<=1;
    get("addProfile").disabled=config.profiles.length>=10;
  }
  function changed(text="修改尚未保存，点击保存后应用。") {dirty=true;status.textContent=text;}
  function applied(value) {
    const selected=value.profiles.find(item=>item.id===value.activeProfileId);
    get("activeProfile").textContent=`已保存的当前配置：${selected.name} · AI ${value.enabled?"已开启":"已关闭"}`;
  }
  void send({type:"AI_CONFIG_GET"}).then(({config:value})=>{
    config=value;selectedId=value.activeProfileId;
    for(const field of promptFields)get(field).value=config[field];
    get("enabled").checked=config.enabled;
    for(const id of ["save","profile","addProfile","openaiProfile","removeProfile"])get(id).disabled=false;
    renderProfiles();applied(config);status.textContent="";
  }).catch(error=>{status.textContent=error.message;});
  get("settings").addEventListener("input",()=>{if(config){changed();renderProcessing();}});
  get("serviceTier").addEventListener("change",()=>{if(config)changed();});
  get("profile").addEventListener("change",()=>{
    remember();selectedId=get("profile").value;renderProfiles();changed("已选择配置，点击保存后切换生效。尚未保存的编辑保留在本页。");
  });
  get("addProfile").addEventListener("click",()=>{
    if(!config || saving || config.profiles.length>=10)return;
    remember();selectedId=crypto.randomUUID();config.profiles.push({id:selectedId,name:"新配置",baseUrl:"",apiKey:"",model:"",serviceTier:"auto"});
    renderProfiles();changed();get("profileName").focus();
  });
  get("openaiProfile").addEventListener("click",()=>{
    if(!config || saving)return;
    remember();let profile=config.profiles.find(item=>item.id==="openai");
    if(!profile){
      if(config.profiles.length>=10){status.textContent="最多保存10组，请先删除不需要的配置。";return;}
      profile={...XReplyAIConfig.openAIPreset};config.profiles.push(profile);
    }
    selectedId=profile.id;renderProfiles();changed("已选择 OpenAI 配置；已有 Key 和自定义值不会被覆盖。填写完成后保存生效。");
  });
  get("removeProfile").addEventListener("click",()=>{
    if(!config || saving || config.profiles.length<=1)return;
    config.profiles=config.profiles.filter(item=>item.id!==selectedId);selectedId=config.profiles[0].id;
    renderProfiles();changed("已从本页移除此配置；保存后才删除，关闭本页可放弃这次修改。");
  });
  get("defaults").addEventListener("click",()=>{
    for(const field of promptFields)get(field).value=XReplyAIConfig.defaults[field];
    changed("已填入默认 Prompt，点击保存后应用。");
  });
  get("settings").addEventListener("submit",async event=>{
    event.preventDefault();if(!config || saving)return;
    saving=true;remember();
    const controls=[...get("settings").querySelectorAll("input,textarea,select,button")];
    controls.forEach(control=>{control.disabled=true;});
    try {
      const next=XReplyAIConfig.normalizeProfiles({...config,enabled:get("enabled").checked,activeProfileId:selectedId,
        ...Object.fromEntries(promptFields.map(field=>[field,get(field).value]))});
      const active=XReplyAIConfig.activeConfig(next);
      if(active.enabled && !await chrome.permissions.request({origins:[XReplyAIConfig.originPattern(XReplyAIConfig.endpoint(active.baseUrl))]}))throw new Error("域名未授权，设置未保存；原配置仍然生效。");
      await send({type:"AI_CONFIG_SAVE",config:next});
      config=next;dirty=false;applied(config);status.textContent="已保存并切换，旧配置的生成任务已取消。";
    } catch(error){status.textContent=error.message;}
    finally{saving=false;controls.forEach(control=>{control.disabled=false;});renderProfiles();}
  });
  window.addEventListener("beforeunload",event=>{if(dirty){event.preventDefault();event.returnValue="";}});
})();
