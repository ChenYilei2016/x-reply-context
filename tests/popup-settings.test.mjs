import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

test('弹窗点赞开关默认关闭、单独保存，保存失败回滚且不影响主页设置',async () => {
  const nodes = new Map();
  const settings = { hideCompletedHome:true };
  let failSave = false;
  const element = selector => {
    if (!nodes.has(selector)) nodes.set(selector,{ checked:false,disabled:true,
      addEventListener(name,handler) { this[name] = handler; } });
    return nodes.get(selector);
  };
  const context = vm.createContext({ document:{ querySelector:element },chrome:{
    storage:{ local:{ get:async key => ({ [key]:settings[key] }),set:async values => {
      if (failSave) throw new Error('failed'); Object.assign(settings,values);
    } } },tabs:{ query:async () => [] }
  } });
  vm.runInContext(await readFile(new URL('../extension/popup.js',import.meta.url),'utf8'),context);
  await new Promise(resolve => setImmediate(resolve));
  const likes = element('#auto-hide-like-notifications');
  assert.equal(likes.checked,false); assert.equal(likes.disabled,false);
  assert.equal(element('#hide-completed-home').checked,true);
  likes.checked = true; await likes.change();
  assert.equal(settings.autoHideLikeNotifications,true); assert.equal(settings.hideCompletedHome,true);
  failSave = true; likes.checked = false; await likes.change();
  assert.equal(likes.checked,true); assert.equal(settings.autoHideLikeNotifications,true);
  assert.match(element('#like-filter-status').textContent,/未保存/);
  assert.equal(likes.disabled,false);
});
