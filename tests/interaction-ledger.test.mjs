import test from 'node:test';
import assert from 'node:assert/strict';
import '../extension/core.js';
import '../extension/interaction-ledger.js';
const core=globalThis.XReplyContext,ledger=globalThis.XReplyInteractionLedger;
const now=Date.now();
const tweet=(id,authorId,conversationId=id,parentId='',recipientId='')=>({id,authorId,conversationId,parentId,recipientId,text:'fixture'});
function initial(){const s=core.createState();core.ingest(s,{users:[{id:'1',handle:'me'},{id:'2',handle:'peer'},{id:'3',handle:'third'}],tweets:[tweet('100','1'),tweet('101','2','100','100','1'),tweet('200','2'),tweet('201','1','200','200','2')]},'me',now);return s;}
test('迁移按不同原帖去重，保留历史下限而不相加，原快照不变',()=>{
 const state=initial(),legacy=structuredClone(state);legacy.people['1:2'].myCommentedPosts=8;
 const before=JSON.stringify(state),plan=ledger.migrationPlan(state,legacy,now);
 assert.equal(plan.facts.size,2);assert.equal(plan.people['1:2'].myCommentedPosts,1);assert.equal(plan.people['1:2'].theirCommentedPosts,1);
 assert.equal(plan.people['1:2'].legacyMyLowerBound,8);assert.equal(plan.statistics.incomplete,true);assert.equal(JSON.stringify(state),before);
 Object.assign(state,{people:plan.people,statistics:plan.statistics});
 assert.deepEqual(core.classify(state,'me','101').personStats,{myCommentedPosts:8,theirCommentedPosts:1,incomplete:true});
 assert.equal(core.classify(state,'me','101').newPerson,false);
});
test('帖子未缓存时可按卡片作者读取人物汇总，已缓存帖子优先使用记录的作者',()=>{
 const state=initial();
 const plan=ledger.migrationPlan(state,null,now);
 Object.assign(state,{people:plan.people,statistics:plan.statistics});
 const [uncached]=core.classifyBatch(state,'me',['900'],'peer');
 assert.deepEqual(uncached.personStats,{myCommentedPosts:1,theirCommentedPosts:1,incomplete:true});
 assert.equal(uncached.authorHandle,'peer');
 assert.equal(uncached.origin,'unknown');
 assert.equal(uncached.evidenceId,'');
 const [cached]=core.classifyBatch(state,'me',['101'],'third');
 assert.equal(cached.authorHandle,'peer');
 assert.deepEqual(cached.personStats,uncached.personStats);
 assert.equal(core.classifyBatch(state,'me',['900'],'unknown')[0].personStats,null);
});
test('没有可恢复明细的旧零值仍标记历史不完整，首次评论证据提供至少1而非假零',()=>{
 const state=core.createState();state.people['1:2']={myCommentedPosts:0,theirCommentedPosts:0,firstCommentOnMyPostId:'101',seenAt:now};
 const plan=ledger.migrationPlan(state,null,now);assert.equal(plan.facts.size,0);assert.equal(plan.people['1:2'].legacyTheirLowerBound,1);assert.equal(plan.statistics.incomplete,true);
 assert.equal(ledger.migrationPlan(core.createState(),null,now).statistics.incomplete,false);
});
test('根作者未知不乱计；根作者晚到才产出事实，重复读取不重复入队',()=>{
 const state=core.createState();state.statistics={version:2};
 core.ingest(state,{users:[{id:'1',handle:'me'},{id:'2',handle:'peer'}],tweets:[tweet('102','2','100','101','3')]},'me',now);
 assert.equal(core.interactionChanges(state).facts.size,0);core.saved(state);
 core.ingest(state,{tweets:[tweet('100','1')]},'me',now+1);
 assert.equal(core.interactionChanges(state).facts.size,1);core.saved(state);
 core.ingest(state,{tweets:[tweet('102','2','100','101','3')]},'me',now+2);
 assert.equal(core.interactionChanges(state).facts.size,0);
});
test('评论缺原帖 ID 时可复用本地已确认的原帖索引',()=>{
 const state=core.createState();state.statistics={version:2};
 core.ingest(state,{users:[{id:'1',handle:'me'}],tweets:[tweet('101','3','100','100','1')]},'me',now);
 assert.equal(state.tweets['100'],undefined);
 core.saved(state);
 core.ingest(state,{tweets:[tweet('102','2','','100','1')]},'me',now+1);
 assert.deepEqual([...core.interactionChanges(state).facts.keys()],['1:2:in:100']);
});
test('统计模式在缓存清理前捕获事实，不清理人物汇总；账号与方向独立',()=>{
 const state=initial(),plan=ledger.migrationPlan(state,null,now);Object.assign(state,{people:plan.people,statistics:plan.statistics});core.primeInteractions(state);core.saved(state);
 core.ingest(state,{tweets:[tweet('202','1','200','200','2'),tweet('103','2','100','100','1')]},'me',now+1);
 assert.equal(core.interactionChanges(state).facts.size,0,'同帖重复和较新的评论ID无需重写事实');
 core.ingest(state,{},'me',now+core.RETENTION_MS+10);
 assert.equal(Object.keys(state.tweets).length,0);assert.equal(state.people['1:2'].myCommentedPosts,1);assert.equal(state.people['1:2'].theirCommentedPosts,1);
});
test('迁移事实与人物各受2万上限，溢出标记不完整，不借扩大正文无限加载',()=>{
 const state=core.createState();state.accounts['1']=now;
 for(let i=0;i<core.LIMIT;i++){
  const root=String(1000000+i),reply=String(2000000+i);
  state.tweets[reply]={...tweet(reply,'2',root,root,'1'),seenAt:now};
  const peerRoot=String(3000000+i);state.roots[peerRoot]={id:peerRoot,authorId:'2',seenAt:now};
  state.replies['1:'+peerRoot+':2']={id:String(4000000+i),actorId:'1',conversationId:peerRoot,recipientId:'2',seenAt:now};
 }
 const plan=ledger.migrationPlan(state,null,now);
 assert.equal(plan.facts.size,20000);assert.equal(plan.statistics.atCapacity,true);assert.equal(plan.statistics.incomplete,true);
 assert.ok(Object.keys(plan.people).length<=20000);
});
