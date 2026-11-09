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
  const sent=JSON.parse(calls[0][1].body);assert.equal(sent.messages[0].content,'post=一条帖子');assert.equal(sent.stream,true);
  assert.equal(calls[0][1].redirect,'error');
  assert.equal((await service.handle({type:'AI_CONFIG_GET'},sender)).ok,false);
  const status=await service.handle({type:'AI_STATUS'},sender);assert.equal(status.apiKey,undefined);
  assert.throws(()=>scope.XReplyAIConfig.endpoint('https://x.com/i/api'),/不能使用/);
  assert.equal(scope.XReplyAIConfig.originPattern(scope.XReplyAIConfig.endpoint('http://localhost:11434/v1')),'http://localhost/*');
  await chrome.storage.local.set({aiConfig:{...config,enabled:false}});
  assert.equal((await request('disabled')).ok,false);assert.equal(calls.length,1);
});
test('生成把已加载的上下文作为素材发送，带图可选，改写只用正文和草稿',async()=>{
  const {request,calls}=setup(undefined,id=>id==='123'?{root:'本地原帖摘要'}:{});
  const context={postId:'123',comments:['直接评论1','直接评论2','直接评论3','不带第四条'],
    image:'https://pbs.twimg.com/media/Example?format=jpg&name=small&token=test-token',imageFrom:'post'};
  const result=await request('with-context',{post:'本帖正文',context});
  assert.equal(result.ok,true);
  assert.equal(result.contextUsed.root,true);
  assert.equal(result.contextUsed.comments,3);
  assert.equal(result.contextUsed.image,true);
  const [system,user]=JSON.parse(calls[0][1].body).messages;
  assert.match(system.content,/post=见用户消息中的「当前帖子」/);
  assert.doesNotMatch(system.content,/本帖正文|本地原帖摘要|直接评论/);
  assert.match(user.content[0].text,/当前帖子\n本帖正文[\s\S]+原帖\n本地原帖摘要[\s\S]+直接评论3/);
  assert.doesNotMatch(user.content[0].text,/不带第四条/);
  assert.deepEqual(user.content[1],{type:'image_url',image_url:{url:'https://pbs.twimg.com/media/Example?format=jpg&name=small',detail:'low'}});
  await request('text-only',{context:{postId:'123',comments:['直接评论1']}});
  assert.match(JSON.parse(calls[1][1].body).messages[1].content,/已加载的评论\n- 直接评论1/);
  await request('rewrite',{kind:'rewrite',draft:'草稿',context});
  assert.equal(JSON.parse(calls[2][1].body).messages[1].content,'开始。');
  assert.equal(calls.length,3);
});
test('仅图片的目标可生成回复，外部或上级图片不能代替当前目标',async()=>{
  const {request,calls}=setup();
  const image='https://pbs.twimg.com/media/Example.jpg';
  assert.equal((await request('photo-only',{post:'',context:{postId:'123',image,imageFrom:'post'}})).ok,true);
  assert.equal((await request('ancestor-only',{post:'',context:{postId:'123',image,imageFrom:'root'}})).ok,false);
  assert.equal((await request('outside-image',{post:'',context:{postId:'123',image:'https://example.test/Example.jpg'}})).ok,false);
  assert.equal(calls.length,1);
});
test('SSE按字节断开中文仍完整，DONE后结束读取，不等连接关闭',async()=>{
  const raw='data: '+JSON.stringify({choices:[{delta:{content:'<reply>一起加油。</reply>'}}]})+'\n\ndata: [DONE]\n\n';
  const bytes=new TextEncoder().encode(raw);let cancelled=false;
  const {request}=setup(async()=>new Response(new ReadableStream({start(controller){for(const byte of bytes)controller.enqueue(new Uint8Array([byte]));},cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}}));
  assert.equal((await request('stream')).text,'一起加油');assert.equal(cancelled,true);
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
  const result=await rejected.request('unauthorized');assert.equal(result.ok,false);assert.match(result.error,/Key/);assert.ok(!result.error.includes('provider secret'));
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
   assert.equal(JSON.parse(calls.at(-1)[1].body).messages[0].content,label+'|正文${rootOwnership}|'+(kind==='rewrite'?'草稿':''));
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
