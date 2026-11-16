// Offline UI fixture. Model responses, news and extension storage are simulated.
(() => {
  const banner=document.createElement('p');banner.id='fixture-status';banner.textContent='离线验证 · 模拟新闻和模型 · 不请求外网';document.querySelector('.topbar').after(banner);
  const controls=document.createElement('div');controls.innerHTML='<label><input type="checkbox" id="fixture-fail-model"> 模拟模型失败</label><label><input type="checkbox" id="fixture-slow"> 延迟返回 3 秒</label><label><input type="checkbox" id="fixture-fail-source"> 模拟来源 503</label>';
  document.querySelector('.sidebar-footer').append(controls);
  const changes=[],pending=new Map();let permitted=localStorage.getItem('creationFixturePermission')==='yes';
  const data=JSON.parse(localStorage.getItem('creationFixtureData') || '{}');
  const save=()=>localStorage.setItem('creationFixtureData',JSON.stringify(data));
  globalThis.chrome={storage:{local:{get:async key=>({[key]:structuredClone(data[key])}),set:async values=>{Object.assign(data,structuredClone(values));save();}},onChanged:{addListener:fn=>changes.push(fn)}},
    permissions:{contains:async()=>permitted,request:async()=>{permitted=true;localStorage.setItem('creationFixturePermission','yes');return true;}},
    runtime:{sendMessage:async message=>{
      if(message.type==='AI_CREATION_STATUS')return {ok:true,configured:true,permitted:true,name:'离线模型',model:'fixture',origin:'https://model.example/*'};
      if(message.type==='AI_CANCEL'){for(const id of message.ids)pending.get(id)?.();return {ok:true};}
      if(message.type==='AI_REQUEST')return new Promise(resolve=>{
        document.getElementById('fixture-status').textContent=`离线验证 · 实际传入 ${message.materials.length} 篇素材 · ${message.action}`;
        const timer=setTimeout(()=>{pending.delete(message.id);resolve(document.getElementById('fixture-fail-model').checked?{ok:false,error:'模拟模型连接失败，原草稿保留。'}:
          {ok:true,text:message.action==='angles'?'1. 实际用途：关注开发者如何减少重复工作\n素材依据：公开了新工具的功能说明':'工具又多了一个，但我更关心它能省掉哪一步重复操作。\n\n先看清能做什么、有什么限制，再决定要不要换掉手里的流程。'});},document.getElementById('fixture-slow').checked?3000:100);
        pending.set(message.id,()=>{clearTimeout(timer);resolve({ok:false,cancelled:true});pending.delete(message.id);});
      });
      throw new Error('Unexpected offline request');
    }}};
  const body='这是用于验证创作工作台的模拟新闻正文。产品更新增加了文档整理功能，公开介绍了功能范围与使用限制。'.repeat(12);
  const excerpt='这是模拟新闻摘要，介绍了一项工具更新，具体细节应以原文为准。'.repeat(4);
  globalThis.fetch=async(url,{signal}={})=>{
    if(signal?.aborted)throw new DOMException('Aborted','AbortError');
    if(document.getElementById('fixture-fail-source').checked)return new Response('',{status:503});
    const source=XReplyCreationNews.sources.find(source=>source.hosts.includes(new URL(url).hostname));
    if(!source)throw new Error('Blocked external fixture request');
    if(url===source.feed)return new Response('<rss><channel>'+Array.from({length:4},(_,i)=>`<item><title>${source.name} · 模拟新闻 ${i+1}</title><link>https://${source.hosts[0]}/test/${i}</link><pubDate>Mon, 16 Nov 2026 08:00:00 GMT</pubDate><description><![CDATA[<p>${source.id==='ithome'?body:excerpt}</p>]]></description></item>`).join('')+'</channel></rss>');
    return new Response(`<html><body><div id="paragraph" class="article-body">${body}</div></body></html>`);
  };
  const source=XReplyCreationNews.sources[0];
  try {
    const parsed=XReplyCreationNews.parseFeed('<rss><channel><item><title>安全 &amp; 标题</title><link>https://www.ithome.com/test</link><description><![CDATA[<p>正文</p><script>throw new Error("bad")</script>]]></description></item><item><title>外部链接</title><link>https://evil.example/a</link></item></channel></rss>',source);
    if(parsed.length!==1 || parsed[0].title!=='安全 & 标题' || parsed[0].text!=='正文')throw new Error('RSS parsing assertion failed');
    if(XReplyCreationNews.articleText('<div id="paragraph">'+body+'</div>',source).length<300)throw new Error('Article parser failed');
    banner.dataset.parserTests='passed';
  } catch(error) {banner.textContent=error.message;banner.dataset.parserTests='failed';}
})();
