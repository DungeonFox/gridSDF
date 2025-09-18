// myEdgeCaseLibrary.js
// A “directing” rule set for BucketOrchestrator. Each rule can:
//  • read/mutate context
//  • return { rerouteBucketName?, abort?, replacePayload?, delayMs?, retry? }
//  • validate / normalize vec2 and tag inputs
//  • shard or time-slice bucket routing
//  • throttle duplicates
//
// Usage:
//   import buildRules, { defaultEdgeOptions } from './myEdgeCaseLibrary.js';
//   orchestrator.registerRule(buildRules({ /* overrides */ }));
//
// Notes:
//  - Rules are pure(ish) functions operating on {context, op, payload, orchestrator}.
//  - Keep heavy I/O outside rules; prefer hints that the orchestrator acts upon.
//  - BucketOrchestrator will still sanitize/lowercase the final bucket name.

export const defaultEdgeOptions = {
  // If provided and context is missing card/repo/file, these defaults are used.
  contextDefaults: { card: 'c000', repo: '0x00', file: '0x00', group: 'default' },

  // For sharding by vec2 coordinate:
  shard: {
    enabled: true,
    sizeX: 256,  // cells per shard on x
    sizeY: 256,  // cells per shard on y
    // Final bucket name becomes: resolver(context) + `-s${sx}x${sy}`
    // Example: "c0010xb10xf1statecapture-s0x1"
  },

  // Time-slicing: append YYYYMMDD to bucket for ops labeled in timeSliceOps.
  timeSlicing: {
    enabled: false,
    timeSliceOps: new Set(['bulkPreserve']), // ops it applies to
    // time zone insensitive: uses local date
  },

  // Lightweight duplicate-write throttle window (ms)
  throttleMs: 60,

  // Max array length for a single value write (prevents accidental megabyte writes)
  maxValuesPerWrite: 8192,

  // Max bulk entries per transaction (guardrails only; actual IDB can handle more)
  maxBulkEntries: 5000,

  // Retry overrides when rules detect transient conditions
  transientRetry: { attempts: 3, delayMs: 120 },

  // When quotaLow is set on context, spill writes to a suffix
  spillSuffix: '-spill',

  // If present in context, maps bucketAlias -> actual base bucket (before sharding/time-slicing/spill)
  aliasMap: {
    // 'work': (ctx) => `${ctx.card}${ctx.repo}${ctx.file}statecapture`
  }
};

// ----------------------------- helpers -----------------------------

function isFiniteNum(n) { return Number.isFinite(n); }

function normalizeVec2(maybeVec2) {
  if (!Array.isArray(maybeVec2) || maybeVec2.length !== 2) return null;
  const x = Number(maybeVec2[0]);
  const y = Number(maybeVec2[1]);
  return (isFiniteNum(x) && isFiniteNum(y)) ? [x, y] : null;
}

function normalizeGroup(group) {
  if (group == null) return 'default';
  const s = String(group).trim();
  return s.length ? s : 'default';
}

function shardSuffix(vec2, sizeX, sizeY) {
  const [x, y] = vec2;
  const sx = Math.floor(x / sizeX);
  const sy = Math.floor(y / sizeY);
  return `-s${sx}x${sy}`;
}

function yyyymmdd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

// In-memory throttle cache (module-scope)
const _recentWrites = new Map(); // key -> ts

function makeRecentKey(op, payload) {
  try {
    if (op === 'bulkPreserve') {
      // key based on first & length for a cheap signature
      const first = payload?.entries?.[0] ?? {};
      return `${op}:${JSON.stringify(first)}:${payload?.entries?.length || 0}`;
    }
    return `${op}:${JSON.stringify(payload)}`;
  } catch {
    return `${op}:opaque`;
  }
}

// Clamp numeric arrays; coerce non-numbers to 0; trim length cap
function sanitizeNumericArray(arr, maxLen) {
  if (!Array.isArray(arr) && !ArrayBuffer.isView(arr)) return [];
  const out = [];
  const lim = Math.min(maxLen, Number(arr.length || 0));
  for (let i = 0; i < lim; i++) {
    const v = Number(arr[i]);
    out.push(isFiniteNum(v) ? v : 0);
  }
  return out;
}

