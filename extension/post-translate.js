// X 原生单帖编辑器的正文转换。所有编辑经 XReplyEditor 写入，让 X 同步自己的草稿状态。
(() => {
  "use strict";
  const EDITORS = '[contenteditable="true"][data-testid^="tweetTextarea_"]';
  const SUBMIT = '[data-testid="tweetButton"],[data-testid="tweetButtonInline"]';
  const POST_LABEL = /^(?:发帖|发帖文|發帖|發佈貼文|发布|發布|Post|ポストする)$/i;

  function composer() {
    const dialog = document.querySelector('[role="dialog"]');
    const root = dialog || (/^\/(?:home|compose\/post)\/?$/.test(location.pathname) &&
      document.querySelector('[data-testid="primaryColumn"]'));
    if (!root) return null;
    const editors = root.querySelectorAll(EDITORS);
    if (editors.length !== 1 || !editors[0].matches('[data-testid="tweetTextarea_0"]')) return null;
    const submit = root.querySelector(SUBMIT);
    if (!submit || !POST_LABEL.test(submit.textContent.trim() || submit.getAttribute("aria-label") || "")) return null;
    const toolbar = root.querySelector('[data-testid="toolBar"]');
    return toolbar ? {editor:editors[0],toolbar} : null;
  }

  function create({message,accountHandle,connected}) {
    let current;
    const edit = globalThis.XReplyEditor;
    function unmount() {
      if (!current) return;
      const s = current;
      current = null;
      s.listeners.abort();
      s.row.remove();
      if (s.pending) void message({type:"AI_CANCEL",ids:[s.pending]}).catch(()=>{});
    }
    function refresh() {
      const target = connected() && composer();
      if (current && target?.editor === current.editor && target.toolbar === current.toolbar && current.row.isConnected) return;
      unmount();
      if (!target) return;
      const row = document.createElement("div"), select = document.createElement("select"), status = document.createElement("span");
      row.className = "xrc-post-translate";
      select.setAttribute("aria-label","转换发帖语言");
      select.title = "用创作台的成稿模型翻译正文";
      select.add(new Option("转换",""));
      select.options[0].disabled = true;
      select.add(new Option("转成日语","ja"));
      select.add(new Option("转成英语","en"));
      select.value = "";
      status.setAttribute("role","status");
      row.append(select,status);
      target.toolbar.before(row);
      const s = current = {...target,row,pending:"",revision:0,listeners:new AbortController()};
      const options = {signal:s.listeners.signal};
      s.editor.addEventListener("input",()=>{s.revision++;},options);
      s.editor.addEventListener("compositionstart",()=>{s.revision++;},options);
      select.addEventListener("change",async()=>{
        const language = select.value;
        select.value = "";
        if (!language || s.pending) return;
        const original = edit.readDraft(s.editor), revision = s.revision, account = accountHandle();
        if (!original.trim()) { status.textContent = "先输入要翻译的正文"; return; }
        const valid = () => current === s && connected() && !document.hidden && accountHandle() === account &&
          composer()?.editor === s.editor && s.revision === revision;
        const id = crypto.randomUUID();
        s.pending = id;
        select.disabled = true;
        status.textContent = "正在翻译…";
        try {
          const result = await message({type:"AI_REQUEST",kind:"translate",id,language,post:original,draft:""});
          if (!result?.ok) throw new Error(result?.error || "转换已取消");
          if (!valid() || edit.readDraft(s.editor) !== original) {status.textContent = "草稿或页面已变化，保留当前正文";return;}
          const ok = await edit.write(s.editor,result.text,{replace:true,readText:edit.readDraft,expected:original,valid,signal:s.listeners.signal});
          status.textContent = ok ? "已转换，可继续编辑" : "未能确认译文已写入，请核对正文";
        } catch (error) { status.textContent = error.message; }
        finally { s.pending = ""; select.disabled = false; }
      },options);
    }
    window.addEventListener("pagehide",unmount);
    return {refresh};
  }
  globalThis.XReplyPostTranslate = {create};
})();
