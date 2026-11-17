import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const scope = vm.createContext({});
vm.runInContext(await readFile(new URL('../extension/creation/post-lint.js', import.meta.url), 'utf8'), scope);
const {check, describe} = scope.XReplyPostLint;
const ids = issues => [...issues.map(issue => issue.id)];

test('找出提到资料本身的说法：素材、原文、时间未知、编号', () => {
  const issues = check('一则发布时间未知的素材介绍了新模型。素材还称价格减半（M1），原文提到开源。');
  const meta = issues.find(issue => issue.id === 'meta');
  assert.ok(meta, '应提示提到了资料本身');
  assert.ok(meta.matches.length <= 3, '每类最多列 3 个片段');
  assert.ok(meta.matches.includes('素材'));
  assert.match(describe(issues)[0], /^提到了资料本身（“.+”）：读者看不到/);
});

test('引用转发时“原帖”是正常说法，其他形态才提示', () => {
  assert.deepEqual(ids(check('原帖说得太乐观了。', {quotes: true})), []);
  assert.deepEqual(ids(check('原帖说得太乐观了。')), ['meta']);
});

test('AI 套话、营销腔、破折号与多个话题标签', () => {
  assert.deepEqual(ids(check('值得注意的是，这不仅仅是降价，更是信号。')), ['cliche']);
  assert.deepEqual(ids(check('家人们，重磅消息')), ['hype']);
  assert.deepEqual(ids(check('它便宜了——但没那么简单')), ['dash']);
  assert.deepEqual(ids(check('今天聊聊 #AI #OpenAI')), ['hashtags']);
  assert.deepEqual(ids(check('今天聊聊 #AI')), [], '一个标签不提示');
});

test('正常的帖子没有问题；空正文不检查', () => {
  assert.deepEqual(ids(check('OpenAI 把 API 价格砍了一半。小团队终于敢把 Agent 跑在生产里了，你会先拿它做什么？')), []);
  assert.deepEqual(ids(check('Apple M4 芯片的跑分出来了')), [], '芯片型号不是资料编号');
  assert.deepEqual(ids(check('   ')), []);
});
