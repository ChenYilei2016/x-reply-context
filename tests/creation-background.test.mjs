import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const files = ['material-model.js', 'channel-http.js', 'channel-registry.js', 'channel-scheduler.js', 'draft-record.js', 'creation-background.js'];
const sources = await Promise.all(files.map(file => readFile(new URL(`../extension/creation/${file}`, import.meta.url), 'utf8')));

function setup() {
  const local = {creationXCaptureEnabled: false, creationVelocityBadge: true, other: 1,
    creationDrafts: [{id: 'old-1', text: '旧草稿正文', title: '旧草稿', revision: 3, updatedAt: 5,
      materials: [{title: 'IT之家新闻', url: 'https://www.ithome.com/0/1.htm', source: 'IT之家', text: '很长的正文'}]}, {id: 'empty', text: '  '}],
    creationNews: {ithome: {}}, creationMarks: {a: {}}, creationPreferences: {style: 'brief'}};
  const savedDrafts = [];
  const session = {creationPendingSaves: ['x:1'], keep: 2};
  const removedStates = [];
  let rewriteWith;
  const db = {
    async rewrite(transform) { rewriteWith = transform; return {updated: 0, deleted: 0}; },
    async deleteChannelState(id) { removedStates.push(id); },
    async channelStates() { return {}; }, async count() { return 0; },
    async putDrafts(list) { savedDrafts.push(...list); return 0; }
  };
  const remove = store => async keys => keys.forEach(key => delete store[key]);
  const chrome = {
    runtime: {getURL: path => `chrome-extension://test/${path}`},
    storage: {local: {get: async key => ({[key]: local[key]}), set: async () => {}, remove: remove(local)}, session: {remove: remove(session)}},
    permissions: {contains: async () => true},
    alarms: {created: null, get: async () => null, create: async (name, options) => { chrome.alarms.created = {name, ...options}; }}
  };
  const scope = vm.createContext({URL, XReplyMaterialDB: {create: () => db}});
  sources.forEach(source => vm.runInContext(source, scope));
  return {scope, chrome, local, session, removedStates, savedDrafts, rewriteWith: () => rewriteWith};
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

test('更新时迁移 0.26.0 旧草稿：保留正文、素材标题与链接和原保存时间，空草稿丢弃，旧缓存删除', async () => {
  const {scope, chrome, local, savedDrafts} = setup();
  const result = await scope.XReplyCreationBackground.create(chrome).handleInstalled();
  assert.equal(result.migratedDrafts, 1);
  assert.equal(savedDrafts.length, 1);
  const [draft] = savedDrafts;
  assert.equal(draft.id, 'legacy:old-1');
  assert.equal(draft.text, '旧草稿正文');
  assert.equal(draft.status, 'draft');
  assert.equal(draft.origin, 'legacy');
  assert.equal(draft.updatedAt, 5);
  assert.deepEqual(JSON.parse(JSON.stringify(draft.materials)), [{id: '', title: 'IT之家新闻', url: 'https://www.ithome.com/0/1.htm'}]);
  for (const key of ['creationDrafts', 'creationNews', 'creationMarks', 'creationPreferences']) assert.equal(key in local, false);
});
