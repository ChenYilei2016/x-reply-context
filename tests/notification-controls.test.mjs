import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = (await Promise.all(['card-filter.js','notification-filter.js'].map(name =>
  readFile(new URL(`../extension/${name}`,import.meta.url),'utf8')))).join('\n');

function setup() {
  const created = [];
  const listeners = new Map();
  const timers = new Map();
  let now = 0;
  let serial = 0;
  const listen = (name,handler) => listeners.set(name,[...(listeners.get(name) || []),handler]);
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  function node() {
    const attributes = new Map();
    const el = { children:[],isConnected:false,hidden:false,disabled:false,textContent:'',
      setAttribute:(key,value) => attributes.set(key,value),
      getAttribute:key => attributes.get(key) ?? null,
      hasAttribute:key => attributes.has(key),removeAttribute:key => attributes.delete(key),
      closest:() => null,getBoundingClientRect:() => ({ top:el.top ?? 120,height:157 }),
      addEventListener(name,handler) { this[name] = handler; },
      remove() {
        if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this),1);
        this.isConnected = false;
      },
      append(...items) {
        for (const item of items) {
          item.remove(); this.children.push(item); item.parentElement = this; item.isConnected = this.isConnected;
        }
      },
      before(item) {
        item.remove(); const parent = this.parentElement;
        parent.children.splice(parent.children.indexOf(this),0,item); item.parentElement = parent; item.isConnected = true;
        item.children.forEach(child => { child.isConnected = true; });
      },
      get previousElementSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this)-1]; }
    };
    created.push(el); return el;
  }
  const header = node(); header.isConnected = true;
  const settings = node(); header.append(settings);
  const article = node(); article.isConnected = true; article.id = '123';
  const env = { mode:"completed",enabled:true,auto:false,modal:false,hidden:false,complete:true,cards:[article],calls:0,jobs:[],accountReads:0 };
  const primary = { contains:card => env.cards.includes(card),
    querySelector:() => ({ parentElement:settings }),
    querySelectorAll:() => env.cards };
  const location = { pathname:'/notifications' };
  const window = { innerHeight:720,scrollY:0,addEventListener:listen };
  const context = vm.createContext({ window,location,Date:{ now:() => now },
    setTimeout:(fn,delay) => { const id = ++serial; timers.set(id,{ fn,at:now+delay }); return id; },
    clearTimeout:id => timers.delete(id),
    document:{ createElement:node,querySelector:() => primary,
      addEventListener:listen,get hidden() { return env.hidden; },
      querySelectorAll:() => env.cards.filter(card => card.hasAttribute('data-xrc-notification-hidden')) } });
  vm.runInContext(source,context);
  const filter = context.XReplyNotificationFilter.create({
    columnSelector:'column',accountHandle:() => { env.accountReads++; return 'me'; },tweetId:card => card.id,enabled:() => env.enabled,mode:() => env.enabled ? env.mode : "off",
    autoEnabled:() => env.auto,autoReady:() => true,saveAuto:async value => {
      if (env.failSaveAuto) throw new Error('failed');
      env.auto = value;
    },
    ready:() => true,holdLayout:() => env.modal,save:async value => {
      if (env.failSave) throw new Error("failed");
      env.enabled = value !== "off"; env.mode = value;
    },
    schedule() { env.jobs.push(filter.refresh()); },
    message:async request => {
      env.calls++;
      const result = { rows:request.ids.map(id => ({ id,status:env.complete ? 'replied' : 'unknown',
        evidenceId:env.complete ? 'reply' : '',likeEvidenceId:'like' })) };
      return env.reply ? env.reply(request,result) : result;
    }
  });
  const control = name => created.find(el => el.className === name);
  const clock = { timers,dispatch:(name,isTrusted = false) => {
    for (const listener of listeners.get(name) || []) listener({ type:name,isTrusted });
  },
    async advance(ms) {
      const end = now+ms;
      let steps = 0;
      for (;;) {
        const entry = [...timers].sort((a,b) => a[1].at-b[1].at).find(([,timer]) => timer.at <= end);
        if (!entry) break;
        assert.ok(++steps < 30,'自动整理不能产生即时循环');
        const [id,timer] = entry; now = timer.at; timers.delete(id); timer.fn(); await flush();
      }
      now = end; await flush();
    }
  };
  const makeCard = (id,top) => { const card = node(); card.id = id; card.top = top; card.isConnected = true; return card; };
  return { env,article,filter,control,location,clock,makeCard,window };
}

