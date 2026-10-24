// Local synthetic state only. Optional Git ref compares the same workload with an earlier implementation.
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import vm from 'node:vm';
import {performanceState,fixtureRootId} from './performance-fixture.mjs';
const source=process.argv[2]?execFileSync('git',['show',`${process.argv[2]}:extension/core.js`],{encoding:'utf8'}):await readFile(new URL('../../extension/core.js',import.meta.url),'utf8');
const scope=vm.createContext({});vm.runInContext(source,scope);const core=scope.XReplyContext;
const now=Date.now(),state=performanceState(core,now),tweet=state.tweets[fixtureRootId(0)],user=state.users['2'];
core.classify(state,'me',tweet.id);core.saved(state);
const samples=[];
for(let i=1;i<=10;i++){
 const start=performance.now();core.ingest(state,{users:[user],tweets:[tweet]},'me',now+i);core.classify(state,'me',tweet.id);samples.push(performance.now()-start);core.saved(state);
}
console.log(JSON.stringify({synthetic:true,ref:process.argv[2]||'worktree',samplesMs:samples,minMs:Math.min(...samples),maxMs:Math.max(...samples),meanMs:samples.reduce((a,b)=>a+b,0)/samples.length},null,2));
