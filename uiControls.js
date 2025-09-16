// uiControls.js
import { NS, SS_UID, LS_REG, generateUID, getRegistry, setRegistry, ensureInRegistry, resolveUID, sanitizeCode } from './utils.js';
import { presetCode } from './logicPresets.js';
import { modulesByUID, ensureModule, reloadAllUIDs, clearRegistry, updateVisibility } from './moduleManager.js';

export function buildUI(rootEl){
  rootEl.innerHTML = `
    <h2>Unified Scene (all UIDs)</h2>
    <div class="row">
      <label style="flex: 1 1 55%">Active UID
        <select id="uidSelect" class="mono"></select>
      </label>
      <button id="btnPrevUID" title="Previous UID">◀</button>
      <button id="btnNextUID" title="Next UID">▶</button>
    </div>
    <div class="row"><div id="uidBox" class="mono" style="flex:1 1 auto"></div></div>
    <div class="row" style="margin-top:6px">
      <button id="btnCopyUID" class="btn-ok" title="Copy active UID">Copy</button>
      <button id="btnOpenWithUID" title="Open new tab bound to active UID">Open Link</button>
      <button id="btnNewUID" class="btn-warn" title="Create new UID and make it active here">New UID</button>
    </div>
    <div class="row" style="margin-top:6px">
      <label><input type="checkbox" id="chkShowOthers" checked> Show other grids</label>
      <label><input type="checkbox" id="chkSync" checked> Live sync</label>
      <label><input type="checkbox" id="chkAllAffect" checked> All grids affect particles</label>
      <label><input type="checkbox" id="chkHideActive"> Hide active grid <span class="kbd">H</span></label>
    </div>
    <hr style="border-color:#30363d; opacity:.5">
    <div class="row">
      <label>Grid Width<input type="number" id="gridWidth" value="10" min="1" step="0.1"></label>
      <label>Grid Height<input type="number" id="gridHeight" value="10" min="1" step="0.1"></label>
      <label>Grid Depth<input type="number" id="gridDepth" value="10" min="1" step="0.1"></label>
    </div>
    <div class="row">
      <label>Cells X<input type="number" id="cellsX" value="10" min="1" max="50"></label>
      <label>Cells Y<input type="number" id="cellsY" value="10" min="1" max="50"></label>
      <label>Cells Z<input type="number" id="cellsZ" value="3" min="1" max="50"></label>
      <label>Fidelity<input type="number" id="fidelity" value="3" min="1" max="8"></label>
    </div>
    <div class="row">
      <label>Num Particles<input type="number" id="numParticles" value="100" min="0"></label>
      <label>Grid Pos X<input type="number" id="gridPosX" value="0" step="0.1"></label>
      <label>Grid Pos Y<input type="number" id="gridPosY" value="0" step="0.1"></label>
      <label>Grid Pos Z<input type="number" id="gridPosZ" value="0" step="0.1"></label>
    </div>
    <label>Shape<select id="shapeSelect"><option value="cube">Cube</option><option value="sphere">Sphere</option><option value="custom" selected>Custom SVG</option></select></label>
    <label>SVG Path<textarea id="svgPath" rows="3" cols="40">[M 0 -1 L 0.3 -0.3 L 1 0 L 0.3 0.3 L 0 1 L -0.3 0.3 L -1 0 L -0.3 -0.3 Z][M 0 -0.8 L 0.24 -0.24 L 0.8 0 L 0.24 0.24 L 0 0.8 L -0.24 0.24 L -0.8 0 L -0.24 -0.24 Z][M 0 -0.6 L 0.18 -0.18 L 0.6 0 L 0.18 0.18 L 0 0.6 L -0.18 0.18 L -0.6 0 L -0.18 -0.18 Z]</textarea></label>
    <div class="btns">
      <button id="btnUpdate" class="btn-ok">Update Active Grid</button>
      <button id="btnUpdatePos">Update Active Position</button>
      <button id="btnSaveLS" class="btn-ok">Save Active</button>
      <button id="btnLoadLS" class="btn-warn">Load Active</button>
      <button id="btnClearLS" class="btn-bad">Clear Active</button>
      <button id="btnExportJSON">Export Active JSON</button>
      <button id="btnListRegistry">List Registry</button>
      <button id="btnClearRegistry" class="btn-bad">Clear Registry</button>
      <button id="btnReloadAll">Reload All UIDs</button>
    </div>
    <hr style="border-color:#30363d; opacity:.5">
    <details open>
      <summary><strong>Interaction Logic per UID</strong> <span class="note">(program the velocity update; saved to LocalStorage)</span></summary>
      <div class="row">
        <label><input type="checkbox" id="chkUseCustomLogic"> Use custom logic for active UID</label>
      </div>
      <div class="row">
        <label style="flex:1 1 50%">Preset
          <select id="logicPreset">
            <option>Attract</option><option>Repel</option><option>Vortex</option>
            <option>Swirl</option><option>BoundarySpring</option><option>Turbulence</option>
            <option>NoOp</option>
          </select>
        </label>
        <label style="flex:1 1 50%">Force Scale
          <input type="number" id="forceScale" value="1.0" step="0.1" />
        </label>
      </div>
      <label>Logic Function <span class="note">(edit and Compile → Save)</span>
        <textarea id="logicCode" rows="12" class="mono"></textarea>
      </label>
      <div class="btns">
        <button id="btnPresetToEditor">Preset → Editor</button>
        <button id="btnCompileLogic" class="btn-ok">Compile</button>
        <button id="btnSaveLogic" class="btn-ok">Save</button>
        <button id="btnLoadLogic" class="btn-warn">Load</button>
        <button id="btnResetLogic" class="btn-bad">Reset to Preset</button>
      </div>
      <div class="note" id="logicStatus"></div>
    </details>
    <details style="margin-top:8px"><summary>UIDs present</summary><div id="uidList" class="mono"></div></details>
    <div id="log" class="note"></div>
  `;

  // Simple log
  function log(msg){
    const el=document.getElementById('log');
    const line=(typeof msg==='string')?msg:JSON.stringify(msg);
    el.textContent='['+new Date().toLocaleTimeString()+'] '+line+'\n'+el.textContent;
    try{ console.log(msg); }catch(_){}
  }
  function setStatus(text, ok){ const s=document.getElementById('logicStatus'); s.textContent=text; s.className='note ' + (ok?'ok':'err'); }

  // State
  let ACTIVE_UID = resolveUID();
  const uidBox=document.getElementById('uidBox');
  const uidSelect=document.getElementById('uidSelect');
  uidBox.textContent=ACTIVE_UID;

  // Bus for multi-tabs
  let bus=null;
  try{
    bus = new BroadcastChannel('SGM_BUS');
    bus.onmessage = (ev)=>{
      if (!document.getElementById('chkSync').checked) return;
      const data=ev.data||{}; const {type, uid} = data;
      if (type==='stateSaved' || type==='blobsSaved' || type==='newUID' || type==='clearUID' || type==='clearRegistry' || type==='logicSaved'){
        if (type==='clearRegistry'){ for(const id in modulesByUID) delete modulesByUID[id]; reloadAllUIDs(window.__SG_SCENE); renderUIDList(); renderUIDSelect(); return; }
        if (type==='clearUID' && modulesByUID[uid]){ modulesByUID[uid].dispose(); delete modulesByUID[uid]; renderUIDList(); renderUIDSelect(); return; }
        ensureModule(uid, window.__SG_SCENE, null, true); renderUIDList(); renderUIDSelect();
      }
    };
  }catch(e){ log('BroadcastChannel unavailable: '+e.message); }
  function busEmit(msg){ try{ bus && bus.postMessage(msg); }catch(_){ } }

  function renderUIDList(){
    const reg=getRegistry(); const box=document.getElementById('uidList');
    if (!reg.length){ box.textContent='(none)'; return; }
    box.textContent = reg.map(r => `${r.uid} — created ${new Date(r.createdAt).toLocaleString()}${r.lastSavedAt?(' — saved '+new Date(r.lastSavedAt).toLocaleString()):''}`).join('\n');
  }
  function renderUIDSelect(){
    const reg=getRegistry();
    uidSelect.innerHTML='';
    reg.forEach(r=>{ const opt=document.createElement('option'); opt.value=r.uid; opt.textContent=r.uid; uidSelect.appendChild(opt); });
    if (reg.length && !reg.some(r=>r.uid===ACTIVE_UID)){ ACTIVE_UID=reg[0].uid; }
    uidSelect.value=ACTIVE_UID; uidBox.textContent=ACTIVE_UID;
  }

  // Visibility toggles
  function applyVisibility(){
    updateVisibility(
      ACTIVE_UID,
      document.getElementById('chkShowOthers').checked,
      document.getElementById('chkHideActive').checked
    );
  }

  // Handlers
  document.getElementById('chkShowOthers').addEventListener('change', applyVisibility);
  document.getElementById('chkHideActive').addEventListener('change', applyVisibility);

  uidSelect.addEventListener('change', ()=>{
    ACTIVE_UID = uidSelect.value;
    sessionStorage.setItem(SS_UID, ACTIVE_UID);
    applyVisibility(); refreshActiveUIFromModule();
  });
  document.getElementById('btnPrevUID').addEventListener('click', ()=>{
    const reg=getRegistry(); if (!reg.length) return;
    const idx = reg.findIndex(r=>r.uid===ACTIVE_UID);
    const prev = (idx<=0) ? reg.length-1 : idx-1;
    ACTIVE_UID = reg[prev].uid; sessionStorage.setItem(SS_UID, ACTIVE_UID);
    applyVisibility(); refreshActiveUIFromModule();
  });
  document.getElementById('btnNextUID').addEventListener('click', ()=>{
    const reg=getRegistry(); if (!reg.length) return;
    const idx = reg.findIndex(r=>r.uid===ACTIVE_UID);
    const next = (idx+1) % reg.length;
    ACTIVE_UID = reg[next].uid; sessionStorage.setItem(SS_UID, ACTIVE_UID);
    applyVisibility(); refreshActiveUIFromModule();
  });
  document.getElementById('btnCopyUID').addEventListener('click', ()=>{ navigator.clipboard.writeText(ACTIVE_UID); log('UID copied'); });
  document.getElementById('btnOpenWithUID').addEventListener('click', ()=>{ const url=new URL(location.href); url.searchParams.set('uid', ACTIVE_UID); window.open(url.toString(), '_blank', 'noopener'); });
  document.getElementById('btnNewUID').addEventListener('click', ()=>{
    const newUID=generateUID(); sessionStorage.setItem(SS_UID, newUID); ensureInRegistry(newUID);
    busEmit({type:'newUID', uid:newUID}); ACTIVE_UID=newUID; ensureModule(ACTIVE_UID, window.__SG_SCENE, null, true);
    applyVisibility(); refreshActiveUIFromModule(); renderUIDList(); renderUIDSelect();
  });

  document.getElementById('btnUpdate').addEventListener('click', ()=>{
    const mod = modulesByUID[ACTIVE_UID]; if (!mod) return;
    const params = {
      gridWidth: parseFloat(document.getElementById('gridWidth').value),
      gridHeight: parseFloat(document.getElementById('gridHeight').value),
      gridDepth: parseFloat(document.getElementById('gridDepth').value),
      cellsX: parseInt(document.getElementById('cellsX').value,10),
      cellsY: parseInt(document.getElementById('cellsY').value,10),
      cellsZ: parseInt(document.getElementById('cellsZ').value,10),
      fidelity: parseInt(document.getElementById('fidelity').value,10),
      shapeType: document.getElementById('shapeSelect').value,
      customSVGPath: document.getElementById('svgPath').value.trim()
    };
    mod.updateGrid(params);
    busEmit({type:'stateSaved', uid:ACTIVE_UID});
  });
  document.getElementById('btnUpdatePos').addEventListener('click', ()=>{
    const mod = modulesByUID[ACTIVE_UID]; if (!mod) return;
    const posX=parseFloat(document.getElementById('gridPosX').value);
    const posY=parseFloat(document.getElementById('gridPosY').value);
    const posZ=parseFloat(document.getElementById('gridPosZ').value);
    mod.updatePosition(new THREE.Vector3(posX,posY,posZ));
    busEmit({type:'stateSaved', uid:ACTIVE_UID});
  });
  document.getElementById('btnSaveLS').addEventListener('click', ()=>{ const m=modulesByUID[ACTIVE_UID]; if(m){ m.saveState(); m.saveBlobs(); busEmit({type:'stateSaved', uid:ACTIVE_UID}); busEmit({type:'blobsSaved', uid:ACTIVE_UID}); } });
  document.getElementById('btnLoadLS').addEventListener('click', ()=>{ ensureModule(ACTIVE_UID, window.__SG_SCENE, null, true); refreshActiveUIFromModule(); });
  document.getElementById('btnClearLS').addEventListener('click', ()=>{
    localStorage.removeItem(NS+'state.'+ACTIVE_UID);
    localStorage.removeItem(NS+'blobArray.'+ACTIVE_UID);
    localStorage.removeItem(NS+'logic.'+ACTIVE_UID);
    busEmit({type:'clearUID', uid:ACTIVE_UID});
    ensureModule(ACTIVE_UID, window.__SG_SCENE, null, true); renderUIDList(); renderUIDSelect(); log('Cleared active UID');
  });
  document.getElementById('btnExportJSON').addEventListener('click', ()=>{
    const S = modulesByUID[ACTIVE_UID] ? modulesByUID[ACTIVE_UID].toStateJSON() : null;
    const st = S || null;
    const bl = (window.SDFGrid && window.SDFGrid.loadBlobs)? window.SDFGrid.loadBlobs(ACTIVE_UID) : null;
    const lg = (modulesByUID[ACTIVE_UID] ? modulesByUID[ACTIVE_UID].logic : null);
    const payload = { uid: ACTIVE_UID, state: st, blobs: bl, logic: lg, registry: getRegistry() };
    const blob = new Blob([JSON.stringify(payload,null,2)], {type:'application/json'});
    const url = URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='sdf_grid_state_'+ACTIVE_UID+'.json'; a.click(); URL.revokeObjectURL(url);
  });
  document.getElementById('btnListRegistry').addEventListener('click', ()=>{ log(getRegistry()); });
  document.getElementById('btnClearRegistry').addEventListener('click', ()=>{ clearRegistry(); renderUIDList(); renderUIDSelect(); log('Registry cleared'); });
  document.getElementById('btnReloadAll').addEventListener('click', ()=>{ reloadAllUIDs(window.__SG_SCENE); applyVisibility(); refreshActiveUIFromModule(); });

  // Logic editor
  document.getElementById('btnPresetToEditor').addEventListener('click', ()=>{
    const mod = modulesByUID[ACTIVE_UID]; if (!mod) return;
    const preset=document.getElementById('logicPreset').value;
    const code=presetCode(preset);
    document.getElementById('logicCode').value=code;
    mod.logic.preset=preset;
  });
  document.getElementById('btnCompileLogic').addEventListener('click', ()=>{
    const mod = modulesByUID[ACTIVE_UID]; if (!mod) return;
    const src=sanitizeCode(document.getElementById('logicCode').value);
    const ok=mod.compileLogic(src);
    if (ok){
      try{
        mod.logic.compiled({ p:{position:new THREE.Vector3(), velocity:new THREE.Vector3()}, dt:0, sd:1, inside:false, grad:new THREE.Vector3(1,0,0), center:new THREE.Vector3(), zIndex:0, uid:mod.uid, forceScale:1, state:mod.state });
        setStatus('Compiled', true);
      }catch(e){ setStatus('Compiled, runtime error: '+(e.message||e), false); }
    } else setStatus('Compile error: '+mod.logic.compileError, false);
    document.getElementById('logicCode').value=src;
  });
  document.getElementById('btnSaveLogic').addEventListener('click', ()=>{
    const mod = modulesByUID[ACTIVE_UID]; if (!mod) return;
    mod.logic.enabled = document.getElementById('chkUseCustomLogic').checked;
    mod.logic.preset = document.getElementById('logicPreset').value;
    mod.logic.forceScale = parseFloat(document.getElementById('forceScale').value)||1;
    mod.logic.code = document.getElementById('logicCode').value;
    mod.saveLogic();
    setStatus('Saved', true);
  });
  document.getElementById('btnLoadLogic').addEventListener('click', ()=>{
    ensureModule(ACTIVE_UID, window.__SG_SCENE, null, true);
    refreshActiveUIFromModule();
    setStatus('Loaded', true);
  });
  document.getElementById('btnResetLogic').addEventListener('click', ()=>{
    const mod = modulesByUID[ACTIVE_UID]; if (!mod) return;
    const preset=document.getElementById('logicPreset').value;
    const code=presetCode(preset);
    document.getElementById('logicCode').value=code;
    mod.compileLogic(code);
    setStatus('Preset code applied', true);
  });
  document.getElementById('chkUseCustomLogic').addEventListener('change', (e)=>{
    const mod = modulesByUID[ACTIVE_UID]; if (!mod) return;
    mod.logic.enabled = e.target.checked;
    mod.saveLogic();
  });
  document.getElementById('forceScale').addEventListener('change', (e)=>{
    const mod = modulesByUID[ACTIVE_UID]; if (!mod) return;
    mod.logic.forceScale = parseFloat(e.target.value)||1;
    mod.saveLogic();
  });

  // Keyboard H toggle
  window.addEventListener('keydown', (e)=>{
    if (e.key==='h' || e.key==='H'){
      const chk=document.getElementById('chkHideActive');
      chk.checked = !chk.checked;
      applyVisibility();
      log('Active grid '+(chk.checked?'hidden':'shown')+' via keyboard');
    }
  });

  function refreshActiveUIFromModule(){
    const m = modulesByUID[ACTIVE_UID]; if (!m) return;
    document.getElementById('gridWidth').value  = m.state.gridWidth;
    document.getElementById('gridHeight').value = m.state.gridHeight;
    document.getElementById('gridDepth').value  = m.state.gridDepth;
    document.getElementById('cellsX').value     = m.state.cellsX;
    document.getElementById('cellsY').value     = m.state.cellsY;
    document.getElementById('cellsZ').value     = m.state.cellsZ;
    document.getElementById('fidelity').value   = m.state.fidelity;
    document.getElementById('shapeSelect').value= m.state.shapeType;
    document.getElementById('svgPath').value    = m.state.customSVGPath;
    document.getElementById('gridPosX').value   = m.position.x;
    document.getElementById('gridPosY').value   = m.position.y;
    document.getElementById('gridPosZ').value   = m.position.z;
    uidBox.textContent = ACTIVE_UID;
    uidSelect.value = ACTIVE_UID;

    document.getElementById('chkUseCustomLogic').checked = !!m.logic.enabled;
    document.getElementById('logicPreset').value = m.logic.preset || 'Attract';
    document.getElementById('forceScale').value = (typeof m.logic.forceScale==='number'?m.logic.forceScale:1).toFixed(2);
    document.getElementById('logicCode').value = m.logic.code || presetCode('Attract');
    setStatus(m.logic.compileError ? ('Compile error: ' + m.logic.compileError) : 'Ready', !m.logic.compileError);
  }

  // Expose helpers for main.js
  return {
    get ACTIVE_UID(){ return ACTIVE_UID; },
    set ACTIVE_UID(v){ ACTIVE_UID=v; sessionStorage.setItem(SS_UID, ACTIVE_UID); applyVisibility(); refreshActiveUIFromModule(); },
    log, renderUIDList, renderUIDSelect, applyVisibility, refreshActiveUIFromModule,
    busEmit
  };
}
