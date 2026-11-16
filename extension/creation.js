(() => {
  "use strict";
  const news=globalThis.XReplyCreationNews, store=globalThis.XReplyCreationStore, model=globalThis.XReplyCreationModel;
  const $=id=>document.getElementById(id);
  const make=(tag,text,className)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;};
  const status=(id,text,error=false)=>{$(id).textContent=text;$(id).dataset.error=String(error);};
  const formatTime=value=>value ? new Date(value).toLocaleString("zh-CN",{year:"numeric",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"}) : "时间未提供";
  let cache={},marks={},drafts=[],selected=[],view="news",page=1,refreshing=false;
  let draftId=crypto.randomUUID(),draftRevision=0,dirty=false,saveTimer,saveChain=Promise.resolve(),preferencesTimer;
  let pending=null,candidate=null,aiStatus=null;
  const pageSize=20;
  const items=()=>Object.values(cache).flatMap(source=>source.items || []);
  function preferences() {
    return {source:$("source").value,state:$("filter-state").value,sort:$("sort").value,search:$("search").value,
      style:$("style").value,length:$("length").value,instructions:$("instructions").value,prompt:$("prompt").value};
  }
  function persistPreferences() {
    clearTimeout(preferencesTimer);
    preferencesTimer=setTimeout(()=>void store.savePreferences(preferences()).catch(()=>status("save-status","创作偏好未保存，请稍后重试。",true)),300);
  }
  function restorePreferences(saved) {
    for (const [id,key] of [["source","source"],["filter-state","state"],["sort","sort"],["style","style"],["length","length"]]) {
      if ([...$(id).options].some(option=>option.value===saved[key])) $(id).value=saved[key];
    }
    $("search").value=(saved.search || "").slice(0,100);
    $("instructions").value=(saved.instructions || "").slice(0,2000);
    $("prompt").value=saved.prompt || model.defaultPrompt;
  }
  function button(text,action) {
    const el=make("button",text);el.type="button";
    el.addEventListener("click",()=>void Promise.resolve().then(action).catch(error=>status("news-status",error.message,true)));
    return el;
  }
  function sourceLink(item) {
    const el=make("a","查看来源 ↗");el.href=item.url;el.target="_blank";el.rel="noopener noreferrer";return el;
  }
  function setView(next) {
    view=next;page=1;
    for (const el of document.querySelectorAll("[data-view]")) el.setAttribute("aria-pressed",String(el.dataset.view===view));
    $("page-title").textContent={news:"新闻素材",saved:"我的收藏",drafts:"我的草稿",hidden:"已隐藏"}[view];
    $("filters").hidden=view==="drafts";
    renderCards();
  }
  function renderCards() {
    $("news-count").textContent=items().length;$("draft-count").textContent=drafts.length;
    let matches;
    if (view==="drafts") matches=drafts;
    else {
      const query=$("search").value.trim().toLowerCase(),source=$("source").value,state=$("filter-state").value;
      matches=items().filter(item=>{
        const flag=marks[item.id] || {};
        return (view==="hidden" ? flag.hidden : !flag.hidden) && (view!=="saved" || flag.saved) &&
          (source==="all" || item.sourceId===source) && (!query || `${item.title}\n${item.text}`.toLowerCase().includes(query)) &&
          (state!=="unused" || !flag.used) && (state!=="used" || flag.used) && (state!=="body" || item.coverage==="body");
      });
      matches.sort((a,b)=>($("sort").value==="body" ? Number(b.coverage==="body")-Number(a.coverage==="body") : 0) ||
        (Date.parse(b.publishedAt)||b.fetchedAt)-(Date.parse(a.publishedAt)||a.fetchedAt));
    }
    const pages=Math.max(1,Math.ceil(matches.length/pageSize));page=Math.min(page,pages);
    $("list-summary").textContent=view==="drafts" ? `${matches.length} 份本机草稿` : `${matches.length} 篇素材 · ${view==="hidden"?"可恢复隐藏内容":"新闻按来源时间更新，不代表平台热度"}`;
    $("cards").replaceChildren();
    for (const item of matches.slice((page-1)*pageSize,page*pageSize)) $("cards").append(view==="drafts" ? draftCard(item) : newsCard(item));
    if (!matches.length) $("cards").append(make("div",view==="drafts" ? "还没有草稿。选素材生成后，采用结果即可保存。" : "暂无符合条件的素材。可以调整筛选，或授权后刷新来源。","empty"));
    $("page-number").textContent=`${page} / ${pages}`;$("previous").disabled=page<=1;$("next").disabled=page>=pages;
  }
  function newsCard(item) {
    const flag=marks[item.id] || {}, chosen=selected.some(value=>value.id===item.id);
    const card=make("article",undefined,`card${chosen?" selected":""}`),meta=make("div",undefined,"card-meta");
    meta.append(make("span",item.source,"badge"),make("time",formatTime(item.publishedAt)),make("span",item.coverage==="body"?"正文 / 节选":"仅摘要"));
    if (flag.used) meta.append(make("span","已使用","badge"));
    card.append(meta,make("h3",item.title),make("p",item.text.slice(0,160)+(item.text.length>160?"…":"")));
    const actions=make("div",undefined,"card-actions");
    const choose=button(chosen?"已选 · 移除":"选入素材",()=>toggleSelection(item));
    choose.disabled=Boolean(pending);choose.setAttribute("aria-pressed",String(chosen));
    actions.append(choose,button(flag.saved?"★ 已收藏":"☆ 收藏",async()=>{marks=await store.mark(item.id,"saved",!flag.saved);renderCards();}),
      button(flag.hidden?"恢复显示":"隐藏",async()=>{marks=await store.mark(item.id,"hidden",!flag.hidden);renderCards();}),sourceLink(item));
    card.append(actions);return card;
  }
  function draftCard(item) {
    const card=make("article",undefined,"card");
    card.append(make("div",`草稿 · ${formatTime(item.updatedAt)}`,"card-meta"),make("h3",item.title || "未命名草稿"),make("p",item.text.slice(0,180)));
    const actions=make("div",undefined,"card-actions");
    actions.append(button("继续编辑",async()=>{await flushSave();cancelGeneration();loadDraft(item);renderCards();}),button("删除",async()=>{
      if (!confirm("删除这份本机草稿？请先复制需要保留的内容。")) return;
      await flushSave();drafts=await store.removeDraft(item.id);
      if (draftId===item.id) resetDraft();renderCards();
    }));
    card.append(actions);return card;
  }
  function toggleSelection(item) {
    if (pending) return;
    if (selected.some(value=>value.id===item.id)) selected=selected.filter(value=>value.id!==item.id);
    else {
      if (selected.length>=3) {status("news-status","一次最多选 3 篇素材，可先移除一篇。",true);return;}
      selected.push({...item});
    }
    renderSelected();renderCards();if($("draft").value.trim()) queueSave();
  }
  function renderSelected() {
    $("selection-count").textContent=`${selected.length} / 3 篇`;$("selected-materials").replaceChildren();
    if (!selected.length) $("selected-materials").append(make("p","从左侧选择素材，正文会自动带入。","empty"));
    for (const item of selected) {
      const box=make("div",undefined,"selected-material"),details=make("details");
      details.append(make("summary",item.title));box.append(details);
      const remove=button("移除",()=>toggleSelection(item));remove.disabled=Boolean(pending);box.append(remove);
      details.append(make("div",`${item.source} · ${item.coverage==="body"?"正文或节选":"仅有摘要，生成时不会补造细节"}${item.text.length>=news.BODY_LIMIT?" · 最多携带前 10000 字":""}`,"coverage"),make("pre",item.text || "暂无可用正文"),sourceLink(item));
      $("selected-materials").append(box);
    }
    $("generate").disabled=$("angles").disabled=Boolean(pending) || !selected.length;
    $("use-candidate").disabled=Boolean(pending);
  }
  function renderSources() {
    $("source-statuses").replaceChildren();
    for (const source of news.sources) {
      const data=cache[source.id];
      $("source-statuses").append(make("div",`${source.name}：${data?.items?.length || 0} 篇 · ${data?.updatedAt ? "更新于 "+formatTime(data.updatedAt) : "尚未读取"}${data?.error ? " · "+data.error : ""}`,"source-state"));
    }
  }
  async function refresh(force=false) {
    if (refreshing) return;
    if (!await chrome.permissions.contains({origins:news.origins})) {$("permission-panel").hidden=false;status("news-status","授权来源后即可自动加载新闻。");return;}
    $("permission-panel").hidden=true;refreshing=true;$("refresh").disabled=true;
    status("news-status","正在检查新闻更新，已有素材仍可使用…");
    try {
      // 同源在多个工作台之间只拉取一次；成功刷新保留 15 分钟缓存。
      for (const source of news.sources) {
        await navigator.locks.request(`xreply-feed-${source.id}`,async()=>{
          const latest=(await store.readCache())[source.id];cache[source.id]=latest || {};
          if (latest?.updatedAt && Date.now()-latest.updatedAt<(force?30000:news.TTL)) return;
          try {
            const xml=await news.fetchText(source.feed,source);
            const incoming=news.parseFeed(xml,source);
            const value={items:news.mergeItems(latest?.items || [],incoming),updatedAt:Date.now(),error:""};
            await store.setSource(source.id,value);cache[source.id]=value;
          } catch(error) {
            cache[source.id]={...latest,error:error.message};
            await store.setSource(source.id,cache[source.id]);
          }
          renderSources();renderCards();
        });
      }
      const failed=news.sources.filter(source=>cache[source.id]?.error).length;
      status("news-status",failed ? `${failed} 个来源暂不可用，已保留其他素材与上次缓存。展开「来源状态」查看原因。` : "素材已更新，选一篇即可开始创作。",Boolean(failed));
    } catch(error) {status("news-status",error.message,true);}
    finally {refreshing=false;$("refresh").disabled=false;renderSources();renderCards();}
  }
  async function readModel() {
    try {
      aiStatus=await chrome.runtime.sendMessage({type:"AI_CREATION_STATUS"});
      if (!aiStatus?.ok) throw new Error(aiStatus?.error || "模型状态暂不可用。");
      $("model-status").textContent=aiStatus.configured ? `${aiStatus.name} · ${aiStatus.model}` : "请先在 AI 接口设置中填写模型配置";
      $("authorize-model").hidden=!aiStatus.configured || aiStatus.permitted;
    } catch(error) {$("model-status").textContent=error.message;aiStatus=null;}
  }
  async function enrich(item,signal) {
    if(item.coverage==="body") return item;
    const source=news.sources.find(value=>value.id===item.sourceId);
    if (!source) return item;
    try {
      const text=news.articleText(await news.fetchText(item.url,source,signal),source);
      if (text.length>item.text.length) {
        const next={...item,text,coverage:"body"};
        await navigator.locks.request(`xreply-feed-${source.id}`,async()=>{
          const old=(await store.readCache())[source.id];
          if (old?.items?.some(value=>value.id===item.id)) {
            const value={...old,items:old.items.map(value=>value.id===item.id?next:value)};
            await store.setSource(source.id,value);cache[source.id]=value;
          }
        });
        return next;
      }
    } catch(error) {
      if (signal.aborted) throw error;
      status("generation-status",`${item.source} 正文未能补全，将仅使用现有摘要。`);
    }
    return item;
  }
  function cancelGeneration() {
    if (!pending) return;
    const old=pending;pending=null;old.controller.abort();
    void chrome.runtime.sendMessage({type:"AI_CANCEL",ids:[old.id]}).catch(()=>{});
    $("cancel").hidden=true;status("generation-status","已取消，原草稿保留。");renderSelected();renderCards();
  }
  async function generate(action) {
    if (pending || !selected.length) return;
    await readModel();
    if (pending || !selected.length) return;
    if (!aiStatus?.configured || !aiStatus.permitted) {status("generation-status","请先配置并授权模型接口。",true);return;}
    const job={id:crypto.randomUUID(),controller:new AbortController()},snapshot=selected.map(item=>({...item}));pending=job;
    const settings=preferences();$("cancel").hidden=false;renderSelected();renderCards();
    status("generation-status","正在准备素材，必要时补取正文…");
    let timer;
    try {
      const materials=[];
      for (const item of snapshot) {
        if (pending!==job) return;
        materials.push(await enrich(item,job.controller.signal));
      }
      if (pending!==job) return;
      selected=materials;renderSelected();
      const message={type:"AI_REQUEST",kind:"compose",id:job.id,action,materials,style:settings.style,length:Number(settings.length),prompt:settings.prompt,instructions:settings.instructions};
      model.build(message);
      status("generation-status",`${action==="angles"?"正在分析写作角度":"正在生成成稿"} · ${materials.length} 篇素材${materials.some(item=>item.coverage!=="body")?"（含摘要）":""} · 最长等待 60 秒`);
      const result=await Promise.race([chrome.runtime.sendMessage(message),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("创作等待超时，请重试；原草稿保留。")),65000);})]);
      if (pending!==job) return;
      if (!result?.ok) throw new Error(result?.error || "创作已取消或服务暂不可用。");
      candidate={text:result.text,materials,action};
      $("candidate").textContent=result.text;$("candidate-panel").hidden=false;
      $("candidate-label").textContent=action==="angles"?"建议写作角度":"本次生成结果";
      $("use-candidate").textContent=action==="angles"?"按这些角度生成":"采用为草稿";
      status("generation-status",action==="angles"?"角度已生成。可一键带入附加要求并生成成稿，也可自行挑选和修改。":"成稿已生成，点击「采用为草稿」后可继续编辑。");
    } catch(error) {if(pending===job)status("generation-status",error.message,true);}
    finally {
      clearTimeout(timer);
      if (pending===job) {pending=null;$("cancel").hidden=true;renderSelected();renderCards();}
    }
  }
  function queueSave() {
    dirty=true;status("save-status","正在保存…");clearTimeout(saveTimer);
    saveTimer=setTimeout(()=>void save().catch(()=>{}),500);
    $("draft-length").textContent=`${$("draft").value.length} 字`;
  }
  function save() {
    clearTimeout(saveTimer);
    const id=draftId,text=$("draft").value,materials=selected.map(item=>({...item}));
    saveChain=saveChain.catch(()=>{}).then(async()=>{
      if (!dirty || id!==draftId) return;
      try {
        const result=await store.saveDraft({id,text,materials,title:text.trim().split("\n")[0].slice(0,60) || "空白草稿"},draftRevision);
        if (id===draftId) {
          draftRevision=result.revision;
          if ($("draft").value===text && JSON.stringify(selected)===JSON.stringify(materials)) dirty=false;
          status("save-status",dirty ? "正在保存后续修改…" : "已保存到本机 · "+formatTime(result.updatedAt));
        }
        drafts=await store.readDrafts();renderCards();
      } catch(error) {status("save-status",error.message,true);throw error;}
    });
    return saveChain;
  }
  async function flushSave() {if(dirty)await save();else await saveChain.catch(()=>{});}
  function loadDraft(item) {
    draftId=item.id;draftRevision=item.revision;dirty=false;selected=(item.materials || []).map(value=>({...value}));
    $("draft").value=item.text;$("draft-length").textContent=`${item.text.length} 字`;$("candidate-panel").hidden=true;candidate=null;
    status("save-status","已打开草稿 · "+formatTime(item.updatedAt));renderSelected();
  }
  function resetDraft() {
    cancelGeneration();draftId=crypto.randomUUID();draftRevision=0;dirty=false;selected=[];candidate=null;
    $("draft").value="";$("candidate-panel").hidden=true;$("draft-length").textContent="0 字";
    status("save-status","");status("generation-status","");renderSelected();renderCards();
  }
  $("filters").addEventListener("submit",event=>event.preventDefault());
  for (const id of ["source","filter-state","sort","search"]) $(id).addEventListener(id==="search"?"input":"change",()=>{page=1;persistPreferences();renderCards();});
  for (const id of ["style","length","instructions","prompt"]) $(id).addEventListener("input",persistPreferences);
  for (const el of document.querySelectorAll("[data-view]")) el.addEventListener("click",()=>setView(el.dataset.view));
  $("previous").onclick=()=>{page--;renderCards();};$("next").onclick=()=>{page++;renderCards();};
  $("refresh").onclick=()=>void refresh(true).catch(error=>status("news-status",error.message,true));
  $("enable-sources").onclick=()=>{
    void chrome.permissions.request({origins:news.origins}).then(granted=>{
      if(granted)return refresh();status("news-status","未授权来源。授权后即可读取自动素材。");
    }).catch(error=>status("news-status",error.message,true));
  };
  $("authorize-model").onclick=()=>{
    if(aiStatus?.origin)void chrome.permissions.request({origins:[aiStatus.origin]}).then(readModel).catch(error=>status("generation-status",error.message,true));
  };
  $("reset-prompt").onclick=()=>{if(confirm("恢复默认创作提示词？现有评论提示词不受影响。")){$("prompt").value=model.defaultPrompt;persistPreferences();}};
  $("generate").onclick=()=>void generate("draft").catch(error=>status("generation-status",error.message,true));
  $("angles").onclick=()=>void generate("angles").catch(error=>status("generation-status",error.message,true));
  $("cancel").onclick=cancelGeneration;
  $("use-candidate").onclick=()=>{
    if(!candidate)return;
    if(candidate.action==="angles") {
      const instructions=($("instructions").value.trim()+"\n参考以下角度组织内容：\n"+candidate.text).trim();
      if(instructions.length>2000){status("generation-status","角度和附加要求合计超过 2000 字，请挑选需要的部分填入附加要求。",true);return;}
      $("instructions").value=instructions;persistPreferences();
      void generate("draft").catch(error=>status("generation-status",error.message,true));return;
    }
    if($("draft").value.trim() && !confirm("用本次结果替换当前草稿？若要保留旧稿，请先点「另存一份」。"))return;
    $("draft").value=candidate.text;selected=candidate.materials.map(item=>({...item}));renderSelected();queueSave();
  };
  $("draft").addEventListener("input",queueSave);
  $("copy").onclick=()=>void (async()=>{
    if(!$("draft").value.trim())throw new Error("先生成或填写草稿再复制。");
    await navigator.clipboard.writeText($("draft").value);status("save-status","正文已复制，可到 X 粘贴并核对。");
  })().catch(error=>status("save-status",error.message,true));
  $("mark-used").onclick=()=>void (async()=>{
    if(!selected.length)throw new Error("当前草稿没有关联素材。");
    for(const item of selected)marks=await store.mark(item.id,"used",true);
    status("save-status","所选素材已标记使用。此标记不代表已经发布。");renderCards();
  })().catch(error=>status("save-status",error.message,true));
  $("save-as").onclick=()=>void (async()=>{
    await saveChain.catch(()=>{});clearTimeout(saveTimer);
    draftId=crypto.randomUUID();draftRevision=0;dirty=true;await save();
  })().catch(error=>status("save-status",error.message,true));
  $("new-draft").onclick=()=>void flushSave().then(resetDraft).catch(()=>{});
  window.addEventListener("beforeunload",event=>{if(dirty){event.preventDefault();event.returnValue="";}});
  window.addEventListener("pagehide",cancelGeneration);
  chrome.storage.onChanged.addListener((changes,area)=>{if(area==="local" && changes.aiConfig)void readModel();});
  window.addEventListener("focus",()=>void readModel());
  async function init() {
    for(const source of news.sources){const option=make("option",source.name);option.value=source.id;$("source").append(option);}
    const saved=await store.load();cache=saved.cache;marks=saved.marks;drafts=saved.drafts;restorePreferences(saved.preferences);
    if(drafts.length)loadDraft(drafts[0]);else renderSelected();renderCards();renderSources();
    await readModel();await refresh();
  }
  void init().catch(error=>status("news-status","工作台初始化失败："+error.message,true));
})();
