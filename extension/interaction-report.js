(() => {
  "use strict";

  const byId = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const account = params.get("account");
  const accountId = params.get("accountId");
  const status = byId("report-status");
  const refresh = byId("refresh-report");
  if (!/^[a-z0-9_]{1,15}$/i.test(account || "") || !/^\d{1,25}$/.test(accountId || "")) {
    status.textContent = "请在已登录的 X 标签页打开扩展，再点击「互动分析」。";
    refresh.disabled = true;
    return;
  }
  byId("report-account").textContent = `@${account}`;

  const results = byId("report-results");
  const filters = byId("report-filters");
  const relationship = byId("relationship");
  const sort = byId("sort-order");
  const rows = byId("report-rows");
  const previous = byId("previous-page");
  const next = byId("next-page");
  const actionStatus = byId("action-status");
  const matchCount = byId("match-count");
  const metricButtons = [...document.querySelectorAll(".metrics [data-filter]")];
  const filterButtons = [...document.querySelectorAll("[data-filter]")];
  const pendingActions = new Set();
  const number = new Intl.NumberFormat("zh-CN");
  let page = 1, pages = 1, requestNumber = 0, readTimer;

  function setStatus(element,text,error = false) {
    element.textContent = text;
    element.dataset.error = String(error);
  }

  function selectRelationship(value) {
    relationship.value = value;
    if (value === "theirsOnly" || value === "theirsMore") sort.value = "theirsDesc";
    if (value === "mineOnly" || value === "mineMore") sort.value = "mineDesc";
    queueRead(true);
  }

  function queueRead(resetPage = false,delay = 0) {
    if (resetPage) page = 1;
    const request = ++requestNumber;
    clearTimeout(readTimer);
    for (const button of filterButtons) button.setAttribute("aria-pressed",String(button.dataset.filter === relationship.value));
    previous.disabled = next.disabled = true;
    if (!filters.checkValidity()) {
      results.removeAttribute("aria-busy");
      refresh.disabled = false;
      matchCount.textContent = "最低篇数请输入非负整数。";
      return;
    }
    refresh.disabled = true;
    results.setAttribute("aria-busy","true");
    if (delay) readTimer = setTimeout(() => void read(request),delay);
    else void read(request);
  }

  async function read(request) {
    try {
      const response = await chrome.runtime.sendMessage({type:"INTERACTION_REPORT",account,accountId,page,
        filter:relationship.value,sort:sort.value,search:byId("author-search").value,
        minMine:byId("minimum-mine").valueAsNumber || 0,minTheirs:byId("minimum-theirs").valueAsNumber || 0});
      if (request !== requestNumber) return;
      if (!response?.ok) throw new Error(response?.error || "本地统计暂时不可用，请刷新报表。");
      render(response);
      setStatus(status,"");
      results.hidden = false;
    } catch (error) {
      if (request !== requestNumber) return;
      setStatus(status,error.message,true);
      results.hidden = true;
    } finally {
      if (request === requestNumber) {
        refresh.disabled = false;
        results.removeAttribute("aria-busy");
      }
    }
  }

  function countCell(count,direction,atLegacyBound) {
    const cell = document.createElement("td");
    cell.className = `count ${count ? direction : "unknown"}`;
    cell.textContent = count ? number.format(count) : "待确认";
    if (atLegacyBound) {
      const note = document.createElement("span");
      note.className = "author-note";
      note.textContent = "历史下限";
      note.title = "旧汇总与现有逐帖记录可能重叠。显示两者中较大的篇数，确认篇数超过旧下限后数字才会增加。";
      cell.append(note);
    }
    return cell;
  }

  function authorLabel(row) {
    return row.handle ? `@${row.handle}` : `ID ${row.peerId}`;
  }

  function renderRow(row) {
    const line = document.createElement("tr");
    const person = document.createElement("td");
    if (row.confirmed) {
      const link = document.createElement("a");
      link.href = `https://x.com/${row.handle}`;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = authorLabel(row);
      person.append(link);
    } else {
      person.textContent = row.handle ? `@${row.handle}` : "用户名待确认";
      const note = document.createElement("span");
      note.className = "author-note";
      note.textContent = row.peerId ? `ID ${row.peerId}` : "来自现有名单";
      person.append(note);
    }
    const action = document.createElement("td");
    const buttons = document.createElement("div");
    buttons.className = "row-actions";
    const actions = [
      ["skipped",row.skipped ? "恢复" : "标记跳过",row.handle],
      ["whitelisted",row.whitelisted ? "移出白名单" : "加入白名单",row.peerId]
    ];
    for (const [list,label,id] of actions) {
      if (!row.confirmed && !row[list]) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "row-action";
      button.dataset.action = `${list}:${id}`;
      button.textContent = label;
      button.setAttribute("aria-label",`${label} ${authorLabel(row)}`);
      button.disabled = pendingActions.has(button.dataset.action);
      button.addEventListener("click",() => void toggleList(row,button,list));
      buttons.append(button);
    }
    if (buttons.childElementCount) action.append(buttons);
    else {
      action.className = "author-note";
      action.textContent = "账号待确认";
    }
    line.append(person,countCell(row.myCommentedPosts,"mine",row.mineAtLegacyBound),
      countCell(row.theirCommentedPosts,"theirs",row.theirsAtLegacyBound),action);
    return line;
  }

  function render(report) {
    const coverage = byId("coverage-status");
    coverage.dataset.limited = String(report.incomplete || report.atCapacity);
    const history = report.incomplete ? "历史记录不完整，按下限展示" : "本机已确认的互动记录";
    coverage.textContent = report.atCapacity ? `互动账本已达容量 · ${history}` : history;
    for (const button of metricButtons) button.querySelector("strong").textContent = number.format(report.totals[button.dataset.filter]);
    const sortTheirs = sort.value.startsWith("theirs");
    byId("mine-heading").removeAttribute("aria-sort");
    byId("theirs-heading").removeAttribute("aria-sort");
    byId(sortTheirs ? "theirs-heading" : "mine-heading").setAttribute("aria-sort",sort.value.endsWith("Asc") ? "ascending" : "descending");

    const focus = rows.contains(document.activeElement) ? document.activeElement.dataset.action : "";
    rows.replaceChildren(...report.rows.map(renderRow));
    if (!report.rows.length) {
      const cell = rows.insertRow().insertCell();
      cell.colSpan = 4;
      cell.className = "empty";
      cell.textContent = "没有符合当前条件的作者。";
    }
    if (focus) [...rows.querySelectorAll("button")].find(button => button.dataset.action === focus)?.focus({preventScroll:true});
    page = report.page;
    pages = report.pages;
    matchCount.textContent = `找到 ${number.format(report.total)} 位作者`;
    byId("page-number").textContent = `第 ${number.format(page)} / ${number.format(pages)} 页`;
    previous.disabled = page === 1;
    next.disabled = page >= pages;
  }

  async function toggleList(row,button,list) {
    const action = button.dataset.action;
    if (pendingActions.has(action)) return;
    pendingActions.add(action);
    button.disabled = true;
    setStatus(actionStatus,"");
    try {
      const type = list === "whitelisted" ? "INTERACTION_REPORT_SET_WHITELIST" : "INTERACTION_REPORT_SET_SKIP";
      const result = await chrome.runtime.sendMessage({type,account,accountId,author:row.handle,peerId:row.peerId,[list]:!row[list]});
      if (!result?.ok) throw new Error(result?.error || "名单未保存，请重试。");
      setStatus(actionStatus,`${button.textContent}成功 · ${authorLabel(row)}`);
      queueRead(false,120);
    } catch (error) {
      setStatus(actionStatus,error.message,true);
    } finally {
      pendingActions.delete(action);
      for (const current of rows.querySelectorAll("button")) {
        if (current.dataset.action === action) current.disabled = false;
      }
    }
  }

  for (const button of filterButtons) button.addEventListener("click",() => selectRelationship(button.dataset.filter));
  relationship.addEventListener("change",() => selectRelationship(relationship.value));
  sort.addEventListener("change",() => queueRead(true));
  for (const input of filters.querySelectorAll("input")) input.addEventListener("input",() => queueRead(true,180));
  filters.addEventListener("submit",event => { event.preventDefault(); queueRead(true); });
  refresh.addEventListener("click",() => queueRead());
  previous.addEventListener("click",() => { if (page > 1) { page--; queueRead(); } });
  next.addEventListener("click",() => { if (page < pages) { page++; queueRead(); } });
  chrome.storage.onChanged.addListener((changes,area) => {
    if (area === "local" && (changes.replySkipAuthors || changes.replySkipWhitelist) && !document.hidden) queueRead(false,120);
  });
  queueRead();
})();
