/* Shared by the page observer, service worker and the focused self-checks. */
(() => {
  "use strict";
  const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
  const LIMIT = 10000;
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

  function extract(payload) {
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
      if (user) users.set(user.id, user);
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
            tweets.set(tweet.id, { ...tweets.get(tweet.id), ...tweet });
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
      users: [...users.values()].slice(0,500), tweets: [...tweets.values()].slice(0,500),
      likes: [...likes.values()].slice(0,500)
    };
  }

  function createState() {
    return { version: 1, users: {}, tweets: {}, roots: {}, replies: {}, likes: {}, people: {}, accounts: {}, updatedAt: 0 };
  }

  function mergeKnown(previous, next, now) {
    const result = { ...previous };
    for (const [key, value] of Object.entries(next)) if (value !== "") result[key] = value;
    result.seenAt = now;
    return result;
  }

  function findAccount(state, accountHandle) {
    const name = handle(accountHandle);
    if (!name) return null;
    return Object.values(state.users).find(user => user.handle === name) || null;
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
        state.roots[rootId] = {
          id: rootId, authorId: rootAuthor,
          seenAt: Math.max(tweet.seenAt,state.roots[rootId]?.seenAt || 0)
        };
      }
      if (!state.accounts[tweet.authorId] || !tweet.parentId || !recipientId ||
          tweet.authorId === recipientId) continue;
      const key = `${tweet.authorId}:${rootId}:${recipientId}`;
      const previous = state.replies[key];
      if (!previous || BigInt(tweet.id) >= BigInt(previous.id)) {
        state.replies[key] = {
          id: tweet.id, actorId: tweet.authorId, conversationId: rootId,
          recipientId, text: tweet.text || "", seenAt: tweet.seenAt
        };
      }
    }
  }

  function commentOnRoot(state, actorId, rootId) {
    return Object.values(state.replies).find(reply =>
      reply.actorId === actorId && reply.conversationId === rootId) ||
      Object.values(state.tweets).find(tweet => tweet.authorId === actorId &&
        tweet.parentId && conversationOf(state,tweet) === rootId);
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
      state[key] = retained;
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
    state.people = retainRecords(people,now);
  }

  function ingest(state, batch, accountHandle, now = Date.now()) {
    const hadPeople = Boolean(state.people);
    state.likes ||= {};
    state.people ||= {};
    for (const raw of (Array.isArray(batch?.users) ? batch.users : []).slice(0,500)) {
      const user = cleanUser(raw);
      if (user) state.users[user.id] = { ...user, seenAt: now };
    }
    for (const raw of (Array.isArray(batch?.tweets) ? batch.tweets : []).slice(0,500)) {
      const tweet = cleanTweet(raw);
      if (tweet) state.tweets[tweet.id] = mergeKnown(state.tweets[tweet.id], tweet, now);
    }
    const me = findAccount(state, accountHandle);
    const likesOnly = Boolean(hadPeople && batch?.likes?.length && !batch?.users?.length &&
      !batch?.tweets?.length && me && state.accounts[me.id]);
    if (me) state.accounts[me.id] = now;
    const changedLikes = [];
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
      state.likes[key] = {
        ...previous,
        id:raw.id, actorId:actor.id, liked:raw.liked, observedAt, seenAt:now,
        source:raw.source === "mutation" ? "mutation" : "snapshot"
      };
      changedLikes.push(state.likes[key]);
    }
    for (const like of likesOnly ? changedLikes : Object.values(state.likes)) {
      const tweet = state.tweets[like.id];
      if (!tweet) continue;
      const conversationId = conversationOf(state,tweet) || like.conversationId || "";
      if (like.recipientId !== tweet.authorId || like.conversationId !== conversationId) {
        state.likes[`${like.actorId}:${like.id}`] = { ...like,recipientId:tweet.authorId,conversationId };
      }
    }
    if (!likesOnly) indexReplies(state);
    const relationshipsPruned = prune(state, now);
    if (!likesOnly || relationshipsPruned) indexPeople(state, now);
    state.updatedAt = now;
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
    result.authorHandle = state.users[tweet.authorId]?.handle || "";
    const original = !tweet.parentId && tweet.conversationId === tweet.id;
    if (!original && me && tweet.authorId === me.id) return { ...result, status: "self" };
    const rootId = conversationOf(state, tweet);
    const rootAuthorId = state.roots[rootId]?.authorId;
    const origin = rootAuthorId && me ? (rootAuthorId === me.id ? "mine" : "others") : "unknown";
    const evidence = me && rootId ?
      state.replies[`${me.id}:${rootId}:${tweet.authorId}`] ||
        (original ? (lookup ? lookup.comments.get(rootId) : commentOnRoot(state,me.id,rootId)) : null) : null;
    const like = me && rootId ? (lookup ? lookup.likes.get(`${rootId}:${tweet.authorId}`) :
      Object.values(state.likes || {}).find(item => item.liked && item.actorId === me.id &&
        item.conversationId === rootId && item.recipientId === tweet.authorId)) : null;
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
    return classifyWith(state,findAccount(state,accountHandle),tweetId);
  }

  function classifyBatch(state, accountHandle, tweetIds) {
    const ids = Array.isArray(tweetIds) ? tweetIds.slice(0,100) : [];
    if (!ids.length) return [];
    const me = findAccount(state,accountHandle);
    if (!me) return ids.map(tweetId => classifyWith(state,null,tweetId));
    // Build once per batch, preserving first-match order without a persistent cache or invalidation rules.
    const lookup = { comments:new Map(),likes:new Map() };
    for (const reply of Object.values(state.replies)) {
      if (reply.actorId === me.id && !lookup.comments.has(reply.conversationId)) lookup.comments.set(reply.conversationId,reply);
    }
    for (const tweet of Object.values(state.tweets)) {
      if (tweet.authorId !== me.id || !tweet.parentId) continue;
      const rootId = conversationOf(state,tweet);
      if (!lookup.comments.has(rootId)) lookup.comments.set(rootId,tweet);
    }
    for (const like of Object.values(state.likes || {})) {
      const key = `${like.conversationId}:${like.recipientId}`;
      if (like.liked && like.actorId === me.id && !lookup.likes.has(key)) lookup.likes.set(key,like);
    }
    return ids.map(tweetId => classifyWith(state,me,tweetId,lookup));
  }

  globalThis.XReplyContext = { extract, createState, ingest, classify, classifyBatch, findAccount, id, handle, RETENTION_MS, LIMIT };
})();
