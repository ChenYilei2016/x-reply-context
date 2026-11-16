import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const read = path => readFile(new URL(`../extension/${path}`, import.meta.url), 'utf8');
const [coreSource, captureSource, observeSource] = await Promise.all(['core.js', 'creation/x-capture.js', 'observe.js'].map(read));
const backgroundSources = await Promise.all(['creation/material-model.js', 'creation/channel-http.js', 'creation/channel-registry.js',
  'creation/channel-scheduler.js', 'creation/creation-background.js'].map(read));
const tick = () => new Promise(resolve => setImmediate(resolve));
const NOW = Date.parse('2026-11-16T12:00:00Z');

/** 按 X GraphQL（HomeTimeline）的结构构造帖子节点。 */
function tweetResult(id, {handle = 'alice', followers = 1200, views = '34567', viewState = 'EnabledWithCount', reply = false,
  text = `AI 新闻 ${id} https://t.co/abc123`, relationshipCounts = false} = {}) {
  const user = {__typename: 'User', rest_id: `9${id}`, core: {screen_name: handle, name: 'Alice'},
    legacy: relationshipCounts ? {} : {followers_count: followers}};
  if (relationshipCounts) user.relationship_counts = {followers};
  return {
    __typename: 'Tweet', rest_id: id,
    core: {user_results: {result: user}},
    views: {count: views, state: viewState},
    legacy: {
      id_str: id, full_text: text, created_at: 'Mon Nov 16 10:00:00 +0000 2026', conversation_id_str: id, user_id_str: `9${id}`,
      favorite_count: 120, retweet_count: 30, reply_count: 12, quote_count: 3, bookmark_count: 40, lang: 'zh',
      ...(reply ? {in_reply_to_status_id_str: '1', in_reply_to_user_id_str: '9'} : {}),
      extended_entities: {media: [{type: 'photo', media_url_https: 'https://pbs.twimg.com/media/a.jpg'}, {type: 'unknown', media_url_https: 'x'}]}
    }
  };
}
const timeline = results => ({data: {home: {home_timeline_urt: {instructions: [{type: 'TimelineAddEntries',
  entries: results.map((result, index) => ({entryId: `tweet-${index}`, content: {itemContent: {tweet_results: {result}}}}))}]}}}});

function loadCapture() {
  const scope = vm.createContext({});
  vm.runInContext(captureSource, scope);
  return scope.XReplyXCapture;
}

test('帖子节点转换：正文去短链，带作者粉丝、浏览与互动、媒体', () => {
  const capture = loadCapture();
  const node = tweetResult('1001');
  const post = capture.postFromNode({id: '1001', text: node.legacy.full_text}, node, NOW);
  assert.equal(post.id, 'x:1001');
  assert.equal(post.url, 'https://x.com/alice/status/1001');
  assert.equal(post.text, 'AI 新闻 1001');
  assert.equal(post.publishedAt, '2026-11-16T10:00:00.000Z');
  assert.deepEqual({...post.author}, {handle: 'alice', name: 'Alice', followers: 1200});
  assert.equal(post.metrics.views, 34567);
  assert.equal(post.metrics.bookmarks, 40);
  assert.deepEqual(post.media.map(item => item.type), ['image']);

  const hidden = tweetResult('1002', {viewState: 'Enabled', relationshipCounts: true, followers: 88});
  const hiddenPost = capture.postFromNode({id: '1002', text: 'x'}, hidden, NOW);
  assert.equal(hiddenPost.metrics.views, undefined, '未公开浏览量时不填');
  assert.equal(hiddenPost.author.followers, 88, '新结构的粉丝数');
  assert.equal(capture.postFromNode({id: '1003', text: 'x', parentId: '1'}, tweetResult('1003', {reply: true}), NOW), null, '回复不采集');
  assert.equal(capture.postFromNode({id: '1004', text: 'x'}, {legacy: {}}, NOW), null, '缺作者或时间不采集');
});

