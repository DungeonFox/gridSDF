// vec2BucketManager.js
// A drop-in “manager” that encapsulates the full functionality you exercised in index.html,
// exposing a clean, UI-free API for apps/tests/workers.
//
// Dependencies (place alongside this file):
//   - bucketOrchestrator.js
//   - vec2StorageManager.js
//   - myEdgeCaseLibrary.js
//   - reliabilityEdgeRule.js
//
// Usage (ESM):
//   import Vec2BucketManager from './vec2BucketManager.js';
//   const mgr = await Vec2BucketManager.create({
//     context: { card:'c001', repo:'0xb1', file:'0xf1', group:'chem' },
//     rules:   { shard:{enabled:true,sizeX:256,sizeY:256}, throttleMs:60 },
//     reliability: { tickMs:150, maxAttempts:10 },
//   });
//   await mgr.setValue([10,20], [1,2,3], { group:'chem' });
//   const withNames = await mgr.getValueWithNames([10,20], { group:'chem' });
//
// Notes:
//   - Buckets are ALWAYS sanitized/lowercased by resolver here.
//   - Rule packs can be replaced at runtime (hard throttle preserved by default).
//   - Reliability worker (verify+heal queue) can be started/stopped on demand.
//   - All orchestrator public methods are surfaced 1:1 with optional contextOverride.

import BucketOrchestrator from './bucketOrchestrator.js';
import buildRules, { defaultEdgeOptions as _edgeDefaults } from './myEdgeCaseLibrary.js';
import installReliability from './reliabilityEdgeRule.js';

// ---------- defaults ----------
const defaultResolver = (ctx) => {
  const base = (ctx.baseBucket && String(ctx.baseBucket)) ||
               (`${ctx.card}${ctx.repo}${ctx.file}statecapture`);
  const suffix = ctx.routeSuffix ? String(ctx.routeSuffix) : '';
  return (base + suffix).toLowerCase().replace(/[^a-z0-9-]/g, '');
};

const defaultManagerOptions = {
  dbName: 'Vec2DB',
  dbVersion: 1,
  context: { card: 'c001', repo: '0xb1', file: '0xf1', group: 'default' },
  resolver: defaultResolver,
  // myEdgeCaseLibrary options (hard throttle behavior kept)
  rules: {
    contextDefaults: _edgeDefaults.contextDefaults,
    shard: { enabled: true, sizeX: 256, sizeY: 256 },
    timeSlicing: { enabled: false, timeSliceOps: new Set(['bulkPreserve']) },
    throttleMs: 60,
    maxValuesPerWrite: 8192,
    maxBulkEntries: 5000,
    aliasMap: { work: (ctx) => `${ctx.card}${ctx.repo}${ctx.file}statecapture` },
  },
  reliability: {
    enabled: true,
    tickMs: 150,
    maxAttempts: 10,
    onLog: null, // (level,...args)=>void
  },
  onLog: null, // (level,...args)=>void
};

// ---------- helper ----------
function noop() {}
function makeLogger(cb) {
  return typeof cb === 'function' ? cb : noop;
}

function cloneTimeSliceOps(value, fallback) {
  const source = value ?? fallback;
  if (source instanceof Set) return new Set(source);
  if (Array.isArray(source)) return new Set(source);
  return source ?? new Set();
}

function normalizeRules(base, overrides = {}) {
  const merged = { ...base, ...(overrides || {}) };
  merged.shard = { ...base.shard, ...(overrides.shard || {}) };
  merged.timeSlicing = { ...base.timeSlicing, ...(overrides.timeSlicing || {}) };
  merged.timeSlicing.timeSliceOps = cloneTimeSliceOps(
    overrides.timeSlicing?.timeSliceOps,
    base.timeSlicing?.timeSliceOps
  );
  return merged;
}

function normalizeManagerOptions(opts = {}) {
  const rulesOverrides = opts.rules || {};
  const reliabilityOverrides = opts.reliability || {};
  const merged = {
    ...defaultManagerOptions,
    ...opts,
    context: { ...defaultManagerOptions.context, ...(opts.context || {}) },
    resolver: typeof opts.resolver === 'function' ? opts.resolver : defaultManagerOptions.resolver,
    rules: normalizeRules(defaultManagerOptions.rules, rulesOverrides),
    reliability: {
      ...defaultManagerOptions.reliability,
      ...reliabilityOverrides,
    },
  };

  if (typeof merged.reliability.onLog !== 'function') {
    merged.reliability.onLog = defaultManagerOptions.reliability.onLog;
  }
  merged.onLog = typeof opts.onLog === 'function' ? opts.onLog : defaultManagerOptions.onLog;
  return merged;
}

// ---------- manager ----------
export default class Vec2BucketManager {
  /**
   * Factory that constructs, init()s, and returns a ready manager.
   * @param {Partial<typeof defaultManagerOptions>} opts
   */
  static async create(opts = {}) {
    const mgr = new Vec2BucketManager(opts);
    await mgr.init(opts.context);
    // Apply initial default pack and reliability (if enabled)
    await mgr.applyRules(opts.rules);
    if (mgr._reliability?.worker && opts?.reliability?.enabled !== false) {
      mgr._reliability.worker.start();
    }
    return mgr;
  }

  constructor(opts = {}) {
    this.options = normalizeManagerOptions(opts);
    // wire logs
    this._log = makeLogger(this.options.onLog);
    // base orchestrator
    this._orch = new BucketOrchestrator({
      bucketNameResolver: this.options.resolver || defaultResolver,
      dbName: this.options.dbName,
      dbVersion: this.options.dbVersion,
      onLog: (lvl, ...args) => this._log(`orch:${lvl}`, ...args),
    });
    // reliability is installed on-demand in applyRules()
    this._reliability = null;
  }

