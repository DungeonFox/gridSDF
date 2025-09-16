import { DENSE_W, DENSE_H, STORE_BASE, STORE_BASEZ, STORE_LAYER, STORE_LMETA, DEFAULT_QUADRANT_COUNT } from './SDFGridConstants.js';
import { arraysEqual } from './SDFGridUtil.js';
import { idbGet, idbPut, idbDelete } from './SDFGridStorage.js';
import { createSparseQuadrants, denseFromQuadrants } from './SDFGridQuadrants.js';

function _quadrantLayout(count){
  const cols=Math.ceil(Math.sqrt(count));
  const rows=Math.ceil(count/cols);
  const qW=Math.ceil(DENSE_W/cols);
  const qH=Math.ceil(DENSE_H/rows);
  return { cols, rows, qW, qH };
}

function _ensureLayout(ctx){
  ctx._quadLayout ||= _quadrantLayout(ctx.quadrantCount || DEFAULT_QUADRANT_COUNT);
  return ctx._quadLayout;
}

function _quadrantIndex(bx, by){
  const { cols, qW, qH } = _ensureLayout(this);
  const col=Math.floor(bx / qW);
  const row=Math.floor(by / qH);
  return row*cols + col;
}

function _sliceQuadrant(arr, qi, F){
  const { cols, qW, qH } = _ensureLayout(this);
  const col=qi%cols, row=Math.floor(qi/cols);
  const xStart=col*qW, yStart=row*qH;
  const xEnd=Math.min(xStart+qW, DENSE_W);
  const yEnd=Math.min(yStart+qH, DENSE_H);
  const qw=xEnd-xStart, qh=yEnd-yStart;
  const out=new Float32Array(qw*qh*F);
  let idx=0;
  for(let y=yStart;y<yEnd;y++){
    const rowBase=y*DENSE_W*F;
    for(let x=xStart;x<xEnd;x++){
      const base=rowBase + x*F;
      for(let fi=0;fi<F;fi++) out[idx++]=arr[base+fi];
    }
  }
  return out;
}

function _insertQuadrant(arr, qi, quad, F){
  const { cols, qW, qH } = _ensureLayout(this);
  const col=qi%cols, row=Math.floor(qi/cols);
  const xStart=col*qW, yStart=row*qH;
  const xEnd=Math.min(xStart+qW, DENSE_W);
  const yEnd=Math.min(yStart+qH, DENSE_H);
  const qw=xEnd-xStart;
  let idx=0;
  for(let y=yStart;y<yEnd;y++){
    const rowBase=y*DENSE_W*F;
    for(let x=xStart;x<xEnd;x++){
      const base=rowBase + x*F;
      for(let fi=0;fi<F;fi++) arr[base+fi]=quad[idx++];
    }
  }
}

function _markDirty(ctx, z, bx, by){
  const qi=_quadrantIndex.call(ctx, bx, by);
  let set=ctx._dirtyLayers.get(z|0);
  if(!set){ set=new Set(); ctx._dirtyLayers.set(z|0,set); }
  set.add(qi);
}

const QUADRANT_WRITE_RETRIES = 3;

function _quadrantStorageKey(zKey, qi){
  return `${zKey},${qi}`;
}

function _bufferLength(val){
  if (!val) return 0;
  if (typeof val.byteLength === 'number') return val.byteLength;
  if (val?.buffer && typeof val.buffer.byteLength === 'number') return val.buffer.byteLength;
  return 0;
}

function _cloneQuadrantPayload(source){
  if (!source) return null;
  if (source instanceof ArrayBuffer) return source;
  if (ArrayBuffer.isView(source)){
    const { buffer, byteOffset, byteLength } = source;
    if (byteOffset===0 && byteLength===buffer.byteLength) return buffer;
    return buffer.slice(byteOffset, byteOffset + byteLength);
  }
  return null;
}

function _bufferToFloat32(buf){
  if (!buf) return null;
  if (buf instanceof Float32Array) return buf;
  if (buf instanceof ArrayBuffer) return new Float32Array(buf);
  if (ArrayBuffer.isView(buf)){
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / Float32Array.BYTES_PER_ELEMENT);
  }
  return null;
}

async function _readLayerQuadrant(zKey, qi){
  if (!this._db) return { buffer:null, key:null, type:null };
  const tupleKey=[zKey, qi];
  try {
    const buf=await idbGet(this._db, STORE_LAYER, tupleKey);
    if (buf) return { buffer:buf, key:tupleKey, type:'tuple' };
  } catch (err) {
    // ignore tuple read errors and fall back
  }
  const strKey=_quadrantStorageKey(zKey, qi);
  try {
    const buf=await idbGet(this._db, STORE_LAYER, strKey);
    if (buf) return { buffer:buf, key:strKey, type:'string' };
  } catch (err) {
    // ignore string read errors
  }
  return { buffer:null, key:null, type:null };
}

