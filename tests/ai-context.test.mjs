import test from 'node:test';
import assert from 'node:assert/strict';
import '../extension/ai-context.js';
import '../extension/observe-media.js';

test('本页缓存只选目标的直接评论，优先附目标图片并隔离切换账号',()=>{
  const cache=globalThis.XReplyAIContext.create();
  const image='https://pbs.twimg.com/media/Photo.jpg';
  cache.observe('',{id:'100',text:'原帖',conversationId:'100',aiPhoto:image});
  cache.observe('me',{id:'101',parentId:'100',conversationId:'100',text:'上一级'});
  cache.observe('me',{id:'102',parentId:'101',conversationId:'100',text:'当前帖子'});
  cache.observe('me',{id:'103',parentId:'100',conversationId:'100',text:'另一个分支'});
  for (let i=1;i<=5;i++) cache.observe('me',{id:String(110+i),parentId:'102',conversationId:'100',text:`直接回复${i}`});
  const before=cache.read('me','102',false);
  assert.deepEqual(before.comments,['直接回复1','直接回复2','直接回复3']);
  assert.equal(before.parent,'上一级');
  assert.equal(before.image,'');
  assert.equal(cache.read('me','102',true).imageFrom,'root');
  const displayed = 'https://pbs.twimg.com/media/Displayed.jpg';
  const fromPage = cache.read('me','102',true,()=>displayed);
  assert.equal(fromPage.image,displayed);
  assert.equal(fromPage.imageFrom,'post');
  cache.observe('me',{id:'102',aiPhoto:image});
  const unexpectedPageRead = () => assert.fail('无需从页面取图');
  assert.equal(cache.read('me','102',true,unexpectedPageRead).imageFrom,'post');
  assert.equal(cache.read('me','102',false,unexpectedPageRead).image,'');
  cache.observe('me',{id:'102',aiPhoto:null});
  assert.equal(cache.read('me','102',true,unexpectedPageRead).imageFrom,'root');
  assert.equal(cache.read('me','101',false).root,'原帖');
  const afterSwitch = cache.read('other','102',true,()=>displayed);
  assert.deepEqual(afterSwitch.comments,[]);
  assert.equal(afterSwitch.parent,undefined);
  assert.equal(afterSwitch.image,displayed);
  cache.observe('other',{id:'102',text:'新账号当前帖'});
  assert.deepEqual(cache.read('other','102',true).comments,[]);
  assert.equal(cache.read('other','102',true).image,'');
});

test('只读取帖子照片，跳过视频封面和受保护作者的媒体',()=>{
  const {photoFromTweet}=globalThis.XReplyObserveMedia;
  const photo={type:'photo',media_url_https:'https://pbs.twimg.com/media/Example.jpg'};
  const legacy={extended_entities:{media:[{...photo,type:'video'},photo]}};
  assert.equal(photoFromTweet({legacy}),photo.media_url_https);
  assert.equal(photoFromTweet({legacy,core:{user_results:{result:{privacy:{protected:true}}}}}),null);
  assert.equal(photoFromTweet(legacy),'');
  assert.equal(photoFromTweet(legacy,{protected:false}),photo.media_url_https);
  assert.equal(photoFromTweet(legacy,{protected:true}),null);
});

test('图片还在加载时使用当前帖已设置的照片地址',()=>{
  const {photoFromArticle} = globalThis.XReplyAIContext;
  const article = {isConnected:true,querySelector:()=>null,querySelectorAll:()=>images};
  const image = (postId,src,currentSrc) => ({
    complete:false,naturalWidth:0,currentSrc,
    getAttribute:name=>name === 'src' ? src : null,
    closest:selector=>{
      if (selector === 'article[data-testid="tweet"]') return article;
      if (selector === 'a[href]') return {getAttribute:()=>`/author/status/${postId}/photo/1`};
      return null;
    }
  });
  const current = 'https://pbs.twimg.com/media/Current?format=jpg&name=medium';
  const previous = 'https://pbs.twimg.com/media/Previous.jpg';
  const images = [image('101',previous,previous),image('102',current,previous)];
  assert.equal(photoFromArticle(article,'102'),current);
  assert.equal(photoFromArticle(article,'103'),'');
});
