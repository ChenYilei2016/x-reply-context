(() => {
  "use strict";
  const core = globalThis.XReplyContext;
  const postVideo = globalThis.XReplyPostVideo;
  const aiContext = globalThis.XReplyAIContext;
  const CHANNEL = "x-reply-context-v1";
  const MAX_BYTES = 8 * 1024 * 1024;
  const REPLY_RESULTS = { CreateTweet:"create_tweet",CreateNoteTweet:"notetweet_create" };
  const pendingUsers = new Map();
  const pendingTweets = new Map();
  const pendingLikes = new Map();
  const pendingUserCounts = new Map();
  let pendingPostVideo;
  let ready = false;
  let timer;
  let replySequence = 0;
  const failureStatus = status => status >= 400 && status < 500 && status !== 408 ? "failed" : "unknown";

  function operationFor(value) {
    try {
      const url = new URL(value, location.href);
      if (url.origin !== location.origin) return "";
      if (/^\/i\/api\/2\/notifications\/(?:all|mentions|verified)\.json$/.test(url.pathname)) return "Notifications";
      return url.pathname.match(/^\/i\/api\/graphql\/[\w-]+\/(TweetDetail|TweetResultByRestId|TweetResultsByRestIds|UserTweets|UserTweetsAndReplies|UserRepliesTimeline|UserByScreenName|HomeTimeline|HomeLatestTimeline|NotificationsTimeline|Following|Followers|BlueVerifiedFollowers|SearchTimeline|CreateTweet|CreateNoteTweet|Likes|FavoriteTweet|UnfavoriteTweet)$/)?.[1] || "";
    } catch { return ""; }
  }

  function currentAccount() {
    const path = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute("href");
    const account = core.handle(path?.match(/^\/([a-zA-Z0-9_]{1,15})\/?$/)?.[1]);
    return account;
  }

  function requestContext(url) {
    const operation = operationFor(url);
    if (!operation) return null;
    return {
      operation,account:currentAccount(),observedAt:Date.now(),
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
    const warning=responseWarning(payload,context);
    if (payload) {
      const result = payload.data?.[REPLY_RESULTS[context.operation]]?.tweet_results?.result;
      const parsed = core.extract(payload);
      const createdId = core.id(result?.rest_id || result?.tweet?.rest_id || result?.legacy?.id_str);
      const tweet = parsed.tweets.find(item => item.id === createdId && item.parentId === parentId);
      const user = tweet && parsed.users.find(item => item.id === tweet.authorId && item.handle === context.account);
      if (!warning.hasErrors && tweet && user) {
        status = "sent";
        batch = {
          users:[user,...parsed.users.filter(item => item.id !== user.id)],
          tweets:[tweet,...parsed.tweets.filter(item => item.id !== tweet.id)],
          likes:parsed.likes.map(like => ({ ...like,account:context.account,
            observedAt:context.observedAt,source:"snapshot" }))
        };
      } else status = warning.hasErrors && !createdId ? "failed" : "unknown";
    }
    if (status!=="sent" || warning.present) {
      await interactionAlert(context,{payload,reason:status==="sent"?"warning":status});
    }
    window.postMessage({ channel:CHANNEL,type:"REPLY_RESULT",parentId,
      account:context.account,requestId:context.requestId,startedAt:context.observedAt,status,
      batch:batch && Object.fromEntries(Object.entries(batch).map(([name,items]) => [name,items.slice(0,500)])) },location.origin);
    return status === "sent" ? batch : null;
  }

  function responseWarning(payload,context) {
    const result=payload?.data?.[REPLY_RESULTS[context.operation]]?.tweet_results?.result;
    const operationResult=payload?.data?.[REPLY_RESULTS[context.operation]];
    const errors=[payload?.errors,operationResult?.errors,result?.errors].flatMap(items=>Array.isArray(items)?items.slice(0,3):[]);
    const entries=[...errors,...[payload?.warnings,operationResult?.warnings,result?.warnings]
      .flatMap(items=>Array.isArray(items)?items.slice(0,3):[])];
    const messages=entries.map(item=>typeof item === "string" ? item : item?.message)
      .filter(text=>typeof text === "string").map(text=>text.slice(0,240));
    const code=entries.find(item=>typeof item?.code === "number" || typeof item?.code === "string")?.code;
    return {present:entries.length>0,hasErrors:errors.length>0,message:messages.join("；").slice(0,600),code:code===undefined?"":String(code).slice(0,40)};
  }

  async function interactionAlert(context,{status=context.httpStatus || 0,payload,reason="unknown",retryAfter=""}={}) {
    if ((!context.reaction && !REPLY_RESULTS[context.operation]) || context.alerted) return;
    const targetId=await (context.reaction?context.tweetId:context.replyParent);
    if (!targetId || !context.account || context.account!==currentAccount() || context.alerted) return;
    context.alerted=true;
    const warning=responseWarning(payload,context);
    window.postMessage({channel:CHANNEL,type:"INTERACTION_ALERT",account:context.account,
      operation:context.operation,targetId,httpStatus:status,reason,code:warning.code,
      message:warning.message,retryAfter:String(retryAfter || "").slice(0,100)},location.origin);
  }

  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;

  function rememberUserCounts(handle,node) {
    const legacy = node.legacy || node;
    const following = count(node.relationship_counts?.following ?? legacy.friends_count);
    const followers = count(node.relationship_counts?.followers ?? legacy.followers_count);
    if (following === undefined && followers === undefined) return;
    pendingUserCounts.set(handle,{ handle,following,followers });
    if (pendingUserCounts.size > 500) pendingUserCounts.delete(pendingUserCounts.keys().next().value);
  }

  function readPeopleListCounts(payload) {
    const instructions = payload?.data?.user?.result?.timeline?.timeline?.instructions;
    if (!Array.isArray(instructions)) return;
    for (const instruction of instructions.slice(0,100)) {
      const entries = Array.isArray(instruction?.entries) ? instruction.entries.slice(0,500) : [instruction?.entry];
      for (const entry of entries) {
        const item = entry?.content?.itemContent;
        if (item?.itemType !== "TimelineUser") continue;
        const user = item.user_results?.result;
        const handle = core.handle(user?.core?.screen_name || user?.legacy?.screen_name);
        if (handle) rememberUserCounts(handle,user);
      }
    }
  }

  function flushUserCounts() {
    if (!ready || !pendingUserCounts.size) return;
    window.postMessage({ channel:CHANNEL,type:"USER_COUNTS",users:[...pendingUserCounts.values()] },location.origin);
    pendingUserCounts.clear();
  }

  function flushPostVideo() {
    if (!ready || !pendingPostVideo) return;
    window.postMessage({ channel:CHANNEL,type:"POST_VIDEO_MEDIA",...pendingPostVideo },location.origin);
    pendingPostVideo = undefined;
  }

  function flush() {
    clearTimeout(timer); timer = undefined;
    if (!ready) return;
    flushUserCounts();
    flushPostVideo();
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
      if (["Following","Followers","BlueVerifiedFollowers"].includes(context.operation)) {
        readPeopleListCounts(payload);
        flushUserCounts();
        return;
      }
      let batch;
      if (REPLY_RESULTS[context.operation]) {
        const saved = await replyResult(context,"unknown",payload);
        // The created reply stays in the immediate batch; extra context uses normal bounded batches.
        if (saved) batch = Object.fromEntries(Object.entries(saved).map(([name,items]) => [name,items.slice(500)]));
        else if (payload?.errors?.length || await context.replyParent) return;
      }
      const includeCounts = ["HomeTimeline","NotificationsTimeline","Notifications"].includes(context.operation);
      const post = location.pathname?.includes("/status/") && postVideo?.parsePostLink(location.href);
      const aiAccount = context.account || currentAccount();
      const legacyObjects = payload?.globalObjects;
      let mp4, photos;
      batch ||= core.extract(payload,includeCounts ? (user,node) => rememberUserCounts(user.handle,node) : undefined,
        post || aiContext ? (tweet,node) => {
          if (post && tweet.id === post.id && !mp4) mp4 = postVideo.selectMp4(node);
          const legacyAuthor = legacyObjects?.tweets?.[tweet.id] === node ? legacyObjects.users?.[tweet.authorId] : undefined;
          const photo = aiContext?.photoFromTweet(node,legacyAuthor);
          if (photo) (photos ||= new Map()).set(tweet.id,photo);
        } : undefined);
      if (includeCounts) flushUserCounts();
      if (mp4 || mp4 === "" && context.operation === "TweetDetail") {
        pendingPostVideo = { id:post.id,url:mp4 };
        flushPostVideo();
      }
      let likes = batch.likes;
      if (context.reaction) {
        const responseAt = Date.now();
        const tweetId = await context.tweetId;
        const key = context.operation === "FavoriteTweet" ? "favorite_tweet" : "unfavorite_tweet";
        likes = !payload.errors?.length && payload.data?.[key] === "Done" && tweetId ?
          [{ id:tweetId,liked:context.operation === "FavoriteTweet",observedAt:responseAt }] : [];
        if (!likes.length || responseWarning(payload,context).present) {
          await interactionAlert(context,{payload,reason:likes.length?"warning":payload?.errors?.length?"failed":"unknown"});
        }
        if (!likes.length) return;
        if (ready) {
          if (likes.length && context.account && context.account === currentAccount()) {
            window.postMessage({ channel:CHANNEL,type:"OBSERVED",interaction:true,account:context.account,requestStartedAt:context.observedAt,
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
        if (merged.aiAccount !== aiAccount) delete merged.aiPhoto;
        for (const [field,value] of Object.entries(tweet)) if (value !== "") merged[field] = value;
        merged.aiAccount = aiAccount;
        const photo = photos?.get(tweet.id);
        if (photo) merged.aiPhoto = photo;
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
      void interactionAlert(context);
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

  async function responsePayload(response,limit=MAX_BYTES,allowError=false) {
    if (!response.ok && !allowError) return null;
    if (!response.body ||
        !response.headers.get("content-type")?.includes("json") ||
        Number(response.headers.get("content-length")) > limit) {
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
        if (bytes > limit) {
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
    context.httpStatus=response.status;
    if (!response.ok) {
      // Read only a bounded JSON error body; the native response stays untouched.
      const payload=(context.reaction || REPLY_RESULTS[context.operation])?
        await responsePayload(response,64*1024,true):null;
      await interactionAlert(context,{status:response.status,payload,reason:failureStatus(response.status),
        retryAfter:response.headers.get("retry-after")});
      void replyResult(context,failureStatus(response.status));return;
    }
    const payload = await responsePayload(response);
    if (payload) await accept(payload,context);
    else {await interactionAlert(context);void replyResult(context,"unknown");}
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
      .catch(() => {void interactionAlert(context,{reason:"network"});return replyResult(context,"unknown");});
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
      const failed = () => { if (active()) {void interactionAlert(context,{reason:"network"});void replyResult(context,"unknown");} cleanup(); };
      const loaded = () => {
        if (!active()) return;
        context.httpStatus=this.status;
        if (this.status < 200 || this.status >= 300) {
          let payload;
          try {
            if (this.responseType==="json") payload=this.response;
            else if ((!this.responseType || this.responseType==="text") && this.responseText.length<=64*1024) payload=JSON.parse(this.responseText);
          } catch { /* HTTP status still identifies a failed or uncertain operation. */ }
          void interactionAlert(context,{status:this.status,payload,reason:failureStatus(this.status),retryAfter:this.getResponseHeader?.("retry-after")});
          void replyResult(context,failureStatus(this.status));return;
        }
        try {
          const value = key => notificationNetwork ? notificationNetwork.originalXHR(this,key) : this[key];
          if (this.responseType === "json") void accept(value("response"),context);
          else if ((!this.responseType || this.responseType === "text") &&
                   value("responseText").length <= MAX_BYTES) void accept(JSON.parse(value("responseText")),context);
          else {void interactionAlert(context);void replyResult(context,"unknown");}
        } catch {void interactionAlert(context);void replyResult(context,"unknown");}
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
