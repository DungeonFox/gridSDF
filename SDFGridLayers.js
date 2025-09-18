import { DENSE_W, DENSE_H, STORE_BASE, STORE_BASEZ, STORE_LAYER, STORE_LMETA, DEFAULT_QUADRANT_COUNT } from './SDFGridConstants.js';
import { arraysEqual } from './SDFGridUtil.js';
import { idbGet, idbPut } from './SDFGridStorage.js';
import {
  computeQuadrantLayout,
  createDenseZeroTemplate,
  cloneDenseTemplateBuffer,
  updateDenseTemplateEnv
} from './SDFGridQuadrants.js';

function _ensureLayout(ctx){
  ctx._quadLayout ||= computeQuadrantLayout(ctx.quadrantCount || DEFAULT_QUADRANT_COUNT);
  return ctx._quadLayout;
}

function _quadrantRect(ctx, qi){
  const { cols, qW, qH } = _ensureLayout(ctx);
  const col=qi%cols, row=Math.floor(qi/cols);
  const xStart=col*qW, yStart=row*qH;
  const xEnd=Math.min(xStart+qW, DENSE_W);
  const yEnd=Math.min(yStart+qH, DENSE_H);
  return { xStart, yStart, xEnd, yEnd, qw:xEnd-xStart, qh:yEnd-yStart };
}

function _insertQuadrant(arr, qi, quad, F){
  const { xStart, yStart, xEnd, yEnd } = _quadrantRect(this, qi);
  let idx=0;
  for(let y=yStart;y<yEnd;y++){
    const rowBase=y*DENSE_W*F;
    for(let x=xStart;x<xEnd;x++){
      const base=rowBase + x*F;
      for(let fi=0;fi<F;fi++) arr[base+fi]=quad[idx++];
    }
  }
}

function _markDirty(ctx, z){
  ctx._dirtyLayers.set(z|0, true);
}

function _remapDenseLayer(src, srcFields, targetSchema){
  const Fnew=targetSchema.fieldNames.length;
  const Fold=srcFields.length;
  if (!Fold) return new Float32Array(DENSE_W*DENSE_H*Fnew);
  if (Fold===Fnew && arraysEqual(srcFields, targetSchema.fieldNames)) return src;
  const total=DENSE_W*DENSE_H;
  if (src.length !== total*Fold) return new Float32Array(total*Fnew);
  const out=new Float32Array(total*Fnew);
  const oldIdx=new Map(srcFields.map((n,i)=>[n,i]));
  for(let pix=0; pix<total; pix++){
    const baseNew=pix*Fnew;
    const baseOld=pix*Fold;
    for(let fi=0; fi<Fnew; fi++){
      const name=targetSchema.fieldNames[fi];
      const fiOld=oldIdx.get(name);
      if (fiOld!=null) out[baseNew+fi]=src[baseOld+fiOld];
    }
  }
  return out;
}

async function _loadLegacyQuadrantLayer(ctx, key, targetSchema, lmeta){
  const qCount=ctx.quadrantCount || DEFAULT_QUADRANT_COUNT;
  if (!ctx._db) return null;
  _ensureLayout(ctx);
  const buffers=await Promise.all(Array.from({length:qCount},(_,i)=>idbGet(ctx._db, STORE_LAYER, `${key},${i}`)));
  if (buffers.every(b=>!b)) return null;
  let fields=Array.isArray(lmeta?.fields)?lmeta.fields.slice():[];
  let Fold=fields.length;
  if (!Fold){
    for(let qi=0; qi<buffers.length; qi++){
      const buf=buffers[qi]; if(!buf) continue;
      const quad=new Float32Array(buf);
      const { qw, qh }=_quadrantRect(ctx, qi);
      const area=qw*qh;
      if (area>0){
        const est=quad.length/area;
        if (Number.isInteger(est) && est>0){ Fold=est; break; }
      }
    }
  }
  if (!Fold) Fold=targetSchema.fieldNames.length;
  if (!fields.length) fields=targetSchema.fieldNames.slice(0, Fold);
  const total=DENSE_W*DENSE_H*Fold;
  const arrOld=new Float32Array(total);
  for(let qi=0; qi<buffers.length; qi++){
    const buf=buffers[qi]; if(!buf) continue;
    const quad=new Float32Array(buf);
    _insertQuadrant.call(ctx, arrOld, qi, quad, Fold);
  }
  return { buffer: arrOld, fields };
}

