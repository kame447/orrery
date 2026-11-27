"""Persistent graph relationships and layout geometry, without a live backend.

Run with pytest or directly with Python. Node executes the production helpers;
the small SVG fixture records their output without starting a browser or agent.
"""

import json
import math
from pathlib import Path
import shutil
import subprocess
import unittest


BRIDGE = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")


def section(source, start, end):
    offset = source.index(start)
    return source[offset:source.index(end, offset)]


HARNESS = r"""
let clock=1800000000000;
const RealDate=Date;
Date=class extends RealDate{static now(){return clock;}};
let lineageParent=new Map(),communicationEdges=[],graphTopologyKey='',graphTopologyRetryAt=0;
let currentAgents=[],liveAgents=[],miniPositions=new Map(),planetPositions=new Map();
const commPairs=new Map(),observedConnections=new Map();
let commRefreshTimer=null,planetarium=null,planetSvg=null,planetMotion=null;
const miniMotion={};
const requests=[],events=[],handlers=new Map();
let reply={spawn:[],edges:[]},responseOK=true,responseError=false;
const OC={lineageHue:new Map(),get lineageParent(){return lineageParent;},
  get communicationEdges(){return communicationEdges;}};
const window={OC};
class Element{
  constructor(tag){this.tag=tag;this.children=[];this.attrs={};this.dataset={};
    this.classList={contains:name=>(this.attrs.class||'').split(' ').includes(name),
      toggle:(name,on)=>{const classes=new Set((this.attrs.class||'').split(' ').filter(Boolean));
        on?classes.add(name):classes.delete(name);this.attrs.class=[...classes].join(' ');}};
  }
  setAttribute(key,value){this.attrs[key]=String(value);
    if(key.startsWith('data-'))this.dataset[key.slice(5)]=String(value);}
  getAttribute(key){return this.attrs[key]??null;}
  appendChild(child){this.children.push(child);return child;}
  replaceChildren(...children){this.children=children;}
  querySelectorAll(selector){const result=[];
    for(const child of this.children){if(child.classList.contains(selector.slice(1)))result.push(child);
      result.push(...child.querySelectorAll(selector));}return result;}
}
const miniSvg=new Element('svg');
const document={hidden:false,createElementNS:(_,tag)=>new Element(tag),
  addEventListener:(name,fn)=>{if(!handlers.has(name))handlers.set(name,[]);handlers.get(name).push(fn);},
  dispatchEvent:event=>{events.push(event.type);for(const fn of handlers.get(event.type)||[])fn(event);}};
class CustomEvent{constructor(type,options={}){this.type=type;this.detail=options.detail;}}
const networkOverlay={classList:{contains:()=>false}};
function assignLineageHues(){}
function setTimeout(){return 1;}
function clearTimeout(){}
async function fetch(url){requests.push(url);if(responseError)throw Error('offline');
  return {ok:responseOK,json:async()=>reply};}
function renderMini(){
  const layout=layoutAgents(liveAgents,MINI);miniPositions=layout.positions;
  miniMotion.layoutDimensions={...MINI,width:layout.width,height:layout.height};
  miniSvg.replaceChildren();drawSpawnEdges(miniSvg,layout,false);
  miniSvg.appendChild(svgEl('g',{class:'orrery-comm-layer'}));
  renderCommLayer(miniSvg,miniPositions,miniMotion.layoutDimensions);
}
function renderPlanetarium(){}
function receiveMail(messages){recordMessages(messages);renderMini();}
function roster(names){currentAgents=names.map(name=>({name,act_state:'work'}));
  document.dispatchEvent(new CustomEvent('oc:agents',{detail:{agents:currentAgents}}));}
function mail(from,to,age=0){document.dispatchEvent(new CustomEvent('oc:mail',{
  detail:{messages:[{sender:from,recipients:[to],ts:clock-age}]}}));}
function layout(surface='MINI'){
  const dimensions=surface==='MINI'?MINI:PLANET;
  const result=layoutAgents(liveAgents,dimensions);
  return {width:result.width,height:result.height,dimensions,
    components:result.components,singletons:result.singletons,parentOf:[...result.parentOf],
    positions:[...result.positions].map(([name,p])=>({name,x:p.x,y:p.y,component:p.component}))};
}
function lines(){return miniSvg.querySelectorAll('.orrery-comm-edge').map(el=>({
  a:el.dataset.a,b:el.dataset.b,opacity:Number(el.getAttribute('stroke-opacity')),
  life:Number(el.dataset.life)}));}
function spawnLines(){return miniSvg.querySelectorAll('.orrery-spawn-edge').map(el=>({
  parent:el.dataset.parent,child:el.dataset.child,active:el.classList.contains('mail-live')}));}
function topology(){return {parentOf:[...lineageParent],edges:communicationEdges,
  events:events.filter(name=>name==='oc:graph').length};}
"""


