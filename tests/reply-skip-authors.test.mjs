import test from 'node:test';
import assert from 'node:assert/strict';
import '../extension/reply-skip-authors.js';

const {createClient,createWriter,readLists,WHITELIST_KEY} = globalThis.XReplySkipAuthors;

test('不同标签的并发标记都保留，按当前账号隔离并可恢复',async()=>{
  const saved = {}, listeners = [];
  const storage = {local:{
    get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,structuredClone(saved[key])])),
    set:async values=>{
      Object.assign(saved,structuredClone(values));
      const changes=Object.fromEntries(Object.keys(values).map(key=>[key,{newValue:saved[key]}]));
      for (const listener of listeners) listener(changes,'local');
    }
  },onChanged:{addListener:listener=>listeners.push(listener)}};
  const write = createWriter(storage), page = createClient(storage), popup = createClient(storage);
  assert.equal(await page.ready(),true);
  assert.equal(page.recommendedInteractionGap(),null);
  const results = await Promise.all([
    write('Me','ALICE',true),
    write('me','bob',true),
    write('other','carol',true)
  ]);
  assert.ok(results.every(result=>result.ok));
  assert.deepEqual([...page.authors('me')],['alice','bob']);
  assert.deepEqual([...popup.authors('other')],['carol']);
  await write('me','alice',false);
  assert.deepEqual([...page.authors('me')],['bob']);
  assert.deepEqual([...popup.authors('other')],['carol']);
  assert.equal((await write('me','ME',true)).ok,false);

  const whitelist = createWriter(storage,WHITELIST_KEY);
  await Promise.all([whitelist('1','1234567890123456789',true),whitelist('2','3',true)]);
  assert.deepEqual([...page.whitelist('1')],['1234567890123456789']);
  assert.deepEqual([...popup.whitelist('2')],['3']);
  assert.deepEqual([...page.authors('me')],['bob']);
  await whitelist('1','1234567890123456789',false);
  assert.equal(page.whitelist('1').size,0);
  assert.deepEqual([...(await readLists(storage,'other','2')).whitelist],['3']);
});

test('启动时先收到的新名单和差值设置不会被较早的读取结果覆盖',async()=>{
  let receive, finishRead;
  const storage = {local:{get:()=>new Promise(resolve=>{finishRead=resolve;})},
    onChanged:{addListener:listener=>{receive=listener;}}};
  const client = createClient(storage);
  receive({replySkipAuthors:{newValue:{me:['alice']}}},'local');
  receive({[WHITELIST_KEY]:{newValue:{'1':['2']}}},'local');
  receive({recommendedInteractionSkip:{newValue:{enabled:true,gap:0}}},'local');
  finishRead({replySkipAuthors:{me:['bob']},[WHITELIST_KEY]:{'1':['3']},recommendedInteractionSkip:{enabled:false,gap:5}});
  assert.equal(await client.ready(),true);
  assert.deepEqual([...client.authors('me')],['alice']);
  assert.deepEqual([...client.whitelist('1')],['2']);
  assert.equal(client.recommendedInteractionGap(),0);
  receive({recommendedInteractionSkip:{newValue:{enabled:false,gap:3}}},'local');
  assert.equal(client.recommendedInteractionGap(),null);
});
