import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const scope = vm.createContext({URL});
for (const file of ['compose-prompt.js', 'angle-model.js', 'draft-model.js']) {
  vm.runInContext(await readFile(new URL(`../extension/creation/${file}`, import.meta.url), 'utf8'), scope);
}
const {PostFormat, DEFAULT_PERSONA, buildRequest, parse, selectSamples} = scope.XReplyDraftModel;
const DAY = 86400_000;
const NOW = Date.parse('2026-11-17T04:00:00Z');
const material = (extra = {}) => ({kind: 'article', title: '某公司开源新模型', text: '模型权重已在 GitHub 公开。', url: 'https://github.com/a/b',
  source: 'GitHub Trending', coverage: 'excerpt', publishedAt: NOW, ...extra});
const base = () => ({materials: [material()], format: 'short_opinion', persona: DEFAULT_PERSONA});

test('构建请求：形态、字数范围、角度、样本、附加要求和首屏规则', () => {
  const request = buildRequest({...base(), angle: {type: 'contrarian', hook: '开源不等于免费', outline: ['许可证', '算力']},
    samples: ['我的旧帖 <b>'], instructions: '结尾抛个问题'}, NOW);
  assert.match(request.prompt, /3 条可以直接发在 X 上的「中短帖观点」候选，每条约 150～400 字/);
  assert.match(request.prompt, /本次角度：反常识。参考钩子：开源不等于免费/);
  assert.match(request.prompt, /1\. 许可证；2\. 算力/);
  assert.match(request.prompt, /280 加权字符/);
  assert.match(request.prompt, /本次要求：结尾抛个问题/);
  assert.match(request.prompt, /小娱乐、大 AI 科技/);
  assert.match(request.content, /<samples>\n<sample>我的旧帖 &lt;b&gt;<\/sample>/);
  const plain = buildRequest({...base(), format: 'quote'}, NOW);
  assert.match(plain.prompt, /「引用转发」/);
  assert.match(plain.prompt, /正文里不要放原帖链接/);
  assert.doesNotMatch(plain.prompt, /本次角度|<samples>/);
});

test('构建请求：拒绝无效形态、角度、样本数量和过长要求', () => {
  assert.throws(() => buildRequest({...base(), format: 'thread'}), /形态/);
  assert.throws(() => buildRequest({...base(), angle: {type: 'nope', hook: 'x'}}), /角度无效/);
  assert.throws(() => buildRequest({...base(), samples: Array(6).fill('a')}), /最多 5 条/);
  assert.throws(() => buildRequest({...base(), instructions: 'a'.repeat(501)}), /最多 500 字/);
  assert.throws(() => buildRequest({...base(), persona: 'a'.repeat(2001)}), /人设最多/);
});

test('解析候选：容错 JSON、去引号、去重、最多 3 条', () => {
  const drafts = parse('<reply>{"drafts":[{"hook_style":"提问","text":"“开源就免费？”"},{"hook_style":"数字","text":"三个数字"},' +
    '{"hook_style":"重复","text":"三个数字"},{"text":"第四条"},{"text":"第五条"}]}</reply>');
  assert.equal(drafts.length, 3);
  assert.equal(drafts[0].text, '开源就免费？');
  assert.equal(drafts[0].hookStyle, '提问');
  assert.equal(drafts[2].text, '第四条');
  assert.equal(parse('["只有正文"]')[0].text, '只有正文');
  assert.throws(() => parse('{"drafts":[{"text":"  "}]}'), /没有返回可用的候选稿/);
  assert.throws(() => parse('{"posts":[]}'), /没有候选稿/);
});

test('样本：手动样本在前，再按浏览量补近 60 天自己的帖子，排除被排除的和别人的', () => {
  const own = (id, views, age, extra = {}) => ({id, kind: 'x_post', own: true, text: `帖子 ${id}`, publishedAt: NOW - age * DAY, metrics: {views}, ...extra});
  const samples = selectSamples({
    manual: [{id: 'm1', text: ' 手动样本 '}, {id: 'm2', text: ''}],
    own: [own('a', 100, 1), own('b', 9000, 2), own('c', 5000, 70), own('d', 7000, 3), own('e', 99999, 1, {own: false}), own('f', 8000, 1)],
    excluded: ['f'], now: NOW
  });
  assert.deepEqual([...samples.map(sample => sample.id)], ['m1', 'b', 'd', 'a']);
  assert.equal(samples[0].text, '手动样本');
  assert.equal(samples[1].views, 9000);
  const many = selectSamples({own: Array.from({length: 8}, (_, i) => own(`p${i}`, i, 1)), now: NOW});
  assert.equal(many.length, 5);
});

test('形态：引用转发附原帖链接，优先选中素材里的 X 帖子', () => {
  const quote = PostFormat.from('quote');
  const materials = [material(), material({kind: 'x_post', url: 'https://x.com/a/status/9'})];
  assert.equal(PostFormat.quoteTarget(quote, materials), 'https://x.com/a/status/9');
  assert.equal(PostFormat.quoteTarget(quote, [material()]), 'https://github.com/a/b');
  assert.equal(PostFormat.quoteTarget(PostFormat.DEFAULT, materials), null);
  assert.equal(PostFormat.DEFAULT.id, 'short_opinion');
});