test('滚动使待更新项移出或回到DOM时，应用按钮保留原节点和位置，不再消失',async () => {
  const { env,article,filter,control,location } = setup();
  await filter.refresh();
  const apply = control('xrc-filter-apply');
  assert.equal(apply.hidden,false);
  assert.equal(apply.disabled,false);
  const parent = apply.parentElement;
  const index = parent.children.indexOf(apply);
  env.cards = []; await filter.refresh();
  assert.equal(apply.hidden,false,'没有待更新项时也不能移除按钮');
  assert.equal(apply.disabled,true);
  assert.equal(parent.children.indexOf(apply),index);
  env.cards = [article]; await filter.refresh();
  assert.equal(control('xrc-filter-apply'),apply);
  assert.equal(apply.textContent,'整理列表');
  assert.equal(apply.disabled,false);
  env.modal = true; location.pathname = '/compose/post'; await filter.refresh();
  assert.equal(apply.disabled,true,'编辑时不可整理背景列表');
  assert.equal(apply.hidden,false);
  env.modal = false; location.pathname = '/notifications'; env.enabled = false; await filter.refresh();
  assert.equal(apply.hidden,false,'关闭筛选也保留位置');
  assert.equal(apply.disabled,true);
});

async function automaticSetup() {
  const setupState = setup();
  const { env,makeCard,filter } = setupState;
  env.auto = true; env.complete = false;
  env.cards = [makeCard('above',-100),makeCard('reading',120),makeCard('below',1600)];
  await filter.refresh();
  env.complete = true; filter.invalidate(); await filter.refresh();
  return setupState;
}

test('通知中的他人原帖及引用帖，只有已评论且点赞本帖才可整理隐藏',async () => {
  const { env,filter,makeCard } = setup();
  env.cards = ['complete','text-only','heart-only','other-heart','mine'].map(id => makeCard(id,1600));
  env.reply = request => ({ rows:request.ids.map(id => ({ id,status:'not-reply',
    origin:id === 'mine' ? 'mine' : 'others',evidenceId:id === 'heart-only' ? '' : 'reply',
    likeEvidenceId:id === 'text-only' ? '' : id === 'other-heart' ? 'another-post' : id })) });
  await filter.refresh();
  filter.requestApply(); await filter.refresh();
  assert.deepEqual(env.cards.map(card => card.hasAttribute('data-xrc-notification-hidden')),[true,false,false,false,false]);
});

test('自动整理空闲10秒仅更新阅读区下方，交互重新计时，手动仍可全量整理',async () => {
  const { env,filter,clock,control } = await automaticSetup();
  const hidden = () => env.cards.map(card => card.hasAttribute('data-xrc-notification-hidden'));
  const reads = env.accountReads;
  for (let i = 0; i < 500; i++) clock.dispatch('scroll');
  assert.equal(env.accountReads,reads,'已计时期间滚动不能反复查询DOM账号');
  await clock.advance(9999); assert.deepEqual(hidden(),[false,false,false]);
  clock.dispatch('scroll');
  await clock.advance(9999); assert.deepEqual(hidden(),[false,false,false]);
  await clock.advance(1); assert.deepEqual(hidden(),[false,false,true]);
  assert.equal(filter.pendingCount(),2);
  const calls = env.calls;
  await clock.advance(60000); assert.equal(env.calls,calls,'仅保护区有变化时不持续分类');
  assert.equal(clock.timers.size,0);
  await control('xrc-filter-apply').click({ stopPropagation() {} });
  await Promise.all(env.jobs);
  assert.deepEqual(hidden(),[true,true,true]);
});

test('回复框和后台暂停，恢复后重新等10秒；自动开关可关闭且位置不变',async () => {
  const { env,filter,clock,location,control } = await automaticSetup();
  await clock.advance(5000);
  env.modal = true; location.pathname = '/compose/post'; await filter.refresh();
  assert.equal(clock.timers.size,0);
  await clock.advance(20000);
  assert.equal(env.cards[2].hasAttribute('data-xrc-notification-hidden'),false);
  env.modal = false; location.pathname = '/notifications'; await filter.refresh();
  await clock.advance(9999);
  env.hidden = true; clock.dispatch('visibilitychange');
  await clock.advance(20000);
  assert.equal(env.cards[2].hasAttribute('data-xrc-notification-hidden'),false);
  env.hidden = false; clock.dispatch('visibilitychange');
  await clock.advance(9999); assert.equal(env.cards[2].hasAttribute('data-xrc-notification-hidden'),false);
  await clock.advance(1); assert.equal(env.cards[2].hasAttribute('data-xrc-notification-hidden'),true);
  const auto = control('xrc-filter-auto');
  const index = auto.parentElement.children.indexOf(auto);
  await auto.click({ stopPropagation() {} });
  assert.equal(env.auto,false); assert.equal(clock.timers.size,0);
  assert.equal(auto.parentElement.children.indexOf(auto),index);
  assert.equal(auto.hidden,false);
});

test('自动整理一轮后，补位和布局滚动不能继续整理；真实用户再次操作才重启',async () => {
  const { env,filter,clock,makeCard } = await automaticSetup();
  await clock.advance(10000); await Promise.all(env.jobs);
  const arrived = makeCard('filled-complete',1800); env.cards.push(arrived);
  filter.invalidate(); await filter.refresh();
  clock.dispatch('scroll',true);
  await clock.advance(60000); await Promise.all(env.jobs);
  assert.equal(arrived.hasAttribute('data-xrc-notification-hidden'),false,'补位数据不能触发连续折叠和分页');
  clock.dispatch('wheel',true); await clock.advance(9999);
  assert.equal(arrived.hasAttribute('data-xrc-notification-hidden'),false);
  await clock.advance(1); await Promise.all(env.jobs);
  assert.equal(arrived.hasAttribute('data-xrc-notification-hidden'),true);
});

