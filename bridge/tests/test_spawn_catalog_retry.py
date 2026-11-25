"""A slow catalog survives polling timeouts, and the open picker recovers itself."""
import asyncio
import json
import subprocess
import sys
from pathlib import Path

import pytest

from aiohttp import ClientSession, ClientTimeout, web
from aiohttp.test_utils import TestClient, TestServer

from test_cockpit_tour import tour_browser

BRIDGE=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(BRIDGE))
import orrery_backend as ob


def node(body):
    script=f"const Loader=require({json.dumps(str(BRIDGE/'spawn_catalog_loader.js'))});\n"
    script+='(async()=>{'+body+'})().catch(e=>{console.error(e);process.exitCode=1;});'
    return json.loads(subprocess.run(['node','-e',script],check=True,capture_output=True,text=True).stdout)


def test_catalog_retries_with_spacing_then_polls_and_recovers_without_a_click():
    result=node('''
      const states=[],timers=[];let mode='fail',calls=0;
      const data={providers:[{id:'live',models:['from-telemetry']}]};
      const loader=Loader.create({isOpen:()=>true,onState:s=>states.push(s),
        fetchCatalog:async()=>{calls++;if(mode==='fail')throw Error('busy');return data;},
        setTimer:(fn,delay)=>{const task={fn,delay};timers.push(task);return task;},clearTimer:()=>{}});
      await loader.refresh();const initial=states.at(-1).status;
      const delays=[];for(let i=0;i<4;i++){const t=timers.shift();delays.push(t.delay);await t.fn();}
      const unavailable=states.at(-1).status;mode='ready';const t=timers.shift();delays.push(t.delay);await t.fn();
      console.log(JSON.stringify({initial,unavailable,delays,calls,final:states.at(-1),timers:timers.length}));
    ''')
    assert result['initial']=='loading' and result['unavailable']=='unavailable'
    assert result['delays']==[1000,3000,8000,30000,30000]
    assert result['final']['status']=='ready' and result['final']['catalog']['providers'][0]['id']=='live'
    assert result['calls']==6 and result['timers']==0


def test_only_a_successful_catalog_is_reused_and_close_discards_late_results():
    result=node('''
      const states=[],timers=[];let mode='good',resolveOld;
      const good={providers:[{id:'last-good'}]},newer={providers:[{id:'newer'}]};
      const loader=Loader.create({isOpen:()=>true,onState:s=>states.push(s),
        fetchCatalog:()=>mode==='good'?Promise.resolve(good):mode==='new'?Promise.resolve(newer):mode==='slow'?new Promise(r=>resolveOld=r):Promise.reject(Error('offline')),
        setTimer:(fn,delay)=>{const t={fn,delay};timers.push(t);return t;},clearTimer:t=>timers.splice(timers.indexOf(t),1)});
      await loader.refresh();mode='fail';await loader.refresh();const stale=states.at(-1);
      loader.stop();const stopped=timers.length;mode='slow';const old=loader.refresh();
      await Promise.resolve();const same=loader.refresh()===old;loader.stop();mode='new';await loader.refresh();
      resolveOld({providers:[{id:'obsolete'}]});await old;
      console.log(JSON.stringify({stale,stopped,same,final:states.at(-1)}));
    ''')
    assert result['stale']==dict(status='stale',catalog=dict(providers=[dict(id='last-good')]))
    assert result['stopped']==0 and result['same']
    assert result['final']==dict(status='ready',catalog=dict(providers=[dict(id='newer')]))


def catalog_proxy(monkeypatch,delay,*,timeout=None,clients=1):
    async def run():
        requests=0
        async def handle(request):
            nonlocal requests
            requests+=1
            await asyncio.sleep(delay)
            return web.json_response({'providers':[{'id':'codex','label':'Codex','models':['fixture-current']} ]})
        upstream=web.Application();upstream.router.add_get('/api/spawn-names',handle)
        async with TestServer(upstream) as source,ClientSession(timeout=ClientTimeout(total=.1)) as session:
            monkeypatch.setattr(ob,'DASHBOARD_URL',str(source.make_url('')).rstrip('/'))
            if timeout is not None:monkeypatch.setattr(ob,'CATALOG_PROXY_TIMEOUT',timeout)
            app=web.Application();app[ob.HTTP_SESSION_KEY]=session;app[ob.PROXY_INFLIGHT_KEY]={};app[ob.TMUX_BIN_KEY]='unused'  # Catalog requests never construct or use a tmux transport.
            app.router.add_get('/telemetry/spawn-catalog',ob.proxy_dashboard)
            async with TestClient(TestServer(app)) as client:
                async def ask():
                    async with client.get('/telemetry/spawn-catalog') as response:return response.status,await response.json()
                result=await asyncio.gather(*(ask() for _ in range(clients)))
                return result,requests
    return asyncio.run(run())