async function _persistLayerQuadrant(zKey, qi, source){
  if (!this._db) return false;
  const payload=_cloneQuadrantPayload(source);
  if (!payload) return false;
  const key=_quadrantStorageKey(zKey, qi);
  for (let attempt=0; attempt<QUADRANT_WRITE_RETRIES; attempt++){
    try {
      await idbPut(this._db, STORE_LAYER, key, payload);
      const verify=await idbGet(this._db, STORE_LAYER, key);
      if (_bufferLength(verify) === payload.byteLength) return true;
    } catch (err) {
      // retry
    }
  }
  if (typeof console !== 'undefined' && console?.warn){
    console.warn('[SDFGrid] Failed to persist quadrant', zKey, qi);
  }
  return false;
}

async function _ensureLayerQuadrant(zKey, qi, handlers, ...args){
  if (!this._db) return null;
  const opts=handlers || {};
  const canonicalKey=_quadrantStorageKey(zKey, qi);
  for (let attempt=0; attempt<QUADRANT_WRITE_RETRIES; attempt++){
    const record=await _readLayerQuadrant.call(this, zKey, qi);
    const existing=record.buffer;
    if (existing){
      if (!opts.update) return existing;
      const ctx={ attempt, zKey, qi, buffer:existing, view:_bufferToFloat32(existing), key:record.key, keyType:record.type, canonicalKey };
      const produced=await opts.update(ctx, ...args);
      if (!produced) return existing;
      const stored=await _persistLayerQuadrant.call(this, zKey, qi, produced);
      if (stored){
        if (record.type==='tuple' && record.key){
          try { await idbDelete(this._db, STORE_LAYER, record.key); } catch (err) { /* ignore cleanup errors */ }
        }
        const updated=await _readLayerQuadrant.call(this, zKey, qi);
        return updated.buffer;
      }
      continue;
    }
    if (!opts.create) return null;
    const ctx={ attempt, zKey, qi, canonicalKey };
    const produced=await opts.create(ctx, ...args);
    if (!produced) return null;
    const stored=await _persistLayerQuadrant.call(this, zKey, qi, produced);
    if (stored){
      const updated=await _readLayerQuadrant.call(this, zKey, qi);
      return updated.buffer;
    }
  }
  const final=await _readLayerQuadrant.call(this, zKey, qi);
  return final.buffer;
}

export async function _ensureZeroTemplate(){
  const count = this.quadrantCount || DEFAULT_QUADRANT_COUNT;
  if (!this._db) return createSparseQuadrants(count, this.envExpressions || []);
  const key=`sid:${this.schema.id}`;
  let tmpl=await idbGet(this._db, STORE_BASEZ, key);
  if (!tmpl){
    tmpl=createSparseQuadrants(count, this.envExpressions || []);
    await idbPut(this._db, STORE_BASEZ, key, tmpl);
  }
  return tmpl;
}

export async function _ensureBaseSDF(z){
  if (!this._db) return null;
  const W=this.state.cellsX, H=this.state.cellsY;
  const key=z|0;
  const buf=await idbGet(this._db, STORE_BASE, key);
  if (buf) return new Int16Array(buf);

  const sx=this.state.gridWidth/W, sy=this.state.gridHeight/H, sz=this.state.gridDepth/this.effectiveCellsZ;
  const halfW=this.state.gridWidth/2, halfH=this.state.gridHeight/2, halfD=this.state.gridDepth/2;
  const arr=new Int16Array(W*H);
  let c=0;
  for(let y=0;y<H;y++){
    for(let x=0;x<W;x++){
      const cx=x*sx+sx/2-halfW + this.position.x;
      const cy=y*sy+sy/2-halfH + this.position.y;
      const cz=z*sz+sz/2-halfD + this.position.z;
      const d=this.sdf(new THREE.Vector3(cx,cy,cz), z);
      const q=Math.max(-32767, Math.min(32767, Math.round(d*1000)));
      arr[y*W+x]=q;
      if ((++c & 0xFFFF)===0) await Promise.resolve();
    }
  }
  await idbPut(this._db, STORE_BASE, key, arr.buffer);
  return arr;
}

export async function getBaseDistance(z,x,y){
  const W=this.state.cellsX,H=this.state.cellsY;
  if(!this._db || x<0||y<0||x>=W||y>=H) return 0;
  const arr=await this._ensureBaseSDF(z);
  return arr ? arr[y*W+x]/1000.0 : 0;
}

export function _denseIdx(F,xPix,yPix,fi){
  return ((yPix*DENSE_W)+xPix)*F + fi;
}

