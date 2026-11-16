// 浏览器检查页共用：收集断言，结果通过 BrowserCheck.done 交给 scripts/browser-check.mjs，
// 同时写入页面方便手动打开查看。
(() => {
  "use strict";
  const checks = [];
  function check(name, ok, detail = "") { checks.push({ name, ok: Boolean(ok), detail: ok ? "" : String(detail) }); }
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  async function run(scenario) {
    let result;
    try {
      await scenario(check);
      result = { ok: checks.length > 0 && checks.every(item => item.ok), checks };
    } catch (error) {
      result = { ok: false, checks, error: `${error?.message || error}` };
    }
    const output = document.createElement("pre");
    output.textContent = JSON.stringify(result, null, 2);
    document.body.append(output);
    finish(result);
  }
  globalThis.BrowserCheck = { run, done };
})();
