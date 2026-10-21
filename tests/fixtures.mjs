export const users = [
  { id:"101", handle:"my_account" },
  { id:"202", handle:"alice" },
  { id:"303", handle:"bob" },
  { id:"404", handle:"other_account" },
  { id:"505", handle:"carol" }
];

export function post(id, authorId, conversationId, parentId = "", recipientId = "", text = "测试内容") {
  return { id, authorId, conversationId, parentId, recipientId, text };
}

export function graphql(tweet) {
  const author = users.find(user => user.id === tweet.authorId);
  return {
    __typename:"Tweet", rest_id:tweet.id,
    core:{ user_results:{ result:{
      __typename:"User", rest_id:author.id, core:{ screen_name:author.handle }
    } } },
    legacy:{
      id_str:tweet.id, user_id_str:tweet.authorId, conversation_id_str:tweet.conversationId,
      in_reply_to_status_id_str:tweet.parentId || null,
      in_reply_to_user_id_str:tweet.recipientId || null, full_text:tweet.text
    }
  };
}

export const demoTweets = [
  post("2112500000000000001","101","2112500000000000001","","","我分享了一些最近做工具的心得。"),
  post("2112500000000000002","202","2112500000000000001","2112500000000000001","101","很有启发，感谢分享！"),
  post("2112500000000000003","101","2112500000000000001","2112500000000000002","202","谢谢，欢迎交流！"),
  post("2112500000000000004","202","2112500000000000001","2112500000000000003","101","不客气，一起加油。"),
  post("2112500000000000005","303","2112500000000000001","2112500000000000001","101","第一次看到这个方法，具体怎么用呢？"),
  post("2112500000000000006","202","2112500000000000006","","","今天分享一个小技巧。"),
  post("2112500000000000007","101","2112500000000000006","2112500000000000006","202","学到了，感谢分享。"),
  post("2112500000000000008","202","2112500000000000006","2112500000000000007","101","感谢支持！"),
  post("2112500000000000009","303","2112500000000000006","2112500000000000007","101","也想请教你一个问题。"),
  post("2112500000000000010","101","2112500000000000010","","","这是另一篇新原帖。"),
  post("2112500000000000011","202","2112500000000000010","2112500000000000010","101","这篇也很有意思。"),
  post("2112500000000000013","505","2112500000000000001","2112500000000000001","101","第一次来，这个思路很有意思！")
];
