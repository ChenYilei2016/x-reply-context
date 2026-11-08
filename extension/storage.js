(() => {
  "use strict";
  const COLLECTIONS=["users","tweets","roots","replies","likes","people"];
  const DATABASE="x-reply-context-records";
  function create() {
    let opening;
    const core=globalThis.XReplyContext;
    const snapshots=new Map(COLLECTIONS.map(name=>[name,new Map()]));
    const request=operation=>new Promise((resolve,reject)=>{
      operation.onsuccess=()=>resolve(operation.result);operation.onerror=()=>reject(operation.error);
    });
    const completed=transaction=>new Promise((resolve,reject)=>{
      transaction.oncomplete=resolve;transaction.onabort=()=>reject(transaction.error||Error("本地记录写入未完成"));transaction.onerror=()=>{};
    });
    const ledger=globalThis.XReplyInteractionLedger.create({request});
    function database() {
      if(!opening){
        opening=new Promise((resolve,reject)=>{
          const operation=indexedDB.open(DATABASE,2);let blocked=false;
          operation.onupgradeneeded=event=>{
            const db=operation.result,transaction=operation.transaction;
            try {
              for(const name of [...COLLECTIONS,"metadata","interactionFacts","backups"])
                if(!db.objectStoreNames.contains(name))db.createObjectStore(name,{keyPath:"key"});
              // Upgrade is atomic: every old row is backed up before v2 can open or migrate.
              const backup=transaction.objectStore("backups");
              backup.put({key:"manifest",value:{at:Date.now(),fromVersion:event.oldVersion,format:1}});
              if(event.oldVersion>0)for(const name of [...COLLECTIONS,"metadata"]){
                let count=0;const cursor=transaction.objectStore(name).openCursor();
                cursor.onsuccess=()=>{
                  const row=cursor.result;if(!row)return;
                  if(++count>core.LIMIT+1){transaction.abort();return;}
                  backup.put({key:`${name}:${row.key}`,collection:name,record:row.value});row.continue();
                };
              }
            }catch {try{transaction.abort();}catch{}}
          };
          operation.onerror=()=>reject(operation.error);
          operation.onblocked=()=>{blocked=true;reject(Error("本地记录正在升级，请关闭旧的扩展页面后重试"));};
          operation.onsuccess=()=>{
            const db=operation.result;if(blocked){db.close();return;}
            db.onversionchange=()=>{db.close();opening=undefined;};resolve(db);
          };
        });
        void opening.catch(()=>{opening=undefined;});
      }
      return opening;
    }
    function sameRecord(a,b){return a===b||Boolean(a&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(key=>a[key]===b[key]));}
    const metadata=state=>({version:state.version,accounts:state.accounts,likeSnapshotFloors:state.likeSnapshotFloors||{},updatedAt:state.updatedAt,initialized:true,statistics:state.statistics});
    async function save(state) {
      const db=await database(),dirty=core.changes(state),changes=[];
      for(const name of COLLECTIONS){
        if(name==="people")continue; // Ledger is the only writer of durable summaries.
        const previous=snapshots.get(name),records=state[name];
        for(const key of dirty?dirty[name]:Object.keys(records)){
          if(!Object.hasOwn(records,key)){if(previous.has(key))changes.push({name,key});continue;}
          if(sameRecord(previous.get(key),records[key]))previous.set(key,records[key]);
          else changes.push({name,key,value:records[key]});
        }
        if(!dirty)for(const key of previous.keys())if(!Object.hasOwn(records,key))changes.push({name,key});
      }
      const pending=core.interactionChanges(state),facts=[...pending.facts.values()];let statsChanged=false;
      // Facts and their counts commit together in bounded batches. Cache writes come last,
      // so a worker interrupted between batches never persists uncaptured source evidence.
      for(let offset=0;offset<facts.length || offset===0&&pending.overflow;offset+=500){
        const transaction=db.transaction(["metadata","people","interactionFacts"],"readwrite"),done=completed(transaction);
        let result;
        try {
          result=await ledger.apply(transaction,facts.slice(offset,offset+500),pending.overflow);
          const previous=await request(transaction.objectStore("metadata").get("state"));
          transaction.objectStore("metadata").put({key:"state",value:{...previous.value,statistics:result.statistics}});
          await done;
        }catch(error){try{transaction.abort();}catch{}await done.catch(()=>{});throw error;}
        for(const [key,value] of result.people){state.people[key]=value;snapshots.get("people").set(key,value);}
        state.statistics=result.statistics;statsChanged ||= result.statsChanged;
      }
      const transaction=db.transaction([...new Set(["metadata",...changes.map(change=>change.name)])],"readwrite"),done=completed(transaction);
      let statistics;
      try {
        for(const change of changes){const store=transaction.objectStore(change.name);if(change.value)store.put({key:change.key,value:change.value});else store.delete(change.key);}
        const previous=await request(transaction.objectStore("metadata").get("state"));
        statistics=previous.value.statistics;
        transaction.objectStore("metadata").put({key:"state",value:{...metadata(state),statistics}});
        await done;
      }catch(error){try{transaction.abort();}catch{}await done.catch(()=>{});throw error;}
      state.statistics=statistics;
      for(const change of changes){const snapshot=snapshots.get(change.name);if(change.value)snapshot.set(change.key,change.value);else snapshot.delete(change.key);}
      core.saved(state);return {statsChanged};
    }
    async function backupLegacy(db,legacy) {
      if(!legacy)return;
      const transaction=db.transaction("backups","readwrite"),done=completed(transaction),store=transaction.objectStore("backups");
      try {if(!await request(store.get("legacy")))store.put({key:"legacy",value:legacy});await done;}
      catch(error){try{transaction.abort();}catch{}await done.catch(()=>{});throw error;}
    }
    function bounded(source) {
      if(!source || source.version!==1)throw Error("旧记录格式异常，请保留备份后检查");
      for(const name of COLLECTIONS)if(Object.keys(source[name]||{}).length>core.LIMIT)throw Error("旧记录超出迁移边界，请保留备份后检查");
    }
    async function load() {
      const db=await database();
      const transaction=db.transaction([...COLLECTIONS,"metadata","backups","interactionFacts"],"readonly"),done=completed(transaction);
      const [[meta,backup,factCount,...rows]]=await Promise.all([Promise.all([
        request(transaction.objectStore("metadata").get("state")),request(transaction.objectStore("backups").get("manifest")),
        request(transaction.objectStore("interactionFacts").count()),
        ...COLLECTIONS.map(name=>request(transaction.objectStore(name).getAll(undefined,core.LIMIT+1)))
      ]),done]);
      if(rows.some(values=>values.length>core.LIMIT))throw Error("本地记录数量异常，请保留原记录后检查");
      let state={version:meta?.value?.version||1,accounts:meta?.value?.accounts||{},likeSnapshotFloors:meta?.value?.likeSnapshotFloors||{},updatedAt:meta?.value?.updatedAt||0};
      COLLECTIONS.forEach((name,i)=>{state[name]=Object.fromEntries(rows[i].map(row=>[row.key,row.value]));});
      bounded(state);
      if(meta?.value?.statistics?.version===2){
        state.statistics=meta.value.statistics;
        if(factCount!==state.statistics.factCount || rows[5].length!==state.statistics.peopleCount)throw Error("互动事实和汇总数量不一致，请保留备份后检查");
      }else{
        const legacy=(await chrome.storage.local.get("replyContext")).replyContext;
        if(legacy){bounded(legacy);await backupLegacy(db,legacy);}
        if(!meta?.value?.initialized && legacy){state=structuredClone(legacy);for(const name of COLLECTIONS)state[name]||={};state.accounts||={};state.likeSnapshotFloors||={};}
        const plan=globalThis.XReplyInteractionLedger.migrationPlan(state,legacy,backup?.value?.at||Date.now());
        const names=meta?.value?.initialized?["people","interactionFacts","metadata"]:[...COLLECTIONS,"interactionFacts","metadata"];
        const migration=db.transaction(names,"readwrite"),migrated=completed(migration);
        const next={...state,people:plan.people,statistics:plan.statistics};
        try {
          migration.objectStore("people").clear();migration.objectStore("interactionFacts").clear();
          if(!meta?.value?.initialized)for(const name of COLLECTIONS){
            if(name==="people")continue;
            for(const [key,value] of Object.entries(state[name]))migration.objectStore(name).put({key,value});
          }
          for(const fact of plan.facts.values())migration.objectStore("interactionFacts").put(fact);
          for(const [key,value] of Object.entries(plan.people))migration.objectStore("people").put({key,value});
          migration.objectStore("metadata").put({key:"state",value:metadata(next)});
          await migrated;
        }catch(error){try{migration.abort();}catch{}await migrated.catch(()=>{});throw error;}
        state=next;
      }
      for(const name of COLLECTIONS)snapshots.set(name,new Map(Object.entries(state[name])));
      core.primeInteractions(state);core.saved(state);
      return state;
    }
    return {load,save};
  }
  globalThis.XReplyStorage={create};
})();
