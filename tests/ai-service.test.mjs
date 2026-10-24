import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const sources=await Promise.all(['ai-config.js','ai-service.js'].map(name=>readFile(new URL(`../extension/${name}`,import.meta.url),'utf8')));
const config={enabled:true,baseUrl:'https://model.example/v1',apiKey:'test-key',model:'test-model',generatePrompt:'post=${post}',rewritePrompt:'post=${post};draft=${draft}'};
function setup(fetchImpl=async()=>new Response(JSON.stringify({choices:[{message:{content:'<reply>你好。</reply>'}}]}),{headers:{'content-type':'application/json'}})) {
  let settings=structuredClone(config),autoComplete;const changed=[];const calls=[];
  const chrome={runtime:{getURL:path=>`chrome-extension://test/${path}`,openOptionsPage:async()=>{}},
    storage:{local:{get:async()=>({aiConfig:settings,aiAutoComplete:autoComplete}),set:async next=>{const change={};if('aiConfig' in next){settings=next.aiConfig;change.aiConfig={newValue:settings};}if('aiAutoComplete' in next){autoComplete=next.aiAutoComplete;change.aiAutoComplete={newValue:autoComplete};}changed.forEach(fn=>fn(change,'local'));}},onChanged:{addListener:fn=>changed.push(fn)}},
    permissions:{contains:async()=>true}};
  const scope=vm.createContext({chrome,fetch:(...args)=>{calls.push(args);return fetchImpl(...args);},URL,Headers,Response,TextDecoder,DOMException,AbortController,setTimeout,clearTimeout});
  sources.forEach(source=>vm.runInContext(source,scope));
  const service=scope.XReplyAIService.create();
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