export async function _ensureDenseLayer(z){
  const key=z|0;
  if (this._layerCache.has(key)) return this._layerCache.get(key);

  const targetSchema=this.schema;
  const Fnew=targetSchema.fieldNames.length;

  if (!this._db){
    const arr=new Float32Array(DENSE_W*DENSE_H*Fnew);
    this._layerCache.set(key,arr); return arr;
  }

  const template=await this._ensureZeroTemplate();
  let qCount=this.quadrantCount || DEFAULT_QUADRANT_COUNT;
  const quadTemplate=template?.quadrants;
  if (Array.isArray(quadTemplate) && quadTemplate.length){
    qCount=quadTemplate.length;
    if (this.quadrantCount !== qCount){
      this.quadrantCount=qCount;
      this._quadLayout=null;
    }
  }
  _ensureLayout(this);

  const lmeta=await idbGet(this._db, STORE_LMETA, key);
  const curSid=lmeta?.sid|0;
  const curFields=lmeta?.fields || [];
  const schemaMatches = curSid === targetSchema.id && arraysEqual(curFields, targetSchema.fieldNames);

  const buffers=new Array(qCount);
  const missingIdx=[];
  const migrateIdx=[];
  for (let qi=0; qi<qCount; qi++){
    const rec=await _readLayerQuadrant.call(this, key, qi);
    const buf=rec.buffer;
    buffers[qi]=buf;
    if (!buf) missingIdx.push(qi);
    else if (rec.type==='tuple') migrateIdx.push(qi);
  }

  if (buffers.every(b=>!b)){
    const arr=denseFromQuadrants(template, targetSchema);
    await this._applySparseIntoDense(z, arr);
    for (let qi=0; qi<qCount; qi++){
      const factory=()=>_sliceQuadrant.call(this, arr, qi, Fnew);
      await _ensureLayerQuadrant.call(this, key, qi, { create: factory });
    }
    await idbPut(this._db, STORE_LMETA, key, { sid:targetSchema.id, fields:targetSchema.fieldNames });
    this._layerCache.set(key,arr); return arr;
  }

  if (schemaMatches){
    const needsInit = missingIdx.length>0 || migrateIdx.length>0;
    const arr=needsInit ? denseFromQuadrants(template, targetSchema) : new Float32Array(DENSE_W*DENSE_H*Fnew);

    for (let qi=0; qi<qCount; qi++){
      const buf=buffers[qi]; if(!buf) continue;
      const quad=_bufferToFloat32(buf);
      if (quad) _insertQuadrant.call(this, arr, qi, quad, Fnew);
    }

    if (needsInit){
      for (const qi of missingIdx){
        const factory=()=>_sliceQuadrant.call(this, arr, qi, Fnew);
        await _ensureLayerQuadrant.call(this, key, qi, { create: factory });
      }
      for (const qi of migrateIdx){
        const factory=()=>_sliceQuadrant.call(this, arr, qi, Fnew);
        await _ensureLayerQuadrant.call(this, key, qi, { update: factory });
      }
      await idbPut(this._db, STORE_LMETA, key, { sid:targetSchema.id, fields:targetSchema.fieldNames });
    }

    this._layerCache.set(key,arr); return arr;
  }

  const Fold=curFields.length;
  const oldIdx=new Map(curFields.map((n,i)=>[n,i]));
  const arr=denseFromQuadrants(template, targetSchema);

  for(let qi=0; qi<qCount; qi++){
    const buf=buffers[qi]; if(!buf) continue;
    const quadOld=_bufferToFloat32(buf);
    if (!quadOld) continue;
    const { cols, qW, qH } = this._quadLayout;
    const col=qi%cols, row=Math.floor(qi/cols);
    const xStart=col*qW, yStart=row*qH;
    const xEnd=Math.min(xStart+qW, DENSE_W);
    const yEnd=Math.min(yStart+qH, DENSE_H);
    const qw=xEnd-xStart;
    let idx=0;
    for(let y=yStart;y<yEnd;y++){
      const rowBase=y*DENSE_W*Fnew;
      for(let x=xStart;x<xEnd;x++){
        const baseNew=rowBase + x*Fnew;
        const baseOld=idx*Fold;
        for (const [name, fiNew] of targetSchema.index){
          const fiOld=oldIdx.get(name);
          if (fiOld!=null) arr[baseNew+fiNew]=quadOld[baseOld+fiOld];
        }
        idx++;
      }
    }
  }

  for (let qi=0; qi<qCount; qi++){
    const factory=()=>_sliceQuadrant.call(this, arr, qi, Fnew);
    await _ensureLayerQuadrant.call(this, key, qi, { create: factory, update: factory });
  }
  await idbPut(this._db, STORE_LMETA, key, { sid:targetSchema.id, fields:targetSchema.fieldNames });
  this._layerCache.set(key,arr); return arr;
}

