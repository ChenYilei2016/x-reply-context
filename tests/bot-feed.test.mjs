import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const files = ['material-model.js', 'channel-http.js', 'channel-registry.js', 'channels/bot-feed.js', 'channel-scheduler.js', 'creation-background.js'];
const sources = await Promise.all(files.map(file => read(`extension/creation/${file}`)));
const NOW = Date.parse('2026-11-16T12:00:00Z');

function setup() {
  const stored = {};
  const chrome = {
    runtime: {getURL: path => `chrome-extension://test/${path}`},
    storage: {local: {get: async key => ({[key]: stored[key]}), set: async values => Object.assign(stored, structuredClone(values))}},
    permissions: {contains: async () => true}, alarms: {get: async () => null, create: async () => {}}
  };
  const db = {states: {}, async channelStates() { return this.states; }, async count() { return 0; }};
  const scope = vm.createContext({URL, XReplyMaterialDB: {create: () => db}});
  sources.forEach(source => vm.runInContext(source, scope));
  return {scope, stored, service: scope.XReplyCreationBackground.create(chrome)};
}

function materialsFrom(scope, feed) {
  const {XReplyChannels: channels, XReplyMaterialModel: model} = scope;
  const definition = channels.get('bot-feed');
  return definition.parse(feed, {now: NOW}).map(item => model.normalize(item, {channelId: 'bot-feed', now: NOW,
    defaultCategory: model.MaterialCategory.OTHER, metricsSource: model.MetricsSource.CHANNEL_REPORTED}));
}

test('文档示例 feed 与指南内嵌示例都能完整入库', async () => {
  const {scope} = setup();
  const example = JSON.parse(await read('docs/guide/bot-feed.example.json'));
  const results = materialsFrom(scope, example);
  assert.ok(results.every(result => result.material), JSON.stringify(results.map(result => result.error)));
  const [post, article] = results.map(result => result.material);
  assert.equal(post.category, 'ai');
  assert.equal(post.metricsSource, 'channel_reported');
  assert.equal(scope.XReplyMaterialModel.breakoutRatio(post) > 20, true);
  assert.equal(article.category, 'entertainment');
  const guide = await read('docs/guide/bot-feed.md');
  const embedded = JSON.parse(guide.match(/```json\n([\s\S]*?)\n```/)[1]);
  assert.ok(materialsFrom(scope, embedded).every(result => result.material));
});

test('feed 格式错误时整渠道报错，地址默认指向本机服务', () => {
  const {scope} = setup();
  const definition = scope.XReplyChannels.get('bot-feed');
  assert.throws(() => definition.parse({schema: 'other', items: []}), /schema/);
  assert.throws(() => definition.parse({schema: 'xrc.feed/v1'}), /items/);
  assert.equal(scope.XReplyChannels.resolveUrl(definition, {}), 'http://127.0.0.1:8765/feed.json');
  assert.equal(scope.XReplyChannels.resolveUrl(definition, {url: 'http://localhost:9000/feed.json'}), 'http://localhost:9000/feed.json');
});

test('渠道设置：bot 地址只能指向本机，其他渠道不能改地址', async () => {
  const {service, stored} = setup();
  const page = {url: 'chrome-extension://test/creation/channels.html'};
  const save = extra => service.handle({type: 'CREATION_CHANNEL_SETTINGS', channelId: 'bot-feed', ...extra}, page);
  assert.equal((await save({url: 'http://127.0.0.1:9000/feed.json'})).ok, true);
  assert.equal(stored.creationChannelSettings['bot-feed'].url, 'http://127.0.0.1:9000/feed.json');
  await assert.rejects(save({url: 'https://evil.example/feed.json'}), /只能指向/);
  await assert.rejects(save({url: 'http://192.168.1.2:8765/feed.json'}), /只能指向/);
  assert.equal((await save({url: '', enabled: false})).ok, true, '清空恢复默认地址');
  assert.deepEqual({...stored.creationChannelSettings['bot-feed']}, {url: '', enabled: false});
  await assert.rejects(service.handle({type: 'CREATION_CHANNEL_SETTINGS', channelId: 'nope', url: ''}, page), /不可修改/);
});
