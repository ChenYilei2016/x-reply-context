(() => {
  "use strict";

  const USER_CELL = '[data-testid="UserCell"]';
  const COLUMN = '[data-testid="primaryColumn"]';
  const HIDDEN = "data-xrc-people-hidden";
  const FOLLOW_BUTTON = ':is(button,[role="button"]):is([data-testid$="-follow"],[data-testid$="-unfollow"])';
  const GAP_HELP = "仅当粉丝数大于关注数时检查：（粉丝数 − 关注数）÷ 粉丝数。关注数不少于粉丝数时通过此项。";
  const DEFAULT_STATUS = "仅筛选已加载账号";
  const EMPTY_CRITERIA = {maxFollowers:null,maxGap:null,hideFollowed:false};

  function create({accountHandle,countsFor,handleFromName,isPeopleList,storage}) {
    let view, form, status;
    const hidden = new Map();

    function person(cell) {
      const button = cell.querySelector(FOLLOW_BUTTON);
      const match = button?.getAttribute("data-testid")?.match(/^(\d{1,25})-(follow|unfollow)$/);
      if (match) return {key:match[1],id:match[1],followed:match[2]==="unfollow"};
      for (const name of cell.querySelectorAll('a[href] [dir="ltr"]')) {
        const handle = handleFromName(name);
        if (handle) return {key:`@${handle}`,handle};
      }
      return {};
    }

    function excluded(user,{maxFollowers,maxGap,hideFollowed}) {
      if (hideFollowed && user.followed) return true;
      if (maxFollowers === null && maxGap === null) return false;
      const counts = countsFor(user.handle,user.id);
      if (maxFollowers !== null && counts?.followers >= maxFollowers) return true;
      if (maxGap === null || counts?.followers === undefined || counts.following === undefined) return false;
      const {followers,following} = counts;
      return followers > following && (followers-following)*100/followers > maxGap;
    }

    function restore() {
      for (const node of hidden.keys()) node.removeAttribute(HIDDEN);
      hidden.clear();
    }

    function reset() {
      restore();
      form?.remove();
      form = undefined;
      view = undefined;
    }

    function apply(criteria) {
      if (criteria.maxFollowers === null && criteria.maxGap === null && !criteria.hideFollowed) {
        restore();
        status.textContent = DEFAULT_STATUS;
        return;
      }
      const cells = view.column.querySelectorAll(USER_CELL);
      const next = new Map();
      for (const cell of cells) {
        const user = person(cell);
        if (!user.key || !excluded(user,criteria)) continue;
        const wrapper = cell.closest('[data-testid="cellInnerDiv"]');
        const node = wrapper && !wrapper.querySelector('[role="tablist"]') &&
          wrapper.querySelectorAll(USER_CELL).length === 1 ? wrapper : cell;
        next.set(node,{cell,key:user.key});
      }
      for (const node of hidden.keys()) if (!next.has(node)) node.removeAttribute(HIDDEN);
      hidden.clear();
      for (const [node,entry] of next) {
        if (!node.hasAttribute(HIDDEN)) node.setAttribute(HIDDEN,"");
        hidden.set(node,entry);
      }
      status.textContent = cells.length && next.size === cells.length ? "本批无匹配，可点「清除」" :
        `本次显示 ${cells.length-next.size}/${cells.length} 个`;
    }

    function buildForm(account) {
      const key = `peopleListFilter:${account}`;
      let editRevision = 0;
      const controls = document.createElement("form");
      controls.className = "xrc-people-filter";
      controls.setAttribute("aria-label","关注列表筛选");
      function numberField(text,max,step,unit = "",title = "") {
        const label = document.createElement("label"), input = document.createElement("input");
        input.type = "number";
        input.min = "0";
        input.max = String(max);
        input.step = step;
        input.placeholder = "不限";
        label.title = title;
        label.append(text,input,unit);
        controls.append(label);
        return input;
      }
      const followers = numberField("粉丝数 <",Number.MAX_SAFE_INTEGER,"1");
      followers.setAttribute("aria-label","粉丝数上限");
      const gap = numberField("关粉差 ≤",100,"any","%",GAP_HELP);
      gap.setAttribute("aria-label","关粉差百分比上限");
      gap.title = GAP_HELP;
      const label = document.createElement("label"), followed = document.createElement("input");
      followed.type = "checkbox";
      label.append(followed,"隐藏已关注");
      const submit = document.createElement("button"), clear = document.createElement("button");
      submit.type = "submit";
      submit.textContent = "应用";
      clear.type = "button";
      clear.textContent = "清除";
      status = document.createElement("span");
      status.setAttribute("role","status");
      status.textContent = DEFAULT_STATUS;
      controls.append(label,submit,clear,status);

      async function save(criteria) {
        if (form !== controls || view.path !== location.pathname || accountHandle() !== account ||
            document.querySelector(COLUMN) !== view.column) return;
        const revision = ++editRevision;
        if (!criteria) controls.reset();
        apply(criteria ?? EMPTY_CRITERIA);
        try {
          if (criteria) await storage.set({[key]:criteria});
          else await storage.remove(key);
        } catch (error) {
          if (form === controls && editRevision === revision) {
            status.textContent = criteria ? "已筛选，条件保存失败" : "已恢复列表，保存值清除失败";
          }
          console.warn("回过了：无法更新关注列表筛选条件",error.message);
        }
      }

      async function load() {
        try {
          const saved = (await storage.get(key))[key];
          if (!saved || form !== controls || editRevision || accountHandle() !== account) return;
          followers.value = saved.maxFollowers ?? "";
          gap.value = saved.maxGap ?? "";
          followed.checked = saved.hideFollowed === true;
        } catch (error) {
          console.warn("回过了：无法读取关注列表筛选条件",error.message);
        }
      }

      controls.addEventListener("input",() => { editRevision++; });
      controls.addEventListener("submit",event => {
        event.preventDefault();
        void save({maxFollowers:followers.value === "" ? null : followers.valueAsNumber,
          maxGap:gap.value === "" ? null : gap.valueAsNumber,hideFollowed:followed.checked});
      });
      clear.addEventListener("click",() => { void save(null); });
      void load();
      return controls;
    }

    function refresh(account) {
      if (!account || !isPeopleList()) { if (view) reset(); return; }
      const column = document.querySelector(COLUMN);
      if (!column) { if (view) reset(); return; }
      const path = location.pathname;
      const tabs = column.querySelector('[role="tablist"]');
      const anchor = tabs?.closest("nav") || tabs;
      if (view?.column !== column || view.path !== path || view.account !== account || !form?.isConnected) {
        restore();
        if (!form || view?.account !== account) {
          form?.remove();
          form = buildForm(account);
        }
        view = {column,path,account};
        status.textContent = DEFAULT_STATUS;
      }
      if (anchor && anchor.nextElementSibling !== form) anchor.after(form);
      else if (!anchor && form.parentElement !== column) column.prepend(form);
      // The site may recycle a virtual cell for another account after applying a batch.
      for (const [node,{cell,key}] of hidden) {
        if (column.contains(node) && node.contains(cell) && person(cell).key === key) continue;
        node.removeAttribute(HIDDEN);
        hidden.delete(node);
      }
    }

    return {refresh,reset};
  }

  globalThis.XReplyPeopleFilter = {create};
})();