test('收集器合批：同一帖子只保留最新，未就绪时保留到下次', () => {
  const capture = loadCapture();
  const timers = [];
  let ready = false;
  const sent = [];
  const collector = capture.createCollector({send: posts => ready && (sent.push(posts), true), clock: () => NOW,
    schedule: fn => timers.push(fn)});
  const node = tweetResult('2001');
  collector.add({id: '2001', text: 'a'}, node);
  collector.add({id: '2001', text: 'b'}, node);
  collector.add({id: '2002', text: 'c'}, tweetResult('2002'));
  assert.equal(timers.length, 1, '只安排一次发送');
  timers.shift()();
  assert.equal(sent.length, 0);
  assert.equal(collector.size(), 2);
  ready = true;
  timers.shift()();
  assert.equal(sent.length, 1);
  assert.deepEqual([...sent[0].map(post => post.text)], ['b', 'c']);
  assert.equal(collector.size(), 0);
});

test('页面观察器：时间线响应经采集器发出 CREATION_X_POSTS，回复和点赞回执不采集', async () => {
  const core = vm.createContext({});
  vm.runInContext(coreSource, core);
  const messages = [], listeners = [], timers = new Map();
  let timerId = 0;
  let payload = timeline([tweetResult('3001'), {__typename: 'TweetWithVisibilityResults', tweet: tweetResult('3002', {handle: 'me'})},
    tweetResult('3003', {reply: true})]);
  const window = {postMessage: message => messages.push(message), addEventListener: (_name, fn) => listeners.push(fn),
    fetch: async () => new Response(JSON.stringify(payload), {headers: {'content-type': 'application/json'}})};
  const context = vm.createContext({XReplyContext: core.XReplyContext, window, location: {origin: 'https://x.com', href: 'https://x.com/home'},
    URL, Request, TextDecoder, XMLHttpRequest: class {}, document: {querySelector: () => ({getAttribute: () => '/me'})},
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id)});
  vm.runInContext(captureSource, context);
  vm.runInContext(observeSource, context);
  listeners.forEach(fn => fn({source: window, origin: 'https://x.com', data: {channel: 'x-reply-context-v1', type: 'READY'}}));
  await window.fetch('/i/api/graphql/hash/HomeTimeline');
  for (let i = 0; i < 40; i++) await tick();
  for (const fn of [...timers.values()]) fn();
  const creation = messages.filter(message => message.type === 'CREATION_X_POSTS');
  assert.equal(creation.length, 1);
  assert.equal(creation[0].account, 'me');
  assert.deepEqual([...creation[0].posts.map(post => post.id)].sort(), ['x:3001', 'x:3002']);
  assert.ok(messages.some(message => message.type === 'OBSERVED'), '原有互动记录照常发送');

  messages.length = 0;
  payload = {data: {favorite_tweet: 'Done'}};
  await window.fetch('/i/api/graphql/hash/FavoriteTweet', {method: 'POST', body: JSON.stringify({variables: {tweet_id: '3001'}})});
  for (let i = 0; i < 40; i++) await tick();
  for (const fn of [...timers.values()]) fn();
  assert.equal(messages.filter(message => message.type === 'CREATION_X_POSTS').length, 0);
});

test('后台入库：只接受 X 顶层页面，遵守采集开关，识别自己的帖子', async () => {
  const stored = {}, upserts = [], states = {};
  const chrome = {
    runtime: {getURL: path => `chrome-extension://test/${path}`},
    storage: {local: {get: async key => ({[key]: stored[key]}), set: async values => Object.assign(stored, values)},
      session: {get: async () => ({}), set: async () => {}}},
    permissions: {contains: async () => true}, alarms: {get: async () => null, create: async () => {}}
  };
  const db = {
    async upsertMany(items) { upserts.push(...items); return {inserted: items.length, updated: 0}; },
    async channelStates() { return structuredClone(states); },
    async saveChannelState(state) { states[state.channelId] = state; },
    async count() { return upserts.length; }
  };
  const scope = vm.createContext({URL, XReplyMaterialDB: {create: () => db}});
  backgroundSources.forEach(source => vm.runInContext(source, scope));
  const service = scope.XReplyCreationBackground.create(chrome);
  const capture = loadCapture();
  const posts = ['4001', '4002'].map((id, index) => capture.postFromNode({id, text: '内容'}, tweetResult(id, {handle: index ? 'Me' : 'alice'}), NOW));
  const xSender = {frameId: 0, url: 'https://x.com/home'};

  assert.equal((await service.handle({type: 'CREATION_INGEST_X', account: 'me', posts}, {frameId: 1, url: 'https://x.com/home'})).ok, false);
  assert.equal((await service.handle({type: 'CREATION_INGEST_X', account: 'me', posts}, {frameId: 0, url: 'https://evil.example/'})).ok, false);
  const result = await service.handle({type: 'CREATION_INGEST_X', account: 'me', posts: [...posts, {id: 'bad'}]}, xSender);
  assert.equal(result.stored, 2);
  assert.equal(upserts.find(item => item.id === 'x:4001').own, false);
  assert.equal(upserts.find(item => item.id === 'x:4002').own, true, '账号名不区分大小写');
  assert.equal(upserts[0].metricsSource, 'x_observed');
  assert.deepEqual([...upserts[0].channelIds], ['x-observed']);
  assert.equal(states['x-observed'].totalInserted, 2);

  const page = {url: 'chrome-extension://test/creation/channels.html'};
  assert.equal((await service.handle({type: 'CREATION_X_CAPTURE_SETTINGS', enabled: false}, xSender)).ok, false, 'X 页面不能改设置');
  await service.handle({type: 'CREATION_X_CAPTURE_SETTINGS', enabled: false}, page);
  const disabled = await service.handle({type: 'CREATION_INGEST_X', account: 'me', posts}, xSender);
  assert.equal(disabled.disabled, true);
  assert.equal(upserts.length, 2);
  const status = await service.handle({type: 'CREATION_CHANNELS_STATUS'}, page);
  assert.equal(status.xCapture.enabled, false);
  assert.equal(status.xCapture.state.fetched, 2);
});

