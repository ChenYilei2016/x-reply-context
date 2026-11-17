// 创作素材的 IndexedDB 存储。与互动记录数据库相互独立，扩展后台与工作台页面共用。
// 依赖 XReplyMaterialModel 的合并与保留规则；本文件只负责事务、索引与分批。
(() => {
  "use strict";

  const DATABASE = "x-reply-creation";
  const VERSION = 1;
  const MATERIALS = "materials";
  const CHANNEL_STATES = "channelStates";
  /** 单个事务最多写入的素材数，避免长事务阻塞页面读取。 */
  const WRITE_BATCH = 200;

  const request = operation => new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });

  const completed = transaction => new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error("素材写入未完成"));
    transaction.onerror = () => {};
  });

  function upgrade(db) {
    if (!db.objectStoreNames.contains(MATERIALS)) {
      const materials = db.createObjectStore(MATERIALS, { keyPath: "id" });
      materials.createIndex("lastSeenAt", "lastSeenAt");
      materials.createIndex("kindLastSeenAt", ["kind", "lastSeenAt"]);
    }
    if (!db.objectStoreNames.contains(CHANNEL_STATES)) db.createObjectStore(CHANNEL_STATES, { keyPath: "channelId" });
  }

  /**
   * @param options.indexedDB 默认使用全局 indexedDB，检查页可传入独立实例
   * @param options.name 数据库名，检查页使用临时库
   */
  function create({ indexedDB = globalThis.indexedDB, name = DATABASE } = {}) {
    const model = globalThis.XReplyMaterialModel;
    let opening;

    function database() {
      opening ||= new Promise((resolve, reject) => {
        const operation = indexedDB.open(name, VERSION);
        operation.onupgradeneeded = () => upgrade(operation.result);
        operation.onerror = () => reject(operation.error);
        operation.onblocked = () => reject(new Error("素材库正在升级，请关闭旧的工作台页面后重试"));
        operation.onsuccess = () => {
          const db = operation.result;
          db.onversionchange = () => { db.close(); opening = undefined; };
          resolve(db);
        };
      });
      opening.catch(() => { opening = undefined; });
      return opening;
    }

    async function write(storeNames, work) {
      const db = await database();
      const transaction = db.transaction(storeNames, "readwrite");
      const done = completed(transaction);
      try {
        const result = await work(transaction);
        await done;
        return result;
      } catch (error) {
        try { transaction.abort(); } catch { /* 事务已结束 */ }
        await done.catch(() => {});
        throw error;
      }
    }

    async function read(storeName, work) {
      const db = await database();
      return work(db.transaction(storeName, "readonly").objectStore(storeName));
    }

    /** 批量写入素材：已存在的按领域规则合并。返回新增与更新数量。 */
    async function upsertMany(materials) {
      const unique = new Map();
      for (const material of materials) unique.set(material.id, model.merge(unique.get(material.id), material));
      const all = [...unique.values()];
      let inserted = 0;
      for (let start = 0; start < all.length; start += WRITE_BATCH) {
        const batch = all.slice(start, start + WRITE_BATCH);
        inserted += await write(MATERIALS, async transaction => {
          const store = transaction.objectStore(MATERIALS);
          const existing = await Promise.all(batch.map(material => request(store.get(material.id))));
          batch.forEach((material, index) => store.put(model.merge(existing[index], material)));
          return existing.filter(item => !item).length;
        });
      }
      return { inserted, updated: all.length - inserted };
    }

    const get = id => read(MATERIALS, store => request(store.get(id)));

    const count = () => read(MATERIALS, store => request(store.count()));

    /**
     * 按最近出现时间倒序读取，读到 since 之前或达到 limit 即停止，不全量加载。
     * @param options.kind 只读某一类型
     * @param options.since 最早的 lastSeenAt（毫秒）
     * @param options.limit 最多条数（只计入满足 where 的条目）
     * @param options.where 可选筛选条件，在游标上逐条判断，不满足的不进内存结果
     */
    function recent({ kind, since = 0, limit = 2000, where } = {}) {
      return read(MATERIALS, store => new Promise((resolve, reject) => {
        const range = kind ?
          IDBKeyRange.bound([kind, since], [kind, Infinity]) :
          IDBKeyRange.lowerBound(since);
        const cursor = store.index(kind ? "kindLastSeenAt" : "lastSeenAt").openCursor(range, "prev");
        const rows = [];
        cursor.onerror = () => reject(cursor.error);
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row || rows.length >= limit) { resolve(rows); return; }
          if (!where || where(row.value)) rows.push(row.value);
          row.continue();
        };
      }));
    }

    /** 设置用户标记（saved、hidden、usedAt）。素材不存在时返回 undefined。 */
    function setMark(id, mark, value) {
      if (!["saved", "hidden", "usedAt"].includes(mark)) throw new Error(`未知标记 ${mark}`);
      return write(MATERIALS, async transaction => {
        const store = transaction.objectStore(MATERIALS);
        const material = await request(store.get(id));
        if (!material) return undefined;
        const marks = { ...material.marks };
        if (value === undefined || value === false) delete marks[mark];
        else marks[mark] = value;
        const next = { ...material, marks };
        store.put(next);
        return next;
      });
    }

    /**
     * 按保留策略清理：先删除过期素材，再在超出总量时从最久未出现的开始删除（跳过收藏和自己的帖子）。
     * 游标逐条处理，不把整个库读进内存。
     */
    function prune(now, policy = model.DEFAULT_RETENTION) {
      return write(MATERIALS, transaction => new Promise((resolve, reject) => {
        const store = transaction.objectStore(MATERIALS);
        const total = store.count();
        total.onerror = () => reject(total.error);
        total.onsuccess = () => {
          let remaining = total.result;
          let removed = 0;
          const cursor = store.index("lastSeenAt").openCursor();
          cursor.onerror = () => reject(cursor.error);
          cursor.onsuccess = () => {
            const row = cursor.result;
            if (!row) { resolve(removed); return; }
            const material = row.value;
            const overCapacity = remaining > policy.maxCount && !material.marks?.saved && !material.own;
            if (model.isExpired(material, now, policy) || overCapacity) {
              row.delete();
              removed++;
              remaining--;
            }
            row.continue();
          };
        };
      }));
    }

    /**
     * 逐条改写素材（用于迁移）。transform 返回新对象则更新、返回 null 则删除、原样返回则不动。
     * 单个事务内用游标处理，不把整个库读入内存。
     */
    function rewrite(transform) {
      return write(MATERIALS, transaction => new Promise((resolve, reject) => {
        let updated = 0, deleted = 0;
        const cursor = transaction.objectStore(MATERIALS).openCursor();
        cursor.onerror = () => reject(cursor.error);
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row) { resolve({ updated, deleted }); return; }
          const next = transform(row.value);
          if (next === null) { row.delete(); deleted++; }
          else if (next !== row.value) { row.update(next); updated++; }
          row.continue();
        };
      }));
    }

    async function channelStates() {
      const rows = await read(CHANNEL_STATES, store => request(store.getAll()));
      return Object.fromEntries(rows.map(row => [row.channelId, row]));
    }

    const saveChannelState = state => write(CHANNEL_STATES, async transaction => {
      transaction.objectStore(CHANNEL_STATES).put(state);
    });

    const deleteChannelState = channelId => write(CHANNEL_STATES, async transaction => {
      transaction.objectStore(CHANNEL_STATES).delete(channelId);
    });

    async function close() {
      const db = await opening?.catch(() => undefined);
      db?.close();
      opening = undefined;
    }

    return { upsertMany, get, count, recent, setMark, prune, rewrite, channelStates, saveChannelState, deleteChannelState, close };
  }

  globalThis.XReplyMaterialDB = Object.freeze({ create, DATABASE });
})();
