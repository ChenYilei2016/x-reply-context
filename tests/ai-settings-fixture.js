// Local settings UI fixture: fake credentials only; no model or Chrome storage calls.
(() => {
  let saved={enabled:true,baseUrl:'https://primary.example/v1',apiKey:'fixture-primary-key',model:'primary-model',generatePrompt:'共享生成：${post} / ${rootOwnership}',rewritePrompt:'共享改写：${draft}'};
  const note=document.createElement('p');note.textContent='本地设置模拟 · 假 Key · 不连接模型或真实扩展存储';note.style.color='#a91610';document.querySelector('h1').after(note);
  const failure=document.createElement('label');failure.innerHTML='<input type="checkbox" id="fail-save"> 模拟保存失败';document.body.append(failure);
  const evidence=document.createElement('p');evidence.id='mock-evidence';document.body.append(evidence);
  const report=()=>{const value=XReplyAIConfig.normalizeProfiles(saved);evidence.textContent='模拟已保存配置：'+value.activeProfileId+' · '+value.profiles.length+'组';};
  globalThis.chrome={runtime:{sendMessage:async message=>{
    if(message.type==='AI_CONFIG_GET')return {ok:true,config:XReplyAIConfig.normalizeProfiles(saved)};
    if(message.type==='AI_CONFIG_SAVE'){
      if(document.querySelector('#fail-save').checked)return {ok:false,error:'模拟保存失败；原配置仍生效'};
      saved=XReplyAIConfig.normalizeProfiles(message.config);report();return {ok:true};
    }
    throw Error('Unexpected fixture operation');
  }},permissions:{request:async()=>true}};
  report();
})();
