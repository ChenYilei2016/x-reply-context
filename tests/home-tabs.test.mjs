import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../extension/continuous.js',import.meta.url),'utf8');
const helpers=source.slice(source.indexOf('    function homeTabs('),source.indexOf('    function profileTabs('));
const {homeTabs,selectedHomeTab,homeTabKey}=vm.runInNewContext(`(()=>{${helpers};return {homeTabs,selectedHomeTab,homeTabKey};})()`,{URL,location:{origin:'https://x.com',href:'https://x.com/home'}});
const tab=(text,selected=false)=>({textContent:text,getAttribute:key=>key==='aria-selected'?String(selected):null,matches:()=>false,querySelector:()=>null});
const primary=tabs=>({querySelector:()=>({querySelectorAll:()=>tabs})});
test('主页前两项与右侧自定义标签均能识别，缺少选中项时不启动',()=>{
  for(let index=0;index<5;index++) {
    const tabs=['为你推荐','正在关注','科学','科技','新人蓝朋友'].map((text,i)=>tab(text,i===index));
    assert.equal(selectedHomeTab(primary(tabs)),index);
  }
  assert.equal(selectedHomeTab(primary([tab('科技')])),-1);
});
test('首页标签身份不只依赖位置，忽略排版空白但识别名称变化',()=>{
  assert.equal(homeTabKey(tab(' 科技\n ')),homeTabKey(tab('科技')));
  assert.notEqual(homeTabKey(tab('科技')),homeTabKey(tab('科学')));
  assert.equal(homeTabKey(undefined),'');
});
test('只读取主页标签栏，卡片或编辑器里的标签不混入索引',()=>{
  const tabs=[tab('为你推荐'),tab('正在关注'),tab('科技',true)];
  const column={...primary(tabs),querySelectorAll:()=>[...tabs,tab('其他内嵌标签',true)]};
  assert.equal(homeTabs(column).length,3);assert.equal(selectedHomeTab(column),2);
});
