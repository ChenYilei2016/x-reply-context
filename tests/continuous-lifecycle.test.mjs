import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../extension/continuous.js',import.meta.url),'utf8');
test('没有连续回复会话时切到后台或离开页面，不抛异常或触发操作',()=>{
 const handlers=new Map();
 const scope=vm.createContext({document:{hidden:true,addEventListener:(name,fn)=>handlers.set('document:'+name,fn)},
  window:{addEventListener:(name,fn)=>handlers.set('window:'+name,fn)}});
 vm.runInContext(source,scope);
 scope.XReplyContinuous.create({});
 assert.doesNotThrow(()=>handlers.get('document:visibilitychange')());
 assert.doesNotThrow(()=>handlers.get('window:pagehide')());
});
