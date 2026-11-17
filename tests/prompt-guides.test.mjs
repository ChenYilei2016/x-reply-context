import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const files = ['compose-prompt.js', 'angle-model.js', 'draft-model.js', 'rewrite-model.js', 'style-model.js', 'image-model.js', 'prompt-guides.js'];
const sources = await Promise.all(files.map(file => readFile(new URL(`../extension/creation/${file}`, import.meta.url), 'utf8')));
function setup(saved = {}) {
  const data = {creationPromptGuides: saved};
  const chrome = {storage: {local: {get: async key => ({[key]: data[key]}), set: async values => Object.assign(data, values)}}};
  const scope = vm.createContext({URL, chrome, crypto});
  sources.forEach(source => vm.runInContext(source, scope));
  return {scope, data};
}
const NOW = Date.parse('2026-11-17T04:00:00Z');
const material = {kind: 'note', title: '', text: '我粘贴进来的一段正文，讲的是新模型发布后的价格变化。', url: '', source: '粘贴', coverage: 'excerpt', publishedAt: null};

test('每个任务都有默认写作要求；只保存与默认不同、非空、不超长的修改', async () => {
  const {scope: {XReplyPromptGuides: guides}, data} = setup({rewrite: '  只用短句  ', drafts: '', unknown: 'x', angles: 'a'.repeat(3001)});
  for (const task of guides.TASKS) assert.ok(guides.defaultGuide(task.id).length > 20, task.id);
  assert.deepEqual({...await guides.load()}, {rewrite: '只用短句'});
  await guides.save('styles', '只看开头');
  await guides.save('rewrite', guides.defaultGuide('rewrite'));
  assert.deepEqual({...data.creationPromptGuides}, {styles: '只看开头'}, '与默认相同视为恢复默认');
  await assert.rejects(guides.save('nope', 'x'), /未知/);
  await assert.rejects(guides.save('styles', 'a'.repeat(3001)), /最多 3000 字/);
});

test('写作要求进入各任务提示词；任务说明、事实约束与输出格式不随修改消失', () => {
  const {scope} = setup();
  const {XReplyRewriteModel: rewrite, XReplyDraftModel: drafts, XReplyAngleModel: angles, XReplyStyleModel: style, XReplyImageModel: image} = scope;
  const input = {materials: [material], style: 'standard', length: '200', format: 'short_opinion', persona: '人设'};
  const custom = rewrite.buildRequest(input, {now: NOW, guide: '全部用短句，每段不超过两行。'}).prompt;
  assert.match(custom, /<writing_guide>\n全部用短句，每段不超过两行。/);
  assert.doesNotMatch(custom, /不是同义改写/, '默认写作要求被替换');
  assert.match(custom, /原内容里的“我”是原作者/, '事实约束固定保留');
  assert.match(custom, /只写 <materials> 里有的事实/);
  assert.match(custom, /"drafts"/);
  assert.match(rewrite.buildRequest(input, {now: NOW}).prompt, /<writing_guide>\n这是二次创作，不是同义改写/);
  assert.match(rewrite.buildRequest(input, {now: NOW, guide: '  '}).prompt, /不是同义改写/, '空修改用默认');
  assert.match(drafts.buildRequest({...input, guide: undefined}, {now: NOW, guide: '自定义成稿'}).prompt, /<writing_guide>\n自定义成稿/);
  assert.match(angles.buildRequest({materials: [material], persona: '人设'}, {now: NOW, guide: '自定义角度'}).prompt, /自定义角度[\s\S]*"angles"/);
  const posts = [1, 2, 3].map(index => ({text: `帖子 ${index}`}));
  const styles = style.buildRequest({posts}, {now: NOW, guide: '自定义拆解'}).prompt;
  assert.match(styles, /<writing_guide>\n自定义拆解/);
  assert.match(styles, /example 必须是从帖子里原样摘出/, '防编造规则固定保留');
  assert.match(image.buildPromptRequest({text: '正文', style: 'news', ratio: '1:1'}, {guide: '自定义配图'}).prompt, /自定义配图[\s\S]*不画真实人物/);
});

test('粘贴内容可以没有链接；其他素材仍要求 HTTPS 链接', () => {
  const {scope: {XReplyComposePrompt: prompt}} = setup();
  const [note] = prompt.checkMaterials([material]);
  assert.equal(note.url, '');
  assert.doesNotMatch(prompt.materialXml(note, 0), /<url>/);
  const xml = prompt.materialXml(note, 0);
  assert.match(xml, /^<material id="M1" source="粘贴" coverage="摘要">/, '粘贴内容不写类型');
  assert.doesNotMatch(prompt.materialXml({...note, source: ''}, 0), /source=/, '没有来源名时不写来源');
  assert.doesNotMatch(xml, /published_at|未知/, '时间未知时不写，避免模型在正文里复述“时间未知”');
  assert.match(prompt.materialXml({...note, publishedAt: Date.parse('2026-11-16T09:00:00Z')}, 0), /published_at="2026-11-16T09:00:00.000Z"/);
  assert.throws(() => prompt.checkMaterials([{...material, kind: 'article'}]), /链接无效/);
  assert.equal(prompt.checkMaterials(Array(6).fill(material)).length, 6);
});
