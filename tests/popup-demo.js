// Only the local preview uses these synthetic settings and statistics.
const settings = {};
globalThis.chrome = {
  storage:{ local:{ get:async key => ({ [key]:settings[key] }),set:async values => Object.assign(settings,values) } },
  tabs:{ query:async () => [{ id:1 }],sendMessage:async () => ({ account:'demo_account' }) },
  runtime:{ sendMessage:async () => ({ ok:true,replyCount:286,likeCount:378 }) }
};
