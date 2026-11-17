import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const scope = vm.createContext({URL, crypto});
for (const file of ['draft-record.js', 'publish-link.js', 'review-model.js']) {
  vm.runInContext(await readFile(new URL(`../extension/creation/${file}`, import.meta.url), 'utf8'), scope);
}
const {XReplyDraftRecord: record, XReplyPublishLink: publish, XReplyReviewModel: review} = scope;
const {DraftStatus} = record;
const HOUR = 3600_000;
const NOW = Date.parse('2026-11-17T04:00:00Z');
const plain = value => JSON.parse(JSON.stringify(value));
const draft = (extra = {}) => ({...record.create({text: '黄仁勋辞任 CEO，但他没离开英伟达。', format: 'short_opinion',
  angle: {type: 'contrarian', hook: '不等于离开'}, materials: [{id: 'm', title: '新闻', url: 'https://a.example/1'}]}, NOW, extra.id || 'd:1'), ...extra});
const ownPost = (id, text, extra = {}) => ({id: `x:${id}`, kind: 'x_post', own: true, text, url: `https://x.com/me/status/${id}`,
  publishedAt: NOW + HOUR, firstSeenAt: NOW + 2 * HOUR, lastSeenAt: NOW + 2 * HOUR, metrics: {views: 1000}, snapshots: [], ...extra});

test('草稿状态：草稿与待确认可改正文、等待关联；已发不可改', () => {
  assert.equal(DraftStatus.from('draft').isEditable(), true);
  assert.equal(DraftStatus.PENDING.awaitsLink(), true);
  assert.equal(DraftStatus.PUBLISHED.isEditable(), false);
  assert.equal(DraftStatus.PUBLISHED.awaitsLink(), false);
  assert.deepEqual(plain(DraftStatus.values().map(status => status.label)), ['草稿', '待确认', '已发']);
});

test('状态流转：保存 → 打开发帖页 → 关联 → 撤销；已发后改正文报错', () => {
  const created = draft();
  assert.equal(created.status, 'draft');
  assert.equal(created.angle.type, 'contrarian');
  const edited = record.withText(created, '改过的正文', NOW + 1);
  assert.equal(edited.updatedAt, NOW + 1);
  const pending = record.markPending(edited, NOW + 2);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.publishOpenedAt, NOW + 2);
  const published = record.linkPost(pending, {id: '123', url: 'https://x.com/me/status/123', publishedAt: NOW + 3}, 'manual', NOW + 4);
  assert.equal(published.status, 'published');
  assert.equal(published.post.linkedBy, 'manual');
  assert.throws(() => record.withText(published, '再改'), /已发的草稿不能再改/);
  assert.throws(() => record.markPending(published), /已发/);
  const unlinked = record.unlinkPost(published, NOW + 5);
  assert.equal(unlinked.status, 'draft');
  assert.equal(unlinked.post, null);
  assert.throws(() => record.create({text: '  '}), /不能为空/);
  assert.throws(() => record.linkPost(created, {id: 'abc'}, 'manual'), /编号无效/);
});

test('帖子链接解析：x.com、twitter.com、mobile，带参数与子路径', () => {
  assert.deepEqual(plain(record.parsePostUrl('https://x.com/me/status/123?s=20')), {id: '123', url: 'https://x.com/me/status/123'});
  assert.deepEqual(plain(record.parsePostUrl(' https://mobile.twitter.com/Me_1/status/456/photo/1 ')), {id: '456', url: 'https://x.com/Me_1/status/456'});
  assert.equal(record.parsePostUrl('https://x.com/me'), null);
  assert.equal(record.parsePostUrl('https://evilx.com/me/status/1'), null);
  assert.equal(record.parsePostUrl('不是链接'), null);
});

test('手动录入数据：只收非负整数，全空时清除，未发不能录', () => {
  const published = record.linkPost(draft(), {id: '1', url: 'https://x.com/me/status/1'}, 'manual', NOW);
  const withMetrics = record.withManualMetrics(published, {views: 5000, likes: 30, reposts: undefined}, NOW);
  assert.deepEqual(plain(withMetrics.manualMetrics), {views: 5000, likes: 30, recordedAt: NOW});
  assert.equal(record.withManualMetrics(withMetrics, {}, NOW).manualMetrics, null);
  assert.throws(() => record.withManualMetrics(published, {views: -1}), /非负整数/);
  assert.throws(() => record.withManualMetrics(published, {views: 1.5}), /非负整数/);
  assert.throws(() => record.withManualMetrics(draft(), {views: 1}), /发布后/);
});

test('预填链接：正文编码进 intent；过长时退回空白发帖页', () => {
  const short = publish.intentUrl('你好 #AI\nhttps://x.com/a/status/1');
  assert.equal(short.prefilled, true);
  assert.equal(short.url, `https://x.com/intent/post?text=${encodeURIComponent('你好 #AI\nhttps://x.com/a/status/1')}`);
  const long = publish.intentUrl('中'.repeat(3000));
  assert.equal(long.prefilled, false);
  assert.equal(long.url, 'https://x.com/compose/post');
});

