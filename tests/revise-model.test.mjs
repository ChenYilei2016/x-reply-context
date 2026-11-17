import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const scope = vm.createContext({URL});
for (const file of ['compose-prompt.js', 'revise-model.js']) {
  vm.runInContext(await readFile(new URL(`../extension/creation/${file}`, import.meta.url), 'utf8'), scope);
}
const {ReviseAction, buildRequest, parse} = scope.XReplyReviseModel;
const NOW = Date.parse('2026-11-17T04:00:00Z');
const base = (extra = {}) => ({text: '值得注意的是，OpenAI 降价了。', action: 'human', persona: '我的人设', ...extra});

test('精修请求：人设、动作说明、正文转义、不新增事实', () => {
  const request = buildRequest(base({text: '降价了 <b>'}), {now: NOW});
  assert.match(request.prompt, /<persona>\n我的人设\n<\/persona>/);
  assert.match(request.prompt, /本次修改：改得更像真人随手发的/);
  assert.match(request.prompt, /不新增 <post> 和 <materials> 里都没有的事实/);
  assert.match(request.prompt, /只在 <post> 已有的信息范围内修改/, '没有资料时只在正文范围内改');
  assert.match(request.prompt, /<reply>修改后的完整正文<\/reply>/);
  assert.equal(request.content, '<post>降价了 &lt;b&gt;</post>');
});

test('修掉问题带上自查结果；按我的要求带上指令；带资料时做事实核对', () => {
  const fix = buildRequest(base({action: 'fix', issues: ['AI 套话（“值得注意的是”）：删掉']}), {now: NOW});
  assert.match(fix.content, /<issues>\n<issue>AI 套话（“值得注意的是”）：删掉<\/issue>\n<\/issues>/);
  const custom = buildRequest(base({action: 'custom', instruction: '加一句价格对比',
    materials: [{kind: 'note', title: '', text: '输入价格从 2 美元降到 1 美元。', url: '', source: '', coverage: 'title', publishedAt: null}]}), {now: NOW});
  assert.match(custom.content, /<instruction>加一句价格对比<\/instruction>/);
  assert.match(custom.content, /<materials>\n<material id="M1"/);
  assert.doesNotMatch(custom.prompt, /只在 <post> 已有的信息范围内修改/);
});

test('精修请求校验：空正文、未知动作、缺问题或缺要求', () => {
  assert.throws(() => buildRequest(base({text: ' '})), /正文是空的/);
  assert.throws(() => buildRequest(base({action: 'nope'})), /未知的精修方式/);
  assert.throws(() => buildRequest(base({action: 'fix', issues: []})), /没有需要修的问题/);
  assert.throws(() => buildRequest(base({action: 'custom', instruction: ''})), /先写下你想怎么改/);
  assert.throws(() => buildRequest(base({text: 'a'.repeat(4001)})), /最多 4000 字/);
  assert.equal(ReviseAction.values().length, 7);
});

test('精修结果去掉整段引号；空结果报错', () => {
  assert.equal(parse('「改好的正文」'), '改好的正文');
  assert.throws(() => parse('  '), /没有返回修改后的正文/);
});
