export const fixtureRootId = index => String(10000000000000000000n+BigInt(index));

export function performanceState(core,now = Date.now()) {
const state = core.createState();
const limit=core.LIMIT;
const me = '90000000000000000000';
const rootId = fixtureRootId;
for (let i = 0; i < (limit-1); i++) state.users[String(i+2)] = { id:String(i+2),handle:`u${i}`,seenAt:now };
state.users[me] = { id:me,handle:'me',seenAt:now }; state.accounts[me] = now;
for (let i = 0; i < limit; i++) {
  const id = rootId(i),authorId = String(i%(limit-1)+2);
  state.tweets[id] = { id,authorId,conversationId:id,parentId:'',text:'fixture',seenAt:now };
  state.roots[id] = { id,authorId,seenAt:now };
  const conversationId = rootId(i%(limit-100));
  state.replies[`${me}:${conversationId}:${authorId}`] = {
    id:String(20000000000000000000n+BigInt(i)),actorId:me,recipientId:authorId,conversationId,text:'old reply',seenAt:now
  };
  const likeId = String(30000000000000000000n+BigInt(i));
  state.likes[`${me}:${likeId}`] = { id:likeId,actorId:me,recipientId:authorId,conversationId:id,liked:true,seenAt:now };
}
core.ingest(state,{},"me",now);
return state;
}
