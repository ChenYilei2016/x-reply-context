import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

test('弹窗保留已关闭的选择、单独保存，保存失败回滚且不影响主页设置',async () => {
  const nodes = new Map();
  const settings = { hideCompletedHome:true,autoHideLikeNotifications:false,autoHideFollowNotifications:false };
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
  const follows = element('#auto-hide-follow-notifications');
  assert.equal(follows.checked,false); assert.equal(follows.disabled,false);
  const reposts = element('#auto-hide-repost-notifications');
  assert.equal(reposts.checked,false,'转发过滤默认关闭'); assert.equal(reposts.disabled,false);
  reposts.checked = true; await reposts.change();
  assert.equal(settings.autoHideRepostNotifications,true);
  assert.equal(settings.autoHideLikeNotifications,false); assert.equal(settings.autoHideFollowNotifications,false);
  reposts.checked = false; await reposts.change();
  assert.equal(settings.autoHideRepostNotifications,false);
  assert.match(element('#repost-filter-status').textContent,/刷新/);
  likes.checked = true; await likes.change();
  assert.equal(settings.autoHideLikeNotifications,true); assert.equal(settings.hideCompletedHome,true);
  follows.checked = true; await follows.change();
  assert.equal(settings.autoHideFollowNotifications,true); assert.equal(settings.autoHideLikeNotifications,true);
  follows.checked = false; await follows.change();
  assert.equal(settings.autoHideFollowNotifications,false); assert.equal(likes.checked,true);
  failSave = true; likes.checked = false; await likes.change();
  assert.equal(likes.checked,true); assert.equal(settings.autoHideLikeNotifications,true);
  assert.match(element('#like-filter-status').textContent,/未保存/);
  assert.equal(likes.disabled,false);
  reposts.checked = true; await reposts.change();
  assert.equal(reposts.checked,false,'保存失败恢复原选择');
  assert.equal(settings.autoHideRepostNotifications,false);
});
