// 创作页面（写作台、对标风格）共用的模型通道：读取各步骤的 API 状态、授权模型域名、发起与取消创作请求，
// 并渲染页面上的 .model[data-step] 状态位。请求本身由后台 AI 服务排队、超时与发送。
(() => {
  "use strict";

  /**
   * @param options.onChange 状态变化（开始／结束请求、授权后）时回调，页面据此重新渲染
   * @param options.onError 授权等操作失败时回调
   */
  function create({ onChange = () => {}, onError = () => {} } = {}) {
    let steps = {}, tasks = {}, pending = null;

    async function load() {
      const status = await chrome.runtime.sendMessage({ type: "AI_STUDIO_STATUS" });
      if (!status?.ok) throw new Error(status?.error || "读取创作模型状态失败");
      steps = Object.fromEntries(status.steps.map(step => [step.id, step]));
      tasks = status.tasks;
    }

    async function authorize(step) {
      if (!await chrome.permissions.request({ origins: [step.origin] })) throw new Error("未授权模型域名。");
      await load();
      onChange();
    }

    /** 发起一次创作请求，返回模型文本；被取消时返回 null。同一时间只允许一个请求。 */
    async function request(task, input) {
      if (pending) throw new Error("上一个请求还在进行。");
      await load();
      const step = steps[tasks[task]];
      if (!step?.configured) throw new Error(`请先在 AI 设置中为「${step?.label || task}」配置模型。`);
      if (!step.permitted) throw new Error("模型域名尚未授权，点模型名旁的「授权模型域名」后重试。");
      const id = crypto.randomUUID();
      pending = { id, task };
      onChange();
      try {
        const result = await chrome.runtime.sendMessage({ type: "AI_REQUEST", kind: "studio", task, id, input });
        if (pending?.id !== id || result?.cancelled) return null;
        if (!result?.ok) throw new Error(result?.error || "创作服务暂不可用。");
        return result.text;
      } finally {
        if (pending?.id === id) pending = null;
        onChange();
      }
    }

    /** 取消当前请求；没有请求时返回 false。 */
    function cancel() {
      if (!pending) return false;
      const { id } = pending;
      pending = null;
      void chrome.runtime.sendMessage({ type: "AI_CANCEL", ids: [id] }).catch(() => {});
      onChange();
      return true;
    }

    /** 渲染页面中所有 .model[data-step]：配置名与模型，未配置时给出设置入口，未授权时给出授权按钮。 */
    function render(root = document) {
      for (const container of root.querySelectorAll(".model[data-step]")) {
        const step = steps[container.dataset.step];
        container.replaceChildren();
        if (!step) continue;
        if (!step.configured) {
          const settings = Object.assign(document.createElement("a"), { textContent: "去 AI 设置", href: "../ai-settings.html", target: "_blank" });
          container.append("模型未配置 · ", settings);
          continue;
        }
        container.append(`${step.name} · ${step.model}`);
        if (!step.permitted) {
          const button = Object.assign(document.createElement("button"), { type: "button", textContent: "授权模型域名", className: "small" });
          button.addEventListener("click", () => void authorize(step).catch(onError));
          container.append(" ", button);
        }
      }
    }

    return { load, request, cancel, render, get pending() { return pending; } };
  }

  globalThis.XReplyModelClient = Object.freeze({ create });
})();
