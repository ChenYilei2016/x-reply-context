const core=globalThis.XReplyContext,name='x-reply-context-records',output=document.querySelector('#result');
const collections=['users','tweets','roots','replies','likes','people'];
const request=op=>new Promise((resolve,reject)=>{op.onsuccess=()=>resolve(op.result);op.onerror=()=>reject(op.error);});
const done=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||Error('aborted'));});
const id=n=>(1000000000000000000n+BigInt(n)).toString();
const tweet=(n,author,root=n,parent='',recipient='')=>({id:id(n),authorId:author,conversationId:id(root),parentId:parent?id(parent):'',recipientId:recipient,text:'fixture'});
document.querySelector('#run').onclick=async event=>{
 const checks=[],metrics={},connections=[];event.target.disabled=true;output.dataset.result='running';
 const check=(label,ok)=>{checks.push({label,ok:Boolean(ok)});if(!ok)throw Error(label);};
 const originalOpen=indexedDB.open.bind(indexedDB),originalPut=IDBObjectStore.prototype.put,originalGetAll=IDBObjectStore.prototype.getAll;
 let abortStore='',factReads=0,factWrites=0,peopleWrites=0;
 indexedDB.open=(...args)=>{const op=originalOpen(...args);op.addEventListener('success',()=>connections.push(op.result));return op;};
 IDBObjectStore.prototype.put=function(value,...args){
  if(this.name==='interactionFacts')factWrites++;if(this.name==='people')peopleWrites++;
  const result=Reflect.apply(originalPut,this,[value,...args]);
  if(this.name===abortStore){abortStore='';this.transaction.abort();}return result;
 };
 IDBObjectStore.prototype.getAll=function(...args){if(this.name==='interactionFacts'){factReads++;throw Error('不得全量读取互动事实');}return Reflect.apply(originalGetAll,this,args);};
 try{
  await request(indexedDB.deleteDatabase(name));const now=Date.now(),old=core.createState();
  core.ingest(old,{users:[{id:'1',handle:'me'},{id:'2',handle:'peer'},{id:'3',handle:'other'}],tweets:[tweet(1,'1'),tweet(2,'2',1,1,'1'),tweet(3,'2'),tweet(4,'1',3,3,'2')]},'me',now);
  const legacy=structuredClone(old);legacy.people['1:2'].myCommentedPosts=7;
  globalThis.chrome={storage:{local:{get:async()=>({replyContext:structuredClone(legacy)})}}};
  const seed=indexedDB.open(name,1);seed.onupgradeneeded=()=>{for(const store of [...collections,'metadata'])seed.result.createObjectStore(store,{keyPath:'key'});};
  const seedDb=await request(seed),seedTx=seedDb.transaction([...collections,'metadata'],'readwrite'),seedDone=done(seedTx);
  for(const store of collections)for(const [key,value] of Object.entries(old[store]))seedTx.objectStore(store).put({key,value});
  seedTx.objectStore('metadata').put({key:'state',value:{version:1,accounts:old.accounts,likeSnapshotFloors:{},initialized:true,updatedAt:now}});await seedDone;seedDb.close();
  abortStore='backups';let failed=false;try{await XReplyStorage.create().load();}catch{failed=true;}
  const unchanged=await request(indexedDB.open(name,1));
  check('备份失败则升级回滚，旧数据库和统计保持原样',failed&&unchanged.version===1&&!unchanged.objectStoreNames.contains('interactionFacts')&&(await request(unchanged.transaction('people','readonly').objectStore('people').get('1:2'))).value.theirCommentedPosts===1);
  unchanged.close();abortStore='people';failed=false;try{await XReplyStorage.create().load();}catch{failed=true;}
  const db=await request(indexedDB.open(name));
  const read=async(store,key)=>request(db.transaction(store,'readonly').objectStore(store).get(key));
  const count=async store=>request(db.transaction(store,'readonly').objectStore(store).count());
  check('迁移前完整备份，迁移中断仍保留旧统计且无半份新事实',failed&&(await count('interactionFacts'))===0&&JSON.stringify((await read('backups','people:1:2')).record.value)===JSON.stringify(old.people['1:2'])&&(await read('people','1:2')).value.theirCommentedPosts===1);
  check('旧local快照也先备份，未混入API配置',(await read('backups','legacy')).value.people['1:2'].myCommentedPosts===7);
  let storage=XReplyStorage.create();let t=performance.now(),state=await storage.load();core.prepare(state);metrics.migrationMs=performance.now()-t;
  check('重试迁移去重，历史下限不与事实重复相加',state.statistics.factCount===2&&state.people['1:2'].myCommentedPosts===1&&core.classify(state,'me',id(2)).personStats.myCommentedPosts===7&&state.statistics.incomplete);
  const before=[factWrites,peopleWrites];core.ingest(state,{tweets:[tweet(2,'2',1,1,'1'),tweet(6,'2',1,1,'1')]},'me',now+1);await storage.save(state);
  check('同帖多次与重复加载不改计数、不重写事实或汇总',state.people['1:2'].theirCommentedPosts===1&&factWrites===before[0]&&peopleWrites===before[1]);
  core.ingest(state,{tweets:[tweet(7,'1'),tweet(8,'2',7,7,'1')]},'me',now+2);await storage.save(state);
  check('不同原帖增加一次，事实和计数一同保存',state.people['1:2'].theirCommentedPosts===2&&(await count('interactionFacts'))===3);
  core.ingest(state,{tweets:[tweet(9,'1'),tweet(10,'2',9,9,'1')]},'me',now+3);abortStore='interactionFacts';failed=false;try{await storage.save(state);}catch{failed=true;}
  check('事实写入中断时计数不先增加',failed&&(await read('people','1:2')).value.theirCommentedPosts===2&&(await count('interactionFacts'))===3);
  await storage.save(state);check('失败后重试只补一次，不重复累计',(await count('interactionFacts'))===4&&state.people['1:2'].theirCommentedPosts===3);
  const repairTx=db.transaction(['metadata','roots','tweets'],'readwrite'),repairDone=done(repairTx);
  const repairMeta=await request(repairTx.objectStore('metadata').get('state'));
  delete repairMeta.value.interactionRulesVersion;
  repairTx.objectStore('metadata').put(repairMeta);
  repairTx.objectStore('roots').put({key:id(11),value:{id:id(11),authorId:'1',seenAt:now}});
  repairTx.objectStore('tweets').put({key:id(12),value:{...tweet(12,'3',11,11,'1'),conversationId:'',seenAt:now}});
  await repairDone;
  abortStore='interactionFacts';failed=false;try{await XReplyStorage.create().load();}catch{failed=true;}
  check('升级补算失败时保留已有次数，完成标记可重试',failed&&(await count('interactionFacts'))===4&&
    !(await read('metadata','state')).value.interactionRulesVersion);
  storage=XReplyStorage.create();state=await storage.load();core.prepare(state);
  check('补回缓存中可确认的一篇，旧事实不重复累加',state.people['1:3'].theirCommentedPosts===1&&
    state.people['1:2'].theirCommentedPosts===3&&(await count('interactionFacts'))===5&&
    Boolean((await read('metadata','state')).value.interactionRulesVersion));
  t=performance.now();for(let offset=0;offset<core.LIMIT;offset+=500){
   core.ingest(state,{tweets:Array.from({length:500},(_,i)=>tweet(1000+offset+i,'3'))},'me',now+4+offset);
  }
  metrics.fill20kCacheMs=performance.now()-t;await storage.save(state);
  check('仅一条自己的回复，2万条浏览淘汰原评论和原帖后人数计数不减少',Object.keys(state.replies).length===1&&!state.tweets[id(2)]&&!state.roots[id(3)]&&state.people['1:2'].theirCommentedPosts===3&&state.people['1:2'].myCommentedPosts===1);
  const writesBeforeReopen=factWrites;
  t=performance.now();state=await XReplyStorage.create().load();core.prepare(state);metrics.coldReadMs=performance.now()-t;
  check('重开恢复汇总，已完成补算不重复执行',state.people['1:2'].theirCommentedPosts===3&&
    state.people['1:3'].theirCommentedPosts===1&&factReads===0&&factWrites===writesBeforeReopen);
  core.ingest(state,{users:[{id:'1',handle:'me'},{id:'2',handle:'peer'}],tweets:[tweet(30000,'2')]},'me',now+30000);await storage.save(state);
  const rows=Array.from({length:100},()=>id(30000));core.classifyBatch(state,'me',rows);t=performance.now();core.classifyBatch(state,'me',rows);metrics.warmClassify100Ms=performance.now()-t;
  check('显示保守下限，历史不完整不误判NEW',core.classify(state,'me',id(30000)).personStats.theirCommentedPosts===3&&core.classify(state,'me',id(30000)).personStats.incomplete===true);
  core.ingest(state,{},'me',now+core.RETENTION_MS+40000);await storage.save(state);
  check('90天正文过期不清除互动累计',Object.keys(state.tweets).length===0&&state.people['1:2'].theirCommentedPosts===3);
  async function fillLedger(limit,oldCap=false){
   const tx=db.transaction(['interactionFacts','people','metadata','tweets'],'readwrite'),written=done(tx);
   const meta=await request(tx.objectStore('metadata').get('state'));
   const statistics=meta.value.statistics,previousCount=statistics.factCount;
   for(let n=previousCount;n<limit;n++){
    const peerId=String(100000+n),rootId=id(100000+n);
    tx.objectStore('interactionFacts').put({key:`1:${peerId}:out:${rootId}`,accountId:'1',peerId,direction:'out',rootId,firstReplyId:'',seenAt:now});
    tx.objectStore('people').put({key:`1:${peerId}`,value:{myCommentedPosts:1,theirCommentedPosts:0,firstCommentOnMyPostId:'',seenAt:now}});
   }
   statistics.factCount=limit;statistics.peopleCount+=limit-previousCount;statistics.atCapacity=true;
   if(oldCap){
    meta.value.interactionRulesVersion=1;
    const seenAt=now+core.RETENTION_MS+40001;
    for(const cached of [tweet(90000,'1'),tweet(90001,'2',90000,90000,'1')]){
     tx.objectStore('tweets').put({key:cached.id,value:{...cached,seenAt}});
    }
   }
   tx.objectStore('metadata').put(meta);await written;
  }
  await fillLedger(core.LIMIT,true);
  storage=XReplyStorage.create();t=performance.now();state=await storage.load();core.prepare(state);metrics.expandAndReplayMs=performance.now()-t;
  check('旧账本满2万后仍能补回缓存事实，清除当前满额提示并保留历史缺口',
    (await count('interactionFacts'))===core.LIMIT+1&&state.people['1:2'].theirCommentedPosts===4&&state.statistics.incomplete&&!state.statistics.atCapacity);
  check('用户资料过期后冷启动保留已核验的账号映射',!core.findAccount(state,'me')&&core.findOwnAccount(state,'me')?.id==='1');
  await fillLedger(core.INTERACTION_LIMIT);
  storage=XReplyStorage.create();t=performance.now();state=await storage.load();core.prepare(state);metrics.cold40kMs=performance.now()-t;
  check('冷启动可读超过2万个人物汇总，事实表仍只计数',Object.keys(state.people).length>core.LIMIT&&factReads===0);
  const retained=state.people['1:2'].theirCommentedPosts;
  core.ingest(state,{tweets:[tweet(91000,'1'),tweet(91001,'2',91000,91000,'1')]},'me',now+core.RETENTION_MS+50000);await storage.save(state);
  check('互动事实满4万保留原计数，明确标记容量不足',(await count('interactionFacts'))===core.INTERACTION_LIMIT&&state.statistics.atCapacity&&state.people['1:2'].theirCommentedPosts===retained);
  check('备份始终保持迁移前原样',(await read('backups','people:1:2')).record.value.theirCommentedPosts===1);
  output.dataset.result='passed';output.textContent=JSON.stringify({fixture:true,checks,metrics},null,2);
 }catch(error){output.dataset.result='failed';output.textContent=JSON.stringify({checks,error:error.message,stack:error.stack},null,2);}
 finally{indexedDB.open=originalOpen;IDBObjectStore.prototype.put=originalPut;IDBObjectStore.prototype.getAll=originalGetAll;connections.forEach(db=>db.close());await request(indexedDB.deleteDatabase(name));event.target.disabled=false;}
};
