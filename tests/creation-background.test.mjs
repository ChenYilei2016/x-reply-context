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
    async putDrafts(list) { savedDrafts.push(...list); return 0; },
    upserted: [], marks: [],
    async upsertMany(list) { db.upserted.push(...list); return {inserted: list.length, updated: 0}; },
    async setMark(id, mark, value) { db.marks.push([id, mark, value]); }
  };
  const remove = store => async keys => keys.forEach(key => delete store[key]);
  const chrome = {
    runtime: {id: 'ext', getURL: path => `chrome-extension://test/${path}`},
    storage: {local: {get: async key => ({[key]: local[key]}), set: async values => Object.assign(local, values), remove: remove(local)}, session: {remove: remove(session)}},
    tabs: {created: [], updated: [], create: async options => { chrome.tabs.created.push(options); return options; },
      update: async (id, options) => { chrome.tabs.updated.push([id, options]); return {id, windowId: 7}; }},
    windows: {update: async () => {}},
    permissions: {contains: async () => true},
    alarms: {created: null, get: async () => null, create: async (name, options) => { chrome.alarms.created = {name, ...options}; }}
  };
  const scope = vm.createContext({URL, XReplyMaterialDB: {create: () => db}});
  sources.forEach(source => vm.runInContext(source, scope));
  return {scope, chrome, local, session, removedStates, savedDrafts, db, rewriteWith: () => rewriteWith};
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

const xTab = {id: 'ext', tab: {id: 5, index: 2}, frameId: 0, url: 'https://x.com/home'};
const post = (id = '1890000000000000001') => ({id: `x:${id}`, kind: 'x_post', url: `https://x.com/alice/status/${id}`, text: '别人的爆款正文',
  coverage: 'full', author: {handle: 'alice', name: '爱丽丝'}, metrics: {views: 250000, likes: 12000}});

test('X 页面「改写」：写入素材库并收藏，已选素材换成这一条，写作台切到改写并在旁边打开', async () => {
  const {scope, chrome, local, db} = setup();
  local.creationBasket = ['https://a.example/1', 'x:2'];
  const service = scope.XReplyCreationBackground.create(chrome);
  const reply = await service.handle({type: 'CREATION_PICK_POST', action: 'rewrite', post: post()}, xTab);
  assert.equal(reply.ok, true);
  assert.equal(db.upserted[0].channelIds[0], 'x-pick');
  assert.equal(db.upserted[0].metricsSource, 'channel_reported');
  assert.deepEqual(db.marks, [['x:1890000000000000001', 'saved', true]]);
  assert.deepEqual([...local.creationBasket], ['x:1890000000000000001']);
  assert.equal(local.creationStudioIntent.mode, 'rewrite');
  assert.deepEqual(JSON.parse(JSON.stringify(chrome.tabs.created)), [{url: 'chrome-extension://test/creation/studio.html', index: 3, openerTabId: 5}]);

  chrome.runtime.getContexts = async () => [{tabId: 42}];
  await service.handle({type: 'CREATION_PICK_POST', action: 'rewrite', post: post()}, xTab);
  assert.equal(chrome.tabs.updated[0][0], 42, '写作台已打开时切换过去，不再新开');
  assert.equal(chrome.tabs.created.length, 1);
});

test('X 页面「选入」：追加到已选素材，重复不追加，满 3 条时提示', async () => {
  const {scope, chrome, local} = setup();
  local.creationBasket = ['a'];
  const service = scope.XReplyCreationBackground.create(chrome);
  const pick = id => service.handle({type: 'CREATION_PICK_POST', action: 'pick', post: post(id)}, xTab);
  assert.equal((await pick('11')).basketCount, 2);
  const again = await pick('11');
  assert.equal(again.alreadyPicked, true);
  assert.equal(again.basketCount, 2);
  assert.equal((await pick('12')).basketCount, 3);
  await assert.rejects(pick('13'), /已选满 3 条/);
  assert.deepEqual([...local.creationBasket], ['a', 'x:11', 'x:12']);
  assert.equal(chrome.tabs.created.length, 0, '选入不打开写作台');
});

test('X 页面消息：只接受本扩展在 x.com 顶层框架的内容脚本，拒绝无效帖子与未知操作', async () => {
  const {scope, chrome, db} = setup();
  const service = scope.XReplyCreationBackground.create(chrome);
  const message = {type: 'CREATION_PICK_POST', action: 'pick', post: post()};
  assert.equal((await service.handle(message, {...xTab, url: 'https://evil.example/'})).ok, false);
  assert.equal((await service.handle(message, {...xTab, frameId: 3})).ok, false);
  assert.equal((await service.handle(message, {...xTab, id: 'other'})).ok, false);
  assert.equal((await service.handle(message, {url: 'chrome-extension://test/creation/studio.html'})).ok, false, '创作页面也不能伪造选入');
  await assert.rejects(service.handle({...message, action: 'delete'}, xTab), /未知操作/);
  await assert.rejects(service.handle({...message, post: {...post(), kind: 'article'}}, xTab), /帖子内容无效/);
  await assert.rejects(service.handle({...message, post: {...post(), id: 'https://a.example/1'}}, xTab), /帖子内容无效/);
  assert.equal(db.upserted.length, 0);
});
