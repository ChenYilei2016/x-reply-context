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
    return core.handle(path?.match(/^\/([a-zA-Z0-9_]{1,15})\/?$/)?.[1]);
  }

  function requestContext(url) {
    const operation = operationFor(url);
    if (!operation) return null;
    return {
      operation, account:currentAccount(), observedAt:Date.now(),
      reaction:operation === "FavoriteTweet" || operation === "UnfavoriteTweet"
    };
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

  async function replyBody(request) {
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
        if (bytes > 512 * 1024) { void reader.cancel().catch(() => {}); return ""; }
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
      const parsed = core.extract(payload);
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
      account:context.account,requestId:context.requestId,startedAt:context.observedAt,status,batch },location.origin);
    return status === "sent";
  }

  function flush() {
    timer = undefined;
    if (!ready || (!pendingTweets.size && !pendingUsers.size && !pendingLikes.size)) return;
    window.postMessage({
      channel: CHANNEL, type: "OBSERVED",
      batch: {
        users:[...pendingUsers.values()], tweets:[...pendingTweets.values()], likes:[...pendingLikes.values()]
      }
    }, location.origin);
    pendingUsers.clear();
    pendingTweets.clear();
    pendingLikes.clear();
  }

  async function accept(payload,context) {
    try {
      if (REPLY_RESULTS[context.operation]) {
        const sent = await replyResult(context,"unknown",payload);
        // Validated replies use one immediate save path, including native replies.
        if (sent || payload.errors?.length) return;
      }
      const batch = core.extract(payload);
      let likes = batch.likes;
      if (context.reaction) {
        const responseAt = Date.now();
        const tweetId = await context.tweetId;
        const key = context.operation === "FavoriteTweet" ? "favorite_tweet" : "unfavorite_tweet";
        likes = !payload.errors?.length && payload.data?.[key] === "Done" && tweetId ?
          [{ id:tweetId,liked:context.operation === "FavoriteTweet",observedAt:responseAt }] : [];
      }
      for (const user of batch.users) {
        if (pendingUsers.size < 500 || pendingUsers.has(user.id)) pendingUsers.set(user.id,user);
      }
      for (const tweet of batch.tweets) {
        if (pendingTweets.size < 500 || pendingTweets.has(tweet.id)) pendingTweets.set(tweet.id,tweet);
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
          if (pendingLikes.size < 500 || previous) pendingLikes.set(key,record);
        }
      }
      if (!timer) timer = setTimeout(flush,200);
    } catch {
      // A changed X response must not interfere with the original request.
      void replyResult(context,"unknown");
    }
  }

  window.addEventListener("message", event => {
    if (event.source === window && event.origin === location.origin &&
        event.data?.channel === CHANNEL && event.data.type === "READY") {
      ready = true;
      flush();
    }
  });
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
        try { context.tweetId = request.clone().text().then(reactionId,() => ""); }
        catch { context.tweetId = ""; }
      }
    }
    if (context && REPLY_RESULTS[context.operation]) {
      const body = args[1]?.body !== undefined ? args[1].body :
        typeof Request !== "undefined" && request instanceof Request ? replyBody(request) : "";
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
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method,url,...rest) {
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
      for (const event of ["error","abort","timeout"]) {
        this.addEventListener(event,() => { void replyResult(context,"unknown"); },{ once:true });
      }
      this.addEventListener("load", () => {
        if (this.status < 200 || this.status >= 300) { void replyResult(context,failureStatus(this.status)); return; }
        try {
          const value = key => notificationNetwork ? notificationNetwork.originalXHR(this,key) : this[key];
          if (this.responseType === "json") void accept(value("response"),context);
          else if ((!this.responseType || this.responseType === "text") &&
                   value("responseText").length <= MAX_BYTES) void accept(JSON.parse(value("responseText")),context);
          else void replyResult(context,"unknown");
        } catch { void replyResult(context,"unknown"); }
      }, { once:true });
    }
    const send = () => Reflect.apply(originalSend,this,args);
    return notificationNetwork ? notificationNetwork.sendXHR(this,send) : send();
  };
})();
