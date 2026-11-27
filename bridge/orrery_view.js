/* ── orrery view: real spawn + communication graph (rail + planetarium) ──
   Owns <svg id="orrery"> and its full-stage planetarium.
   Inputs (read-only):
     window.OC — { jumpToAgent, lineageHue, lineageParent, communicationEdges, agents(),
                   mailBacklog() }
     document events:
       'oc:agents'  detail:{agents}    — every roster poll tick (~3s)
       'oc:graph'                     — changed spawn/communication topology
       'oc:mail'    detail:{messages}  — NEW mail since last tick (deduped)
   Colour stays reserved for spawn lineage; state/events use motion. */
(function(){
'use strict';
const OC=window.OC;
const miniSvg=document.getElementById('orrery');
if(!miniSvg||!OC)return;

const SVG_NS='http://www.w3.org/2000/svg';
const MINI={
  width:280,height:200,large:false,
  xPadding:34,topPadding:46,bottomPadding:46,
  treePitchX:66,treePitchY:64,singlePitchX:66,singlePitchY:64,
  singleColumns:5,sectionGap:64,treeGapUnits:.55,
  captionWidth:62,captionTop:15,captionHeight:20,nodeAbove:20,
};
const MINI_HEIGHT_KEY='oc-mini-graph-height';
const MINI_MIN_HEIGHT=120;
const MINI_MAX_HEIGHT=520;
const MAIL_BELOW_GRAPH=160; // Leave room for the handle and at least several Mail rows.
const PLANET={
  width:1000,height:620,large:true,
  xPadding:64,topPadding:90,bottomPadding:80,
  treePitchX:112,treePitchY:122,singlePitchX:112,singlePitchY:122,
  singleColumns:8,sectionGap:128,treeGapUnits:.55,
  captionWidth:104,captionTop:37,captionHeight:34,nodeAbove:37,
};
const MAIL_EDGE_LIFETIME=90000;
const MAX_COMETS=6;
const MOTION_STIFFNESS=150;
const MOTION_DAMPING=22;
const MOTION_SETTLE_DISTANCE=.1;
const MOTION_SETTLE_SPEED=.12;
const MOTION_SETTLE_FRAMES=4;
const reducedMotion=window.matchMedia&&
  window.matchMedia('(prefers-reduced-motion: reduce)');
let liveAgents=OC.agents()||[];
let miniPositions=new Map();
let planetPositions=new Map();
let planetarium=null;
let planetSvg=null;
let planetLastFocus=null;
let activeComets=0;
let activeMailRoute=null;
const commPairs=new Map();
const observedConnections=new Map();
let commRefreshTimer=null;
let motionFrameId=null;
let motionLastTime=null;
let miniMode=(OC.miniView&&OC.miniView().mode)==='network'?'network':'orrery';
let miniNetworkDepth=Number(OC.miniView&&OC.miniView().depth)||2;
let miniFocusName=OC.activeAgent&&OC.activeAgent()||'';
let miniWidth=MINI.width,miniHeight=MINI.height;

function svgEl(tag,attrs={}){
  const el=document.createElementNS(SVG_NS,tag);
  Object.entries(attrs).forEach(([key,value])=>el.setAttribute(key,value));
  return el;
}
function stateOf(agent){
  return String(agent.act_state||(agent.running?'activity unknown':'idle')).replaceAll('_',' ');
}
function roleOf(agent){
  return String(agent&&agent.annot&&agent.annot.role||'').trim();
}
function modelOf(agent){
  return String(agent&&(agent.model_raw||agent.model||agent.cmd)||'agent').trim();
}
function stateGlyph(agent){
  const state=String(agent&&agent.act_state||'').toLowerCase();
  if(state==='question'||state==='ask_user_question')return '?';
  if(state==='ask'||agent&&agent.annot&&agent.annot.attention)return '!';
  return '';
}
function drawStateGlyph(target,agent,x,y,large){
  const glyph=stateGlyph(agent);if(!glyph)return;
  const radius=large?36:14,offset=large?31:13;
  const group=svgEl('g',{class:'orrery-state-glyph '+(glyph==='?'?'question':'attention')});
  group.appendChild(svgEl('circle',{class:'orrery-state-orbit',cx:x,cy:y,r:radius,pathLength:'100'}));
  const text=svgEl('text',{x:x+offset,y:y-offset+1,'text-anchor':'middle'});
  text.textContent=glyph;group.appendChild(text);target.appendChild(group);
}
function initials(name){
  const capitals=String(name).match(/[A-Z](?=[a-z]|$)/g);
  if(capitals&&capitals.length)return capitals.slice(0,2).join('');
  return String(name).trim().slice(0,2).toUpperCase()||'?';
}
function initialLetter(name){
  return String(name).trim().slice(0,1).toUpperCase()||'?';
}
function activateAgent(agent){
  document.dispatchEvent(new CustomEvent(
    'oc:filter-agent',{detail:{agent:agent.name}}));
  // The jump switches the stage BEHIND the overlay — close it so the
  // pane is actually revealed (2026-07-30 product decision).
  if(planetarium&&planetarium.classList.contains('on'))closePlanetarium();
  OC.jumpToAgent(agent.name);
}
function makeInteractive(group,agent){
  group.setAttribute('role','button');
  group.setAttribute('tabindex','0');
  const role=roleOf(agent),model=modelOf(agent);
  group.setAttribute('aria-label',`Jump to ${agent.name}, ${model}${role?`, ${role}`:''}, ${stateOf(agent)}`);
  group.addEventListener('click',()=>activateAgent(agent));
  group.addEventListener('keydown',event=>{
    if(event.key==='Enter'||event.key===' '){
      event.preventDefault();
      activateAgent(agent);
    }
  });
}

/* Build a live-only forest. Invalid/cyclic parent links are ignored so a stale
   graph cannot hide agents. Connected trees lead; true singletons form the
   compact grid that follows them. */
function buildForest(live){
  const byName=new Map();
  (live||[]).forEach(agent=>{
    if(agent&&agent.name&&!byName.has(agent.name))byName.set(agent.name,agent);
  });
  const names=[...byName.keys()].sort((a,b)=>a.localeCompare(b));
  const parentOf=new Map();
  names.forEach(child=>{
    const parent=OC.lineageParent.get(child);
    if(!parent||parent===child||!byName.has(parent))return;
    let cursor=parent;
    const seen=new Set([child]);
    while(parentOf.has(cursor)&&!seen.has(cursor)){
      seen.add(cursor);
      cursor=parentOf.get(cursor);
    }
    if(cursor===child||seen.has(cursor))return;
    parentOf.set(child,parent);
  });
  const children=new Map(names.map(name=>[name,[]]));
  parentOf.forEach((parent,child)=>children.get(parent).push(child));
  children.forEach(items=>items.sort((a,b)=>a.localeCompare(b)));
  const roots=names.filter(name=>!parentOf.has(name));
  return {
    byName,parentOf,children,
    trees:roots.filter(name=>children.get(name).length),
    singletons:roots.filter(name=>!children.get(name).length),
  };
}

function communicationPairs(){
  const pairs=new Map();
  (OC.communicationEdges||[]).forEach(edge=>{
    if(!edge||typeof edge.source!=='string'||typeof edge.target!=='string'||
       !edge.source||!edge.target||edge.source===edge.target)return;
    pairs.set(pairKey(edge.source,edge.target),{a:edge.source,b:edge.target});
  });
  // A graph request may have started before the latest delivered mail.
  observedConnections.forEach((pair,key)=>pairs.set(key,pair));
  return pairs;
}
function connectedComponents(forest){
  const adjacent=new Map([...forest.byName.keys()].map(name=>[name,new Set()]));
  const connect=(a,b)=>{
    if(!adjacent.has(a)||!adjacent.has(b)||a===b)return;
    adjacent.get(a).add(b);adjacent.get(b).add(a);
  };
  forest.parentOf.forEach((parent,child)=>connect(parent,child));
  communicationPairs().forEach(pair=>connect(pair.a,pair.b));
  const visited=new Set(),components=[];
  [...adjacent.keys()].sort((a,b)=>a.localeCompare(b)).forEach(start=>{
    if(visited.has(start))return;
    const component=[],pending=[start];visited.add(start);
    while(pending.length){
      const name=pending.pop();component.push(name);
      adjacent.get(name).forEach(other=>{
        if(!visited.has(other)){visited.add(other);pending.push(other);}
      });
    }
    components.push(component.sort((a,b)=>a.localeCompare(b)));
  });
  return components;
}
function captionClearance(dimensions){
  return [dimensions.captionWidth+4,dimensions.nodeAbove+dimensions.captionTop+dimensions.captionHeight+2];
}
function packLayoutBlocks(blocks,maxWidth,gapX=0,gapY=0){
  let x=0,y=0,rowHeight=0,width=0,height=0;
  const positions=new Map();
  blocks.forEach(block=>{
    if(x&&x+block.width>maxWidth){y+=rowHeight+gapY;x=0;rowHeight=0;}
    block.positions.forEach((position,name)=>positions.set(name,{
      ...position,x:x+position.x,y:y+position.y,
    }));
    width=Math.max(width,x+block.width);
    height=Math.max(height,y+block.height);
    rowHeight=Math.max(rowHeight,block.height);
    x+=block.width+gapX;
  });
  return {width,height,positions};
}

/* Pack real spawn trees inside their communication component. A communication
   link joins blocks, never invents a parent. Portrait/caption cells stay intact. */
function layoutAgents(live,dimensions){
  const forest=buildForest(live),components=connectedComponents(forest);
  const innerWidth=dimensions.width-dimensions.xPadding*2;
  const spanCache=new Map();
  function treeSpan(name){
    if(!spanCache.has(name)){
      const children=forest.children.get(name);
      spanCache.set(name,children.length
        ?children.reduce((sum,child)=>sum+treeSpan(child),0):1);
    }
    return spanCache.get(name);
  }
  function treeBlock(root,component){
    const positions=new Map();let maxDepth=0;
    function place(name,depth,start){
      maxDepth=Math.max(maxDepth,depth);
      const children=forest.children.get(name),childXs=[];
      let cursor=start;
      children.forEach(child=>{
        place(child,depth+1,cursor);
        childXs.push(positions.get(child).x);
        cursor+=treeSpan(child);
      });
      const x=children.length?(childXs[0]+childXs[childXs.length-1])/2:
        (start+.5)*dimensions.treePitchX;
      positions.set(name,{x,y:depth*dimensions.treePitchY,component});
    }
    place(root,0,0);
    return {width:treeSpan(root)*dimensions.treePitchX,
      height:(maxDepth+1)*dimensions.treePitchY,positions};
  }
  const connected=[],isolated=[];
  components.forEach(component=>{
    if(component.length===1){isolated.push(component[0]);return;}
    const roots=component.filter(name=>!forest.parentOf.has(name)).sort((a,b)=>
      Number(!forest.children.get(a).length)-Number(!forest.children.get(b).length)||a.localeCompare(b));
    const blocks=roots.map(root=>treeBlock(root,component[0]));
    connected.push(packLayoutBlocks(blocks,Math.max(innerWidth,...blocks.map(block=>block.width))));
  });
  const blocks=connected.slice();
  if(isolated.length){
    blocks.push(packLayoutBlocks(isolated.map(name=>treeBlock(name,name)),
      Math.min(isolated.length,dimensions.singleColumns)*dimensions.treePitchX));
  }
  const packed=packLayoutBlocks(blocks,Math.max(innerWidth,...blocks.map(block=>block.width)),
    dimensions.treePitchX*dimensions.treeGapUnits,dimensions.sectionGap);
  const raw=[...packed.positions.values()];
  const minX=raw.length?Math.min(...raw.map(p=>p.x)):0;
  const maxX=raw.length?Math.max(...raw.map(p=>p.x)):0;
  const minY=raw.length?Math.min(...raw.map(p=>p.y)):0;
  const maxY=raw.length?Math.max(...raw.map(p=>p.y)):0;
  const width=Math.max(dimensions.width,maxX-minX+dimensions.xPadding*2);
  const height=Math.max(dimensions.height,maxY-minY+dimensions.topPadding+dimensions.bottomPadding);
  const left=(width-(maxX-minX))/2;
  const top=dimensions.topPadding+(height-dimensions.topPadding-dimensions.bottomPadding-(maxY-minY))/2;
  const positions=new Map();
  packed.positions.forEach((position,name)=>{
    const agent=forest.byName.get(name);
    positions.set(name,{...position,x:left+position.x-minX,y:top+position.y-minY,
      agent,hue:OC.lineageHue.get(name)||'#7a8794',working:agent.act_state==='work'});
  });
  return {width,height,positions,parentOf:forest.parentOf,trees:forest.trees,
    singletons:isolated,components};
}

/* A hop follows a known spawn or communication edge between live agents. */
function telemetryNetworkSubset(live,focus,depth){
  const byName=new Map((live||[]).filter(agent=>agent&&agent.name)
    .map(agent=>[agent.name,agent]));
  if(!focus||!byName.has(focus))return null;
  const adjacent=new Map([...byName.keys()].map(name=>[name,new Set()]));
  OC.lineageParent.forEach((parent,child)=>{
    if(!adjacent.has(parent)||!adjacent.has(child))return;
    adjacent.get(parent).add(child);adjacent.get(child).add(parent);
  });
  communicationPairs().forEach(pair=>{
    if(!adjacent.has(pair.a)||!adjacent.has(pair.b))return;
    adjacent.get(pair.a).add(pair.b);adjacent.get(pair.b).add(pair.a);
  });
  const visible=new Set([focus]);
  let frontier=[focus];
  for(let hop=0;hop<Math.max(1,Math.min(3,Number(depth)||2));hop++){
    const next=[];
    frontier.forEach(name=>(adjacent.get(name)||[]).forEach(other=>{
      if(visible.has(other))return;
      visible.add(other);next.push(other);
    }));
    frontier=next;
    if(!frontier.length)break;
  }
  return {byName,visible};
}
function telemetryMiniLayout(live,focus,depth,dimensions){
  const subset=telemetryNetworkSubset(live,focus,depth);
  if(!subset)return layoutAgents(live,dimensions);
  const names=[...subset.visible].sort((a,b)=>a.localeCompare(b));
  const others=names.filter(name=>name!==focus);
  const rx=Math.min(102,dimensions.width*.36),ry=dimensions.height*.34;
  const offsets=[{name:focus,x:0,y:0}];
  others.forEach((name,index)=>{
    const angle=-Math.PI/2+(Math.PI*2*index)/others.length;
    offsets.push({name,x:Math.cos(angle)*rx,y:Math.sin(angle)*ry});
  });
  const [horizontal,vertical]=captionClearance(dimensions);
  let scale=1;
  for(let i=0;i<offsets.length;i++){
    for(let j=0;j<i;j++){
      const dx=Math.abs(offsets[i].x-offsets[j].x),dy=Math.abs(offsets[i].y-offsets[j].y);
      scale=Math.max(scale,Math.min(horizontal/dx,vertical/dy));
    }
  }
  const width=Math.max(dimensions.width,2*rx*scale+2*dimensions.xPadding);
  const height=Math.max(dimensions.height,2*ry*scale+dimensions.topPadding+dimensions.bottomPadding);
  const centerX=width/2,centerY=(height+dimensions.topPadding-dimensions.bottomPadding)/2;
  const positions=new Map();
  const positionFor=(name,x,y,networkFocus=false)=>{
    const agent=subset.byName.get(name);
    positions.set(name,{x,y,agent,component:focus,hue:OC.lineageHue.get(name)||'#7a8794',
      working:agent.act_state==='work',networkFocus});
  };
  offsets.forEach(({name,x,y})=>positionFor(name,centerX+x*scale,centerY+y*scale,name===focus));
  const parentOf=new Map();
  OC.lineageParent.forEach((parent,child)=>{
    if(positions.has(parent)&&positions.has(child))parentOf.set(child,parent);
  });
  return {width,height,positions,parentOf,trees:[],singletons:[],networkFocus:focus};
}

function createMotionSurface(target,dimensions){
  return {
    target,dimensions,states:new Map(),positions:new Map(),nodes:new Map(),
    spawnEdges:[],spawnPairs:new Set(),initialized:false,active:false,settledFrames:0,
  };
}
const miniMotion=createMotionSurface(miniSvg,MINI);
let planetMotion=null;
miniPositions=miniMotion.positions;

function motionIsReduced(){
  return Boolean(reducedMotion&&reducedMotion.matches);
}
function newNodeStart(name,target,dimensions){
  const centerX=dimensions.width/2,centerY=dimensions.height/2;
  let dx=target.x-centerX,dy=target.y-centerY;
  let distance=Math.hypot(dx,dy);
  if(distance<1){
    const angle=[...String(name)].reduce((sum,char)=>
      sum+char.codePointAt(0),0)%360*Math.PI/180;
    dx=Math.cos(angle);dy=Math.sin(angle);distance=1;
  }
  const offset=dimensions.large?46:16;
  return {
    x:target.x+dx/distance*offset,
    y:target.y+dy/distance*offset,
  };
}
function prepareMotion(surface,layout,viewportChanged=false){
  const instant=viewportChanged||!surface.initialized||motionIsReduced();
  surface.layoutDimensions={
    ...surface.dimensions,width:layout.width,height:layout.height,
  };
  surface.spawnPairs=new Set([...layout.parentOf].map(([child,parent])=>pairKey(parent,child)));
  const seen=new Set();
  layout.positions.forEach((target,name)=>{
    seen.add(name);
    let state=surface.states.get(name);
    if(!state){
      const start=instant?target:newNodeStart(name,target,{
        ...surface.dimensions,width:layout.width,height:layout.height,
      });
      state={
        name,x:start.x,y:start.y,vx:0,vy:0,opacity:instant?1:0,
        targetOpacity:1,removing:false,
      };
      surface.states.set(name,state);
    }
    state.tx=target.x;state.ty=target.y;
    state.baseX=target.x;state.baseY=target.y;
    state.agent=target.agent;state.hue=target.hue;
    state.working=target.working;
    state.component=target.component||null;
    state.networkFocus=Boolean(target.networkFocus);
    state.targetOpacity=1;state.removing=false;
    if(instant){
      state.x=state.tx;state.y=state.ty;state.vx=0;state.vy=0;state.opacity=1;
    }
  });
  [...surface.states].forEach(([name,state])=>{
    if(seen.has(name))return;
    if(instant){surface.states.delete(name);return;}
    state.tx=state.x;state.ty=state.y;
    state.baseX=state.x;state.baseY=state.y;
    state.targetOpacity=0;state.removing=true;
  });
  surface.positions.clear();
  surface.states.forEach((state,name)=>surface.positions.set(name,state));
  surface.initialized=true;surface.settledFrames=0;
  surface.active=!instant&&[...surface.states.values()].some(state=>
    Math.hypot(state.tx-state.x,state.ty-state.y)>MOTION_SETTLE_DISTANCE||
    Math.hypot(state.vx,state.vy)>MOTION_SETTLE_SPEED||
    Math.abs(state.targetOpacity-state.opacity)>.006);
}
function updateSurfaceGeometry(surface){
  surface.states.forEach((state,name)=>{
    const node=surface.nodes.get(name);
    if(node){
      const dx=state.x-state.baseX,dy=state.y-state.baseY;
      if(Math.abs(dx)>.001||Math.abs(dy)>.001){
        node.setAttribute('transform',`translate(${dx} ${dy})`);
      }else node.removeAttribute('transform');
      node.style.opacity=String(Math.max(0,Math.min(1,state.opacity)));
    }
  });
  surface.spawnEdges.forEach(edge=>{
    const from=surface.states.get(edge.dataset.parent);
    const to=surface.states.get(edge.dataset.child);
    if(!from||!to)return;
    edge.setAttribute('x1',from.x);edge.setAttribute('y1',from.y);
    edge.setAttribute('x2',to.x);edge.setAttribute('y2',to.y);
    edge.style.opacity=String(Math.min(from.opacity,to.opacity));
  });
  const commLayer=commLayerOf(surface.target);
  if(commLayer){
    commLayer.querySelectorAll('.orrery-comm-edge').forEach(edge=>{
      const from=surface.states.get(edge.dataset.a);
      const to=surface.states.get(edge.dataset.b);
      if(!from||!to)return;
      const curve=commPathBetween(
        from,to,surface.positions,surface.layoutDimensions||surface.dimensions);
      edge.setAttribute('d',curve.d);
      const life=Number(edge.dataset.life||0);
      edge.setAttribute('stroke-opacity',
        ((.2+.38*life)*Math.min(from.opacity,to.opacity)).toFixed(3));
    });
  }
  if(activeMailRoute)renderMailFocus(surface);
}
function finishSurfaceMotion(surface){
  const removing=[];
  surface.states.forEach((state,name)=>{
    state.x=state.tx;state.y=state.ty;state.vx=0;state.vy=0;
    state.opacity=state.targetOpacity;
    if(state.removing)removing.push(name);
  });
  removing.forEach(name=>{
    const node=surface.nodes.get(name);if(node)node.remove();
    surface.nodes.delete(name);surface.states.delete(name);surface.positions.delete(name);
  });
  surface.active=false;surface.settledFrames=0;
  updateSurfaceGeometry(surface);
}
function stepSurfaceMotion(surface,dt){
  if(!surface.active)return false;
  let unsettled=false;
  surface.states.forEach(state=>{
    const ax=(state.tx-state.x)*MOTION_STIFFNESS-state.vx*MOTION_DAMPING;
    const ay=(state.ty-state.y)*MOTION_STIFFNESS-state.vy*MOTION_DAMPING;
    state.vx+=ax*dt;state.vy+=ay*dt;
    state.x+=state.vx*dt;state.y+=state.vy*dt;
    const alpha=1-Math.exp(-11*dt);
    state.opacity+=(state.targetOpacity-state.opacity)*alpha;
    const distance=Math.hypot(state.tx-state.x,state.ty-state.y);
    const speed=Math.hypot(state.vx,state.vy);
    if(distance>=MOTION_SETTLE_DISTANCE||speed>=MOTION_SETTLE_SPEED||
       Math.abs(state.targetOpacity-state.opacity)>=.006)unsettled=true;
  });
  updateSurfaceGeometry(surface);
  surface.settledFrames=unsettled?0:surface.settledFrames+1;
  if(surface.settledFrames>=MOTION_SETTLE_FRAMES){
    finishSurfaceMotion(surface);return false;
  }
  return true;
}
function motionSurfaces(){
  const surfaces=[miniMotion];
  if(planetMotion&&planetarium&&planetarium.classList.contains('on')){
    surfaces.push(planetMotion);
  }
  return surfaces;
}
function syncMotionLoop(){
  const active=motionSurfaces().some(surface=>surface.active);
  if(!active){
    if(motionFrameId!==null)cancelAnimationFrame(motionFrameId);
    motionFrameId=null;motionLastTime=null;return;
  }
  if(motionFrameId===null)motionFrameId=requestAnimationFrame(runMotionFrame);
}
function runMotionFrame(now){
  motionFrameId=null;
  const dt=motionLastTime===null?1/60:
    Math.max(1/240,Math.min(1/30,(now-motionLastTime)/1000));
  motionLastTime=now;
  motionSurfaces().forEach(surface=>stepSurfaceMotion(surface,dt));
  syncMotionLoop();
}

function drawSpawnEdges(target,layout,large){
  const layer=svgEl('g',{class:'orrery-spawn-layer'});
  layout.parentOf.forEach((parent,child)=>{
    const from=layout.positions.get(parent),to=layout.positions.get(child);
    if(!from||!to)return;
    layer.appendChild(svgEl('line',{
      class:'orrery-spawn-edge'+(large?' planet-edge':''),
      x1:from.x,y1:from.y,x2:to.x,y2:to.y,
      'data-parent':parent,'data-child':child,
    }));
  });
  target.appendChild(layer);
  return layer;
}

// Keep provider choice and unknown labels identical across portrait views.
// Compact fallback text is shared with the roster; hover keeps it whole.
function drawProviderBadge(group,agent,x,y,portraitRadius,size=14){
  const presentation=OC.providerPresentation(agent);
  const {provider,text,compactText,local}=presentation;
  const label=local?text:(provider?provider.label:text);
  const seat=svgEl('g',{class:'mini-provider-badge'+(size>14?' planet-provider-badge':'')+(local?' local-provider-badge':''),role:'img','aria-label':label,
    transform:`translate(${x+portraitRadius*.72} ${y+portraitRadius*.72})`});
  const title=svgEl('title');title.textContent=label;seat.appendChild(title);
  if(local){
    const r=size/2;
    seat.appendChild(svgEl('polygon',{class:'mini-provider-seat',
      points:`0,${-r*.92} ${r*.8},${-r*.46} ${r*.8},${r*.46} 0,${r*.92} ${-r*.8},${r*.46} ${-r*.8},${-r*.46}`}));
  }else seat.appendChild(svgEl('circle',{class:'mini-provider-seat',r:size/2}));
  const fallback=()=>{
    if(local)return; // Unknown local maker keeps the hexagon without an adapter mark.
    const mark=svgEl('text',{class:'mini-provider-fallback',x:0,y:0,
      'text-anchor':'middle','dominant-baseline':'central',transform:`scale(${size/14})`});
    mark.textContent=compactText;seat.appendChild(mark);
  };
  if(provider){
    const h=size*.58;
    const aspect={anthropic:1,openai:256/260,google:1,deepseek:71.69/52.76};
    const w=h*(aspect[provider.asset]||1);
    const mark=svgEl('image',{class:'mini-provider-logo',x:-w/2,y:-h/2,width:w,height:h,
      href:'cockpit-assets/'+provider.asset+'.svg','aria-label':label,
      preserveAspectRatio:'xMidYMid meet'});
    mark.addEventListener('error',()=>{mark.remove();fallback();},{once:true});
    seat.appendChild(mark);
  }else fallback();
  group.appendChild(seat);
  return label;
}
function drawAgentCaption(group,{agent,x,y},dimensions,provider){
  const role=roleOf(agent);
  const title=svgEl('title');
  title.textContent=[agent.name,role,modelOf(agent),provider].filter(Boolean).join(' · ');
  group.prepend(title);

  // Keep the full text in the DOM so Demo can mask whole names before the
  // browser clips them to the cell.
  const caption=svgEl('foreignObject',{x:x-dimensions.captionWidth/2,y:y+dimensions.captionTop,
    width:dimensions.captionWidth,height:dimensions.captionHeight,'aria-hidden':'true'});
  const text=document.createElement('div');
  text.className='orrery-caption';
  const name=document.createElement('div');
  name.className='orrery-caption-name';
  name.textContent=agent.name;
  text.appendChild(name);
  if(role){
    const roleLabel=document.createElement('div');
    roleLabel.className='orrery-caption-role';
    roleLabel.textContent=role;
    text.appendChild(roleLabel);
  }
  caption.appendChild(text);
  group.appendChild(caption);
}
function drawMiniAgent(target,defs,position,index,dimensions){
  const {agent,x,y,hue,working}=position;
  const portraitRadius=8.5;
  const ringRadius=11;
  const clipId=`mini-portrait-${index}`;
  const clip=svgEl('clipPath',{id:clipId});
  clip.appendChild(svgEl('circle',{cx:x,cy:y,r:portraitRadius}));
  defs.appendChild(clip);
  const group=svgEl('g',{
    class:'orrery-agent mini-agent'+(working?' is-working':'')+(position.networkFocus?' is-network-focus':''),
    'data-agent':agent.name,'data-component':position.component||agent.name,
  });
  makeInteractive(group,agent);
  group.appendChild(svgEl('circle',{class:'orrery-hit',cx:x,cy:y,r:14}));
  group.appendChild(svgEl('circle',{
    class:'mini-portrait-fallback',cx:x,cy:y,r:portraitRadius,
  }));
  const fallback=svgEl('text',{
    class:'mini-initial',x,y:y+2.7,'text-anchor':'middle',
  });
  fallback.textContent=initialLetter(agent.name);
  group.appendChild(fallback);
  const image=svgEl('image',{
    class:'mini-portrait',
    x:x-portraitRadius,y:y-portraitRadius,
    width:portraitRadius*2,height:portraitRadius*2,
    href:'/telemetry/portrait?v=4&style=pixel&name='+encodeURIComponent(agent.name),
    'clip-path':`url(#${clipId})`,
    preserveAspectRatio:'xMidYMid slice',
    'aria-hidden':'true',
  });
  image.addEventListener('error',()=>image.classList.add('failed'));
  group.appendChild(image);
  // Neutral ring in the compact rail (2026-07-30 product decision): spawn edges already
  // tie families together at this scale — lineage hue stays in the dense
  // fullscreen views (planetarium / NETWORK) only.
  group.appendChild(svgEl('circle',{
    class:'mini-lineage-ring',cx:x,cy:y,r:ringRadius,
    stroke:'rgba(236,229,214,.30)',
  }));
  group.appendChild(svgEl('circle',{
    class:'orrery-motion-ring mini-motion-ring',cx:x,cy:y,r:ringRadius+2.7,
    pathLength:'100',
  }));
  // Last, so the portrait cannot bury it: SVG has no z-index — paint order is
  // DOM order. Drawn before the <image>, "someone is waiting on you" was
  // silently painted over by the face (2026-08-06).
  const providerLabel=drawProviderBadge(group,agent,x,y,portraitRadius);
  drawStateGlyph(group,agent,x,y,false);
  drawAgentCaption(group,position,dimensions,providerLabel);
  target.appendChild(group);
  return group;
}

function drawPlanetAgent(target,defs,position,index){
  const {agent,x,y,hue,working}=position;
  const radius=28;
  const portraitRadius=24;
  const clipId=`planet-portrait-${index}`;
  const clip=svgEl('clipPath',{id:clipId});
  clip.appendChild(svgEl('circle',{cx:x,cy:y,r:portraitRadius}));
  defs.appendChild(clip);
  const group=svgEl('g',{
    class:'orrery-agent planet-agent'+(working?' is-working':''),
    'data-agent':agent.name,'data-component':position.component||agent.name,
  });
  makeInteractive(group,agent);
  group.appendChild(svgEl('circle',{class:'orrery-hit',cx:x,cy:y,r:radius+8}));
  group.appendChild(svgEl('circle',{
    class:'planet-portrait-fallback',cx:x,cy:y,r:portraitRadius,
  }));
  const fallback=svgEl('text',{
    class:'planet-initials',x,y:y+6,'text-anchor':'middle',
  });
  fallback.textContent=initials(agent.name);
  group.appendChild(fallback);
  // Line art, not the photographs: at medallion size the greyscale portraits
  // read as smudges against the dark ground, and the whole point of the
  // disc is telling one agent from another at a glance (2026-08-25 maintainer).
  const image=svgEl('image',{
    class:'planet-portrait',
    x:x-portraitRadius,y:y-portraitRadius,
    width:portraitRadius*2,height:portraitRadius*2,
    href:'/telemetry/portrait?v=4&style=pixel&name='+encodeURIComponent(agent.name),
    'clip-path':`url(#${clipId})`,
    preserveAspectRatio:'xMidYMid slice',
    'aria-hidden':'true',
  });
  image.addEventListener('error',()=>image.classList.add('failed'));
  group.appendChild(image);
  group.appendChild(svgEl('circle',{
    class:'planet-lineage-ring',cx:x,cy:y,r:radius,
  }));
  group.appendChild(svgEl('circle',{
    class:'orrery-motion-ring planet-motion-ring',cx:x,cy:y,r:radius+5,
    pathLength:'100',
  }));
  // After the motion ring, not before: the rotating arc was painting over the
  // state orbit that sits just outside it.
  const providerLabel=drawProviderBadge(group,agent,x,y,portraitRadius,26);
  drawStateGlyph(group,agent,x,y,true);
  drawAgentCaption(group,position,PLANET,providerLabel);
  target.appendChild(group);
  return group;
}

function addExpandAffordance(target,dimensions,isOpen){
  const large=dimensions.large;
  const x=dimensions.width-(large?31:14);
  const y=large?31:14;
  const group=svgEl('g',{
    class:'orrery-expand',
    role:'button',
    tabindex:'0',
    'aria-label':isOpen?'Close planetarium':'Open planetarium',
    // The tour's checklist folds out of the way of the way out.
    ...(isOpen?{'data-tour-keep-visible':''}:{}),
  });
  group.appendChild(svgEl('rect',{
    x:x-(large?20:11),y:y-(large?20:10),
    width:large?40:22,height:large?40:20,rx:large?7:4,
  }));
  const glyph=svgEl('text',{
    x,y:y+(large?7:4),'text-anchor':'middle',
  });
  glyph.textContent='⤢';
  group.appendChild(glyph);
  const activate=event=>{
    event.preventDefault();
    event.stopPropagation();
    if(isOpen)closePlanetarium();
    else openPlanetarium();
  };
  group.addEventListener('click',activate);
  group.addEventListener('keydown',event=>{
    if(event.key==='Enter'||event.key===' ')activate(event);
  });
  target.appendChild(group);
}

function preservedFlights(target){
  return [...target.children].filter(child=>
    child.classList.contains('orrery-comet-flight'));
}
function syncMiniSelection(){
  miniSvg.querySelectorAll('.mini-selection-ring').forEach(ring=>ring.remove());
  if(miniMode!=='orrery')return;
  // The roster can point to a separate window or a terminal-less agent.
  // Only the pane actually displayed in the center owns this marker.
  const name=OC.activeAgent&&OC.activeAgent();
  const group=miniMotion.nodes.get(name);
  if(!group)return;
  const hit=group.querySelector('.orrery-hit');
  group.appendChild(svgEl('circle',{
    class:'mini-selection-ring',cx:hit.getAttribute('cx'),cy:hit.getAttribute('cy'),r:19.5,
  }));
}
function installMiniGraphDivider(){
  const divider=document.getElementById('mailGraphDivider');
  if(!divider)return;
  const rail=miniSvg.parentElement,head=miniSvg.previousElementSibling;
  let preferred=readPreference(),drag=null;
  function readPreference(){
    try{
      const saved=Number(localStorage.getItem(MINI_HEIGHT_KEY));
      if(Number.isFinite(saved)&&saved>=MINI_MIN_HEIGHT&&saved<=MINI_MAX_HEIGHT)return Math.round(saved);
    }catch(_){/* preference unavailable */}
    return MINI.height;
  }
  function maxHeight(){
    return Math.max(MINI_MIN_HEIGHT,Math.min(MINI_MAX_HEIGHT,rail.clientHeight-head.offsetHeight-MAIL_BELOW_GRAPH));
  }
  function paint(height=preferred){
    const max=maxHeight(),value=Math.max(MINI_MIN_HEIGHT,Math.min(max,Math.round(height)));
    miniSvg.style.height=value+'px';
    divider.setAttribute('aria-valuemin',MINI_MIN_HEIGHT);
    divider.setAttribute('aria-valuemax',max);
    divider.setAttribute('aria-valuenow',value);
    divider.setAttribute('aria-valuetext',value+' pixels');
    return value;
  }
  function save(height){
    preferred=height;
    paint();
    try{
      localStorage.setItem(MINI_HEIGHT_KEY,String(preferred));
      window.OrreryPrefs?.flush();
    }catch(_){/* keep the live height */}
  }
  function syncPreference(){
    preferred=readPreference();
    if(!drag)paint();
  }
  divider.addEventListener('pointerdown',event=>{
    if(event.button!==0||drag)return;
    event.preventDefault();
    const height=miniSvg.clientHeight;
    drag={id:event.pointerId,y:event.clientY,height,preview:height};
    divider.focus({preventScroll:true});
    divider.classList.add('dragging');
    divider.setPointerCapture(event.pointerId);
  });
  function move(event){
    if(!drag||drag.id!==event.pointerId)return;
    drag.preview=paint(drag.height+event.clientY-drag.y);
  }
  function finish(event){
    if(!drag||drag.id!==event.pointerId)return;
    if(event.type==='pointerup')move(event);
    const {height,preview}=drag;
    drag=null;
    divider.classList.remove('dragging');
    if(event.type==='pointerup'&&preview!==height)save(preview);
    else paint();
  }
  divider.addEventListener('pointermove',move);
  for(const type of ['pointerup','pointercancel','lostpointercapture'])divider.addEventListener(type,finish);
  divider.addEventListener('dblclick',()=>save(MINI.height));
  divider.addEventListener('keydown',event=>{
    if(drag)return;
    const step=event.shiftKey?64:24;
    const current=miniSvg.clientHeight;
    let height;
    switch(event.key){
      case 'ArrowUp':height=Math.max(MINI_MIN_HEIGHT,current-step);break;
      case 'ArrowDown':height=Math.min(maxHeight(),current+step);break;
      case 'Home':height=MINI_MIN_HEIGHT;break;
      case 'End':height=maxHeight();break;
      case 'Enter':height=MINI.height;break;
      default:return;
    }
    event.preventDefault();save(height);
  });
  window.addEventListener('storage',event=>{if(event.key===MINI_HEIGHT_KEY)syncPreference();});
  document.addEventListener('oc:prefs-changed',event=>{
    if(event.detail?.keys?.includes(MINI_HEIGHT_KEY))syncPreference();
  });
  new ResizeObserver(()=>paint(drag?.preview??preferred)).observe(rail);
  paint();
}
function renderMini(){
  const width=miniSvg.clientWidth||miniWidth,height=miniSvg.clientHeight||miniHeight;
  const resized=width!==miniWidth||height!==miniHeight;
  miniWidth=width;miniHeight=height;
  // Fit the base scene into the viewport, then use any extra room for layout.
  // This keeps the SVG's normal scale while allowing the network to spread.
  const scale=Math.min(width/MINI.width,height/MINI.height);
  const dimensions={...MINI,width:width/scale,height:height/scale};
  const flights=preservedFlights(miniSvg);
  miniSvg.replaceChildren();
  const layout=miniMode==='network'
    ?telemetryMiniLayout(liveAgents,miniFocusName,miniNetworkDepth,dimensions)
    :layoutAgents(liveAgents,dimensions);
  prepareMotion(miniMotion,layout,resized);
  miniSvg.setAttribute('viewBox',`0 0 ${layout.width} ${layout.height}`);
  miniSvg.classList.toggle('orrery-mode',miniMode==='orrery');
  miniSvg.classList.toggle('telemetry-network',Boolean(layout.networkFocus));
  miniSvg.setAttribute('aria-label',layout.networkFocus
    ?`Telemetry network for ${layout.networkFocus}, ${miniNetworkDepth} hops`
    :'Live agent spawn and communication graph');
  const defs=svgEl('defs');
  miniSvg.appendChild(defs);
  const spawnLayer=drawSpawnEdges(miniSvg,layout,false);
  miniSvg.appendChild(svgEl('g',{class:'orrery-comm-layer'}));
  const nodes=svgEl('g',{class:'orrery-node-layer'});
  let index=0;
  miniMotion.nodes.clear();
  miniMotion.states.forEach((state,name)=>{
    const group=drawMiniAgent(nodes,defs,{
      ...state,x:state.baseX,y:state.baseY,
    },index++,dimensions);
    miniMotion.nodes.set(name,group);
  });
  miniSvg.appendChild(nodes);
  addExpandAffordance(miniSvg,{...dimensions,width:layout.width,height:layout.height},false);
  flights.forEach(flight=>miniSvg.appendChild(flight));
  miniMotion.spawnEdges=[...spawnLayer.children];
  syncMiniSelection();
  refreshCommEdges();
  updateSurfaceGeometry(miniMotion);
  syncMotionLoop();
}
function renderPlanetarium(){
  if(!planetSvg||!planetarium.classList.contains('on'))return;
  const flights=preservedFlights(planetSvg);
  planetSvg.replaceChildren();
  // Keep the complete spawn forest; communication groups it without changing ancestry.
  const layout=layoutAgents(liveAgents,PLANET);
  prepareMotion(planetMotion,layout);
  planetSvg.setAttribute('viewBox',`0 0 ${layout.width} ${layout.height}`);
  planetSvg.classList.toggle('telemetry-network',Boolean(layout.networkFocus));
  const defs=svgEl('defs');
  planetSvg.appendChild(defs);
  const spawnLayer=drawSpawnEdges(planetSvg,layout,true);
  planetSvg.appendChild(svgEl('g',{class:'orrery-comm-layer'}));
  const nodes=svgEl('g',{class:'orrery-node-layer'});
  let index=0;
  planetMotion.nodes.clear();
  planetMotion.states.forEach((state,name)=>{
    const group=drawPlanetAgent(nodes,defs,{
      ...state,x:state.baseX,y:state.baseY,
    },index++);
    planetMotion.nodes.set(name,group);
  });
  planetSvg.appendChild(nodes);
  addExpandAffordance(
    planetSvg,{...PLANET,width:layout.width,height:layout.height},true);
  flights.forEach(flight=>planetSvg.appendChild(flight));
  planetMotion.spawnEdges=[...spawnLayer.children];
  refreshCommEdges();
  updateSurfaceGeometry(planetMotion);
  syncMotionLoop();
}

function ensurePlanetarium(){
  if(planetarium)return;
  planetarium=document.createElement('div');
  planetarium.className='overlay orrery-planetarium';
  planetarium.id='planetariumOverlay';
  planetarium.setAttribute('role','dialog');
  planetarium.setAttribute('aria-modal','true');
  planetarium.setAttribute('aria-labelledby','planetariumTitle');
  planetarium.setAttribute('aria-hidden','true');
  const panel=document.createElement('section');
  panel.className='planetarium-panel';
  const head=document.createElement('header');
  head.className='planetarium-head';
  const title=document.createElement('div');
  title.id='planetariumTitle';
  title.className='planetarium-title';
  title.textContent='Planetarium';
  const note=document.createElement('div');
  note.className='planetarium-note';
  note.textContent='SPAWN + MAIL LINKS · ACTIVITY (90 S)';
  const telemetry=document.createElement('button');
  telemetry.className='planetarium-telemetry';telemetry.type='button';
  telemetry.textContent='OPEN TELEMETRY ↗';
  telemetry.setAttribute('aria-label','Open the telemetry network dashboard');
  telemetry.addEventListener('click',()=>{
    // Keep the nested overlays ordered: reveal the telemetry workspace before
    // its open event reaches cockpit.html.
    closePlanetarium();
    document.dispatchEvent(new CustomEvent('oc:open-telemetry',{
      detail:{focus:OC.activeAgent&&OC.activeAgent()||miniFocusName||''},
    }));
  });
  head.append(title,note,telemetry);
  planetSvg=svgEl('svg',{
    class:'planetarium-svg',
    viewBox:`0 0 ${PLANET.width} ${PLANET.height}`,
    role:'group',
    'aria-label':'Live agent spawn and communication graph',
    tabindex:'-1',
  });
  planetMotion=createMotionSurface(planetSvg,PLANET);
  planetPositions=planetMotion.positions;
  panel.append(head,planetSvg);
  planetarium.appendChild(panel);
  planetarium.addEventListener('mousedown',event=>{
    if(event.target===planetarium)closePlanetarium();
  });
  document.body.appendChild(planetarium);
}
function openPlanetarium(){
  ensurePlanetarium();
  if(planetarium.classList.contains('on'))return;
  planetLastFocus=document.activeElement;
  planetarium.classList.add('on');
  planetarium.setAttribute('aria-hidden','false');
  renderPlanetarium();
  requestAnimationFrame(()=>planetSvg.focus());
}
function closePlanetarium(){
  if(!planetarium||!planetarium.classList.contains('on'))return;
  planetarium.classList.remove('on');
  planetarium.setAttribute('aria-hidden','true');
  if(planetMotion){
    planetMotion.active=false;planetMotion.initialized=false;
    planetMotion.states.clear();planetMotion.positions.clear();
    planetMotion.nodes.clear();planetMotion.spawnEdges=[];planetMotion.spawnPairs.clear();
  }
  syncMotionLoop();
  const restoreTarget=planetLastFocus&&planetLastFocus.isConnected&&
    planetLastFocus!==document.body
    ?planetLastFocus:miniSvg.querySelector('.orrery-expand');
  if(restoreTarget)restoreTarget.focus();
  document.dispatchEvent(new CustomEvent('oc:planetarium-closed'));
}

function recipientNames(message){
  if(message.recipient)return [typeof message.recipient==='string'
    ?message.recipient:message.recipient.name].filter(Boolean);
  if(!Array.isArray(message.recipients))return [];
  return message.recipients.map(recipient=>
    typeof recipient==='string'?recipient:recipient&&recipient.name).filter(Boolean);
}
function senderName(message){
  return typeof message.sender==='string'
    ?message.sender:message.sender&&message.sender.name;
}
function timestampMs(value){
  if(typeof value==='number'&&Number.isFinite(value)){
    return value>1e12?value:value*1000;
  }
  if(typeof value==='string'&&value.trim()){
    const numeric=Number(value);
    if(Number.isFinite(numeric))return numeric>1e12?numeric:numeric*1000;
    const parsed=Date.parse(value);
    if(Number.isFinite(parsed))return parsed;
  }
  return null;
}
function observedMailTime(message,serverNowMs){
  const sentAt=timestampMs(message.ts||message.created_ts);
  if(sentAt===null)return Date.now();
  if(serverNowMs!==null){
    const age=Math.max(0,serverNowMs-sentAt);
    return Date.now()-age;
  }
  return Math.min(Date.now(),sentAt);
}
function pairKey(a,b){
  return a.localeCompare(b)<=0?`${a}\u001f${b}`:`${b}\u001f${a}`;
}
function recordMessages(messages,serverNowMs=null){
  const now=Date.now();
  const liveNames=new Set(liveAgents.map(agent=>agent.name));
  (messages||[]).forEach(message=>{
    const from=senderName(message);
    if(!from)return;
    const sentAt=observedMailTime(message,serverNowMs);
    recipientNames(message).forEach(to=>{
      if(!to||to===from)return;
      const key=pairKey(from,to);
      const ordered=from.localeCompare(to)<=0?[from,to]:[to,from];
      const existing=observedConnections.get(key);
      observedConnections.set(key,{a:ordered[0],b:ordered[1],observedAt:now,
        confirmed:Boolean(existing?.confirmed)||(liveNames.has(from)&&liveNames.has(to))});
      if(now-sentAt>=MAIL_EDGE_LIFETIME)return;
      const previous=commPairs.get(key);
      if(!previous||sentAt>previous.ts){
        commPairs.set(key,{a:ordered[0],b:ordered[1],ts:sentAt});
      }
    });
  });
}
function commLayerOf(target){
  return [...target.children].find(child=>
    child.classList.contains('orrery-comm-layer'));
}
function segmentNearNode(from,to,node,radius){
  const dx=to.x-from.x,dy=to.y-from.y;
  const x=node.x-from.x,y=node.y-from.y;
  const t=Math.max(0,Math.min(1,(x*dx+y*dy)/(dx*dx+dy*dy||1)));
  return (x-dx*t)**2+(y-dy*t)**2<=radius*radius;
}
function commPathBetween(from,to,positions,dimensions,spawnPairs){
  const dx=to.x-from.x,dy=to.y-from.y;
  const straight={
    d:`M ${from.x} ${from.y} L ${to.x} ${to.y}`,
    point:t=>({x:from.x+dx*t,y:from.y+dy*t}),
  };
  const distance=Math.hypot(dx,dy);
  if(!distance||(spawnPairs&&isLineagePair(from.name,to.name,spawnPairs)))return straight;
  // Clear the portrait's outer ring, with room for the edge stroke.
  const radius=dimensions.large?32:14;
  const nodes=[...positions.values()].filter(node=>node!==from&&node!==to);
  if(!nodes.some(node=>segmentNearNode(from,to,node,radius)))return straight;

  // Start with a shallow detour on either side of the line. Use the same
  // side in both directions, so a highlighted reply retraces its Mail edge.
  const direction=dx<0||(dx===0&&dy<0)?-1:1;
  const nx=direction*dy/distance,ny=-direction*dx/distance;
  let best=straight,fewest=Infinity;
  for(const depth of [2.5,4,6]){
    for(const side of [1,-1]){
      const offset=depth*side*radius;
      const cx=Math.max(0,Math.min(dimensions.width,(from.x+to.x)/2+nx*offset));
      const cy=Math.max(0,Math.min(dimensions.height,(from.y+to.y)/2+ny*offset));
      const point=t=>{
        const mt=1-t;
        return {
          x:mt*mt*from.x+2*mt*t*cx+t*t*to.x,
          y:mt*mt*from.y+2*mt*t*cy+t*t*to.y,
        };
      };
      const curve={d:`M ${from.x} ${from.y} Q ${cx} ${cy} ${to.x} ${to.y}`,point};
      // Test the detour for other portraits as well. Twelve chords with one
      // extra unit of clearance cover the small gap between each chord and
      // the quadratic at these depths.
      const points=Array.from({length:13},(_,index)=>point(index/12));
      const hits=nodes.filter(node=>points.some((end,index)=>index>0&&
        segmentNearNode(points[index-1],end,node,radius+1))).length;
      if(!hits)return curve;
      if(hits<fewest){best=curve;fewest=hits;}
    }
  }
  return best;
}
function renderMailFocus(surface){
  const target=surface?.target;
  if(!target)return;
  let layer=target.querySelector('.orrery-mail-focus');
  if(!activeMailRoute){
    layer?.remove();
    return;
  }
  const from=surface.states.get(activeMailRoute.sender);
  if(!layer){
    layer=svgEl('g',{class:'orrery-mail-focus','aria-hidden':'true'});
    target.insertBefore(layer,target.querySelector('.orrery-node-layer'));
  }
  layer.replaceChildren();
  if(!from||from.removing)return;
  const dimensions=surface.layoutDimensions||surface.dimensions;
  for(const name of activeMailRoute.recipients||[]){
    const to=surface.states.get(name);
    if(!to||to.removing||to===from)continue;
    const curve=commPathBetween(from,to,surface.positions,dimensions,surface.spawnPairs);
    const distance=Math.hypot(to.x-from.x,to.y-from.y);
    const t=Math.max(.45,1-(dimensions.large?27:14)/Math.max(distance,1));
    const tip=curve.point(t),base=curve.point(t-.05);
    const angle=Math.atan2(tip.y-base.y,tip.x-base.x),length=dimensions.large?9:5;
    const wing=turn=>`${tip.x-length*Math.cos(angle+turn)} ${tip.y-length*Math.sin(angle+turn)}`;
    layer.append(
      svgEl('path',{d:curve.d}),
      svgEl('path',{d:`M ${wing(.58)} L ${tip.x} ${tip.y} L ${wing(-.58)}`})
    );
  }
}
document.addEventListener('oc:mail-route',event=>{
  activeMailRoute=event.detail;
  renderMailFocus(miniMotion);
  if(planetarium?.classList.contains('on'))renderMailFocus(planetMotion);
});
/* A spawn always carries its task message, so a parent and its child are a
   mail pair by definition. Drawing both a spawn line and a mail curve for
   them puts two lines where there is one relationship. Hand the mail to the
   line that is already there — brighten it — and draw separate Mail edges
   for pairs the drawn lineage does not connect. */
function isLineagePair(a,b,spawnPairs){
  return spawnPairs.has(pairKey(a,b));
}
function markLiveSpawnEdges(target,liveSet){
  if(!target)return;
  target.querySelectorAll('.orrery-spawn-edge').forEach(edge=>{
    edge.classList.toggle('mail-live',
      liveSet.has(pairKey(edge.dataset.parent,edge.dataset.child)));
  });
}
function renderCommLayer(target,positions,dimensions){
  const layer=target&&commLayerOf(target);
  if(!layer)return;
  layer.replaceChildren();
  const now=Date.now();
  const liveLineage=new Set();
  const spawnPairs=new Set([...target.querySelectorAll('.orrery-spawn-edge')]
    .map(edge=>pairKey(edge.dataset.parent,edge.dataset.child)));
  communicationPairs().forEach((pair,key)=>{
    const from=positions.get(pair.a),to=positions.get(pair.b);
    if(!from||!to||from.removing||to.removing)return;
    const recent=commPairs.get(key);
    const life=recent?Math.max(0,Math.min(1,1-(now-recent.ts)/MAIL_EDGE_LIFETIME)):0;
    if(isLineagePair(pair.a,pair.b,spawnPairs)){
      if(life>0)liveLineage.add(key);
      return;
    }
    const curve=commPathBetween(from,to,positions,dimensions);
    layer.appendChild(svgEl('path',{
      class:'orrery-comm-edge',
      d:curve.d,fill:'none',
      'stroke-opacity':(.2+.38*life).toFixed(3),
      'data-a':pair.a,'data-b':pair.b,'data-life':life.toFixed(5),
    }));
  });
  markLiveSpawnEdges(target,liveLineage);
}
function refreshCommEdges(){
  const now=Date.now();
  const liveNames=new Set(liveAgents.map(agent=>agent.name));
  commPairs.forEach((pair,key)=>{
    if(now-pair.ts>=MAIL_EDGE_LIFETIME||
       ((!liveNames.has(pair.a)||!liveNames.has(pair.b))&&!observedConnections.has(key)))commPairs.delete(key);
  });
  renderCommLayer(miniSvg,miniPositions,miniMotion.layoutDimensions||MINI);
  if(planetarium&&planetarium.classList.contains('on')){
    renderCommLayer(
      planetSvg,planetPositions,
      (planetMotion&&planetMotion.layoutDimensions)||PLANET);
  }
  scheduleCommRefresh();
}
function scheduleCommRefresh(){
  if(commRefreshTimer!==null){
    clearTimeout(commRefreshTimer);commRefreshTimer=null;
  }
  const now=Date.now();
  let delay=Infinity;
  commPairs.forEach(pair=>{
    const age=now-pair.ts;
    if(age<MAIL_EDGE_LIFETIME){
      delay=Math.min(delay,500,Math.max(16,MAIL_EDGE_LIFETIME-age));
    }
  });
  if(!Number.isFinite(delay))return;
  commRefreshTimer=setTimeout(()=>{
    commRefreshTimer=null;
    refreshCommEdges();
  },delay);
}
async function seedRecentMail(){
  try{
    const data=await (await fetch(
      '/telemetry/mail/recent?limit=40',{cache:'no-store'})).json();
    if(data&&data.ok){
      recordMessages(data.messages,timestampMs(data.now));
      renderMini();
      renderPlanetarium();
    }
  }catch(error){/* live oc:mail still keeps the graph current */}
}

function subjectLabel(subject){
  const characters=[...String(subject||'')];
  return characters.length<=40
    ?characters.join('')
    :characters.slice(0,39).join('')+'…';
}
function animateComet(target,positions,fromName,toName,message,large){
  const from=positions.get(fromName),to=positions.get(toName);
  if(!from||!to||motionIsReduced())return Promise.resolve();
  const important=/^(high|urgent)$/i.test(message.importance||'');
  const flight=svgEl('g',{
    class:'orrery-comet-flight'+(important?' important':''),
  });
  const tail=svgEl('ellipse',{class:'orrery-comet-tail',cx:large?-16:-7,cy:0,
    rx:large?20:9,ry:large?3.2:1.45});
  const halo=svgEl('circle',{class:'orrery-comet-halo',cx:0,cy:0,r:large?10:4.8});
  const head=svgEl('circle',{class:'orrery-comet',cx:0,cy:0,r:large?(important?6:4.5):(important?2.9:2.1)});
  flight.append(tail,halo,head);
  if(large){
    const label=svgEl('text',{
      class:'orrery-comet-label',x:10,y:-8,
    });
    /* textContent is the escape boundary for untrusted mail subjects. */
    label.textContent=subjectLabel(message.subject);
    flight.appendChild(label);
  }
  target.appendChild(flight);
  const duration=700;
  return new Promise(resolve=>{
    let started=null;
    function frame(now){
      if(started===null)started=now;
      const progress=Math.min(1,(now-started)/duration);
      const eased=progress<.5
        ?4*progress*progress*progress
        :1-Math.pow(-2*progress+2,3)/2;
      const curve=commPathBetween(
        from,to,positions,large&&planetMotion
          ?planetMotion.layoutDimensions||PLANET:miniMotion.layoutDimensions||MINI,
        (large?planetMotion:miniMotion)?.spawnPairs);
      const point=curve.point(eased);
      const envelope=cometEnvelope(progress);
      const ahead=curve.point(Math.min(1,eased+.01)),behind=curve.point(Math.max(0,eased-.01));
      const angle=Math.atan2(ahead.y-behind.y,ahead.x-behind.x)*180/Math.PI;
      flight.setAttribute('transform',`translate(${point.x} ${point.y}) scale(${envelope.scale})`);
      flight.style.opacity=String(envelope.opacity);
      tail.setAttribute('transform',`rotate(${angle})`);
      tail.style.opacity=String(envelope.tailOpacity);
      if(progress<1)requestAnimationFrame(frame);
      else{flight.remove();resolve();}
    }
    requestAnimationFrame(frame);
  });
}
function cometEnvelope(t){
  t=Math.max(0,Math.min(1,t));
  const smooth=x=>x*x*(3-2*x);
  const opacity=smooth(Math.min(1,t/.15))*(1-smooth(Math.max(0,(t-.82)/.18)));
  return {opacity,scale:t<=.5?1+.6*smooth(t/.5):1.6-.8*smooth((t-.5)/.5),
    tailOpacity:opacity*(.2+.8*Math.sin(Math.PI*t))};
}
function launchComet(message,toName){
  const fromName=senderName(message);
  if(!fromName||!miniPositions.has(fromName)||!miniPositions.has(toName))return;
  if(activeComets>=MAX_COMETS)return;
  activeComets+=1;
  const animations=[
    animateComet(miniSvg,miniPositions,fromName,toName,message,false),
  ];
  if(planetarium&&planetarium.classList.contains('on')&&
     planetPositions.has(fromName)&&planetPositions.has(toName)){
    animations.push(animateComet(
      planetSvg,planetPositions,fromName,toName,message,true));
  }
  Promise.all(animations).finally(()=>{activeComets=Math.max(0,activeComets-1);});
}
function receiveMail(messages){
  recordMessages(messages);
  renderMini();
  renderPlanetarium();
  const flights=[];
  (messages||[]).forEach(message=>{
    recipientNames(message).forEach(recipient=>flights.push([message,recipient]));
  });
  requestAnimationFrame(()=>{
    flights.forEach(([message,recipient])=>launchComet(message,recipient));
  });
}

document.addEventListener('oc:agents',event=>{
  liveAgents=(event.detail&&event.detail.agents)||[];
  const liveNames=new Set(liveAgents.map(agent=>agent.name));
  observedConnections.forEach((pair,key)=>{
    if(liveNames.has(pair.a)&&liveNames.has(pair.b))pair.confirmed=true;
    else if(pair.confirmed||Date.now()-pair.observedAt>=MAIL_EDGE_LIFETIME)observedConnections.delete(key);
  });
  renderMini();
  renderPlanetarium();
});
document.addEventListener('oc:graph',()=>{
  renderMini();
  renderPlanetarium();
});
document.addEventListener('oc:mail',event=>
  receiveMail(event.detail&&event.detail.messages));
document.addEventListener('oc:focus-agent',event=>{
  miniFocusName=event.detail&&event.detail.name||'';
  if(miniMode==='network')renderMini();
});
document.addEventListener('oc:stage-agent',syncMiniSelection);
document.addEventListener('oc:mini-view',event=>{
  const detail=event.detail||{};
  miniMode=detail.mode==='network'?'network':'orrery';
  miniNetworkDepth=[1,2,3].includes(Number(detail.depth))?Number(detail.depth):2;
  miniFocusName=OC.activeAgent&&OC.activeAgent()||miniFocusName;
  renderMini();
});
window.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&planetarium&&planetarium.classList.contains('on')){
    event.preventDefault();
    event.stopImmediatePropagation();
    closePlanetarium();
  }
},true);

/* The planetarium was only reachable from a bare ⤢ glyph tucked into the
   corner of the rail, which is not a legible way to say "show me the whole
   forest" — the lineage view is the thing people actually want back once a
   pane is open, and they could not find their way to it. Expose it so the
   header can offer it by name. */
window.OrreryRail={openPlanetarium,closePlanetarium,
  planetariumOpen:()=>Boolean(planetarium&&planetarium.classList.contains('on'))};

recordMessages(OC.mailBacklog&&OC.mailBacklog());
installMiniGraphDivider();
renderMini();
new ResizeObserver(()=>{
  const width=miniSvg.clientWidth,height=miniSvg.clientHeight;
  if(width&&height&&(width!==miniWidth||height!==miniHeight))renderMini();
}).observe(miniSvg);
seedRecentMail();
})();
