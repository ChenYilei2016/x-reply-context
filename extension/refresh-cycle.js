/* Opt-in reply batches; ordinary browsing never schedules a refresh. */
(() => {
  "use strict";
  const SETTINGS = "replyRefreshCycle";
  const MARKER = "replyRefreshResume:";
  const DEFAULTS = {enabled:false,min:10,max:20};
  const normalize = value => {
    const min=Number(value?.min),max=Number(value?.max);
    return {enabled:value?.enabled===true,
      min:Number.isInteger(min)&&min>=1&&min<=1000?min:10,
      max:Number.isInteger(max)&&max>=1&&max<=1000?max:20};
  };
  const supported = s => s?.feed==="home" && s.homeTabIndex===0;
  const same = (a,b) => a.enabled===b.enabled && a.min===b.min && a.max===b.max;

  function createBackground(api) {
    const key = tabId => MARKER+tabId;
    // Serialize only these small session markers, independently of history writes.
    let tail=Promise.resolve();
    function handle(message,sender) {
      const run=async()=>{
        if(sender.frameId!==0 || !Number.isInteger(sender.tab?.id) || sender.tab.incognito) return {ok:false,error:"当前页面不能自动换批。"};
        const url=new URL(sender.url);
        if(!["https://x.com","https://twitter.com"].includes(url.origin))return {ok:false,error:"无效来源。"};
        const recordKey=key(sender.tab.id);
        if(message.type==="REFRESH_ARM") {
          const config=normalize((await api.storage.local.get(SETTINGS))[SETTINGS]);
          if(!config.enabled)return {ok:false,error:"自动换批开关已关闭。"};
          if(config.min>config.max)return {ok:false,error:"自动换批次数区间无效。"};
          if(!/^[a-zA-Z0-9_]{1,15}$/.test(message.account || ""))return {ok:false,error:"当前账号尚未确认。"};
          // sender.url authenticates the script origin, not the current SPA route.
          if(message.currentPath!=="/home" && message.currentPath!=="/home/")return {ok:false,error:"当前页面不是主页，未登记换批。"};
          await api.storage.session.set({[recordKey]:{account:message.account.toLowerCase(),at:Date.now(),min:config.min,max:config.max}});
          return {ok:true};
        }
        if(message.type==="REFRESH_TAKE") {
          const record=(await api.storage.session.get(recordKey))[recordKey];
          await api.storage.session.remove(recordKey); // Consume before any UI action; reload cannot replay it.
          const valid=record && Date.now()-record.at>=0 && Date.now()-record.at<120000 && (message.currentPath==="/home" || message.currentPath==="/home/");
          return {ok:true,resume:valid?record:null};
        }
        if(message.type==="REFRESH_CANCEL") {await api.storage.session.remove(recordKey);return {ok:true};}
        return {ok:false,error:"未知换批操作。"};
      };
      const result=tail.then(run,run);tail=result.catch(()=>{});return result;
    }
    return {handle,removed:tabId=>{
      const result=tail.then(()=>api.storage.session.remove(key(tabId)));
      tail=result.catch(()=>{});return result;
    }};
  }

  function create({storage,message,accountHandle,requestRefresh,resume,notify}) {
    let config={...DEFAULTS},ready=false,saving=false,pendingConfig=null,error="",account="",count=0,target=0,generation=0;
    let records=new Set(),pending,deadline,resuming=false,navigating=false,pauseReason="";
    function reset(nextAccount=account) {
      account=nextAccount;count=0;records.clear();generation++;
      target=config.enabled?config.min+Math.floor(Math.random()*(config.max-config.min+1)):0;
    }
    function stopResume(text="") {pending=null;clearTimeout(deadline);if(text)notify(text);}
    function apply(value) {
      const next=normalize(value);if(next.min>next.max)next.enabled=false;
      if(!same(config,next)){config=next;reset();stopResume();}
      ready=true;requestRefresh();
    }
    async function initialize() {
      try {
        apply((await storage.local.get(SETTINGS))[SETTINGS]);
        const result=await message({type:"REFRESH_TAKE",currentPath:location.pathname});
        if(result.resume && config.enabled && config.min===result.resume.min && config.max===result.resume.max && location.pathname==="/home") {
          pending={...result.resume,switched:false,lastCheck:""};
          deadline=setTimeout(()=>stopResume("换批后未能打开合适帖子，请手动选择；不会继续刷新或翻页。"),15000);
          requestRefresh();
        }
      } catch {ready=true;error="自动换批暂不可用";requestRefresh();}
    }
    storage.onChanged.addListener((changes,area)=>{
      if(area==="local" && changes[SETTINGS])apply(changes[SETTINGS].newValue);
    });
    void initialize();

    function record(s,id) {
      if(!ready || !config.enabled || !supported(s))return;
      if(account!==s.account)reset(s.account);
      if(records.has(id) || count>=target)return;
      records.add(id);count++;requestRefresh();
    }
    function due(s) {return ready&&config.enabled&&supported(s)&&account===s.account&&target>0&&count>=target;}
    function unsafeReason() {
      if(document.hidden)return "页面已切到后台；返回前台后点击继续。";
      for(const dialog of document.querySelectorAll('[role="dialog"],[aria-modal="true"]')) {
        const box=dialog.getBoundingClientRect();if(box.width&&box.height)return "页面仍有打开的弹窗；关闭后点击继续。";
      }
      for(const editor of document.querySelectorAll('[contenteditable="true"][data-testid^="tweetTextarea_"]')) {
        if(editor.innerText.trim())return "检测到未发送文字；请先保存或处理草稿。";
        if(editor.contains(document.activeElement))return "输入框仍有焦点；离开输入框后点击继续。";
      }
      if(document.querySelector('[data-testid="attachments"],[data-testid="mediaPreview"],[data-testid="pollOption_0"]'))return "检测到附件或投票编辑内容；请先保存或处理。";
      return "";
    }
    const safe=()=>!unsafeReason();
    function paused(reason) {pauseReason=reason;return "paused";}
    async function refresh(s,valid) {
      if(!due(s))return "continue";
      pauseReason="";
      const version=generation,reason=unsafeReason();
      if(navigating)return paused("刷新已启动，请等待页面加载。" );
      if(reason)return paused(reason);
      if(!valid())return paused("回复框或连续回复状态尚未就绪；关闭回复框后点击继续。");
      navigating=true;
      let leaving=false;
      try {
        await message({type:"REFRESH_ARM",account:s.account,currentPath:location.pathname});
        const reason=unsafeReason();
        if(!due(s) || version!==generation || reason || !valid() || accountHandle()!==s.account) {
          await message({type:"REFRESH_CANCEL"});
          return paused(reason || "账号、设置或回复状态已变化，已取消本次刷新。");
        }
        location.assign("/home");leaving=true;return "navigating";
      } catch (cause) {
        if(!due(s))return "continue";
        error="换批未启动："+String(cause?.message || "后台登记失败，请重载扩展并刷新 X 后重试。").slice(0,200);
        return paused(error);
      }
      finally{if(!leaving)navigating=false;}
    }
    async function tick() {
      if(!pending || resuming)return;
      if(!config.enabled || document.hidden || location.pathname!=="/home") {stopResume();return;}
      const me=accountHandle();if(!me)return;
      if(me!==pending.account) {stopResume("账号已变化，未续开回复框。");return;}
      if(!safe()) {stopResume("已有编辑内容或弹窗，未续开回复框。");return;}
      const intent=pending;resuming=true;
      try {
        const result=await resume(intent,()=>pending===intent&&config.enabled&&safe()&&accountHandle()===intent.account);
        if(pending!==intent)return;
        if(result==="opened") {stopResume();requestRefresh();}
        else if(result==="empty")stopResume("本批暂无可处理帖子，请手动选择；不会自动翻页。");
        else if(result==="paused")stopResume("页面状态已变化，未自动打开回复框。");
      } catch {stopResume("本地记录暂不可用，未自动打开回复框。");}
      finally{resuming=false;}
    }
    function render(s,bar) {
      if(!supported(s))return;
      if(account!==s.account)reset(s.account);
      let row=bar.querySelector('.xrc-refresh-cycle');
      if(!row) {
        row=document.createElement('div');row.className='xrc-refresh-cycle';
        const label=document.createElement('label'),toggle=document.createElement('input');toggle.type='checkbox';toggle.className='xrc-cycle-enabled';
        label.append(toggle,document.createTextNode('自动换一批'));
        row.append(label,document.createTextNode('每 '));
        for(const [name,caption] of [['min','最少评论数'],['max','最多评论数']]) {
          if(name==='max')row.append(document.createTextNode('～'));
          const input=document.createElement('input');input.type='number';input.min='1';input.max='1000';input.step='1';input.className='xrc-cycle-'+name;input.setAttribute('aria-label',caption);row.append(input);
        }
        row.append(document.createTextNode(' 条'));
        const status=document.createElement('span');status.className='xrc-cycle-progress';status.setAttribute('role','status');row.append(status);
        row.title='默认关闭，仅为你推荐生效；通过“评论点赞下条”成功保存的评论计数，跳过不计。到达随机次数后刷新为你推荐并打开一条，仍需你确认发送。修改区间重新计数；手动刷新也重新计数。';
        row.addEventListener('change',async()=>{
          if(saving)return;
          const next={enabled:toggle.checked,min:Number(row.querySelector('.xrc-cycle-min').value),max:Number(row.querySelector('.xrc-cycle-max').value)};
          if(!Number.isInteger(next.min)||!Number.isInteger(next.max)||next.min<1||next.max>1000||next.min>next.max) {
            error='请输入1～1000且最小≤最大';requestRefresh();return;
          }
          saving=true;pendingConfig=next;error='';requestRefresh();
          try {await storage.local.set({[SETTINGS]:next});apply(next);}
          catch {error='设置未保存';}
          finally{saving=false;pendingConfig=null;requestRefresh();}
        });
        bar.append(row);
      }
      const shown=pendingConfig || config;
      for(const name of ['enabled','min','max']) {
        const input=row.querySelector('.xrc-cycle-'+name);
        if(name==='enabled'){if(input.checked!==shown.enabled)input.checked=shown.enabled;}
        else if(document.activeElement!==input && input.value!==String(shown[name]))input.value=String(shown[name]);
        const disabled=!ready||saving;if(input.disabled!==disabled)input.disabled=disabled;
      }
      const status=row.querySelector('.xrc-cycle-progress'),text=error||(config.enabled?`${count}/${target}`:'已关闭');
      if(status.textContent!==text)status.textContent=text;
      if(status.title!==text)status.title=text;
    }
    return {record,due,refresh,render,tick,pauseMessage:()=>pauseReason,cancel:()=>stopResume()};
  }
  globalThis.XReplyRefreshCycle={create,createBackground};
})();