test('正文相似度：忽略链接、空白和标点；不同内容相似度低', () => {
  assert.equal(publish.similarity('黄仁勋辞任 CEO，但他没离开英伟达。', '黄仁勋辞任CEO 但他没离开英伟达 https://t.co/abc'), 1);
  assert.ok(publish.similarity('黄仁勋辞任 CEO，但他没离开英伟达。今天聊聊接班', '黄仁勋辞任 CEO，但他没有离开英伟达。今天聊聊接班') >= publish.MATCH_THRESHOLD);
  assert.ok(publish.similarity('黄仁勋辞任 CEO', '苹果发布新手机') < 0.2);
  assert.equal(publish.similarity('', 'a'), 0);
});

test('自动关联：只匹配自己的帖子、等待中的草稿和时间窗内的帖子，每条只配一次', () => {
  const waiting = draft({id: 'd:1', status: 'pending'});
  const other = draft({id: 'd:2', text: '完全不同的一条：苹果发布了新手机，续航提升明显。'});
  const done = record.linkPost(draft({id: 'd:3'}), {id: '900', url: 'https://x.com/me/status/900'}, 'feed', NOW);
  const posts = [
    ownPost('101', '黄仁勋辞任 CEO，但他没离开英伟达。 https://t.co/x'),
    ownPost('102', '黄仁勋辞任 CEO，但他没离开英伟达。', {publishedAt: NOW + 2 * HOUR}),
    ownPost('103', '黄仁勋辞任 CEO，但他没离开英伟达。', {own: false}),
    ownPost('900', '黄仁勋辞任 CEO，但他没离开英伟达。'),
    ownPost('104', '黄仁勋辞任 CEO，但他没离开英伟达。', {publishedAt: NOW - 2 * HOUR})
  ];
  const matches = publish.findMatches([waiting, other, done], posts, DraftStatus.from);
  assert.deepEqual(plain(matches.map(match => [match.draftId, match.post.id])), [['d:1', '101']]);
  const old = publish.findMatches([waiting], [ownPost('105', waiting.text, {publishedAt: NOW + 15 * 24 * HOUR})], DraftStatus.from);
  assert.equal(old.length, 0, '超过 14 天的不关联');
  const quote = draft({id: 'd:4', quoteUrl: 'https://x.com/bob/status/7'});
  assert.equal(publish.findMatches([quote], [ownPost('106', `${quote.text} https://t.co/q`)], DraftStatus.from).length, 1, '引用链接被 X 换成 t.co 仍能匹配');
});

test('复盘数据：bot 汇报优先，24 小时内读数取发布后一天内最后一次快照，无变化返回原对象', () => {
  const published = record.linkPost(draft(), {id: '101', url: 'https://x.com/me/status/101', publishedAt: NOW}, 'feed', NOW);
  const material = ownPost('101', 'x', {metrics: {views: 9000, likes: 80}, metricsAt: NOW + 30 * HOUR,
    snapshots: [{at: NOW + 2 * HOUR, views: 1000}, {at: NOW + 20 * HOUR, views: 6000}, {at: NOW + 30 * HOUR, views: 9000}]});
  const refreshed = review.refresh(published, material);
  assert.deepEqual(plain(refreshed.metrics), {views: 9000, likes: 80, observedAt: NOW + 30 * HOUR});
  assert.deepEqual(plain(refreshed.views24h), {views: 6000, hours: 20});
  assert.equal(review.refresh(refreshed, material), refreshed);
  assert.equal(review.refresh(published, undefined), published, '素材已清理时保留缓存');
  const manual = record.withManualMetrics(published, {views: 100}, NOW);
  assert.equal(review.effectiveMetrics(manual).origin, 'manual');
  assert.equal(review.effectiveMetrics({...manual, metrics: refreshed.metrics}).origin, 'feed');
});

test('复盘统计：按角度和形态分组，没有数据的计篇数不计平均；已发有数据的成为样本候选', () => {
  const make = (id, angle, format, views) => {
    const base = record.linkPost(draft({id, angle: angle ? {type: angle, hook: 'h'} : null, format}), {id: id.slice(2), url: `https://x.com/me/status/${id.slice(2)}`, publishedAt: NOW}, 'feed', NOW);
    return views === null ? base : {...base, metrics: {views, likes: views / 100}};
  };
  const drafts = [make('d:11', 'contrarian', 'short_opinion', 10000), make('d:12', 'contrarian', 'quote', 2000),
    make('d:13', null, 'short_opinion', null), make('d:14', 'roast', 'short_opinion', 30000), draft({id: 'd:15'})];
  const summary = review.summarize(drafts);
  assert.equal(summary.published, 4);
  assert.equal(summary.measured, 3);
  assert.equal(summary.avgViews, 14000);
  assert.deepEqual(plain(summary.byAngle.map(group => [group.key, group.count, group.avgViews, group.bestViews])),
    [['roast', 1, 30000, 30000], ['contrarian', 2, 6000, 10000], ['none', 1, null, null]]);
  assert.deepEqual(plain(summary.byFormat.map(group => [group.key, group.count, group.measured])), [['short_opinion', 3, 2], ['quote', 1, 1]]);
  const samples = review.asOwnPosts(drafts);
  assert.deepEqual(plain(samples.map(post => [post.id, post.metrics.views])), [['x:11', 10000], ['x:12', 2000], ['x:14', 30000]]);
  assert.equal(samples[0].own, true);
});
