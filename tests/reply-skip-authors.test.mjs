import test from 'node:test';
import assert from 'node:assert/strict';
import '../extension/reply-skip-authors.js';

const {createClient,createWriter} = globalThis.XReplySkipAuthors;

test('不同标签的并发标记都保留，按当前账号隔离并可恢复',async()=>{
  const saved = {}, listeners = [];
  const storage = {local:{
    get:async key=>({[key]:structuredClone(saved[key])}),
    set:async values=>{
      Object.assign(saved,structuredClone(values));
      for (const listener of listeners) listener({replySkipAuthors:{newValue:saved.replySkipAuthors}},'local');
    }
  },onChanged:{addListener:listener=>listeners.push(listener)}};
  const write = createWriter(storage), page = createClient(storage), popup = createClient(storage);
  assert.equal(await page.ready(),true);
  const results = await Promise.all([
    write({account:'Me',author:'ALICE',skipped:true}),
    write({account:'me',author:'bob',skipped:true}),
    write({account:'other',author:'carol',skipped:true})
  ]);
  assert.ok(results.every(result=>result.ok));
  assert.deepEqual([...page.authors('me')],['alice','bob']);
  assert.deepEqual([...popup.authors('other')],['carol']);
  await write({account:'me',author:'alice',skipped:false});
  assert.deepEqual([...page.authors('me')],['bob']);
  assert.deepEqual([...popup.authors('other')],['carol']);
  assert.equal((await write({account:'me',author:'ME',skipped:true})).ok,false);
});

test('启动时先收到的新名单不会被较早的读取结果覆盖',async()=>{
  let receive, finishRead;
  const storage = {local:{get:()=>new Promise(resolve=>{finishRead=resolve;})},
    onChanged:{addListener:listener=>{receive=listener;}}};
  const client = createClient(storage);
  receive({replySkipAuthors:{newValue:{me:['alice']}}},'local');
  finishRead({replySkipAuthors:{me:['bob']}});
  assert.equal(await client.ready(),true);
  assert.deepEqual([...client.authors('me')],['alice']);
});
