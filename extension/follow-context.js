(() => {
  "use strict";
  const LIMIT = 10000;
  const fields = ["following","followedBy"];
  function create() {
    let account = "";
    const records = new Map();
    function setAccount(value) {
      const next = typeof value === "string" && /^[a-zA-Z0-9_]{1,15}$/.test(value) ? value.toLowerCase() : "";
      if (next === account) return false;
      account = next; records.clear(); return true;
    }
    function ingest(viewer,rows,order) {
      if (!account || viewer !== account || !Array.isArray(rows)) return [];
      const changed = [];
      for (const row of rows.slice(0,500)) {
        if (!row || typeof row.id !== "string" || !/^\d{1,25}$/.test(row.id)) continue;
        const previous = records.get(row.id), next = {...previous,id:row.id};
        let accepted = false, different = false;
        for (const field of fields) {
          const sequence = row[field+"Order"] ?? order;
          if (typeof row[field] !== "boolean" || !Number.isSafeInteger(sequence) || sequence < 1 ||
              sequence < (previous?.[field+"Order"] || 0)) continue;
          accepted = true;
          if (previous?.[field] !== row[field]) different = true;
          next[field] = row[field]; next[field+"Order"] = sequence;
        }
        if (!accepted) continue;
        records.delete(row.id); records.set(row.id,next);
        if (different) changed.push(next);
      }
      while (records.size > LIMIT) records.delete(records.keys().next().value);
      return changed;
    }
    return {setAccount,ingest,read:(viewer,id)=>viewer === account ? records.get(id) : undefined,
      values:()=>records.values(),clear:()=>records.clear()};
  }
  globalThis.XReplyFollowContext = {create};
})();
