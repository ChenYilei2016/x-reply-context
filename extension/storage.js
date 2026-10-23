(() => {
  "use strict";
  const COLLECTIONS = ["users","tweets","roots","replies","likes","people"];
  const DATABASE = "x-reply-context-records";

  function create() {
    let opening;
    const snapshots = new Map(COLLECTIONS.map(name => [name,new Map()]));
    const request = operation => new Promise((resolve,reject) => {
      operation.onsuccess = () => resolve(operation.result);
      operation.onerror = () => reject(operation.error);
    });
    const completed = transaction => new Promise((resolve,reject) => {
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error || new Error("本地记录写入未完成"));
      transaction.onerror = () => {}; // The abort event determines the transaction's final outcome.
    });

    function database() {
      if (!opening) {
        opening = new Promise((resolve,reject) => {
          const operation = indexedDB.open(DATABASE,1);
          let blocked = false;
          operation.onupgradeneeded = () => {
            for (const name of [...COLLECTIONS,"metadata"]) operation.result.createObjectStore(name,{ keyPath:"key" });
          };
          operation.onerror = () => reject(operation.error);
          operation.onblocked = () => { blocked = true; reject(new Error("本地记录正在升级，请关闭旧的扩展页面后重试")); };
          operation.onsuccess = () => {
            const db = operation.result;
            if (blocked) { db.close(); return; }
            db.onversionchange = () => { db.close(); opening = undefined; };
            resolve(db);
          };
        });
        void opening.catch(() => { opening = undefined; });
      }
      return opening;
    }

    function sameRecord(previous,next) {
      if (previous === next) return true;
      if (!previous) return false;
      const keys = Object.keys(previous);
      return keys.length === Object.keys(next).length && keys.every(key => previous[key] === next[key]);
    }

    async function save(state) {
      const changes = [];
      for (const name of COLLECTIONS) {
        const previous = snapshots.get(name);
        const records = state[name];
        for (const key of Object.keys(records)) {
          if (sameRecord(previous.get(key),records[key])) previous.set(key,records[key]);
          else changes.push({ name,key,value:records[key] });
        }
        for (const key of previous.keys()) {
          if (!Object.hasOwn(records,key)) changes.push({ name,key });
        }
      }
      const db = await database();
      const names = [...new Set(["metadata",...changes.map(change => change.name)])];
      const transaction = db.transaction(names,"readwrite");
      const done = completed(transaction);
      for (const change of changes) {
        const store = transaction.objectStore(change.name);
        if (change.value) store.put({ key:change.key,value:change.value });
        else store.delete(change.key);
      }
      transaction.objectStore("metadata").put({ key:"state",value:{
        version:state.version,accounts:state.accounts,updatedAt:state.updatedAt,initialized:true
      } });
      await done;
      for (const change of changes) {
        const snapshot = snapshots.get(change.name);
        if (change.value) snapshot.set(change.key,change.value);
        else snapshot.delete(change.key);
      }
    }

    async function load() {
      const db = await database();
      const transaction = db.transaction([...COLLECTIONS,"metadata"],"readonly");
      const done = completed(transaction);
      const limit = globalThis.XReplyContext.LIMIT;
      const reads = COLLECTIONS.map(name => request(transaction.objectStore(name).getAll(undefined,limit+1)));
      const [[metadata,...collections]] = await Promise.all([Promise.all([
        request(transaction.objectStore("metadata").get("state")),...reads
      ]),done]);
      if (metadata?.value?.initialized) {
        if (metadata.value.version !== 1 || collections.some(rows => rows.length > limit)) {
          throw new Error("本地记录格式或数量异常，请保留原记录后检查");
        }
        const state = { version:1,accounts:metadata.value.accounts,updatedAt:metadata.value.updatedAt };
        COLLECTIONS.forEach((name,index) => {
          state[name] = Object.fromEntries(collections[index].map(row => [row.key,row.value]));
          snapshots.set(name,new Map(Object.entries(state[name])));
        });
        return state;
      }
      const saved = (await chrome.storage.local.get("replyContext")).replyContext;
      const state = saved?.version === 1 ? saved : globalThis.XReplyContext.createState();
      globalThis.XReplyContext.ingest(state,{},"");
      // The initialized marker and records commit together; retain the old local snapshot as a backup.
      await save(state);
      return state;
    }

    return { load,save };
  }
  globalThis.XReplyStorage = { create };
})();
