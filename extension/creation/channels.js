// 素材渠道页：授权、开关、地址配置、状态查看与立即刷新。所有数据操作都经后台 CREATION_* 消息完成。
(() => {
  "use strict";

  const { MaterialCategory } = globalThis.XReplyMaterialModel;
  const { time: formatTime } = globalThis.XReplyFormat;
  const $ = id => document.getElementById(id);
  let status = null;
  let busy = false;

  // ---------- 后台通信 ----------

  async function call(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || "后台暂不可用，请稍后重试");
    return response;
  }

  async function reload() {
    status = await call({ type: "CREATION_CHANNELS_STATUS" });
    render();
  }

  // ---------- 格式化 ----------

  function describeState(state) {
    if (!state) return { text: "尚未拉取", error: false };
    const parts = [];
    if (state.lastSuccessAt) parts.push(`最近成功 ${formatTime(state.lastSuccessAt)}，本次 ${state.fetched ?? 0} 条、新增 ${state.inserted ?? 0} 条`);
    if (state.rejected) parts.push(`${state.rejected} 条格式不合格已跳过`);
    if (state.failures) parts.push(`连续失败 ${state.failures} 次：${state.error}`);
    if (state.nextRunAt) parts.push(`下次 ${formatTime(state.nextRunAt)}`);
    return { text: parts.join(" · ") || "尚未拉取", error: Boolean(state.failures) };
  }

  function setStatusText(element, { text, error }) {
    element.textContent = text;
    element.dataset.error = String(error);
  }

  // ---------- 渲染 ----------

  function renderSummary() {
    const channels = status.channels;
    const enabled = channels.filter(channel => channel.enabled);
    const missing = enabled.filter(channel => !channel.permitted);
    const failing = enabled.filter(channel => channel.state?.failures);
    const parts = [`素材库共 ${status.total} 条`, `${enabled.length}/${channels.length} 个渠道开启`];
    if (missing.length) parts.push(`${missing.length} 个待授权`);
    if (failing.length) parts.push(`${failing.length} 个失败中`);
    setStatusText($("summary"), { text: parts.join(" · "), error: Boolean(failing.length) });
    $("grant-all").disabled = busy || !missing.length;
    $("run-all").disabled = busy;
  }

  function renderChannel(channel) {
    const node = $("channel-template").content.firstElementChild.cloneNode(true);
    node.dataset.enabled = String(channel.enabled);
    node.querySelector(".name").textContent = channel.name;
    node.querySelector(".category").textContent = MaterialCategory.from(channel.category)?.label || channel.category;
    node.querySelector(".interval").textContent = `每 ${channel.intervalMinutes} 分钟`;

    const permission = node.querySelector(".permission");
    permission.textContent = channel.permitted ? "已授权" : "未授权";
    permission.dataset.granted = String(channel.permitted);
    const grant = node.querySelector(".grant");
    grant.hidden = channel.permitted;
    grant.addEventListener("click", () => act(() => requestOrigins(channel.origins)));

    const run = node.querySelector(".run");
    run.disabled = busy || !channel.enabled || !channel.permitted;
    run.addEventListener("click", () => act(() => runChannels([channel.id])));

    const enabled = node.querySelector(".enabled");
    enabled.checked = channel.enabled;
    enabled.addEventListener("change", () => act(() => call({ type: "CREATION_CHANNEL_SETTINGS", channelId: channel.id, enabled: enabled.checked })));

    setStatusText(node.querySelector(".state"), channel.enabled ? describeState(channel.state) : { text: "已关闭", error: false });

    if (channel.id === "bot-feed") renderUrlForm(node, channel);
    return node;
  }

  function renderUrlForm(node, channel) {
    const form = node.querySelector(".url-form");
    const input = form.querySelector(".url");
    form.hidden = false;
    input.value = channel.settings.url || "";
    input.placeholder = "http://127.0.0.1:8765/feed.json（默认）";
    form.addEventListener("submit", event => {
      event.preventDefault();
      act(() => call({ type: "CREATION_CHANNEL_SETTINGS", channelId: channel.id, url: input.value.trim() }));
    });
  }

  function render() {
    if (!status) return;
    renderSummary();
    $("channels").replaceChildren(...status.channels.map(renderChannel));
  }

  // ---------- 操作 ----------

  /** 主机权限必须由用户点击触发申请。 */
  async function requestOrigins(origins) {
    const granted = await chrome.permissions.request({ origins });
    if (!granted) throw new Error("未授权，渠道暂不能拉取");
  }

  async function runChannels(channelIds) {
    setStatusText($("summary"), { text: "正在拉取，请稍候…", error: false });
    const result = await call({ type: "CREATION_CHANNELS_RUN", channelIds });
    if (result.busy) throw new Error("已有一轮拉取在进行，稍后再试");
    const failed = result.results.filter(row => !row.ok);
    if (failed.length) throw new Error(`${failed.length} 个渠道失败，详情见各渠道状态`);
  }

  /** 统一处理按钮操作：串行执行，结束后刷新状态，错误显示在顶部。 */
  async function act(operation) {
    if (busy) return;
    busy = true;
    render();
    let failure;
    try {
      await operation();
    } catch (error) {
      failure = error;
    } finally {
      busy = false;
      await reload().catch(error => { failure ||= error; });
      if (failure) setStatusText($("summary"), { text: failure.message, error: true });
    }
  }

  $("grant-all").addEventListener("click", () => act(() => {
    const origins = status.channels.filter(channel => channel.enabled && !channel.permitted).flatMap(channel => channel.origins);
    return requestOrigins([...new Set(origins)]);
  }));
  $("run-all").addEventListener("click", () => act(() => runChannels(undefined)));
  void reload().catch(error => setStatusText($("summary"), { text: error.message, error: true }));
})();
