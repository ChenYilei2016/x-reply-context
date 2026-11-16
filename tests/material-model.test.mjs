import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source = await readFile(new URL('../extension/creation/material-model.js', import.meta.url), 'utf8');
const scope = vm.createContext({URL});
vm.runInContext(source, scope);
const model = scope.XReplyMaterialModel;
const {MaterialKind, Coverage, MetricsSource, MaterialCategory} = model;

const HOUR = 3600_000;
const NOW = Date.parse('2026-11-16T12:00:00Z');
const context = (extra = {}) => ({channelId: 'bot-feed', now: NOW, ...extra});
const xPost = (extra = {}) => ({
  id: 'x:1', kind: 'x_post', url: 'https://x.com/someone/status/1', text: '一条帖子',
  publishedAt: '2026-11-16T10:00:00Z', author: {handle: '@someone', name: '某人', followers: 1000},
  metrics: {views: 20000, likes: 300, observedAt: '2026-11-16T11:58:00Z'}, ...extra
});
const normalized = (raw, extra) => {
  const result = model.normalize(raw, context(extra));
  assert.equal(result.error, undefined, result.error);
  return result.material;
};

test('枚举按 id 查找并封装各自规则', () => {
  assert.equal(MaterialKind.from('x_post'), MaterialKind.X_POST);
  assert.equal(MaterialKind.from('nope'), undefined);
  assert.ok(Coverage.FULL.richerThan(Coverage.EXCERPT));
  assert.equal(Coverage.infer(''), Coverage.TITLE);
  assert.equal(Coverage.infer('字'.repeat(400)), Coverage.FULL);
  assert.ok(MetricsSource.X_OBSERVED.replaces(MetricsSource.CHANNEL_REPORTED));
  assert.ok(!MetricsSource.RANK_ONLY.replaces(MetricsSource.CHANNEL_REPORTED));
  assert.equal(MaterialCategory.fromTags(['未知', '娱乐', 'AI']), MaterialCategory.ENTERTAINMENT);
  assert.equal(MaterialCategory.classify('OpenAI 发布新模型'), MaterialCategory.AI);
  assert.equal(MaterialCategory.classify('华为发布新手机'), MaterialCategory.TECH);
  assert.equal(MaterialCategory.classify('今天天气不错', MaterialCategory.HOT), MaterialCategory.HOT);
  assert.equal(MaterialCategory.classify('FAIR 规则'), MaterialCategory.OTHER, '单词内部的 AI 不应误判');
});

test('归一化 feed 条目：清理链接与字段，生成首个快照', () => {
  const material = normalized(xPost({url: 'https://x.com/someone/status/1?utm_source=a#top', tags: ['AI', 'AI', '']}));
  assert.equal(material.url, 'https://x.com/someone/status/1');
  assert.equal(material.author.handle, 'someone');
  assert.equal(material.category, 'ai');
  assert.deepEqual([...material.tags], ['AI']);
  assert.equal(material.metricsSource, 'channel_reported');
  assert.equal(material.metricsAt, Date.parse('2026-11-16T11:58:00Z'));
  assert.equal(material.snapshots.length, 1);
  assert.equal(material.coverage, 'excerpt');
  assert.deepEqual([...material.channelIds], ['bot-feed']);
});

test('归一化拒绝无效条目，丢弃非法指标', () => {
  for (const [raw, pattern] of [
    [{...xPost(), id: ''}, /id/],
    [{...xPost(), kind: 'video'}, /未知类型/],
    [{...xPost(), url: 'http://x.com/a'}, /HTTPS/],
    [{...xPost(), url: 'javascript:alert(1)'}, /HTTPS/],
    [{...xPost(), text: '', title: ''}, /为空/],
    [null, /不是对象/]
  ]) assert.match(model.normalize(raw, context()).error, pattern);
  const material = normalized(xPost({metrics: {views: -1, likes: 1.5, rank: 3}}));
  assert.deepEqual({...material.metrics}, {rank: 3});
  assert.equal(material.metricsSource, 'rank_only');
  assert.equal(material.snapshots.length, 0);
  assert.equal(normalized(xPost({metrics: undefined})).metricsSource, 'none');
  assert.equal(normalized(xPost({text: '长'.repeat(20000)})).text.length, model.LIMITS.text);
});

