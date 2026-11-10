(() => {
  "use strict";

  function mediaItems(tweet) {
    return tweet.legacy?.extended_entities?.media ?? tweet.extended_entities?.media ??
      tweet.legacy?.entities?.media ?? tweet.entities?.media;
  }

  function parseCdnUrl(value,origin,pathPattern,limit) {
    if (typeof value !== "string" || value.length > limit) return null;
    try {
      const url = new URL(value);
      if (url.origin === origin && !url.username && !url.password && pathPattern.test(url.pathname)) return url;
    } catch { /* Ignore malformed media fields in the observed response. */ }
    return null;
  }

  function photoFromTweet(tweet,legacyAuthor) {
    const author = tweet.core?.user_results?.result;
    // Null records known protection, which also rules out the DOM fallback.
    if (legacyAuthor?.protected === true || author?.privacy?.protected === true || author?.legacy?.protected === true) return null;
    if (!tweet.legacy && legacyAuthor?.protected !== false) return "";
    const media = mediaItems(tweet);
    if (!Array.isArray(media)) return "";
    for (const item of media.slice(0,4)) {
      if (item?.type !== "photo") continue;
      const url = parseCdnUrl(item.media_url_https,"https://pbs.twimg.com",/^\/media\/[a-z0-9_-]+(?:\.(?:jpe?g|png|webp|gif))?$/i,2048);
      if (!url) continue;
      url.hash = "";
      for (const key of [...url.searchParams.keys()]) if (key !== "format" && key !== "name") url.searchParams.delete(key);
      return url.href;
    }
    return "";
  }

  function selectMp4(tweet) {
    const media = mediaItems(tweet);
    if (!Array.isArray(media)) return "";
    for (const item of media.slice(0,4)) {
      const variants = item?.video_info?.variants;
      if (item?.type !== "video" || item.allow_download_status?.allow_download === false || !Array.isArray(variants)) continue;
      let selected = "", highestBitrate = -1;
      for (const variant of variants.slice(0,20)) {
        if (variant?.content_type !== "video/mp4") continue;
        const url = parseCdnUrl(variant.url,"https://video.twimg.com",/\.mp4$/i,4096);
        const bitrate = Number.isFinite(variant.bitrate) && variant.bitrate >= 0 ? variant.bitrate : 0;
        if (url && bitrate > highestBitrate) { selected = url.href; highestBitrate = bitrate; }
      }
      if (selected) return selected;
    }
    return "";
  }

  globalThis.XReplyObserveMedia = { photoFromTweet,selectMp4 };
})();
