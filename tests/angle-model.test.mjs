import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const scope = vm.createContext({URL});
for (const file of ['compose-prompt.js', 'angle-model.js']) {
  vm.runInContext(await readFile(new URL(`../extension/creation/${file}`, import.meta.url), 'utf8'), scope);
}
const {XReplyAngleModel: {AngleType, AngleCoverage, buildRequest, parse, assess}, XReplyComposePrompt: prompt} = scope;
const NOW = Date.parse('2026-11-17T04:00:00Z');
const material = (extra = {}) => ({kind: 'article', title: 'OpenAI 发布新模型', text: '官方博客介绍了新模型的推理能力。', url: 'https://openai.com/news/1',
  source: 'OpenAI', coverage: 'excerpt', publishedAt: NOW - 3600_000, author: '', ...extra});
const reference = (extra = {}) => ({url: 'https://x.com/a/status/1', author: 'a', text: '新模型实测：推理快了一倍', views: 120000, velocity: 8000, ...extra});
const counts = {materials: 2, references: 2};

test('构建请求：素材与参考帖编号、转义、人设与规则；校验输入', () => {
  const request = buildRequest({materials: [material(), material({kind: 'x_post', text: '<script>注意</script>', author: 'b', views: 5000})],
    references: [reference(), {url: 'http://bad', text: '丢弃'}], persona: '测试人设'}, {now: NOW});
  assert.match(request.prompt, /测试人设/);
  assert.match(request.prompt, /2026-11-17T04:00:00.000Z/);
  assert.match(request.prompt, /反常识/);
  assert.match(request.prompt, /<rules>\n只写 <materials> 里有的事实/);
  assert.match(request.prompt, /读者看不到你收到的资料/, '正文不提资料本身');
  assert.match(request.prompt, /<persona>\n测试人设\n<\/persona>/);
  assert.match(request.content, /<material id="M1" kind="文章" source="OpenAI" coverage="摘要"/);
  assert.match(request.content, /id="M2" kind="X 帖子".*author="@b" views="5000"/);
  assert.match(request.content, /&lt;script&gt;/);
  assert.match(request.content, /<reference id="R1" author="@a" views="120000">/);
  assert.doesNotMatch(request.content, /R2/, '非 HTTPS 的参考帖被丢弃');

  assert.throws(() => buildRequest({materials: [], persona: 'p'}), /1～6/);
  assert.throws(() => buildRequest({materials: Array(7).fill(material()), persona: 'p'}), /1～6/);
  assert.throws(() => buildRequest({materials: [material({url: 'http://a.com'})], persona: 'p'}), /链接无效/);
  assert.throws(() => buildRequest({materials: [material()], persona: ' '}), /人设/);
  assert.match(buildRequest({materials: [material()], persona: 'p'}).content, /没有同话题的 X 帖子/);
});

test('解析：容忍代码块、说明文字、尾随逗号和中文类型名', () => {
  const text = '好的，以下是角度：\n```json\n{"angles":[{"type":"反常识","hook":"新模型最大的变化不是快","outline":"- 速度\\n- 价格",' +
    '"evidence":["M1","M9"],"risk":"","covered_by":["R1","R7"]},{"type":"listicle","hook":"三个变化","outline":["一","二"],"evidence":[2],"covered_by":[]},]}\n```';
  const {angles, dropped} = parse(text, counts);
  assert.equal(dropped, 0);
  assert.equal(angles.length, 2);
  assert.equal(angles[0].type, 'contrarian');
  assert.deepEqual([...angles[0].outline], ['速度', '价格']);
  assert.deepEqual([...angles[0].evidence], [0], '越界的 M9 丢弃');
  assert.deepEqual([...angles[0].coveredBy], [0], '越界的 R7 丢弃');
  assert.deepEqual([...angles[1].evidence], [1], '数字编号也接受');
});

test('解析：缺类型或钩子的角度丢弃；全部无效或不是 JSON 时报错', () => {
  const {angles, dropped} = parse(JSON.stringify([{type: '解读', hook: '可用'}, {type: '未知', hook: 'x'}, {type: '吐槽'}]), counts);
  assert.equal(angles.length, 1);
  assert.equal(dropped, 2);
  assert.throws(() => parse('{"angles":[{"type":"未知"}]}', counts), /缺少类型或钩子/);
  assert.throws(() => parse('我觉得可以从三个方向写', counts), /没有返回结构化结果/);
  assert.throws(() => parse('{"angles": [', counts), /不完整|无法解析/);
  assert.throws(() => parse('{"ideas":[]}', counts), /没有角度列表/);
});

test('对照：有同角度参考帖为“已有人写”，潜力取真实最高值；没有则为新角度、潜力无依据', () => {
  const references = [reference(), reference({url: 'https://x.com/c/status/3', views: 300000, velocity: undefined})];
  const [covered, fresh, noData] = assess([
    {type: 'interpret', hook: 'a', outline: [], evidence: [0], risk: '', coveredBy: [0, 1]},
    {type: 'prediction', hook: 'b', outline: [], evidence: [], risk: '', coveredBy: []},
    {type: 'story', hook: 'c', outline: [], evidence: [], risk: '', coveredBy: [2]}
  ], references);
  assert.equal(covered.coverage, AngleCoverage.COVERED.id);
  assert.equal(covered.potential.views, 300000);
  assert.equal(covered.potential.velocity, 8000);
  assert.equal(covered.potential.basis, 2);
  assert.equal(covered.coveringPosts.length, 2);
  assert.equal(fresh.coverage, 'new');
  assert.equal(fresh.potential, null);
  assert.equal(noData.coverage, 'new', '编号超出参考帖列表时不算已有人写');
  assert.equal(AngleType.from('教程').id, 'tutorial');
  assert.equal(AngleCoverage.from('new').label, '新角度');
});

test('素材风险：只有标题、超过 48 小时', () => {
  const warnings = prompt.materialWarnings([material({coverage: 'title'}), material({coverage: 'title', publishedAt: NOW - 50 * 3600_000})], NOW);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /只有标题/);
  assert.match(warnings[1], /M2 .*48 小时/);
  assert.equal(prompt.materialWarnings([material()], NOW).length, 0);
});

test('页面取字段：素材与参考帖只带需要的内容', () => {
  const stored = {id: 'x:1', kind: 'x_post', title: '', text: '帖子正文', url: 'https://x.com/a/status/1', coverage: 'full',
    publishedAt: NOW, firstSeenAt: NOW, author: {handle: 'a', followers: 10}, metrics: {views: 10, likes: 1}, snapshots: [{}]};
  const picked = prompt.toPromptMaterial(stored, 'Grok 机器人');
  assert.deepEqual(Object.keys(picked).sort(), ['author', 'coverage', 'kind', 'publishedAt', 'rank', 'source', 'text', 'title', 'url', 'views']);
  assert.equal(picked.author, 'a');
  const ref = prompt.toPromptReference(stored, 12.5);
  assert.equal(ref.velocity, 12.5);
  assert.equal(ref.views, 10);
});
