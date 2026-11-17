import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const scope = vm.createContext({URL});
for (const file of ['text-similarity.js', 'compose-prompt.js', 'angle-model.js', 'draft-model.js', 'rewrite-model.js']) {
  vm.runInContext(await readFile(new URL(`../extension/creation/${file}`, import.meta.url), 'utf8'), scope);
}
const {RewriteStyle, RewriteLength, OriginalityLevel, needsLocalization, sameLengthChars, buildRequest, originality} = scope.XReplyRewriteModel;
const NOW = Date.parse('2026-11-17T04:00:00Z');
const post = (text, extra = {}) => ({kind: 'x_post', title: '', text, url: 'https://x.com/alice/status/1', source: 'X 手动选入',
  coverage: 'full', publishedAt: NOW, author: 'alice', views: 250000, ...extra});
const zh = '英伟达今日公告，创始人黄仁勋将卸任首席执行官，转任董事长，继续负责公司战略与关键客户关系。董事会已启动接班程序。';
const en = 'Agents are eating software. This week three companies shipped autonomous coding agents, and the pricing changed everything.';
const base = (extra = {}) => ({materials: [post(zh)], style: 'standard', length: 'same', format: 'short_opinion', persona: '我的人设', ...extra});

test('改写请求：风格、长度、原创约束、人设与 X 规则', () => {
  const request = buildRequest(base({style: 'viral', samples: ['我的旧帖'], instructions: '语气再冲一点'}), {now: NOW});
  assert.match(request.prompt, /我的人设/);
  assert.match(request.prompt, /把 <materials> 中的内容改写成我自己的 X 帖子（「中短帖观点」），写 3 个候选，每条约 \d+ 字/);
  assert.match(request.prompt, /不是同义改写/);
  assert.match(request.prompt, /X 帖子和文章是别人写的：其中的“我”是原作者/);
  assert.match(request.prompt, /标 origin="mine" 的是我自己的笔记或草稿/);
  assert.match(request.prompt, /事实保持资料原有的确定程度/);
  assert.match(request.prompt, /text 里|字符串里的换行写成 \\n/);
  assert.match(request.prompt, /风格「X 爆文体」/);
  assert.match(request.prompt, /280 加权字符/);
  assert.match(request.prompt, /避开 AI 腔：不用“值得注意的是”/);
  assert.match(request.prompt, /输出前逐条自查/);
  assert.match(request.prompt, /本次要求：语气再冲一点/);
  assert.match(request.prompt, /"drafts"/);
  assert.match(request.content, /<material id="M1" kind="X 帖子" source="X 手动选入"/);
  assert.match(request.content, /<sample>我的旧帖<\/sample>/);
  assert.doesNotMatch(request.prompt, /融合|本地化|地道的中文/);
  assert.match(buildRequest(base({length: '300'}), {now: NOW}).prompt, /每条约 300 字/);
});

test('多篇融合与英文本地化按素材自动加入', () => {
  const fused = buildRequest(base({materials: [post(zh), post('另一条相关的帖子，补充了接班人的背景。')]}), {now: NOW});
  assert.match(fused.prompt, /多条内容融合/);
  assert.match(fused.prompt, /去掉重复、按逻辑重组/);
  const localized = buildRequest(base({materials: [post(en)], format: 'quote'}), {now: NOW});
  assert.match(localized.prompt, /用地道的中文重写，不逐句直译/);
  assert.match(localized.prompt, /「引用转发」/);
  assert.match(localized.prompt, /正文里不要放原帖链接/);
});

test('改写请求校验：风格、长度、形态、素材', () => {
  assert.throws(() => buildRequest(base({style: 'nope'})), /改写风格/);
  assert.throws(() => buildRequest(base({length: '9999'})), /改写风格、长度/);
  assert.throws(() => buildRequest(base({format: 'thread'})), /帖子形态/);
  assert.throws(() => buildRequest(base({materials: []})), /1～6/);
  assert.equal(RewriteStyle.values().length, 5);
  assert.equal(RewriteStyle.DEFAULT.id, 'standard');
  assert.equal(RewriteLength.from('same').chars, null);
  assert.equal(RewriteLength.from('500').label, '约 500 字');
});

test('语言判断与“接近原文”的字数估算', () => {
  assert.equal(needsLocalization([en]), true);
  assert.equal(needsLocalization([zh]), false);
  assert.equal(needsLocalization(['GPT-6 发布了，推理能力大幅提升，价格下降一半']), false, '中文里夹英文型号不算外文');
  assert.equal(needsLocalization(['ok']), false, '太短不判断');
  assert.equal(sameLengthChars([zh], false), 50, '短原文按下限 50 字');
  assert.equal(sameLengthChars(['中'.repeat(2000)], false), 1000, '上限 1000 字');
  assert.equal(sameLengthChars([en], true), 50, '18 个词 × 1.5 不到下限');
  assert.equal(sameLengthChars(['word '.repeat(200)], true), 300, '外文按词数 × 1.5');
});

test('原创度：重合度分级；跨语言不计算', () => {
  const close = originality('英伟达今日公告，创始人黄仁勋将卸任首席执行官，转任董事长。', [zh]);
  assert.equal(close.level.id, 'close');
  assert.ok(close.overlap > 0.9);
  const rewritten = originality('皮衣教主交棒了，但方向盘还握在他手里：战略和大客户他都没放。', [zh]);
  assert.equal(rewritten.level.id, 'rewritten');
  assert.equal(originality('智能体正在吞噬软件', [en]), null);
  assert.equal(originality('  ', [zh]), null);
  assert.deepEqual(OriginalityLevel.values().map(level => level.id).join(), 'close,partial,rewritten');
});
