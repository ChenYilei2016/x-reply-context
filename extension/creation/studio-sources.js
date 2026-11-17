// 写作台的内容来源：粘贴的正文、粘贴的链接（文章链接读取正文，X 帖子链接从素材库找）、雷达或 X 上选入的素材。
// 三者可以单独用，也可以组合；按“粘贴正文 → 链接 → 已选素材”的顺序最多取 6 条交给模型。
(() => {
  "use strict";

  const LinkStatus = Object.freeze({ IDLE: "idle", LOADING: "loading", OK: "ok", ERROR: "error" });

  /** 短指纹（长度 + FNV-1a 32 位），只用于判断内容是否变化，存进写作进度时不必保存全文。 */
  function fingerprint(value) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `${value.length}:${hash.toString(36)}`;
  }

  /**
   * @param deps.db 素材库；deps.store 写作台存储（已选素材）；deps.prompt 提示词模块；
   *   deps.sourceName (material) => 渠道名；deps.onChange 状态变化时回调
   */
  function create({ db, store, prompt, sourceName, onChange }) {
    const input = globalThis.XReplySourceInput;
    const reader = globalThis.XReplyLinkReader;
    let text = "";
    let parsed = input.parse("");
    let basketIds = [], basket = [], missing = [];
    /** 链接读取结果按链接缓存，本页有效。 */
    const links = new Map();

    function setText(value) {
      text = value;
      parsed = input.parse(value);
      for (const { url } of parsed.links) if (!links.has(url)) links.set(url, { status: LinkStatus.IDLE });
    }

    async function loadBasket() {
      basketIds = await store.basketIds();
      ({ materials: basket, missing } = await store.basketMaterials(basketIds));
    }

    const removeFromBasket = id => store.saveBasket(basketIds.filter(item => item !== id));

    const fromLibrary = material => ({ key: material.id, prompt: prompt.toPromptMaterial(material, sourceName(material)), library: material });

    async function readLink(link) {
      if (!link.xPostId) return { status: LinkStatus.OK, material: await reader.read(link.url) };
      const material = await db.get(`x:${link.xPostId}`);
      if (!material) throw new Error("X 帖子读不了（需要登录）：请先在 X 上点帖子下的「改写」或「选入」，或直接粘贴正文。");
      return { status: LinkStatus.OK, material, library: true };
    }

    /**
     * 读取还没读到的链接（依次读取，最多 3 个）。文章链接需要一次性授权读取网页，
     * 授权弹窗要求用户手势，所以必须在点击处理函数里最先调用。
     */
    async function resolve() {
      const pending = parsed.links.filter(link => links.get(link.url).status !== LinkStatus.OK);
      if (!pending.length) return;
      const needsWeb = pending.some(link => !link.xPostId);
      const permitted = !needsWeb || await reader.hasPermission() || await reader.requestPermission();
      for (const link of pending) {
        if (!link.xPostId && !permitted) {
          links.set(link.url, { status: LinkStatus.ERROR, error: "没有授权读取网页，已跳过；可以粘贴正文。" });
          continue;
        }
        links.set(link.url, { status: LinkStatus.LOADING });
        onChange();
        try { links.set(link.url, await readLink(link)); }
        catch (error) { links.set(link.url, { status: LinkStatus.ERROR, error: error.message }); }
        onChange();
      }
    }

    /**
     * 本次交给模型的来源：{ key, prompt（发给后台的素材字段）, library（来自素材库时为原素材，用于参考帖、标记已用） }。
     */
    function sources() {
      const list = [];
      if (parsed.body) {
        list.push({ key: "paste", library: null, prompt: { kind: "note", title: "", text: parsed.body, url: "", source: "",
          coverage: input.coverageOf(parsed.body), publishedAt: null, author: "" } });
      }
      for (const { url } of parsed.links) {
        const entry = links.get(url);
        if (entry?.status !== LinkStatus.OK) continue;
        list.push(entry.library ? fromLibrary(entry.material) : { key: url, prompt: entry.material, library: null });
      }
      for (const material of basket) if (!list.some(source => source.key === material.id)) list.push(fromLibrary(material));
      return list.slice(0, prompt.LIMITS.materials);
    }

    /**
     * 内容的标识：粘贴的正文、链接与已选素材任一变化都会改变。用于判断角度、候选是否还对应当前内容。
     * 按输入计算，不依赖链接是否已读取（重新打开页面时链接尚未读取，标识应保持不变）。
     */
    const signature = () => fingerprint([parsed.body, ...parsed.links.map(link => link.url), ...basketIds].join("\n"));

    return {
      setText, text: () => text, body: () => parsed.body, droppedLinks: () => parsed.droppedLinks,
      links: () => parsed.links.map(link => ({ ...link, ...links.get(link.url) })),
      loadBasket, basket: () => basket, missing: () => missing, removeFromBasket, resolve, sources, signature
    };
  }

  globalThis.XReplyStudioSources = Object.freeze({ create, LinkStatus, fingerprint });
})();
