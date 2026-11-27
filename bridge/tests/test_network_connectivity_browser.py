"""Connected components and visible geometry on an isolated static cockpit.

Uses an existing test CDP browser through mini_browser. No production backend,
agent, tmux session, or application window is used.
"""

import base64
import json

import pytest

from test_mini_orrery_selection import mini_browser, tour_browser


NAMES = ["Pilot", "Helper", "Misty", "Astute", "Brisk", "Jade"]


def configure_graph(client, evaluate, variant, theme="dark"):
    client.call("Emulation.setEmulatedMedia", features=[
        {"name": "prefers-reduced-motion", "value": "reduce"}])
    evaluate("""(()=>{
      const names=NAMES,variant=VARIANT;
      OrreryColorTheme.setPreference(THEME);
      setMiniViewMode('orrery');
      currentAgents=names.map(name=>({name,category:'agent',running:true,
        act_state:'work',provider:'openai',model:'Fixture model',
        annot:{role:name==='Pilot'?'Coordinator':'Review task'}}));
      OC.lineageParent.clear();
      names.slice(1,variant==='restored-lineage'?6:3).forEach(name=>OC.lineageParent.set(name,'Pilot'));
      communicationEdges=names.slice(1).map(target=>({source:'Pilot',target}));
      document.dispatchEvent(new CustomEvent('oc:agents',{detail:{agents:currentAgents}}));
      document.dispatchEvent(new CustomEvent('oc:graph'));
      focusSession('Pilot');
    })()""".replace("NAMES", json.dumps(NAMES)).replace("VARIANT", json.dumps(variant))
             .replace("THEME", json.dumps(theme)))


READ_GRAPH = r"""selector=>{
  const svg=document.querySelector(selector);
  const box=el=>{const r=el.getBoundingClientRect();return {
    left:r.left,top:r.top,right:r.right,bottom:r.bottom};};
  const circleBox=el=>{
    const matrix=el.getScreenCTM();
    const center=new DOMPoint(Number(el.getAttribute('cx')),Number(el.getAttribute('cy'))).matrixTransform(matrix);
    const radius=Number(el.getAttribute('r'))+(parseFloat(getComputedStyle(el).strokeWidth)||0)/2;
    return {left:center.x-radius*Math.abs(matrix.a),right:center.x+radius*Math.abs(matrix.a),
      top:center.y-radius*Math.abs(matrix.d),bottom:center.y+radius*Math.abs(matrix.d)};
  };
  const union=(a,b)=>({left:Math.min(a.left,b.left),top:Math.min(a.top,b.top),
    right:Math.max(a.right,b.right),bottom:Math.max(a.bottom,b.bottom)});
  const overlaps=(a,b)=>a.left<b.right-.1&&b.left<a.right-.1&&a.top<b.bottom-.1&&b.top<a.bottom-.1;
  const viewport=box(svg);
  const inside=b=>b.left>=viewport.left-.1&&b.top>=viewport.top-.1&&
    b.right<=viewport.right+.1&&b.bottom<=viewport.bottom+.1;
  const nodes=[...svg.querySelectorAll('.orrery-agent')].map(node=>{
    const hit=node.querySelector('.orrery-hit'),arc=node.querySelector('.orrery-motion-ring');
    const ring=node.querySelector('.mini-selection-ring');
    return {name:node.dataset.agent,component:node.dataset.component,
      x:Number(hit.getAttribute('cx')),y:Number(hit.getAttribute('cy')),
      transform:node.getAttribute('transform'),portrait:union(box(hit),circleBox(arc)),
      caption:box(node.querySelector('foreignObject')),ring:ring?circleBox(ring):null};
  });
  const collisions=[],outside=[];
  for(let i=0;i<nodes.length;i++){
    const a=nodes[i];
    for(const part of ['portrait','caption','ring'])if(a[part]&&!inside(a[part]))outside.push([a.name,part,a[part]]);
    if(overlaps(a.portrait,a.caption))collisions.push([a.name,'own portrait/caption']);
    // The selected ring surrounds its own portrait; compare it with other nodes.
    for(let j=0;j<i;j++)for(const ap of ['portrait','caption','ring'])for(const bp of ['portrait','caption','ring']){
      const b=nodes[j];if(a[ap]&&b[bp]&&overlaps(a[ap],b[bp]))collisions.push([a.name,ap,b.name,bp]);
    }
  }
  return {count:nodes.length,components:[...new Set(nodes.map(node=>node.component))],
    names:nodes.map(node=>node.name).sort(),collisions,outside,
    visible:viewport.right>viewport.left&&viewport.bottom>viewport.top,
    selected:nodes.filter(node=>node.ring).map(node=>node.name),
    positions:nodes.map(({name,x,y,transform})=>({name,x,y,transform})).sort((a,b)=>a.name.localeCompare(b.name)),
    spawn:[...svg.querySelectorAll('.orrery-spawn-edge')].map(edge=>({
      parent:edge.dataset.parent,child:edge.dataset.child,active:edge.classList.contains('mail-live'),
      coords:['x1','y1','x2','y2'].map(key=>edge.getAttribute(key))})).sort((a,b)=>a.child.localeCompare(b.child)),
    mail:[...svg.querySelectorAll('.orrery-comm-edge')].map(edge=>({a:edge.dataset.a,b:edge.dataset.b,
      path:edge.getAttribute('d'),life:Number(edge.dataset.life),opacity:Number(edge.getAttribute('stroke-opacity'))}))
      .sort((a,b)=>(a.a+'|'+a.b).localeCompare(b.a+'|'+b.b))};
}"""


