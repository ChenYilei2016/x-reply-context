// Local popup preview. No access to real extension settings or X accounts.
(() => {
 const settings={};
 const note=document.createElement('p');note.textContent='本地弹窗模拟 · 设置仅存在此页';document.body.prepend(note);
 globalThis.chrome={storage:{local:{get:async key=>({[key]:settings[key]}),set:async value=>Object.assign(settings,value)}},
  tabs:{query:async()=>[{id:1}],sendMessage:async()=>({account:'demo_account'})},
  runtime:{sendMessage:async()=>({ok:true,replyCount:0,likeCount:0})}};
})();
