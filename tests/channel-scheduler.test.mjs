import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const files = ['material-model.js', 'channel-http.js', 'channel-registry.js', 'channel-scheduler.js'];
const sources = await Promise.all(files.map(file => readFile(new URL(`../extension/creation/${file}`, import.meta.url), 'utf8')));
const MINUTE = 60_000;
const NOW = Date.parse('2026-11-16T12:00:00Z');

/** 按主机返回预设响应；值为函数时调用它（可抛错模拟失败）。 */
const routes = {};
const routedFetch = async url => {
  const route = routes[new URL(url).hostname];
  const value = typeof route === 'function' ? await route() : route;
  return new Response(JSON.stringify(value), {headers: {'content-type': 'application/json'}});
};

function setup({fetchImpl = routedFetch, granted = () => true} = {}) {
  const scope = vm.createContext({URL, AbortController, TextDecoder, Response, setTimeout, clearTimeout, fetch: fetchImpl});
  sources.forEach(source => vm.runInContext(source, scope));
  const stored = {};
  const chrome = {
    storage: {local: {get: async key => ({[key]: structuredClone(stored[key])}), set: async values => Object.assign(stored, structuredClone(values))}},
    permissions: {contains: async ({origins}) => origins.every(granted)}
  };
  const db = {
    states: {}, materials: [], pruned: 0,
    async upsertMany(items) { this.materials.push(...items); return {inserted: items.length, updated: 0}; },
    async saveChannelState(state) { this.states[state.channelId] = state; },
    async channelStates() { return structuredClone(this.states); },
    async prune() { this.pruned++; return 0; },
    async count() { return this.materials.length; }
  };
  let now = NOW;
  const clock = () => now;
  const advance = minutes => { now += minutes * MINUTE; };
  const make = extra => scope.XReplyChannelScheduler.create({
    chrome, db, channels: scope.XReplyChannels, model: scope.XReplyMaterialModel, http: scope.XReplyChannelHttp, clock, ...extra
  });
  return {scope, chrome, db, advance, make, stored};
}

const item = n => ({id: `https://a.example/${n}`, kind: 'article', url: `https://a.example/${n}`, title: `新闻 ${n}`});
function definition(id, response, extra = {}) {
  routes[`${id}.example`] = response;
  return {id, name: id, category: 'tech', intervalMinutes: 30, origins: [`https://${id}.example/*`], hosts: [`${id}.example`], maxItems: 3,
    url: `https://${id}.example/feed`, format: 'json', parse: body => body.items, ...extra};
}

test('纯规则：到期判断、退避时长与成功失败状态', () => {
  const {scope} = setup();
  const scheduler = scope.XReplyChannelScheduler;
  assert.ok(scheduler.isDue(undefined, NOW));
  assert.ok(!scheduler.isDue({nextRunAt: NOW + 1}, NOW));
  assert.deepEqual([1, 2, 3, 9].map(scheduler.backoffMinutes), [15, 30, 60, 60]);
  const def = definition('a', {items: []});
  const failed = scheduler.stateAfterFailure(def, undefined, NOW, new Error('HTTP 503'));
  assert.equal(failed.failures, 1);
  assert.equal(failed.nextRunAt, NOW + 30 * MINUTE, '退避不短于渠道周期');
  const failedThree = scheduler.stateAfterFailure(def, {...failed, failures: 2}, NOW, 'x');
  assert.equal(failedThree.nextRunAt, NOW + 60 * MINUTE);
  const ok = scheduler.stateAfterSuccess(def, failedThree, NOW, {fetched: 3, inserted: 2, rejected: 1});
  assert.equal(ok.failures, 0);
  assert.equal(ok.error, '');
  assert.equal(ok.lastErrorAt, NOW, '保留最近一次失败时间供界面展示');
});

test('并发池限制同时运行的任务数，单个失败不影响其他任务', async () => {
  const {scope} = setup();
  let active = 0, peak = 0;
  const task = n => async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 5)); active--; return n; };
  const results = await scope.XReplyChannelScheduler.runPool([1, 2, 3, 4, 5].map(task), 2);
  assert.deepEqual([...results], [1, 2, 3, 4, 5]);
  assert.equal(peak, 2);
});

