import { users,post,graphql,demoTweets } from "./fixtures.mjs";

export function installComposerDemo({ state,core,addNotification }) {
  const drafts = new Map();
  const originalFetch = window.fetch;
  let sequence = 0;
  let requests = 0;
  let sent = 0;
  let dialog;
  const evidence = document.querySelector("#composer-evidence");
  let returnPath;
  let sourceTab;
  const updateEvidence = () => {
    evidence.textContent = `模拟请求 ${requests} 次 · 成功 ${sent} 次 · 草稿 ${drafts.size} 条`;
    evidence.dataset.drafts = JSON.stringify([...drafts].map(([id,text]) => ({ id,text })));
    evidence.dataset.requests = String(requests);
    evidence.dataset.sent = String(sent);
  };
  updateEvidence();

  window.fetch = async function (url,options) {
    if (!/\/i\/api\/graphql\/demo\/Create(?:Note)?Tweet$/.test(String(url))) return originalFetch(url,options);
    requests++;
    updateEvidence();
    const variables = JSON.parse(options.body).variables;
    const target = state.tweets[variables.reply.in_reply_to_tweet_id];
    const mode = document.querySelector("#reply-result-mode").value;
    if (mode === "new-message") {
      const incoming = post("2112500000000090001","303",demoTweets[9].id,demoTweets[9].id,"101","本轮处理中刚到的新通知");
      core.ingest(state,{ users,tweets:[incoming] },"my_account");
      addNotification(incoming,true);
    }
    await new Promise(resolve => setTimeout(resolve,mode === "delayed" ? 1600 : 350));
    if (mode === "failed") return new Response(JSON.stringify({ errors:[{ message:"模拟发送失败" }] }),{
      headers:{ "content-type":"application/json" }
    });
    const actualTarget = mode === "wrong-target" ? state.tweets[demoTweets[1].id] : target;
    const created = post(String(2112500000000010000n + BigInt(++sequence)),"101",actualTarget.conversationId,
      actualTarget.id,actualTarget.authorId,variables.tweet_text);
    const result = graphql(created);
    if (mode === "note") {
      delete result.legacy.full_text;
      result.note_tweet = { note_tweet_results:{ result:{ text:created.text } } };
    }
    const wrapper = mode === "note" ? "notetweet_create" : "create_tweet";
    return new Response(JSON.stringify({ data:{ [wrapper]:{ tweet_results:{ result } } } }),{
      headers:{ "content-type":"application/json" }
    });
  };

  function close() {
    dialog?.remove();
    dialog = null;
    sourceTab?.setAttribute("aria-selected","true");
    history.replaceState(null,"",returnPath);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  function askToClose(targetId,editor) {
    if (!editor.innerText.trim()) { close(); return; }
    const sheet = document.createElement("div");
    sheet.className = "demo-save-sheet";
    sheet.dataset.testid = "confirmationSheetDialog";
    sheet.setAttribute("role","dialog");
    const heading = document.createElement("h2");
    heading.textContent = "要保存帖子草稿？";
    const save = document.createElement("button");
    save.dataset.testid = "confirmationSheetConfirm";
    save.textContent = "保存";
    save.addEventListener("click",() => {
      drafts.set(targetId,editor.innerText);
      updateEvidence();
      sheet.remove();
      close();
    });
    const keep = document.createElement("button");
    keep.textContent = "继续编辑";
    keep.addEventListener("click",() => sheet.remove());
    sheet.append(heading,save,keep);
    document.body.append(sheet);
  }

  function open(targetId) {
    const target = state.tweets[targetId];
    if (!target || dialog) return;
    returnPath = location.pathname;
    sourceTab = document.querySelector('[data-testid="primaryColumn"] [role="tab"][aria-selected="true"]');
    dialog = document.createElement("div");
    dialog.className = "demo-composer";
    dialog.setAttribute("role","dialog");
    dialog.setAttribute("aria-label","模拟回复框");
    dialog.dataset.targetId = targetId;
    const nativeClose = document.createElement("button");
    nativeClose.dataset.testid = "app-bar-close";
    nativeClose.setAttribute("aria-label","关闭");
    nativeClose.textContent = "关闭";
    const quote = document.createElement("p");
    quote.textContent = `回复 @${users.find(user => user.id === target.authorId)?.handle}：${target.text}`;
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    editor.dataset.testid = "tweetTextarea_0";
    editor.setAttribute("role","textbox");
    editor.setAttribute("aria-label","回复文字（仅模拟）");
    editor.textContent = drafts.get(targetId) || "";
    const editorRoot = document.createElement("div");
    editorRoot.className = "DraftEditor-root";
    editorRoot.append(editor);
    if (document.querySelector("#reply-result-mode").value === "typing" && !editor.textContent) {
      const ghost = document.createElement("div");
      ghost.id = "xreply-ghost";
      ghost.dataset.suggestion = "这是一段逐字填入的模拟回复。";
      ghost.textContent = "按 Tab 模拟逐字填入";
      editorRoot.append(ghost);
      editor.addEventListener("keydown",async event => {
        if (event.key !== "Tab" || !ghost.isConnected) return;
        event.preventDefault();
        const text = ghost.dataset.suggestion;
        ghost.remove();
        let protectedWhileTyping = true;
        for (const character of text) {
          editor.textContent += character;
          editor.dispatchEvent(new InputEvent("input",{ bubbles:true,inputType:"insertText",data:character }));
          if (editor.textContent !== text &&
              (!dialog.querySelector(".xrc-flow-skip")?.disabled || !dialog.querySelector(".xrc-flow-send")?.disabled)) {
            protectedWhileTyping = false;
          }
          await new Promise(resolve => setTimeout(resolve,90));
        }
        evidence.dataset.typingGuard = protectedWhileTyping ? "passed" : "failed";
      });
    }
    const error = document.createElement("p");
    error.setAttribute("role","alert");
    const nativeSend = document.createElement("button");
    nativeSend.dataset.testid = "tweetButton";
    nativeSend.textContent = "回复（模拟）";
    nativeSend.disabled = !editor.innerText.trim();
    editor.addEventListener("input",() => { nativeSend.disabled = !editor.innerText.trim(); });
    nativeClose.addEventListener("click",() => askToClose(targetId,editor));
    nativeSend.addEventListener("click",async () => {
      if (nativeSend.disabled) return;
      nativeSend.disabled = true;
      const operation = document.querySelector("#reply-result-mode").value === "note" ? "CreateNoteTweet" : "CreateTweet";
      const response = await window.fetch(`/i/api/graphql/demo/${operation}`,{
        method:"POST",body:JSON.stringify({ variables:{ tweet_text:editor.innerText,reply:{ in_reply_to_tweet_id:targetId } } })
      });
      const result = await response.json();
      if (result.errors) {
        error.textContent = "模拟发送失败，草稿保留";
        nativeSend.disabled = false;
      } else {
        sent++;
        drafts.delete(targetId);
        updateEvidence();
        close();
      }
    });
    const nativeToolbar = document.createElement("div");
    nativeToolbar.dataset.testid = "toolBar";
    nativeToolbar.append(nativeSend);
    dialog.append(nativeClose,quote,editorRoot,error,nativeToolbar);
    document.body.append(dialog);
    history.replaceState(null,"","/compose/post");
    sourceTab?.setAttribute("aria-selected","false");
    editor.focus();
  }

  document.addEventListener("click",event => {
    const article = event.target.closest('[data-testid="reply"]')?.closest('article[data-testid="tweet"]');
    if (article) open(article.dataset.demoId);
  });
}
