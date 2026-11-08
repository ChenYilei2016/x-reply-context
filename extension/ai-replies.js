(() => {
  "use strict";
  const EDITOR = '[role="dialog"] [contenteditable="true"][data-testid="tweetTextarea_0"]';
  function create({accountHandle,connected,message,requestRefresh,rootOwnership=()=>"unknown",recommendedReply=()=>null,canAutoFillUnfocused=()=>false,onAutoFillBlocked=()=>{},interactionBlocked=()=>false}) {
    const edit = globalThis.XReplyEditor;
    let enabled = false, autoComplete = false, current, target, notice, configEpoch = 0;
    let fillRecommended = false;
    const autoPreparations = new WeakMap();
    const attachment = '[data-testid="attachments"],[data-testid="mediaPreview"],[data-testid="pollOption_0"]';
    let typingDelayMin=35,typingDelayMax=100;
    const pausedEditors=new WeakSet();
    let previews = new WeakMap(), conflicts = new WeakSet();
    const textOf = node => node?.innerText.trim() || "";
    function hidePreview(s) {
      s?.ghost?.remove();
      s?.root?.classList.remove("xrc-ai-preview");
      if (s) {s.ghost = null;s.drawn = "";}
    }
    function toast(text) {
      if (!notice) {
        notice = document.createElement("aside"); notice.className = "xrc-ai-notice"; notice.setAttribute("role","status");
        const label = document.createElement("span"), settings = document.createElement("button"), close = document.createElement("button");
        settings.type = close.type = "button"; settings.textContent = "AI 设置"; close.textContent = "×"; close.setAttribute("aria-label","关闭 AI 提示");
        settings.addEventListener("click",() => {void message({type:"AI_OPEN_SETTINGS"}).catch(()=>{});});
        close.addEventListener("click",() => {notice.hidden=true;});
        notice.append(label,settings,close); document.body.append(notice);
      }
      notice.querySelector("span").textContent = text; notice.hidden = false;
    }
    function valid(s) {
      return !interactionBlocked() && connected() && enabled && current === s && s.epoch === configEpoch && s.editor.isConnected &&
        accountHandle() === s.account && document.querySelector(EDITOR) === s.editor &&
        (!s.quote || s.quote.isConnected && s.quote.textContent === s.quoteText);
    }
    function cancelRequests(s) {
      if (!s?.pending.size) return;
      const ids = [...s.pending]; s.pending.clear();
      void message({type:"AI_CANCEL",ids}).catch(()=>{});
    }
    function stop() {
      const old = current; current = undefined;
      if (old) {
        previews.set(old.editor,{account:old.account,post:old.post,targetId:old.targetId,epoch:old.epoch,candidates:[...old.candidates],index:old.index,
          retry:!old.candidates.length && old.pending.size > 0,error:old.error});
        cancelRequests(old);hidePreview(old);clearTimeout(old.timer);old.wake?.();
      }
      target=undefined;
      if (notice) notice.hidden=true;
      requestRefresh();
    }
    function pause() {
      const editor=current?.editor || document.querySelector(EDITOR);
      if(editor){
        pausedEditors.add(editor);
        const reply=current?.autoReply || recommendedReply(editor);
        if(reply){
          const preparation=autoPreparations.get(reply) || {partial:""};
          preparation.paused=true;
          const draft=edit.read(editor);
          if(current?.autoExpected!==undefined && draft && draft!==current.autoExpected)preparation.partial=draft;
          autoPreparations.set(reply,preparation);
        }
      }
      if(current)stop();
      if(editor)previews.delete(editor);
    }
    // Continue uses the live reply and editor, never a snapshot of an old DOM node.
    function resumeAutomatic(editor) {
      if(interactionBlocked() || !connected() || document.hidden || !editor?.isConnected || document.querySelector(EDITOR)!==editor)
        return "当前回复框不可用，请核对页面后继续。";
      const reply=recommendedReply(editor);
      if(!reply)return "尚未确认当前回复对象，请重新打开回复框。";
      if(current?.composing || current?.writing || current?.rewriting || current?.recommending || current?.pending.size || edit.busy(editor))
        return "AI 或编辑操作尚未完成，请稍后再继续。";
      const draft=edit.read(editor),preparation=autoPreparations.get(reply);
      if(draft && preparation?.partial===draft)return "AI 只填入了部分内容，请先核对并编辑，或清空后再继续。";
      if(draft.trim()){
        pausedEditors.delete(editor);if(preparation)preparation.paused=false;requestRefresh();return "";
      }
      if(!enabled || !fillRecommended)return "空草稿尚未准备：请开启 AI 自动填入，或先手动写好回复。";
      if(conflict())return "检测到其他回复插件，请先停用后再继续。";
      if(editor.closest('[role="dialog"]')?.querySelector(attachment))return "请先手动处理附件或投票，再继续本轮。";
      // Explicit Continue gets one fresh attempt, including when X replaced the editor.
      if(current)stop();
      pausedEditors.delete(editor);previews.delete(editor);autoPreparations.delete(reply);
      refresh();
      if(current?.editor===editor && current.autoReply===reply && current.recommending)return "";
      pausedEditors.add(editor);autoPreparations.set(reply,{paused:true,partial:""});
      return "AI 未能开始准备草稿，请检查帖子文字或手动推荐后继续。";
    }
    function prepareAutomatic(s) {
      const reply=fillRecommended && recommendedReply(s.editor);
      if(!reply)return false;
      s.autoReply=reply;
      const previous=autoPreparations.get(reply);
      if(previous){
        if(!previous.paused && !edit.read(s.editor).trim()){
          previous.paused=true;
          autoFillBlocked(s,"AI 准备已中断或输入框已重建，请手动推荐或重新开始；不会自动重试。");
        }
        return true;
      }
      autoPreparations.set(reply,{paused:false,partial:""});
      if(!edit.read(s.editor).trim() && !s.dialog.querySelector(attachment))void applyRecommendation(s,true);
      return true;
    }
    function conflict() { return Boolean(document.querySelector('#xreply-ghost') || document.querySelector('#xreply-toast:not([style*="display: none"])')); }
    function draw(s) {
      if (!autoComplete || s.autoReply || !valid(s) || s.writing || s.rewriting || s.recommending) {hidePreview(s);return;}
      const draft = edit.read(s.editor), candidate = s.candidates[s.index] || "";
      const suggestion = candidate.startsWith(draft) ? candidate.slice(draft.length) : "";
      const label = suggestion || (!draft && s.pending.size ? "生成中…" : "");
      if (!label) {hidePreview(s);return;}
      const signature = `${draft}\u0000${label}`;
      if (s.drawn === signature && s.ghost?.isConnected) return;
      if (!s.ghost) {
        s.ghost = document.createElement("div"); s.ghost.className = "xrc-ai-ghost"; s.ghost.setAttribute("aria-hidden","true");
        const style = getComputedStyle(s.editor);
        for (const key of ["fontFamily","fontSize","fontWeight","lineHeight","letterSpacing"]) s.ghost.style[key]=style[key];
        s.root.classList.add("xrc-ai-preview");s.root.append(s.ghost);
      }
      s.ghost.replaceChildren();
      if (draft) {const prefix=document.createElement("span");prefix.textContent=draft;prefix.style.color="transparent";s.ghost.append(prefix);}
      s.ghost.append(document.createTextNode(label));s.drawn=signature;
    }
    async function request(s,kind,draft = "") {
      if(!valid(s))return {ok:false,cancelled:true};
      const id = crypto.randomUUID();s.pending.add(id);requestRefresh();
      try {return await message({type:"AI_REQUEST",id,kind,post:s.post,draft,rootOwnership:rootOwnership(s.editor)});}
      catch(error) {return {ok:false,error:error.message};}
      finally {s.pending.delete(id);requestRefresh();}
    }
    function generate(s) {
      if (!autoComplete || s.autoReply || !valid(s) || edit.read(s.editor) || s.pending.size >= 3) return;
      void request(s,"generate").then(result => {
        if (!valid(s) || edit.read(s.editor) || s.writing || s.rewriting) return;
        if (result.ok) {
          s.candidates.push(result.text);
          if (s.candidates.length > 32) {s.candidates.shift();s.index=Math.max(0,s.index-1);}
        } else if (!result.cancelled) s.error=result.error;
        if (!s.pending.size && !s.candidates.length && s.error) toast(`AI：${s.error}`);
        draw(s);
      });
      draw(s);
    }
    function refresh() {
      if (interactionBlocked()) {pause();return;}
      if (!enabled || !connected() || document.hidden) return;
      const editor = document.querySelector(EDITOR);
      if (current && (current.editor !== editor || current.account !== accountHandle() ||
          current.quote && (!current.quote.isConnected || current.quote.textContent !== current.quoteText))) {
        const nextTarget=target;stop();target=nextTarget;
      }
      if (!editor) return;
      if (conflict()) {
        if (current) stop();
        if (!conflicts.has(editor)) {conflicts.add(editor);toast("检测到 XReply，请先停用它再使用内置 AI，避免重复处理。");}
        return;
      }
      if (current) {
        const root=editor.closest('.DraftEditor-root');
        if (root && root!==current.root) {hidePreview(current);current.root=root;draw(current);}
        return; // Input/results update only this editor; no per-frame history/DOM scan.
      }
      const dialog = editor.closest('[role="dialog"]'), root = editor.closest('.DraftEditor-root');
      if (!root || !dialog?.querySelector('[data-testid="tweetButton"]')) return;
      const quote = dialog.querySelector('[data-testid="tweetText"]');
      const post = textOf(quote);
      const account = accountHandle();
      if (!post || !account) return;
      const cached=previews.get(editor);
      const reuse=cached?.account===account && cached.post===post && (!target || cached.targetId===target.id) && cached.epoch===configEpoch;
      const s = current = {editor,dialog,root,post,account,targetId:target?.id || "",quote,quoteText:quote?.textContent,epoch:configEpoch,pending:new Set(),
        candidates:reuse?[...cached.candidates]:[],index:reuse?cached.index:0,version:0,writing:false,rewriting:false,composing:false};
      target=undefined;
      if(pausedEditors.has(editor))return; // Acknowledgement alone must not restart generation in the old composer.
      if(prepareAutomatic(s))return;
      if (autoComplete && !edit.read(editor) && (!reuse || cached.retry)) for(let index=0;index<3;index++) generate(s);
      else {draw(s);if(reuse && cached.error && !s.candidates.length)toast(`AI：${cached.error}`);}
    }
    function autoFillBlocked(s,text) {
      toast(text);
      onAutoFillBlocked(s.editor,text);
    }
    function canAutoFill(s) {
      const focusAllowed=document.activeElement===s.editor ||
        document.hasFocus && !document.hasFocus() && canAutoFillUnfocused(s.editor);
      return !document.hidden && focusAllowed &&
        recommendedReply(s.editor) === s.autoReply &&
        !s.dialog.querySelector(attachment);
    }
    async function recommend(editor) {
      if (interactionBlocked())return;
      if (!connected()) return;
      if (!enabled) {toast("请先在 AI 设置中配置并开启 API；自动补全可保持关闭。");return;}
      refresh();
      const s=current;
      if (!s || s.editor!==editor || !valid(s)) {toast("未找到当前回复文字，请从帖子重新打开回复框。");return;}
      await applyRecommendation(s);
    }
    async function applyRecommendation(s,automatic=false) {
      if(!valid(s))return;
      const {editor}=s;
      if (s.writing || s.rewriting || s.recommending || s.composing || edit.busy(editor)) return;
      const before=edit.read(editor), version=s.version;
      s.recommending=true;cancelRequests(s);hidePreview(s);requestRefresh();
      try {
        const result=await request(s,"generate");
        if (!valid(s)) return;
        if(automatic && !canAutoFill(s)){
          autoFillBlocked(s,"AI 已返回，但当前焦点或回复条件不允许填入；请核对后手动继续。");return;
        }
        if (s.version!==version || edit.read(editor)!==before) {
          const text="草稿已变化，保留你的新内容；本次推荐未填入。";
          if(automatic)autoFillBlocked(s,text);else toast(text);
          return;
        }
        if (!result.ok) {
          if(!result.cancelled){const text=`AI：${result.error}`;if(automatic)autoFillBlocked(s,text);else toast(text);}
          return;
        }
        s.writing=true;
        requestRefresh();
        if (automatic) {
          s.autoExpected=before+result.text;
          const complete=await typeDraft(s,result.text,before,{automatic:true});
          if(!complete && valid(s))autoFillBlocked(s,"AI 填入未完成，已保留当前文字；请检查后手动继续，不会自动重试。");
          return;
        }
        const value=(before && !/\s$/.test(before)?" ":"")+result.text;
        const ok=await edit.write(editor,value,{expected:before,valid:()=>valid(s)&&s.version===version&&!s.composing});
        if (!ok && valid(s)) toast("推荐未完整填入，请核对草稿；不会自动重试。");
      } catch {if(valid(s)){const text="推荐未填入，请检查草稿后重试。";if(automatic)autoFillBlocked(s,text);else toast(text);}}
      finally {s.autoExpected=undefined;s.writing=false;s.recommending=false;requestRefresh();}
    }
    async function adopt(s) {
      if (!valid(s) || s.writing || s.rewriting || s.recommending || s.composing) return;
      const before = edit.read(s.editor), full = s.candidates[s.index];
      if (!full?.startsWith(before) || full===before) return;
      const suffix = full.slice(before.length);
      s.writing=true;cancelRequests(s);hidePreview(s);requestRefresh();
      try {await typeDraft(s,suffix,before);}
      catch {if(valid(s))toast("AI 填入已停止，请检查草稿后手动继续。");}
      finally {s.writing=false;requestRefresh();}
    }
    async function typeDraft(s,suffix,before,{automatic=false}={}) {
      const canType=()=>valid(s) && !s.composing && (automatic?canAutoFill(s):document.activeElement===s.editor);
      const characters=Array.from(suffix);
      let expected=before;
      for (let index=0;index<characters.length;index++) {
        let char=characters[index];
        while (char.endsWith("\n") && index+1<characters.length) char+=characters[++index];
        if (!canType() || edit.read(s.editor)!==expected) return false;
        const ok=await edit.write(s.editor,char,{expected,valid:canType});
        if (!ok) {if(canType()&&!automatic)toast("AI 填入已停止，请核对草稿；不会重复填入。");return false;}
        expected+=char;
        if (current !== s) return false;
        await new Promise(resolve=>{s.wake=resolve;s.timer=setTimeout(resolve,typingDelayMin+Math.random()*(typingDelayMax-typingDelayMin));});s.wake=null;
      }
      return true;
    }
    async function rewrite(s) {
      const before = edit.read(s.editor), version=s.version;
      if (!before.trim() || s.writing || s.rewriting || s.recommending || s.composing) return;
      s.rewriting=true;cancelRequests(s);hidePreview(s);toast("改写中…");requestRefresh();
      try {
        const result=await request(s,"rewrite",before);
        if (!valid(s)) return;
        if (s.version!==version || edit.read(s.editor)!==before) {toast("草稿已变化，保留你的新内容；本次改写未应用。");return;}
        if (!result.ok) {if(!result.cancelled)toast(`AI：${result.error}`);return;}
        s.writing=true;
        const ok=await edit.write(s.editor,result.text,{replace:true,expected:before,valid:()=>valid(s)&&s.version===version&&!s.composing});
        if (!ok) toast("改写未完整应用，请检查草稿；不会自动重试。");
        else if(notice)notice.hidden=true;
      } catch {if(valid(s))toast("改写未应用，请检查草稿后手动继续。");}
      finally {s.writing=false;s.rewriting=false;requestRefresh();}
    }
    document.addEventListener("click",event=>{
      if (!enabled || interactionBlocked()) return;
      const node=event.target instanceof Element?event.target:event.target?.parentElement;
      const article=node?.closest('[data-testid="reply"]')?.closest('article[data-testid="tweet"]');
      if (node?.closest('[data-testid="tweetButton"]') && current && (current.writing || current.rewriting || current.recommending)) {
        event.preventDefault();event.stopImmediatePropagation();toast("请等待生成、填入或改写完成，再确认发送。");return;
      }
      if (article && !article.closest('[role="dialog"]')) {
        const editor=document.querySelector(EDITOR);if(editor)pausedEditors.delete(editor);
        if (current) stop(); // A new reply action invalidates even a reused editor with identical text.
        target={id:article.querySelector('time')?.closest('a')?.getAttribute('href') || ""};
      }
      if (node?.closest('[data-testid="app-bar-close"]') && current) stop();
    },true);
    document.addEventListener("input",event=>{
      const s=current;if(!s || event.target!==s.editor)return;
      s.version++;
      if (s.writing || s.rewriting || s.recommending) return;
      if(edit.read(s.editor))cancelRequests(s);
      draw(s);
    },true);
    for(const name of ["compositionstart","compositionend"])document.addEventListener(name,event=>{
      const s=current;if(s && event.target===s.editor){s.composing=name==="compositionstart";if(s.composing)hidePreview(s);else draw(s);}
    },true);
    document.addEventListener("keydown",event=>{
      const plainTab = event.key === "Tab" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
      const replyEditor = event.target instanceof Element ? event.target.closest(EDITOR) : null;
      const composing = event.isComposing || event.keyCode === 229 || (current?.editor === replyEditor && current.composing);
      // Reserve plain Tab before AI readiness checks; pending/absent suggestions must not move focus.
      if (plainTab && replyEditor && !composing) event.preventDefault();
      if(interactionBlocked())return;
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && current &&
          event.target === current.editor && (current.writing || current.rewriting || current.recommending)) {
        event.preventDefault();event.stopImmediatePropagation();toast("请等待生成、填入或改写完成，再确认发送。");return;
      }
      if (!["Tab","ArrowUp","ArrowDown"].includes(event.key)) return;
      const s=current;if(!s || event.target!==s.editor || !valid(s) || composing || conflict())return;
      if(s.writing || s.rewriting || s.recommending || edit.busy(s.editor))return;
      if(event.key==="Tab" && event.altKey && edit.read(s.editor).trim()) {
        event.preventDefault();event.stopImmediatePropagation();void rewrite(s);return;
      }
      if(plainTab && s.ghost?.isConnected && s.candidates[s.index]?.startsWith(edit.read(s.editor))) {
        event.preventDefault();event.stopImmediatePropagation();void adopt(s);return;
      }
      if(["ArrowUp","ArrowDown"].includes(event.key) && !s.autoReply && !edit.read(s.editor) && s.candidates.length) {
        event.preventDefault();event.stopImmediatePropagation();
        s.index=Math.max(0,Math.min(s.candidates.length-1,s.index+(event.key==="ArrowDown"?1:-1)));
        draw(s);if(s.candidates.length-1-s.index+s.pending.size<1)generate(s);
      }
    },true);
    async function reload() {
      const epoch=++configEpoch;enabled=false;stop();previews=new WeakMap();conflicts=new WeakSet();
      try {
        const status=await message({type:"AI_STATUS"});
        if(epoch===configEpoch){
          enabled=status.enabled===true;autoComplete=status.autoComplete===true;fillRecommended=status.fillRecommended===true;
          typingDelayMin=status.typingDelayMin ?? 35;typingDelayMax=status.typingDelayMax ?? 100;
          requestRefresh();
        }
      }
      catch { /* Existing local features stay usable if AI settings are unavailable. */ }
    }
    chrome.storage.onChanged.addListener((changes,area)=>{if(area==="local" && (changes.aiConfig || changes.aiAutoComplete || changes.aiFillRecommended))void reload();});
    document.addEventListener("visibilitychange",()=>{if(document.hidden)stop();else requestRefresh();});
    window.addEventListener("pagehide",stop);
    void reload();
    return {refresh,stop,pause,resumeAutomatic,recommend,fillRecommendedEnabled:()=>enabled && fillRecommended,phase:editor=>{
      if(!enabled)return "";
      const paused=pausedEditors.has(editor)||autoPreparations.get(current?.editor===editor?current.autoReply:recommendedReply(editor))?.paused;
      if (!current || current.editor!==editor) return paused?"paused":"";
      if (current.writing) return "writing";
      if (current.rewriting) return "rewriting";
      return current.recommending || current.pending.size ? "generating" : paused?"paused":"";
    },busy:editor=>Boolean(current && current.editor===editor&&(current.writing||current.rewriting||current.recommending))};
  }
  globalThis.XReplyAIReplies={create};
})();
