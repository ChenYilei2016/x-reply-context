(() => {
  "use strict";
  const core = globalThis.XReplyContext;
  const CHANNEL = "x-reply-context-v1";
  const MAX_BYTES = 8 * 1024 * 1024;
  const REPLY_RESULTS = { CreateTweet:"create_tweet",CreateNoteTweet:"notetweet_create" };
  const pendingUsers = new Map();
  const pendingTweets = new Map();
  const pendingLikes = new Map();
  let ready = false;
  let timer;
  let replySequence = 0;
  const follows = globalThis.XReplyFollowContext?.create();
  let followEpoch = 0, followSequence = 0;
  const failureStatus = status => status >= 400 && status < 500 && status !== 408 ? "failed" : "unknown";

  function operationFor(value) {
    try {
      const url = new URL(value, location.href);
      if (url.origin !== location.origin) return "";
      if (/^\/i\/api\/2\/notifications\/(?:all|mentions|verified)\.json$/.test(url.pathname)) return "Notifications";
      return url.pathname.match(/^\/i\/api\/graphql\/[\w-]+\/(TweetDetail|TweetResultByRestId|TweetResultsByRestIds|UserTweets|UserTweetsAndReplies|UserRepliesTimeline|UserByScreenName|HomeTimeline|HomeLatestTimeline|NotificationsTimeline|SearchTimeline|CreateTweet|CreateNoteTweet|Likes|FavoriteTweet|UnfavoriteTweet)$/)?.[1] || "";
    } catch { return ""; }
  }

  function currentAccount() {
    const path = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute("href");
    const account = core.handle(path?.match(/^\/([a-zA-Z0-9_]{1,15})\/?$/)?.[1]);
    if (follows?.setAccount(account)) followEpoch++;
    return account;
  }

  function requestContext(url) {
    const operation = operationFor(url);
    if (!operation) return null;
    return {
      operation, account:currentAccount(), observedAt:Date.now(),followEpoch,followOrder:++followSequence,
      reaction:operation === "FavoriteTweet" || operation === "UnfavoriteTweet"
    };
  }

  function publishFollows(account,rows) {
    if (rows.length) window.postMessage({channel:CHANNEL,type:"FOLLOW_CONTEXT",account,rows},location.origin);
  }

  function extractObserved(payload,context) {
    const account = currentAccount();
    let rows = [];
    const collect = follows && context.account && context.account === account && context.followEpoch === followEpoch ? relation => {
      follows.ingest(account,[relation],context.followOrder);
      if (!ready) return;
      // Send current snapshots even if unchanged: the other world's bounded cache may have evicted this ID.
      const record = follows.read(account,relation.id);
      if (record) rows.push(record);
      if (rows.length >= 500) {publishFollows(account,rows);rows=[];}
    } : undefined;
    const parsed = core.extract(payload,collect);
    if (ready) publishFollows(account,rows);
    return parsed;
  }

  function reactionId(body) {
    try {
      if (typeof body !== "string" || body.length > 4096) return "";
      return core.id(JSON.parse(body)?.variables?.tweet_id);
    } catch { return ""; }
  }

  function replyParentId(body) {
    try {
      if (typeof body !== "string" || body.length > 512 * 1024) return "";
      return core.id(JSON.parse(body)?.variables?.reply?.in_reply_to_tweet_id);
    } catch { return ""; }
  }

  async function requestBody(request,limit) {
    const reader = request.clone().body?.getReader();
    if (!reader) return "";
    const decoder = new TextDecoder();
    let body = "";
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) return body + decoder.decode();
        bytes += chunk.value.byteLength;
        if (bytes > limit) { void reader.cancel().catch(() => {}); return ""; }
        body += decoder.decode(chunk.value,{ stream:true });
      }
    } catch { return ""; }
    finally { reader.releaseLock(); }
  }

  function watchReply(context,body) {
    if (!REPLY_RESULTS[context.operation]) return;
    context.requestId = `${context.observedAt}:${++replySequence}`;
    // Keep only the reply target, never the outgoing draft or media payload.
    context.replyParent = Promise.resolve(body).then(replyParentId,() => "");
    void context.replyParent.then(parentId => {
      if (parentId && context.account && context.account === currentAccount()) {
        window.postMessage({ channel:CHANNEL,type:"REPLY_STARTED",parentId,
          account:context.account,requestId:context.requestId,startedAt:context.observedAt },location.origin);
      }
    });
  }

  async function replyResult(context,status,payload) {
    if (!REPLY_RESULTS[context.operation] || context.replyFinished) return;
    context.replyFinished = true;
    const parentId = await context.replyParent;
    if (!parentId || !context.account || context.account !== currentAccount()) return;
    let batch;
    if (payload) {
      const result = payload.data?.[REPLY_RESULTS[context.operation]]?.tweet_results?.result;
      const parsed = extractObserved(payload,context);
      const createdId = core.id(result?.rest_id || result?.tweet?.rest_id || result?.legacy?.id_str);
      const tweet = parsed.tweets.find(item => item.id === createdId && item.parentId === parentId);
      const user = tweet && parsed.users.find(item => item.id === tweet.authorId && item.handle === context.account);
      if (!payload.errors?.length && tweet && user) {
        status = "sent";
        batch = {
          users:[user,...parsed.users.filter(item => item.id !== user.id)],
          tweets:[tweet,...parsed.tweets.filter(item => item.id !== tweet.id)],
          likes:parsed.likes.map(like => ({ ...like,account:context.account,
            observedAt:context.observedAt,source:"snapshot" }))
        };
      } else status = payload.errors?.length && !createdId ? "failed" : "unknown";
    }
    window.postMessage({ channel:CHANNEL,type:"REPLY_RESULT",parentId,
      account:context.account,requestId:context.requestId,startedAt:context.observedAt,status,
      batch:batch && Object.fromEntries(Object.entries(batch).map(([name,items]) => [name,items.slice(0,500)])) },location.origin);
    return status === "sent" ? batch : null;
  }

  function flush() {
    clearTimeout(timer); timer = undefined;
    if (!ready) return;
    while (pendingTweets.size || pendingUsers.size || pendingLikes.size) {
      const batch = {};
      for (const [name,records] of [["users",pendingUsers],["tweets",pendingTweets],["likes",pendingLikes]]) {
        batch[name] = [];
        for (const [key,record] of records) {
          batch[name].push(record); records.delete(key);
          if (batch[name].length === 500) break;
        }
      }
      window.postMessage({ channel:CHANNEL,type:"OBSERVED",batch },location.origin);
    }
  }

  async function accept(payload,context) {
    try {
      let batch;
      if (REPLY_RESULTS[context.operation]) {
        const saved = await replyResult(context,"unknown",payload);
        // The created reply stays in the immediate batch; extra context uses normal bounded batches.
        if (saved) batch = Object.fromEntries(Object.entries(saved).map(([name,items]) => [name,items.slice(500)]));
        else if (payload.errors?.length) return;
      }
      batch ||= extractObserved(payload,context);
      let likes = batch.likes;
      if (context.reaction) {
        const responseAt = Date.now();
        const tweetId = await context.tweetId;
        const key = context.operation === "FavoriteTweet" ? "favorite_tweet" : "unfavorite_tweet";
        likes = !payload.errors?.length && payload.data?.[key] === "Done" && tweetId ?
          [{ id:tweetId,liked:context.operation === "FavoriteTweet",observedAt:responseAt }] : [];
        if (ready) {
          if (likes.length && context.account && context.account === currentAccount()) {
            window.postMessage({ channel:CHANNEL,type:"OBSERVED",interaction:true,account:context.account,
              batch:{ users:batch.users.slice(0,500),tweets:batch.tweets.slice(0,500),likes:likes.map(like =>
                ({ ...like,account:context.account,source:"mutation" })) } },location.origin);
            batch.users = batch.users.slice(500); batch.tweets = batch.tweets.slice(500);
          }
          likes = [];
        }
      }
      for (const user of batch.users) {
        pendingUsers.set(user.id,user);
        if (ready && pendingUsers.size >= 500) flush();
      }
      for (const tweet of batch.tweets) {
        const merged = { ...pendingTweets.get(tweet.id) };
        for (const [field,value] of Object.entries(tweet)) if (value !== "") merged[field] = value;
        pendingTweets.set(tweet.id,merged);
        if (ready && pendingTweets.size >= 500) flush();
      }
      // Like state belongs to the viewer, not the tweet author; discard it across an account switch.
      if (context.account && context.account === currentAccount()) {
        for (const like of likes) {
          const key = `${context.account}:${like.id}`;
          const record = {
            ...like,account:context.account,observedAt:like.observedAt || context.observedAt,
            source:context.reaction ? "mutation" : "snapshot"
          };
          const previous = pendingLikes.get(key);
          if (previous && (previous.observedAt > record.observedAt ||
              (previous.observedAt === record.observedAt && previous.source === "mutation" && !context.reaction))) continue;
          pendingLikes.set(key,record);
          if (ready && pendingLikes.size >= 500) flush();
        }
      }
      if (!timer && (pendingUsers.size || pendingTweets.size || pendingLikes.size)) timer = setTimeout(flush,200);
    } catch {
      // A changed X response must not interfere with the original request.
      void replyResult(context,"unknown");
    }
  }

  window.addEventListener("message", event => {
    if (event.source === window && event.origin === location.origin &&
        event.data?.channel === CHANNEL) {
      if (["READY","NOTIFICATION_FILTER_CONTEXT"].includes(event.data.type)) currentAccount();
      if (event.data.type === "READY") {
        if (!ready && follows) {
          const account = currentAccount(); let rows = [];
          for (const row of follows.values()) {
            rows.push(row);
            if (rows.length === 500) {publishFollows(account,rows);rows=[];}
          }
          publishFollows(account,rows);
        }
        ready = true;
        flush();
      }
    }
  });
  window.addEventListener("pagehide",() => {follows?.clear();followEpoch++;});
  window.postMessage({ channel:CHANNEL,type:"OBSERVER_READY" },location.origin);

  async function responsePayload(response) {
    if (!response.ok) return null;
    if (!response.body ||
        !response.headers.get("content-type")?.includes("json") ||
        Number(response.headers.get("content-length")) > MAX_BYTES) {
      return null;
    }
    const reader = response.clone().body.getReader();
    const decoder = new TextDecoder();
    let body = "";
    let bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BYTES) {
          void reader.cancel().catch(() => {});
          return null;
        }
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
      return JSON.parse(body);
    } catch { return null; }
    finally { reader.releaseLock(); }
  }

  async function readResponse(response,context) {
    if (!response.ok) { void replyResult(context,failureStatus(response.status)); return; }
    const payload = await responsePayload(response);
    if (payload) await accept(payload,context);
    else void replyResult(context,"unknown");
  }

  const notificationNetwork = globalThis.XReplyNotificationNetwork?.create({
    accountHandle:currentAccount,readPayload:responsePayload,observe:accept
  });

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const request = args[0];
    const url = typeof request === "string" || request instanceof URL ? String(request) : request?.url;
    const context = requestContext(url);
    if (context?.reaction) {
      if (args[1]?.body !== undefined) context.tweetId = reactionId(args[1].body);
      else if (typeof Request !== "undefined" && request instanceof Request) {
        // Read only the target ID from a cloned like request; leave the original body untouched.
        try { context.tweetId = requestBody(request,4096).then(reactionId,() => ""); }
        catch { context.tweetId = ""; }
      }
    }
    if (context && REPLY_RESULTS[context.operation]) {
      const body = args[1]?.body !== undefined ? args[1].body :
        typeof Request !== "undefined" && request instanceof Request ? requestBody(request,512 * 1024) : "";
      watchReply(context,body);
    }
    const send = () => Reflect.apply(originalFetch,this,args);
    const method = String(args[1]?.method || request?.method || "GET").toUpperCase();
    if (method === "GET" && notificationNetwork?.handles(context)) return notificationNetwork.fetch(args,context,send);
    const responsePromise = send();
    if (context) void responsePromise.then(response => readResponse(response,context))
      .catch(() => replyResult(context,"unknown"));
    return responsePromise;
  };

  const requestContexts = new WeakMap();
  const xhrCleanups = new WeakMap();
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method,url,...rest) {
    xhrCleanups.get(this)?.();
    const context = requestContext(url);
    requestContexts.set(this,context);
    notificationNetwork?.prepareXHR(this,context,url,method);
    return Reflect.apply(originalOpen,this,[method,url,...rest]);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    const context = requestContexts.get(this);
    if (context) {
      context.account = currentAccount();
      context.observedAt = Date.now();
      if (context.reaction) context.tweetId = reactionId(args[0]);
      watchReply(context,args[0]);
      const active = () => requestContexts.get(this) === context;
      const failed = () => { if (active()) void replyResult(context,"unknown"); cleanup(); };
      const loaded = () => {
        if (!active()) return;
        if (this.status < 200 || this.status >= 300) { void replyResult(context,failureStatus(this.status)); return; }
        try {
          const value = key => notificationNetwork ? notificationNetwork.originalXHR(this,key) : this[key];
          if (this.responseType === "json") void accept(value("response"),context);
          else if ((!this.responseType || this.responseType === "text") &&
                   value("responseText").length <= MAX_BYTES) void accept(JSON.parse(value("responseText")),context);
          else void replyResult(context,"unknown");
        } catch { void replyResult(context,"unknown"); }
      };
      const cleanup = () => {
        for (const event of ["error","abort","timeout"]) this.removeEventListener(event,failed);
        this.removeEventListener("load",loaded);
        this.removeEventListener("loadend",cleanup);
        if (xhrCleanups.get(this) === cleanup) xhrCleanups.delete(this);
      };
      xhrCleanups.set(this,cleanup);
      for (const event of ["error","abort","timeout"]) this.addEventListener(event,failed,{once:true});
      this.addEventListener("load",loaded,{once:true});
      this.addEventListener("loadend",cleanup,{once:true});
    }
    const send = () => Reflect.apply(originalSend,this,args);
    return notificationNetwork ? notificationNetwork.sendXHR(this,send) : send();
  };
})();
