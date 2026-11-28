"""A font slider preview must not resize the terminal or steal keyboard focus."""
from test_conversation_review_regressions import cockpit, stable_roster


def test_terminal_font_preview_only_commits_once(cockpit):
    js, wait, client, _, enable = cockpit
    stable_roster(js)
    enable(claimed=True, count=1)
    js("""conversationView.close();settingsPopover.showPopover();
      terminalFontRange.scrollIntoView({block:'center'});terminalFontRange.focus();""")
    js("new Promise(resolve=>setTimeout(resolve,350))")
    js("""window.fontCalls={apply:0,queue:0,fit:0,save:0,sync:0};
      const applyFont=applyTerminalSettings,queueFont=queueStageFit,saveFont=persistTerminalSettings,
        fitFont=panes.get('%901').fit.fit.bind(panes.get('%901').fit),openXHR=XMLHttpRequest.prototype.open;
      applyTerminalSettings=(...args)=>{fontCalls.apply++;return applyFont(...args)};
      queueStageFit=(...args)=>{fontCalls.queue++;return queueFont(...args)};
      persistTerminalSettings=(...args)=>{fontCalls.save++;return saveFont(...args)};
      panes.get('%901').fit.fit=(...args)=>{fontCalls.fit++;return fitFont(...args)};
      XMLHttpRequest.prototype.open=function(method,url,...args){
        if(method==='PUT'&&url==='/telemetry/prefs')fontCalls.sync++;
        return openXHR.call(this,method,url,...args);
      };
      packets.length=0;
      for(const value of ['9','13.5','15','16']){
        terminalFontRange.value=value;
        terminalFontRange.dispatchEvent(new Event('input',{bubbles:true}));
      }""")
    assert js('terminalFontValue.textContent') == '16.0 px'
    assert js('terminalFontRange.getAttribute("aria-valuetext")') == '16.0 pixels'
    assert js('fontCalls') == dict(apply=0, queue=0, fit=0, save=0, sync=0)
    assert js('panes.get("%901").term.options.fontSize') == 12.5
    assert js("localStorage.getItem('oc-term-font')") is None
    assert js("packets.filter(p=>p.type==='resize')") == []
    js("""terminalFontRange.dispatchEvent(new Event('change',{bubbles:true}));
      terminalFontRange.dispatchEvent(new Event('change',{bubbles:true}));""")
    wait("fontCalls.fit===1&&fontCalls.sync===1")
    assert js('fontCalls') == dict(apply=1, queue=1, fit=1, save=1, sync=1)
    assert js('panes.get("%901").term.options.fontSize') == 16
    assert js("packets.filter(p=>p.type==='resize'&&p.paneId==='%901').length") == 1
    assert js("document.activeElement===terminalFontRange && localStorage.getItem('oc-term-font')==='16'")
    assert js("packets.filter(p=>['input','claim','release'].includes(p.type))") == []
    client.call('Page.removeScriptToEvaluateOnNewDocument', identifier=js.storage_bootstrap)
    client.call('Page.reload', ignoreCache=True)
    wait("!window.fontCalls&&document.getElementById('terminalFontSize')?.value==='16'")
    enable(count=1)
    assert js('panes.get("%901").term.options.fontSize') == 16
