(() => {
  "use strict";
  const COMPOSER = '[role="dialog"]';
  const EDITOR = '[contenteditable="true"][data-testid="tweetTextarea_0"]';
  const SEND = '[data-testid="tweetButton"]';
  const CLOSE = '[data-testid="app-bar-close"]';
  const PRIMARY_COLUMN = '[data-testid="primaryColumn"]';
  const visible = node => {
    const box = node?.getBoundingClientRect();
    return Boolean(box?.width && box.height && getComputedStyle(node).visibility !== "hidden");
  };
  const enabled = node => node && !node.disabled && node.getAttribute("aria-disabled") !== "true";
  const eligible = (row,feed) => row && !row.evidenceId &&
    (feed === "home" && row.status === "not-reply" ? row.origin !== "mine" :
      !["replied","self","not-reply"].includes(row.status));

  function create({ accountHandle,tweetId,columnSelector,message }) {
    let session;
    let notice;
    let noticeTimer;
    let internalClose = false;
    let openingId = "";
    let rewriteNode;
    let rewriteWatch;

    function composer() {
      return Array.from(document.querySelectorAll(COMPOSER))
        .find(node => visible(node) && node.querySelector(EDITOR) && node.querySelector(SEND));
    }

    function feedColumn(s) {
      return document.querySelector(s.feed === "home" ? PRIMARY_COLUMN : columnSelector);
    }

    function articles(s) {
      const column = feedColumn(s);
      return Array.from(column?.querySelectorAll('article[data-testid="tweet"]') || [])
        .filter(article => !article.closest(COMPOSER));
    }

    function nativeHeart(s) {
      const article = articles(s).find(node => tweetId(node) === s.current.id);
      return Array.from(article?.querySelectorAll('[data-testid="like"],[data-testid="unlike"]') || [])
        .find(button => button.closest('article[data-testid="tweet"]') === article);
    }

    function toggleHeart(s) {
      if (!currentSession(s) || !["ready","failed"].includes(s.phase)) return;
      const heart = nativeHeart(s);
      if (!enabled(heart)) return;
      // Only this explicit click invokes X's native control; its response uses the existing save path.
      heart.click();
      refresh();
    }

    function clearNotice() {
      clearTimeout(noticeTimer);
      notice?.remove();
      notice = null;
    }

    function showNotice(text,action,temporary = false) {
      clearNotice();
      notice = document.createElement("aside");
      notice.className = "xrc-flow-notice";
      notice.setAttribute("role","status");
      const label = document.createElement("span");
      label.textContent = text;
      notice.append(label);
      if (action) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = action.label;
        button.addEventListener("click",event => { event.stopPropagation(); action.run(); });
        notice.append(button);
      }
      if (session && action?.label !== "结束连续回复") {
        const close = document.createElement("button");
        close.type = "button";
        close.textContent = "×";
        close.setAttribute("aria-label","结束连续回复");
        close.addEventListener("click",() => finish());
        notice.append(close);
      }
      document.body.append(notice);
      if (temporary) noticeTimer = setTimeout(clearNotice,8000);
    }

    function finish(text = "") {
      const previous = session;
      session = undefined;
      openingId = "";
      clearTimeout(previous?.timeout);
      rewriteWatch?.disconnect();
      rewriteWatch = undefined;
      rewriteNode = undefined;
      document.querySelectorAll(".xrc-continuous").forEach(node => node.remove());
      clearNotice();
      if (text) showNotice(text,null,true);
    }

    function currentSession(s) {
      if (session !== s || accountHandle() !== s.account || !feedColumn(s)) return false;
      if (s.feed === "home") {
        if (!/^\/(?:home|compose)(?:\/|$)/.test(location.pathname)) return false;
        const tabs = [...feedColumn(s).querySelectorAll('[role="tab"]')];
        const selected = tabs.find(tab => tab.getAttribute("aria-selected") === "true");
        return tabs.length > 0 && (!selected || selected === tabs[0]);
      }
      return /^\/(?:notifications|compose)(?:\/|$)/.test(location.pathname);
    }

    function entryFeed(article) {
      if (article.closest(COMPOSER)) return "";
      if (/^\/notifications(?:\/|$)/.test(location.pathname) && article.closest(columnSelector)) return "notifications";
      if (!/^\/home\/?$/.test(location.pathname)) return "";
      const firstTab = article.closest(PRIMARY_COLUMN)?.querySelector('[role="tab"]');
      // The real home tabs can be DIVs; only the first (For you) tab starts this flow.
      return firstTab?.getAttribute("aria-selected") === "true" &&
        !firstTab.getAttribute("href")?.startsWith("/notifications") ? "home" : "";
    }

    function start(article,feed) {
      const id = tweetId(article);
      const account = accountHandle();
      if (!id || !account) return;
      finish();
      session = {
        account,feed,handled:new Set(),current:{ id },phase:"ready",
        note:"从当前页选择，略过已回复。",attempt:null
      };
      refresh();
    }

    function hasDraft(dialog) {
      return Boolean(dialog.querySelector(EDITOR)?.innerText.trim() ||
        dialog.querySelector('[data-testid="attachments"],[data-testid="mediaPreview"],[data-testid="pollOption_0"]'));
    }

    function draftBusy(s) {
      const editor = s.current.dialog?.querySelector(EDITOR);
      if (s.current.fillingText !== undefined && editor?.innerText.replace(/\n$/,"") === s.current.fillingText) {
        delete s.current.fillingText;
      }
      const rewrite = document.querySelector("#xreply-toast");
      if (rewrite !== rewriteNode) {
        rewriteWatch?.disconnect();
        rewriteNode = rewrite;
        if (rewrite) {
          rewriteWatch = new MutationObserver(refresh);
          rewriteWatch.observe(rewrite,{ attributes:true,attributeFilter:["style"],childList:true,subtree:true });
        }
      }
      return s.current.fillingText !== undefined ||
        (visible(rewrite) && /^改写中/.test(rewrite.innerText.trim()));
    }

    function closeForNext(s) {
      if (draftBusy(s)) { render(s); return; }
      const dialog = s.current.dialog;
      const close = dialog?.querySelector(CLOSE);
      if (!enabled(close)) {
        s.note = "未找到关闭按钮，请手动关闭回复框后重新开始。";
        render(s);
        return;
      }
      s.hadDraft = hasDraft(dialog);
      s.saveClicked = false;
      s.phase = "closing";
      s.note = s.hadDraft ? "正在保存 X 草稿并跳过…" : "正在进入下一条…";
      render(s);
      internalClose = true;
      try { close.click(); } finally { internalClose = false; }
      refresh();
    }

    function saveDraftIfAsked(s) {
      const dialogs = Array.from(document.querySelectorAll(
        '[data-testid="confirmationSheetDialog"],[role="dialog"],[role="alertdialog"]'));
      for (const dialog of dialogs) {
        if (!visible(dialog) || dialog.querySelector(EDITOR)) continue;
        if (!/草稿|帖子|推文|貼文|draft|post|tweet/i.test(dialog.innerText)) continue;
        const save = Array.from(dialog.querySelectorAll('button,[role="button"]')).find(button =>
          visible(button) && /^(保存|保存草稿|儲存|儲存草稿|Save|Save draft)$/i.test(button.innerText.trim()));
        if (enabled(save) && s.saveButton !== save) {
          s.saveButton = save;
          s.saveClicked = true;
          save.click();
        }
        return true;
      }
      return false;
    }

    async function advance(s) {
      if (!currentSession(s) || s.phase === "advancing") return;
      s.handled.add(s.current.id);
      await selectNext(s);
    }

    async function selectNext(s) {
      if (!currentSession(s) || s.phase === "advancing") return;
      s.phase = "advancing";
      clearTimeout(s.timeout);
      s.attempt = null;
      s.current.dialog?.querySelector(".xrc-continuous")?.remove();
      clearNotice();
      try {
        const candidates = [...new Map(articles(s).map(article => [tweetId(article),article]))]
          .filter(([id,article]) => id && !s.handled.has(id) && enabled(article.querySelector('[data-testid="reply"]')));
        let nextId = "";
        // Only inspect mounted cards; classify locally in bounded batches.
        for (let offset = 0; offset < candidates.length && !nextId; offset += 100) {
          const batch = candidates.slice(offset,offset+100);
          const result = await message({ type:"CLASSIFY",account:s.account,ids:batch.map(([id]) => id) });
          if (!currentSession(s)) return;
          const byId = new Map(result.rows.map(row => [row.id,row]));
          nextId = batch.find(([id,article]) => article.isConnected && tweetId(article) === id &&
            eligible(byId.get(id),s.feed) && enabled(article.querySelector('[data-testid="reply"]')))?.[0] || "";
        }
        if (!nextId) {
          finish(`当前已加载的${s.feed === "home" ? "主页帖子" : "通知"}处理完成。加载更多后，从任一条继续。`);
          return;
        }
        s.current = { id:nextId };
        s.phase = "opening";
        s.note = s.saveClicked ? "上一条已保存到 X 草稿。" : "从当前页选择，略过已回复。";
        openCurrent(s);
      } catch (error) {
        if (session === s) {
          s.phase = "paused";
          showNotice(error.message,{ label:"结束连续回复",run:() => finish() });
        }
      }
    }

    function openCurrent(s) {
      if (!currentSession(s)) return;
      const article = articles(s).find(node => tweetId(node) === s.current.id);
      const reply = article?.querySelector('[data-testid="reply"]');
      if (!enabled(reply)) {
        s.phase = "paused";
        showNotice("这条内容已移出页面，可继续选择其他已加载内容。",{
          label:"继续下一条",run:() => selectNext(s)
        });
        return;
      }
      clearNotice();
      openingId = s.current.id;
      article.scrollIntoView({ block:"nearest",behavior:"instant" });
      reply.click();
      openingId = "";
      s.timeout = setTimeout(() => {
        if (session === s && s.phase === "opening") finish("未能打开下一条，请从列表重新开始。");
      },8000);
    }

    function sendNext(s) {
      if (!currentSession(s)) return;
      if (draftBusy(s)) { render(s); return; }
      if (s.phase === "sent") { closeForNext(s); return; }
      const dialog = s.current.dialog;
      const submit = dialog?.querySelector(SEND);
      if (!["ready","failed"].includes(s.phase) || !enabled(submit) || !singleReply(dialog)) return;
      s.saveClicked = false;
      s.attempt = { parentId:s.current.id,clickedAt:Date.now(),requestId:"" };
      s.phase = "sending";
      s.note = "发送中，确认成功后进入下一条…";
      render(s);
      s.timeout = setTimeout(() => {
        if (session !== s || s.phase !== "sending") return;
        s.phase = "uncertain";
        s.note = "暂未确认发送结果，请先核对；不会重复发送。";
        render(s);
        if (!composer()) showNotice(s.note,{ label:"结束连续回复",run:() => finish() });
      },30000);
      // Use the native composer, including its validation, attachments and current text.
      submit.click();
    }

    function singleReply(dialog) {
      return dialog && dialog.querySelectorAll('[contenteditable="true"][data-testid^="tweetTextarea_"]').length === 1;
    }

    function render(s) {
      const dialog = s.current.dialog;
      if (!dialog?.isConnected) return;
      // X's outer dialog is transparent; keep our controls in its native footer.
      const nativeToolbar = dialog.querySelector(SEND)?.closest('[data-testid="toolBar"]');
      if (!nativeToolbar) return;
      let bar = dialog.querySelector(".xrc-continuous");
      if (!bar) {
        bar = document.createElement("div");
        bar.className = "xrc-continuous";
        bar.setAttribute("aria-label","连续回复");
        bar.addEventListener("click",event => event.stopPropagation());
        const status = document.createElement("span");
        status.className = "xrc-flow-status";
        status.setAttribute("role","status");
        const skip = document.createElement("button");
        skip.type = "button";
        skip.className = "xrc-flow-skip";
        skip.textContent = "跳过";
        skip.title = "只跳过本轮；未发送内容优先保存到 X 草稿，不标记已回复。";
        skip.addEventListener("click",() => closeForNext(s));
        const heart = document.createElement("button");
        heart.type = "button";
        heart.className = "xrc-flow-heart";
        heart.addEventListener("click",() => toggleHeart(s));
        const send = document.createElement("button");
        send.type = "button";
        send.className = "xrc-flow-send";
        send.addEventListener("click",() => sendNext(s));
        bar.append(status,heart,skip,send);
      }
      if (nativeToolbar.nextElementSibling !== bar) nativeToolbar.after(bar);
      const busy = draftBusy(s);
      const statusText = `${s.feed === "home" ? "主页 · " : ""}已处理 ${s.handled.size} 条 · ${busy ? "回复正在填入或改写，完成后可继续。" : s.note}`;
      const status = bar.querySelector(".xrc-flow-status");
      if (status.textContent !== statusText) status.textContent = statusText;
      const canAct = ["ready","failed"].includes(s.phase);
      const native = nativeHeart(s);
      const heart = bar.querySelector(".xrc-flow-heart");
      const liked = native?.getAttribute("data-testid") === "unlike";
      const heartText = native ? liked ? "♥ 已点" : "♡ 点赞" : "♡ 不可用";
      if (heart.textContent !== heartText) heart.textContent = heartText;
      const pressed = String(liked);
      if (heart.getAttribute("aria-pressed") !== pressed) heart.setAttribute("aria-pressed",pressed);
      heart.disabled = !canAct || !enabled(native);
      heart.title = native ?
        `${liked ? "取消" : "给"}当前正在回复的这条帖子${liked ? "的点赞" : "点赞"}，不影响文字回复或下一条；结果以 X 原生状态为准。` :
        "当前帖子已移出列表或缺少原生红心控件，请关闭回复框后从列表重新打开。";
      bar.querySelector(".xrc-flow-skip").disabled = !canAct || busy;
      const send = bar.querySelector(".xrc-flow-send");
      const sendText = s.phase === "sent" ? "下一条" : s.phase === "sending" ? "发送中…" : "发送并下一条";
      if (send.textContent !== sendText) send.textContent = sendText;
      send.disabled = busy || (s.phase !== "sent" && (!canAct || !enabled(dialog.querySelector(SEND)) || !singleReply(dialog)));
      send.title = singleReply(dialog) ? "确认本条发送成功后进入下一条。" : "请先完成多条帖子编辑，再使用连续回复。";
    }

    function refresh() {
      const s = session;
      if (!s) return;
      if (!currentSession(s)) { finish(); return; }
      const dialog = composer();
      if (s.phase === "closing") {
        const savingDraft = saveDraftIfAsked(s);
        if (savingDraft) return;
        if (!dialog) {
          if (s.hadDraft && !s.saveClicked) {
            s.phase = "draft-check";
            showNotice("未确认 X 是否保存了草稿，请核对后再继续。",{
              label:"已确认，继续下一条",run:() => advance(s)
            });
          } else void advance(s);
        }
        return;
      }
      if (s.phase === "advancing" || s.phase === "paused" || s.phase === "draft-check") return;
      if (dialog && !s.current.dialog) {
        s.current.dialog = dialog;
        if (s.phase === "opening") { clearTimeout(s.timeout); s.phase = "ready"; }
      } else if (!dialog && s.current.dialog) {
        if (s.phase === "sent" && s.autoAdvance) { void advance(s); return; }
        if (["sending","uncertain","sent"].includes(s.phase)) {
          if (!notice) showNotice(s.note,{ label:s.phase === "sent" ? "下一条" : "结束连续回复",
            run:() => s.phase === "sent" ? advance(s) : finish() });
          return;
        }
        finish();
        return;
      } else if (dialog && s.current.dialog !== dialog) { finish(); return; }
      render(s);
    }

    async function receiveReply(data,saved) {
      const s = session;
      const attempt = s?.attempt;
      if (!s || !attempt || !currentSession(s) || data.account !== s.account ||
          data.parentId !== attempt.parentId || !Number.isFinite(data.startedAt) ||
          data.startedAt < attempt.clickedAt || typeof data.requestId !== "string" || data.requestId.length > 80) return;
      if (data.type === "REPLY_STARTED") {
        if (!attempt.requestId) attempt.requestId = data.requestId;
        return;
      }
      if (data.type !== "REPLY_RESULT" || !attempt.requestId || data.requestId !== attempt.requestId || attempt.settled) return;
      if (!["sent","failed","unknown"].includes(data.status)) return;
      if (data.status !== "sent") {
        clearTimeout(s.timeout);
        attempt.settled = true;
        s.phase = data.status === "failed" ? "failed" : "uncertain";
        s.note = s.phase === "failed" ? "发送失败，内容留在原处；可修改后重试。" : "发送结果未确认，请先核对；不会自动重发。";
        render(s);
        if (!composer()) showNotice(s.note,{ label:"结束连续回复",run:() => finish() });
        return;
      }
      const tweet = data.batch?.tweets?.[0];
      const user = data.batch?.users?.[0];
      if (!tweet || tweet.parentId !== s.current.id || !user || user.handle !== s.account || tweet.authorId !== user.id) return;
      if (!saved) return;
      clearTimeout(s.timeout);
      attempt.settled = true;
      const autoAdvance = s.phase === "sending";
      // Persist before filtering the next cards, so the same conversation is skipped correctly.
      try {
        await saved;
        if (!currentSession(s) || s.attempt !== attempt) return;
        s.phase = "sent";
        s.autoAdvance = autoAdvance;
        s.note = autoAdvance ? "已发送，正在进入下一条…" : "已确认发送成功，点击下一条继续。";
        refresh();
      } catch {
        if (session !== s) return;
        s.phase = "uncertain";
        s.note = "回复已发送，但本地记录未保存。请勿重复发送，刷新 X 后继续。";
        render(s);
        if (!composer()) showNotice(s.note,{ label:"结束连续回复",run:() => finish() });
      }
    }

    document.addEventListener("click",event => {
      const target = event.target instanceof Element ? event.target : event.target?.parentElement;
      const close = target?.closest(CLOSE);
      if (close && session && !internalClose && close.closest(COMPOSER) === composer()) { finish(); return; }
      const reply = target?.closest('[data-testid="reply"]');
      const article = reply?.closest('article[data-testid="tweet"]');
      if (!article) return;
      const feed = entryFeed(article);
      if (!feed) return;
      if (openingId && tweetId(article) === openingId) return;
      start(article,feed);
    },true);
    document.addEventListener("input",refresh);
    document.addEventListener("keydown",event => {
      const editor = event.target instanceof Element ? event.target.closest(EDITOR) : null;
      if (event.key === "Tab" && !event.altKey && session && editor && session.current.dialog?.contains(editor)) {
        const suggestion = editor.closest(".DraftEditor-root")?.querySelector("#xreply-ghost")?.dataset.suggestion;
        if (suggestion) {
          // XReply can retarget its unfinished typing to a new editor; wait for this draft to finish.
          session.current.fillingText = editor.innerText.replace(/\n$/,"") + suggestion;
          render(session);
        }
      }
      if (event.key === "Escape" && !event.isComposing && session) {
        const s = session;
        requestAnimationFrame(() => { if (session === s && !composer()) finish(); });
      }
    },true);
    return { refresh,receiveReply };
  }

  globalThis.XReplyContinuous = { create };
})();