def run_js(script):
    if not NODE:
        raise unittest.SkipTest("node not installed")
    view = (BRIDGE / "orrery_view.js").read_text()
    cockpit = (BRIDGE / "cockpit.html").read_text()
    snippets = [
        "const SVG_NS='http://www.w3.org/2000/svg';",
        section(view, "const MINI=", "const MAX_COMETS="),
        section(view, "function svgEl(", "function stateOf("),
        section(view, "function buildForest(", "function createMotionSurface("),
        section(view, "function drawSpawnEdges(", "// Keep provider choice"),
        section(view, "function recipientNames(", "function renderMailFocus("),
        section(view, "function isLineagePair(", "async function seedRecentMail("),
        section(view, "document.addEventListener('oc:agents'", "document.addEventListener('oc:focus-agent'"),
        section(cockpit, "async function pollGraph(){", "function assignLineageHues("),
    ]
    program = HARNESS + "\n" + "\n".join(snippets)
    program += "\n(async()=>{" + script + "})().then(value=>console.log(JSON.stringify(value)))"
    program += ".catch(error=>{console.error(error.stack);process.exitCode=1;});"
    result = subprocess.run([NODE], input=program, text=True, capture_output=True, timeout=20)
    if result.returncode:
        raise AssertionError(result.stderr)
    return json.loads(result.stdout)


