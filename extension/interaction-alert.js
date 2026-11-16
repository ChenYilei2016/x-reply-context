/* Page-local acknowledgement gate; never retries or sends an interaction. */
(() => {
  "use strict";
  const ACTIONS={CreateTweet:"评论",CreateNoteTweet:"长评论",FavoriteTweet:"点赞",UnfavoriteTweet:"取消点赞"};
  const CONTROLS='[data-testid="tweetButton"],[data-testid="tweetButtonInline"],[data-testid="like"],[data-testid="unlike"],.xrc-flow-send,.xrc-flow-heart,.xrc-flow-skip,.xrc-ai-recommend,.xrc-quick-reply';
  function create({accountHandle,onPause,onRelease,onUnavailableReply}) {
    let active=null,panel;
    function clear() {
      active=null;
      panel?.remove();
      panel=null;
    }
    function blocked() {
      if (!active)return false;
      const account=accountHandle();
      if (account && account!==active.account) clear();
      return Boolean(active);
    }
    function show(data) {
      if (!Object.hasOwn(ACTIONS,data?.operation) || !data.account || data.account!==accountHandle()) return;
      const text=typeof data.message==="string"?data.message.slice(0,600):"";
      const status=Number.isInteger(data.httpStatus)?data.httpStatus:0;
      const rateLimited=status===429 || /rate.?limit|too many requests|限流|操作过于频繁|频率限制/i.test(text);
      const code=typeof data.code==="string"?data.code.slice(0,40):"";
      const retry=typeof data.retryAfter==="string"?data.retryAfter.slice(0,100):"";
      const canSkipTarget = data.targetUnavailable === true && status === 200 && code === "385" &&
        data.reason === "failed" && !rateLimited && !retry &&
        (data.operation === "CreateTweet" || data.operation === "CreateNoteTweet");
      // An unavailable post must never supersede an existing warning or rate-limit gate.
      if (canSkipTarget && active?.account === data.account && !active.skip) return;
      const signature=JSON.stringify([data.account,data.operation,rateLimited,status,code,data.reason,text,retry,
        canSkipTarget,canSkipTarget ? data.requestId : ""]);
      if (active?.signature===signature) return;
      const skip = canSkipTarget ? onUnavailableReply?.(data) : undefined;
      const title=skip?"当前帖子不可回复":rateLimited?"X 限流提示，请停止连续操作":
        data.reason==="warning"?"X 返回警告，已暂停连续操作":"X 操作异常，已暂停连续操作";
      const detail=[ACTIONS[data.operation],status?`HTTP ${status}`:"",code?`错误码 ${code}`:""].filter(Boolean).join(" · ");
      const description=text || (data.reason==="network"?"网络请求失败或中断，结果尚未确认。":data.reason==="failed"?"X 未确认此次操作成功。":"返回内容无法确认操作成功，请先在 X 核对，避免重复提交。");
      active={account:data.account,signature,skip};onPause();
      if (!panel) {
        panel=document.createElement("aside");panel.className="xrc-interaction-alert";panel.setAttribute("role","alert");
        panel.setAttribute("aria-live","assertive");panel.setAttribute("aria-atomic","true");
        const heading=document.createElement("strong"),meta=document.createElement("div"),message=document.createElement("p"),wait=document.createElement("div"),help=document.createElement("p");
        const ack=document.createElement("button"),next=document.createElement("button"),actions=document.createElement("div");
        heading.className="xrc-alert-title";meta.className="xrc-alert-meta";message.className="xrc-alert-message";wait.className="xrc-alert-wait";
        help.className="xrc-alert-help";actions.className="xrc-alert-actions";
        ack.type="button";ack.className="xrc-alert-ack";ack.textContent="我已查看，解除暂停";
        ack.addEventListener("click",()=>{clear();onRelease();});
        next.type="button";next.className="xrc-alert-next";next.textContent="跳过此帖";
        next.addEventListener("click",()=>{
          if (!active?.skip || accountHandle() !== active.account) return;
          if (!active.skip(clear)) help.textContent="请先确认当前回复框和草稿，再手动选择下一条。";
        });
        actions.append(next,ack);
        panel.append(heading,meta,message,wait,help,actions);(document.body||document.documentElement).append(panel);
      }
      panel.querySelector("strong").textContent=title;
      panel.querySelector(".xrc-alert-meta").textContent=detail;
      panel.querySelector(".xrc-alert-message").textContent=description;
      panel.querySelector(".xrc-alert-wait").textContent=retry?`X 返回的 Retry-After：${retry}；不会计时自动恢复。`:"";
      panel.querySelector(".xrc-alert-help").textContent=skip?
        "这条评论未发出。可跳过此帖，按 X 的草稿流程处理现有内容，并打开下一条已加载的帖子。":
        "本页评论、点赞、AI生成与自动下一条已暂停。先核对 X 提示与操作结果；草稿保留，不会自动重试。解除后，重新打开回复框可启动连续回复。";
      panel.querySelector(".xrc-alert-next").hidden=!skip;
    }
    function prevent(event) {event.preventDefault();event.stopImmediatePropagation();}
    window.addEventListener("click",event=>{
      if (!blocked()) return;
      const node=event.target instanceof Element?event.target:event.target?.parentElement;
      if(node?.closest(CONTROLS))prevent(event);
    },true);
    const nativeActions=new Set(["l","r","t","n"]);
    function guardKey(event) {
      if (!blocked())return;
      const node=event.target instanceof Element?event.target:null;
      const editing=node?.closest('input,textarea,[contenteditable="true"],[role="textbox"]');
      const key=event.key.toLowerCase();
      const sendKey=event.key==="Enter"&&(event.altKey||event.ctrlKey||event.metaKey);
      const nativeAction=!editing&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&nativeActions.has(key);
      const aiKey=editing&&event.altKey&&!event.ctrlKey&&!event.metaKey&&
        (event.key==="Tab"||event.code==="KeyQ"||key==="q"||/^[1-6]$/.test(key)||/^Digit[1-6]$/.test(event.code || ""));
      if(sendKey||nativeAction||aiKey||(event.key==="Enter"||event.key===" ")&&node?.closest(CONTROLS))prevent(event);
    }
    // Stop shortcuts before they reach the page's document/list handlers, including keyup bindings.
    for(const type of ["keydown","keypress","keyup"])window.addEventListener(type,guardKey,true);
    return {show,blocked};
  }
  globalThis.XReplyInteractionAlert={create};
})();
