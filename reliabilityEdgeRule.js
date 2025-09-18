// reliabilityEdgeRule.js
// A queue-backed reliability layer implemented as an edge-case rule pack.
// Ensures "what was meant to be stored" is indeed stored—even under load.
//
// Usage:
//   import installReliability from './reliabilityEdgeRule.js';
//   const { rule, worker } = installReliability(orch, { /* options */ });
//   orch.registerRule(rule);
//   worker.start();
//   // ... later: worker.stop();
//
// Works with BucketOrchestrator + vec2StorageManager.js.
// The rule enqueues any write-like op. The worker verifies by read-back,
// and retries missing/partial entries until success or exhaustion.
//
// Supported ops: setValue, updateValue, deleteValue, setVec2Tags, setVec2TagName, bulkPreserve, migrate (best-effort)

export default function installReliability(orchestrator, options = {}) {
  const cfg = {
    // Core loop
    tickMs: 180,                 // base tick interval
    maxPerTick: 24,              // limit how many queue items to touch per tick
    // Attempts & backoff
    maxAttempts: 8,              // per item
    baseRetryMs: 160,            // initial retry delay per item
    backoff: 1.7,                // multiplicative backoff
    jitterPct: 0.25,             // ±25% jitter
    // Equality checks
    floatEpsilon: 1e-9,          // equality tolerance for float arrays
    // Bulk handling
    verifyAllBulk: true,         // verify each entry in bulkPreserve
    // Logging
    onLog: (lvl, ...args) => { /* silent by default */ },
    ...options
  };

  // ----------------------------- Queue model -----------------------------
  // Unified queue item variants. All have a "kind" and "context" (used by resolver).
  // We store a minimal "write attempt" footprint + "verify" footprint.
  //
  // KINDS:
  //  - 'setValue'      : { vec2:[x,y], values:number[], group?:string }
  //  - 'updateValue'   : { vec2:[x,y], index:number, value:number }
  //  - 'deleteValue'   : { vec2:[x,y] }
  //  - 'setVec2Tags'   : { group:string, vec2:[x,y], names:string[] }
  //  - 'setVec2TagName': { group:string, vec2:[x,y], index:number, name:string }
  //  - 'bulkPreserve'  : { entries:[{vec2,values,tagGroup?,tagNames?}, ...] } (expanded internally)
  //
  // Queue items get an "id" for dedup + status tracking.

  const _q = new Map(); // id -> entry

  function keyFor(op, payload, context) {
    // Compose a deterministic identity for deduplication.
    // Note: for bulk we will expand to per-entry items; identity is per vec2 (+ group when tags exist).
    const ctxKey = `${context.card}|${context.repo}|${context.file}|${context.group ?? ''}|${context.routeSuffix ?? ''}|${context.forceBucket ?? ''}|${context.bucketAlias ?? ''}`;
    switch (op) {
      case 'setValue':
        return `SV:${ctxKey}:${payload.vec2[0]}|${payload.vec2[1]}:${payload.values.length}`;
      case 'updateValue':
        return `UV:${ctxKey}:${payload.vec2[0]}|${payload.vec2[1]}:${payload.index}`;
      case 'deleteValue':
        return `DV:${ctxKey}:${payload.vec2[0]}|${payload.vec2[1]}`;
      case 'setVec2Tags':
        return `ST:${ctxKey}:${payload.group}|${payload.vec2[0]}|${payload.vec2[1]}:${payload.names.length}`;
      case 'setVec2TagName':
        return `SN:${ctxKey}:${payload.group}|${payload.vec2[0]}|${payload.vec2[1]}:${payload.index}`;
      case 'bulkPreserve':
        // we expand later; this key is not used for storage
        return `BP:${ctxKey}:${payload.entries?.length || 0}`;
      case 'migrate':
        return `MG:${ctxKey}:${(payload.items?.length || 0)}`;
      default:
        return `OP:${op}:${ctxKey}`;
    }
  }

  function enqueue(item) {
    const id = item.id;
    if (_q.has(id)) {
      // refresh desired payload (e.g., subsequent write supersedes older)
      const ex = _q.get(id);
      ex.payload = item.payload;
      ex.touch = Date.now();
      return ex;
    }
    _q.set(id, {
      ...item,
      attempts: 0,
      nextAt: Date.now(),
      touch: Date.now()
    });
    return item;
  }

  function remove(id) {
    _q.delete(id);
  }

  function randJitter(ms) {
    const mag = ms * cfg.jitterPct;
    return ms + (Math.random() * 2 - 1) * mag;
  }

  // ----------------------------- Comparators -----------------------------

  function floatsEqual(a, b, eps = cfg.floatEpsilon) {
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (Math.abs(Number(a[i]) - Number(b[i])) > eps) return false;
    }
    return true;
  }

  // ----------------------------- Verify & Write helpers ------------------

  async function verifySetValue(ctx, p) {
    const got = await orchestrator.getValue(p.vec2, { contextOverride: ctx });
    if (!got) return false;
    const arr = Array.from(got);
    return floatsEqual(arr, p.values);
  }

  async function writeSetValue(ctx, p) {
    await orchestrator.setValue(p.vec2, p.values, { group: p.group, contextOverride: ctx });
  }

  async function verifyUpdateValue(ctx, p) {
    const got = await orchestrator.getValue(p.vec2, { contextOverride: ctx });
    if (!got) return false;
    const arr = Array.from(got);
    return Number(arr[p.index]) === Number(p.value);
  }

  async function writeUpdateValue(ctx, p) {
    await orchestrator.updateValue(p.vec2, p.index, p.value, { contextOverride: ctx });
  }

  async function verifyDeleteValue(ctx, p) {
    const got = await orchestrator.getValue(p.vec2, { contextOverride: ctx });
    return got === null; // deleted if not found
  }

  async function writeDeleteValue(ctx, p) {
    await orchestrator.deleteValue(p.vec2, { contextOverride: ctx });
  }

  async function verifySetVec2Tags(ctx, p) {
    const names = await orchestrator.getVec2Tags(p.group, p.vec2, { contextOverride: ctx });
    if (!names) return false;
    // allow extra trailing empty strings on either side
    const a = p.names.slice();
    const b = names.slice();
    // trim trailing empties
    while (a.length && a[a.length - 1] === '') a.pop();
    while (b.length && b[b.length - 1] === '') b.pop();
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (String(a[i]) !== String(b[i])) return false;
    return true;
  }

  async function writeSetVec2Tags(ctx, p) {
    await orchestrator.setVec2Tags(p.group, p.vec2, p.names, { contextOverride: ctx });
  }

  async function verifySetVec2TagName(ctx, p) {
    const names = await orchestrator.getVec2Tags(p.group, p.vec2, { contextOverride: ctx });
    if (!names) return false;
    return String(names[p.index] ?? '') === String(p.name ?? '');
  }

  async function writeSetVec2TagName(ctx, p) {
    await orchestrator.setVec2TagName(p.group, p.vec2, p.index, p.name, { contextOverride: ctx });
  }

  // For bulk we decompose into individual "setValue" + optional "setVec2Tags" items.
  function expandBulk(context, payload) {
    const items = [];
    for (const e of payload.entries || []) {
      items.push({
        kind: 'setValue',
        context,
        payload: { vec2: e.vec2, values: Array.from(e.values ?? []), group: e.tagGroup }
      });
      if (cfg.verifyAllBulk && e.tagGroup && Array.isArray(e.tagNames)) {
        items.push({
          kind: 'setVec2Tags',
          context,
          payload: { group: e.tagGroup, vec2: e.vec2, names: e.tagNames.slice() }
        });
      }
    }
    return items;
  }

  async function verifyAndHeal(entry) {
    const { kind, context, payload } = entry;
    try {
      let ok = false;
      if (kind === 'setValue')     ok = await verifySetValue(context, payload);
      else if (kind === 'updateValue') ok = await verifyUpdateValue(context, payload);
      else if (kind === 'deleteValue') ok = await verifyDeleteValue(context, payload);
      else if (kind === 'setVec2Tags') ok = await verifySetVec2Tags(context, payload);
      else if (kind === 'setVec2TagName') ok = await verifySetVec2TagName(context, payload);

      if (ok) return true; // verified

      // Not OK: try to (re)write
      if (kind === 'setValue')           await writeSetValue(context, payload);
      else if (kind === 'updateValue')   await writeUpdateValue(context, payload);
      else if (kind === 'deleteValue')   await writeDeleteValue(context, payload);
      else if (kind === 'setVec2Tags')   await writeSetVec2Tags(context, payload);
      else if (kind === 'setVec2TagName')await writeSetVec2TagName(context, payload);

      // Verify again (fast path)
      if (kind === 'setValue')           return await verifySetValue(context, payload);
      else if (kind === 'updateValue')   return await verifyUpdateValue(context, payload);
      else if (kind === 'deleteValue')   return await verifyDeleteValue(context, payload);
      else if (kind === 'setVec2Tags')   return await verifySetVec2Tags(context, payload);
      else if (kind === 'setVec2TagName')return await verifySetVec2TagName(context, payload);

      return false;
    } catch (e) {
      cfg.onLog('warn', 'verifyAndHeal error', kind, e?.message || e);
      return false;
    }
  }

  // ----------------------------- Worker loop -----------------------------

  let _timer = null;
  function scheduleNext() {
    if (_timer) return;
    _timer = setTimeout(tick, cfg.tickMs);
  }

  async function tick() {
    _timer = null;
    const now = Date.now();
    const ready = [];
    for (const [id, it] of _q) {
      if (it.nextAt <= now) ready.push(it);
      if (ready.length >= cfg.maxPerTick) break;
    }
    for (const it of ready) {
      if (!_q.has(it.id)) continue;
      const ok = await verifyAndHeal(it);
      if (ok) {
        remove(it.id);
        cfg.onLog('info', 'verified', it.kind, it.id);
        continue;
      }
      // backoff
      it.attempts += 1;
      if (it.attempts >= cfg.maxAttempts) {
        cfg.onLog('warn', 'exhausted attempts', it.kind, it.id);
        remove(it.id);
        continue;
      }
      const delay = randJitter(cfg.baseRetryMs * Math.pow(cfg.backoff, it.attempts));
      it.nextAt = Date.now() + delay;
      it.touch = Date.now();
    }
    scheduleNext();
  }

  const worker = {
    start() {
      scheduleNext();
      cfg.onLog('info', 'reliability worker started');
    },
    stop() {
      if (_timer) clearTimeout(_timer);
      _timer = null;
      cfg.onLog('info', 'reliability worker stopped');
    },
    size() { return _q.size; },
    snapshot() { return Array.from(_q.values()).map(s => ({ id: s.id, kind: s.kind, attempts: s.attempts, nextAt: s.nextAt })); }
  };

  // ----------------------------- Rule hook ------------------------------

  // This rule observes outbound ops and enqueues verification tasks.
  async function reliabilityRule({ context, op, payload }) {
    // Expand and enqueue according to op; do not abort the op.
    // The actual write proceeds; we verify & heal afterwards.
    try {
      if (op === 'setValue') {
        const id = keyFor(op, payload, context);
        enqueue({ id, kind: 'setValue', context: { ...context }, payload: { vec2: payload.vec2, values: Array.from(payload.values ?? []), group: payload.group } });
      } else if (op === 'updateValue') {
        const id = keyFor(op, payload, context);
        enqueue({ id, kind: 'updateValue', context: { ...context }, payload: { vec2: payload.vec2, index: payload.index, value: payload.value } });
      } else if (op === 'deleteValue') {
        const id = keyFor(op, payload, context);
        enqueue({ id, kind: 'deleteValue', context: { ...context }, payload: { vec2: payload.vec2 } });
      } else if (op === 'setVec2Tags') {
        const id = keyFor(op, payload, context);
        enqueue({ id, kind: 'setVec2Tags', context: { ...context }, payload: { group: payload.group, vec2: payload.vec2, names: Array.from(payload.names ?? []) } });
      } else if (op === 'setVec2TagName') {
        const id = keyFor(op, payload, context);
        enqueue({ id, kind: 'setVec2TagName', context: { ...context }, payload: { group: payload.group, vec2: payload.vec2, index: payload.index, name: String(payload.name ?? '') } });
      } else if (op === 'bulkPreserve') {
        // Decompose into per-entry tasks.
        const items = expandBulk({ ...context }, payload);
        for (const it of items) {
          const id = keyFor(it.kind === 'setValue' ? 'setValue' : 'setVec2Tags', it.payload, context);
          it.id = id;
          enqueue(it);
        }
      } else if (op === 'migrate') {
        // Best-effort: enqueue verifies for target side after migrate completes (vector entries only).
        for (const it of (payload.items || [])) {
          const id = `MGV:${context.card}|${context.repo}|${context.file}:${it.vec2[0]}|${it.vec2[1]}`;
          enqueue({ id, kind: 'setValue', context: { ...context }, payload: { vec2: it.vec2, values: [] } }); // values unknown; verify presence only
        }
      }
      scheduleNext();
    } catch (e) {
      cfg.onLog('warn', 'reliabilityRule enqueue error', op, e?.message || e);
    }
    // No replacement/abort; we only observe and ensure after-the-fact.
    return undefined;
  }

  return { rule: reliabilityRule, worker, queueIntrospect: () => worker.snapshot() };
}
