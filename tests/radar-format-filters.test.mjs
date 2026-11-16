import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const scope = vm.createContext({});
for (const file of ['format.js', 'radar-filters.js']) vm.runInContext(await readFile(new URL(`../extension/creation/${file}`, import.meta.url), 'utf8'), scope);
const {XReplyFormat: format, XReplyRadarFilters: {RadarView, matchesTopic, countByCategory}} = scope;

test('中文数字、流速、倍数与相对时间', () => {
  assert.deepEqual([9999, 12345, 123456, 1234567, 340000000, null].map(format.count), ['9999', '1.2万', '12.3万', '123万', '3.4亿', '—']);
  assert.equal(format.velocity(12345), '1.2万/h');
  assert.equal(format.velocity(null), '—');
  assert.deepEqual([0.04, 8.25, 150.6].map(format.ratio), ['0x', '8.3x', '151x']);
  const now = Date.parse('2026-11-16T12:00:00Z');
  assert.deepEqual([now - 10_000, now - 5 * 60_000, now - 3 * 3600_000, now - 50 * 3600_000, 0].map(t => format.ago(t, now)),
    ['刚刚', '5 分钟前', '3 小时前', '2 天前', '时间未知']);
});

const topic = (extra = {}) => ({category: 'ai', saved: false, members: [{kind: 'x_post', title: '', text: 'OpenAI 新模型', author: {handle: 'Alice'}}], ...extra});

test('筛选：视图、分类、类型、关键词（含作者）', () => {
  assert.ok(matchesTopic(topic(), {}));
  assert.ok(!matchesTopic(topic(), {view: RadarView.SAVED}));
  assert.ok(matchesTopic(topic({saved: true}), {view: RadarView.SAVED}));
  assert.ok(!matchesTopic(topic(), {category: 'tech'}));
  assert.ok(!matchesTopic(topic(), {kind: 'article'}));
  assert.ok(matchesTopic(topic(), {query: 'openai'}));
  assert.ok(matchesTopic(topic(), {query: 'alice'}));
  assert.ok(!matchesTopic(topic(), {query: 'netflix'}));
  assert.ok(RadarView.HIDDEN.includesMaterial({marks: {hidden: true}}));
  assert.ok(!RadarView.ALL.includesMaterial({marks: {hidden: true}}));
  assert.equal(RadarView.from('x'), RadarView.ALL);
  assert.deepEqual({...countByCategory([topic(), topic(), topic({category: 'hot'})])}, {all: 3, ai: 2, hot: 1});
});
