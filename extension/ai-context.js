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

  function photoFromArticle(article,postId) {
    if (!article?.isConnected || !id(postId)) return "";
    const author = article.querySelector('[data-testid="User-Name"]');
    if (author?.querySelector('[data-testid="icon-lock"],[aria-label="Protected account"],[aria-label="受保护的账号"]')) return "";
    for (const image of article.querySelectorAll('[data-testid="tweetPhoto"] img')) {
      if (image.closest('article[data-testid="tweet"]') !== article ||
          image.closest('[data-testid="videoPlayer"],[data-testid="videoComponent"]')) continue;
      const href = image.closest('a[href]')?.getAttribute("href");
      const owner = href?.match(/\/status\/(\d{1,25})\/photo\/\d+\/?(?:[?#]|$)/)?.[1];
      if (owner !== postId) continue;
      const url = photoUrl(image.getAttribute("src")) || photoUrl(image.currentSrc);
      if (url) return url;
    }
    return "";
  }

  function normalize(raw) {
    const postId = id(raw?.postId);
    const pageAuthor = postId && (raw?.pageAuthor === "我" || raw?.pageAuthor === "对方") ? raw.pageAuthor : "";
    const parent = snippet(raw?.parent);
    const rootText = snippet(raw?.root);
    const root = rootText === parent ? "" : rootText;
    const comments = Array.isArray(raw?.comments) ? [...new Set(raw.comments.slice(0,COMMENT_LIMIT).map(snippet))]
      .filter(text => text && text !== parent && text !== root) : [];
    const image = photoUrl(raw?.image);
    const imageFrom = ["parent","root"].includes(raw?.imageFrom) ? raw.imageFrom : "post";
    return { postId,pageAuthor,parent,root,comments,image,imageFrom,imageRequested:raw?.imageRequested === true };
  }

  function create() {
    const posts = new Map();
    let owner = "";

    function useAccount(account) {
      if (!account || account === owner) return;
      if (owner) posts.clear();
      owner = account;
    }

    function observe(account,record) {
      const postId = id(record?.id);
      if (!postId || (owner && !account)) return;
      useAccount(account);
      const previous = posts.get(postId);
      const photo = photoUrl(record.aiPhoto);
      const photoBlocked = record.aiPhoto === null || (!photo && previous?.photoBlocked === true);
      posts.delete(postId);
      posts.set(postId,{
        parentId:id(record.parentId) || previous?.parentId || "",
        rootId:id(record.conversationId) || previous?.rootId || "",
        text:snippet(record.text) || previous?.text || "",
        image:photoBlocked ? "" : photo || previous?.image || "",
        photoBlocked
      });
      if (posts.size > POST_LIMIT) posts.delete(posts.keys().next().value);
    }

    function read(account,postId,includeImage,readTargetPhoto) {
      if (!account || !id(postId)) return { postId };
      useAccount(account);
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
      const targetPhoto = includeImage && !post?.photoBlocked ? post?.image || photoUrl(readTargetPhoto?.()) : "";
      const image = includeImage ? targetPhoto || parent?.image || root?.image || "" : "";
      const imageFrom = targetPhoto ? "post" : parent?.image ? "parent" : "root";
      return { postId,parent:parent?.text,root:root?.text,comments,image,imageFrom };
    }

    return { observe,read };
  }

  globalThis.XReplyAIContext = { create,normalize,photoUrl,photoFromArticle };
})();