export async function _ensureZeroTemplate(){
  const count = this.quadrantCount || DEFAULT_QUADRANT_COUNT;
  const envExprs = this.envExpressions || [];

  if (!this._db){
    if (!this._memoryZeroTemplate){
      this._memoryZeroTemplate = createDenseZeroTemplate(count, envExprs, this.schema);
    } else if (!arraysEqual(this._memoryZeroTemplate.fieldNames || [], this.schema.fieldNames)){
      this._memoryZeroTemplate = createDenseZeroTemplate(count, envExprs, this.schema);
    } else {
      updateDenseTemplateEnv(this._memoryZeroTemplate, envExprs, this.schema, count);
    }
    return this._memoryZeroTemplate;
  }

  const key=`sid:${this.schema.id}`;
  let tmpl=await idbGet(this._db, STORE_BASEZ, key);
  let dirty=false;

  if (!tmpl){
    tmpl=createDenseZeroTemplate(count, envExprs, this.schema);
    dirty=true;
  } else if (tmpl.quadrants){
    tmpl=createDenseZeroTemplate(count, envExprs, this.schema);
    dirty=true;
  } else {
    const storedFields = Array.isArray(tmpl.fieldNames) ? tmpl.fieldNames : [];
    if (!arraysEqual(storedFields, this.schema.fieldNames)){
      tmpl=createDenseZeroTemplate(count, envExprs, this.schema);
      dirty=true;
    } else {
      const bufLength = (tmpl.buffer instanceof Float32Array ? tmpl.buffer.length : (tmpl.buffer?.byteLength||0)/4);
      const expected = DENSE_W * DENSE_H * this.schema.fieldNames.length;
      if (bufLength !== expected){
        tmpl=createDenseZeroTemplate(count, envExprs, this.schema);
        dirty=true;
      } else if (updateDenseTemplateEnv(tmpl, envExprs, this.schema, count)){
        dirty=true;
      }
    }
  }

  tmpl.version = 2;
  tmpl.fieldNames = this.schema.fieldNames.slice();
  tmpl.quadrantCount = count;

  if (dirty) await idbPut(this._db, STORE_BASEZ, key, tmpl);
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
    const tmpl=await this._ensureZeroTemplate();
    const arr=cloneDenseTemplateBuffer(tmpl, targetSchema);
    this._layerCache.set(key,arr); return arr;
  }

  const [buf,lmeta]=await Promise.all([
    idbGet(this._db, STORE_LAYER, key),
    idbGet(this._db, STORE_LMETA, key)
  ]);

  let fields=Array.isArray(lmeta?.fields)?lmeta.fields.slice():[];
  let arr=null;
  let persistLayer=false;

  if (buf){
    const stored=buf instanceof Float32Array ? buf : new Float32Array(buf);
    const total=DENSE_W*DENSE_H;
    const Fold=fields.length || (stored.length?Math.floor(stored.length/total):0);
    if (Fold && stored.length===total*Fold){
      arr=_remapDenseLayer(stored, fields.length?fields:targetSchema.fieldNames.slice(0,Fold), targetSchema);
      if (arr===stored && fields.length && arraysEqual(fields, targetSchema.fieldNames) && lmeta?.sid===targetSchema.id){
        this._layerCache.set(key,arr); return arr;
      }
      fields=targetSchema.fieldNames.slice();
      persistLayer = arr!==stored;
    }
  }

  if (!arr){
    const legacy=await _loadLegacyQuadrantLayer(this, key, targetSchema, lmeta);
    if (legacy){
      arr=_remapDenseLayer(legacy.buffer, legacy.fields, targetSchema);
      fields=targetSchema.fieldNames.slice();
      persistLayer=true;
    }
  }

  if (!arr){
    const tmpl=await this._ensureZeroTemplate();
    arr=cloneDenseTemplateBuffer(tmpl, targetSchema);
    await this._applySparseIntoDense(z, arr);
    fields=targetSchema.fieldNames.slice();
    persistLayer=true;
  }

  if (arr.length !== DENSE_W*DENSE_H*Fnew){
    const fixed=new Float32Array(DENSE_W*DENSE_H*Fnew);
    fixed.set(arr.subarray(0, Math.min(arr.length, fixed.length)));
    arr=fixed;
    persistLayer=true;
  }

  const metaMatches=lmeta?.sid===targetSchema.id && arraysEqual(lmeta?.fields||[], targetSchema.fieldNames);
  if (persistLayer) await idbPut(this._db, STORE_LAYER, key, arr.buffer);
  if (!metaMatches) await idbPut(this._db, STORE_LMETA, key, { sid:targetSchema.id, fields:targetSchema.fieldNames });

  this._layerCache.set(key,arr);
  return arr;
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
  _markDirty(this, z);
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
  _markDirty(this, z);
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
  const entries=Array.from(this._dirtyLayers.keys());
  this._dirtyLayers.clear();
  await Promise.all(entries.map(async (z)=>{
    const arr=this._layerCache.get(z|0);
    if (!arr) return;
    await Promise.all([
      idbPut(this._db, STORE_LAYER, z|0, arr.buffer),
      idbPut(this._db, STORE_LMETA, z|0, { sid:this.schema.id, fields:this.schema.fieldNames })
    ]);
  }));
  this._flushHandle=null;
}

