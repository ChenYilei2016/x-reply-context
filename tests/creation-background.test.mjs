import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const files = ['material-model.js', 'channel-http.js', 'channel-registry.js', 'channel-scheduler.js', 'creation-background.js'];
const sources = await Promise.all(files.map(file => readFile(new URL(`../extension/creation/${file}`, import.meta.url), 'utf8')));

function setup() {
  const local = {creationXCaptureEnabled: false, creationVelocityBadge: true, other: 1};
  const session = {creationPendingSaves: ['x:1'], keep: 2};
  const removedStates = [];
  let rewriteWith;
  const db = {
    async rewrite(transform) { rewriteWith = transform; return {updated: 0, deleted: 0}; },
    async deleteChannelState(id) { removedStates.push(id); },
    async channelStates() { return {}; }, async count() { return 0; }
  };
  const remove = store => async keys => keys.forEach(key => delete store[key]);
  const chrome = {
    runtime: {getURL: path => `chrome-extension://test/${path}`},
    storage: {local: {get: async () => ({}), set: async () => {}, remove: remove(local)}, session: {remove: remove(session)}},
    permissions: {contains: async () => true},
    alarms: {created: null, get: async () => null, create: async (name, options) => { chrome.alarms.created = {name, ...options}; }}
  };
  const scope = vm.createContext({URL, XReplyMaterialDB: {create: () => db}});
  sources.forEach(source => vm.runInContext(source, scope));
  return {scope, chrome, local, session, removedStates, rewriteWith: () => rewriteWith};
}

test('下线 X 浏览采集：只来自该渠道的素材删除，多来源素材去掉该渠道并降为渠道报告', () => {
  const {scope} = setup();
  const {withoutRetiredXChannel: migrate} = scope.XReplyCreationBackground;
  const base = {id: 'x:1', metricsSource: 'x_observed', snapshots: [{at: 1, source: 'x_observed', views: 9}, {at: 2, source: 'rank_only', rank: 1}]};
  assert.equal(migrate({...base, channelIds: ['x-observed']}), null);
  const shared = migrate({...base, channelIds: ['x-observed', 'bot-feed']});
  assert.deepEqual([...shared.channelIds], ['bot-feed']);
  assert.equal(shared.metricsSource, 'channel_reported');
  assert.deepEqual(shared.snapshots.map(snapshot => snapshot.source), ['channel_reported', 'rank_only']);
  const untouched = {...base, channelIds: ['ithome'], metricsSource: 'none'};
  assert.equal(migrate(untouched), untouched, '其他素材原样返回，不触发写入');
});

test('安装或更新时建立定时器，并清除已下线功能的数据与设置', async () => {
  const {scope, chrome, local, session, removedStates, rewriteWith} = setup();
  const service = scope.XReplyCreationBackground.create(chrome);
  await service.handleInstalled();
  assert.equal(chrome.alarms.created.name, 'creationChannels');
  assert.equal(rewriteWith(), scope.XReplyCreationBackground.withoutRetiredXChannel);
  assert.deepEqual(removedStates, ['x-observed']);
  assert.deepEqual({...local}, {other: 1});
  assert.deepEqual({...session}, {keep: 2});
  assert.equal((await service.handle({type: 'CREATION_INGEST_X', posts: []}, {frameId: 0, url: 'https://x.com/home'})).ok, false, '不再接受 X 页面提交');
});
