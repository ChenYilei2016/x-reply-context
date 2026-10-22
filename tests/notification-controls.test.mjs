import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = (await Promise.all(['card-filter.js','notification-filter.js'].map(name =>
  readFile(new URL(`../extension/${name}`,import.meta.url),'utf8')))).join('\n');

function setup() {
  const created = [];
  function node() {
    const attributes = new Map();
    const el = { children:[],isConnected:false,hidden:false,disabled:false,textContent:'',
      setAttribute:(key,value) => attributes.set(key,value),
      getAttribute:key => attributes.get(key) ?? null,
      hasAttribute:key => attributes.has(key),removeAttribute:key => attributes.delete(key),
      closest:() => null,getBoundingClientRect:() => ({ top:120,height:157 }),
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
  const env = { enabled:true,modal:false,cards:[article] };
  const primary = { querySelector:() => ({ parentElement:settings }),querySelectorAll:() => env.cards };
  const location = { pathname:'/notifications' };
  const context = vm.createContext({ window:{ innerHeight:720 },location,
    document:{ createElement:node,querySelector:() => primary,
      querySelectorAll:() => env.cards.filter(card => card.hasAttribute('data-xrc-notification-hidden')) } });
  vm.runInContext(source,context);
  const filter = context.XReplyNotificationFilter.create({
    columnSelector:'column',accountHandle:() => 'me',tweetId:card => card.id,enabled:() => env.enabled,
    ready:() => true,holdLayout:() => env.modal,save:async value => { env.enabled = value; },schedule() {},
    message:async request => ({ rows:request.ids.map(id => ({ id,status:'replied',evidenceId:'reply',likeEvidenceId:'like' })) })
  });
  const control = name => created.find(el => el.className === name);
  return { env,article,filter,control,location };
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
