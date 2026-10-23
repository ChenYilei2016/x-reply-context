import { performance } from 'node:perf_hooks';
import { mkdir,writeFile } from 'node:fs/promises';
import path from 'node:path';
import '../../extension/core.js';
const core = globalThis.XReplyContext;
const state = core.createState();
const now = Date.now();
const me = '90000000000000000000';
const rootId = index => String(10000000000000000000n+BigInt(index));
for (let i = 0; i < 9999; i++) state.users[String(i+2)] = { id:String(i+2),handle:`u${i}`,seenAt:now };
state.users[me] = { id:me,handle:'me',seenAt:now }; state.accounts[me] = now;
for (let i = 0; i < 10000; i++) {
  const id = rootId(i),authorId = String(i%9999+2);
  state.tweets[id] = { id,authorId,conversationId:id,parentId:'',text:'fixture',seenAt:now };
  state.roots[id] = { id,authorId,seenAt:now };
  const conversationId = rootId(i%9900);
  state.replies[`${me}:${conversationId}:${authorId}`] = {
    id:String(20000000000000000000n+BigInt(i)),actorId:me,recipientId:authorId,conversationId,text:'old reply',seenAt:now
  };
  const likeId = String(30000000000000000000n+BigInt(i));
  state.likes[`${me}:${likeId}`] = { id:likeId,actorId:me,recipientId:authorId,conversationId:id,liked:true,seenAt:now };
}
const ids = Array.from({ length:100 },(_,i) => rootId(9900+i));
const classify = () => core.classifyBatch ? core.classifyBatch(state,'me',ids) : ids.map(id => core.classify(state,'me',id));
classify();
const samples = [];
for (let i = 0; i < 3; i++) { const started=performance.now(); classify(); samples.push(Number((performance.now()-started).toFixed(2))); }
const result = { fixture:true,engine:core.classifyBatch ? 'batch' : 'per-card',users:Object.keys(state.users).length,
  tweets:Object.keys(state.tweets).length,likes:Object.keys(state.likes).length,replies:Object.keys(state.replies).length,
  batchSize:ids.length,samplesMs:samples,medianMs:[...samples].sort((a,b) => a-b)[1] };
const likes = Array.from({ length:500 },(_,i) => ({ id:String(30000000000000000000n+BigInt(i)),
  account:'me',liked:true,observedAt:now,source:'mutation' }));
const ingestSamples = [];
for (let i = 0; i < 3; i++) { const started=performance.now(); core.ingest(state,{ likes },'me',now); ingestSamples.push(Number((performance.now()-started).toFixed(2))); }
result.ingest500LikesMs = ingestSamples;
result.ingestMedianMs = [...ingestSamples].sort((a,b) => a-b)[1];
if (process.argv[2]) { await mkdir(path.dirname(process.argv[2]),{ recursive:true }); await writeFile(process.argv[2],JSON.stringify(result,null,2)+'\n'); }
console.log(JSON.stringify(result,null,2));
