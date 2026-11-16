import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const scope = vm.createContext({URL});
for (const file of ['material-model.js', 'topic-cluster.js', 'radar-ranking.js']) {
  vm.runInContext(await readFile(new URL(`../extension/creation/${file}`, import.meta.url), 'utf8'), scope);
}
const {XReplyMaterialModel: model, XReplyTopicCluster: {cluster}, XReplyRadarRanking: {RadarSort, rank, compositeScore, channelPercentiles}} = scope;
const HOUR = 3600_000;
const NOW = Date.parse('2026-11-16T12:00:00Z');
const normalize = (raw, channelId, extra = {}) => model.normalize(raw, {channelId, now: NOW, ...extra}).material;

const hot = normalize({id: 'baidu:黄仁勋辞任英伟达CEO', kind: 'hot_topic', url: 'https://www.baidu.com/s?wd=a', title: '黄仁勋辞任英伟达CEO', metrics: {rank: 2}}, 'baidu-hot');
const article = normalize({id: 'https://a.example/1', kind: 'article', url: 'https://a.example/1', title: '英伟达宣布黄仁勋辞任CEO', publishedAt: NOW - 3 * HOUR}, 'ithome');
const viral = normalize({id: 'x:1', kind: 'x_post', url: 'https://x.com/a/status/1', text: '黄仁勋辞任英伟达CEO了？太突然',
  publishedAt: NOW - 2 * HOUR, author: {handle: 'a', followers: 2000}, metrics: {views: 200000}}, 'x-observed', {metricsSource: model.MetricsSource.X_OBSERVED});
const quiet = normalize({id: 'x:2', kind: 'x_post', url: 'https://x.com/b/status/2', text: '今天写了一个开源小工具，欢迎试用',
  publishedAt: NOW - 30 * HOUR, author: {handle: 'b', followers: 5000}, metrics: {views: 800}}, 'x-observed');
const fresh = normalize({id: 'https://b.example/2', kind: 'article', url: 'https://b.example/2', title: '某手机品牌发布秋季新品',
  publishedAt: NOW - HOUR}, 'ithome');

test('话题摘要：跨渠道来源、X 指标、热榜名次、成员按流速排序', () => {
  const topics = rank([quiet, article, viral, hot, fresh], {now: NOW, model, cluster});
  const nvidia = topics.find(topic => topic.members.length === 3);
  assert.equal(nvidia.title, '黄仁勋辞任英伟达CEO');
  assert.equal(nvidia.sourceCount, 3);
  assert.equal(nvidia.xPostCount, 1);
  assert.equal(nvidia.maxViews, 200000);
  assert.equal(nvidia.maxVelocity, 100000);
  assert.equal(nvidia.maxBreakout, 100);
  assert.equal(nvidia.bestRank, 2);
  assert.equal(nvidia.members[0].id, 'x:1', '有流速的成员排前面');
  assert.equal(topics[0].id, nvidia.id, '综合排序第一');
  assert.equal(nvidia.category, 'tech');
});

test('排序方式：缺少指标的排在后面，最新按时间', () => {
  const topics = rank([quiet, article, viral, hot, fresh], {now: NOW, model, cluster});
  const byLatest = [...topics].sort((a, b) => RadarSort.LATEST.compare(a, b));
  assert.equal(byLatest.at(-1).leader.id, 'x:2', '30 小时前的话题最后；热榜没有发布时间时按首次采集时间算');
  const byBreakout = [...topics].sort((a, b) => RadarSort.BREAKOUT.compare(a, b));
  assert.equal(byBreakout.at(-1).maxBreakout, null);
  assert.equal(RadarSort.from('nope'), RadarSort.COMPOSITE);
  assert.equal(RadarSort.from('velocity').label, '流速');
});

test('综合分：渠道内百分位、跨渠道印证、爆文倍数有上限，按账号定位加权', () => {
  const base = {category: 'ai', sourceCount: 1, channelTop: 0, maxBreakout: null, latestAt: NOW - 48 * HOUR};
  assert.equal(compositeScore(base, NOW), 0);
  assert.equal(compositeScore({...base, maxBreakout: 1e9}, NOW), 2);
  assert.equal(compositeScore({...base, channelTop: 1}, NOW), 3);
  assert.equal(compositeScore({...base, latestAt: NOW - HOUR}, NOW), 1);
  assert.equal(compositeScore({...base, sourceCount: 3}, NOW), 3);
  assert.ok(Math.abs(compositeScore({...base, channelTop: 1, category: 'entertainment'}, NOW) - 1.8) < 1e-9, '娱乐按 0.6 加权');
});

test('渠道内百分位：不同渠道各自排序，单位不可比的指标不跨渠道比较', () => {
  const bili = [5e6, 1e5].map((views, index) => normalize({id: `bilibili:${index}`, kind: 'hot_topic', url: `https://www.bilibili.com/video/${index}`,
    title: `视频${index}`, category: 'entertainment', publishedAt: NOW - HOUR, metrics: {views}}, 'bilibili-popular'));
  const news = [1, 5].map(hours => normalize({id: `https://openai.com/${hours}`, kind: 'article', url: `https://openai.com/${hours}`,
    title: `公告${hours}`, category: 'ai', publishedAt: NOW - hours * HOUR}, 'openai-news'));
  const percentiles = channelPercentiles([...bili, ...news], NOW, model);
  assert.equal(percentiles.get('bilibili:0'), 1);
  assert.equal(percentiles.get('bilibili:1'), 0.5);
  assert.equal(percentiles.get('https://openai.com/1'), 1, '没有指标的渠道按新鲜度排，最新的也是本渠道第一');
  const topics = rank([...bili, ...news], {now: NOW, model, cluster});
  assert.equal(topics[0].leader.id, 'https://openai.com/1', 'AI 渠道第一名在定位加权后排在娱乐第一名之前');
});
