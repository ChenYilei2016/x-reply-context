import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
// Exercise the production URL normalizer without exposing a test-only runtime API.
const source=await readFile(new URL('../extension/continuous.js',import.meta.url),'utf8');
const helper=source.slice(source.indexOf('    function searchKey('),source.indexOf('    function searchTabs('));
const key=vm.runInNewContext(`(${helper.trim()})`,{URL,location:{href:'https://x.com/compose/post',origin:'https://x.com'}});
test('标签入口编码或原文等价，并与输入同一#标签的搜索一致',()=>{
 const hash=key('/hashtag/浇朋友?src=hashtag_click');
 assert.ok(hash,'hashtag入口必须可识别');
 assert.equal(hash,key('/hashtag/%E6%B5%87%E6%9C%8B%E5%8F%8B?src=hashtag_click'));
 assert.equal(hash,key('/search?q=%23%E6%B5%87%E6%9C%8B%E5%8F%8B&src=typed_query'));
});
test('换标签、页签或搜索筛选时身份不同，来源和参数顺序不影响',()=>{
 const hash=key('/hashtag/浇朋友?src=hashtag_click&pf=on');
 assert.ok(hash);
 assert.notEqual(hash,key('/hashtag/蓝V互关?pf=on'));
 assert.notEqual(hash,key('/hashtag/浇朋友?pf=on&f=live'));
 assert.notEqual(hash,key('/hashtag/浇朋友'));
 assert.equal(hash,key('/hashtag/浇朋友?pf=on&src=other'));
});
test('拒绝无效标签、其他站点、详情页及非帖子页签',()=>{
 for(const path of ['/hashtag/','/hashtag/%ZZ','/hashtag/a/b','/hashtag/a%2Fb','/hashtag/%20',
  'https://example.com/hashtag/test','/alice/status/123','/hashtag/test?f=user','/hashtag/test?f=media','/hashtag/test?f=list'])assert.equal(key(path),'',path);
});
test('普通搜索仍保留查询词和筛选，热门与最新分开',()=>{
 assert.equal(key('/search?q=test&src=typed_query'),'q=test');
 assert.equal(key('/search?src=other&q=test&f=live'),'f=live&q=test');
 assert.equal(key('/search?q='),'');
});
