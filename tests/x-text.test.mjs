import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const scope = vm.createContext({Intl});
vm.runInContext(await readFile(new URL('../extension/creation/x-text.js', import.meta.url), 'utf8'), scope);
const {weightedLength, foldIndex, measure, FOLD_LIMIT, PREMIUM_LIMIT} = scope.XReplyXText;

test('加权字数：半角计 1，中日韩计 2，常用标点按 X 的区间计', () => {
  assert.equal(weightedLength('hello world'), 11);
  assert.equal(weightedLength('你好，世界'), 10, '全角逗号也计 2');
  assert.equal(weightedLength('こんにちは'), 10);
  assert.equal(weightedLength('한국어'), 6);
  assert.equal(weightedLength('“引号”—'), 1 + 4 + 1 + 1, 'U+2014、U+201C、U+201D 落在计 1 的区间');
  assert.equal(weightedLength('…'), 2, 'U+2026 不在计 1 的区间');
  assert.equal(weightedLength(''), 0);
});

test('emoji 按 2 计，组合序列（肤色、家庭、国旗）整体按 2 计', () => {
  assert.equal(weightedLength('👍'), 2);
  assert.equal(weightedLength('👍🏽'), 2);
  assert.equal(weightedLength('👨‍👩‍👧'), 2);
  assert.equal(weightedLength('🇨🇳'), 2);
  assert.equal(weightedLength('ok👌'), 4);
});

test('链接无论长短按 23 计，中文标点不算进链接', () => {
  assert.equal(weightedLength('https://x.com'), 23);
  assert.equal(weightedLength(`https://example.com/${'a'.repeat(200)}`), 23);
  assert.equal(weightedLength('看 https://openai.com/blog，不错'), 2 + 1 + 23 + 2 + 4);
  assert.equal(weightedLength('www.example.com/path'), 23);
});

test('先做 NFC 规范化：组合字符按一个字计', () => {
  assert.equal(weightedLength('é'), 1);
});

test('首屏折叠位置：140 个汉字正好不折叠，第 141 个起折叠；链接跨线时整体放到线后', () => {
  assert.equal(foldIndex('中'.repeat(140)), null);
  assert.equal(foldIndex('中'.repeat(141)), 140);
  assert.equal(foldIndex('a'.repeat(280)), null);
  assert.equal(foldIndex('a'.repeat(281)), 280);
  const text = `${'中'.repeat(135)}https://example.com/long`;
  assert.equal(foldIndex(text), 135, '270 + 23 超过 280，链接整体在线后');
  assert.equal(FOLD_LIMIT, 280);
});

test('计数摘要：折叠、Premium 上限', () => {
  const short = measure('短帖');
  assert.equal(short.length, 4);
  assert.equal(short.folded, false);
  const long = measure('中'.repeat(12501));
  assert.equal(long.overPremium, true);
  assert.equal(long.folded, true);
  assert.equal(PREMIUM_LIMIT, 25000);
});
