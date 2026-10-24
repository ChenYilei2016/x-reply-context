// Uses real React/Draft.js from a separate local test dependency directory, never an X account.
history.replaceState(null,'','/notifications');
const output = document.querySelector('#result');
let flow, frame, latestState = '', commands = 0, sendCalls = 0;
const originalCommand = document.execCommand.bind(document);
document.execCommand = (...args) => { commands++; return originalCommand(...args); };
const requestRefresh = () => {
  if (frame) return;
  frame = requestAnimationFrame(() => { frame = 0; flow.refresh(); });
};
flow = XReplyContinuous.create({
  accountHandle:() => 'me',
  tweetId:article => article.querySelector('time')?.closest('a')?.getAttribute('href')?.split('/').pop() || '',
  columnSelector:'[data-testid="primaryColumn"]',requestRefresh,
  message:async request => ({ok:true,rows:request.ids.map(id => ({
    id,origin:'others',status:'not-reply',rootId:id,authorHandle:'peer',rootText:'本地例子'
  }))}),
  renderLabels:(node,row) => { node.textContent = row.origin; }
});
function Editor({seed}) {
  const [state,setState] = React.useState(() => Draft.EditorState.createWithContent(Draft.ContentState.createFromText(seed)));
  return React.createElement(Draft.Editor,{
    editorState:state,ariaLabel:'本地 Draft 回复',
    onChange:next => { latestState = next.getCurrentContent().getPlainText(); setState(next); }
  });
}
function close() {
  flow.stop();
  const mount = document.querySelector('#draft-root');
  if (mount) ReactDOM.unmountComponentAtNode(mount);
  document.querySelector('[role="dialog"]')?.remove();
  history.replaceState(null,'','/notifications');
}
document.querySelector('[data-testid="reply"]').addEventListener('click',() => {
  const mode = document.querySelector('#mode').value;
  const seed = mode === 'empty' || mode === 'rapid' ? '' : '原稿';
  latestState = seed;
  const dialog = document.createElement('div');
  dialog.setAttribute('role','dialog');
  dialog.innerHTML = '<button data-testid="app-bar-close">关闭</button><div id="draft-root"></div><div data-testid="toolBar"><button data-testid="tweetButton">发送（仅计数）</button></div>';
  dialog.querySelector('[data-testid="app-bar-close"]').addEventListener('click',close);
  dialog.querySelector('[data-testid="tweetButton"]').addEventListener('click',() => sendCalls++);
  document.body.append(dialog);
  history.replaceState(null,'','/compose/post');
  ReactDOM.render(React.createElement(Editor,{seed}),document.querySelector('#draft-root'));
  const editor = document.querySelector('.public-DraftEditor-content');
  editor.dataset.testid = 'tweetTextarea_0';
  if (mode === 'blocked') editor.addEventListener('paste',event => event.stopImmediatePropagation(),true);
  requestRefresh();
});
document.querySelector('#run').addEventListener('click',async () => {
  close(); commands = 0; sendCalls = 0;
  output.dataset.result = "running"; output.textContent = "检查中";
  const mode = document.querySelector('#mode').value;
  document.querySelector('[data-testid="reply"]').click();
  const end = Date.now()+3000;
  while (!document.querySelector('.xrc-quick-reply')) {
    if (Date.now()>end) { output.textContent = '未出现快捷按钮'; return; }
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
  const editor = document.querySelector('[data-testid="tweetTextarea_0"]');
  if (mode === 'selected') {
    editor.focus(); const range = document.createRange(); range.selectNodeContents(editor);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  }
  // Only pin our two phrase draws; Draft also uses randomness for unique block keys.
  const random = Math.random;
  let draws = 0;
  Math.random = () => ++draws <= 2 ? 0 : random();
  try {
    document.querySelector('.xrc-quick-reply').click();
    if (mode === 'rapid') document.querySelector('.xrc-quick-reply').click();
  } finally { Math.random = random; }
  await new Promise(resolve => setTimeout(resolve,100));
  const currentEditor = document.querySelector('[data-testid="tweetTextarea_0"]');
  const expected = mode === 'blocked' ? '原稿' :
    (mode === 'empty' || mode === 'rapid' ? '' : '原稿 ')+'一起加油好兄弟...';
  const result = {
    fixture:true,mode,expected,domText:currentEditor?.innerText,stateText:latestState,commands,sendCalls,
    status:document.querySelector('.xrc-flow-status')?.textContent
  };
  result.pass = result.domText === expected && result.stateText === expected && commands === 0 && sendCalls === 0;
  output.dataset.result = result.pass ? 'passed' : 'failed';
  output.textContent = JSON.stringify(result,null,2);
});
