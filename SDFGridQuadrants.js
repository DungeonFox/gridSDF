import { DENSE_W, DENSE_H, DEFAULT_QUADRANT_COUNT } from './SDFGridConstants.js';
import { parseEnvExpression } from './SDFGridEnvExpressions.js';

// Quantize environment variables using the Pareto principle (top 20% retained)
export function quantizePareto(env){
  const entries = Object.entries(env || {});
  if (!entries.length) return {};
  const sorted = entries.sort((a,b)=>Math.abs(b[1])-Math.abs(a[1]));
  const keep = Math.ceil(entries.length * 0.2);
  const out = {};
  for (let i=0; i<keep; i++){
    const [k,v] = sorted[i];
    out[k] = v;
  }
  return out;
}

// Create sparse quadrants from serialized environment expressions
// Each expression resolves to an object whose keys become the quadrant variables
// with zero as the default value. Expressions can differ per quadrant.
export function createSparseQuadrants(count = DEFAULT_QUADRANT_COUNT, envExprs = []){
  const quads = [];
  for (let i=0; i<count; i++){
    const expr = envExprs[i] ?? envExprs[0] ?? {};
    const tmpl = parseEnvExpression(expr);
    const q = {};
    for (const k of Object.keys(tmpl)) q[k] = 0;
    quads.push(q);
  }
  return { quadrants: quads };
}

// Reconstruct a dense Float32Array layer from a quadrant template
export function denseFromQuadrants(template, schema){
  const F = schema.fieldNames.length;
  const arr = new Float32Array(DENSE_W * DENSE_H * F);
  const quads = template?.quadrants || [];
  const qCount = quads.length;
  if (!qCount) return arr;

  // Lay out quadrants across the 1024×1024 layer in a near-square grid
  const cols = Math.ceil(Math.sqrt(qCount));
  const rows = Math.ceil(qCount / cols);
  const qW = Math.ceil(DENSE_W / cols);
  const qH = Math.ceil(DENSE_H / rows);

  for (let i=0; i<qCount; i++){
    const quad = quads[i];
    const entries = Object.entries(quad);
    const col = i % cols;
    const row = Math.floor(i / cols);
    const xStart = col * qW;
    const yStart = row * qH;
    const xEnd = Math.min(xStart + qW, DENSE_W);
    const yEnd = Math.min(yStart + qH, DENSE_H);

    for (let y=yStart; y<yEnd; y++){
      const rowBase = y * DENSE_W * F;
      for (let x=xStart; x<xEnd; x++){
        const base = rowBase + x * F;
        for (const [name, val] of entries){
          const fi = schema.index.get(name);
          if (fi != null) arr[base + fi] = val;
        }
      }
    }
  }
  return arr;
}

export function computeQuadrantLayout(count = DEFAULT_QUADRANT_COUNT){
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const qW = Math.ceil(DENSE_W / Math.max(1, cols));
  const qH = Math.ceil(DENSE_H / Math.max(1, rows));
  return { cols, rows, qW, qH, count };
}

export function quadrantBounds(layout, qi){
  const { cols, qW, qH } = layout;
  const col = qi % cols;
  const row = Math.floor(qi / cols);
  const minX = col * qW;
  const minY = row * qH;
  const maxX = Math.min(minX + qW, DENSE_W);
  const maxY = Math.min(minY + qH, DENSE_H);
  return { minX, minY, maxX, maxY };
}

function _combineBounds(out, b){
  if (!out){
    return { minX:b.minX, minY:b.minY, maxX:b.maxX, maxY:b.maxY };
  }
  return {
    minX: Math.min(out.minX, b.minX),
    minY: Math.min(out.minY, b.minY),
    maxX: Math.max(out.maxX, b.maxX),
    maxY: Math.max(out.maxY, b.maxY)
  };
}

function _boundsIntersect(a, b){
  if (!a || !b) return false;
  return !(a.maxX <= b.minX || b.maxX <= a.minX || a.maxY <= b.minY || b.maxY <= a.minY);
}

function _axisExtent(b){
  return { x:b.maxX - b.minX, y:b.maxY - b.minY };
}

export function buildQuadrantBVH(count, layout = computeQuadrantLayout(count)){
  const leaves = [];
  for (let i=0; i<count; i++){
    leaves.push({ index:i, bounds:quadrantBounds(layout, i) });
  }

  function build(nodes){
    if (!nodes.length) return null;
    if (nodes.length <= 4){
      const bounds = nodes.reduce((acc,n)=>_combineBounds(acc,n.bounds), null);
      return { bounds, indices:nodes.map(n=>n.index) };
    }
    const bounds = nodes.reduce((acc,n)=>_combineBounds(acc,n.bounds), null);
    const ext = _axisExtent(bounds);
    const axis = ext.x >= ext.y ? 'x' : 'y';
    const sorted = nodes.slice().sort((a,b)=>{
      const ca = axis==='x' ? (a.bounds.minX + a.bounds.maxX) : (a.bounds.minY + a.bounds.maxY);
      const cb = axis==='x' ? (b.bounds.minX + b.bounds.maxX) : (b.bounds.minY + b.bounds.maxY);
      return ca - cb;
    });
    const mid = Math.floor(sorted.length / 2);
    const left = build(sorted.slice(0, mid));
    const right = build(sorted.slice(mid));
    return { bounds, left, right };
  }

  return build(leaves);
}