export async function withLayerQuadrant(z, quadrantIndex, handlers, ...args){
  if (!this._db) return null;
  return _ensureLayerQuadrant.call(this, z|0, quadrantIndex|0, handlers, ...args);
}

export function _mapCellToDense(z, x, y){
  const w=this.state.cellsX, h=this.state.cellsY;
  const nuc=this.getNucleus(z);
  const dx=x - nuc.x;
  const dy=y - nuc.y;
  const sx=DENSE_W / Math.max(1,w);
  const sy=DENSE_H / Math.max(1,h);
  const baseC={ x:(DENSE_W>>1)-1, y:(DENSE_H>>1)-1 };
  const bx=Math.max(0, Math.min(DENSE_W-1, baseC.x + Math.round(dx * sx)));
  const by=Math.max(0, Math.min(DENSE_H-1, baseC.y + Math.round(dy * sy)));
  return { bx, by };
}

export async function _applySparseIntoDense(z, arr){
  const F=this.schema.fieldNames.length;
  const applyFields=this.schema.fieldNames;
  for (const key in this.dataTable){
    const parts=key.split(',');
    const zi=Number(parts[2]||-1);
    if (zi !== (z|0)) continue;
    const x=Number(parts[0]), y=Number(parts[1]);
    if (x<0||x>=this.state.cellsX||y<0||y>=this.state.cellsY) continue;
    const { bx, by } = this._mapCellToDense(z, x, y);
    const base=this._denseIdx(F, bx, by, 0);
    const src=this.dataTable[key];
    for (let fi=0; fi<F; fi++){
      const name=applyFields[fi];
      const v=src[name] || 0;
      if (v!==0) arr[base+fi]=v;
    }
  }
}

export async function setDenseFromCell(z, xCell, yCell, values){
  const arr=await this._ensureDenseLayer(z);
  const F=this.schema.fieldNames.length;
  const { bx, by } = this._mapCellToDense(z, xCell, yCell);
  const base=this._denseIdx(F, bx, by, 0);
  for (const [name,v] of Object.entries(values)){
    const fi=this.schema.index.get(name); if (fi==null) continue;
    arr[base+fi] = v;
    this._maxField[name] = Math.max(this._maxField[name]||0, v||0);
    if (name==='O2') this._maxO2=Math.max(this._maxO2, v||0);
  }
  _markDirty(this, z, bx, by);
  if (!this._flushHandle) this._flushHandle=setTimeout(()=>this._flushDirtyLayers(), 200);
}

export async function addDenseFromCell(z, xCell, yCell, values){
  const arr=await this._ensureDenseLayer(z);
  const F=this.schema.fieldNames.length;
  const { bx, by } = this._mapCellToDense(z, xCell, yCell);
  const base=this._denseIdx(F, bx, by, 0);
  for (const [name,inc] of Object.entries(values)){
    const fi=this.schema.index.get(name); if (fi==null) continue;
    const nxt=(arr[base+fi]||0) + inc;
    arr[base+fi] = nxt;
    this._maxField[name] = Math.max(this._maxField[name]||0, nxt);
    if (name==='O2') this._maxO2=Math.max(this._maxO2, nxt);
  }
  _markDirty(this, z, bx, by);
  if (!this._flushHandle) this._flushHandle=setTimeout(()=>this._flushDirtyLayers(), 200);
}

export async function sampleDenseForCell(z, xCell, yCell, field){
  const fi=this.schema.index.get(field); if (fi==null) return 0;
  const arr=await this._ensureDenseLayer(z);
  const F=this.schema.fieldNames.length;
  const { bx, by } = this._mapCellToDense(z, xCell, yCell);
  return arr[this._denseIdx(F, bx, by, fi)] || 0;
}

export async function _flushDirtyLayers(){
  if (this._disposed){ this._flushHandle=null; return; }
  if (!this._db || !this._dirtyLayers.size){ this._flushHandle=null; return; }
  const entries=Array.from(this._dirtyLayers.entries());
  this._dirtyLayers.clear();
  _ensureLayout(this);
  for (const [z,set] of entries){
    const layerKey=z|0;
    const arr=this._layerCache.get(layerKey);
    if (!arr) continue;
    const F=this.schema.fieldNames.length;
    const indices=Array.from(set).sort((a,b)=>a-b);
    for (const qi of indices){
      const quad=_sliceQuadrant.call(this, arr, qi, F);
      await _persistLayerQuadrant.call(this, layerKey, qi, quad);
    }
    await idbPut(this._db, STORE_LMETA, layerKey, { sid:this.schema.id, fields:this.schema.fieldNames });
  }
  this._flushHandle=null;
}

