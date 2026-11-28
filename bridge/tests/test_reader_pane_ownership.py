"""A Reader without a selected pane must not display another agent's history."""
import pytest
from test_conversation_review_regressions import cockpit, stable_roster


@pytest.mark.parametrize("transition", ["terminal-less", "pending-stage"])
def test_reader_does_not_fallback_to_another_agent(cockpit, transition):
    js, wait, _, _, enable = cockpit
    stable_roster(js)
    enable(count=1)
    js("""conversationView.close();
      window.visibleReaders=()=>[...document.querySelectorAll('.conversation-panel:not([hidden])')];
      currentAgents.push({name:'OtherFixture',program:'codex',history_binding:'bound',transcript_path:'/fixture/two.jsonl'});
      createPane('OtherFixture',{paneId:'%902',windowId:'@902',width:80,height:20});
      OrreryConversationSource.Source.prototype.read=async(name)=>({
        agent:name,provider:'codex',mode:'cursor',events:[{id:'one',kind:'text',role:'assistant',text:'Generated history for '+name}],has_older:false});
      setActive('%902','single');conversationView.open();""")
    wait("visibleReaders().some(panel=>panel.textContent.includes('Generated history for OtherFixture'))")
    js("setActive('%901','single');conversationView.open()")
    wait("visibleReaders().some(panel=>panel.textContent.includes('Generated history for ReviewFixture'))")
    if transition == "terminal-less":
        js("currentAgents.push({name:'NoPaneFixture',cmd:'codex-app',program:'codex'});jumpToSessionTarget('NoPaneFixture')")
    else:
        # Existing stage primitives used for connecting targets without a pane.
        js("activeId=null;splitVisible=false;blurTerminalFocus();paintPendingSession('NoPaneFixture');renderStage()")
    assert js("activeSession()") is None
    assert js("scrName.textContent") == "NoPaneFixture"
    assert js("visibleReaders().map(panel=>panel.getAttribute('aria-label'))") == []
    assert js("stageEl.querySelectorAll('.termhost.on').length") == 0
    js("conversationView.open();conversationView.refresh();renderStage()")
    assert js("visibleReaders().length") == 0
    js("setActive('%902','single');conversationView.open()")
    wait("visibleReaders().some(panel=>panel.textContent.includes('Generated history for OtherFixture'))")
    assert js("visibleReaders().length") == 1