test('调度：按开关、到期和权限筛选，归一化后入库，截断到 maxItems', async () => {
  const {scope, db, make, advance, chrome} = setup({granted: origin => !origin.includes('locked')});
  const registry = scope.XReplyChannels;
  registry.register(definition('alpha', {items: [item(1), item(2), {id: 'bad', kind: 'article', url: 'http://insecure'}, item(3), item(4)]}));
  registry.register(definition('broken', () => { throw new Error('HTTP 503'); }));
  registry.register(definition('locked', {items: [item(9)]}));
  registry.register(definition('off', {items: [item(8)]}));
  assert.throws(() => registry.register({...registry.get('alpha')}), /重复/);
  assert.throws(() => registry.register({id: 'x'}), /缺少/);
  assert.throws(() => registry.register({...definition('y', {}), format: 'xml'}), /format/);

  const scheduler = make();
  await scheduler.saveSettings('off', {enabled: false});
  const first = await scheduler.run();
  const byId = Object.fromEntries([...first.results, ...first.skipped].map(row => [row.channelId, row]));
  assert.equal(byId.alpha.fetched, 2, '第 3 条无效被拒，maxItems 截断第 4 条之后');
  assert.equal(byId.alpha.rejected, 1);
  assert.equal(byId.broken.ok, false);
  assert.equal(byId.locked.skipped, 'permission');
  assert.equal(byId.off.skipped, 'disabled');
  assert.equal(db.materials[0].category, 'tech');
  assert.deepEqual([...db.materials[0].channelIds], ['alpha']);
  assert.equal(db.states.broken.failures, 1);
  assert.equal(db.pruned, 1);

  const second = await scheduler.run();
  assert.equal(second.results.length, 0, '未到期不运行');
  assert.equal(db.pruned, 1, '6 小时内不重复清理');
  advance(31);
  const third = await scheduler.run();
  assert.deepEqual([...third.results.map(row => row.channelId)].sort(), ['alpha', 'broken']);
  assert.equal(db.states.broken.failures, 2);
  const forced = await scheduler.run({force: true, channelIds: ['alpha']});
  assert.deepEqual([...forced.results.map(row => row.channelId)], ['alpha']);

  const status = await scheduler.status();
  const alpha = status.channels.find(row => row.id === 'alpha');
  assert.equal(alpha.enabled, true);
  assert.equal(alpha.state.inserted, 2);
  assert.equal(status.channels.find(row => row.id === 'locked').permitted, false);
  await assert.rejects(scheduler.saveSettings('nope', {}), /未知渠道/);
});

test('没有渠道可运行时仍按周期清理素材库', async () => {
  const {scope, db, make, advance} = setup({granted: () => false});
  scope.XReplyChannels.register(definition('noperm', {items: [item(1)]}));
  const scheduler = make();
  const first = await scheduler.run();
  assert.equal(first.results.length, 0);
  assert.equal(db.pruned, 1);
  await scheduler.run();
  assert.equal(db.pruned, 1, '6 小时内不重复清理');
  advance(6 * 60 + 1);
  await scheduler.run();
  assert.equal(db.pruned, 2);
});

test('调度锁：已有一轮在运行时直接返回 busy', async () => {
  const {scope, make} = setup();
  scope.XReplyChannels.register(definition('slow', {items: [item(1)]}));
  let held = false;
  const locks = {request: async (name, options, fn) => held ? fn(null) : (held = true, fn({name}).finally(() => { held = false; }))};
  const scheduler = make({locks});
  const [a, b] = await Promise.all([scheduler.run({force: true}), scheduler.run({force: true})]);
  assert.equal(a.results.length, 1);
  assert.equal(b.busy, true);
});

test('受限 HTTP：只访问白名单主机，不带凭证，限制大小，本机允许 HTTP', async () => {
  let options;
  const {scope} = setup({fetchImpl: async (url, args) => { options = args; return new Response('x'.repeat(2048)); }});
  const http = scope.XReplyChannelHttp;
  assert.equal(http.allowedUrl('http://127.0.0.1:8765/feed.json', ['127.0.0.1'])?.port, '8765');
  assert.equal(http.allowedUrl('http://evil.example/a', ['evil.example']), null);
  assert.equal(http.allowedUrl('https://u:p@a.example/', ['a.example']), null);
  await assert.rejects(http.fetchText('https://b.example/', {hosts: ['a.example']}), /不在渠道允许的范围/);
  await assert.rejects(http.fetchText('https://a.example/', {hosts: ['a.example'], maxBytes: 1024}), /超过/);
  assert.equal(options.credentials, 'omit');
  const {scope: failing} = setup({fetchImpl: async () => new Response('', {status: 503})});
  await assert.rejects(failing.XReplyChannelHttp.fetchText('https://a.example/', {hosts: ['a.example']}), /HTTP 503/);
});
