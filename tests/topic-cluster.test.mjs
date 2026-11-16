import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const scope = vm.createContext({});
vm.runInContext(await readFile(new URL('../extension/creation/topic-cluster.js', import.meta.url), 'utf8'), scope);
const {cluster, tokenize} = scope.XReplyTopicCluster;
const HOUR = 3600_000;
const NOW = Date.parse('2026-11-16T12:00:00Z');
let sequence = 0;
const material = (kind, text, {hoursAgo = 1, title} = {}) => ({
  id: `m${++sequence}`, kind, title: title ?? (kind === 'x_post' ? '' : text), text: kind === 'x_post' ? text : '',
  publishedAt: NOW - hoursAgo * HOUR, firstSeenAt: NOW
});
const groups = topics => [...topics].map(topic => [...topic.members.map(member => member.id)].sort().join(',')).sort();

test('切词：中文双字去泛词，英文保留型号，去掉链接和话题符号', () => {
  const tokens = [...tokenize('OpenAI发布GPT-5.2模型 https://t.co/abc #大模型 the new')];
  assert.ok(tokens.includes('openai'));
  assert.ok(tokens.includes('gpt-5.2'));
  assert.ok(tokens.includes('模型'));
  assert.ok(tokens.includes('大模'));
  assert.ok(!tokens.includes('发布'), '泛词不参与');
  assert.ok(!tokens.some(token => token.includes('t.co')), '链接去掉');
  assert.ok(!tokens.includes('the') && !tokens.includes('new'));
  assert.deepEqual([...tokenize('第 3 名 2026 年')], ['2026'], '1～3 位纯数字不参与');
});

test('同一事件跨热榜、新闻、X 帖子合并，无关事件分开', () => {
  const hot = material('hot_topic', '黄仁勋辞任英伟达CEO');
  const article = material('article', '英伟达宣布黄仁勋辞任CEO，董事会启动接班');
  const post = material('x_post', '黄仁勋辞任英伟达CEO了？这消息太突然', {hoursAgo: 2});
  const other = material('hot_topic', '苹果iPhone销量创新高');
  const otherPost = material('x_post', 'iPhone 销量又创新高，苹果这次赢麻了');
  const topics = cluster([post, other, hot, otherPost, article]);
  assert.deepEqual(groups(topics), [[article.id, hot.id, post.id].sort().join(','), [other.id, otherPost.id].sort().join(',')].sort());
  const nvidia = topics.find(topic => topic.members.length === 3);
  assert.equal(nvidia.leader.id, hot.id, '热榜条目优先作为锚点');
});

test('时间相差超过 48 小时不合并', () => {
  const recent = material('article', 'DeepSeek开源新一代推理模型R3');
  const old = material('article', 'DeepSeek开源新一代推理模型R3', {hoursAgo: 60});
  assert.equal(cluster([recent, old]).length, 2);
});

test('只与锚点比较，不发生链式误并；只共享一个词不合并', () => {
  const leader = material('article', 'OpenAI GPT-6 定价公布 Plus 会员');
  const bridge = material('article', 'GPT-6 Plus 会员 涨价引发讨论', {hoursAgo: 2});
  const far = material('article', 'Netflix 会员 涨价 引发讨论', {hoursAgo: 3});
  const topics = cluster([leader, bridge, far], {heat: item => item === leader ? 10 : 1});
  const leaderTopic = topics.find(topic => topic.leader.id === leader.id);
  assert.ok(!leaderTopic.members.some(member => member.id === far.id), '与锚点只共享泛词的素材不会经由中间条目并入');
  assert.equal(cluster([material('article', 'Claude 新功能'), material('article', 'Claude 价格')]).length, 2, '只共享 claude 不合并');
});

test('批量规模：2000 条在合理时间内完成', () => {
  const words = ['模型', '芯片', '手机', '游戏', '电影', '球赛', '汽车', '机器', '学习', '开源'];
  const items = Array.from({length: 2000}, (_, index) =>
    material(index % 3 ? 'x_post' : 'article', `${words[index % 10]}${words[(index * 7) % 10]}${words[(index * 3) % 10]} 事件${index}`, {hoursAgo: index % 40}));
  const started = performance.now();
  const topics = cluster(items);
  assert.ok(performance.now() - started < 2000, `耗时 ${performance.now() - started}ms`);
  assert.equal(topics.reduce((sum, topic) => sum + topic.members.length, 0), 2000, '每条素材恰好属于一个话题');
});
