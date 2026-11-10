import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const sources=await Promise.all(['core.js','observe.js'].map(n=>readFile(new URL('../extension/'+n,import.meta.url),'utf8')));
async function observe({transport='fetch',operation='FavoriteTweet',status=200,payload={data:{favorite_tweet:'Done'}},network=false,switchAccount=false,raw=false}={}) {
 const messages=[],listeners=[],timers=[];let account='me',requests=0;
 class Xhr extends EventTarget {
  open(){} send(){requests++;}
  getResponseHeader(){return '60';}
  complete(){this.status=status;this.responseType='json';this.response=payload;this.dispatchEvent(new Event(network?'error':'load'));this.dispatchEvent(new Event('loadend'));}
 }
 const location={origin:'https://x.com',href:'https://x.com/home'};
 const window={postMessage:m=>messages.push(m),addEventListener:(_n,fn)=>listeners.push(fn),fetch:async()=>{
  requests++;if(network)throw Error('offline');
  return new Response(raw?payload:JSON.stringify(payload),{status,headers:{'content-type':'application/json','retry-after':'60'}});
 }};
 const scope=vm.createContext({window,location,URL,Request,TextDecoder,XMLHttpRequest:Xhr,
  document:{querySelector:()=>({getAttribute:()=>'/'+account})},setTimeout:fn=>timers.push(fn),clearTimeout(){}});
 sources.forEach(s=>vm.runInContext(s,scope));listeners.forEach(fn=>fn({source:window,origin:location.origin,data:{channel:'x-reply-context-v1',type:'READY'}}));
 const url=`https://x.com/i/api/graphql/test/${operation}`,body=JSON.stringify({variables:operation.includes('Create')?{reply:{in_reply_to_tweet_id:'123'}}:{tweet_id:'123'}});
 if(transport==='fetch'){const request=window.fetch(url,{method:'POST',body});if(switchAccount)account='other';await request.catch(()=>{});}
 else{const xhr=new Xhr();xhr.open('POST',url);xhr.send(body);if(switchAccount)account='other';xhr.complete();}
 for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r));
 for(const timer of timers)timer();
 return {messages,requests,alerts:messages.filter(m=>m.type==='INTERACTION_ALERT')};
}
for(const transport of ['fetch','xhr']) {
 test(`${transport} 评论及点赞HTTP限流立即提示，含状态/错误/等待，不写成功`,async()=>{
  for(const operation of ['CreateTweet','CreateNoteTweet','FavoriteTweet','UnfavoriteTweet']){
   const result=await observe({transport,operation,status:429,payload:{errors:[{code:88,message:'Rate limit exceeded'}]}});
   assert.equal(result.requests,1);assert.equal(result.alerts.length,1);
   const alert=result.alerts[0];assert.equal(alert.operation,operation);assert.equal(alert.httpStatus,429);assert.equal(alert.code,'88');assert.equal(alert.retryAfter,'60');assert.equal(alert.targetId,'123');
   assert.equal(result.messages.some(m=>m.type==='OBSERVED'),false);
  }
 });
 test(`${transport} HTTP200业务错误、警告、未知回执与网络失败均可见`,async()=>{
  for(const payload of [{errors:[{message:'Action not permitted'}]},{data:{favorite_tweet:'Done'},warnings:[{message:'Please slow down'}]},{}]) {
   const result=await observe({transport,payload});assert.equal(result.alerts.length,1);
   if(payload.warnings){assert.equal(result.alerts[0].reason,'warning');assert.equal(result.messages.find(m=>m.type==='OBSERVED').batch.likes[0].liked,true);assert.equal(result.messages[1].type,'INTERACTION_ALERT');}
   else assert.equal(result.messages.some(m=>m.type==='OBSERVED'),false);
  }
  assert.equal((await observe({transport,network:true})).alerts[0].reason,'network');
 });
 test(`${transport} 正常成功无提示，迟到旧账号错误不串账号`,async()=>{
  assert.equal((await observe({transport})).alerts.length,0);
  assert.equal((await observe({transport,switchAccount:true,status:403})).alerts.length,0);
 });
}
test('畸形或过大错误JSON仍保留HTTP状态，错误摘要有界',async()=>{
 assert.equal((await observe({status:503,payload:'not-json',raw:true})).alerts[0].httpStatus,503);
 const large=await observe({status:429,payload:{errors:[{message:'x'.repeat(70000)}]}});assert.equal(large.alerts[0].message,'');
 const bounded=await observe({payload:{errors:Array.from({length:50},()=>({code:'c'.repeat(300),message:'x'.repeat(500)}))}});
 assert.ok(bounded.alerts[0].message.length<=600);assert.ok(bounded.alerts[0].code.length<=40);
});


test('评论确认成功但有警告时先暂停再保留成功回执，未知评论不入观察记录',async()=>{
 const tweet={rest_id:'999',legacy:{id_str:'999',user_id_str:'1',full_text:'fixture',conversation_id_str:'123',in_reply_to_status_id_str:'123'},core:{user_results:{result:{rest_id:'1',legacy:{screen_name:'me'}}}}};
 const payload={data:{create_tweet:{tweet_results:{result:tweet}}},warnings:[{message:'Please slow down'}]};
 const success=await observe({operation:'CreateTweet',payload});
 assert.equal(success.alerts.length,1);assert.equal(success.alerts[0].reason,'warning');
 const receipt=success.messages.find(m=>m.type==='REPLY_RESULT');assert.equal(receipt.status,'sent');assert.equal(receipt.batch.tweets[0].id,'999');
 assert.ok(success.messages.indexOf(success.alerts[0])<success.messages.indexOf(receipt));
 const unknown=await observe({operation:'CreateTweet',payload:{data:{create_tweet:{tweet_results:{result:{...tweet,legacy:{...tweet.legacy,in_reply_to_status_id_str:'456'}}}}}}});
 assert.equal(unknown.messages.find(m=>m.type==='REPLY_RESULT').status,'unknown');
 assert.equal(unknown.messages.find(m=>m.type==='REPLY_RESULT').replyEvidence,undefined);
 assert.equal(unknown.messages.some(m=>m.type==='OBSERVED'),false);
 const partial=await observe({operation:'CreateTweet',payload:{data:{create_tweet:{errors:[{message:'partial failure'}],tweet_results:{result:tweet}}}}});
 assert.equal(partial.messages.find(m=>m.type==='REPLY_RESULT').status,'unknown');assert.equal(partial.messages.some(m=>m.type==='OBSERVED'),false);
 assert.equal(partial.messages.find(m=>m.type==='REPLY_RESULT').replyEvidence,undefined);
});

test('评论回执缺作者资料仍转交严格匹配的事实，保守保留待确认状态',async()=>{
 const result={rest_id:'999',legacy:{id_str:'999',user_id_str:'1',in_reply_to_status_id_str:'123',conversation_id_str:'123',in_reply_to_user_id_str:'2'}};
 for(const [transport,operation,key] of [['fetch','CreateTweet','create_tweet'],['xhr','CreateNoteTweet','notetweet_create']]){
  const observed=await observe({transport,operation,payload:{data:{[key]:{tweet_results:{result}}}}});
  const receipt=observed.messages.find(message=>message.type==='REPLY_RESULT');
  assert.equal(observed.requests,1);
  assert.equal(receipt.status,'unknown');
  assert.equal(receipt.batch,undefined);
  assert.equal(receipt.replyEvidence?.id,'999');
  assert.equal(receipt.replyEvidence?.authorId,'1');
  assert.equal(receipt.replyEvidence?.parentId,'123');
  assert.equal(observed.alerts.length,1);
 }
});
