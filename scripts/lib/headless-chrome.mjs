// 无头 Chrome 与 DevTools 协议（CDP）的最小封装，供浏览器检查与扩展冒烟检查共用。
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function waitFor(probe, timeout, message) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await delay(100);
  }
  throw new Error(message);
}

/** 启动临时配置的无头 Chrome；extraArgs 可加载扩展等。 */
export async function startChrome(extraArgs = []) {
  const profile = mkdtempSync(path.join(tmpdir(), "xrc-chrome-"));
  const browser = spawn(CHROME_PATH, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", ...extraArgs, "about:blank"
  ], { stdio: "ignore" });
  const exited = new Promise(resolve => browser.once("exit", resolve));
  const portFile = path.join(profile, "DevToolsActivePort");
  const port = await waitFor(() => existsSync(portFile) && readFileSync(portFile, "utf8").split("\n")[0], 15000, "Chrome 未启动调试端口");
  return {
    port,
    targets: async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json(),
    open: async url => (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json(),
    async stop() {
      browser.kill();
      await exited;
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  };
}

/** 连接一个调试目标；evaluate 等待 Promise 并按值返回，页面异常转为 Error。 */
export async function connect(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  function send(method, params = {}) {
    const id = ++sequence;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise(resolve => pending.set(id, resolve));
  }
  async function evaluate(expression, { userGesture = false } = {}) {
    const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture });
    const details = response.result?.exceptionDetails;
    if (details) throw new Error(details.exception?.description || details.text || "页面异常");
    return response.result?.result?.value;
  }
  return { send, evaluate, close: () => socket.close() };
}

/**
 * 以管道模式启动无头 Chrome，可通过 CDP 加载未打包扩展（正式版 Chrome 已不支持 --load-extension）。
 * 返回的 client 支持按 sessionId 向各个目标（页面、Service Worker）发送命令。
 */
export async function startChromeWithPipe() {
  const profile = mkdtempSync(path.join(tmpdir(), "xrc-chrome-"));
  const browser = spawn(CHROME_PATH, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    `--user-data-dir=${profile}`, "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", "about:blank"
  ], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const exited = new Promise(resolve => browser.once("exit", resolve));
  const [writer, reader] = [browser.stdio[3], browser.stdio[4]];
  let sequence = 0;
  let buffer = "";
  const pending = new Map();
  reader.on("data", chunk => {
    buffer += chunk.toString("utf8");
    let end;
    while ((end = buffer.indexOf("\0")) >= 0) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
  });

  async function send(method, params = {}, sessionId) {
    const id = ++sequence;
    writer.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
    const message = await new Promise(resolve => pending.set(id, resolve));
    if (message.error) throw new Error(`${method}: ${message.error.message}`);
    return message.result;
  }

  async function evaluate(sessionId, expression, { userGesture = false } = {}) {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "页面异常");
    return result.result?.value;
  }

  /** 附加到满足条件的目标，返回 sessionId。 */
  async function attach(predicate, timeout = 15000) {
    const target = await waitFor(async () => (await send("Target.getTargets")).targetInfos.find(predicate), timeout, "未找到目标");
    return (await send("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
  }

  return {
    send, evaluate, attach,
    async stop() {
      browser.kill();
      await exited;
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  };
}
