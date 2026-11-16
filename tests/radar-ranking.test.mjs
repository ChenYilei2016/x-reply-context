import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const scope = vm.createContext({URL});
for (const file of ['material-model.js', 'topic-cluster.js', 'radar-ranking.js']) {
  vm.runInContext(await readFile(new URL(`../extension/creation/${file}`, import.meta.url), 'utf8'), scope);
}
const {XReplyMaterialModel: model, XReplyTopicCluster: {cluster}, XReplyRadarRanking: {RadarSort, rank, compositeScore}} = scope;
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

test('综合分各项有上限，旧话题不加新鲜度', () => {
  const base = {sourceCount: 1, maxVelocity: null, bestRank: null, maxBreakout: null, latestAt: NOW - 48 * HOUR};
  assert.equal(compositeScore(base, NOW), 0);
  assert.equal(compositeScore({...base, maxBreakout: 1e9}, NOW), 2);
  assert.equal(compositeScore({...base, bestRank: 1}, NOW), 2.5);
  assert.equal(compositeScore({...base, bestRank: 1000}, NOW), 0);
  assert.equal(compositeScore({...base, latestAt: NOW - HOUR}, NOW), 1);
  assert.equal(compositeScore({...base, sourceCount: 3}, NOW), 3);
});
