import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { likeIconPath } from './fixtures.mjs';
const source = await readFile(new URL('../extension/like-notifications.js',import.meta.url),'utf8');
const attribute = 'data-xrc-like-notification-hidden';
function setup() {
  const env = { account:'me',modal:false,active:true,auto:false,cards:[] };
  const primary = { contains:card => env.cards.includes(card),querySelectorAll:() => env.cards };
  const context = vm.createContext({ window:{ innerHeight:720 },
    document:{ querySelectorAll:selector => env.cards.filter(card => selector.split(',').some(part => card.hasAttribute(part.slice(1,-1)))) } });
  vm.runInContext(source,context);
  const filter = context.XReplyLikeNotifications.create({ column:() => env.active ? primary : null,
    accountHandle:() => env.account,holdLayout:() => env.modal,autoEnabled:() => env.auto });
  function card(kind = 'like') {
    const attributes = new Map();
    const node = { kind,top:1600,stamp:'2026-10-22T00:00:00Z',summary:'Someone 喜欢了你的回复',href:'/person',snippet:'fixture',
      getBoundingClientRect:() => ({ top:node.top }),
      matches:() => node.kind !== 'tweet',getAttribute:key => attributes.get(key) ?? null,
      hasAttribute:key => attributes.has(key),setAttribute:(key,value) => attributes.set(key,value),
      removeAttribute:key => attributes.delete(key),
      querySelector(selector) {
        if (selector.includes('svg path')) return { getAttribute:() => node.kind === 'like' || node.kind === 'tweet' ? likeIconPath : 'follow-icon' };
        if (selector === 'time') return { getAttribute:() => node.stamp,
          closest:() => ({ querySelector:() => ({ textContent:node.summary }) }) };
        return { textContent:node.snippet };
      },
      querySelectorAll:() => [{ getAttribute:() => node.href }]
    };
    env.cards.push(node); return node;
  }
  return { env,filter,card };
}
test('手动只采纳一次已加载快照，新点赞和后续DOM刷新不会继续隐藏',() => {
  const { env,filter,card } = setup();
  const old = card(); const follow = card('follow'); const tweet = card('tweet');
  filter.clearLoaded();
  assert.equal(old.hasAttribute(attribute),true);
  assert.equal(follow.hasAttribute(attribute),false); assert.equal(tweet.hasAttribute(attribute),false);
  const arrived = card(); arrived.stamp = '2026-10-22T00:01:00Z';
  for (let i = 0; i < 100; i++) filter.sync();
  assert.equal(arrived.hasAttribute(attribute),false);
  old.summary = 'A different person liked another post'; filter.sync();
  assert.equal(old.hasAttribute(attribute),false,'虚拟节点复用时不沿用旧隐藏标记');
  filter.clearLoaded(); env.active = false; env.modal = true; filter.sync();
  assert.equal(arrived.hasAttribute(attribute),true,'回复框不使背景突然恢复');
  env.modal = false; filter.sync();
  assert.equal(arrived.hasAttribute(attribute),false);
});
test('缺少稳定时间字段时保留；换账号和显式恢复清除本地标记',() => {
  const { env,filter,card } = setup();
  const unknown = card(); unknown.stamp = '';
  const like = card(); filter.clearLoaded();
  assert.equal(unknown.hasAttribute(attribute),false);
  env.account = 'other'; filter.sync(); assert.equal(like.hasAttribute(attribute),false);
  filter.clearLoaded(); filter.restore(); assert.equal(like.hasAttribute(attribute),false);
});
test('单次最多100条，不循环处理余下通知',() => {
  const { env,filter,card } = setup();
  for (let i = 0; i < 150; i++) card();
  filter.clearLoaded();
  for (let i = 0; i < 10; i++) filter.sync();
  assert.equal(env.cards.filter(node => node.hasAttribute(attribute)).length,100);
});

const automaticAttribute = 'data-xrc-auto-like-hidden';
test('自动点赞只处理阅读区下方一批，补位和重复同步不能重新启动',() => {
  const { env,filter,card } = setup();
  env.auto = true;
  const reading = card(); reading.top = 100;
  const above = card(); above.top = -100;
  const follow = card('follow'); const tweet = card('tweet');
  for (let i = 0; i < 150; i++) card();
  filter.sync(); filter.clearAutomaticBelow();
  assert.equal(env.cards.filter(node => node.hasAttribute(automaticAttribute)).length,100);
  for (const node of [reading,above,follow,tweet]) assert.equal(node.hasAttribute(automaticAttribute),false);
  const arrived = card();
  for (let i = 0; i < 100; i++) { filter.sync(); filter.clearAutomaticBelow(); }
  assert.equal(arrived.hasAttribute(automaticAttribute),false);
  assert.equal(filter.pendingAutomatic(),false);
  filter.armAutomatic(); filter.clearAutomaticBelow();
  assert.equal(arrived.hasAttribute(automaticAttribute),true);
});
test('自动点赞独立恢复、回复框保持、节点复用与账号切换',() => {
  const { env,filter,card } = setup();
  const manual = card(); filter.clearLoaded();
  env.auto = true;
  const automatic = card(); filter.sync(); filter.clearAutomaticBelow();
  assert.equal(automatic.hasAttribute(automaticAttribute),true);
  env.auto = false; env.modal = true; env.active = false; filter.sync();
  assert.equal(automatic.hasAttribute(automaticAttribute),true);
  env.modal = false; env.active = true; filter.sync();
  assert.equal(automatic.hasAttribute(automaticAttribute),false);
  assert.equal(manual.hasAttribute(attribute),true);
  env.auto = true; filter.sync(); filter.clearAutomaticBelow();
  automatic.stamp = 'different'; filter.sync();
  assert.equal(automatic.hasAttribute(automaticAttribute),false);
  filter.armAutomatic(); filter.clearAutomaticBelow(); env.account = 'other'; filter.sync();
  assert.equal(automatic.hasAttribute(automaticAttribute),false);
  filter.clearAutomaticBelow(); env.active = false; filter.sync();
  assert.equal(env.cards.some(node => node.hasAttribute(automaticAttribute)),false);
});
