import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../extension/companion.js',import.meta.url),'utf8');
const sender={url:'https://x.com/compose/post',frameId:0,tab:{windowId:1,incognito:false}};
function setup() {
  const saved={},windows=new Map([[1,{id:1,width:1512,height:891,left:0,top:33}]]);
  let next=10,creates=0,failSave=false,failFocus=false;
  const navigations=[],updates=[];
  const api={storage:{session:{get:async key=>({[key]:saved[key]}),set:async data=>{if(failSave)throw Error('storage');Object.assign(saved,data);},remove:async key=>{delete saved[key];}}},
    windows:{get:async id=>{if(!windows.has(id))throw Error('closed');return windows.get(id);},
      create:async options=>{creates++;const window={id:++next,...options,tabs:[{id:next+100}]};windows.set(next,window);return window;},
      update:async(id,options)=>{if(failFocus)throw Error('focus');updates.push({id,...options});Object.assign(windows.get(id),options);},
      remove:async id=>{windows.delete(id);}},tabs:{update:async(id,options)=>{navigations.push({id,...options});}}};
  const scope=vm.createContext({URL});vm.runInContext(source,scope);
  const create=()=>scope.XReplyCompanion.create(api);
  return {create,saved,windows,navigations,updates,get creates(){return creates;},failSave:()=>{failSave=true;},failFocus:()=>{failFocus=true;}};
}
test('伴随窗口并发点击只创建一次；之后不同人也只唤起，不重载或转移草稿',async()=>{
  const env=setup(),flow=env.create();
  const results=await Promise.all(Array.from({length:20},(_,i)=>flow.open({handle:i%2?'bob':'alice'},sender)));
  assert.equal(env.creates,1);assert.equal(env.navigations.length,1);
  assert.equal(env.navigations[0].url,'https://x.com/alice');
  assert.ok(results.every(r=>r.ok));
  const result=await flow.open({handle:'bob'},sender);
  assert.equal(result.reused,true);assert.equal(result.handle,'alice');
  assert.equal(env.navigations.length,1);assert.equal(env.creates,1);
  assert.deepEqual(env.updates[0],{id:11,focused:true});
});
test('服务工作线程重启后仍复用会话内窗口，最小化时恢复',async()=>{
  const env=setup();await env.create().open({handle:'alice'},sender);
  env.windows.get(11).state='minimized';
  assert.equal((await env.create().open({handle:'alice'},sender)).reused,true);
  assert.equal(env.creates,1);assert.deepEqual(env.updates[0],{id:11,state:'normal',focused:true});
});
test('关闭删除引用，下一次才创建；其他窗口关闭不影响伴随窗口',async()=>{
  const env=setup(),flow=env.create();await flow.open({handle:'alice'},sender);
  await flow.removed(1);assert.ok(env.saved.replyContextCompanion);
  env.windows.delete(11);await flow.removed(11);assert.equal(env.saved.replyContextCompanion,undefined);
  await flow.open({handle:'bob'},sender);assert.equal(env.creates,2);
  assert.equal(env.navigations[1].url,'https://x.com/bob');
});
test('睡眠时错过关闭事件也能清除失效引用再打开',async()=>{
  const env=setup(),flow=env.create();await flow.open({handle:'alice'},sender);
  env.windows.delete(11);
  await env.create().open({handle:'bob'},sender);assert.equal(env.creates,2);
});
test('窗口唤起失败不另开重试，不覆盖现有页面',async()=>{
  const env=setup(),flow=env.create();await flow.open({handle:'alice'},sender);env.failFocus();
  assert.equal((await flow.open({handle:'bob'},sender)).ok,false);
  assert.equal(env.creates,1);assert.equal(env.navigations.length,1);
});
test('窗口引用保存失败只关闭新建空白窗口，不加载 X',async()=>{
  const env=setup();env.failSave();
  assert.equal((await env.create().open({handle:'alice'},sender)).ok,false);
  assert.equal(env.navigations.length,0);assert.equal(env.windows.size,1);
});
test('拒绝非法账号、非 X 来源、子 frame 和隐身窗口',async()=>{
  const env=setup(),flow=env.create();
  for(const [handle,from] of [['../settings',sender],['alice',{...sender,url:'https://example.org/'}],
    ['alice',{...sender,frameId:1}],['alice',{...sender,tab:{windowId:1,incognito:true}}]]) {
    assert.equal((await flow.open({handle},from)).ok,false);
  }
  assert.equal(env.creates,0);
});
