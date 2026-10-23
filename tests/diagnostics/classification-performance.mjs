import { performance } from 'node:perf_hooks';
import { mkdir,writeFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { performanceState,fixtureRootId } from './performance-fixture.mjs';
if (process.argv[3]) vm.runInThisContext(execFileSync('git',['show',`${process.argv[3]}:extension/core.js`],{ encoding:'utf8' }));
else await import('../../extension/core.js');
const core = globalThis.XReplyContext;
const now = Date.now();
const state = performanceState(core,now);
const rootId = fixtureRootId;
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
const singleLikeSamples = [];
for (let i = 0; i < 3; i++) {
  const started = performance.now(); core.ingest(state,{ likes:[{ ...likes[0],liked:i%2 === 0,observedAt:now+i+1 }] },'me',now+i+1);
  singleLikeSamples.push(Number((performance.now()-started).toFixed(2)));
}
result.singleLikeMs = singleLikeSamples;
result.singleLikeMedianMs = [...singleLikeSamples].sort((a,b) => a-b)[1];
result.serializedStateBytes = Buffer.byteLength(JSON.stringify(state));
if (process.argv[2]) { await mkdir(path.dirname(process.argv[2]),{ recursive:true }); await writeFile(process.argv[2],JSON.stringify(result,null,2)+'\n'); }
console.log(JSON.stringify(result,null,2));
