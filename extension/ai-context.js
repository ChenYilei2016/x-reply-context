(() => {
  "use strict";
  const POST_LIMIT = 500;
  const COMMENT_LIMIT = 3;
  const id = value => typeof value === "string" && /^\d{1,25}$/.test(value) ? value : "";
  const snippet = value => typeof value === "string" ? value.slice(0,200).trim() : "";

  function photoUrl(value) {
    if (typeof value !== "string" || value.length > 2048) return "";
    try {
      const url = new URL(value);
      if (url.origin !== "https://pbs.twimg.com" || url.username || url.password ||
          !/^\/media\/[a-z0-9_-]+(?:\.(?:jpe?g|png|webp|gif))?$/i.test(url.pathname)) return "";
      url.hash = "";
      for (const key of [...url.searchParams.keys()]) if (key !== "format" && key !== "name") url.searchParams.delete(key);
      return url.href;
    } catch { return ""; }
  }

  function photoFromTweet(tweet,legacyAuthor) {
    if (!tweet.legacy && legacyAuthor?.protected !== false) return "";
    const legacy = tweet.legacy || tweet;
    const media = legacy.extended_entities?.media ?? tweet.extended_entities?.media ?? legacy.entities?.media;
    if (!Array.isArray(media)) return "";
    const author = tweet.core?.user_results?.result;
    if (author?.privacy?.protected === true || author?.legacy?.protected === true) return "";
    for (const item of media.slice(0,4)) {
      const url = item?.type === "photo" && photoUrl(item.media_url_https);
      if (url) return url;
    }
    return "";
  }

  function normalize(raw) {
    const parent = snippet(raw?.parent);
    const rootText = snippet(raw?.root);
    const root = rootText === parent ? "" : rootText;
    const comments = Array.isArray(raw?.comments) ? [...new Set(raw.comments.slice(0,COMMENT_LIMIT).map(snippet))]
      .filter(text => text && text !== parent && text !== root) : [];
    const image = photoUrl(raw?.image);
    const imageFrom = ["parent","root"].includes(raw?.imageFrom) ? raw.imageFrom : "post";
    return { postId:id(raw?.postId),parent,root,comments,image,imageFrom };
  }

  function create() {
    const posts = new Map();
    let owner = "";

    function observe(account,record) {
      const postId = id(record?.id);
      if (!postId || (owner && !account)) return;
      if (owner && account !== owner) posts.clear();
      if (account) owner = account;
      const previous = posts.get(postId);
      posts.delete(postId);
      posts.set(postId,{
        parentId:id(record.parentId) || previous?.parentId || "",
        rootId:id(record.conversationId) || previous?.rootId || "",
        text:snippet(record.text) || previous?.text || "",
        image:photoUrl(record.aiPhoto) || previous?.image || ""
      });
      if (posts.size > POST_LIMIT) posts.delete(posts.keys().next().value);
    }

    function read(account,postId,includeImage) {
      if (!account || (owner && account !== owner) || !id(postId)) return { postId };
      owner ||= account;
      const post = posts.get(postId);
      const parent = post?.parentId !== postId && post?.parentId !== post?.rootId ? posts.get(post?.parentId) : null;
      const root = post?.rootId !== postId ? posts.get(post?.rootId) : null;
      const comments = [];
      const seen = new Set([post?.text,parent?.text,root?.text]);
      for (const [key,reply] of posts) {
        if (key === postId || reply.parentId !== postId || !reply.text || seen.has(reply.text)) continue;
        comments.push(reply.text); seen.add(reply.text);
        if (comments.length === COMMENT_LIMIT) break;
      }
      const image = includeImage ? post?.image || parent?.image || root?.image || "" : "";
      const imageFrom = post?.image ? "post" : parent?.image ? "parent" : "root";
      return { postId,parent:parent?.text,root:root?.text,comments,image,imageFrom };
    }

    return { observe,read };
  }

  globalThis.XReplyAIContext = { create,normalize,photoUrl,photoFromTweet };
})();
