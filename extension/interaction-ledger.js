/* Durable, compact comment facts. Cache eviction never decrements these totals. */
(() => {
  "use strict";
  const core=globalThis.XReplyContext;
  const safeCount=value=>Number.isSafeInteger(value)&&value>=0?value:0;
  const first=(a,b)=>!a?b:!b?a:BigInt(a)<BigInt(b)?a:b;
  const person=()=>({myCommentedPosts:0,theirCommentedPosts:0,legacyMyLowerBound:0,legacyTheirLowerBound:0,firstCommentOnMyPostId:"",seenAt:0});
  const field=fact=>fact.direction==="out"?"myCommentedPosts":"theirCommentedPosts";
  const pair=fact=>`${fact.accountId}:${fact.peerId}`;
  const atCapacity=statistics=>statistics.factCount>=core.INTERACTION_LIMIT || statistics.peopleCount>=core.INTERACTION_LIMIT;
  function addPersonFact(value,fact,increment) {
    if(increment)value[field(fact)]++;
    if(fact.direction==="in")value.firstCommentOnMyPostId=first(value.firstCommentOnMyPostId,fact.firstReplyId);
    value.seenAt=Math.max(value.seenAt,Number.isFinite(fact.seenAt)?fact.seenAt:0);
  }
  function migrationPlan(state,legacy,backupAt) {
    const facts=new Map(),people={};
    const sources=[state,...(legacy?.version===1?[legacy]:[])];
    const statistics={version:2,factCount:0,peopleCount:0,incomplete:false,atCapacity:false,backupAt,migratedAt:Date.now()};
    for(const source of sources){
      if(["tweets","replies","people","accounts"].some(name=>Object.keys(source[name] || {}).length))statistics.incomplete=true;
      for(const [key,old] of Object.entries(source.people || {})){
        const ids=key.split(":");if(ids.length!==2||!ids.every(core.id)||ids[0]===ids[1])continue;
        if(!people[key]){
          if(statistics.peopleCount>=core.INTERACTION_LIMIT){statistics.incomplete=true;continue;}
          people[key]=person();statistics.peopleCount++;
        }
        const value=people[key],firstId=core.id(old.firstCommentOnMyPostId);
        value.legacyMyLowerBound=Math.max(value.legacyMyLowerBound,safeCount(old.myCommentedPosts));
        value.legacyTheirLowerBound=Math.max(value.legacyTheirLowerBound,safeCount(old.theirCommentedPosts),firstId?1:0);
        value.firstCommentOnMyPostId=first(value.firstCommentOnMyPostId,firstId);
        value.seenAt=Math.max(value.seenAt,Number.isFinite(old.seenAt)?old.seenAt:0);
      }
    }
    for(const source of sources){
      for(const fact of core.interactionFacts({...source,accounts:{...state.accounts,...source.accounts}})){
        const key=pair(fact),previous=facts.get(fact.key);
        if(!previous && (facts.size>=core.INTERACTION_LIMIT || !people[key]&&statistics.peopleCount>=core.INTERACTION_LIMIT)){
          statistics.incomplete=true;continue;
        }
        if(!people[key]){people[key]=person();statistics.peopleCount++;}
        addPersonFact(people[key],fact,!previous);
        if(!previous)facts.set(fact.key,fact);
        else if(fact.firstReplyId)previous.firstReplyId=first(previous.firstReplyId,fact.firstReplyId);
      }
    }
    statistics.factCount=facts.size;
    statistics.atCapacity=atCapacity(statistics);
    return {facts,people,statistics};
  }
  function create({request}) {
    async function apply(transaction,facts,overflow=false) {
      const factStore=transaction.objectStore("interactionFacts"),peopleStore=transaction.objectStore("people");
      const keys=[...new Set(facts.map(pair))];
      const [metadata,oldFacts,oldPeople]=await Promise.all([
        request(transaction.objectStore("metadata").get("state")),
        Promise.all(facts.map(fact=>request(factStore.get(fact.key)))),
        Promise.all(keys.map(key=>request(peopleStore.get(key))))
      ]);
      if(metadata?.value?.statistics?.version!==2)throw Error("互动统计尚未完成迁移");
      const statistics={...metadata.value.statistics},people=new Map(keys.map((key,i)=>[key,oldPeople[i]?.value]));
      const changed=new Set();let statsChanged=false;
      const incomplete=()=>{
        if(!statistics.incomplete)statsChanged=true;
        statistics.incomplete=true;
      };
      if(overflow)incomplete();
      for(let i=0;i<facts.length;i++){
        const fact=facts[i],key=pair(fact),previous=oldFacts[i];let value=people.get(key);
        if(previous&&!value)throw Error("互动事实与人物汇总不一致，请保留备份后检查");
      if(!previous && (statistics.factCount>=core.INTERACTION_LIMIT || !value&&statistics.peopleCount>=core.INTERACTION_LIMIT)){incomplete();continue;}
        if(previous && (!fact.firstReplyId || previous.firstReplyId&&BigInt(previous.firstReplyId)<=BigInt(fact.firstReplyId)))continue;
        if(!value){value=person();statistics.peopleCount++;}
        else if(!changed.has(key))value={...value};
        addPersonFact(value,fact,!previous);people.set(key,value);changed.add(key);statsChanged=true;
        factStore.put(previous?{...previous,firstReplyId:fact.firstReplyId}:{...fact});
        if(!previous)statistics.factCount++;
      }
    const full=atCapacity(statistics);
    if(statistics.atCapacity!==full){statistics.atCapacity=full;statsChanged=true;}
      const updated=new Map();
      for(const key of changed){const value=people.get(key);peopleStore.put({key,value});updated.set(key,value);}
      return {statistics,people:updated,statsChanged};
    }
    return {apply};
  }
  globalThis.XReplyInteractionLedger={migrationPlan,create,atCapacity};
})();
