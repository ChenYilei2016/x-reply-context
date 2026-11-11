import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const sources=await Promise.all(['ai-config.js','ai-context.js','ai-service.js'].map(name=>readFile(new URL(`../extension/${name}`,import.meta.url),'utf8')));
const config={enabled:true,baseUrl:'https://model.example/v1',apiKey:'test-key',model:'test-model',generatePrompt:'post=${post}',rewritePrompt:'post=${post};draft=${draft}'};
function setup(fetchImpl=async()=>new Response(JSON.stringify({choices:[{message:{content:'<reply>你好。</reply>'}}]}),{headers:{'content-type':'application/json'}}),readThread) {
  let settings=structuredClone(config);const preferences={},changed=[],calls=[];
  const chrome={runtime:{getURL:path=>`chrome-extension://test/${path}`,openOptionsPage:async()=>{}},
    storage:{local:{get:async()=>({aiConfig:settings,...preferences}),set:async next=>{const change={};for(const [key,value] of Object.entries(next)){if(key==='aiConfig')settings=value;else preferences[key]=value;change[key]={newValue:value};}changed.forEach(fn=>fn(change,'local'));}},onChanged:{addListener:fn=>changed.push(fn)}},
    permissions:{contains:async()=>true}};
  const scope=vm.createContext({chrome,fetch:(...args)=>{calls.push(args);return fetchImpl(...args);},URL,Headers,Response,TextDecoder,DOMException,AbortController,setTimeout,clearTimeout});
  sources.forEach(source=>vm.runInContext(source,scope));
  const service=scope.XReplyAIService.create({readThread});
  const sender={id:'test',url:'https://x.com/notifications',tab:{id:1},frameId:0,documentId:'doc1'};
  const request=(id,extra={})=>service.handle({type:'AI_REQUEST',id,kind:'generate',post:'一条帖子',draft:'',...extra},sender);
  return {service,sender,request,calls,chrome,scope};
}
test('自带API请求只发模型地址，模板/输出清理兼容，网页拿不到Key',async()=>{
  const {service,sender,request,calls,chrome,scope}=setup();
  const result=await request('one');assert.equal(result.text,'你好');
  assert.equal(calls[0][0],'https://model.example/v1/chat/completions');
  const sent=JSON.parse(calls[0][1].body);assert.ok(sent.messages[0].content.endsWith('\n\npost=一条帖子'));assert.equal(sent.stream,true);
  assert.equal(calls[0][1].redirect,'error');
  assert.equal((await service.handle({type:'AI_CONFIG_GET'},sender)).ok,false);
  const status=await service.handle({type:'AI_STATUS'},sender);assert.equal(status.apiKey,undefined);
  assert.throws(()=>scope.XReplyAIConfig.endpoint('https://x.com/i/api'),/不能使用/);
  assert.equal(scope.XReplyAIConfig.originPattern(scope.XReplyAIConfig.endpoint('http://localhost:11434/v1')),'http://localhost/*');
  await chrome.storage.local.set({aiConfig:{...config,enabled:false}});
  assert.equal((await request('disabled')).ok,false);assert.equal(calls.length,1);
});
test('生成与改写在提示词顶部读取当下本地时间和时区，不修改已存Prompt',async()=>{
  const {request,calls,scope,service}=setup();
  let clock=Date.parse('2026-11-11T13:05:06Z'),timeZone='Asia/Singapore';
  scope.Date=class extends Date {constructor(...args){super(...(args.length?args:[clock]));}};
  scope.Intl={DateTimeFormat:class extends Intl.DateTimeFormat {
    constructor(locale,options){super(locale,{...options,timeZone});}
  }};
  for (const [kind,stamp,zone,expected] of [
    ['generate','2026-11-11T13:05:06Z','Asia/Singapore','2026年11月11日星期三 GMT+8 21:05:06'],
    ['rewrite','2026-11-12T00:05:06Z','Asia/Singapore','2026年11月12日星期四 GMT+8 08:05:06'],
    ['generate','2026-11-11T13:05:06Z','America/Los_Angeles','2026年11月11日星期三 GMT-8 05:05:06'],
  ]) {
    clock=Date.parse(stamp);timeZone=zone;
    assert.equal((await request('time-'+calls.length,{kind,draft:'草稿'})).ok,true);
    const prompt=JSON.parse(calls.at(-1)[1].body).messages[0].content;
    assert.ok(prompt.startsWith(`<reply_time timezone="${zone}">${expected}</reply_time>\n`));
    assert.match(prompt,/不是帖子发布时间.*问候语和时段表达以此为准/);
    assert.ok(prompt.endsWith(kind==='rewrite'?'\n\npost=一条帖子;draft=草稿':'\n\npost=一条帖子'));
  }
  const saved=await service.handle({type:'AI_CONFIG_GET'},{url:'chrome-extension://test/ai-settings.html'});
  assert.equal(saved.config.generatePrompt,config.generatePrompt);
  assert.equal(saved.config.rewritePrompt,config.rewritePrompt);
});
test('二次润色须单独开启与授权，使用所选模型和首稿',async()=>{
  const {service,sender,request,calls,chrome,scope}=setup();
  const status=()=>service.handle({type:'AI_STATUS'},sender);
  assert.equal((await status()).polishEnabled,false);
  assert.equal((await request('off',{kind:'polish',draft:'首稿'})).ok,false);
  assert.equal(calls.length,0);

  const settings=scope.XReplyAIConfig.normalizeProfiles(config);
  const polish={id:'polish',name:'润色',baseUrl:'https://polish.example/v1',apiKey:'fixture-polish-key',model:'polish-model'};
  settings.profiles.push(polish);
  Object.assign(settings,{polishEnabled:true,polishProfileId:polish.id,polishPrompt:'润色标准 ${draft}'});
  const settingsSender={url:'chrome-extension://test/ai-settings.html'};
  const save=()=>service.handle({type:'AI_CONFIG_SAVE',config:settings},settingsSender);
  let allowPolish=false;
  chrome.permissions.contains=async({origins})=>allowPolish || !origins.includes('https://polish.example/*');
  await assert.rejects(save,/授权模型域名/);
  allowPolish=true;
  assert.equal((await save()).ok,true);
  assert.equal((await status()).polishEnabled,true);

  await request('first-draft');
  const result=await request('polish',{kind:'polish',post:'当前帖 <图>',draft:'首稿 & 问候'});
  assert.equal(result.text,'你好');
  assert.deepEqual(calls.map(([url,options])=>[url,options.headers.Authorization]),[
    ['https://model.example/v1/chat/completions','Bearer test-key'],
    ['https://polish.example/v1/chat/completions','Bearer fixture-polish-key'],
  ]);
  const {model,messages}=JSON.parse(calls[1][1].body);
  assert.equal(model,'polish-model');
  assert.match(messages[0].content,/润色标准 见用户消息中的「待润色回复」/);
  assert.match(messages[1].content,/<current_post>当前帖 &lt;图&gt;<\/current_post>\n<draft_reply>首稿 &amp; 问候<\/draft_reply>/);
});
test('二次润色拒绝半稿，并接受正常结束的 JSON 和流式回复',async()=>{
  let response;
  const {request,chrome}=setup(async()=>response);
  await chrome.storage.local.set({aiConfig:{...config,polishEnabled:true,polishProfileId:'current'}});
  const json=(content,finish_reason)=>new Response(JSON.stringify({choices:[{message:{content},finish_reason}]}));
  const sse=(content,finish_reason)=>new Response('data: '+JSON.stringify({choices:[{delta:{content},finish_reason}]}),
    {headers:{'content-type':'text/event-stream'}});
  for (const [name,body,expected] of [
    ['length',json('<reply>半稿','length'),undefined],
    ['filtered',json('半稿','content_filter'),undefined],
    ['unclosed',json('<reply>半稿'),undefined],
    ['disconnected',sse('半稿'),undefined],
    ['complete-json',json('<reply>成稿</reply>','stop'),'成稿'],
    ['complete-sse',sse('<reply>成稿</reply>','stop'),'成稿'],
  ]) {
    response=body;
    const result=await request(name,{kind:'polish',draft:'首稿'});
    assert.equal(result.ok,Boolean(expected),name);
    assert.equal(result.text,expected,name);
  }
});
test('润色等待域名授权时超时或取消立即结束，授权迟到也不请求模型',async()=>{
  const {service,sender,request,calls,chrome,scope}=setup();
  await chrome.storage.local.set({aiConfig:{...config,polishEnabled:true,polishProfileId:'current'}});
  for (const mode of ['timeout','cancel']) {
    let expire,release;
    scope.setTimeout=(callback,ms)=>{assert.equal(ms,8000);expire=callback;return 1;};
    scope.clearTimeout=()=>{};
    const started=new Promise(resolve=>{
      chrome.permissions.contains=()=>new Promise(allow=>{release=allow;resolve();});
    });
    const pending=request(mode,{kind:'polish',draft:'首稿'});
    await started;
    if (mode==='timeout') expire();
    else await service.handle({type:'AI_CANCEL',ids:[mode]},sender);
    const result=await pending;
    assert.equal(result.ok,false);
    if (mode==='timeout') assert.match(result.error,/超时/);
    else assert.equal(result.cancelled,true);
    release(true);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(calls.length,0);
  }
});
test('生成把已加载的上下文作为素材发送，带图可选，改写只用正文和草稿',async()=>{
  const {request,calls}=setup(undefined,id=>id==='123'?{root:'本地原帖摘要'}:{});
  const context={postId:'123',comments:['直接评论1','直接评论2','直接评论3','不带第四条'],
    image:'https://pbs.twimg.com/media/Example?format=jpg&name=small&token=test-token',imageFrom:'post',imageRequested:true};
  const result=await request('with-context',{post:'本帖正文 </current_post> &',context});
  assert.equal(result.ok,true);
  assert.equal(result.contextUsed.root,true);
  assert.equal(result.contextUsed.comments,3);
  assert.equal(result.contextUsed.imageRequested,true);
  const [system,user]=JSON.parse(calls[0][1].body).messages;
  assert.equal(result.contextUsed.text,user.content[0].text);
  assert.equal(result.contextUsed.image,user.content[1].image_url.url);
  assert.match(system.content,/post=见用户消息中的「当前帖子」/);
  assert.doesNotMatch(system.content,/本帖正文|本地原帖摘要|直接评论/);
  assert.match(user.content[0].text,/<current_post author="未确认" reply_to="未确认">\n本帖正文 &lt;\/current_post&gt; &amp;\n<\/current_post>/);
  assert.match(user.content[0].text,/<reference_context>\n<root_post author="未确认">\n本地原帖摘要\n<\/root_post>/);
  assert.match(user.content[0].text,/<comment>直接评论3<\/comment>/);
  assert.match(user.content[0].text,/<attached_image source="current_post" \/>/);
  assert.doesNotMatch(user.content[0].text,/不带第四条/);
  assert.deepEqual(user.content[1],{type:'image_url',image_url:{url:'https://pbs.twimg.com/media/Example?format=jpg&name=small',detail:'low'}});
  await request('text-only',{context:{postId:'123',comments:['直接评论1']}});
  assert.match(JSON.parse(calls[1][1].body).messages[1].content,/<loaded_comments>\n<comment>直接评论1<\/comment>/);
  await request('rewrite',{kind:'rewrite',draft:'草稿',context});
  assert.equal(JSON.parse(calls[2][1].body).messages[1].content,'开始。');
  assert.equal(calls.length,3);
});
test('后台没有帖子记录时用页面作者，回复对象仍未确认',async()=>{
  const {request}=setup();
  const result=await request('page-author',{account:'fixture_owner',context:{postId:'200',pageAuthor:'对方'}});
  assert.match(result.contextUsed.text,/<current_post author="对方" reply_to="未确认">/);
});
test('用本地帖子关系区分独立发帖、回复我和回复第三人',async()=>{
  const {scope,chrome,calls,sender}=setup();
  let listener;
  Object.assign(chrome.runtime,{id:sender.id,onMessage:{addListener:fn=>{listener=fn;}}});
  Object.assign(scope,{console,importScripts(){},XReplyStorage:{create:()=>({
    load:async()=>scope.XReplyContext.createState(),save:async()=>{}
  })}});
  for (const file of ['core.js','background.js']) {
    vm.runInContext(await readFile(new URL('../extension/'+file,import.meta.url),'utf8'),scope);
  }
  const send=message=>new Promise(resolve=>listener(message,sender,resolve));
  const account='fixture_owner';
  const batch={
    users:[{id:'1',handle:account},{id:'2',handle:'fixture_reply'},{id:'3',handle:'fixture_third'}],
    tweets:[
      {id:'100',authorId:'1',conversationId:'100',text:'等我解封'},
      {id:'101',authorId:'2',conversationId:'100',parentId:'100',text:'会等你哦'},
      {id:'200',authorId:'3',conversationId:'200',text:'第三人的原帖'},
      {id:'201',authorId:'2',conversationId:'200',parentId:'200',recipientId:'3',text:'等你回来'},
    ],
  };
  assert.equal((await send({type:'INGEST',account,batch})).ok,true);
  const original=await send({type:'AI_REQUEST',id:'200',kind:'generate',account,post:'第三人的原帖',draft:'',context:{postId:'200',pageAuthor:'我'}});
  assert.match(original.contextUsed.text,/<current_post author="对方" reply_to="无特定对象">/);
  for (const [id,post,rootOwnership,recipient,author] of [
    ['101','会等你哦','mine','我','我'],['201','等你回来','others','第三人','第三人'],
  ]) {
    const result=await send({type:'AI_REQUEST',id,kind:'generate',account,post,draft:'',rootOwnership,context:{postId:id}});
    assert.equal(result.ok,true);
    assert.ok(result.contextUsed.text.includes('<current_post author="对方" reply_to="'+recipient+'">\n'+post));
    assert.ok(result.contextUsed.text.includes('<root_post author="'+author+'">'));
    assert.ok(!calls.at(-1)[1].body.includes(account));
  }
});
test('仅图片的目标可生成回复，外部或上级图片不能代替当前目标',async()=>{
  const {request,calls}=setup();
  const image='https://pbs.twimg.com/media/Example.jpg';
  assert.equal((await request('photo-only',{post:'',context:{postId:'123',image,imageFrom:'post'}})).ok,true);
  assert.equal((await request('ancestor-only',{post:'',context:{postId:'123',image,imageFrom:'root'}})).ok,false);
  assert.equal((await request('outside-image',{post:'',context:{postId:'123',image:'https://example.test/Example.jpg'}})).ok,false);
  assert.equal(calls.length,1);
});
test('SSE跨片段拼接中文和控制标记，DONE后结束读取，不等连接关闭',async()=>{
  const raw=['<reply>一起加油。<|endo','ftext|></reply>'].map(content=>'data: '+JSON.stringify({choices:[{delta:{content}}]})+'\n\n').join('')+'data: [DONE]\n\n';
  const bytes=new TextEncoder().encode(raw);let cancelled=false;
  const {request}=setup(async()=>new Response(new ReadableStream({start(controller){for(const byte of bytes)controller.enqueue(new Uint8Array([byte]));},cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}}));
  assert.equal((await request('stream')).text,'一起加油');assert.equal(cancelled,true);
});
test('模型空回复和超过自设字符上限分别返回可识别的原因',async()=>{
 let content=null;
 const {request,chrome,scope}=setup(async()=>new Response(JSON.stringify({choices:[{message:{content}}]})));
 assert.equal(scope.XReplyAIConfig.normalizeProfiles(config).maxReplyLength,12000);
 await chrome.storage.local.set({aiConfig:{...config,maxReplyLength:5}});
 assert.equal((await request('empty')).code,'EMPTY_AI_OUTPUT');
 content='<reply>一二三四五六</reply>';
 const tooLong=await request('too-long');
 assert.equal(tooLong.code,'AI_OUTPUT_TOO_LONG');assert.match(tooLong.error,/6.*5/);
 content='<reply>一二三四五。</reply>';
 assert.equal((await request('at-limit')).text,'一二三四五');
 assert.throws(()=>scope.XReplyAIConfig.normalizeProfiles({...config,maxReplyLength:12001}),/最大字符数/);
});
test('模型控制标记在写入草稿和判断字符数前移除',async()=>{
  let content='这得写，岗位名就叫反360工程师了<|endoftext|>';
  const {request,chrome}=setup(async()=>new Response(JSON.stringify({choices:[{message:{content}}]})));
  assert.equal((await request('endoftext-marker')).text,'这得写，岗位名就叫反360工程师了');
  content='<|im_start|>assistant\nA < B | C > D&lt;|eot_id|&gt;<｜end▁of▁sentence｜>';
  assert.equal((await request('preserve-punctuation')).text,'A < B | C > D');
  await chrome.storage.local.set({aiConfig:{...config,maxReplyLength:4}});
  content='<reply>继续<|eot_id|>加油<|reply|></s></reply>';
  assert.equal((await request('wrapped-marker',{kind:'rewrite',draft:'加油'})).text,'继续加油');
  content='<|reply|><|endoftext|>';
  assert.equal((await request('marker-only')).code,'EMPTY_AI_OUTPUT');
  content='加油<|endof';
  const incomplete=await request('incomplete-marker');
  assert.equal(incomplete.ok,false);assert.match(incomplete.error,/控制标记/);assert.equal(incomplete.text,undefined);
});
test('全局最多3个模型请求，取消排队和在途任务，隔离不同标签页',async()=>{
  const {request,service,sender,calls}=setup((_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')),{once:true})));
  const pending=Array.from({length:8},(_,i)=>request(`r-${i}`));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,3);
  await service.handle({type:'AI_CANCEL',ids:['r-0']},{...sender,tab:{id:2}});assert.equal(calls[0][1].signal.aborted,false);
  await service.handle({type:'AI_CANCEL',ids:Array.from({length:8},(_,i)=>`r-${i}`)},sender);
  assert.ok((await Promise.all(pending)).every(result=>result.cancelled));assert.equal(calls.length,3);
});
test('模型等待不阻塞原有CLASSIFY与INGEST队列',async()=>{
  let listener,release;const never=new Promise(resolve=>{release=resolve;});
  const scope=vm.createContext({URL,console,setTimeout,importScripts(){},XReplyAIService:{create:()=>({handle:()=>never})},
    XReplyStorage:{create:()=>({load:async()=>scope.XReplyContext.createState(),save:async()=>{}})},
    chrome:{runtime:{id:'test',getURL:path=>`chrome-extension://test${path}`,onMessage:{addListener:fn=>{listener=fn;}}},storage:{local:{set:async()=>{}}}}});
  vm.runInContext(await readFile(new URL('../extension/core.js',import.meta.url),'utf8'),scope);
  vm.runInContext(await readFile(new URL('../extension/background.js',import.meta.url),'utf8'),scope);
  const send=message=>new Promise(resolve=>listener(message,{id:'test',url:'https://x.com/notifications'},resolve));
  let aiDone=false;const ai=send({type:'AI_REQUEST'}).then(()=>{aiDone=true;});
  assert.equal((await send({type:'INGEST',account:'me',batch:{users:[{id:'1',handle:'me'}]}})).ok,true);
  assert.equal((await send({type:'CLASSIFY',account:'me',ids:['100']})).ok,true);assert.equal(aiDone,false);
  release({ok:true});await ai;
});
test('过载有界且配置变化取消全部旧请求',async()=>{
  const {request,calls,chrome}=setup((_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')),{once:true})));
  const pending=Array.from({length:15},(_,i)=>request(`cap-${i}`));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,3);
  assert.equal((await request('overflow')).ok,false);
  await chrome.storage.local.set({aiConfig:{...config,model:'new-model'}});
  assert.ok((await Promise.all(pending)).every(result=>result.cancelled));assert.equal(calls.length,3);
});
test('超大响应和模型错误返回受控错误，不泄漏服务端正文',async()=>{
  const large=setup(async()=>new Response('x'.repeat(1024*1024+1)));
  assert.match((await large.request('large')).error,/过大/);
  const rejected=setup(async()=>new Response('provider secret',{status:401}));
  const result=await rejected.request('unauthorized',{context:{postId:'123'}});
  assert.equal(result.ok,false);assert.match(result.error,/Key/);assert.ok(!result.error.includes('provider secret'));
  assert.equal(result.contextUsed.text,JSON.parse(rejected.calls[0][1].body).messages[1].content);
});

test('自动补全默认关闭，独立开关不改接口配置或阻止手动生成',async()=>{
  const {service,sender,request,calls,chrome}=setup();
  assert.equal((await service.handle({type:'AI_STATUS'},sender)).autoComplete,false);
  assert.equal((await request('manual')).ok,true);
  await chrome.storage.local.set({aiAutoComplete:true});
  assert.equal((await service.handle({type:'AI_STATUS'},sender)).autoComplete,true);
  await chrome.storage.local.set({aiAutoComplete:false});
  assert.equal((await service.handle({type:'AI_STATUS'},sender)).autoComplete,false);
  assert.equal((await request('manual-again')).ok,true);assert.equal(calls.length,2);
});

test('为你推荐自动填入默认关闭，与灰字补全独立',async()=>{
  const {service,sender,chrome}=setup();
  const status=()=>service.handle({type:'AI_STATUS'},sender);
  assert.equal((await status()).fillRecommended,false);
  await chrome.storage.local.set({aiFillRecommended:true});
  const enabled=await status();
  assert.equal(enabled.fillRecommended,true);
  assert.equal(enabled.autoComplete,false);
});


test('原帖归属变量在生成与改写中替换，未知值不猜测，不递归展开正文',async()=>{
 const {request,calls,chrome}=setup();
 const template='${rootOwnership}|${post}|${draft}';
 await chrome.storage.local.set({aiConfig:{...config,generatePrompt:template,rewritePrompt:template}});
 for(const [origin,label] of [['mine','我的原帖'],['others','别人的原帖'],['unknown','待确认'],[undefined,'待确认'],['constructor','待确认']]) {
  for(const kind of ['generate','rewrite']) {
   await request('case-'+calls.length,{kind,rootOwnership:origin,post:'正文${rootOwnership}',draft:'草稿'});
   assert.ok(JSON.parse(calls.at(-1)[1].body).messages[0].content.endsWith('\n\n'+label+'|正文${rootOwnership}|'+(kind==='rewrite'?'草稿':'')));
  }
 }
});

test('保存多组配置切换后取消旧任务，只向新接口发送新Key；配置不暴露给网页',async()=>{
 let first=true;
 const {service,sender,request,calls,scope}=setup((_url,options)=>{
  if(first){first=false;return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')),{once:true}));}
  return Promise.resolve(new Response(JSON.stringify({choices:[{message:{content:'<reply>新配置回复</reply>'}}]}),{headers:{'content-type':'application/json'}}));
 });
 const settingsSender={url:'chrome-extension://test/ai-settings.html'};
 const old=request('old-config');await new Promise(resolve=>setImmediate(resolve));
 const saved=(await service.handle({type:'AI_CONFIG_GET'},settingsSender)).config;
 saved.profiles.find(p=>p.id==='openai').apiKey='fixture-openai-key';saved.activeProfileId='openai';
 assert.equal((await service.handle({type:'AI_CONFIG_SAVE',config:saved},settingsSender)).ok,true);
 assert.equal((await old).cancelled,true);assert.equal(calls[0][1].signal.aborted,true);
 assert.equal((await request('new-config')).text,'新配置回复');
 assert.equal(calls[1][0],'https://api.openai.com/v1/chat/completions');
 assert.equal(calls[1][1].headers.Authorization,'Bearer fixture-openai-key');
 assert.equal(JSON.parse(calls[1][1].body).model,'gpt-6-luna');assert.equal('temperature' in JSON.parse(calls[1][1].body),false);
 assert.equal((await service.handle({type:'AI_CONFIG_GET'},sender)).ok,false);
 const status=await service.handle({type:'AI_STATUS'},sender);assert.equal(status.profiles,undefined);assert.equal(status.apiKey,undefined);
 assert.equal((await service.handle({type:'AI_CONFIG_GET'},settingsSender)).config.profiles[0].apiKey,config.apiKey);
});

test('OpenAI按配置传快速或标准模式，默认省略；第三方不携带service_tier',async()=>{
 const {request,calls,chrome,scope}=setup();
 const base=scope.XReplyAIConfig.normalizeProfiles(config);
 for(const [baseUrl,tier,expected] of [
  ['https://api.openai.com/v1','fast','fast'],['https://api.openai.com/v1','default','default'],
  ['https://api.openai.com/v1','auto',undefined],['https://other.example/v1','fast',undefined],
  ['https://api.openai.com.evil.example/v1','fast',undefined]]) {
  await chrome.storage.local.set({aiConfig:{...base,profiles:base.profiles.map(p=>p.id===base.activeProfileId?{...p,baseUrl,serviceTier:tier}:p)}});
  await request('tier-'+calls.length);
  const body=JSON.parse(calls.at(-1)[1].body);
  assert.equal(body.service_tier,expected);
  if(expected===undefined)assert.equal(Object.hasOwn(body,'service_tier'),false);
  assert.equal(body.temperature,baseUrl==='https://api.openai.com/v1'?undefined:1.2);
 }
 assert.equal(calls.length,5,'每次手动请求只有一次，不重试或探测接口');
});

test('状态读取提供逐字间隔，不将本地填入配置发送给模型',async()=>{
 const {request,service,sender,chrome,calls}=setup();
 assert.equal((await service.handle({type:'AI_STATUS'},sender)).typingDelayMax,100);
 await chrome.storage.local.set({aiConfig:{...config,typingDelayMin:55,typingDelayMax:95}});
 const status=await service.handle({type:'AI_STATUS'},sender);
 assert.equal(status.typingDelayMin,55);assert.equal(status.typingDelayMax,95);
 await request('typing-config');const body=JSON.parse(calls[0][1].body);
 assert.equal('typingDelayMin' in body,false);assert.equal('typingDelayMax' in body,false);
});

test('OpenAI生成和改写发送选定reasoning_effort，默认/第三方省略且失败不重试',async()=>{
 const {request,calls,chrome,scope}=setup();
 const base=scope.XReplyAIConfig.normalizeProfiles(config);
 const settings=(baseUrl,effort)=>({...base,profiles:base.profiles.map(p=>p.id===base.activeProfileId?{...p,baseUrl,reasoningEffort:effort}:p)});
 for(const effort of ['auto','none','minimal','low','medium','high','xhigh','max']){
  await chrome.storage.local.set({aiConfig:settings('https://api.openai.com/v1',effort)});
  for(const kind of ['generate','rewrite']){
   assert.equal((await request('effort-'+calls.length,{kind,draft:'草稿'})).ok,true);
   const body=JSON.parse(calls.at(-1)[1].body);
   assert.equal(body.reasoning_effort,effort==='auto'?undefined:effort);
   assert.equal(Object.hasOwn(body,'reasoning_effort'),effort!=='auto');
  }
 }
 await chrome.storage.local.set({aiConfig:settings('https://other.example/v1','high')});
 await request('other');assert.equal(Object.hasOwn(JSON.parse(calls.at(-1)[1].body),'reasoning_effort'),false);
 assert.equal(calls.length,17);
 const rejected=setup(async()=>new Response('unsupported effort',{status:400}));
 await rejected.chrome.storage.local.set({aiConfig:settings('https://api.openai.com/v1','max')});
 assert.equal((await rejected.request('unsupported')).ok,false);assert.equal(rejected.calls.length,1);
});
