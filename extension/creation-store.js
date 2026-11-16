(() => {
  "use strict";
  const CACHE="creationNews", MARKS="creationMarks", DRAFTS="creationDrafts", PREFS="creationPreferences";
  const read=async(key,fallback)=> (await chrome.storage.local.get(key))[key] || fallback;
  async function update(key,fallback,change) {
    return navigator.locks.request(`xreply-${key}`,async()=>{
      const current=await read(key,fallback), value=change(current);
      await chrome.storage.local.set({[key]:value});
      return value;
    });
  }
  async function mark(id,field,value) {
    if (!["saved","hidden","used"].includes(field)) throw new Error("标记类型无效。");
    return update(MARKS,{},all=>{
      all[id]={...all[id],[field]:value,updatedAt:Date.now()};
      return Object.fromEntries(Object.entries(all).sort((a,b)=>b[1].updatedAt-a[1].updatedAt).slice(0,1000));
    });
  }
  async function saveDraft(draft,expectedRevision=0) {
    if (!draft.id || typeof draft.text!=="string" || draft.text.length>12000) throw new Error("草稿内容无效或超过 12000 字。");
    let saved;
    await update(DRAFTS,[],all=>{
      const old=all.find(item=>item.id===draft.id);
      if (!old && expectedRevision) throw new Error("这份草稿已在其他页面删除，请点击「另存一份」保留当前文字。");
      if (old && old.revision!==expectedRevision) throw new Error("其他页面已更新这份草稿，请点击「另存一份」保留当前文字。");
      if (!old && all.length>=50) throw new Error("已保存 50 份草稿，请先在「我的草稿」删除不再需要的草稿。");
      saved={...draft,revision:(old?.revision||0)+1,updatedAt:Date.now()};
      return [saved,...all.filter(item=>item.id!==draft.id)];
    });
    return saved;
  }
  const removeDraft=id=>update(DRAFTS,[],all=>all.filter(item=>item.id!==id));
  const setSource=(id,value)=>update(CACHE,{},all=>({...all,[id]:value}));
  globalThis.XReplyCreationStore={
    load:async()=>({cache:await read(CACHE,{}),marks:await read(MARKS,{}),drafts:await read(DRAFTS,[]),preferences:await read(PREFS,{})}),
    readCache:()=>read(CACHE,{}),readDrafts:()=>read(DRAFTS,[]),
    savePreferences:preferences=>chrome.storage.local.set({[PREFS]:preferences}),setSource,mark,saveDraft,removeDraft
  };
})();
