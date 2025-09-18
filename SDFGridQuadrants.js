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

export function quadrantLayout(count = DEFAULT_QUADRANT_COUNT){
  const safeCount = Math.max(1, Number.isFinite(count) ? count|0 : DEFAULT_QUADRANT_COUNT);
  const cols = Math.ceil(Math.sqrt(safeCount));
  const rows = Math.ceil(safeCount / cols);
  const qW = Math.ceil(DENSE_W / cols);
  const qH = Math.ceil(DENSE_H / rows);
  return { cols, rows, qW, qH };
}

function _coerceDefault(val){
  if (typeof val === 'number') return Number.isFinite(val) ? val : 0;
  const num = Number(val);
  return Number.isFinite(num) ? num : 0;
}

function _defaultsForQuadrant(index, envExprs, fallback){
  if (fallback && typeof fallback === 'object' && !ArrayBuffer.isView(fallback)) return fallback;
  const expr = envExprs[index] ?? envExprs[0] ?? {};
  return parseEnvExpression(expr);
}

// Create a dense zero template per quadrant from serialized environment expressions.
// Each quadrant is represented as a Float32Array sized to the quadrant footprint, where
// every cell is initialized to the default environment value for the associated field.
export function createDenseZeroTemplate(count = DEFAULT_QUADRANT_COUNT, schema = { fieldNames: [] }, envExprs = [], existing = null){
  const qCount = Math.max(0, Number.isFinite(count) ? count|0 : DEFAULT_QUADRANT_COUNT);
  const fields = Array.isArray(schema?.fieldNames) ? schema.fieldNames.slice() : [];
  const F = fields.length;
  const layout = quadrantLayout(qCount || 1);
  const quadrants = [];

  for (let i=0; i<qCount; i++){
    const defaults = _defaultsForQuadrant(i, envExprs, existing?.quadrants?.[i]);
    const col = i % layout.cols;
    const row = Math.floor(i / layout.cols);
    const width  = col === layout.cols - 1 ? DENSE_W - col * layout.qW : layout.qW;
    const height = row === layout.rows - 1 ? DENSE_H - row * layout.qH : layout.qH;
    const quad = new Float32Array(width * height * F);

    if (F){
      const cellDefaults = new Float32Array(F);
      for (let fi=0; fi<F; fi++){
        const name = fields[fi];
        cellDefaults[fi] = _coerceDefault(defaults?.[name] ?? 0);
      }
      for (let offset=0; offset<quad.length; offset+=F){
        quad.set(cellDefaults, offset);
      }
    }
    quadrants.push(quad);
  }

  return { version: 2, fields, count: qCount, layout, quadrants };
}

// Reconstruct a dense Float32Array layer from a quadrant template
export function denseFromQuadrants(template, schema){
  const F = schema.fieldNames.length;
  const arr = new Float32Array(DENSE_W * DENSE_H * F);
  if (!F) return arr;

  const quads = template?.quadrants || [];
  const qCount = quads.length;
  if (!qCount) return arr;

  const { cols, rows, qW, qH } = quadrantLayout(qCount);

  for (let i=0; i<qCount; i++){
    const quad = quads[i];
    if (!quad) continue;

    const col = i % cols;
    const row = Math.floor(i / cols);
    const xStart = col * qW;
    const yStart = row * qH;
    const xEnd = Math.min(xStart + qW, DENSE_W);
    const yEnd = Math.min(yStart + qH, DENSE_H);

    if (ArrayBuffer.isView(quad)){
      const qw = xEnd - xStart;
      const qh = yEnd - yStart;
      let idx = 0;
      for (let y=0; y<qh; y++){
        const rowBase = (yStart + y) * DENSE_W * F;
        for (let x=0; x<qw; x++){
          const base = rowBase + (xStart + x) * F;
          for (let fi=0; fi<F; fi++) arr[base + fi] = quad[idx++];
        }
      }
    } else {
      const entries = Object.entries(quad);
      if (!entries.length) continue;
      for (let y=yStart; y<yEnd; y++){
        const rowBase = y * DENSE_W * F;
        for (let x=xStart; x<xEnd; x++){
          const base = rowBase + x * F;
          for (const [name, val] of entries){
            const fi = schema.index.get(name);
            if (fi != null) arr[base + fi] = _coerceDefault(val);
          }
        }
      }
    }
  }
  return arr;
}