def test_catalog_can_take_longer_than_the_previous_six_second_poll_limit(monkeypatch):
    result,requests=catalog_proxy(monkeypatch,6.2)
    assert requests==1 and result[0][0]==200
    assert result[0][1]['providers'][0]['models'][0]['id']=='fixture-current'


def test_catalog_timeout_is_bounded_and_concurrent_dialogs_share_the_fetch(monkeypatch):
    result,requests=catalog_proxy(monkeypatch,.15,timeout=.05,clients=2)
    assert requests==1 and result==[(502,{'error':'dashboard slow'})]*2


def test_open_dialog_automatically_recovers_and_keeps_a_stale_selection(tour_browser):
    _,evaluate=tour_browser
    result=evaluate('''(async()=>{
      const original=window.fetch;let mode='fail',calls=0;
      const catalog={providers:[{id:'codex',label:'Codex',program:'codex-cli',models:[{id:'last-good',default:true}],efforts:['low','high']}],naming:{},dirs:[]};
      window.fetch=async(url,options)=>{
        if(url==='/telemetry/spawn-catalog'){calls++;if(mode==='fail')throw Error('slow fixture');return {ok:true,json:async()=>catalog};}
        if(String(url).startsWith('/telemetry/fs/dirs'))return {ok:true,json:async()=>({path:'/workspace',dirs:[]})};
        return original(url,options);
      };
      try{
        spawnOverlay.classList.add('on');spawnTask.value='Fixture task';await loadSpawnCatalog();
        spawnModelButton.click();
        const loading={listed:modelChoices.querySelectorAll('input').length,disabled:spawnSubmit.disabled,status:spawnStatus.textContent};
        mode='good';await new Promise(r=>setTimeout(r,1150));
        const recovered={model:selModel,disabled:spawnSubmit.disabled,status:spawnStatus.textContent};
        mode='fail';await loadSpawnCatalog();
        const input=effortChoices.querySelector('input');input.focus();
        await new Promise(r=>setTimeout(r,1150));
        const stale={model:selModel,disabled:spawnSubmit.disabled,catalogStale:spawnCatalog.stale,
          same:input===effortChoices.querySelector('input'),focus:document.activeElement===input};
        const before=calls;closeSpawnModal(true);await new Promise(r=>setTimeout(r,1200));
        return {loading,recovered,stale,stopped:calls===before};
      }finally{spawnCatalogLoader.stop();window.fetch=original;}
    })()''')
    assert result['loading']==dict(listed=0,disabled=True,status='')
    assert result['recovered']==dict(model='last-good',disabled=False,status='')
    assert result['stale']==dict(model='last-good',disabled=False,catalogStale=True,same=True,focus=True)
    assert result['stopped']


