import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../extension/interaction-alert.js',import.meta.url),'utf8');
function setup(){
 const handlers={window:new Map(),document:new Map()};let account='me';
 class Element {
  constructor(tag='div',editing=false){this.tag=tag;this.children=[];this.editing=editing;}
  setAttribute(){} addEventListener(){} append(...nodes){this.children.push(...nodes);} remove(){}
  querySelector(s){return this.children.find(n=>s.startsWith('.')?n.className===s.slice(1):n.tag===s);}
  closest(s){return this.editing && (s.includes('contenteditable')||s.includes('textarea'))?this:null;}
 }
 const register=kind=>(name,fn)=>{if(!handlers[kind].has(name))handlers[kind].set(name,[]);handlers[kind].get(name).push(fn);};
 const scope=vm.createContext({Element,window:{addEventListener:register('window')},document:{createElement:t=>new Element(t),body:new Element(),addEventListener:register('document')}});
 vm.runInContext(source,scope);
 const guard=scope.XReplyInteractionAlert.create({accountHandle:()=>account,onPause(){},onRelease(){}});
 const key=(name,key,extra={},editing=false)=>{
  const e={key,target:new Element('div',editing),preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;},...extra};
  for(const kind of ['window','document'])for(const fn of handlers[kind].get(name)||[]){if(!e.stopped)fn(e);}
  return Boolean(e.prevented);
 };
 return {guard,key,account:value=>{account=value;},show:()=>guard.show({account:'me',operation:'FavoriteTweet',httpStatus:429})};
}
test('暂停时各阶段拦截原生互动键；保留编辑文本及导航',()=>{
 const env=setup();env.show();
 for(const phase of ['keydown','keypress','keyup']){
  for(const key of ['l','L','r','t','n'])assert.equal(env.key(phase,key),true,phase+':'+key);
  assert.equal(env.key(phase,'l',{},true),false,'草稿中的字母不能被吞掉');
  assert.equal(env.key(phase,'j'),false,'仍可浏览下一张卡片');
 }
 assert.equal(env.key('keydown','Enter',{metaKey:true},true),true);
 assert.equal(env.key('keydown','Enter',{altKey:true}),true,'焦点回到列表也拦截发送组合键');
 assert.equal(env.key('keydown','Tab',{altKey:true},true),true);
 assert.equal(env.key('keydown','q',{altKey:true,code:'KeyQ'},true),true);
});
test('账号临时为空不能解锁，确认换账号后才释放当前页保护',()=>{
 const env=setup();env.show();assert.equal(env.guard.blocked(),true);
 env.account('');assert.equal(env.guard.blocked(),true);
 env.account('me');assert.equal(env.guard.blocked(),true);
 env.account('other');assert.equal(env.guard.blocked(),false);
});
