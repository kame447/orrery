/* Catalog-only model choices. No local server inventory is invented here. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.SpawnPicker=api;
})(typeof globalThis!=='undefined'?globalThis:this,()=>{
  const HARNESS={
    'claude-code':{label:'Claude Code',asset:'anthropic.svg'},
    codex:{label:'Codex',asset:'openai.svg'},
    hermes:{label:'Hermes',asset:'hermes.png'},
    dsh:{label:'dsh',asset:'dsh.svg'},
  };
  const INSTALL_GUIDES={
    'claude-code':{name:'Claude Code CLI',url:'https://code.claude.com/docs/en/setup'},
    codex:{name:'Codex CLI',url:'https://github.com/openai/codex'},
    antigravity:{name:'Antigravity CLI (agy)',url:'https://github.com/kame447/orrery-telemetry/blob/master/docs/antigravity.en.md'},
    dsh:{name:'dsh',url:'https://github.com/kame447/orrery-telemetry/blob/master/docs/native-setup.en.md'},
    hermes:{name:'Hermes',url:'https://github.com/kame447/orrery-telemetry/blob/master/docs/native-setup.en.md'},
  };
  function harnessKey(id){
    const key=String(id||'').trim().toLowerCase().split('/').pop();
    return ({claude:'claude-code',claudecode:'claude-code','codex-cli':'codex','dsh-tui':'dsh'})[key]||key;
  }
  function harnessInfo(id){return HARNESS[harnessKey(id)]||{label:id,asset:null};}
  function guideFor(harness){
    const key=harnessKey(harness?.id);
    const id=key==='gemini'||key==='agy'?'antigravity':key;
    return Object.hasOwn(INSTALL_GUIDES,id)?INSTALL_GUIDES[id]:null;
  }
  function setupGuide(harness){
    const guide=guideFor(harness);
    return guide&&{label:guide.name+' setup',url:guide.url};
  }
  function needsRuntimeSetup(reason){
    return ['runtime_not_prepared','plain_generation_required','runtime_version_mismatch',
      'thin_config_unavailable'].includes(reason);
  }
  function unavailableReason(harness){
    if(harness&&harness.available)return '';
    const guide=guideFor(harness);
    if(guide&&needsRuntimeSetup(harness.reason))return 'Install or repair '+guide.name;
    const messages={
      runtime_not_prepared:'Install or repair this harness',
      credential_reader_unavailable:'Prepare the OS key store',
      disabled_by_opt_in:'Enable this harness in setup',
      unsupported_credential_store:'Use the supported OS key store',
      unsupported_mode:'Unavailable in this Mail mode',
      unsupported_platform:'Unavailable on this OS',
      harness_not_enabled:'Enable the connection settings',
      model_mismatch:'Check the configured model',
    };
    const reason=harness&&harness.reason;
    return Object.hasOwn(messages,reason)?messages[reason]:'Check setup and compatibility';
  }
  function locality(provider,model){return (model&&model.locality||provider.locality)==='local'?'local':'cloud';}
  function family(provider,model){
    if(locality(provider,model)==='local')return 'local';
    const key=String(model&&model.provider||provider.id||'').toLowerCase();
    if(['claude','anthropic','claude-code'].includes(key))return 'claude';
    if(['codex','openai','codex-cli'].includes(key))return 'codex';
    if(key.includes('deepseek'))return 'deepseek';
    return key;
  }
  function entries(catalog){return (catalog.providers||[]).flatMap(provider=>(provider.models||[])
    .filter(model=>model&&model.id).map(model=>({provider,model,key:JSON.stringify([provider.id,model.id,
      ...(Number.isInteger(model.url_index)?[model.url_index]:[]),...(model.url_key?[model.url_key]:[])]),family:family(provider,model)})));}
  function value(provider,model,key){return model&&Object.hasOwn(model,key)?model[key]:provider[key];}
  // Effort-qualified catalog IDs are launch IDs, not separate model families.
  // Keep the original ID in each visible entry so the launch path stays valid.
  function modelLabel(provider,model){
    const id=String(model&&model.id||'');
    if(!(provider&&provider.capabilities&&provider.capabilities.effort_required))return id;
    for(const effort of Array.isArray(provider.efforts)?provider.efforts:[]){
      if(typeof effort!=='string'||!effort)continue;
      const suffix='-'+effort;
      if(id.length>suffix.length&&id.endsWith(suffix))return id.slice(0,-suffix.length);
    }
    return id;
  }
  function displayModels(provider,models){
    const rows=Array.isArray(models)?models:(provider&&provider.models)||[];
    if(!(provider&&provider.capabilities&&provider.capabilities.effort_required))return rows;
    const seen=new Set();
    return rows.filter(model=>{
      const label=modelLabel(provider,model);
      if(seen.has(label))return false;
      seen.add(label);
      return true;
    });
  }
  function harnesses(provider,model){
    const supplied=value(provider,model,'harnesses');
    const fallback=provider.program||({claude:'claude-code',codex:'codex-cli'})[provider.id]||provider.id;
    const offered=Array.isArray(supplied)?supplied:[{id:fallback,available:true,default:true}];
    const result=offered.filter(h=>h&&h.id).map(h=>({...h,label:h.label||harnessInfo(h.id).label,available:h.available===true}));
    return result;
  }
  function helperModels(provider,model,harness){
    const selected=harnesses(provider,model).find(h=>h.id===harness);
    const list=selected&&Object.hasOwn(selected,'helper_models')?selected.helper_models:value(provider,model,'helper_models');
    return Array.isArray(list)?list.filter(m=>typeof m==='string'||m&&m.id).map(m=>typeof m==='string'?{id:m,label:m}:m):[];
  }
  function metadata(provider,model){
    if(provider.dynamic_models){
      const source=model.context_source||'unreported';
      return [provider.label||provider.id,Number.isInteger(model.url_index)?'URL '+(model.url_index+1):'',
        model.context?Math.round(model.context/1000)+'K context ('+source+')':'Context unreported'].filter(Boolean).join(' · ');
    }
    return ['server','quantization','context'].map(key=>value(provider,model,key)).filter(v=>v!==undefined&&v!==null&&v!=='').join(' / ');
  }
  function recent(storage,key){
    try{const list=JSON.parse(storage.getItem(key)||'[]');return Array.isArray(list)?list.filter(v=>typeof v==='string').slice(0,8):[];}catch(_){return [];}
  }
  function remember(storage,key,entryKey){
    try{storage.setItem(key,JSON.stringify([entryKey,...recent(storage,key).filter(k=>k!==entryKey)].slice(0,8)));}catch(_){}
  }
  function rosterHarness(agent){
    const id=agent.harness||agent.program||agent.cmd||'';
    const key=harnessKey(id),model=String(agent.model_raw||agent.model||'').toLowerCase();
    const local=String(agent.locality||agent.provider||'').toLowerCase()==='local';
    const maker=String(agent.provider||'').toLowerCase();
    if(!local&&((key==='claude-code'&&(['anthropic','claude'].includes(maker)||/claude|opus|sonnet|haiku|fable|mythos/.test(model)))||
       (key==='codex'&&(['openai','codex'].includes(maker)||/gpt|codex/.test(model)))))return null;
    if(!id||agent.category&&agent.category!=='agent')return null;
    return {id:key,...harnessInfo(id)};
  }
  return {harnessKey,harnessInfo,unavailableReason,setupGuide,needsRuntimeSetup,locality,family,entries,value,modelLabel,displayModels,harnesses,helperModels,metadata,recent,remember,rosterHarness};
});