@pytest.mark.parametrize('change', ['unchanged', 'model', 'harness'])
def test_catalog_refresh_does_not_replace_prepared_route(tour_browser, change):
    _, evaluate = tour_browser
    result = evaluate("""(async()=>{
      const original=window.fetch;let updated=false,posts=0;
      const selected={id:'chosen',harnesses:[
        {id:'codex',available:true,default:true},{id:'dsh',available:true}]};
      window.fetch=async(url,options)=>{
        if(url==='/telemetry/spawn-catalog'){
          const models=[{id:'fallback',default:true,harnesses:[{id:'codex',available:true}]}];
          if(!updated||CHANGE!=='model')models.push(updated&&CHANGE==='harness'?
            {...selected,harnesses:[{id:'codex',available:true}]}:selected);
          return Response.json({providers:[{id:'codex',label:'Codex',models}],naming:{},dirs:[]});
        }
        if(url==='/telemetry/spawn'){posts++;return Response.json({ok:false,error:'unexpected launch'});}
        if(String(url).startsWith('/telemetry/fs/dirs'))return Response.json({path:'/workspace',dirs:[]});
        return original(url,options);
      };
      try{
        openSpawnModal();await loadSpawnCatalog();spawnModelButton.click();
        modelChoices.querySelector('input[value=chosen]').click();
        spawnHarnesses.querySelector('[data-harness=dsh]').click();
        spawnTask.value='Prepared task';updateSpawnAvailability();
        const before={model:selModel,harness:selHarness,blocked:spawnSubmit.disabled};
        updated=true;await loadSpawnCatalog();
        const after={model:selModel,harness:selHarness,blocked:spawnSubmit.disabled,
          task:spawnTask.value,notice:spawnStatus.textContent};
        if(CHANGE!=='unchanged'){
          await submitSpawn({preventDefault(){}});
          await loadSpawnCatalog();
          const stillBlocked=spawnSubmit.disabled;
          modelChoices.querySelector('input[value=fallback]').click();
          return {before,after,stillBlocked,posts,chosen:selModel,canLaunch:!spawnSubmit.disabled};
        }
        return {before,after,posts};
      }finally{closeSpawnModal();window.fetch=original;}
    })()""".replace('CHANGE', json.dumps(change)))
    assert result['before'] == dict(model='chosen', harness='dsh', blocked=False)
    if change == 'unchanged':
        assert result['after'] == dict(model='chosen', harness='dsh', blocked=False,
                                       task='Prepared task', notice='')
    else:
        assert result['after'] == dict(model=None, harness=None, blocked=True,
                                       task='Prepared task',
                                       notice='Selected model or harness is no longer available. Choose again.')
        assert result['stillBlocked'] and result['chosen'] == 'fallback' and result['canLaunch']
    assert result['posts'] == 0


def test_refresh_keeps_grouped_launch_id_and_explicit_effort(tour_browser):
    _, evaluate = tour_browser
    result = evaluate("""(()=>{
      const provider={id:'gemini',label:'Antigravity',program:'antigravity',
        capabilities:{effort_required:true},efforts:['low','high'],
        models:[{id:'fixture-high',default:true}]};
      spawnCatalog={providers:[provider],naming:{},dirs:[]};
      selFamily='gemini';selProvider=null;selModel=null;selHarness=null;
      selUrlIndex=null;selUrlKey=null;selEffort=null;renderProviderTabs();
      spawnTask.value='Prepared task';
      const range=effortChoices.querySelector('input[type=range]');
      range.value=0;range.dispatchEvent(new Event('input'));
      provider.models.unshift({id:'fixture-low'});
      renderProviderTabs(true);
      return {model:selModel,effort:selEffort,blocked:spawnSubmit.disabled,
        shown:[...modelChoices.querySelectorAll('input')].map(e=>[e.value,e.checked]),
        payload:spawnPayloadFromForm()};
    })()""")
    assert result['model'] == 'fixture-high' and result['effort'] == 'low'
    assert not result['blocked'] and result['shown'] == [['fixture-high', True]]
    assert (result['payload']['model'],result['payload']['effort']) == ('fixture-high','low')


def test_refresh_refuses_dynamic_endpoint_identity_downgrade(tour_browser):
    _, evaluate = tour_browser
    result = evaluate("""(()=>{
      const row={id:'shared-model',url_index:0,url_key:'a'.repeat(64),
        harnesses:[{id:'hermes',available:true}]};
      const provider={id:'workstation',locality:'local',dynamic_models:true,models:[row]};
      spawnCatalog={providers:[provider],naming:{},dirs:[]};
      selFamily='local';selProvider=null;selModel=null;selHarness=null;
      selUrlIndex=null;selUrlKey=null;renderProviderTabs();
      modelChoices.querySelector('input').click();
      spawnTask.value='Prepared task';updateSpawnAvailability();
      const before=spawnPayloadFromForm();
      provider.models=[{id:'shared-model',url_index:0,harnesses:row.harnesses}];
      renderProviderTabs(true);
      return {before,blocked:spawnSubmit.disabled,model:selModel,notice:spawnStatus.textContent};
    })()""")
    assert result['before']['url_index'] == 0 and result['before']['url_key'] == 'a'*64
    assert result['blocked'] and result['model'] is None
    assert result['notice'] == 'Selected model or harness is no longer available. Choose again.'
