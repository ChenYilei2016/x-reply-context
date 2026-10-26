import { performanceState } from './diagnostics/performance-fixture.mjs';
const output = document.querySelector('#result');
const core = globalThis.XReplyContext;
const name = 'x-reply-context-records';
const waitRequest = request => new Promise((resolve,reject) => {
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
document.querySelector('#run').addEventListener('click',async event => {
  event.target.disabled = true; output.textContent = '正在验证…'; output.dataset.result = 'running';
  const checks = []; const connections = [];
  const originalOpen = indexedDB.open.bind(indexedDB);
  const originalPut = IDBObjectStore.prototype.put;
  let measure = false; let abortWrite = false; let writes = [];
  const metrics = {};
  const check = (label,ok) => { checks.push({ label,ok }); if (!ok) throw new Error(label); };
  try {
    await waitRequest(indexedDB.deleteDatabase(name));
    indexedDB.open = (...args) => {
      const request = originalOpen(...args);
      request.addEventListener('success',() => connections.push(request.result));
      return request;
    };
    IDBObjectStore.prototype.put = function(value,...args) {
      if (measure) writes.push({ store:this.name,bytes:JSON.stringify(value).length });
      const request = Reflect.apply(originalPut,this,[value,...args]);
      if (abortWrite && this.name === 'likes') { abortWrite = false; this.transaction.abort(); }
      return request;
    };
    const now = Date.now(); const legacy = performanceState(core,now);
    let legacyReads = 0;
    globalThis.chrome = { storage:{ local:{ get:async () => { legacyReads++; return { replyContext:structuredClone(legacy) }; } } } };
    const storage = globalThis.XReplyStorage.create();
    let started = performance.now();
    const state = await storage.load();
    metrics.migrationMs = performance.now()-started;
    check('迁移保留原记录且各表有界',state.version === 1 && Object.keys(state.likes).length === 10000 && Object.keys(state.people).length > 0);
    const key = Object.keys(state.likes)[0]; const likeId = state.likes[key].id;
    measure = true;
    started = performance.now();
    core.ingest(state,{ likes:[{ id:likeId,account:'me',liked:false,observedAt:now+1,source:'mutation' }] },'me',now+1);
    metrics.singleLikeComputeMs = performance.now()-started;
    started = performance.now(); await storage.save(state); metrics.singleLikeSaveMs = performance.now()-started;
    metrics.singleLikeWrites = writes;
    check('一个红心只写一条红心和小元数据',writes.length === 2 && writes.some(row => row.store === 'likes') && writes.some(row => row.store === 'metadata'));
    measure = false;
    started = performance.now(); const reopened = await globalThis.XReplyStorage.create().load();
    metrics.coldReadMs = performance.now()-started;
    check('重开数据库恢复新红心，不重新迁移旧快照',!reopened.likes[key].liked && legacyReads === 1 && legacy.likes[key].liked);
    core.ingest(state,{ likes:[{ id:likeId,account:'me',liked:true,observedAt:now+2,source:'mutation' }] },'me',now+2);
    abortWrite = true;
    let failed = false;
    try { await storage.save(state); } catch { failed = true; }
    const afterFailure = await globalThis.XReplyStorage.create().load();
    check('事务中断不留下半份记录',failed && !afterFailure.likes[key].liked);
    await storage.save(state);
    check('失败后下一次保存仍可补齐未落盘修改',(await globalThis.XReplyStorage.create().load()).likes[key].liked);
    core.ingest(state,{ tweets:[{ id:likeId,authorId:'2',conversationId:likeId,parentId:'',recipientId:'',text:'迟到的原帖' }] },'me',now+3);
    await storage.save(state);
    check('帖子晚到时红心关系也能增量持久化',(await globalThis.XReplyStorage.create().load()).likes[key].conversationId === likeId);
    // A discarded negative snapshot's watermark must survive worker/database reopen.
    core.ingest(state,{likes:[{id:'555',account:'me',liked:false,observedAt:now+4,source:'snapshot'}]},'me',now+4);
    await storage.save(state);
    const guarded=await globalThis.XReplyStorage.create().load();core.prepare(guarded);
    const actor=core.findAccount(guarded,'me').id;
    check('普通负快照不能挤掉满量的真实红心',!guarded.likes[actor+':555'] && Object.keys(guarded.likes).length===10000);
    check('旧快照时间保护与真实红心同时持久化',guarded.likeSnapshotFloors?.[actor]?.at===now+4 && guarded.likes[key].interactionEvidence===true);
    core.ingest(guarded,{likes:[{id:'555',account:'me',liked:true,observedAt:now+3,source:'snapshot'}]},'me',now+5);
    check('重开后迟到旧正快照仍不能误恢复',!guarded.likes[actor+':555']);
    const result = { fixture:true,checks,metrics };
    output.dataset.evidence = JSON.stringify(result);
    output.dataset.result = 'passed'; output.textContent = JSON.stringify(result,null,2);
  } catch(error) {
    output.dataset.result = 'failed'; output.textContent = JSON.stringify({ checks,error:error.message,stack:error.stack },null,2);
  } finally {
    indexedDB.open = originalOpen; IDBObjectStore.prototype.put = originalPut;
    connections.forEach(db => db.close());
    await waitRequest(indexedDB.deleteDatabase(name));
  }
});