test('收集器即时展示数据：只含有浏览量的帖子，取出后清空', () => {
  const capture = loadCapture();
  const collector = capture.createCollector({send: () => true, clock: () => NOW, schedule: () => 0});
  collector.add({id: '5001', text: 'a'}, tweetResult('5001'));
  collector.add({id: '5002', text: 'b'}, tweetResult('5002', {viewState: 'Enabled'}));
  const display = collector.takeDisplay();
  assert.deepEqual(JSON.parse(JSON.stringify(display)), [{id: 'x:5001', views: 34567, publishedAt: '2026-11-16T10:00:00.000Z', followers: 1200}]);
  assert.equal(collector.takeDisplay().length, 0);
});

test('流速标签收藏：已入库直接标记，未入库暂存到下次入库补上', async () => {
  const marks = {}, materials = new Set(), session = {};
  const chrome = {
    runtime: {getURL: path => `chrome-extension://test/${path}`},
    storage: {local: {get: async () => ({})}, session: {get: async key => ({[key]: session[key]}), set: async values => Object.assign(session, values)}},
    permissions: {contains: async () => true}, alarms: {get: async () => null, create: async () => {}}
  };
  const db = {
    async upsertMany(items) { items.forEach(item => materials.add(item.id)); return {inserted: items.length, updated: 0}; },
    async setMark(id, mark, value) { if (!materials.has(id)) return undefined; marks[id] = {[mark]: value}; return {id}; },
    async channelStates() { return {}; }, async saveChannelState() {}
  };
  const scope = vm.createContext({URL, XReplyMaterialDB: {create: () => db}});
  backgroundSources.forEach(source => vm.runInContext(source, scope));
  const service = scope.XReplyCreationBackground.create(chrome);
  const xSender = {frameId: 0, url: 'https://x.com/home'};
  assert.equal((await service.handle({type: 'CREATION_SAVE_X_POST', postId: '6001'}, {url: 'chrome-extension://test/creation/radar.html'})).ok, false);
  assert.equal((await service.handle({type: 'CREATION_SAVE_X_POST', postId: 'abc'}, xSender).catch(error => ({error: error.message}))).error, '帖子编号无效');
  const pending = await service.handle({type: 'CREATION_SAVE_X_POST', postId: '6001'}, xSender);
  assert.equal(pending.pending, true);
  assert.deepEqual([...session.creationPendingSaves], ['x:6001']);
  const capture = loadCapture();
  await service.handle({type: 'CREATION_INGEST_X', account: 'me', posts: [capture.postFromNode({id: '6001', text: 'x'}, tweetResult('6001'), NOW)]}, xSender);
  assert.equal(marks['x:6001'].saved, true, '入库后补上收藏');
  assert.equal(session.creationPendingSaves.length, 0);
  const direct = await service.handle({type: 'CREATION_SAVE_X_POST', postId: '6001'}, xSender);
  assert.equal(direct.saved, true);
});
