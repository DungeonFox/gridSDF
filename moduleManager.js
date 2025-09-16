// moduleManager.js — plain-object registry, preserves old semantics, passes dense + svg params

import { SDFGrid } from './SDFGrid.js';
import { getRegistry, setRegistry } from './utils.js';

export const modulesByUID = {}; // keep as plain object for hasOwnProperty in main.js

function buildDefaults() {
  return {
    gridWidth: 10, gridHeight: 10, gridDepth: 10,
    cellsX: 10, cellsY: 10, cellsZ: 3,
    fidelity: 3,
    shapeType: 'custom',
    customSVGPath:
      '[M 0 -1 L 0.3 -0.3 L 1 0 L 0.3 0.3 L 0 1 L -0.3 0.3 L -1 0 L -0.3 -0.3 Z]' +
      '[M 0 -0.8 L 0.24 -0.24 L 0.8 0 L 0.24 0.24 L 0 0.8 L -0.24 0.24 L -0.8 0 L -0.24 -0.24 Z]' +
      '[M 0 -0.6 L 0.18 -0.18 L 0.6 0 L 0.18 0.18 L 0 0.6 L -0.18 0.18 L -0.6 0 L -0.18 -0.18 Z]',
    position: { x: 0, y: 0, z: 0 },

    // dense field knobs
    useDenseField: !!navigator.storageBuckets,        // enable when available
    fieldNames: ['O2', 'CO2', 'H2O'],
    fieldForViz: 'O2',
    propagationDir: { x: 1, y: 0 }
  };
}

function massageSaved(uid) {
  const saved = SDFGrid.loadState(uid);
  if (!saved || !saved.state) return null;
  const s = saved.state;
  return {
    gridWidth: s.gridWidth, gridHeight: s.gridHeight, gridDepth: s.gridDepth,
    cellsX: s.cellsX, cellsY: s.cellsY, cellsZ: s.cellsZ,
    fidelity: s.fidelity,
    shapeType: s.shapeType,
    customSVGPath: s.customSVGPath,
    position: saved.position || { x: 0, y: 0, z: 0 },

    // carry env names into dense fields if present
    useDenseField: !!navigator.storageBuckets,
    fieldNames: Array.isArray(saved.envVariables) && saved.envVariables.length ? saved.envVariables : ['O2', 'CO2', 'H2O'],
    fieldForViz: 'O2',
    propagationDir: { x: 1, y: 0 },

    // carry trail/decay if present
    trailStrength: typeof saved.trailStrength === 'number' ? saved.trailStrength : undefined,
    decayRate: typeof saved.decayRate === 'number' ? saved.decayRate : undefined
  };
}

export function disposeModule(uid) {
  const m = modulesByUID[uid];
  if (!m) return;
  try { m.dispose?.(); } catch {}
  delete modulesByUID[uid];
}

export function ensureModule(uid, scene, paramsMaybe, rebuild = false) {
  const fromSaved = massageSaved(uid);
  const defaults = buildDefaults();

  // caller-provided params override, then saved, then defaults
  const params = Object.assign({}, defaults, fromSaved || {}, paramsMaybe || {});

  // ensure bucket binding through uid happens inside SDFGrid (already implemented)
  if (modulesByUID[uid] && !rebuild) return modulesByUID[uid];
  if (modulesByUID[uid] && rebuild) disposeModule(uid);

  const mod = new SDFGrid(uid, scene, params);
  modulesByUID[uid] = mod;
  return mod;
}

export function reloadAllUIDs(scene) {
  const reg = getRegistry(); // [{uid}]
  const keep = {};
  for (let i = 0; i < reg.length; i++) keep[reg[i].uid] = true;

  for (const id in modulesByUID) {
    if (Object.prototype.hasOwnProperty.call(modulesByUID, id) && !keep[id]) disposeModule(id);
  }
  for (let k = 0; k < reg.length; k++) ensureModule(reg[k].uid, scene, null, false);
}

export function clearRegistry() {
  setRegistry([]);
  for (const id in modulesByUID) {
    if (Object.prototype.hasOwnProperty.call(modulesByUID, id)) disposeModule(id);
  }
}

export function updateVisibility(activeUID, showOthers, hideActive) {
  for (const id in modulesByUID) {
    if (!Object.prototype.hasOwnProperty.call(modulesByUID, id)) continue;
    const mod = modulesByUID[id];
    const isActive = id === activeUID;
    const visible = isActive ? !hideActive : !!showOthers;
    mod.setVisible?.(visible);
  }
}
