import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('同一页面的不同脚本环境使用独立的文件路径',async()=>{
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json',import.meta.url),'utf8'));
  const main = manifest.content_scripts.find(script=>script.world === 'MAIN');
  const isolated = manifest.content_scripts.find(script=>!script.world || script.world === 'ISOLATED');
  const duplicates = main.js.filter(path=>isolated.js.includes(path));
  assert.deepEqual(duplicates,[], 'Chromium 按文件路径去重，后一个脚本环境会缺少重复声明的文件');
});
