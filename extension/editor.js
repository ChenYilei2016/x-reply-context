(() => {
  "use strict";
  const read = editor => editor?.innerText.replace(/\n$/,"") || "";
  const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
  const writing = new WeakSet();
  async function insert(editor,text,{replace = false,expected = read(editor),valid = () => true} = {}) {
    if (!editor?.isConnected || !valid() || read(editor) !== expected || editor.getAttribute("aria-disabled") === "true") return false;
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
      await frame();
      if (!valid() || !editor.isConnected || read(editor) !== expected || !editor.contains(selection.anchorNode) ||
          (replace ? selection.toString().replace(/\n$/,"") !== expected : !selection.isCollapsed)) return false;
      const data = new DataTransfer(); data.setData("text/plain",text);
      const paste = new ClipboardEvent("paste",{bubbles:true,cancelable:true,clipboardData:data});
      editor.dispatchEvent(paste);
      if (!paste.defaultPrevented) return false; // No native fallback on a controlled editor.
      await frame();
    } else if (!document.execCommand("insertText",false,text)) return false;
    return editor.isConnected && read(editor) === (replace ? text : expected+text);
  }
  async function write(editor,text,options) {
    if (!editor || writing.has(editor)) return false;
    writing.add(editor);
    try { return await insert(editor,text,options); }
    finally { writing.delete(editor); }
  }
  globalThis.XReplyEditor = {read,write,busy:editor => Boolean(editor && writing.has(editor))};
})();
