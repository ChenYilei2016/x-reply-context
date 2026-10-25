// Only the local demo editor is edited; this fixture never invokes send or like.
export async function checkQuickReplies() {
  const output = document.querySelector('#quick-replies-status');
  const checks = [];
  const check = (name,ok) => { checks.push({name,ok:Boolean(ok)}); if (!ok) throw new Error(name); };
  const wait = async predicate => {
    const end = Date.now()+3500;
    while (!predicate()) {
      if (Date.now()>end) throw new Error('等待快捷填入控件超时');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
  };
  const frames = () => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const random = Math.random;
  const execCommand = document.execCommand;
  output.dataset.result = 'running';
  try {
    const target = document.querySelector('article[data-testid="tweet"] [data-testid="reply"]');
    const card = target.closest('article'); const top = card.getBoundingClientRect().top;
    target.click(); await wait(()=>document.querySelectorAll('.xrc-quick-reply').length===6);
    const buttons = [...document.querySelectorAll('.xrc-quick-reply')];
    const editor = document.querySelector('[data-testid="tweetTextarea_0"]');
    const quick = document.querySelector('.xrc-quick-replies');
    const height = quick.getBoundingClientRect().height;
    editor.focus(); document.execCommand('insertText',false,'保留我的草稿');
    // The tooltip is the user-visible list of choices; verify insertion against that contract.
    const groups = buttons.map(button => button.title.match(/^随机填入：(.*?)，末尾随机/)[1].split(' / '));
    const endings = ['...','!','!!!','!!'];
    let samples = 0;
    for (const [index,phrases] of groups.entries()) {
      for (let variant=0;variant<4;variant++) {
        const before = editor.innerText;
        // A selection in the draft must not get replaced by a quick phrase.
        const selection = window.getSelection(), range = document.createRange();
        range.selectNodeContents(editor); selection.removeAllRanges(); selection.addRange(range);
        const phraseIndex = Math.round(variant*(phrases.length-1)/3);
        let draws=0; Math.random=()=> draws++===0 ? (phraseIndex+.1)/phrases.length : (variant+.1)/4;
        buttons[index].click(); Math.random=random;
        const expected = before+' '+phrases[phraseIndex]+endings[variant];
        await frames(); await wait(()=>!buttons[index].disabled);
        if (editor.innerText!==expected) throw new Error(`快捷词组${index+1}未按原生编辑路径追加`);
        samples++;
      }
    }
    check('六组词句和四种标点均可原生填入，选中草稿也不覆盖',samples===24 && editor.innerText.startsWith('保留我的草稿'));
    await new Promise(resolve=>setTimeout(resolve,300));
    await frames();
    check('通知回复框原有上下文标签仍保留',!document.querySelector('.xrc-flow-root') || document.querySelector('.xrc-flow-context .xrc-labels'));
    check('输入事件通知编辑器，原生回复按钮可用',!document.querySelector('[data-testid="tweetButton"]').disabled);
    check('快捷行高度与背景列表位置不变',quick.getBoundingClientRect().height===height && card.getBoundingClientRect().top===top);
    editor.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true})); await frames();
    check('中文输入法组字期间暂停快捷填入',buttons.every(button=>button.disabled));
    editor.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})); await frames();
    check('组字结束后恢复',buttons.every(button=>!button.disabled));
    const beforeFailure = editor.innerText;
    const blockPaste = event => event.stopImmediatePropagation();
    editor.addEventListener('paste',blockPaste,true); buttons[0].click();
    await frames(); await wait(()=>document.querySelector('.xrc-flow-status').textContent.includes('快捷填入未完成'));
    editor.removeEventListener('paste',blockPaste,true);
    check('编辑器未接收时保留草稿并显示提示',editor.innerText===beforeFailure && document.querySelector('.xrc-flow-status').textContent.includes('快捷填入未完成'));
    check('填入没有发送、点赞或触发下一条',document.querySelector('#composer-evidence').dataset.requests==='0' &&
      document.querySelector('#composer-evidence').dataset.heartRequests==='0' && document.querySelector('.demo-composer'));
  } catch(error) { checks.push({name:error.message,ok:false}); }
  finally {
    Math.random=random; document.execCommand=execCommand;
    // Leave the unsent local draft visible for inspection.
  }
  output.dataset.evidence=JSON.stringify(checks);
  output.dataset.result=checks.every(check=>check.ok)?'passed':'failed';
  output.textContent=`${checks.filter(check=>check.ok).length}/${checks.length} 通过\n`+checks.map(check=>`${check.ok?'✓':'✗'} ${check.name}`).join('\n');
}
