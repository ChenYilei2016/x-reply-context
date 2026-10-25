/* Shared by the page observer, service worker and the focused self-checks. */
(() => {
  "use strict";
  const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
  const LIMIT = 10000;
  const runtime = new WeakMap();
  function cacheFor(state) {
    let cache = runtime.get(state);
    if (!cache) {
      cache = { users:null,lookups:new Map(),dirty:null,expiry:0,likeCount:0 };
      runtime.set(state,cache);
    }
    return cache;
  }
  function mark(state,name,key) { cacheFor(state).dirty?.[name].add(key); }
  function equalRecord(previous,next) {
    return previous === next || Boolean(previous && next && Object.keys(previous).length === Object.keys(next).length &&
      Object.keys(next).every(key => previous[key] === next[key]));
  }
  function put(state,name,key,value) {
    if (equalRecord(state[name][key],value)) return;
    state[name][key] = value; mark(state,name,key);
  }
  function replace(state,name,records) {
    const previous = state[name];
    for (const key of Object.keys(previous)) if (!Object.hasOwn(records,key)) mark(state,name,key);
    for (const key of Object.keys(records)) {
      if (equalRecord(previous[key],records[key])) records[key] = previous[key];
      else mark(state,name,key);
    }
    state[name] = records;
  }
  function saved(state) {
    cacheFor(state).dirty = Object.fromEntries(
      ["users","tweets","roots","replies","likes","people"].map(name => [name,new Set()]));
  }
  const changes = state => cacheFor(state).dirty;

  const id = value => typeof value === "string" && /^\d{1,25}$/.test(value) ? value : "";
  const handle = value => typeof value === "string" && /^[a-zA-Z0-9_]{1,15}$/.test(value) ? value.toLowerCase() : "";
  const text = value => typeof value === "string" ? value.slice(0,200) : "";

  function cleanUser(value) {
    const userId = id(value?.id);
    const screenName = handle(value?.handle);
    return userId && screenName ? { id: userId, handle: screenName } : null;
  }

  function cleanTweet(value) {
    if (!id(value?.id) || !id(value?.authorId)) return null;
    return {
      id: id(value.id), authorId: id(value.authorId),
      conversationId: id(value.conversationId), parentId: id(value.parentId),
      recipientId: id(value.recipientId), text: text(value.text)
    };
  }

  function extract(payload,onRelationship) {
    const users = new Map();
    const tweets = new Map();
    const likes = new Map();
    const pending = [payload];
    let visited = 0;
    while (pending.length && visited++ < 40000) {
      const node = pending.pop();
      if (!node || typeof node !== "object") continue;
      const legacy = node.legacy || node;
      const user = cleanUser({
        id: node.rest_id || legacy.id_str || (node.username ? node.id : ""),
        handle: node.core?.screen_name || legacy.screen_name || node.username
      });
      if (user) {
        users.set(user.id,user);
        if (onRelationship) {
          const perspective = node.relationship_perspectives;
          const outgoing = typeof perspective?.following === "boolean" ? perspective.following : legacy.following;
          const incoming = typeof perspective?.followed_by === "boolean" ? perspective.followed_by : legacy.followed_by;
          const following = typeof outgoing === "boolean" ? outgoing : undefined;
          const followedBy = typeof incoming === "boolean" ? incoming : undefined;
          if (following !== undefined || followedBy !== undefined) onRelationship({id:user.id,following,followedBy});
        }
      }
      const recipient = cleanUser({
        id:legacy.in_reply_to_user_id_str, handle:legacy.in_reply_to_screen_name
      });
      if (recipient) users.set(recipient.id,recipient);
      // Retweets contain copied reply fields; only their nested original can be evidence.
      if (!legacy.retweeted_status && !legacy.retweeted_status_result) {
        const embedded = node.core?.user_results?.result;
        const parent = node.referenced_tweets?.find?.(reference => reference.type === "replied_to");
        const noteText = node.note_tweet?.note_tweet_results?.result?.text;
        const hasBody = typeof legacy.full_text === "string" || typeof node.text === "string" || typeof noteText === "string";
        if (hasBody) {
          const tweet = cleanTweet({
            id: node.rest_id || legacy.id_str || node.id,
            authorId: legacy.user_id_str || embedded?.rest_id || node.author_id || node.user?.id_str,
            parentId: legacy.in_reply_to_status_id_str || parent?.id,
            recipientId: legacy.in_reply_to_user_id_str || node.in_reply_to_user_id,
            conversationId: legacy.conversation_id_str || node.conversation_id,
            text: noteText || legacy.full_text || node.text
          });
          if (tweet) {
            // An explicit non-reply is its own root; never infer this for a partial object.
            if (!tweet.conversationId && !tweet.parentId &&
                ("in_reply_to_status_id_str" in legacy || "referenced_tweets" in node)) {
              tweet.conversationId = tweet.id;
            }
            const previous = tweets.get(tweet.id);
            tweets.set(tweet.id, previous ? mergeKnown(previous,tweet) : tweet);
            if (typeof legacy.favorited === "boolean") {
              likes.set(tweet.id,{ id:tweet.id,liked:legacy.favorited });
            }
          }
        }
      }
      for (const child of Object.values(node)) {
        if (child && typeof child === "object" && pending.length < 40000) pending.push(child);
      }
    }
    return {
      users: [...users.values()], tweets: [...tweets.values()], likes: [...likes.values()]
    };
  }

  function createState() {
    return { version: 1, users: {}, tweets: {}, roots: {}, replies: {}, likes: {}, people: {}, accounts: {}, updatedAt: 0 };
  }

  function mergeKnown(previous, next, now) {
    const result = { ...previous };
    for (const [key, value] of Object.entries(next)) if (value !== "") result[key] = value;
    if (now !== undefined) result.seenAt = now;
    return result;
  }

  function findAccount(state, accountHandle) {
    const name = handle(accountHandle);
    if (!name) return null;
    const cache = cacheFor(state);
    if (!cache.users) {
      cache.users = new Map();
      for (const user of Object.values(state.users)) if (!cache.users.has(user.handle)) cache.users.set(user.handle,user);
    }
    return cache.users.get(name) || null;
  }

  function conversationOf(state, tweet) {
    const seen = new Set();
    for (let depth = 0; tweet && depth < 32; depth++) {
      if (tweet.conversationId) return tweet.conversationId;
      if (!tweet.parentId || seen.has(tweet.id)) return "";
      seen.add(tweet.id);
      tweet = state.tweets[tweet.parentId];
    }
    return "";
  }

  function indexReplies(state) {
    for (const tweet of Object.values(state.tweets)) {
      const rootId = conversationOf(state, tweet);
      if (!rootId) continue;
      const parent = state.tweets[tweet.parentId];
      const recipientId = tweet.recipientId || parent?.authorId;
      const rootAuthor = tweet.id === rootId ? tweet.authorId :
        tweet.parentId === rootId ? recipientId : "";
      if (rootAuthor) {
        put(state,"roots",rootId,{
          id: rootId, authorId: rootAuthor,
          seenAt: Math.max(tweet.seenAt,state.roots[rootId]?.seenAt || 0)
        });
      }
      if (!state.accounts[tweet.authorId] || !tweet.parentId || !recipientId ||
          tweet.authorId === recipientId) continue;
      const key = `${tweet.authorId}:${rootId}:${recipientId}`;
      const previous = state.replies[key];
      if (!previous || BigInt(tweet.id) >= BigInt(previous.id)) {
        put(state,"replies",key,{
          id: tweet.id, actorId: tweet.authorId, conversationId: rootId,
          recipientId, text: tweet.text || "", seenAt: tweet.seenAt
        });
      }
    }
  }

  function retainRecords(records, now) {
    const entries = Object.entries(records);
    let previous = Infinity;
    if (entries.length <= LIMIT && entries.every(([,value]) => {
      const retained = value.seenAt >= now-RETENTION_MS && value.seenAt <= previous;
      previous = value.seenAt;
      return retained;
    })) return records;
    return Object.fromEntries(entries
      .filter(([, value]) => value.seenAt >= now - RETENTION_MS)
      .sort((a,b) => b[1].seenAt - a[1].seenAt).slice(0,LIMIT));
  }

  function prune(state, now) {
    let relationshipsChanged = false;
    for (const key of ["users", "tweets", "roots", "replies", "likes", "people"]) {
      const retained = retainRecords(state[key],now);
      if (key !== "likes" && key !== "people" && retained !== state[key]) relationshipsChanged = true;
      if (retained !== state[key]) replace(state,key,retained);
    }
    const accounts = Object.entries(state.accounts);
    const retainedAccounts = accounts.filter(([, seenAt]) => seenAt >= now - RETENTION_MS).slice(-20);
    if (retainedAccounts.length !== accounts.length) relationshipsChanged = true;
    state.accounts = Object.fromEntries(retainedAccounts);
    return relationshipsChanged;
  }

  function indexPeople(state, now) {
    // Rebuild from retained evidence, counting each original post once per direction.
    const people = Object.fromEntries(Object.entries(state.people)
      .map(([key,person]) => [key,{
        myCommentedPosts:0, theirCommentedPosts:0,
        firstCommentOnMyPostId:person.firstCommentOnMyPostId || "", seenAt:person.seenAt
      }]));
    function personFor(accountId, peerId, seenAt) {
      const key = `${accountId}:${peerId}`;
      const person = people[key] ||= {
        myCommentedPosts:0, theirCommentedPosts:0, firstCommentOnMyPostId:"", seenAt:0
      };
      person.seenAt = Math.max(person.seenAt,seenAt);
      return person;
    }
    const countedPosts = new Set();
    function countPost(accountId, peerId, direction, rootId, seenAt) {
      const person = personFor(accountId,peerId,seenAt);
      const key = `${accountId}:${peerId}:${direction}:${rootId}`;
      if (!countedPosts.has(key)) {
        countedPosts.add(key);
        person[direction]++;
      }
      return person;
    }
    const comments = new Map();
    // A reply index can outlive its cached tweet; keep that evidence without double counting.
    for (const reply of Object.values(state.replies)) {
      comments.set(reply.id,{
        id:reply.id, authorId:reply.actorId,
        conversationId:reply.conversationId, seenAt:reply.seenAt
      });
    }
    for (const tweet of Object.values(state.tweets)) {
      if (!tweet.parentId) continue;
      const previous = comments.get(tweet.id);
      comments.set(tweet.id,{
        id:tweet.id, authorId:tweet.authorId,
        conversationId:conversationOf(state,tweet) || previous?.conversationId || "",
        seenAt:Math.max(tweet.seenAt,previous?.seenAt || 0)
      });
    }
    for (const comment of comments.values()) {
      const { id:tweetId,authorId,conversationId,seenAt } = comment;
      const rootAuthorId = state.roots[conversationId]?.authorId || state.tweets[conversationId]?.authorId;
      if (rootAuthorId && rootAuthorId !== authorId) {
        if (state.accounts[authorId]) {
          countPost(authorId,rootAuthorId,"myCommentedPosts",conversationId,seenAt);
        }
        if (state.accounts[rootAuthorId]) {
          const person = countPost(rootAuthorId,authorId,"theirCommentedPosts",conversationId,seenAt);
          if (!person.firstCommentOnMyPostId || BigInt(tweetId) < BigInt(person.firstCommentOnMyPostId)) {
            person.firstCommentOnMyPostId = tweetId;
          }
        }
      }
    }
    replace(state,"people",retainRecords(people,now));
  }

  // Refresh derived evidence timestamps without rebuilding counts for unchanged posts.
  // Missing derived evidence falls back to the normal rebuild (e.g. after retention).
  function touchEvidence(state,tweet,now) {
    const rootId = conversationOf(state,tweet);
    if (!rootId) return false;
    let missing = false;
    function touch(name,key,expected = true) {
      if (!expected) return;
      const record = state[name][key];
      if (!record) { missing = true; return; }
      if (record.seenAt < now) put(state,name,key,{...record,seenAt:now});
    }
    const recipientId = tweet.recipientId || state.tweets[tweet.parentId]?.authorId;
    touch("roots",rootId,Boolean(state.roots[rootId] || tweet.id === rootId || tweet.parentId === rootId && recipientId));
    if (state.accounts[tweet.authorId] && tweet.parentId && recipientId && tweet.authorId !== recipientId) {
      const key = `${tweet.authorId}:${rootId}:${recipientId}`;
      const reply = state.replies[key];
      if (!reply) missing = true;
      else if (reply.id === tweet.id) touch("replies",key);
    }
    const rootAuthorId = state.roots[rootId]?.authorId || state.tweets[rootId]?.authorId;
    if (tweet.parentId && rootAuthorId && rootAuthorId !== tweet.authorId) {
      if (state.accounts[tweet.authorId]) touch("people",`${tweet.authorId}:${rootAuthorId}`);
      if (state.accounts[rootAuthorId]) touch("people",`${rootAuthorId}:${tweet.authorId}`);
    }
    return missing;
  }

  function ingest(state, batch, accountHandle, now = Date.now()) {
    const cache = cacheFor(state);
    const hadPeople = Boolean(state.people);
    const empty = !batch?.users?.length && !batch?.tweets?.length && !batch?.likes?.length;
    let relationshipsChanged = !hadPeople || cache.expiry === 0 || empty;
    let classificationChanged = false;
    const observedTweets = [];
    state.likes ||= {};
    state.people ||= {};
    for (const raw of (Array.isArray(batch?.users) ? batch.users : []).slice(0,500)) {
      const user = cleanUser(raw);
      if (user) {
        if (state.users[user.id]?.handle !== user.handle) { relationshipsChanged = true; cache.users = null; }
        put(state,"users",user.id,{...user,seenAt:now});
      }
    }
    for (const raw of (Array.isArray(batch?.tweets) ? batch.tweets : []).slice(0,500)) {
      const tweet = cleanTweet(raw);
      if (tweet) {
        const previous = state.tweets[tweet.id];
        const merged = mergeKnown(previous,tweet,now);
        if (!previous || Object.keys(merged).some(key => key !== "seenAt" && previous[key] !== merged[key])) relationshipsChanged = true;
        put(state,"tweets",tweet.id,merged); observedTweets.push(merged);
      }
    }
    const me = findAccount(state, accountHandle);
    if (me) {
      if (!state.accounts[me.id]) relationshipsChanged = true;
      state.accounts[me.id] = now;
    }
    if (!relationshipsChanged) for (const tweet of observedTweets) {
      if (touchEvidence(state,tweet,now)) relationshipsChanged = true;
    }
    const changedLikes = new Set();
    const actors = new Map([[handle(accountHandle),me]]);
    for (const raw of (Array.isArray(batch?.likes) ? batch.likes : []).slice(0,500)) {
      const actorHandle = handle(raw.account);
      if (!actors.has(actorHandle)) actors.set(actorHandle,findAccount(state,actorHandle));
      const actor = actors.get(actorHandle);
      if (!actor || !id(raw.id) || typeof raw.liked !== "boolean" ||
          !Number.isFinite(raw.observedAt) || raw.observedAt < now - RETENTION_MS) continue;
      const key = `${actor.id}:${raw.id}`;
      const previous = state.likes[key];
      const observedAt = Math.min(raw.observedAt,now);
      // An older timeline response must not undo a newer successful like/unlike.
      if (previous && previous.observedAt > observedAt) continue;
      if (previous?.source === "mutation" && previous.observedAt === observedAt &&
          raw.source !== "mutation") continue;
      put(state,"likes",key,{
        ...previous,
        id:raw.id, actorId:actor.id, liked:raw.liked, observedAt, seenAt:now,
        source:raw.source === "mutation" ? "mutation" : "snapshot"
      });
      if (!previous) cache.likeCount++;
      if (!previous || previous.liked !== raw.liked) classificationChanged = true;
      changedLikes.add(key);
    }
    for (const like of relationshipsChanged ? Object.values(state.likes) : [...changedLikes].map(key => state.likes[key])) {
      const tweet = state.tweets[like.id];
      if (!tweet) continue;
      const conversationId = conversationOf(state,tweet) || like.conversationId || "";
      if (like.recipientId !== tweet.authorId || like.conversationId !== conversationId) {
        classificationChanged = true;
        put(state,"likes",`${like.actorId}:${like.id}`,{ ...like,recipientId:tweet.authorId,conversationId });
      }
    }
    if (relationshipsChanged) indexReplies(state);
    // Timestamp-only observations preserve the existing indexes; expiry is a safe lower bound.
    const maintenance = relationshipsChanged || now >= cache.expiry || cache.likeCount > LIMIT;
    const relationshipsPruned = maintenance ? prune(state,now) : false;
    if (relationshipsChanged || relationshipsPruned) indexPeople(state,now);
    if (maintenance) {
      prepare(state);
      cache.users = null;
      cache.lookups.clear();
    } else {
      for (const key of changedLikes) {
        const like = state.likes[key];
        const lookup = cache.lookups.get(like.actorId);
        if (lookup) updateLikeLookup(lookup,like);
      }
    }
    state.updatedAt = now;
    return relationshipsChanged || classificationChanged || maintenance;
  }

  function classifyWith(state, me, tweetId, lookup) {
    const tweet = state.tweets[id(tweetId)];
    const result = {
      id:id(tweetId), origin:"unknown", status:"unknown", rootId:"", evidenceId:"",
      likeEvidenceId:"", personStats:null, newPerson:false
    };
    const directLike = me && state.likes?.[`${me.id}:${result.id}`];
    if (directLike?.liked) result.likeEvidenceId = directLike.id;
    if (!tweet) return result;
    result.authorId = tweet.authorId;
    result.authorHandle = state.users[tweet.authorId]?.handle || "";
    const original = !tweet.parentId && tweet.conversationId === tweet.id;
    if (!original && me && tweet.authorId === me.id) return { ...result, status: "self" };
    const rootId = conversationOf(state, tweet);
    const rootAuthorId = state.roots[rootId]?.authorId;
    const origin = rootAuthorId && me ? (rootAuthorId === me.id ? "mine" : "others") : "unknown";
    const evidence = me && rootId ?
      state.replies[`${me.id}:${rootId}:${tweet.authorId}`] ||
        (original ? lookup?.comments.get(rootId) : null) : null;
    const like = me && rootId ? lookup?.likes.get(`${rootId}:${tweet.authorId}`)?.values().next().value : null;
    const person = me ? state.people?.[`${me.id}:${tweet.authorId}`] : null;
    return {
      ...result, origin, rootId, status: original ? "not-reply" : evidence ? "replied" : "unknown",
      rootHandle: state.users[rootAuthorId]?.handle || "",
      evidenceId: evidence?.id || "", evidenceText: evidence?.text || "",
      // Original cards (including quotes) need a like on that card, not on a reply below it.
      likeEvidenceId: result.likeEvidenceId || (original ? "" : like?.id || ""),
      personStats: me ? {
        myCommentedPosts:person?.myCommentedPosts || 0,
        theirCommentedPosts:person?.theirCommentedPosts || 0
      } : null,
      newPerson: Boolean(origin === "mine" && person?.myCommentedPosts === 0 &&
        person.firstCommentOnMyPostId === tweet.id)
    };
  }

  function classify(state, accountHandle, tweetId) {
    return classifyBatch(state,accountHandle,[tweetId])[0];
  }

  function classifyBatch(state, accountHandle, tweetIds) {
    const ids = Array.isArray(tweetIds) ? tweetIds.slice(0,100) : [];
    if (!ids.length) return [];
    const me = findAccount(state,accountHandle);
    if (!me) return ids.map(tweetId => classifyWith(state,null,tweetId));
    const cache = cacheFor(state);
    let lookup = cache.lookups.get(me.id);
    if (lookup) return ids.map(tweetId => classifyWith(state,me,tweetId,lookup));
    lookup = { comments:new Map(),likes:new Map() };
    for (const reply of Object.values(state.replies)) {
      if (reply.actorId === me.id && !lookup.comments.has(reply.conversationId)) lookup.comments.set(reply.conversationId,reply);
    }
    for (const tweet of Object.values(state.tweets)) {
      if (tweet.authorId !== me.id || !tweet.parentId) continue;
      const rootId = conversationOf(state,tweet);
      if (!lookup.comments.has(rootId)) lookup.comments.set(rootId,tweet);
    }
    for (const like of Object.values(state.likes || {})) {
      if (like.actorId === me.id) updateLikeLookup(lookup,like);
    }
    cache.lookups.set(me.id,lookup);
    return ids.map(tweetId => classifyWith(state,me,tweetId,lookup));
  }

  function prepare(state) {
    const cache = cacheFor(state);
    cache.expiry = Infinity;
    for (const name of ["users","tweets","roots","replies","likes","people"]) {
      for (const record of Object.values(state[name] || {})) cache.expiry = Math.min(cache.expiry,record.seenAt+RETENTION_MS+1);
    }
    for (const seenAt of Object.values(state.accounts)) cache.expiry = Math.min(cache.expiry,seenAt+RETENTION_MS+1);
    cache.likeCount = Object.keys(state.likes || {}).length;
  }

  function updateLikeLookup(lookup,like) {
    const key = `${like.conversationId}:${like.recipientId}`;
    let group = lookup.likes.get(key);
    if (like.liked) {
      if (!group) lookup.likes.set(key,group = new Map());
      group.set(like.id,like);
    } else if (group) {
      group.delete(like.id);
      if (!group.size) lookup.likes.delete(key);
    }
  }

  globalThis.XReplyContext = { extract, createState, ingest, classify, classifyBatch, findAccount, id, handle, RETENTION_MS, LIMIT, changes, saved, prepare };
})();
