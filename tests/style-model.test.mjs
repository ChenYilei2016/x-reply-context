import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const scope = vm.createContext({URL, crypto});
for (const file of ['text-similarity.js', 'compose-prompt.js', 'angle-model.js', 'draft-model.js', 'rewrite-model.js', 'style-model.js']) {
  vm.runInContext(await readFile(new URL(`../extension/creation/${file}`, import.meta.url), 'utf8'), scope);
}
const {XReplyStyleModel: style, XReplyDraftModel: drafts, XReplyRewriteModel: rewrite, XReplyComposePrompt: prompt} = scope;
const plain = value => JSON.parse(JSON.stringify(value));
const NOW = Date.parse('2026-11-17T04:00:00Z');
const posts = [
  {text: 'AI 不会取代你，但会用 AI 的人会。今天聊三个我每天在用的工具。', views: 120000},
  {text: '别再收藏提示词了。真正拉开差距的，是你有没有自己的工作流。', views: 80000},
  {text: '一个反常识：模型越强，提示词越该写短。原因有两个。', views: 50000}
];
const result = JSON.stringify({
  positioning: '面向普通人的 AI 效率博主', topics: ['AI 工具', '工作流'],
  hooks: [{pattern: '先抛反常识结论', example: '一个反常识：模型越强，提示词越该写短'}, {pattern: '否定常见做法', example: '编出来的一句话'}, '用数字列清单'],
  structure: '结论 → 两三个理由 → 一句行动建议', tone: '口语、短句、略带调侃', avoid: ['堆砌术语', '长段落']
});

test('拆解请求：3～10 条帖子，带作者和浏览量，帖子作为引用内容', () => {
  const request = style.buildRequest({author: {handle: 'bob', name: '鲍勃'}, posts}, NOW);
  assert.match(request.prompt, /拆解 <posts> 中这位作者的写作风格/);
  assert.match(request.prompt, /example 必须是从帖子里原样摘出的一句/);
  assert.match(request.content, /<posts author="鲍勃 @bob">/);
  assert.match(request.content, /<post id="P1" views="120000">AI 不会取代你/);
  assert.throws(() => style.buildRequest({posts: posts.slice(0, 2)}), /3～10 条/);
  assert.throws(() => style.buildRequest({posts: Array(11).fill(posts[0])}), /3～10 条/);
  assert.throws(() => style.buildRequest({posts: [...posts, {text: ' '}]}), /空正文/);
  assert.match(style.buildRequest({posts}, NOW).content, /未注明作者/);
});

test('解析：容错 JSON；示例原句必须出自所给帖子，编造的清空但保留手法', () => {
  const {rules, droppedExamples} = style.parse(`好的：\n\`\`\`json\n${result}\n\`\`\``, posts);
  assert.equal(rules.positioning, '面向普通人的 AI 效率博主');
  assert.deepEqual(plain(rules.hooks), [
    {pattern: '先抛反常识结论', example: '一个反常识：模型越强，提示词越该写短'},
    {pattern: '否定常见做法', example: ''},
    {pattern: '用数字列清单', example: ''}
  ]);
  assert.equal(droppedExamples, 1);
  assert.deepEqual(plain(rules.avoid), ['堆砌术语', '长段落']);
  assert.throws(() => style.parse('{"avoid":["x"]}', posts), /没有返回可用的风格规则/);
});

test('模板：创建、改名与编辑校验；发给成稿的结构不带示例原句', () => {
  const {rules} = style.parse(result, posts);
  const template = style.create(rules, {handle: 'bob', name: '鲍勃', postCount: 3}, NOW, 's:1');
  assert.equal(template.name, '@bob 的风格');
  assert.equal(template.source.postCount, 3);
  const edited = style.update(template, {name: '效率博主', tone: '更冲一点', topics: '工具\n- 工作流\n'}, NOW + 1);
  assert.equal(edited.name, '效率博主');
  assert.equal(edited.tone, '更冲一点');
  assert.deepEqual(plain(edited.topics), ['工具', '工作流']);
  assert.throws(() => style.update(template, {name: ' '}), /模板名不能为空/);
  assert.throws(() => style.update(template, {positioning: '', topics: [], hooks: [], structure: '', tone: ''}), /至少要有/);
  const compact = style.forPrompt(edited);
  assert.deepEqual(plain(compact.hooks), ['先抛反常识结论', '否定常见做法', '用数字列清单']);
  assert.equal(JSON.stringify(compact).includes('模型越强'), false);
});

test('成稿与改写套用风格模板：只学写法，与人设冲突以人设为准', () => {
  const {rules} = style.parse(result, posts);
  const benchmark = style.forPrompt(style.create(rules, {handle: 'bob'}, NOW, 's:1'));
  const material = {kind: 'article', title: '新模型发布', text: '官方介绍了推理能力。', url: 'https://a.example/1', source: 'A', coverage: 'excerpt', publishedAt: NOW};
  const draft = drafts.buildRequest({materials: [material], format: 'short_opinion', persona: '人设', benchmark}, NOW).prompt;
  assert.match(draft, /参考对标风格「@bob 的风格」，只学写法，不照搬其内容和原句；与我的人设冲突时以人设为准/);
  assert.match(draft, /- 开头手法：先抛反常识结论；否定常见做法；用数字列清单/);
  assert.match(draft, /- 避免：堆砌术语；长段落/);
  const rewritten = rewrite.buildRequest({materials: [material], style: 'standard', length: 'same', format: 'short_opinion', persona: '人设', benchmark}, NOW).prompt;
  assert.match(rewritten, /- 结构：结论 → 两三个理由 → 一句行动建议/);
  assert.doesNotMatch(drafts.buildRequest({materials: [material], format: 'short_opinion', persona: '人设'}, NOW).prompt, /对标风格/);
  assert.throws(() => prompt.checkBenchmark({name: '空'}), /内容为空/);
});
