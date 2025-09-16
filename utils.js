// utils.js
export const NS = 'SDFGridModule.v1.';
export const SS_UID = NS + 'session.uid';
export const LS_REG = NS + 'registry';

export function logicKey(uid){ return NS + 'logic.' + uid; }
export function stateKey(uid){ return NS + 'state.' + uid; }
export function blobsKey(uid){ return NS + 'blobArray.' + uid; }

export function safeNum(n, alt){ return (typeof n === 'number' && !isNaN(n)) ? n : alt; }
export function clamp(v,min,max){ return v<min?min:(v>max?max:v); }

export function generateUID(){
  return 'sgm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,8);
}

export function lsSet(key, obj){ try{ localStorage.setItem(key, JSON.stringify(obj)); }catch(e){ console.warn('LS set failed:', e.message); } }
export function lsGet(key){ try{ const s=localStorage.getItem(key); return s?JSON.parse(s):null; }catch(e){ console.warn('LS get failed:', e.message); return null; } }
export function lsRemove(key){ try{ localStorage.removeItem(key); }catch(e){ console.warn('LS remove failed:', e.message); } }

export function getRegistry(){ return lsGet(LS_REG) || []; }
export function setRegistry(reg){ lsSet(LS_REG, reg); }
export function ensureInRegistry(uid){
  const reg = getRegistry();
  if (!reg.some(r => r.uid===uid)){ reg.push({ uid, createdAt: Date.now(), lastSavedAt: null }); setRegistry(reg); }
}
export function updateRegistrySaved(uid){
  const reg = getRegistry();
  const r = reg.find(r=>r.uid===uid);
  if (r){ r.lastSavedAt = Date.now(); setRegistry(reg); }
}

export function resolveUID(){
  const p = new URLSearchParams(location.search);
  const urlUID = p.get('uid');
  if (urlUID){ sessionStorage.setItem(SS_UID, urlUID); ensureInRegistry(urlUID); return urlUID; }
  const existing = sessionStorage.getItem(SS_UID);
  if (existing){ ensureInRegistry(existing); return existing; }
  const created = generateUID();
  sessionStorage.setItem(SS_UID, created);
  ensureInRegistry(created);
  return created;
}

export function sanitizeCode(s){
  if (!s) return '';
  return s.replace(/^\uFEFF/, '')
          .replace(/[\u00A0\u200B-\u200D\u2060\uFEFF]/g, ' ')
          .replace(/\u2018|\u2019/g,"'")
          .replace(/\u201C|\u201D/g,'"');
}

export function createRandomQuaternion(){
  const u1=Math.random(), u2=Math.random(), u3=Math.random();
  const s1=Math.sqrt(1-u1), s2=Math.sqrt(u1);
  return new THREE.Quaternion(
    s1*Math.sin(2*Math.PI*u2),
    s1*Math.cos(2*Math.PI*u2),
    s2*Math.sin(2*Math.PI*u3),
    s2*Math.cos(2*Math.PI*u3)
  );
}