class NetworkConnectivityTests(unittest.TestCase):
    def test_live_six_agents_share_a_component_without_inventing_parents(self):
        result = run_js("""
          lineageParent=new Map([['LivelyCurie','PlumEdison'],['MistyPauling','PlumEdison']]);
          communicationEdges=['AstuteKepler','BriskMaxwell','JadeEinstein'].map(target=>({source:'PlumEdison',target}));
          roster(['PlumEdison','LivelyCurie','MistyPauling','AstuteKepler','BriskMaxwell','JadeEinstein']);
          return {mini:layout(),planet:layout('PLANET'),lines:lines(),spawn:spawnLines()};
        """)
        expected = sorted(["PlumEdison", "LivelyCurie", "MistyPauling", "AstuteKepler", "BriskMaxwell", "JadeEinstein"])
        for surface in (result["mini"], result["planet"]):
            self.assertEqual(surface["components"], [expected])
            self.assertEqual(surface["singletons"], [])
            self.assertEqual(sorted(surface["parentOf"]), [["LivelyCurie", "PlumEdison"], ["MistyPauling", "PlumEdison"]])
            self.assertEqual(len({p["component"] for p in surface["positions"]}), 1)
        self.assertEqual(len(result["lines"]), 3)
        self.assertEqual(len(result["spawn"]), 2)

    def test_activity_expiry_keeps_connection_line_component_and_position(self):
        result = run_js("""
          roster(['Parent','Child','Peer']);lineageParent.set('Child','Parent');
          mail('Parent','Peer');mail('Parent','Child');
          const before={layout:layout(),lines:lines(),spawn:spawnLines()};
          clock+=95000;refreshCommEdges();
          return {before,after:{layout:layout(),lines:lines(),spawn:spawnLines()}};
        """)
        self.assertEqual(result["before"]["layout"], result["after"]["layout"])
        self.assertEqual(result["before"]["lines"][0]["life"], 1)
        self.assertEqual(result["after"]["lines"], [{"a": "Parent", "b": "Peer", "opacity": 0.2, "life": 0}])
        self.assertTrue(result["before"]["spawn"][0]["active"])
        self.assertFalse(result["after"]["spawn"][0]["active"])

    def test_old_mail_seeds_relationship_without_recent_activity(self):
        result = run_js("""
          roster(['A','B']);mail('A','B',300000);
          return {layout:layout(),lines:lines(),recent:commPairs.size};
        """)
        self.assertEqual(result["layout"]["components"], [["A", "B"]])
        self.assertEqual(result["layout"]["parentOf"], [])
        self.assertEqual(result["recent"], 0)
        self.assertEqual(result["lines"], [{"a": "A", "b": "B", "opacity": 0.2, "life": 0}])

    def test_communication_only_chain_respects_hops_and_keeps_an_isolate_separate(self):
        result = run_js("""
          communicationEdges=[{source:'A',target:'B'},{source:'B',target:'C'},{source:'C',target:'D'}];
          roster(['A','B','C','D','Unrelated']);
          return {layout:layout(),one:[...telemetryNetworkSubset(liveAgents,'A',1).visible].sort(),
            two:[...telemetryNetworkSubset(liveAgents,'A',2).visible].sort(),
            three:[...telemetryNetworkSubset(liveAgents,'A',3).visible].sort()};
        """)
        self.assertEqual(result["layout"]["components"], [["A", "B", "C", "D"], ["Unrelated"]])
        self.assertEqual(result["layout"]["singletons"], ["Unrelated"])
        self.assertEqual(result["layout"]["parentOf"], [])
        self.assertEqual(result["one"], ["A", "B"])
        self.assertEqual(result["two"], ["A", "B", "C"])
        self.assertEqual(result["three"], ["A", "B", "C", "D"])

    def test_mail_between_spawn_trees_groups_them_without_changing_the_forest(self):
        result = run_js("""
          lineageParent=new Map([['AChild','ARoot'],['BChild','BRoot']]);
          communicationEdges=[{source:'AChild',target:'BChild'}];
          roster(['ARoot','AChild','BRoot','BChild','Unrelated']);
          return {layout:layout(),lines:lines()};
        """)
        self.assertEqual(result["layout"]["components"], [["AChild", "ARoot", "BChild", "BRoot"], ["Unrelated"]])
        self.assertEqual(result["layout"]["parentOf"], [["AChild", "ARoot"], ["BChild", "BRoot"]])
        self.assertEqual(result["layout"]["singletons"], ["Unrelated"])
        self.assertEqual(len(result["lines"]), 1)

    def test_duplicate_reversed_and_invalid_edges_do_not_duplicate_nodes_or_lines(self):
        result = run_js("""
          communicationEdges=[{source:'A',target:'B'},{source:'B',target:'A'},{source:'A',target:'B'},
            {source:'A',target:'A'},{source:'A',target:'Absent'},{source:3,target:'B'},null,{}];
          roster(['A','B','A']);mail('B','A');
          return {layout:layout(),lines:lines()};
        """)
        self.assertEqual(result["layout"]["components"], [["A", "B"]])
        self.assertEqual(len(result["layout"]["positions"]), 2)
        self.assertEqual(len(result["lines"]), 1)

    def test_removed_agents_have_no_lines_and_do_not_bridge_visible_components(self):
        result = run_js("""
          communicationEdges=[{source:'A',target:'Bridge'},{source:'Bridge',target:'B'}];
          roster(['A','Bridge','B']);mail('A','Bridge');
          roster(['A','B']);refreshCommEdges();
          return {layout:layout(),lines:lines(),subset:[...telemetryNetworkSubset(liveAgents,'A',3).visible]};
        """)
        self.assertEqual(result["layout"]["components"], [["A"], ["B"]])
        self.assertEqual(result["lines"], [])
        self.assertEqual(result["subset"], ["A"])

    def test_rejected_cyclic_parent_does_not_hide_a_real_communication_link(self):
        result = run_js("""
          lineageParent=new Map([['A','C'],['B','A'],['C','B']]);
          communicationEdges=[{source:'B',target:'C'}];
          roster(['A','B','C']);return {layout:layout(),lines:lines(),spawn:spawnLines()};
        """)
        self.assertEqual(len(result["spawn"]), 2)
        self.assertEqual(result["layout"]["components"], [["A", "B", "C"]])
        self.assertEqual(result["lines"], [{"a": "B", "b": "C", "opacity": 0.2, "life": 0}])

    def test_mail_route_uses_drawn_lineage_not_rejected_cyclic_parent(self):
        result = run_js("""
          lineageParent=new Map([['A','C'],['B','A'],['C','B']]);
          const forest=buildForest(['A','B','C'].map(name=>({name})));
          const spawnPairs=new Set([...forest.parentOf].map(([child,parent])=>pairKey(parent,child)));
          const from={name:'B',x:30,y:100},middle={name:'A',x:140,y:100},
                to={name:'C',x:250,y:100};
          const positions=new Map([[from.name,from],[middle.name,middle],[to.name,to]]);
          const rejected=commPathBetween(from,to,positions,MINI,spawnPairs);
          const ordinary=commPathBetween(from,to,positions,MINI);
          const valid=commPathBetween(from,middle,positions,MINI,spawnPairs);
          return {rejected:rejected.d,ordinary:ordinary.d,valid:valid.d,
            drawn:isLineagePair('B','C',spawnPairs)};
        """)
        self.assertFalse(result["drawn"])
        self.assertIn(" Q ", result["rejected"])
        self.assertEqual(result["rejected"], result["ordinary"])
        self.assertIn(" L ", result["valid"])

    def test_mail_observed_before_roster_survives_old_roster_and_late_graph(self):
        result = run_js("""
          roster(['A']);mail('A','NewChild');
          roster(['A']);reply={spawn:[],edges:[]};await pollGraph();
          roster(['A','NewChild']);
          return {layout:layout(),lines:lines()};
        """)
        self.assertEqual(result["layout"]["components"], [["A", "NewChild"]])
        self.assertEqual(len(result["lines"]), 1)
        self.assertEqual(result["layout"]["parentOf"], [])

    def test_departed_and_never_confirmed_endpoints_do_not_leave_ghost_connections(self):
        result = run_js("""
          roster(['A','B']);mail('A','B');roster(['A']);roster(['A','B']);
          const departed={layout:layout(),lines:lines()};
          roster(['A']);mail('A','NeverPresent');clock+=95000;roster(['A']);
          roster(['A','NeverPresent']);
          return {departed,unconfirmed:{layout:layout(),lines:lines()}};
        """)
        self.assertEqual(result["departed"]["layout"]["components"], [["A"], ["B"]])
        self.assertEqual(result["departed"]["lines"], [])
        self.assertEqual(result["unconfirmed"]["layout"]["components"], [["A"], ["NeverPresent"]])
        self.assertEqual(result["unconfirmed"]["lines"], [])

    def test_graph_request_predating_delivered_mail_cannot_erase_that_connection(self):
        result = run_js("""
          roster(['A','B']);let release;
          fetch=async()=>({ok:true,json:()=>new Promise(resolve=>{release=resolve;})});
          const pending=pollGraph();await Promise.resolve();
          mail('A','B');release({spawn:[],edges:[]});await pending;
          clock+=95000;refreshCommEdges();
          return {layout:layout(),lines:lines()};
        """)
        self.assertEqual(result["layout"]["components"], [["A", "B"]])
        self.assertEqual(result["lines"], [{"a": "A", "b": "B", "opacity": 0.2, "life": 0}])

    def test_graph_snapshot_order_and_duplicates_do_not_trigger_repeated_redraws(self):
        result = run_js("""
          roster(['A','B','C']);
          reply={spawn:[{source:'A',target:'B'}],edges:[{source:'A',target:'C'},{source:'C',target:'A'}]};
          await pollGraph();const first=topology();
          reply={spawn:[{source:'A',target:'B'},{source:'A',target:'B'}],edges:[{source:'C',target:'A'}]};
          await pollGraph();const repeated=topology();
          reply={spawn:[{source:'A',target:'B'}],edges:[{source:'B',target:'C'}]};
          await pollGraph();return {first,repeated,changed:topology(),requests};
        """)
        self.assertEqual(result["first"], result["repeated"])
        self.assertEqual(result["first"]["events"], 1)
        self.assertEqual(result["changed"]["events"], 2)
        self.assertEqual(result["first"]["edges"], [{"source": "A", "target": "C"}])
        self.assertTrue(all("topology_only=1" in url for url in result["requests"]))

    def test_failed_degraded_or_malformed_graph_keeps_last_successful_topology(self):
        result = run_js("""
          roster(['A','B']);reply={spawn:[{source:'A',target:'B'}],edges:[{source:'A',target:'B'}]};
          await pollGraph();const before=topology(),after=[];
          for(const bad of [null,{}, {spawn:[],edges:{bad:true}}, {spawn:[],edges:[],degraded:true},
            {spawn:[],edges:[],error:'unavailable'}]){
            reply=bad;await pollGraph();after.push(topology());
          }
          reply={spawn:[],edges:[]};responseOK=false;await pollGraph();after.push(topology());
          responseOK=true;responseError=true;await pollGraph();after.push(topology());
          return {before,after};
        """)
        self.assertEqual(result["after"], [result["before"]] * 7)

    def test_malformed_edge_rows_cannot_replace_good_topology_with_an_empty_graph(self):
        result = run_js("""
          roster(['A','B']);reply={spawn:[{source:'A',target:'B'}],edges:[{source:'A',target:'B'}]};
          await pollGraph();const before=topology(),after=[];
          for(const bad of [{spawn:[{source:'A'}],edges:[]}, {spawn:[],edges:[null]},
            {spawn:[],edges:[{source:42,target:'B'}]}]){
            reply=bad;await pollGraph();after.push(topology());
          }
          return {before,after};
        """)
        self.assertEqual(result["after"], [result["before"]] * 3)

    def test_dense_and_multiple_components_keep_portraits_and_captions_separate(self):
        result = run_js("""
          const cases=[];
          for(const shape of ['mixed','fan','chain','mail-only','two-trees']){
            lineageParent.clear();communicationEdges=[];observedConnections.clear();commPairs.clear();
            const names=Array.from({length:shape==='mixed'?7:24},(_,i)=>'Agent'+String(i).padStart(2,'0'));
            if(shape==='fan')names.slice(1).forEach(name=>lineageParent.set(name,names[0]));
            if(shape==='chain')names.slice(1).forEach((name,i)=>lineageParent.set(name,names[i]));
            if(shape==='mixed'){
              lineageParent.set(names[1],names[0]);lineageParent.set(names[2],names[0]);
              communicationEdges=names.slice(3,6).map(target=>({source:names[0],target}));
            }
            if(shape==='mail-only')communicationEdges=names.slice(1).map(target=>({source:names[0],target}));
            if(shape==='two-trees'){
              names.slice(1,11).forEach(name=>lineageParent.set(name,names[0]));
              names.slice(12,23).forEach(name=>lineageParent.set(name,names[11]));
              communicationEdges=[{source:names[4],target:names[19]}];
            }
            roster(names);
            for(const surface of ['MINI','PLANET'])cases.push({shape,surface,...layout(surface)});
            const network=telemetryMiniLayout(liveAgents,names[0],3,MINI);
            cases.push({shape,surface:'NETWORK',width:network.width,height:network.height,dimensions:MINI,
              positions:[...network.positions].map(([name,p])=>({name,x:p.x,y:p.y}))});
          }
          return cases;
        """)
        for surface in result:
            with self.subTest(shape=surface["shape"], surface=surface["surface"]):
                self.assertTrue(math.isfinite(surface["width"]) and math.isfinite(surface["height"]))
                dimensions = surface["dimensions"]
                boxes = []
                for position in surface["positions"]:
                    x, y = position["x"], position["y"]
                    self.assertTrue(math.isfinite(x) and math.isfinite(y))
                    box = (x - dimensions["captionWidth"] / 2, y - dimensions["nodeAbove"],
                           x + dimensions["captionWidth"] / 2,
                           y + dimensions["captionTop"] + dimensions["captionHeight"])
                    self.assertGreaterEqual(box[0], 0)
                    self.assertGreaterEqual(box[1], 0)
                    self.assertLessEqual(box[2], surface["width"] + 0.01)
                    self.assertLessEqual(box[3], surface["height"] + 0.01)
                    for other in boxes:
                        overlap = (box[0] < other[2] - 0.01 and other[0] < box[2] - 0.01 and
                                   box[1] < other[3] - 0.01 and other[1] < box[3] - 0.01)
                        self.assertFalse(overlap, (position["name"], box, other))
                    boxes.append(box)


if __name__ == "__main__":
    unittest.main()
