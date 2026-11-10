(() => {
  "use strict";
  const status=document.querySelector('#status'),button=document.querySelector('#export');let db;
  const request=operation=>new Promise((resolve,reject)=>{operation.onsuccess=()=>resolve(operation.result);operation.onerror=()=>reject(operation.error);});
  void (async()=>{
    const open=indexedDB.open('x-reply-context-records');open.onupgradeneeded=()=>open.transaction.abort();
    db=await request(open);db.onversionchange=()=>db.close();
    if(!db.objectStoreNames.contains('backups'))throw Error('请先重载新版扩展，并打开 X 页面完成迁移。');
    const transaction=db.transaction(['backups','metadata'],'readonly');
    const [backup,metadata]=await Promise.all([request(transaction.objectStore('backups').get('manifest')),request(transaction.objectStore('metadata').get('state'))]);
    if(!backup)throw Error('未找到升级前备份。');
    const stats=metadata?.value?.statistics;
    const limit=globalThis.XReplyContext.INTERACTION_LIMIT;
    const atCapacity=stats&&(stats.factCount>=limit || stats.peopleCount>=limit);
    status.textContent=`备份时间：${new Date(backup.value.at).toLocaleString()}\n${stats?`已确认互动事实：${stats.factCount}/${limit.toLocaleString('en-US')} · ${stats.incomplete?'历史不完整，按下限显示':'本机已确认'}${atCapacity?' · 账本已达容量':''}`:'迁移尚未完成，旧备份仍保留。'}`;
    button.disabled=false;
  })().catch(error=>{status.textContent=error.message||'备份暂不可用。';});
  button.addEventListener('click',async()=>{
    button.disabled=true;
    try {
      const chunks=['{"format":"xrc-pre-ledger-v1","records":['],encoder=new TextEncoder();let count=0,bytes=0;
      await new Promise((resolve,reject)=>{
        const transaction=db.transaction('backups','readonly'),cursor=transaction.objectStore('backups').openCursor();
        transaction.oncomplete=resolve;transaction.onabort=()=>reject(Error('备份导出失败或超过64 MiB导出边界，原备份仍完整保留。'));
        cursor.onsuccess=()=>{
          const row=cursor.result;if(!row)return;
          const text=JSON.stringify(row.value);bytes+=encoder.encode(text).byteLength;
          if(++count>140002||bytes>64*1024*1024){transaction.abort();return;}
          chunks.push((count>1?',':'')+text);row.continue();
        };
      });
      chunks.push(']}');const url=URL.createObjectURL(new Blob(chunks,{type:'application/json'})),a=document.createElement('a');
      a.href=url;a.download=`x-reply-context-pre-ledger-${Date.now()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
      status.textContent+='\n已生成本机备份文件。';
    }catch(error){status.textContent=error.message;}finally{button.disabled=false;}
  });
})();
