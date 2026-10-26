import test from 'node:test';
import assert from 'node:assert/strict';
import '../extension/core.js';
const core=globalThis.XReplyContext;
const event=(id,liked,at,source='snapshot')=>({id,account:'me',liked,observedAt:at,source});
function seed(now){const s=core.createState();core.ingest(s,{users:[{id:'1',handle:'me'},{id:'2',handle:'peer'}],tweets:[{id:'100',authorId:'2',conversationId:'100',text:'root'},{id:'101',authorId:'1',conversationId:'100',parentId:'100',recipientId:'2',text:'reply'}],likes:[event('100',true,now,'mutation')]},'me',now);return s;}
function browse(s,now){for(let batch=0;batch<20;batch++)core.ingest(s,{likes:Array.from({length:500},(_,i)=>event(String(1000+batch*500+i),false,now+batch))},'me',now+batch);}
test('普通未点赞浏览快照不挤掉真实红心，仍保持10000条上限',()=>{
 const now=Date.now(),s=seed(now);browse(s,now+1);
 assert.equal(s.likes['1:100']?.liked,true);assert.equal(Object.keys(s.likes).length,10000);assert.equal(Object.keys(s.replies).length,1);
});
test('取消证据经过未点赞快照更新后仍保留，旧正快照不能恢复',()=>{
 const now=Date.now(),s=seed(now);
 core.ingest(s,{likes:[event('100',false,now+1,'mutation')]},'me',now+1);
 core.ingest(s,{likes:[event('100',false,now+2)]},'me',now+2);browse(s,now+3);
 assert.equal(s.likes['1:100']?.liked,false);
 core.ingest(s,{likes:[event('100',true,now)]},'me',now+30);assert.equal(s.likes['1:100'].liked,false);
 core.ingest(s,{likes:[event('100',true,now+31,'mutation')]},'me',now+31);assert.equal(s.likes['1:100'].liked,true);
});
test('普通负快照被淘汰后，拒绝更早未知快照，但同批分段及新响应可补齐',()=>{
 const now=Date.now(),s=seed(now);
 core.ingest(s,{likes:[event('500',false,now+1)]},'me',now+1);browse(s,now+2);
 assert.equal(s.likes['1:500'],undefined);
 const floor=s.likeSnapshotFloors?.['1'];assert.ok(floor?.at>=now+1);
 core.ingest(s,{likes:[event('500',true,now)]},'me',now+30);assert.equal(s.likes['1:500'],undefined);
 core.ingest(s,{likes:[event('777',true,floor.at)]},'me',now+31);assert.equal(s.likes['1:777']?.liked,true,'普通快照相同请求时间的后续分批不应被误丢');
 core.ingest(s,{likes:[event('500',true,now+32)]},'me',now+32);assert.equal(s.likes['1:500']?.liked,true);
});
test('持久化形状重载后仍有时间保护，90天过期规则不变',()=>{
 const now=Date.now(),s=seed(now);browse(s,now+1);
 const reloaded=JSON.parse(JSON.stringify(s));core.prepare(reloaded);
 core.ingest(reloaded,{likes:[event('1000',true,now-1)]},'me',now+40);
 assert.notEqual(reloaded.likes['1:1000']?.liked,true);
 core.ingest(reloaded,{},'me',now+core.RETENTION_MS+100);
 assert.equal(Object.keys(reloaded.likes).length,0);
});
test('真实取消证据超容量淘汰后仍保护同时间旧快照，账号之间隔离',()=>{
 const now=Date.now(),s=seed(now);core.ingest(s,{likes:[event('100',false,now+1,'mutation')]},'me',now+1);
 for(let batch=0;batch<20;batch++)core.ingest(s,{likes:Array.from({length:500},(_,i)=>event(String(1000+batch*500+i),true,now+2+batch,'mutation'))},'me',now+2+batch);
 assert.equal(s.likes['1:100'],undefined);
 core.ingest(s,{likes:[event('100',true,now+1)]},'me',now+30);assert.equal(s.likes['1:100'],undefined);
 core.ingest(s,{users:[{id:'3',handle:'other'}],likes:[{id:'100',account:'other',liked:true,source:'snapshot',observedAt:now}]},'other',now+31);
 assert.equal(s.likes['3:100']?.liked,true);
});
