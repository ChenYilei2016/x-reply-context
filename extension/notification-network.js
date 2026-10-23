(() => {
  "use strict";
  const CHANNEL = "x-reply-context-v1";
  const MAX_BYTES = 8*1024*1024;

  function rewrite(payload,settings) {
    const timeline = payload?.data?.viewer_v2?.user_results?.result?.notification_timeline?.timeline || payload?.timeline;
    if (!Array.isArray(timeline?.instructions)) return null;
    if (timeline.instructions.length > 100 || timeline.instructions.reduce((count,item) =>
      count+(item?.entries?.length || item?.addEntries?.entries?.length || 0),0) > 5000) return null;
    let removed = 0;
    let remaining = 0;
    const cursors = [];
    function keep(entry) {
      const content = entry?.content;
      const cursor = content?.entryType === "TimelineTimelineCursor" ? content : content?.operation?.cursor;
      if (cursor) { cursors.push({ type:cursor.cursorType,value:cursor.value }); return true; }
      const item = content?.itemContent;
      const ref = content?.item?.content?.notification;
      const notification = item?.itemType === "TimelineNotification" ? item :
        ref && payload.globalObjects?.notifications?.[ref.id];
      const icon = notification?.notification_icon || notification?.icon?.id;
      if ((settings.likes && icon === "heart_icon") || (settings.follows && icon === "person_icon") ||
          (settings.reposts && icon === "retweet_icon")) {
        removed++; return false;
      }
      remaining++;
      return true;
    }
    timeline.instructions = timeline.instructions.filter(instruction => {
      const container = instruction?.type === "TimelineAddEntries" ? instruction : instruction?.addEntries;
      if (Array.isArray(container?.entries)) container.entries = container.entries.filter(keep);
      const replacement = instruction?.type === "TimelineReplaceEntry" ? instruction.entry : instruction?.replaceEntry?.entry;
      return replacement ? keep(replacement) : true;
    });
    return { removed,remaining,cursors };
  }

  function create({ accountHandle,readPayload,observe }) {
    let settings = { likes:true,follows:true,reposts:false };
    let settingsReady = false;
    let notifyReady;
    const ready = new Promise(resolve => { notifyReady = resolve; });
    const states = new Map();
    const xhrContexts = new WeakMap();
    const descriptors = Object.fromEntries(["response","responseText"].map(key =>
      [key,Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype,key)]));
    const originalAbort = XMLHttpRequest.prototype.abort;
    const active = () => /^\/(?:notifications|compose)(?:\/|$)/.test(location.pathname);
    const error = () => new DOMException("Notification pagination paused or cancelled","AbortError");
    const handles = context => ["Notifications","NotificationsTimeline"].includes(context?.operation);

    function request(context,url) {
      const parsed = new URL(url,location.href);
      let variables = {};
      try { variables = JSON.parse(parsed.searchParams.get("variables") || "{}"); } catch { /* Unknown input stays native. */ }
      const timeline = variables.timeline_type || parsed.pathname.match(/notifications\/(all|mentions|verified)/)?.[1] || "All";
      const account = context.account || accountHandle();
      return { ...context,account,key:`${account}:${timeline}`,cursor:variables.cursor || parsed.searchParams.get("cursor") || "" };
    }

    function stateFor(context) {
      if (!states.has(context.key)) {
        if (states.size >= 6) clear();
        states.set(context.key,{ account:context.account,paused:false,empty:false,loading:false,permitNext:false,bottom:new Set(),top:new Set(),pending:[] });
      }
      return states.get(context.key);
    }
    function announce(context,state) {
      window.postMessage({ channel:CHANNEL,type:"NOTIFICATION_FILTER_STATUS",account:context.account,
        key:context.key,paused:state.paused,empty:state.empty,loading:state.loading,pending:state.pending.length > 0 },location.origin);
    }
    function clear() {
      for (const state of states.values()) for (const job of [...state.pending]) job.cancel();
      states.clear();
    }
    function valid(context) { return active() && Boolean(context.account) && context.account === accountHandle(); }

    function filtered(payload,context) {
      if (!context.account) { context.account = accountHandle(); context.key = `${context.account}${context.key}`; }
      if (!settingsReady || !valid(context)) return null;
      const state = stateFor(context);
      const topRequest = state.top.has(context.cursor);
      const result = rewrite(payload,settings);
      if (!result) { finishNative(context); return null; }
      for (const cursor of result.cursors) {
        const set = cursor.type === "Bottom" ? state.bottom : cursor.type === "Top" ? state.top : null;
        if (set && typeof cursor.value === "string") {
          set.add(cursor.value); if (set.size > 64) set.delete(set.values().next().value);
        }
      }
      if (!topRequest && result.removed && !result.remaining) {
        state.paused = true; state.empty = true; state.loading = false; announce(context,state);
      } else if (!topRequest && state.paused) {
        // Stay in single-batch mode after an empty batch, even when the next batch contains comments.
        state.empty = !result.remaining; state.loading = false; announce(context,state);
      }
      return result.removed ? payload : null;
    }

    function finishNative(context) {
      const state = states.get(context.key);
      if (state?.top.has(context.cursor)) return;
      if (state?.loading) { state.loading = false; announce(context,state); }
    }

    function defer(context,run,cancel) {
      if (!valid(context)) { run(); return null; }
      const state = stateFor(context);
      if (!state.paused || !state.bottom.has(context.cursor) || !valid(context)) { run(); return null; }
      if (state.permitNext) {
        state.permitNext = false; state.loading = true; run(); announce(context,state); return null;
      }
      // Bound parked requests; never retain an unlimited retry queue or call the network to fill a page.
      if (state.pending.length >= 4) { cancel(); return null; }
      const job = {
        run() { remove(); valid(context) ? run() : cancel(); },
        cancel() { remove(); cancel(); }
      };
      function remove() { const index = state.pending.indexOf(job); if (index >= 0) state.pending.splice(index,1); }
      state.pending.push(job); announce(context,state);
      return job;
    }

    async function fetchResponse(response,context) {
      if (!settingsReady) {
        let timeout;
        await Promise.race([ready,new Promise(resolve => { timeout = setTimeout(resolve,1500); })]);
        clearTimeout(timeout);
      }
      let payload;
      try { payload = await readPayload(response); } catch { finishNative(context); return response; }
      if (!payload) { finishNative(context); return response; }
      void observe(payload,context);
      const changed = filtered(payload,context);
      if (!changed) { finishNative(context); return response; }
      const headers = new Headers(response.headers);
      headers.delete("content-length"); headers.delete("content-encoding");
      const text = JSON.stringify(changed);
      function build() {
        const next = new Response(text,{ status:response.status,statusText:response.statusText,headers });
        Object.defineProperties(next,{ url:{ value:response.url },redirected:{ value:response.redirected },
          type:{ value:response.type },clone:{ value:() => {
            if (next.bodyUsed) throw new TypeError("Response body already consumed");
            return build();
          } } });
        return next;
      }
      return build();
    }

    function fetch(args,context,send) {
      const input = args[0];
      const meta = request(context,typeof input === "string" || input instanceof URL ? String(input) : input.url);
      const signal = args[1]?.signal || input?.signal;
      return new Promise((resolve,reject) => {
        let job;
        const abort = () => { job?.cancel(); reject(error()); };
        const cleanup = () => signal?.removeEventListener("abort",abort);
        if (signal?.aborted) { reject(error()); return; }
        job = defer(meta,() => {
          cleanup();
          Promise.resolve().then(send).then(response => fetchResponse(response,meta)).then(resolve,
            cause => { finishNative(meta); reject(cause); });
        },() => { cleanup(); reject(error()); });
        if (job) signal?.addEventListener("abort",abort,{ once:true });
      });
    }

    function prepareXHR(xhr,context,url,method = "GET") {
      const previous = xhrContexts.get(xhr);
      if (previous) {
        previous.reopening = true; previous.job?.cancel(); xhrContexts.delete(xhr);
        delete xhr.response; delete xhr.responseText;
      }
      if (String(method).toUpperCase() !== "GET" || !handles(context) || !descriptors.response?.get || !descriptors.responseText?.get) return;
      if (["response","responseText"].some(key => Object.getOwnPropertyDescriptor(xhr,key)?.configurable === false)) return;
      const record = { context:request(context,url),cache:null,job:null };
      xhrContexts.set(xhr,record);
      function value(key) {
        const raw = descriptors[key].get.call(xhr);
        if (xhr.readyState !== 4 || xhr.status < 200 || xhr.status >= 300 ||
            !["","text","json"].includes(xhr.responseType) || !settingsReady ||
            (record.context.account && !valid(record.context))) return raw;
        if (record.cache?.raw === raw) return record.cache.value;
        try {
          const text = typeof raw === "string" ? raw : JSON.stringify(raw);
          if (text.length > MAX_BYTES) return raw;
          const payload = JSON.parse(text);
          const changed = filtered(payload,record.context);
          const result = changed ? typeof raw === "string" ? JSON.stringify(changed) : changed : raw;
          record.cache = { raw,value:result };
          return result;
        } catch { return raw; }
      }
      for (const key of ["response","responseText"]) {
        Object.defineProperty(xhr,key,{ configurable:true,get:() => value(key) });
      }
    }
    function sendXHR(xhr,send) {
      const record = xhrContexts.get(xhr);
      if (!record) return send();
      if (record.job) throw new DOMException("Request already waiting to send","InvalidStateError");
      xhr.addEventListener("loadend",() => {
        const state = states.get(record.context.key);
        if (state?.loading && !state.top.has(record.context.cursor)) {
          if (xhr.status < 200 || xhr.status >= 300) finishNative(record.context);
          else { state.loading = false; announce(record.context,state); }
        }
      },{ once:true });
      record.job = defer(record.context,() => { record.job = null; send(); },() => {
        record.job = null; originalAbort.call(xhr);
        if (!record.reopening) queueMicrotask(() => { xhr.dispatchEvent(new Event("abort")); xhr.dispatchEvent(new Event("loadend")); });
      });
    }
    function originalXHR(xhr,key) { return descriptors[key]?.get ? descriptors[key].get.call(xhr) : xhr[key]; }
    if (originalAbort) XMLHttpRequest.prototype.abort = function () {
      const job = xhrContexts.get(this)?.job;
      return job ? job.cancel() : Reflect.apply(originalAbort,this,[]);
    };

    window.addEventListener("message",event => {
      if (event.source !== window || event.origin !== location.origin || event.data?.channel !== CHANNEL) return;
      const data = event.data;
      if (data.type === "NOTIFICATION_FILTER_SETTINGS") {
        const next = { likes:data.likes === true,follows:data.follows === true,reposts:data.reposts === true };
        if (settingsReady && (next.likes !== settings.likes || next.follows !== settings.follows || next.reposts !== settings.reposts)) {
          for (const [key,state] of states) {
            state.paused = false; state.loading = false; state.permitNext = false;
            announce({ key,account:state.account },state);
            for (const job of [...state.pending]) job.run();
          }
        }
        settings = next; settingsReady = true; notifyReady();
      }
      if (data.type === "NOTIFICATION_FILTER_CONTINUE") {
        const state = states.get(data.key);
        if (!state || state.account !== accountHandle() || !active()) return;
        if (state.loading) return;
        if (!state.paused) return;
        state.loading = state.pending.length > 0;
        state.permitNext = !state.loading;
        // One explicit click releases one original pagination request, not a fetch loop.
        const [first,...duplicates] = state.pending;
        for (const job of duplicates) job.cancel();
        first?.run(); announce({ key:data.key,account:state.account },state);
      }
      if (data.type === "NOTIFICATION_FILTER_CONTEXT" && (!active() ||
          [...states.values()].some(state => state.account !== accountHandle()))) clear();
    });
    window.addEventListener("pagehide",clear);
    return { handles,fetch,prepareXHR,sendXHR,originalXHR };
  }
  globalThis.XReplyNotificationNetwork = { rewrite,create };
})();