test('慢分类期间滚动或卡片移入阅读区，不应用过期自动整理；默认关闭不运行',async () => {
  const { env,filter,clock,window } = await automaticSetup();
  let finish;
  env.reply = (_request,result) => new Promise(resolve => { finish = () => resolve(result); });
  await clock.advance(10000);
  assert.equal(filter.applying(),true);
  window.scrollY = 200; clock.dispatch('wheel',true);
  env.cards[2].top = 200;
  finish(); await Promise.all(env.jobs);
  assert.equal(env.cards[2].hasAttribute('data-xrc-notification-hidden'),false);
  assert.equal(filter.applying(),false);
  env.reply = undefined; env.cards[2].top = 1600; filter.invalidate(); await filter.refresh();
  env.reply = (_request,result) => new Promise(resolve => { finish = () => resolve(result); });
  await clock.advance(10000);
  env.cards[2].top = 200;
  finish(); await Promise.all(env.jobs);
  assert.equal(env.cards[2].hasAttribute('data-xrc-notification-hidden'),false,'布局变化移入阅读区也不可收起');
  const off = setup(); await off.filter.refresh(); await off.clock.advance(60000);
  assert.equal(off.clock.timers.size,0);
  assert.equal(off.env.calls,1);
  const newFar = off.makeCard('new-far',1600); off.env.cards.push(newFar);
  off.filter.invalidate(); await off.filter.refresh();
  assert.equal(newFar.hasAttribute('data-xrc-notification-hidden'),false,'新挂载项也必须等待手动或空闲周期');
  off.env.failSaveAuto = true;
  await off.control('xrc-filter-auto').click({ stopPropagation() {} });
  assert.equal(off.env.auto,false);
  assert.match(off.control('xrc-filter-auto').title,/未保存/);
  assert.equal(off.clock.timers.size,0);
});


test('两个隐藏条件互斥，文字模式不要求红心，按钮固定且关闭可恢复',async () => {
  const { env,filter,makeCard,control } = setup();
  env.cards = ['text','both','heart','unknown','original','mine'].map(id => makeCard(id,1600));
  env.reply = request => ({rows:request.ids.map(id => ({id,
    status:['original','mine'].includes(id)?'not-reply':id==='unknown'?'unknown':'replied',
    origin:id==='mine'?'mine':'others',evidenceId:['heart','unknown'].includes(id)?'':'reply',
    likeEvidenceId:['text','original'].includes(id)?'':id}))});
  await filter.refresh(); filter.requestApply(); await filter.refresh();
  const hidden = () => env.cards.map(card=>card.hasAttribute('data-xrc-notification-hidden'));
  assert.deepEqual(hidden(),[false,true,false,false,false,false]);
  const original=control('xrc-notification-filter'), text=control('xrc-notification-replied');
  const positions=[...text.parentElement.children];
  await text.click({stopPropagation(){}}); await Promise.all(env.jobs);
  assert.equal(env.mode,'replied'); assert.equal(original.getAttribute('aria-pressed'),'false');
  assert.equal(text.getAttribute('aria-pressed'),'true');
  assert.deepEqual(hidden(),[true,true,false,false,true,false]);
  await original.click({stopPropagation(){}}); await Promise.all(env.jobs);
  assert.deepEqual(hidden(),[false,true,false,false,false,false]);
  assert.equal(original.getAttribute('aria-pressed'),'true'); assert.equal(text.getAttribute('aria-pressed'),'false');
  await original.click({stopPropagation(){}}); await Promise.all(env.jobs);
  assert.equal(env.mode,'off'); assert.ok(hidden().every(value=>!value));
  assert.deepEqual(text.parentElement.children,positions);
});

test('文字模式保存失败或回复框打开时保留旧条件；晚到数据仍保护阅读区',async () => {
  const {env,filter,control,article}=setup();await filter.refresh();
  const text=control('xrc-notification-replied');
  env.failSave=true; await text.click({stopPropagation(){}});
  assert.equal(env.mode,'completed');assert.equal(text.getAttribute('aria-pressed'),'false');
  assert.match(text.title,/未保存/);
  env.failSave=false;env.modal=true;await filter.refresh();
  assert.ok(text.disabled);await text.click({stopPropagation(){}});assert.equal(env.mode,'completed');
  env.modal=false;env.complete=false;
  await text.click({stopPropagation(){}});await Promise.all(env.jobs);
  assert.equal(article.hasAttribute('data-xrc-notification-hidden'),false);
  env.complete=true; filter.invalidate();await filter.refresh();
  assert.equal(article.hasAttribute('data-xrc-notification-hidden'),false,'后续资料不能直接移走当前阅读行');
});
