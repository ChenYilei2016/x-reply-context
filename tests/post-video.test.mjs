import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import '../extension/core.js';
import '../extension/post-video.js';
import '../extension/video-download.js';

const mediaUrl = name => `https://video.twimg.com/ext_tw_video/111/pu/vid/${name}`;
const low = mediaUrl('480x270/low.mp4?tag=12');
const high = mediaUrl('1280x720/high.mp4?tag=12');
const variant = (url,bitrate,content_type = 'video/mp4') => ({url,bitrate,content_type});
const media = (variants,allow = true) => ({type:'video',video_info:{variants},allow_download_status:{allow_download:allow}});
const { parsePostLink,selectMp4 } = globalThis.XReplyPostVideo;

test('帖子链接去掉分享参数，只接受 X 帖子，MP4 只取 X 媒体域中最高码率',()=>{
  assert.deepEqual(parsePostLink('https://twitter.com/i/web/status/123/video/1?s=20'),{id:'123',url:'https://x.com/i/status/123'});
  assert.deepEqual(parsePostLink('x.com/demo/status/123?s=20'),{id:'123',url:'https://x.com/demo/status/123'});
  for (const url of ['https://x.com/home','https://x.com.evil.test/demo/status/123','https://evil.test@x.com/demo/status/123']) {
    assert.equal(parsePostLink(url),null);
  }
  const tweet = {legacy:{extended_entities:{media:[media([variant(high,9000)],false),media([
    variant(low,256000),variant(high,2176000),variant(mediaUrl('playlist.m3u8'),9000000,'application/x-mpegURL'),
    variant('https://video.twimg.com.evil.test/high.mp4',9000000)
  ])]}}};
  assert.equal(selectMp4(tweet),high);
  assert.equal(selectMp4({extended_entities:{media:[media([variant(high,0)],false)]}}),'');
});

test('从原帖正常响应提取指定帖子的视频，忽略回复和引用帖的视频',async()=>{
  const tweet = (id,attachments) => ({rest_id:id,legacy:{id_str:id,user_id_str:'9',full_text:'demo',extended_entities:{media:attachments}}});
  const primary = {...tweet('123',[media([variant(low,256000)])]),quoted_status_result:{result:tweet('321',[media([variant(high,2176000)])])}};
  const payload = {data:{threaded_conversation_with_injections_v2:{instructions:[{entries:[primary,tweet('456',[media([variant(high,2176000)])])].map(result=>({
    content:{itemContent:{tweet_results:{result:{__typename:'TweetWithVisibilityResults',tweet:result}}}}
  }))}]}}};
  const messages = [], listeners = [];
  const location = {origin:'https://x.com',href:'https://x.com/demo/status/123',pathname:'/demo/status/123'};
  const window = {
    fetch:async()=>new Response(JSON.stringify(payload),{headers:{'content-type':'application/json'}}),
    postMessage:message=>messages.push(message),addEventListener:(_name,listener)=>listeners.push(listener)
  };
  const scope = vm.createContext({XReplyContext:globalThis.XReplyContext,XReplyPostVideo:globalThis.XReplyPostVideo,
    XMLHttpRequest:class {open(){} send(){}},window,location,URL,Request,TextDecoder,document:{querySelector:()=>null},
    setTimeout:()=>1,clearTimeout:()=>{}});
  vm.runInContext(await readFile(new URL('../extension/observe.js',import.meta.url),'utf8'),scope);
  for (const listener of listeners) listener({source:window,origin:location.origin,data:{channel:'x-reply-context-v1',type:'READY'}});
  const response = await window.fetch('/i/api/graphql/demo/TweetDetail');
  assert.deepEqual(await response.json(),payload);
  for (let i=0;i<10&&!messages.some(message=>message.type==='POST_VIDEO_MEDIA');i++) await new Promise(resolve=>setImmediate(resolve));
  const found = messages.filter(message=>message.type==='POST_VIDEO_MEDIA');
  assert.deepEqual(found.map(({id,url})=>[id,url]),[['123',low]]);
});

test('复用当前帖子，粘贴其他链接时只加载一次并交给 Chrome 下载',async()=>{
  const created = [], removed = [], saved = [];
  const event = () => ({addListener(){},removeListener(){}});
  const tabs = {
    onActivated:event(),onRemoved:event(),
    sendMessage:async (tabId,{id}) => tabId === 1 && id === '123' || tabId === 2 && id === '456' ? {seen:true,url:high} : {seen:false},
    create:async input=>{created.push(input);return {id:2};},get:async()=>({active:false}),remove:async id=>removed.push(id)
  };
  const downloads = {download:async item=>{saved.push(item);return 1;}};
  const downloader = globalThis.XReplyVideoDownload.create({tabs,downloads});
  assert.deepEqual(await downloader.download({url:'https://x.com/demo/status/123',tabId:1}),{ok:true});
  assert.deepEqual(created,[]);
  assert.deepEqual(await downloader.download({url:'https://twitter.com/demo/status/456?s=20',tabId:1}),{ok:true});
  assert.deepEqual(created,[{url:'https://x.com/demo/status/456',active:false}]);
  assert.deepEqual(removed,[2]);
  assert.deepEqual(saved.map(item=>[item.filename,item.url]),[['X-123.mp4',high],['X-456.mp4',high]]);
});
