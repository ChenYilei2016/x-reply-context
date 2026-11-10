(() => {
  "use strict";
  const postHosts = new Set(["x.com","www.x.com","twitter.com","www.twitter.com","mobile.twitter.com"]);

  function parsePostLink(value) {
    if (typeof value !== "string" || value.length > 4096) return null;
    const input = value.trim();
    try {
      const url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
      if (!postHosts.has(url.hostname) || url.port || url.username || url.password) return null;
      const match = url.pathname.match(/^\/(i\/web|[a-z0-9_]{1,15})\/status\/(\d{1,25})(?:\/(?:video|photo)\/\d+)?\/?$/i);
      if (!match) return null;
      const [,author,id] = match;
      return { id,url:`https://x.com/${author.toLowerCase() === "i/web" ? "i" : author}/status/${id}` };
    } catch { return null; }
  }

  function mp4Url(value) {
    if (typeof value !== "string" || value.length > 4096) return "";
    try {
      const url = new URL(value);
      return url.origin === "https://video.twimg.com" && !url.username && !url.password && /\.mp4$/i.test(url.pathname) ? url.href : "";
    } catch { return ""; }
  }

  globalThis.XReplyPostVideo = { parsePostLink,mp4Url };
})();
