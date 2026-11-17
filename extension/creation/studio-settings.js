// 写作台「写作设置」抽屉：人设、爆款样本、各任务的写作要求（提示词中可修改的部分）。
// 人设与样本供请求使用；写作要求由后台在构建请求时读取，这里只负责查看与修改。
(() => {
  "use strict";

  const SAVE_DELAY = 500;
  const SAMPLE_SEPARATOR = /^\s*---\s*$/m;

  /**
   * @param deps.store 写作台存储（人设与样本）；deps.drafts 草稿库（已发帖子作样本候选）；deps.onError 出错提示
   */
  function create({ store, drafts, onError }) {
    const draftModel = globalThis.XReplyDraftModel;
    const review = globalThis.XReplyReviewModel;
    const guides = globalThis.XReplyPromptGuides;
    const format = globalThis.XReplyFormat;
    const $ = id => document.getElementById(id);
    let profile = null, ownPosts = [], savedGuides = {}, guideTask = guides.TASKS[0].id;
    const timers = {};

    function later(key, work) {
      clearTimeout(timers[key]);
      timers[key] = setTimeout(() => void work().catch(onError), SAVE_DELAY);
    }

    async function load() {
      const [saved, own, savedDrafts, overrides] = await Promise.all([store.profile(), store.ownPosts(), drafts.list(), guides.load()]);
      profile = saved;
      // 已发且有数据的草稿也作为样本候选；与 bot feed 中自己的帖子按帖子 id 去重。
      const known = new Set(own.map(post => post.id));
      ownPosts = [...own, ...review.asOwnPosts(savedDrafts).filter(post => !known.has(post.id))];
      savedGuides = overrides;
    }

    const persona = () => profile.persona;
    const samples = () => draftModel.selectSamples({
      manual: profile.manualSamples.map((text, index) => ({ id: `manual-${index}`, text })), own: ownPosts, excluded: profile.excludedSampleIds
    });

    async function updateProfile(patch) {
      profile = { ...profile, ...patch };
      await store.saveProfile(profile);
      $("profile-status").textContent = "已保存";
      renderSamples();
    }

    // ---------- 渲染 ----------

    function element(tag, text, className) {
      const node = document.createElement(tag);
      if (text !== undefined) node.textContent = text;
      if (className) node.className = className;
      return node;
    }

    function renderSamples() {
      const selected = samples();
      $("samples").replaceChildren(...(selected.length ? selected.map(sample => {
        const item = element("li");
        item.append(element("span", sample.origin === "manual" ? "手动" : `我的帖子 · 浏览 ${format.count(sample.views)}`, "badge"),
          " ", sample.text.length > 90 ? `${sample.text.slice(0, 90)}…` : sample.text);
        if (sample.origin === "own") {
          const exclude = element("button", "排除", "small");
          exclude.type = "button";
          exclude.addEventListener("click", () => void updateProfile({ excludedSampleIds: [...profile.excludedSampleIds, sample.id] }).catch(onError));
          item.append(" ", exclude);
        }
        return item;
      }) : [element("li", "暂无样本：在下方粘贴手动样本，或让 bot 在 feed 里给自己的帖子标记 own。", "muted")]));
      const excluded = profile.excludedSampleIds.length;
      $("samples-restore").hidden = !excluded;
      $("samples-restore").textContent = `恢复已排除的 ${excluded} 条`;
    }

    function renderGuide() {
      const custom = Object.hasOwn(savedGuides, guideTask);
      $("guide-task").value = guideTask;
      $("guide-text").value = custom ? savedGuides[guideTask] : guides.defaultGuide(guideTask);
      $("guide-state").textContent = custom ? "已自定义" : "默认";
      $("guide-default").disabled = !custom;
    }

    function render() {
      $("persona").value = profile.persona;
      $("manual-samples").value = profile.manualSamples.join("\n---\n");
      renderSamples();
      renderGuide();
    }

    // ---------- 事件 ----------

    function bind() {
      $("persona").addEventListener("input", () => {
        $("profile-status").textContent = "正在保存…";
        later("persona", () => updateProfile({ persona: $("persona").value.trim() ? $("persona").value : draftModel.DEFAULT_PERSONA }));
      });
      $("persona-default").addEventListener("click", () => {
        $("persona").value = draftModel.DEFAULT_PERSONA;
        void updateProfile({ persona: draftModel.DEFAULT_PERSONA }).catch(onError);
      });
      $("manual-samples").addEventListener("change", () => void updateProfile({
        manualSamples: $("manual-samples").value.split(SAMPLE_SEPARATOR).map(item => item.trim()).filter(Boolean).slice(0, store.MANUAL_SAMPLE_LIMIT)
      }).catch(onError));
      $("samples-restore").addEventListener("click", () => void updateProfile({ excludedSampleIds: [] }).catch(onError));
      $("guide-task").replaceChildren(...guides.TASKS.map(task => new Option(task.label, task.id)));
      $("guide-task").addEventListener("change", () => { guideTask = $("guide-task").value; renderGuide(); });
      $("guide-text").addEventListener("input", () => {
        $("guide-state").textContent = "正在保存…";
        const task = guideTask, text = $("guide-text").value;
        later(`guide:${task}`, async () => {
          savedGuides = await guides.save(task, text);
          if (task === guideTask) { $("guide-state").textContent = Object.hasOwn(savedGuides, task) ? "已自定义并保存" : "默认"; $("guide-default").disabled = !Object.hasOwn(savedGuides, task); }
        });
      });
      $("guide-default").addEventListener("click", () => void guides.save(guideTask, "").then(saved => { savedGuides = saved; renderGuide(); }, onError));
      $("guide-fixed").textContent = globalThis.XReplyComposePrompt.SHARED_RULES;
    }

    return { load, bind, render, persona, samples };
  }

  globalThis.XReplyStudioSettings = Object.freeze({ create });
})();
