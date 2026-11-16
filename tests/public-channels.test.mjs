import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const files = ['material-model.js', 'feed-parser.js', 'channel-http.js', 'channel-registry.js',
  'channels/rss-channels.js', 'channels/hot-list-channels.js', 'channels/github-trending.js'];
const sources = await Promise.all(files.map(file => readFile(new URL(`../extension/creation/${file}`, import.meta.url), 'utf8')));
const fixture = name => readFile(new URL(`./fixtures/creation/${name}`, import.meta.url), 'utf8');
const NOW = Date.parse('2026-11-16T12:00:00Z');

const scope = vm.createContext({URL});
sources.forEach(source => vm.runInContext(source, scope));
const {XReplyChannels: channels, XReplyMaterialModel: model, XReplyFeedParser: parser} = scope;

/** 用样本跑完整链路：适配器解析 → 素材模型归一化。 */
async function materialsOf(channelId, fixtureName) {
  const definition = channels.get(channelId);
  const raw = await fixture(fixtureName);
  const body = definition.format === 'json' ? JSON.parse(raw) : raw;
  const context = {channelId, now: NOW, defaultCategory: model.MaterialCategory.from(definition.category),
    metricsSource: model.MetricsSource.from(definition.metricsSource || 'channel_reported')};
  return definition.parse(body, {now: NOW}).map(item => {
    const result = model.normalize(item, context);
    assert.equal(result.error, undefined, `${channelId}: ${result.error}`);
    return result.material;
  });
}

test('feed 解析：实体与 CDATA、HTML 转文本、Atom 链接', () => {
  assert.equal(parser.decodeEntities('&lt;p&gt;A&amp;B &#20013;&#x6587; &hellip; &unknown;'), '<p>A&B 中文 … &unknown;');
  assert.equal(parser.htmlToText('<p>第一段<script>x()</script></p><p>第二&nbsp;段<br>换行</p>'), '第一段\n第二 段\n换行');
  const atom = '<feed><entry><link rel="self" href="https://a.example/self"/><link href="https://a.example/post?a=1&amp;b=2"/><title>T</title></entry></feed>';
  assert.equal(parser.parseFeed(atom)[0].link, 'https://a.example/post?a=1&b=2');
  assert.throws(() => parser.parseFeed('<html></html>'), /不是 RSS/);
  const many = `<rss><channel>${'<item><title>x</title><link>https://a.example/</link></item>'.repeat(10)}</channel></rss>`;
  assert.equal(parser.parseFeed(many, 3).length, 3);
});

test('全部公开渠道已注册，声明权限与主机一致', () => {
  const ids = [...channels.list().map(definition => definition.id)].sort();
  assert.deepEqual(ids, ['baidu-hot', 'bilibili-popular', 'github-trending', 'google-ai', 'hacker-news', 'ithome', 'openai-news', 'product-hunt', 'qbitai']);
  for (const definition of channels.list()) {
    assert.ok(definition.origins.every(origin => definition.hosts.some(host => origin === `https://${host}/*`)), definition.id);
    assert.ok(model.MaterialCategory.from(definition.category), definition.id);
  }
});

test('AI 一手来源：OpenAI、Google AI、量子位固定为 AI 分类', async () => {
  const openai = await materialsOf('openai-news', 'openai-news.xml');
  assert.equal(openai.length, 2);
  assert.ok(openai.every(item => item.category === 'ai' && item.kind === 'article' && item.url.startsWith('https://openai.com/')));
  assert.ok(openai[0].publishedAt > 0);
  const google = await materialsOf('google-ai', 'google-ai.xml');
  assert.equal(google[0].media[0]?.type, 'image');
  assert.doesNotMatch(google[0].text, /<img/);
  const qbit = await materialsOf('qbitai', 'qbitai.xml');
  assert.ok(qbit.every(item => item.category === 'ai' && item.title));
});

test('IT之家正文型描述识别为正文，按关键词分类', async () => {
  const items = await materialsOf('ithome', 'ithome.xml');
  assert.equal(items.length, 2);
  assert.equal(items[0].coverage, 'full');
  assert.doesNotMatch(items[0].text, /data-vmark|<p/);
  assert.ok(['tech', 'ai'].includes(items[0].category));
});

test('Hacker News 提取分数和评论数，Product Hunt 去掉链接行', async () => {
  const hn = await materialsOf('hacker-news', 'hacker-news.xml');
  assert.equal(hn.length, 3);
  assert.equal(hn[0].coverage, 'title');
  assert.equal(hn[0].metrics.rank, 1);
  assert.ok(hn[0].metrics.likes > 0);
  assert.match(hn[0].note, /^HN \d+ 分/);
  const ph = await materialsOf('product-hunt', 'product-hunt.xml');
  assert.equal(ph[0].category, 'product');
  assert.equal(ph[0].url, 'https://www.producthunt.com/products/openframe-3');
  assert.doesNotMatch(ph[0].text, /Discussion|Link/);
});

test('百度热搜排除置顶，只有名次指标；B站热门带播放量和发布时间', async () => {
  const baidu = await materialsOf('baidu-hot', 'baidu-hot.json');
  assert.equal(baidu.length, 5, '6 条中 1 条置顶被排除');
  assert.equal(baidu[0].metrics.rank, 1);
  assert.equal(baidu[0].metricsSource, 'rank_only');
  assert.ok(baidu.every(item => item.url.startsWith('https://') && item.kind === 'hot_topic'));
  const bili = await materialsOf('bilibili-popular', 'bilibili-popular.json');
  assert.equal(bili.length, 3);
  assert.ok(bili[0].metrics.views > 0 && bili[0].metrics.rank === 1);
  assert.equal(bili[0].metricsSource, 'channel_reported');
  assert.match(bili[0].url, /^https:\/\/www\.bilibili\.com\/video\/BV/);
  assert.ok(bili[0].publishedAt > 0);
  assert.ok(bili[0].media[0].url.startsWith('https://'));
  assert.ok(model.velocity(bili[0], NOW) > 0, 'B站有播放量和发布时间，可计算流速');
  assert.throws(() => channels.get('bilibili-popular').parse({code: -352}), /code -352/);
  assert.throws(() => channels.get('baidu-hot').parse({}), /结构已变化/);
});

test('GitHub Trending 解析仓库、星标和今日增长，页面变化时报错', async () => {
  const repos = await materialsOf('github-trending', 'github-trending.html');
  assert.equal(repos.length, 2);
  assert.equal(repos[0].id, 'https://github.com/ag-ui-protocol/ag-ui');
  assert.equal(repos[0].category, 'open_source');
  assert.equal(repos[0].metrics.stars, 18434);
  assert.match(repos[0].note, /^今日 \+790 star$/);
  assert.ok(repos[0].tags.includes('TypeScript'));
  assert.ok(repos[0].tags.includes('AI'), '描述含 Agent，标记 AI');
  assert.throws(() => channels.get('github-trending').parse('<html></html>'), /结构已变化/);
});