test('合并：保留更完整正文、更可信指标和用户标记，渠道取并集', () => {
  const old = {...normalized(xPost({coverage: 'full', text: '完整正文'}), {metricsSource: MetricsSource.X_OBSERVED}), marks: {saved: true}};
  const later = normalized(xPost({text: '摘要', metrics: {views: 30000, observedAt: '2026-11-16T13:00:00Z'}}),
    {channelId: 'other', now: NOW + HOUR});
  const merged = model.merge(old, later);
  assert.equal(merged.text, '完整正文');
  assert.equal(merged.metricsSource, 'x_observed', '低可信度渠道不覆盖 X 实测');
  assert.equal(merged.metrics.views, 20000);
  assert.equal(merged.marks.saved, true);
  assert.deepEqual([...merged.channelIds], ['bot-feed', 'other']);
  assert.equal(merged.firstSeenAt, NOW);
  assert.equal(merged.lastSeenAt, NOW + HOUR);
  assert.equal(merged.snapshots.length, 2, '不同来源的快照分别保留');

  const upgraded = model.merge(later, old);
  assert.equal(upgraded.metricsSource, 'x_observed', 'X 实测覆盖渠道报告');
  assert.equal(model.merge(undefined, later), later);
});

test('快照间隔不足 30 分钟时替换，超过时追加，最多保留 8 个', () => {
  const at = minutes => ({...xPost(), metrics: {views: 1000 + minutes * 10, observedAt: new Date(NOW + minutes * 60_000).toISOString()}});
  const observed = minutes => normalized(at(minutes), {metricsSource: MetricsSource.X_OBSERVED, now: NOW + minutes * 60_000});
  let material = observed(0);
  material = model.merge(material, observed(10));
  assert.equal(material.snapshots.length, 1);
  assert.equal(material.snapshots[0].views, 1100);
  for (let minute = 40; minute <= 400; minute += 40) material = model.merge(material, observed(minute));
  assert.equal(material.snapshots.length, model.LIMITS.snapshots);
  assert.equal(material.snapshots.at(-1).views, 5000);
});

test('派生指标：流速、爆文倍数、加速度只在数据足够时给出', () => {
  const material = normalized(xPost());
  assert.equal(model.velocity(material, NOW), 10000);
  assert.equal(model.breakoutRatio(material), 20);
  assert.equal(model.acceleration(material), null);
  assert.equal(model.velocity({...material, publishedAt: NOW}, NOW), 80000, '刚发布按 15 分钟计算');
  assert.equal(model.velocity({...material, publishedAt: null}, NOW), null);
  assert.equal(model.breakoutRatio({...material, author: {handle: 'a', followers: 0}}), null);
  const later = normalized(xPost({metrics: {views: 26000, observedAt: '2026-11-16T12:58:00Z'}}), {now: NOW + HOUR});
  assert.equal(model.acceleration(model.merge(material, later)), 6000);
});

test('保留策略：收藏不过期，自己的帖子保留更久，低浏览帖子先清理', () => {
  const material = normalized(xPost({metrics: {views: 500}}));
  const days = n => NOW + n * 24 * HOUR;
  assert.equal(model.isExpired(material, days(1)), false);
  assert.equal(model.isExpired(material, days(3)), true, '低浏览 X 帖子 48 小时后清理');
  assert.equal(model.isExpired({...material, metrics: {views: 5000}}, days(3)), false);
  assert.equal(model.isExpired({...material, metrics: {views: 5000}}, days(8)), true);
  assert.equal(model.isExpired({...material, marks: {saved: true}}, days(100)), false);
  assert.equal(model.isExpired({...material, own: true}, days(30)), false);
  assert.equal(model.isExpired({...material, own: true}, days(91)), true);
  const article = normalized({id: 'https://a.example/1', kind: 'article', url: 'https://a.example/1', title: '新闻'});
  assert.equal(model.isExpired(article, days(3)), false, '非 X 帖子不按浏览量清理');
});
