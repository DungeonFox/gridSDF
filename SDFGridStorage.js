// IndexedDB and Storage Bucket helpers for SDFGrid
import { IDB_NAME, IDB_VERSION, STORE_META, STORE_BASE, STORE_LAYER, STORE_LMETA, STORE_BASEZ } from './SDFGridConstants.js';

export async function openBucketLC(nameLC){
  if (!nameLC || !navigator.storageBuckets) return null;
  return navigator.storageBuckets.open(nameLC);
}

export function openFieldDB(bucket){
  return new Promise((res,rej)=>{
    const req=bucket.indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded=e=>{
      const db=e.target.result;
      if (!db.objectStoreNames.contains(STORE_META))  db.createObjectStore(STORE_META);
      if (!db.objectStoreNames.contains(STORE_BASE))  db.createObjectStore(STORE_BASE);
      if (!db.objectStoreNames.contains(STORE_LAYER)) db.createObjectStore(STORE_LAYER);
      if (!db.objectStoreNames.contains(STORE_LMETA)) db.createObjectStore(STORE_LMETA);
      if (!db.objectStoreNames.contains(STORE_BASEZ)) db.createObjectStore(STORE_BASEZ);
    };
    req.onsuccess=()=>res(req.result);
    req.onerror =()=>rej(req.error);
  });
}

export function idbGet(db,store,key){
  return new Promise((res,rej)=>{
    const tx=db.transaction(store,'readonly'), st=tx.objectStore(store);
    const rq=st.get(key); rq.onsuccess=()=>res(rq.result ?? null); rq.onerror=()=>rej(rq.error);
  });
}

export function idbPut(db,store,key,val){
  return new Promise((res,rej)=>{
    const tx=db.transaction(store,'readwrite'), st=tx.objectStore(store);
    const rq=st.put(val,key); rq.onsuccess=()=>res(true); rq.onerror=()=>rej(rq.error);
  });
}

export function idbDelete(db,store,key){
  return new Promise((res,rej)=>{
    const tx=db.transaction(store,'readwrite'), st=tx.objectStore(store);
    const rq=st.delete(key); rq.onsuccess=()=>res(true); rq.onerror=()=>rej(rq.error);
  });
}

const QUADRANT_WRITE_RETRIES = 3;

export async function loadQuadrantRecord(db, layerIndex, quadrantIndex){
  if (!db) return { buffer:null, key:null };
  const primaryKey = `${layerIndex},${quadrantIndex}`;
  let buffer = await idbGet(db, STORE_LAYER, primaryKey);
  if (buffer) return { buffer, key:primaryKey };

  const numericKey = [layerIndex, quadrantIndex];
  try {
    const legacy = await idbGet(db, STORE_LAYER, numericKey);
    if (legacy){
      await idbPut(db, STORE_LAYER, primaryKey, legacy);
      await idbDelete(db, STORE_LAYER, numericKey);
      return { buffer:legacy, key:primaryKey };
    }
  } catch (err) {
    // Ignore migration failures; caller will treat as missing
  }

  return { buffer:null, key:primaryKey };
}

export async function persistQuadrantRecord(db, layerIndex, quadrantIndex, source, retries = QUADRANT_WRITE_RETRIES){
  if (!db || !source) return false;

  let payload;
  if (source instanceof ArrayBuffer){
    payload = source;
  } else if (source?.buffer instanceof ArrayBuffer){
    const view = source;
    if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength){
      payload = view.buffer;
    } else {
      payload = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
    }
  }

  if (!payload) return false;

  const expectedBytes = payload.byteLength || source.byteLength || 0;
  const key = `${layerIndex},${quadrantIndex}`;

  for (let attempt=0; attempt<retries; attempt++){
    try {
      await idbPut(db, STORE_LAYER, key, payload);
      const verify = await idbGet(db, STORE_LAYER, key);
      const actualBytes = verify instanceof ArrayBuffer
        ? verify.byteLength
        : (verify?.byteLength ?? (verify?.buffer?.byteLength ?? 0));
      if (actualBytes === expectedBytes) return true;
    } catch (err) {
      // Retry below
    }
    await new Promise(res=>setTimeout(res,0));
  }

  if (typeof console !== 'undefined' && console?.warn){
    console.warn('[SDFGrid] Failed to persist quadrant', layerIndex, quadrantIndex);
  }
  return false;
}
