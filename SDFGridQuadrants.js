import { DENSE_W, DENSE_H, DEFAULT_QUADRANT_COUNT } from './SDFGridConstants.js';
import { parseEnvExpression } from './SDFGridEnvExpressions.js';

const TEMPLATE_VERSION = 2;

function _layoutForQuadrants(count){
  const cols=Math.ceil(Math.sqrt(count));
  const rows=Math.ceil(count/cols);
  const qW=Math.ceil(DENSE_W/cols);
  const qH=Math.ceil(DENSE_H/rows);
  return { cols, rows, qW, qH };
}

function _quadrantBounds(index, layout){
  const { cols, qW, qH } = layout;
  const col=index%cols;
  const row=Math.floor(index/cols);
  const x0=col*qW;
  const y0=row*qH;
  const x1=Math.min(x0+qW, DENSE_W);
  const y1=Math.min(y0+qH, DENSE_H);
  return { x0, y0, x1, y1 };
}

function _buildBVHNode(x0, y0, x1, y1, minSize){
  const width=x1-x0;
  const height=y1-y0;
  const node={ x0, y0, x1, y1, children:null };
  if (width<=minSize && height<=minSize) return node;
  if (width>=height){
    const mid=Math.floor((x0+x1)/2);
    if (mid<=x0 || mid>=x1) return node;
    node.children=[
      _buildBVHNode(x0, y0, mid, y1, minSize),
      _buildBVHNode(mid, y0, x1, y1, minSize)
    ];
  } else {
    const mid=Math.floor((y0+y1)/2);
    if (mid<=y0 || mid>=y1) return node;
    node.children=[
      _buildBVHNode(x0, y0, x1, mid, minSize),
      _buildBVHNode(x0, mid, x1, y1, minSize)
    ];
  }
  return node;
}

function _buildBVH(){
  return _buildBVHNode(0, 0, DENSE_W, DENSE_H, 64);
}

function _boundsIntersect(a, b){
  return a.x0<b.x1 && a.x1>b.x0 && a.y0<b.y1 && a.y1>b.y0;
}

function _stableEnvHash(envObj){
  const keys=Object.keys(envObj||{}).sort();
  const ordered={};
  for (const k of keys) ordered[k]=envObj[k];
  return JSON.stringify(ordered);
}

function _filterEnvToSchema(envObj, schema){
  const out={};
  if (!schema?.fieldNames?.length) return out;
  for (const name of schema.fieldNames){
    if (envObj && Object.prototype.hasOwnProperty.call(envObj, name)) out[name]=envObj[name];
  }
  return out;
}

function _updateRegionBVH(node, target, arr, F, index, values){
  if (!_boundsIntersect(node, target)) return;
  if (!node.children){
    const x0=Math.max(node.x0, target.x0)|0;
    const y0=Math.max(node.y0, target.y0)|0;
    const x1=Math.min(node.x1, target.x1)|0;
    const y1=Math.min(node.y1, target.y1)|0;
    if (x0>=x1 || y0>=y1) return;
    const entries=Object.entries(values || {});
    for (let y=y0; y<y1; y++){
      const rowBase=y*DENSE_W*F;
      for (let x=x0; x<x1; x++){
        const base=rowBase + x*F;
        for (let i=0; i<entries.length; i++){
          const [name,val]=entries[i];
          const fi=index.get(name);
          if (fi!=null) arr[base+fi]=val;
        }
      }
    }
    return;
  }
  for (const child of node.children) _updateRegionBVH(child, target, arr, F, index, values);
}

function _applyQuadrantValues(template, qIndex, values, schema){
  const { layout, bvh } = template;
  const bounds=_quadrantBounds(qIndex, layout);
  const arr=new Float32Array(template.buffer);
  const F=schema.fieldNames.length;
  _updateRegionBVH(bvh, bounds, arr, F, schema.index, values);
}

function _ensureQuadrantValues(template){
  if (!Array.isArray(template.quadrantValues)) template.quadrantValues=[];
  return template.quadrantValues;
}