function _normalizeEnvExpression(expr){
  const obj = parseEnvExpression(expr);
  const out = {};
  for (const key of Object.keys(obj).sort()) out[key] = obj[key];
  return JSON.stringify(out);
}

function _valuesToVector(values, schema){
  const vec = new Float32Array(schema.fieldNames.length);
  for (let i=0; i<schema.fieldNames.length; i++){
    const name = schema.fieldNames[i];
    const v = values?.[name];
    vec[i] = Number.isFinite(v) ? v : 0;
  }
  return vec;
}

function _visitBVH(node, bounds, cb){
  if (!node || !_boundsIntersect(node.bounds, bounds)) return;
  if (node.indices){
    cb(node.indices, node.bounds);
    return;
  }
  _visitBVH(node.left, bounds, cb);
  _visitBVH(node.right, bounds, cb);
}

function _writeIntersection(buffer, layout, F, qi, bounds, vec){
  const qBounds = quadrantBounds(layout, qi);
  const minX = Math.max(qBounds.minX, Math.floor(bounds.minX));
  const minY = Math.max(qBounds.minY, Math.floor(bounds.minY));
  const maxX = Math.min(qBounds.maxX, Math.ceil(bounds.maxX));
  const maxY = Math.min(qBounds.maxY, Math.ceil(bounds.maxY));
  if (maxX <= minX || maxY <= minY) return false;
  let wrote = false;
  for (let y=minY; y<maxY; y++){
    const rowBase = y * DENSE_W * F;
    for (let x=minX; x<maxX; x++){
      const base = rowBase + x * F;
      for (let fi=0; fi<F; fi++) buffer[base + fi] = vec[fi];
      wrote = true;
    }
  }
  return wrote;
}

export function updateDenseTemplate(template, updates, schema){
  if (!template || !updates?.length) return false;
  const buffer = template.buffer instanceof Float32Array ? template.buffer : new Float32Array(template.buffer || 0);
  if (!buffer.length) return false;
  const qCount = template.quadrantCount || template.layout?.count || DEFAULT_QUADRANT_COUNT;
  const layout = template.layout || computeQuadrantLayout(qCount);
  template.layout = layout;
  if (!template.bvh) template.bvh = buildQuadrantBVH(layout.count || qCount, layout);
  template.quadrantCount = layout.count || qCount;
  const F = schema.fieldNames.length;
  let modified = false;

  for (const upd of updates){
    if (!upd?.bounds) continue;
    const vec = _valuesToVector(upd.values || {}, schema);
    _visitBVH(template.bvh, upd.bounds, (indices)=>{
      for (const qi of indices){
        if (_writeIntersection(buffer, layout, F, qi, upd.bounds, vec)) modified = true;
      }
    });
  }
  template.buffer = buffer.buffer;
  return modified;
}

export function createDenseZeroTemplate(count, envExprs, schema){
  const layout = computeQuadrantLayout(count);
  const buffer = new Float32Array(DENSE_W * DENSE_H * schema.fieldNames.length);
  const template = {
    version: 2,
    layout,
    quadrantCount: count,
    bvh: buildQuadrantBVH(count, layout),
    buffer: buffer.buffer,
    fieldNames: schema.fieldNames.slice(),
    envHashes: new Array(count)
  };

  const updates = [];
  for (let i=0; i<count; i++){
    const expr = envExprs?.[i] ?? envExprs?.[0] ?? {};
    template.envHashes[i] = _normalizeEnvExpression(expr);
    updates.push({ bounds: quadrantBounds(layout, i), values: quantizePareto(parseEnvExpression(expr)) });
  }
  updateDenseTemplate(template, updates, schema);
  return template;
}

export function cloneDenseTemplateBuffer(template, schema){
  if (!template) return new Float32Array(DENSE_W * DENSE_H * schema.fieldNames.length);
  if (template.buffer){
    const src = template.buffer instanceof Float32Array ? template.buffer : new Float32Array(template.buffer);
    if (src.length === DENSE_W * DENSE_H * schema.fieldNames.length){
      return new Float32Array(src);
    }
  }
  if (template.quadrants){
    return denseFromQuadrants(template, schema);
  }
  return new Float32Array(DENSE_W * DENSE_H * schema.fieldNames.length);
}

export function updateDenseTemplateEnv(template, envExprs, schema, count){
  if (!template) return false;
  const qCount = count ?? template.quadrantCount ?? envExprs?.length ?? DEFAULT_QUADRANT_COUNT;
  if (!template.layout || template.layout.count !== qCount){
    template.layout = computeQuadrantLayout(qCount);
    template.bvh = buildQuadrantBVH(qCount, template.layout);
    template.quadrantCount = qCount;
  }
  if (!Array.isArray(template.envHashes) || template.envHashes.length !== qCount){
    template.envHashes = new Array(qCount).fill('');
  }

  const updates = [];
  for (let i=0; i<qCount; i++){
    const expr = envExprs?.[i] ?? envExprs?.[0] ?? {};
    const norm = _normalizeEnvExpression(expr);
    if (template.envHashes[i] === norm) continue;
    template.envHashes[i] = norm;
    updates.push({ bounds: quadrantBounds(template.layout, i), values: quantizePareto(parseEnvExpression(expr)) });
  }
  if (!updates.length) return false;
  return updateDenseTemplate(template, updates, schema);
}
