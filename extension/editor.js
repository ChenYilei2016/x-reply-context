(() => {
  "use strict";
  const read = editor => editor?.innerText.replace(/\n$/,"") || "";
  function readDraft(editor) {
    if (!editor) return "";
    const visibleText = editor.innerText;
    if (visibleText.includes("\n") && editor.closest(".DraftEditor-root")) {
      // Draft renders an empty paragraph with a placeholder <br>. Reading the
      // entire editor with innerText counts that placeholder as another line.
      const blocks = editor.querySelectorAll('[data-block="true"]');
      if (blocks.length) return Array.from(blocks, block => block.innerText.replace(/\n$/, "")).join("\n");
    }
    return visibleText.replace(/\n$/, "");
  }
  function frame(signal) {
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise(resolve => {
      const abort = () => {cancelAnimationFrame(frameId);resolve(false);};
      const frameId = requestAnimationFrame(() => {
        signal?.removeEventListener("abort",abort);
        resolve(true);
      });
      signal?.addEventListener("abort",abort,{once:true});
    });
  }
  const writing = new WeakSet();
  async function insert(editor,text,{replace = false,readText = read,expected = readText(editor),valid = () => true,signal} = {}) {
    if (signal?.aborted || !editor?.isConnected || !valid() || readText(editor) !== expected || editor.getAttribute("aria-disabled") === "true") return false;
    editor.focus({preventScroll:true});
    const range = document.createRange(); range.selectNodeContents(editor);
    if (!replace) range.collapse(false);
    const selection = window.getSelection();
    if (!selection) return false;
    selection.removeAllRanges(); selection.addRange(range);
    if (editor.closest(".DraftEditor-root")) {
      // Draft reads its own selection state on paste. Notify it before the next frame,
      // rather than racing the browser's deferred selectionchange event.
      document.dispatchEvent(new Event("selectionchange"));
      if (!await frame(signal) || signal?.aborted) return false;
      if (!valid() || !editor.isConnected || readText(editor) !== expected ||
          !editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)) return false;
      if (replace) {
        const selected = selection.toString();
        if (selected !== expected && selected !== expected+"\n") return false;
      } else if (!selection.isCollapsed) return false;
      const data = new DataTransfer(); data.setData("text/plain",text);
      const paste = new ClipboardEvent("paste",{bubbles:true,cancelable:true,clipboardData:data});
      editor.dispatchEvent(paste);
      if (!paste.defaultPrevented) return false; // No native fallback on a controlled editor.
      if (!await frame(signal) || signal?.aborted) return false;
    } else if (!document.execCommand("insertText",false,text)) return false;
    return editor.isConnected && readText(editor) === (replace ? text : expected+text);
  }
  async function write(editor,text,options) {
    if (!editor || writing.has(editor)) return false;
    writing.add(editor);
    try { return await insert(editor,text,options); }
    finally { writing.delete(editor); }
  }
  globalThis.XReplyEditor = {read,readDraft,write,busy:editor => Boolean(editor && writing.has(editor))};
})();
