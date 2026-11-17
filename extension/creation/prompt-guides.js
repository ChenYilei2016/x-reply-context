// 创作提示词中可由用户修改的「写作要求」：每个任务一段，存本机；空或过长时用各模型的默认值。
// 任务说明、事实约束（只用素材事实、不编造）和输出格式固定在各模型里，不开放修改，避免改坏后结果无法解析。
// 页面（写作台设置）和后台（构建请求时）共用。
(() => {
  "use strict";

  const KEY = "creationPromptGuides";

  const TASKS = Object.freeze([
    { id: "rewrite", label: "改写", model: "XReplyRewriteModel" },
    { id: "drafts", label: "按角度写", model: "XReplyDraftModel" },
    { id: "angles", label: "找角度", model: "XReplyAngleModel" },
    { id: "styles", label: "拆解风格", model: "XReplyStyleModel" },
    { id: "image_prompt", label: "出图提示词", model: "XReplyImageModel" }
  ].map(task => Object.freeze(task)));

  const task = id => TASKS.find(item => item.id === id);
  const limit = () => globalThis.XReplyComposePrompt.GUIDE_LIMIT;

  /** 某个任务的默认写作要求（来自对应模型模块）。 */
  const defaultGuide = id => globalThis[task(id).model].DEFAULT_GUIDE;

  /** 只保留已知任务、非空、不超长、且与默认不同的修改。 */
  function normalize(raw) {
    const guides = {};
    for (const { id } of TASKS) {
      const text = typeof raw?.[id] === "string" ? raw[id].trim() : "";
      if (text && text.length <= limit() && text !== defaultGuide(id)) guides[id] = text;
    }
    return guides;
  }

  async function load() {
    return normalize((await chrome.storage.local.get(KEY))[KEY]);
  }

  /** 保存一个任务的写作要求；与默认相同或为空时视为恢复默认。 */
  async function save(id, text) {
    if (!task(id)) throw new Error("未知的提示词任务。");
    if (typeof text !== "string" || text.length > limit()) throw new Error(`写作要求最多 ${limit()} 字。`);
    const guides = await load();
    if (text.trim() && text.trim() !== defaultGuide(id)) guides[id] = text.trim();
    else delete guides[id];
    await chrome.storage.local.set({ [KEY]: guides });
    return guides;
  }

  globalThis.XReplyPromptGuides = Object.freeze({ KEY, TASKS, task, defaultGuide, normalize, load, save });
})();
