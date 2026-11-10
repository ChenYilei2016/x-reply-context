async function installCheckbox(selector,key,statusSelector,enabledText,defaultEnabled = false,
    disabledText = defaultEnabled ? "已关闭；刷新通知页可恢复此前被过滤的消息。" : "已关闭，恢复正常显示。") {
  const checkbox = document.querySelector(selector);
  const status = document.querySelector(statusSelector);
  try {
    const saved = await chrome.storage.local.get(key);
    checkbox.checked = defaultEnabled ? saved[key] !== false : saved[key] === true;
    checkbox.disabled = false;
    checkbox.addEventListener("change",async () => {
      const value = checkbox.checked;
      checkbox.disabled = true;
      try {
        await chrome.storage.local.set({ [key]:value });
        status.textContent = value ? enabledText : disabledText;
      } catch {
        checkbox.checked = !value;
        status.textContent = "设置未保存，请重试。";
      } finally { checkbox.disabled = false; }
    });
  } catch { status.textContent = "设置暂时不可用，请重新打开扩展。"; }
}
void installCheckbox("#random-skip-reply-like","randomSkipReplyLike","#random-like-status","已开启；后续组合操作有50%概率不点赞，仍停顿后进入下一条。",false,"已关闭；后续组合操作恢复评论后点赞。");
void installCheckbox("#ai-auto-complete","aiAutoComplete","#ai-auto-status","已开启；空回复框自动生成候选。",false,"已关闭；手动推荐仍可使用。");
void installCheckbox("#ai-fill-recommended","aiFillRecommended","#ai-fill-status","已开启；为你推荐的空回复框会自动填入一条草稿。",false,"已关闭；恢复原有 AI 补全设置。");
void installCheckbox("#hide-completed-home","hideCompletedHome","#home-filter-status","已开启，按本机已确认记录筛选。");
void installCheckbox("#auto-hide-like-notifications","autoHideLikeNotifications","#like-filter-status","已开启，后续接收时过滤点赞通知；空批暂停翻页。",true);
void installCheckbox("#auto-hide-follow-notifications","autoHideFollowNotifications","#follow-filter-status","已开启，后续接收时过滤关注通知；空批暂停翻页。",true);
void installCheckbox("#auto-hide-repost-notifications","autoHideRepostNotifications","#repost-filter-status",
  "已开启，后续接收时过滤转发通知；带正文的引用帖保留。",false,"已关闭；刷新通知页可恢复此前被过滤的转发通知。");

async function installInteractionSkip() {
  const form = document.querySelector("#recommended-interaction-skip");
  const settings = globalThis.XReplySkipAuthors;
  if (!form || !settings) return;
  const {enabled,gap} = form.elements;
  const button = form.querySelector('button[type="submit"]');
  const status = form.querySelector('[role="status"]');
  const key = settings.RECOMMENDED_KEY;
  try {
    let saved = settings.interactionSkipSetting((await chrome.storage.local.get(key))[key]);
    function paint() {
      enabled.checked = saved.enabled;
      gap.value = saved.gap;
      status.textContent = saved.enabled ? `已开启，差值超过 ${saved.gap} 篇时跳过。` : "已关闭。";
    }
    paint();
    enabled.disabled = gap.disabled = button.disabled = false;
    form.addEventListener("input",() => { status.textContent = "修改后点击保存差值设置。"; });
    form.addEventListener("submit",async event => {
      event.preventDefault();
      if (button.disabled || !form.checkValidity()) return;
      const next = {enabled:enabled.checked,gap:gap.valueAsNumber};
      enabled.disabled = gap.disabled = button.disabled = true;
      try {
        await chrome.storage.local.set({[key]:next});
        saved = next;
        paint();
      } catch {
        paint();
        status.textContent = "设置未保存，请重试。";
      } finally {
        enabled.disabled = gap.disabled = button.disabled = false;
      }
    });
  } catch { status.textContent = "差值设置暂时不可用，请重新打开扩展。"; }
}
void installInteractionSkip();

let popupAccount = "";
const skipAuthors = globalThis.XReplySkipAuthors?.createClient(chrome.storage,skippedChanged => {
  if (skippedChanged) renderSkipAuthors();
});

function renderSkipAuthors() {
  if (!popupAccount || !skipAuthors?.revision()) return;
  const panel = document.querySelector("#reply-skip-authors");
  const status = panel.querySelector('[role="status"]');
  const authors = [...skipAuthors.authors(popupAccount)].sort();
  panel.querySelector("summary").textContent = `自动跳过名单（${authors.length}）`;
  status.textContent = authors.length ? `@${popupAccount} 的本地名单` : "当前账号没有标记跳过的作者。";
  const items = authors.map(author => {
    const row = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "恢复";
    button.setAttribute("aria-label",`恢复 @${author}`);
    button.addEventListener("click",async () => {
      button.disabled = true;
      try {
        const result = await chrome.runtime.sendMessage({ type:"SET_REPLY_SKIP_AUTHOR",account:popupAccount,author,skipped:false });
        if (!result?.ok) throw new Error(result?.error || "名单暂不可用，请重试。");
      } catch (error) {
        status.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });
    row.append(`@${author}`,button);
    return row;
  });
  panel.querySelector("ul").replaceChildren(...items);
}

(async () => {
  const status = document.querySelector("#status");
  try {
    const [tab] = await chrome.tabs.query({ active:true,currentWindow:true });
    const { account } = await chrome.tabs.sendMessage(tab.id,{ type:"GET_ACCOUNT" });
    if (!account) throw new Error("请先打开已登录的 X 页面。");
    popupAccount = account;
    if (skipAuthors) void skipAuthors.ready().then(ready => {
      if (ready) renderSkipAuthors();
      else document.querySelector('#reply-skip-authors [role="status"]').textContent = "名单暂不可用，请重新打开扩展。";
    });
    const summary = await chrome.runtime.sendMessage({ type:"SUMMARY",account });
    if (!summary?.ok) throw new Error(summary?.error || "本地记录暂不可用");
    status.textContent = `@${account}\n已记录 ${summary.replyCount} 组文字回复 · ${summary.likeCount} 条红心`;
    status.title = "文字按当前账号、原帖和对方去重；红心按帖子去重，仅统计本地仍有已点赞证据的记录。历史来源不同，二者不保证相等。";
    const statistics=document.querySelector("#statistics-status");
    const capacity = summary.interactionLimit ? `/${summary.interactionLimit.toLocaleString("en-US")}` : "";
    if(statistics)statistics.textContent=summary.statistics ?
      `独立互动事实 ${summary.statistics.factCount}${capacity} · ${summary.statistics.incomplete?"历史不完整，按下限显示":"本地已确认"}${summary.statistics.atCapacity?" · 账本已达容量":""}。升级前备份已保留。` : "互动统计尚未迁移，请重载扩展后刷新 X。";
    const report = document.querySelector("#interaction-report");
    if (report && summary.accountId) {
      const query = new URLSearchParams({account,accountId:summary.accountId});
      report.href = `interaction-report.html?${query}`;
      report.hidden = false;
    }
    const history = document.querySelector("#history");
    history.href = `https://x.com/${account}/with_replies`;
    history.hidden = false;
  } catch {
    status.textContent = "请打开已登录的 X 页面。刚安装或更新后，请先刷新 X。";
  }
})();

void globalThis.XReplyTimedReplies?.installSettings(chrome.storage);
