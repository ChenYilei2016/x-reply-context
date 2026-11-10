(() => {
  "use strict";

  const core = globalThis.XReplyContext;
  const PAGE_SIZE = 50;
  const relationshipFilters = new Set(["all","mutual","mineOnly","theirsOnly","mineMore","theirsMore","skipped","whitelist"]);

  function minimum(value) {
    return Number.isSafeInteger(value) ? Math.max(0,value) : 0;
  }

  function matchesRelationship(row,filter) {
    const {myCommentedPosts:mine,theirCommentedPosts:theirs} = row;
    switch (filter) {
      case "mutual": return mine > 0 && theirs > 0;
      case "mineOnly": return mine > 0 && theirs === 0;
      case "theirsOnly": return theirs > 0 && mine === 0;
      case "mineMore": return mine > theirs;
      case "theirsMore": return theirs > mine;
      case "skipped": return row.skipped;
      case "whitelist": return row.whitelisted;
      default: return true;
    }
  }

  function page(state,account,{skipped,whitelist},query) {
    const prefix = `${account.id}:`;
    const search = typeof query.search === "string" ? query.search.slice(0,32).trim().toLowerCase().replace(/^@/,"") : "";
    const filter = relationshipFilters.has(query.filter) ? query.filter : "all";
    const minMine = minimum(query.minMine), minTheirs = minimum(query.minTheirs);
    const totals = { all:0,mutual:0,mineOnly:0,theirsOnly:0,skipped:skipped.size,whitelist:whitelist.size };
    const matched = [];
    const missing = new Set(filter === "skipped" ? skipped : filter === "whitelist" ? whitelist : []);

    function include(row) {
      if (row.myCommentedPosts < minMine || row.theirCommentedPosts < minTheirs || !matchesRelationship(row,filter)) return;
      if (search && !row.handle.includes(search) && !row.peerId.includes(search)) return;
      matched.push(row);
    }

    for (const key in state.people) {
      if (!key.startsWith(prefix)) continue;
      const peerId = key.slice(prefix.length);
      const person = state.people[key];
      const {myCommentedPosts,theirCommentedPosts} = core.summarizePerson(state,person);
      if (!myCommentedPosts && !theirCommentedPosts) continue;
      totals.all++;
      if (myCommentedPosts && theirCommentedPosts) totals.mutual++;
      else if (myCommentedPosts) totals.mineOnly++;
      else totals.theirsOnly++;
      const handle = state.users[peerId]?.handle || "";
      const confirmed = Boolean(handle && core.findAccount(state,handle)?.id === peerId);
      const isSkipped = confirmed && skipped.has(handle);
      const whitelisted = whitelist.has(peerId);
      if (isSkipped && filter === "skipped") missing.delete(handle);
      if (whitelisted && filter === "whitelist") missing.delete(peerId);
      include({peerId,handle,confirmed,skipped:isSkipped,whitelisted,myCommentedPosts,theirCommentedPosts,
        mineAtLegacyBound:myCommentedPosts>(person.myCommentedPosts||0),
        theirsAtLegacyBound:theirCommentedPosts>(person.theirCommentedPosts||0)});
    }

    // Keep list entries removable after their local interaction or profile records expire.
    const whitelisted = filter === "whitelist";
    for (const entry of missing) {
      const peerId = whitelisted ? entry : "";
      const handle = whitelisted ? state.users[peerId]?.handle || "" : entry;
      include({peerId,handle,confirmed:false,skipped:!whitelisted,whitelisted,myCommentedPosts:0,theirCommentedPosts:0});
    }

    const sortByTheirs = query.sort === "theirsDesc" || query.sort === "theirsAsc";
    const field = sortByTheirs ? "theirCommentedPosts" : "myCommentedPosts";
    const ascending = query.sort === "mineAsc" || query.sort === "theirsAsc";
    matched.sort((a,b) => {
      if (!a[field] && b[field]) return 1;
      if (a[field] && !b[field]) return -1;
      const delta = ascending ? a[field]-b[field] : b[field]-a[field];
      return delta || a.handle.localeCompare(b.handle) || a.peerId.localeCompare(b.peerId);
    });
    const total = matched.length;
    const pages = Math.max(1,Math.ceil(total/PAGE_SIZE));
    const currentPage = Math.min(pages,Math.max(1,minimum(query.page)));
    const offset = (currentPage-1)*PAGE_SIZE;
    return {totals,total,pages,page:currentPage,rows:matched.slice(offset,offset+PAGE_SIZE),
      incomplete:state.statistics?.incomplete === true,atCapacity:state.statistics?.atCapacity === true};
  }

  globalThis.XReplyInteractionReport = { page };
})();