export function createDenseZeroTemplate(count = DEFAULT_QUADRANT_COUNT, envExprs = [], schema){
  const fields=schema?.fieldNames || [];
  const F=fields.length;
  const arr=new Float32Array(DENSE_W * DENSE_H * F);
  if (F===0){
    return {
      version:TEMPLATE_VERSION,
      layout:_layoutForQuadrants(count),
      quadrantHashes:Array.from({length:count}, ()=>'{}'),
      quadrantValues:Array.from({length:count}, () => ({})),
      buffer:arr.buffer,
      bvh:_buildBVH(),
      fields:fields.slice()
    };
  }
  const layout=_layoutForQuadrants(count);
  const bvh=_buildBVH();
  const hashes=new Array(count);
  const values=new Array(count);
  for (let i=0; i<count; i++){
    const expr=envExprs[i] ?? envExprs[0] ?? {};
    const parsed=parseEnvExpression(expr);
    const filtered=_filterEnvToSchema(parsed, schema);
    hashes[i]=_stableEnvHash(filtered);
    values[i]={...filtered};
    _applyQuadrantValues({ buffer:arr.buffer, layout, bvh }, i, filtered, schema);
  }
  return {
    version:TEMPLATE_VERSION,
    layout,
    quadrantHashes:hashes,
    quadrantValues:values,
    buffer:arr.buffer,
    bvh,
    fields:fields.slice()
  };
}

export function refreshDenseZeroTemplate(template, count, envExprs, schema){
  if (!schema?.fieldNames) return { template, replaced:false, mutated:false };
  const fields=schema.fieldNames;
  const F=fields.length;
  const expectedSize=DENSE_W * DENSE_H * F * 4;
  const needsRebuild = !template || template.version!==TEMPLATE_VERSION ||
    !template.buffer || template.buffer.byteLength!==expectedSize ||
    !Array.isArray(template.fields) || template.fields.length!==fields.length ||
    template.fields.some((n,i)=>n!==fields[i]) ||
    !template.layout || !template.layout.cols ||
    !Array.isArray(template.quadrantHashes) || template.quadrantHashes.length!==count;
  if (needsRebuild){
    return { template:createDenseZeroTemplate(count, envExprs, schema), replaced:true, mutated:true };
  }
  template.fields = fields.slice();
  template.version = TEMPLATE_VERSION;
  if (!template.bvh) template.bvh=_buildBVH();
  if (!Array.isArray(template.quadrantValues)) template.quadrantValues=Array.from({length:count}, ()=>({}));
  const hashes=template.quadrantHashes;
  let mutated=false;
  let values=_ensureQuadrantValues(template);
  if (values.length !== count){
    values=Array.from({length:count}, (_,i)=> (values[i] ? { ...values[i] } : {}));
    template.quadrantValues=values;
    mutated=true;
  }
  const arr=new Float32Array(template.buffer);
  if (F===0){
    arr.fill(0);
    return { template, replaced:false, mutated:true };
  }
  const layout=_layoutForQuadrants(count);
  template.layout=layout;
  for (let i=0; i<count; i++){
    const expr=envExprs[i] ?? envExprs[0] ?? {};
    const parsed=parseEnvExpression(expr);
    const filtered=_filterEnvToSchema(parsed, schema);
    const hash=_stableEnvHash(filtered);
    const prev=values[i] || {};
    if (hashes[i] !== hash){
      const merged={};
      const keys=new Set([...Object.keys(prev||{}), ...Object.keys(filtered)]);
      keys.forEach(k=>{ merged[k]=Object.prototype.hasOwnProperty.call(filtered,k)?filtered[k]:0; });
      hashes[i]=hash;
      values[i]={...filtered};
      _applyQuadrantValues(template, i, merged, schema);
      mutated=true;
    }
  }
  if (mutated) template.buffer=arr.buffer;
  return { template, replaced:false, mutated };
}

export function cloneDenseTemplate(template, schema){
  const fields=schema?.fieldNames || [];
  const F=fields.length;
  const size=DENSE_W * DENSE_H * F;
  if (!template?.buffer || template.fields?.length!==fields.length){
    return new Float32Array(size);
  }
  return new Float32Array(template.buffer.slice(0));
}
