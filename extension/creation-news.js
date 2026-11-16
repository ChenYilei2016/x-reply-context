(() => {
  "use strict";
  const sources = [
    {id:"ithome",name:"IT之家",category:"科技数码",feed:"https://www.ithome.com/rss/",hosts:["www.ithome.com"],body:"#paragraph"},
    {id:"sspai",name:"少数派",category:"工具效率",feed:"https://sspai.com/feed",hosts:["sspai.com"],body:".article-body, .article__content"},
    {id:"google-ai",name:"Google AI",category:"AI 动态",feed:"https://blog.google/technology/ai/rss/",hosts:["blog.google"],body:".uni-article__body, .article-body, .rich-text"}
  ];
  const origins = sources.flatMap(source=>source.hosts.map(host=>`https://${host}/*`));
  const BODY_LIMIT = 10000, MAX_PER_SOURCE = 30, TTL = 15*60*1000;
  function safeUrl(value,source,base=source.feed) {
    try {
      if (typeof value!=="string" || !value.trim()) return "";
      const url = new URL(value,base);
      if (url.protocol!=="https:" || url.username || url.password || url.port || !source.hosts.includes(url.hostname)) return "";
      url.hash="";
      for (const key of [...url.searchParams.keys()]) if (/^utm_|^(fbclid|gclid)$/.test(key)) url.searchParams.delete(key);
      return url.href;
    } catch { return ""; }
  }
  function htmlText(html) {
    const doc = new DOMParser().parseFromString(html,"text/html");
    doc.querySelectorAll("script,style,noscript,iframe,nav,footer,form,button").forEach(el=>el.remove());
    doc.querySelectorAll("p,div,li,h1,h2,h3,br").forEach(el=>el.append(doc.createTextNode("\n")));
    return (doc.body.textContent || "").replace(/[ \t]+/g," ").replace(/\n\s*\n/g,"\n\n").trim().slice(0,BODY_LIMIT);
  }
  function parseFeed(xml,source,now=Date.now()) {
    const doc = new DOMParser().parseFromString(xml,"application/xml");
    if (doc.querySelector("parsererror") || !doc.querySelector("rss, feed")) throw new Error("来源返回的内容不是有效 RSS。");
    const child = (el,name) => [...el.children].find(node=>node.localName===name);
    const seen = new Set(), items=[];
    for (const entry of [...doc.querySelectorAll("item, entry")].slice(0,80)) {
      const link = child(entry,"link");
      const url = safeUrl(link?.getAttribute("href") || link?.textContent || "",source);
      const title = htmlText(child(entry,"title")?.textContent || "").slice(0,300);
      if (!url || !title || seen.has(url)) continue;
      const rawBody = child(entry,"encoded")?.textContent || child(entry,"content")?.textContent;
      const text = htmlText(rawBody || child(entry,"description")?.textContent || child(entry,"summary")?.textContent || "");
      const stamp = Date.parse(child(entry,"pubDate")?.textContent || child(entry,"published")?.textContent || child(entry,"updated")?.textContent || "");
      // IT之家的 description 是正文型内容；其他源的 description 保持摘要口径。
      const coverage = text.length>=400 && (rawBody || source.id==="ithome") ? "body" : "excerpt";
      items.push({id:url,url,title,text,coverage,sourceId:source.id,source:source.name,category:source.category,
        publishedAt:Number.isFinite(stamp)?new Date(stamp).toISOString():"",fetchedAt:now});
      seen.add(url);
      if (items.length===MAX_PER_SOURCE) break;
    }
    if (!items.length) throw new Error("来源暂未返回可用文章，保留上次素材。");
    return items;
  }
  function articleText(html,source) {
    const doc = new DOMParser().parseFromString(html,"text/html");
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const raw = JSON.parse(script.textContent), nodes=Array.isArray(raw)?raw:[raw,...(Array.isArray(raw["@graph"])?raw["@graph"]:[])];
        const body = nodes.find(node=>typeof node?.articleBody==="string")?.articleBody;
        if (body?.trim().length>=300) return htmlText(body);
      } catch { /* Some publishers embed invalid JSON-LD; use their article container. */ }
    }
    const blocks = [...doc.querySelectorAll(source.body)].map(el=>htmlText(el.innerHTML)).filter(text=>text.length>=300);
    return blocks.sort((a,b)=>b.length-a.length)[0] || "";
  }
  async function fetchText(url,source,signal) {
    if (!safeUrl(url,source)) throw new Error("仅支持已内置新闻来源的链接。");
    const controller = new AbortController();
    const cancel=()=>controller.abort();
    signal?.addEventListener("abort",cancel,{once:true});
    const timer=setTimeout(cancel,15000);
    let reader;
    try {
      if (signal?.aborted) controller.abort();
      const response=await fetch(url,{signal:controller.signal,credentials:"omit",referrerPolicy:"no-referrer"});
      if (!response.ok) throw new Error(`来源请求失败（HTTP ${response.status}）。`);
      if (!safeUrl(response.url || url,source)) throw new Error("来源跳转到了不支持的站点。");
      if (!response.body) throw new Error("来源没有返回内容。");
      reader=response.body.getReader();
      const decoder=new TextDecoder(); let bytes=0,text="";
      for (;;) {
        const chunk=await reader.read();
        if (chunk.done) break;
        bytes+=chunk.value.byteLength;
        if (bytes>2*1024*1024) throw new Error("来源内容过大，已停止读取。");
        text+=decoder.decode(chunk.value,{stream:true});
      }
      return text+decoder.decode();
    } catch(error) {
      if (controller.signal.aborted) throw new Error(signal?.aborted ? "已取消读取。" : "来源读取超时，保留已有素材。");
      if (error instanceof TypeError) throw new Error("无法连接来源，请检查网络或网站访问授权。");
      throw error;
    } finally {
      clearTimeout(timer);signal?.removeEventListener("abort",cancel);
      if (reader) {void reader.cancel().catch(()=>{});reader.releaseLock();}
    }
  }
  function mergeItems(previous,incoming) {
    const byUrl=new Map(previous.map(item=>[item.id,item]));
    for (const item of incoming) {
      const old=byUrl.get(item.id);
      byUrl.set(item.id,old?.coverage==="body" && item.coverage!=="body" ? {...item,text:old.text,coverage:old.coverage} : item);
    }
    return [...byUrl.values()].sort((a,b)=>(Date.parse(b.publishedAt)||b.fetchedAt)-(Date.parse(a.publishedAt)||a.fetchedAt)).slice(0,MAX_PER_SOURCE);
  }
  globalThis.XReplyCreationNews={sources,origins,TTL,BODY_LIMIT,safeUrl,parseFeed,articleText,fetchText,mergeItems};
})();
