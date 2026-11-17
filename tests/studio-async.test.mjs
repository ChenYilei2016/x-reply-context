import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const studio=await readFile(new URL('../extension/creation/studio.js',import.meta.url),'utf8');
// Exercise the real orchestration with delayed responses; no production test-only hooks.
const functions=[
 ['findAngles','  /** 本次生成的任务'],['generate','  /** 编辑区输入'],
 ['revise','  function undoRevise'],['writeImagePrompt','  /** 生图：']
].map(([name,end])=>{const start=studio.indexOf(`  async function ${name}(`);return studio.slice(start,studio.indexOf(end,start));}).join('\n');
function setup(){
 let resolve,signature='source-A',imageText='old body',saves=0;const messages=[];
 const state={candidates:[{text:'原稿',original:'原稿',history:[]}],candidateIndex:0,angles:[],references:[],imageStyle:'news',imageRatio:'1:1',imagePrompt:'原配图提示词'};
 const scope=vm.createContext({state,ai:{pending:null,request:()=>new Promise(r=>resolve=r)},readySources:async()=>[{prompt:{text:'A'}}],sources:{signature:()=>signature},
  confirm:()=>true,generation:()=>({task:'drafts',input:{},approach:{mode:'angle'},label:'test'}),currentBenchmark:()=>null,currentFormat:()=>({label:'短文'}),
  currentCandidate:()=>state.candidates[state.candidateIndex],settings:{persona:()=>''},promptSources:()=>[],ReviseAction:{from:()=>({id:'short',label:'更短'})},
  REVISE_HISTORY:5,reviseModel:{parse:()=> '精修稿'},draftModel:{parse:()=>[{text:'新生成稿'}]},
  store:{referencePosts:async()=>[]},clusterMaterials:x=>x,model:{velocity:()=>0},prompt:{checkReferences:x=>x,toPromptReference:x=>x},
  angleModel:{parse:()=>({angles:[{coverage:'new'}],dropped:0}),assess:x=>x},AngleCoverage:{COVERED:{id:'covered'}},
  imageSourceText:()=>imageText,fingerprint:x=>x,saveSession:async()=>saves++,render(){},$:()=>({value:''}),setStatus:(text,error)=>messages.push({text,error})});
 vm.runInContext(functions,scope);
 return {state,messages,get saves(){return saves;},run:name=>vm.runInContext(`${name}()`,scope),resolve:()=>resolve('fixture result'),changeSource:()=>signature='source-B',changeImage:()=>imageText='edited body'};
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
test('成稿正常返回可采用；等待期间改正文或素材时不覆盖、不误标新来源',async()=>{
 for(const change of ['none','text','source']){
  const env=setup(),running=env.run('generate');await tick();
  if(change==='text')env.state.candidates[0].text='我在等待中写的新稿';
  if(change==='source')env.changeSource();
  env.resolve();await running;
  if(change==='none'){assert.equal(env.state.candidates[0].text,'新生成稿');assert.equal(env.state.candidatesSignature,'source-A');}
  else {assert.equal(env.saves,0);assert.match(env.messages.at(-1).text,/未覆盖/);assert.equal(env.state.candidates[0].text,change==='text'?'我在等待中写的新稿':'原稿');}
 }
});
test('旧角度、旧精修和旧配图提示词均不能覆盖等待期间改变的内容',async()=>{
 for(const name of ['findAngles','revise','writeImagePrompt']){
  const env=setup(),running=env.run(name);await tick();
  if(name==='findAngles')env.changeSource();
  else if(name==='revise')env.state.candidates[0].text='手工修改';
  else env.changeImage();
  env.resolve();await running;
  assert.equal(env.saves,0);assert.equal(env.messages.at(-1).error,true);
  assert.equal(env.state.angles.length,0);assert.equal(env.state.imagePrompt,'原配图提示词');
  if(name==='revise')assert.equal(env.state.candidates[0].text,'手工修改');
 }
});
test('创作模型状态读取期间就占用任务，取消后迟到状态不继续发模型请求',async()=>{
 let resolveStatus,count=0;const calls=[];
 const scope=vm.createContext({crypto:{randomUUID:()=>String(++count)},chrome:{runtime:{sendMessage:async message=>{
  calls.push(message);
  if(message.type==='AI_STUDIO_STATUS')return new Promise(resolve=>resolveStatus=resolve);
  return {ok:true};
 }}}});
 vm.runInContext(await readFile(new URL('../extension/creation/model-client.js',import.meta.url),'utf8'),scope);
 const client=scope.XReplyModelClient.create(),running=client.request('drafts',{});
 assert.ok(client.pending);await assert.rejects(client.request('drafts',{}),/上一个请求/);
 assert.equal(client.cancel(),true);
 resolveStatus({ok:true,tasks:{drafts:'drafts'},steps:[{id:'drafts',configured:true,permitted:true}]});
 assert.equal(await running,null);assert.equal(calls.some(message=>message.type==='AI_REQUEST'),false);
});