def read_graph(evaluate, selector):
    return evaluate("(" + READ_GRAPH + ")(" + json.dumps(selector) + ")")


def capture_graph(client, evaluate, selector, path):
    clip = evaluate("""(()=>{
      const r=document.querySelector(SELECTOR).getBoundingClientRect();
      return {x:r.left,y:r.top,width:r.width,height:r.height,scale:1};
    })()""".replace("SELECTOR", json.dumps(selector)))
    result = client.call("Page.captureScreenshot", format="png", clip=clip, captureBeyondViewport=False)
    path.write_bytes(base64.b64decode(result["data"]))


@pytest.mark.parametrize("theme", ["dark", "light"])
@pytest.mark.parametrize("variant", ["restored-lineage", "spawn-and-mail"])
def test_six_connected_agents_keep_correct_links_and_clear_geometry(mini_browser, tmp_path, theme, variant):
    client, evaluate = mini_browser
    configure_graph(client, evaluate, variant, theme)
    mini = read_graph(evaluate, "#orrery")
    capture_graph(client, evaluate, "#orrery", tmp_path / f"mini-{variant}-{theme}.png")
    evaluate("OrreryRail.openPlanetarium()")
    planet = read_graph(evaluate, ".planetarium-svg")
    capture_graph(client, evaluate, ".planetarium-svg", tmp_path / f"planet-{variant}-{theme}.png")
    expected_children = sorted(NAMES[1:] if variant == "restored-lineage" else NAMES[1:3])
    expected_mail = [] if variant == "restored-lineage" else sorted(NAMES[3:])
    for surface in (mini, planet):
        assert surface["visible"]
        assert surface["count"] == 6
        assert surface["names"] == sorted(NAMES)
        assert len(surface["components"]) == 1 and surface["components"][0]
        assert [edge["child"] for edge in surface["spawn"]] == expected_children
        assert all(edge["parent"] == "Pilot" for edge in surface["spawn"])
        assert sorted(next(name for name in (edge["a"], edge["b"]) if name != "Pilot")
                      for edge in surface["mail"]) == expected_mail
        assert surface["collisions"] == []
        assert surface["outside"] == []
    assert mini["selected"] == ["Pilot"]
    assert planet["selected"] == []


def test_mail_activity_expires_but_dom_links_and_positions_remain(mini_browser):
    client, evaluate = mini_browser
    configure_graph(client, evaluate, "spawn-and-mail")
    evaluate("OrreryRail.openPlanetarium()")
    result = evaluate("""(()=>{
      const read=READ_GRAPH;
      const realNow=Date.now,now=realNow();
      try{
        Date.now=()=>now;
        document.dispatchEvent(new CustomEvent('oc:mail',{detail:{messages:[{
          sender:'Pilot',recipients:NAMES.slice(1),ts:now,subject:'Fixture only'}]}}));
        const before=['#orrery','.planetarium-svg'].map(read);
        Date.now=()=>now+95000;
        document.dispatchEvent(new CustomEvent('oc:graph'));
        return {before,after:['#orrery','.planetarium-svg'].map(read)};
      }finally{Date.now=realNow;}
    })()""".replace("READ_GRAPH", READ_GRAPH).replace("NAMES", json.dumps(NAMES)))
    for before, after in zip(result["before"], result["after"]):
        assert before["positions"] == after["positions"]
        assert before["components"] == after["components"]
        assert len(before["spawn"]) == len(after["spawn"]) == 2
        assert len(before["mail"]) == len(after["mail"]) == 3
        assert all(edge["active"] for edge in before["spawn"])
        assert not any(edge["active"] for edge in after["spawn"])
        for old, new in zip(before["spawn"], after["spawn"]):
            assert (old["parent"], old["child"], old["coords"]) == (new["parent"], new["child"], new["coords"])
        for old, new in zip(before["mail"], after["mail"]):
            assert (old["a"], old["b"], old["path"]) == (new["a"], new["b"], new["path"])
            assert old["life"] == 1 and old["opacity"] > new["opacity"] > 0
            assert new["life"] == 0
        assert after["collisions"] == after["outside"] == []
