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

  function selectMp4(tweet) {
    const media = tweet.legacy?.extended_entities?.media ?? tweet.extended_entities?.media ?? tweet.legacy?.entities?.media;
    if (!Array.isArray(media)) return "";
    for (const item of media.slice(0,4)) {
      const variants = item?.video_info?.variants;
      if (item?.type !== "video" || item.allow_download_status?.allow_download === false || !Array.isArray(variants)) continue;
      let selected = "", highestBitrate = -1;
      for (const variant of variants.slice(0,20)) {
        if (variant?.content_type !== "video/mp4") continue;
        const url = mp4Url(variant.url);
        const bitrate = Number.isFinite(variant.bitrate) && variant.bitrate >= 0 ? variant.bitrate : 0;
        if (url && bitrate > highestBitrate) { selected = url; highestBitrate = bitrate; }
      }
      if (selected) return selected;
    }
    return "";
  }

  globalThis.XReplyPostVideo = { parsePostLink,mp4Url,selectMp4 };
})();