  /** Initialize base storage context */
  async init(context = this.options.context) {
    this._baseContext = { ...this.options.context, ...context };
    await this._orch.init(this._baseContext);
    this._log('mgr:info', 'initialized', JSON.stringify(this._baseContext));
  }

  /**
   * Replace the rule pack with new options (clears previously registered rules),
   * then re-attaches the reliability rule if it was installed.
   * @param {object} ruleOptions
   */
  async applyRules(ruleOptions = {}) {
    // clear current rules (default pack + customs)
    if (Array.isArray(this._orch._rules)) this._orch._rules.length = 0;

    // merge with last-used or defaults
    this.options.rules = normalizeRules(this.options.rules, ruleOptions || {});
    const pack = buildRules(this.options.rules);
    this._orch.registerRule(pack);

    // (Re)install reliability layer if requested
    const relCfg = this.options.reliability || {};
    if (relCfg && relCfg.enabled !== false) {
      // If already installed, keep the same worker instance but re-attach rule
      if (!this._reliability) {
        this._reliability = installReliability(this._orch, {
          ...relCfg,
          onLog: (lvl, ...m) => (relCfg.onLog ? relCfg.onLog(lvl, ...m) : this._log(`reliability:${lvl}`, ...m)),
        });
      }
      this._orch.registerRule(this._reliability.rule);
    }

    this._log('mgr:info', 'rules applied', {
      throttleMs: this.options.rules.throttleMs,
      shard: this.options.rules.shard,
      timeSlicing: !!this.options.rules.timeSlicing?.enabled,
    });
  }

  /** Start/stop reliability worker explicitly */
  startReliability() { this._reliability?.worker?.start?.(); }
  stopReliability()  { this._reliability?.worker?.stop?.(); }
  reliabilityQueueSize() { return this._reliability?.worker?.size?.() ?? 0; }
  reliabilitySnapshot()  { return this._reliability?.queueIntrospect?.() ?? []; }

  /** Swap resolver at runtime (e.g., blue/green cutover) */
  setResolver(fn) {
    const resolver = typeof fn === 'function' ? fn : defaultResolver;
    this.options.resolver = resolver;
    this._orch.resolveBucket = resolver;
    this._log('mgr:info', 'resolver updated');
  }

  /** Update base DB options (re-creates internal orchestrator). Call BEFORE heavy use. */
  reconfigureDB({ dbName, dbVersion } = {}) {
    if (dbName) this.options.dbName = dbName;
    if (dbVersion) this.options.dbVersion = dbVersion;
    // rebuild orchestrator with same context and rules
    const prevRel = this._reliability;
    this._orch = new BucketOrchestrator({
      bucketNameResolver: this.options.resolver || defaultResolver,
      dbName: this.options.dbName,
      dbVersion: this.options.dbVersion,
      onLog: (lvl, ...args) => this._log(`orch:${lvl}`, ...args),
    });
    // re-init + re-apply rules + re-attach reliability
    return this.init(this._baseContext).then(() => this.applyRules(this.options.rules)).then(() => {
      if (prevRel?.worker && this.options.reliability?.enabled !== false) {
        // reliability was already installed and running; start it again
        this._reliability?.worker?.start?.();
      }
    });
  }

  /** Replace/merge base context; affects subsequent calls (unless contextOverride provided per call) */
  setBaseContext(ctx = {}) {
    this._baseContext = { ...this._baseContext, ...ctx };
    this._log('mgr:info', 'base context updated', JSON.stringify(this._baseContext));
  }

  /** Clear orchestrator caches (does not delete data) */
  resetCache() { this._orch.resetCache(); }

  // ------------------- PUBLIC API (thin wrappers) -------------------

  // value ops
  async setValue(vec2, values, opts = {}) {
    return this._orch.setValue(vec2, values, this._withCtx(opts));
  }
  async getValue(vec2, opts = {}) {
    return this._orch.getValue(vec2, this._withCtx(opts));
  }
  async getValueWithNames(vec2, opts = {}) {
    return this._orch.getValueWithNames(vec2, this._withCtx(opts));
  }
  async updateValue(vec2, index, value, opts = {}) {
    return this._orch.updateValue(vec2, index, value, this._withCtx(opts));
  }
  async deleteValue(vec2, opts = {}) {
    return this._orch.deleteValue(vec2, this._withCtx(opts));
  }

  // tag ops
  async setVec2Tags(group, vec2, names, opts = {}) {
    return this._orch.setVec2Tags(group, vec2, names, this._withCtx(opts));
  }
  async setVec2TagName(group, vec2, index, name, opts = {}) {
    return this._orch.setVec2TagName(group, vec2, index, name, this._withCtx(opts));
  }
  async getVec2Tags(group, vec2, opts = {}) {
    return this._orch.getVec2Tags(group, vec2, this._withCtx(opts));
  }
  async deleteVec2Tags(group, vec2, opts = {}) {
    return this._orch.deleteVec2Tags(group, vec2, this._withCtx(opts));
  }

  // bulk & migration
  async bulkPreserve(entries, opts = {}) {
    return this._orch.bulkPreserve(entries, this._withCtx(opts));
  }
  async migrate({ fromContext, toContext, items }) {
    return this._orch.migrate({ fromContext, toContext, items });
  }

  // rule management (advanced)
  /** Register a custom rule (called AFTER the default pack & reliability). */
  registerRule(ruleFn) {
    this._orch.registerRule(ruleFn);
    this._log('mgr:info', 'custom rule registered');
  }

  // -------------- internals --------------
  _withCtx(opts) {
    const { contextOverride, ...rest } = opts || {};
    return {
      ...rest,
      contextOverride: contextOverride ? { ...this._baseContext, ...contextOverride } : this._baseContext
    };
  }
}
