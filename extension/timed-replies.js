/* One foreground run and timer; only an explicit refresh handoff crosses documents. */
(() => {
  "use strict";
  const KEY="timedReplies";
  const FOREGROUND_GRACE_MS=1000;
  const DRAFT_STALL_MS=60000;
  const defaults={enabled:false,allowVisibleUnfocused:false,minSeconds:3,maxSeconds:10,maxAttempts:500,maxMinutes:60};
  function normalize(raw) {
    const value={enabled:raw?.enabled===true,allowVisibleUnfocused:raw?.allowVisibleUnfocused===true};
    for(const [key,min,max] of [["minSeconds",3,3600],["maxSeconds",3,3600],["maxAttempts",1,500],["maxMinutes",1,240]]) {
      value[key]=raw?.[key] ?? defaults[key];
      if(!Number.isInteger(value[key]) || value[key]<min || value[key]>max)throw new Error("间隔需3～3600秒，次数1～500，时长1～240分钟，均为整数。");
    }
    if(value.minSeconds>value.maxSeconds)throw new Error("最短间隔不能大于最长间隔。");
    return value;
  }
  const pageAllowed=settings=>!document.hidden && (settings?.allowVisibleUnfocused===true || !document.hasFocus || document.hasFocus());
  const validId=value=>typeof value==="string"&&/^[a-zA-Z0-9-]{1,80}$/.test(value);
  const remaining=record=>Math.min(record.remainingMs-(Date.now()-record.capturedAt),record.expiresAt-Date.now());
  function normalizeResume(raw,current) {
    if(!raw || !validId(raw.runId) || !/^[a-zA-Z0-9_]{1,15}$/.test(raw.account || ""))return null;
    let settings;try{settings=normalize(raw.settings);}catch{return null;}
    if(!settings.enabled || current&&JSON.stringify(settings)!==JSON.stringify(current))return null;
    const limit=settings.maxMinutes*60000;
    if(!Number.isInteger(raw.attempts)||raw.attempts<0||raw.attempts>=settings.maxAttempts ||
      !Number.isFinite(raw.expiresAt)||!Number.isFinite(raw.capturedAt)||!Number.isFinite(raw.remainingMs)||
      raw.remainingMs<=0||raw.remainingMs>limit||raw.capturedAt>Date.now()||Date.now()-raw.capturedAt>120000||
      raw.expiresAt-raw.capturedAt>limit||remaining(raw)<=0||
      typeof raw.lastId!=="string"||!/^(?:[0-9]{1,25})?$/.test(raw.lastId))return null;
    return {runId:raw.runId,account:raw.account,attempts:raw.attempts,expiresAt:raw.expiresAt,
      capturedAt:raw.capturedAt,remainingMs:raw.remainingMs,lastId:raw.lastId,settings};
  }
  function create({storage,readState,trigger,requestRefresh,onInterrupt=()=>{},onContinue=()=>"",
      cancelRefresh=()=>{},keepAwake=()=>{},powerStatus=()=>"常亮申请未开启",checkScreenLock,
      confirmDraft=()=>false}) {
    let config={...defaults},loaded=false,run=null,paused=null,armed=null,timer=null,scheduledAt=0;
    let row=null,badge=null,caption="尚未开始",attempts=0,firing=false,stopped=false;
    let foregroundWait=null;
    let handoff=null,restoring=null,restoreRequested=false,shownExpiry=0,shownEnd="";
    let restoreDenied=document.hidden,blurredBeforeLoad=false,screenCheck;
    const allowed=()=>pageAllowed(config);
    const manualNavigation=()=>{const entry=performance.getEntriesByType?.('navigation')?.[0];return !entry||entry.type!=="navigate";};
    function setText(node,text){if(node.textContent!==text)node.textContent=text;}
    function paint() {
      if(row && !row.isConnected)row=null;
      const active=Boolean(run||restoring||handoff);
      const state=active?null:readState();
      if(row){
        setText(row.querySelector('span'),!loaded?"定时回复：读取设置…":!config.enabled?"定时回复：已关闭":`定时 ${attempts}/${config.maxAttempts} · ${caption}`);
        const button=row.querySelector('button');setText(button,active?"暂停本轮":paused?"继续本轮":"开始本轮");
        const disabled=!active&&(!loaded||!config.enabled||Boolean(state?.reason)||Boolean(paused&&!state?.resumeReady));if(button.disabled!==disabled)button.disabled=disabled;
        const title=`随机${config.minSeconds}～${config.maxSeconds}秒，最多${config.maxAttempts}次或${config.maxMinutes}分钟。暂停保留次数和原截止时间，需手动继续；手动刷新不会恢复。`;
        if(row.title!==title)row.title=title;
      }
      const show=(config.enabled||stopped)&&(active||/^\/(?:home|compose)(?:\/|$)/.test(location.pathname));
      if(!show){badge?.remove();badge=null;return;}
      if(!badge){
        const host=document.body||document.documentElement;if(!host)return;
        badge=document.createElement('aside');badge.className='xrc-timed-badge';badge.setAttribute('role','status');badge.setAttribute('aria-live','polite');
        const title=document.createElement('strong'),status=document.createElement('span'),detail=document.createElement('small'),button=document.createElement('button'),visibility=document.createElement('div');
        const power=document.createElement('div'),useDraft=document.createElement('button');
        status.className='xrc-timed-badge-status';detail.className='xrc-timed-badge-detail';button.type='button';button.textContent='暂停本轮';
        button.addEventListener('mousedown',event=>event.preventDefault());button.addEventListener('click',toggleRun);
        visibility.className='xrc-timed-badge-visibility';visibility.setAttribute('aria-label','浏览器报告的页面状态');
        visibility.title='按浏览器报告显示；完全遮挡可能被判定隐藏。页面隐藏时立即停止发送倒计时，持续隐藏会暂停本轮。允许可见失焦可在扩展弹窗开启。';
        power.className='xrc-timed-badge-power';
        power.title='显示常亮申请的结果。macOS 负责执行闲置和锁屏规则。';
        useDraft.type='button';useDraft.className='xrc-timed-review-draft';useDraft.hidden=true;
        useDraft.textContent='使用当前草稿并继续';
        useDraft.addEventListener('mousedown',event=>event.preventDefault());
        useDraft.addEventListener('click',()=>continueRun({review:true}));
        badge.append(title,button,status,detail,visibility,power,useDraft);host.append(badge);
      }
      const phase=handoff||restoring?'restoring':run?'running':paused?'paused':stopped?'stopped':'idle';
      if(badge.dataset.state!==phase)badge.dataset.state=phase;
      setText(badge.querySelector('strong'),phase==='restoring'?'自动化 · 刷新衔接中':run?'自动化运行中':paused?'自动化已暂停':stopped?'自动化已停止':'自动化未开始');
      const status=badge.querySelector('span');
      setText(status,paused?`暂停原因：${caption}`:stopped?`停止原因：${caption}`:caption);
      if(status.title!==caption)status.title=caption;
      updatePowerDisplay();
      const visibility=badge.querySelector('.xrc-timed-badge-visibility');
      setText(visibility,`当前：${document.hidden?'页面隐藏':'页面可见'} · ${!document.hasFocus||document.hasFocus()?'有焦点':'已失焦'}`);
      const hidden=String(document.hidden);if(visibility.dataset.hidden!==hidden)visibility.dataset.hidden=hidden;
      const expiresAt=run?.expiresAt||paused?.expiresAt||restoring?.ticket.expiresAt||(stopped?shownExpiry:0);
      if(expiresAt && expiresAt!==shownExpiry){shownExpiry=expiresAt;shownEnd=new Date(expiresAt).toLocaleTimeString([], {hour12:false});}
      const end=expiresAt?` · 截止 ${shownEnd}`:` · 上限${config.maxMinutes}分钟`;
      setText(badge.querySelector('small'),`${attempts}/${config.maxAttempts}次${end}`);
      const button=badge.querySelector('button');
      setText(button,active?'暂停本轮':paused?'继续本轮':'已停止');
      const disabled=!active&&(!paused||Boolean(state?.reason)||!state?.resumeReady);
      if(button.disabled!==disabled)button.disabled=disabled;
      const useDraft=badge.querySelector('.xrc-timed-review-draft');
      const showReview=Boolean(paused&&state?.draftNeedsReview&&state.resumeReady&&!state.reason);
      if(useDraft.hidden===showReview)useDraft.hidden=!showReview;
    }
    function updatePowerDisplay() {
      if(badge)setText(badge.querySelector('.xrc-timed-badge-power'),powerStatus());
    }
    function clearTimer(){clearTimeout(timer);timer=null;scheduledAt=0;}
    function visibilityReason() {
      return document.hidden ? "Chrome 曾报告页面隐藏，返回后点击继续本轮" :
        "页面可见但窗口曾失焦，当前设置要求焦点，点击继续本轮";
    }
    // During a countdown only: suspend the send timer immediately, then confirm visibility.
    const nextSendAt = () => performance.now()+config.minSeconds*1000+Math.floor(Math.random()*((config.maxSeconds-config.minSeconds)*1000+1));
    function holdCountdown() {
      if (!run || !armed || handoff || firing) return false;
      if (!allowed() && !foregroundWait) {
        foregroundWait={until:performance.now()+FOREGROUND_GRACE_MS,reason:visibilityReason()};
        clearScreenCheck();
      }
      if (!foregroundWait) return false;
      if (performance.now()>=foregroundWait.until) {
        pause(allowed()?foregroundWait.reason:visibilityReason());
        return true;
      }
      if (!allowed()) {
        caption="等待浏览器确认页面可见性与焦点";
        schedule(Math.min(run.endAt,foregroundWait.until));paint();return true;
      }
      foregroundWait=null;
      armed={...armed,at:nextSendAt()};
      caption="页面已恢复，重新等待本条发送";
      return false;
    }
    function clearScreenCheck(){if(screenCheck){clearTimeout(screenCheck.timer);screenCheck=null;}}
    function halt(reason,{interrupt=true,cancel=true}={}) {
      if(interrupt)restoreDenied=true;
      if(!run&&!paused&&!restoring&&!handoff)return;
      const refreshId=handoff?.refreshId||restoring?.refreshId||run?.refreshId;
      clearScreenCheck();
      foregroundWait=null;run=null;paused=null;armed=null;handoff=null;restoring=null;restoreRequested=false;clearTimer();caption=reason;stopped=true;
      keepAwake(0);
      if(interrupt)onInterrupt(reason);
      if(cancel&&refreshId)cancelRefresh(refreshId);
      paint();requestRefresh();
    }
    function stop(reason="已手动停止",{preservePaused=false}={}){
      if(preservePaused&&paused)return;
      halt(reason);
    }
    function pause(reason="已手动暂停，点击继续本轮恢复") {
      restoreDenied=true;
      // Handoff cancellation must remain terminal; never reuse a partly consumed refresh ticket.
      if(handoff||restoring){stop("换批衔接已停止，请核对页面后重新开始");return;}
      if(!run)return;
      if(readState()?.likePending){stop("点赞请求尚未确认，请核对后重新开始");return;}
      const refreshId=run.refreshId;
      clearScreenCheck();
      foregroundWait=null;paused={...run,refreshId:"",draftWait:null};run=null;armed=null;clearTimer();caption=reason;
      keepAwake(0);
      onInterrupt(reason);
      if(refreshId)cancelRefresh(refreshId);
      refresh();requestRefresh();
    }
    function screenLocked() {
      restoreDenied=true;
      const reason="Chrome 报告锁屏或屏保已启动";
      if(handoff||restoring){stop(reason+"，换批续接已取消");return;}
      if(run)pause(reason);
      if(paused && /^(Chrome 曾报告页面隐藏|页面可见但窗口曾失焦|页面不在前台)/.test(caption)){caption=reason;paint();}
    }
    function checkPaused() {
      if(!paused)return;
      const state=readState();
      if(attempts>=config.maxAttempts || performance.now()>=paused.endAt || Date.now()>=paused.expiresAt){
        budgetStop("本轮次数或时间已到，不能继续");return;
      }
      if(!config.enabled || !state?.supported || state.account!==paused.account || state.session!==paused.session ||
          state.reason&&!state.pauseable&&!state.awaitingReview)stop(state?.reason||"页面、账号或会话变化，请重新开始");
    }
    function continueRun({review=false}={}) {
      checkPaused();if(!paused)return;
      const state=readState();
      if(!allowed() || state.reason || !state.resumeReady){
        caption=state.reason||"请等待本条结果，核对后进入下一条再继续";paint();return;
      }
      const owner=paused;
      let reviewedDraft;
      if(review){
        if(!state.draftNeedsReview || !confirmDraft(state.draft))return;
        const latest=readState();
        if(paused!==owner || !allowed() || !latest?.resumeReady || latest.reason ||
          latest.session!==state.session || latest.account!==state.account || latest.id!==state.id ||
          latest.editor!==state.editor || latest.draft!==state.draft){
          if(paused===owner){caption="草稿或回复对象已变化，请重新核对。";paint();}
          return;
        }
        reviewedDraft=state.draft.replace(/\n$/,"");
      }
      let problem;
      try {problem=onContinue(state,reviewedDraft);}catch {problem="AI 恢复未确认，请检查草稿后手动推荐。";}
      if(paused!==owner)return;
      if(problem){caption=problem;paint();return;}
      run=paused;paused=null;stopped=false;caption="继续本轮，等待草稿就绪";
      refresh();requestRefresh();
      if(run)keepAwake(run.expiresAt);
    }
    function toggleRun(){if(run||restoring||handoff)pause();else if(paused)continueRun();else start();}
    function budgetStop(reason){halt(reason,{interrupt:false});}
    function finishAtLimit(reason) {
      const state=readState();
      if (!state?.settling) {
        budgetStop(reason);
        return;
      }
      if (!stateForRun(state)) return;
      if (Date.now()>=run.settleUntil) {
        stop(reason+"，本条收尾超时，请核对结果");
        return;
      }
      run.finishReason=reason;
      armed=null;
      caption=reason+"，等待本条收尾";
      schedule(performance.now()+run.settleUntil-Date.now());
      paint();
    }
    function cancelFromRefresh(refreshId,reason="刷新续接已取消") {
      if(refreshId && [handoff?.refreshId,restoring?.refreshId,run?.refreshId].includes(refreshId))halt(reason,{cancel:false});
    }
    function prepareRefresh(refreshId) {
      if(!run || run.finishReason || screenCheck || !stateForRun())return null;
      const left=Math.min(run.endAt-performance.now(),run.expiresAt-Date.now());
      if(left<config.minSeconds*1000){budgetStop("剩余时间不足一次等待，已停止");return null;}
      const ticket={runId:run.id,account:run.account,attempts,lastId:run.lastId,expiresAt:run.expiresAt,
        capturedAt:Date.now(),remainingMs:left,settings:{...config}};
      handoff={refreshId,committed:false};run.refreshId=refreshId;armed=null;clearTimer();
      caption="正在登记自动换批；次数和截止时间保持";schedule(run.endAt);paint();
      return ticket;
    }
    function validRefresh(refreshId){return Boolean(run&&handoff?.refreshId===refreshId&&performance.now()<run.endAt&&Date.now()<run.expiresAt);}
    function commitRefresh(refreshId){if(!validRefresh(refreshId))return false;handoff.committed=true;keepAwake(run.expiresAt);caption="正在刷新，随后继续剩余预算";paint();return true;}
    function previewResume(ticket,refreshId) {
      if(restoreDenied||manualNavigation()||run||paused||handoff||restoring&&restoring.refreshId!==refreshId)return false;
      const value=normalizeResume(ticket,loaded?config:undefined);
      if(!value||!validId(refreshId)||!pageAllowed(value.settings)||blurredBeforeLoad&&!value.settings.allowVisibleUnfocused)return false;
      restoring={ticket:value,refreshId};attempts=value.attempts;stopped=false;caption="核对账号、页面及剩余预算…";
      keepAwake(Math.min(value.expiresAt,Date.now()+15000));paint();return true;
    }
    function canResume(refreshId) {
      if(restoring?.refreshId!==refreshId)return false;
      if(!loaded)return undefined;
      return Boolean(normalizeResume(restoring.ticket,config)&&remaining(restoring.ticket)>=config.minSeconds*1000);
    }
    function restore(ticket,refreshId) {
      if(!restoring && !previewResume(ticket,refreshId))return;
      restoreRequested=true;refresh();requestRefresh();
    }
    function finishRestore() {
      if(!restoring||!restoreRequested||!loaded)return;
      const {ticket,refreshId}=restoring,state=readState();
      if(!canResume(refreshId)||!state?.supported||state.reason||state.account!==ticket.account){stop(state?.reason||"刷新后条件或预算不满足，已停止");return;}
      const left=remaining(ticket);
      run={id:ticket.runId,session:state.session,account:ticket.account,lastId:ticket.lastId,
        endAt:performance.now()+left,expiresAt:ticket.expiresAt,refreshId};
      attempts=ticket.attempts;restoring=null;restoreRequested=false;caption="已恢复本轮，等待草稿就绪";
      keepAwake(run.expiresAt);
    }
    function schedule(at) {
      if(timer!==null && scheduledAt===at)return;
      clearTimer();scheduledAt=at;
      timer=setTimeout(tick,Math.max(0,at-performance.now()));
    }
    function stateForRun(state=readState()) {
      if(!state || state.reason || !state.supported || state.session!==run.session || state.account!==run.account){
        if(state?.pauseable && state.session===run.session && state.account===run.account)pause(state.reason);
        else stop(state?.reason || "页面或账号变化，已停止");
        return null;
      }
      if(state.draftProblem){pause(state.draftProblem);return null;}
      return state;
    }
    function updateDraftWait(state) {
      if(state.ready || !state.preparingDraft){run.draftWait=null;return true;}
      const now=performance.now(),wait=run.draftWait;
      if(!wait || wait.id!==state.id){
        run.draftWait={id:state.id,phase:state.preparingDraft,draft:state.draft,deadline:now+DRAFT_STALL_MS};
      }else if(wait.phase!==state.preparingDraft || wait.draft!==state.draft){
        wait.phase=state.preparingDraft;wait.draft=state.draft;wait.deadline=now+DRAFT_STALL_MS;
      }else if(now>=wait.deadline){
        pause("草稿 60 秒没有进展。核对草稿后点击「继续本轮」。");
        return false;
      }
      return true;
    }
    function refresh() {
      finishRestore();checkPaused();
      if(!run || firing){paint();return;}
      if(run.finishReason || performance.now()>=run.endAt || Date.now()>=run.expiresAt){
        finishAtLimit(run.finishReason || "已到时长上限");return;
      }
      if(handoff){schedule(run.endAt);paint();return;}
      if(holdCountdown())return;
      const state=stateForRun();if(!state)return;
      if(armed && (armed.id!==state.id || armed.draft!==state.draft || !state.ready)){
        stop("草稿或回复状态变化，已停止");return;
      }
      if(screenCheck){paint();return;}
      if(!updateDraftWait(state))return;
      if(!armed && state.ready && state.id!==run.lastId) {
        armed={id:state.id,draft:state.draft,at:nextSendAt()};
        caption=`本次等待${Math.round(armed.at-performance.now())/1000}秒`;
      } else if(!armed)caption=state.waiting || "等待已填好的草稿";
      const nextAt=Math.min(armed?.at ?? run.draftWait?.deadline ?? run.endAt,run.endAt);
      // Keep the earlier check while typing so each character does not reset the timer.
      if(!run.draftWait || timer===null || scheduledAt>nextAt)schedule(nextAt);
      paint();
    }
    function tick() {
      timer=null;scheduledAt=0;
      if(!run)return;
      if(run.finishReason || performance.now()>=run.endAt || Date.now()>=run.expiresAt){refresh();return;}
      if(holdCountdown())return;
      const state=stateForRun();if(!state)return;
      if(!armed || performance.now()<armed.at){refresh();return;}
      if(!state.ready || state.id!==armed.id || state.draft!==armed.draft){stop("草稿或回复状态变化，未发送");return;}
      if(checkScreenLock){void confirmUnlocked();return;}
      fire(state);
    }
    async function confirmUnlocked() {
      const owner=run, target=armed;
      const failed=()=>{clearScreenCheck();pause("无法确认屏幕锁定状态，本轮已暂停");};
      const check=screenCheck={timer:setTimeout(failed,2000)};
      caption="确认屏幕状态…";paint();
      let locked;
      try {locked=await checkScreenLock();}
      catch {if(screenCheck===check)failed();return;}
      if(screenCheck!==check)return;
      clearScreenCheck();
      if(run!==owner || armed!==target)return;
      if(locked!==false){if(locked===true)screenLocked();else failed();return;}
      if(performance.now()>=owner.endAt || Date.now()>=owner.expiresAt){refresh();return;}
      const state=stateForRun();
      if(!state)return;
      if(!state.ready || state.id!==target.id || state.draft!==target.draft){stop("草稿或回复状态变化，未发送");return;}
      fire(state);
    }
    function fire(state) {
      const owner=run;
      owner.lastId=state.id;attempts++;armed=null;firing=true;
      owner.settleUntil=Date.now()+60000;
      if(owner.settleUntil>owner.expiresAt)keepAwake(owner.settleUntil);
      let sent=false;
      try {sent=trigger(state)===true;} catch { /* Do not retry an uncertain native action. */ }
      finally {firing=false;}
      if(!sent){
        if(run===owner || paused?.id===owner.id)stop("未确认触发，已停止；请核对结果");
        return;
      }
      if(run!==owner)return;
      if(attempts>=config.maxAttempts){finishAtLimit("已到次数上限");return;}
      refresh();requestRefresh();
    }
    function start() {
      if(run || paused || restoring || handoff || !loaded || !config.enabled)return;
      const state=readState();
      if(!allowed() || !state?.supported || state.reason){caption=state?.reason || "请从为你推荐打开回复框";paint();return;}
      attempts=0;stopped=false;shownExpiry=0;restoreDenied=true;run={id:crypto.randomUUID(),session:state.session,account:state.account,lastId:"",
        endAt:performance.now()+config.maxMinutes*60000,expiresAt:Date.now()+config.maxMinutes*60000,refreshId:""};
      refresh();requestRefresh();
      if(run)keepAwake(run.expiresAt);
    }
    function apply(value) {
      try {
        const next=normalize(value);
        if(loaded&&JSON.stringify(next)!==JSON.stringify(config))stop("设置已变更，请重新开始");
        config=next;
      } catch {stop("设置无效，已停止");config={...defaults};}
      loaded=true;paint();requestRefresh();
    }
    storage.onChanged.addListener((changes,area)=>{if(area==="local"&&changes[KEY])apply(changes[KEY].newValue);});
    void storage.local.get(KEY).then(saved=>{if(!loaded)apply(saved[KEY]);},()=>{loaded=true;caption="设置读取失败";paint();});
    document.addEventListener("visibilitychange",()=>{if(document.hidden&&!handoff?.committed){if(!holdCountdown())pause(visibilityReason());}else if(!document.hidden){refresh();requestRefresh();}paint();});
    window.addEventListener("focus",()=>{refresh();requestRefresh();});
    window.addEventListener("blur",()=>{
      if(!loaded){blurredBeforeLoad=true;return;}
      if(!handoff?.committed&&!allowed()&&!holdCountdown())pause(visibilityReason());
      paint();
    });
    window.addEventListener("pagehide",()=>{
      if(handoff?.committed){clearTimer();keepAwake(0,true);}
      else stop("页面已离开");
    });
    window.addEventListener("pageshow",event=>{if(event.persisted)stop("从历史页面返回，定时已停止");});
    document.addEventListener("input",event=>{
      if(run && event.isTrusted && event.target instanceof Element && event.target.closest('[contenteditable="true"][data-testid^="tweetTextarea_"]'))stop("手动编辑草稿，已停止");
    },true);
    document.addEventListener("compositionstart",event=>{
      if(run && event.target instanceof Element && event.target.closest('[contenteditable="true"][data-testid^="tweetTextarea_"]'))stop("正在编辑草稿，已停止");
    },true);
    function render(s,bar) {
      if(s.feed!=="home" || s.homeTabIndex!==0)return;
      row=bar.querySelector('.xrc-timed-replies');
      if(!row){
        row=document.createElement('div');row.className='xrc-timed-replies';
        const status=document.createElement('span'),button=document.createElement('button');status.setAttribute('role','status');button.type='button';
        button.addEventListener('mousedown',event=>event.preventDefault());
        button.addEventListener('click',event=>{event.stopPropagation();toggleRun();});
        row.append(status,button);bar.append(row);
      }
      paint();
    }
    return {start,stop,pause,isRunning:()=>Boolean(run && !run.finishReason && performance.now()<run.endAt && Date.now()<run.expiresAt),screenLocked,updatePowerDisplay,continueRun,pageAllowed:allowed,allowsUnfocused:()=>config.allowVisibleUnfocused&&Boolean(run||restoring),isPaused:()=>Boolean(paused),isFinishing:()=>Boolean(run?.finishReason),
      refresh,render,prepareRefresh,validRefresh,commitRefresh,previewResume,canResume,restore,cancelFromRefresh};
  }
  async function installSettings(storage) {
    const form=document.querySelector('#timed-reply-settings');if(!form)return;
    const status=form.querySelector('[role="status"]');
    const fields=['enabled','allowVisibleUnfocused','minSeconds','maxSeconds','maxAttempts','maxMinutes'];
    const input=key=>form.querySelector(`[name="${key}"]`);
    try {
      const saved=normalize((await storage.local.get(KEY))[KEY]);
      for(const key of fields){if(key==='enabled'||key==='allowVisibleUnfocused')input(key).checked=saved[key];else input(key).value=saved[key];}
      form.querySelectorAll('input,button').forEach(node=>{node.disabled=false;});
    }catch {status.textContent='设置读取失败，请重新打开扩展。';return;}
    form.addEventListener('input',()=>{status.textContent='修改尚未保存。';});
    form.addEventListener('submit',async event=>{
      event.preventDefault();const controls=[...form.querySelectorAll('input,button')];controls.forEach(node=>{node.disabled=true;});
      try {
        const value=normalize(Object.fromEntries(fields.map(key=>[key,key==='enabled'||key==='allowVisibleUnfocused'?input(key).checked:input(key).valueAsNumber])));
        await storage.local.set({[KEY]:value});status.textContent=value.enabled?'已保存；在为你推荐回复框点击“开始本轮”。':'已保存并关闭定时触发。';
      }catch(error){status.textContent=error.message || '设置未保存，请重试。';}
      finally{controls.forEach(node=>{node.disabled=false;});}
    });
  }
  globalThis.XReplyTimedReplies={defaults,normalize,normalizeResume,pageAllowed,create,installSettings};
})();