function sanitizeNamesArray(names) {
  if (!Array.isArray(names)) return [];
  return names.map(n => (n == null ? '' : String(n)));
}

// ---------------------------- rules builder ----------------------------

export default function buildRules(options = {}) {
  const cfg = {
    ...defaultEdgeOptions,
    ...options,
    shard: { ...defaultEdgeOptions.shard, ...(options.shard || {}) },
    timeSlicing: { ...defaultEdgeOptions.timeSlicing, ...(options.timeSlicing || {}) }
  };

  // Rule 1: Ensure baseline context; support alias mapping.
  async function ensureContext({ context, op }) {
    // Fill defaults
    for (const k of Object.keys(cfg.contextDefaults)) {
      if (context[k] == null || context[k] === '') {
        context[k] = cfg.contextDefaults[k];
      }
    }
    // Resolve alias -> base bucket prefix (before orchestrator resolver runs)
    if (context.bucketAlias && cfg.aliasMap && cfg.aliasMap[context.bucketAlias]) {
      // Provide a hint: let orchestrator’s resolver read context.baseBucket if it wants.
      const mapper = cfg.aliasMap[context.bucketAlias];
      context.baseBucket = typeof mapper === 'function' ? mapper(context) : String(mapper);
    }
    // Normalize group where relevant
    if (op === 'setVec2Tags' || op === 'setVec2TagName' || op === 'getVec2Tags' || op === 'getValueWithNames') {
      context.group = normalizeGroup(context.group);
    }
  }

  // Rule 2: Normalize/validate payload shapes; cap sizes.
  async function normalizePayload({ op, payload }) {
    if (op === 'setValue' || op === 'updateValue' || op === 'getValue' || op === 'getValueWithNames' || op === 'deleteValue') {
      const vec2 = normalizeVec2(payload.vec2);
      if (!vec2) return { abort: true };
      if (op === 'setValue') {
        const values = sanitizeNumericArray(payload.values, cfg.maxValuesPerWrite);
        return { replacePayload: { vec2, values, group: normalizeGroup(payload.group) } };
      } else if (op === 'updateValue') {
        const idx = Math.max(0, Number(payload.index) | 0);
        const value = Number(payload.value);
        return { replacePayload: { vec2, index: idx, value: isFiniteNum(value) ? value : 0 } };
      } else if (op === 'getValueWithNames') {
        return { replacePayload: { vec2, group: normalizeGroup(payload.group) } };
      }
      return { replacePayload: { ...payload, vec2 } };
    }

    if (op === 'setVec2Tags' || op === 'setVec2TagName' || op === 'getVec2Tags' || op === 'deleteVec2Tags') {
      const vec2 = normalizeVec2(payload.vec2);
      if (!vec2) return { abort: true };
      if (op === 'setVec2Tags') {
        return { replacePayload: { group: normalizeGroup(payload.group), vec2, names: sanitizeNamesArray(payload.names) } };
      } else if (op === 'setVec2TagName') {
        const idx = Math.max(0, Number(payload.index) | 0);
        const name = String(payload.name ?? '');
        return { replacePayload: { group: normalizeGroup(payload.group), vec2, index: idx, name } };
      } else {
        return { replacePayload: { group: normalizeGroup(payload.group), vec2 } };
      }
    }

    if (op === 'bulkPreserve') {
      const raw = Array.isArray(payload.entries) ? payload.entries.slice(0, cfg.maxBulkEntries) : [];
      const entries = raw.map(e => {
        const v2 = normalizeVec2(e.vec2);
        if (!v2) return null;
        const values = sanitizeNumericArray(e.values, cfg.maxValuesPerWrite);
        const tagGroup = e.tagGroup != null ? normalizeGroup(e.tagGroup) : undefined;
        const tagNames = Array.isArray(e.tagNames) ? sanitizeNamesArray(e.tagNames) : undefined;
        return { vec2: v2, values, tagGroup, tagNames };
      }).filter(Boolean);
      // Deduplicate by vec2 + (optional) tagGroup quickly
      const seen = new Set();
      const deduped = [];
      for (const e of entries) {
        const key = `${e.vec2[0]}|${e.vec2[1]}|${e.tagGroup || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(e);
      }
      return { replacePayload: { entries: deduped } };
    }
  }

  // Rule 3: Throttle duplicate writes briefly to avoid hammering IDB.
  async function throttleDuplicates({ op, payload }) {
    if (!cfg.throttleMs) return;
    if (op === 'getValue' || op === 'getVec2Tags' || op === 'getValueWithNames') return; // reads are fine

    const key = makeRecentKey(op, payload);
    const now = performance.now?.() || Date.now();
    const last = _recentWrites.get(key) || 0;
    if (now - last < cfg.throttleMs) {
      return { abort: true }; // silently drop; caller can re-issue later
    }
    _recentWrites.set(key, now);
  }

  // Rule 4: Optional pre-sizing of names when writing values (so orchestrator can ensure slots)
  async function ensureNameSlotsHint({ op, payload, context }) {
    if (op === 'setValue' && typeof context.ensureNameSlots === 'undefined') {
      // If a group is provided and you want names array to match length of values:
      if (payload.group && Array.isArray(payload.values)) {
        context.ensureNameSlots = new Array(payload.values.length).fill('');
      }
    }
  }

  // Rule 5: Routing — shard by vec2; time slicing; spill on quotaLow; alias mapping
  async function routing({ op, payload, context }) {
    // Base route hint (edge lib doesn't compute full name; resolver uses context)
    context.routeSuffix = '';

    // Shard by vec2 for writes and lookups involving a single vec2
    if (cfg.shard.enabled) {
      // ops that carry a single vec2:
      const singleVec2Ops = new Set([
        'setValue', 'getValue', 'getValueWithNames', 'updateValue', 'deleteValue',
        'setVec2Tags', 'setVec2TagName', 'getVec2Tags', 'deleteVec2Tags'
      ]);
      if (singleVec2Ops.has(op)) {
        const v2 = payload.vec2;
        if (v2) context.routeSuffix += shardSuffix(v2, cfg.shard.sizeX, cfg.shard.sizeY);
      } else if (op === 'bulkPreserve' && payload.entries?.length) {
        // Coarse shard: pick first entry to choose a shard
        const v2 = payload.entries[0].vec2;
        if (v2) context.routeSuffix += shardSuffix(v2, cfg.shard.sizeX, cfg.shard.sizeY);
      }
    }

    // Time-slicing for certain ops
    if (cfg.timeSlicing.enabled && cfg.timeSlicing.timeSliceOps.has(op)) {
      context.routeSuffix += `-${yyyymmdd(new Date())}`;
    }

    // Spill routing if caller hints low quota
    if (context.quotaLow && cfg.spillSuffix) {
      context.routeSuffix += cfg.spillSuffix;
      return { retry: cfg.transientRetry }; // nudge orchestrator to be patient
    }

    // If a rule wants to hard reroute, it can return rerouteBucketName:
    if (context.forceBucket) {
      return { rerouteBucketName: String(context.forceBucket) + (context.routeSuffix || '') };
    }
  }

  // Rule 6: Gentle backoff for bulk
  async function bulkBackoff({ op }) {
    if (op === 'bulkPreserve') {
      return { retry: cfg.transientRetry };
    }
  }

  // Compose all rules (order matters)
  const rules = [
    ensureContext,
    normalizePayload,
    throttleDuplicates,
    ensureNameSlotsHint,
    routing,
    bulkBackoff
  ];

  // Return a single callable rule for orchestrator.registerRule(...)
  return async function myEdgeCaseRulePack(args) {
    let out = undefined;
    for (const r of rules) {
      // If a prior rule returned abort, stop early
      if (out?.abort) return out;
      const res = await r(args);
      // merge semantics: last writer wins for fields
      if (res) {
        out = { ...(out || {}), ...res };
        // replacePayload should carry forward to next rules
        if (res.replacePayload !== undefined) {
          args = { ...args, payload: res.replacePayload };
        }
        // rerouteBucketName / retry / delayMs flow straight through
      }
    }
    return out;
  };
}
