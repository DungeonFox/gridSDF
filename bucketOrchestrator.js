// bucketOrchestrator.js
// A mostly-standalone controller module that is "directed" by an external
// edge-case library to contextually manage Storage Buckets and delegate vec2
// reads/writes to your existing Vec2StorageManager.
//
// How it works
// - You register edge-case rules (sync or async). Rules receive {context, op, payload}
//   and may: (a) mutate context, (b) veto or reroute the op, (c) change bucket name,
//   (d) request retries/migrations, (e) apply custom tag policies.
// - You provide a bucketNameResolver(context) → string. It’s sanitized/lowercased.
// - The orchestrator ensures bucket/DB availability, then delegates to Vec2StorageManager.
// - Includes: retry policy, validation, migration between buckets, and bulk preservation.
//
// Dependencies: ./vec2StorageManager.js (the module you already have)
//
// Example usage (outside this file):
//   import Orchestrator from './bucketOrchestrator.js';
//   import rules from './myEdgeCaseLibrary.js';
//   const orch = new Orchestrator({ bucketNameResolver: ctx => `${ctx.card}${ctx.repo}${ctx.file}statecapture` });
//   orch.registerRules(rules);
//   await orch.init({ card:'c001', repo:'0xb1', file:'0xf1' });
//   await orch.setValue([10,20], [1,2,3], { group:'chem' });
//   const got = await orch.getValueWithNames([10,20], { group:'chem' });
//
// Notes
// - Bucket names are force-lowercased and sanitized to [a-z0-9-]. (Hyphens kept, others dropped.)
// - If Storage Buckets API is unavailable, falls back to window.indexedDB inside orchestrated flow.
// - All public methods accept an optional {contextOverride} to re-resolve bucket per call.

import Vec2StorageManager from './vec2StorageManager.js';

export default class BucketOrchestrator {
  /**
   * @param {object} opts
   *  - bucketNameResolver(context): (required) function -> string bucket name (any case); will be sanitized/lowercased.
   *  - dbName: string (default 'Vec2DB')
   *  - dbVersion: number (default 1)
   *  - dataStore: string (default 'vec2Data')
   *  - tagStore: string (default 'vec2Tags')
   *  - retry: { attempts:number, delayMs:number } (default {attempts:2, delayMs:80})
   *  - forbidEmptyBucket: boolean (default true)
   *  - onLog: (level, ...args) => void (optional)
   */
  constructor(opts = {}) {
    if (typeof opts.bucketNameResolver !== 'function') {
      throw new Error('bucketNameResolver(context) is required');
    }
    this.resolveBucket = opts.bucketNameResolver;
    this.dbName = opts.dbName ?? 'Vec2DB';
    this.dbVersion = opts.dbVersion ?? 1;
    this.dataStore = opts.dataStore ?? 'vec2Data';
    this.tagStore = opts.tagStore ?? 'vec2Tags';
    this.retry = Object.assign({ attempts: 2, delayMs: 80 }, opts.retry || {});
    this.forbidEmptyBucket = opts.forbidEmptyBucket ?? true;
    this.log = typeof opts.onLog === 'function' ? opts.onLog : () => {};

    /** @type {Map<string, Vec2StorageManager>} */
    this._storeCache = new Map();
    /** @type {Array<Function>} rule fns: (ctx, op) => RuleResult|void */
    this._rules = [];
    this._baseContext = null;
  }

  // ---------------------- Edge-case rules API ----------------------

  /**
   * Register one or more rule functions.
   * A rule receives: ({ context, op, payload, orchestrator }) and can:
   *  - mutate context (e.g., context.card = 'c002')
   *  - return { rerouteBucketName?, abort?, replacePayload?, delayMs?, retry? }
   */
  registerRule(ruleFnOrArray) {
    const arr = Array.isArray(ruleFnOrArray) ? ruleFnOrArray : [ruleFnOrArray];
    for (const fn of arr) {
      if (typeof fn !== 'function') throw new Error('rule must be a function');
      this._rules.push(fn);
    }
  }

  async _applyRules(op, payload, context) {
    let ctx = { ...(this._baseContext || {}), ...(context || {}) };
    let pl = payload;
    let reroute = null;
    for (const fn of this._rules) {
      const res = await Promise.resolve(fn({ context: ctx, op, payload: pl, orchestrator: this }));
      if (!res) continue;
      if (res.abort) throw new Error(`Operation "${op}" aborted by edge-case rule`);
      if (res.replacePayload !== undefined) pl = res.replacePayload;
      if (typeof res.rerouteBucketName === 'string') reroute = res.rerouteBucketName;
      if (typeof res.delayMs === 'number' && res.delayMs > 0) {
        await new Promise(r => setTimeout(r, res.delayMs));
      }
      if (res.retry && typeof res.retry === 'object') {
        // Allow a rule to override retry behavior for the next execution frame.
        this._lastRuleRetry = res.retry;
      }
    }
    return { context: ctx, payload: pl, rerouteBucketName: reroute };
  }

  // ---------------------- Init / store resolution ----------------------

  /**
   * Initialize orchestrator with a base context (e.g., {card, repo, file, group})
   */
  async init(baseContext = {}) {
    this._baseContext = { ...baseContext };
    // Pre-resolve bucket lazily; do nothing here to allow rules to intervene on first op.
    this.log('info', 'Orchestrator initialized', this._baseContext);
  }

  _sanitizeBucketName(name) {
    if (typeof name !== 'string') name = String(name ?? '');
    // keep [a-z0-9-], drop others; lowercase
    return name.toLowerCase().replace(/[^a-z0-9-]/g, '');
  }

  _bucketKeyFromContext(ctx, explicitReroute) {
    const raw = explicitReroute ?? this.resolveBucket(ctx);
    const sanitized = this._sanitizeBucketName(raw);
    if (!sanitized && this.forbidEmptyBucket) {
      throw new Error('Resolved empty bucket name (forbidden). Provide a valid context or resolver.');
    }
    return sanitized || 'default-bucket';
  }

  async _getStoreForContext(ctx, rerouteName) {
    const bucketName = this._bucketKeyFromContext(ctx, rerouteName);
    if (this._storeCache.has(bucketName)) return this._storeCache.get(bucketName);

    const store = new Vec2StorageManager(bucketName, {
      dbName: this.dbName,
      dbVersion: this.dbVersion,
      dataStore: this.dataStore,
      tagStore: this.tagStore
    });
    await store.init();
    this._storeCache.set(bucketName, store);
    return store;
  }

  // ---------------------- Retry wrapper ----------------------

  async _withRetry(fn, opLabel) {
    const policy = this._lastRuleRetry || this.retry;
    this._lastRuleRetry = null;
    let attempt = 0;
    let delay = policy.delayMs;
    let lastErr;
    while (attempt < policy.attempts) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        this.log('warn', `${opLabel} failed (attempt ${attempt + 1}/${policy.attempts})`, e?.message || e);
        if (attempt + 1 >= policy.attempts) break;
        await new Promise(r => setTimeout(r, delay));
        delay *= 1.4; // backoff
      }
      attempt++;
    }
    throw lastErr;
  }

  // ---------------------- Public data operations ----------------------

  async setValue(vec2, values, { group, contextOverride } = {}) {
    const op = 'setValue';
    const { context, payload, rerouteBucketName } = await this._applyRules(op, { vec2, values, group }, contextOverride);
    return this._withRetry(async () => {
      const store = await this._getStoreForContext(context, rerouteBucketName);
      // Optional: rule may request pre-tag policy (e.g., ensure name slots)
      if (Array.isArray(context.ensureNameSlots) && typeof group === 'string') {
        const cur = (await store.getVec2Tags(group, vec2)) ?? [];
        const len = Math.max(cur.length, context.ensureNameSlots.length);
        const names = new Array(len).fill('');
        for (let i = 0; i < len; i++) names[i] = context.ensureNameSlots[i] ?? cur[i] ?? '';
        await store.setVec2Tags(group, vec2, names);
      }
      return store.setValue(payload.vec2, payload.values);
    }, op);
  }

  async getValue(vec2, { contextOverride } = {}) {
    const op = 'getValue';
    const { context, rerouteBucketName } = await this._applyRules(op, { vec2 }, contextOverride);
    return this._withRetry(async () => {
      const store = await this._getStoreForContext(context, rerouteBucketName);
      return store.getValue(vec2);
    }, op);
  }

  async getValueWithNames(vec2, { group, contextOverride } = {}) {
    const op = 'getValueWithNames';
    const { context, payload, rerouteBucketName } = await this._applyRules(op, { vec2, group }, contextOverride);
    return this._withRetry(async () => {
      const store = await this._getStoreForContext(context, rerouteBucketName);
      return store.getValueWithNames(payload.vec2, payload.group);
    }, op);
  }

  async updateValue(vec2, index, value, { contextOverride } = {}) {
    const op = 'updateValue';
    const { context, payload, rerouteBucketName } = await this._applyRules(op, { vec2, index, value }, contextOverride);
    return this._withRetry(async () => {
      const store = await this._getStoreForContext(context, rerouteBucketName);
      return store.updateValue(payload.vec2, payload.index, payload.value);
    }, op);
  }

  async deleteValue(vec2, { contextOverride } = {}) {
    const op = 'deleteValue';
    const { context, payload, rerouteBucketName } = await this._applyRules(op, { vec2 }, contextOverride);
    return this._withRetry(async () => {
      const store = await this._getStoreForContext(context, rerouteBucketName);
      return store.deleteValue(payload.vec2);
    }, op);
  }

  // ---------------------- Tag operations ----------------------

  async setVec2Tags(group, vec2, names, { contextOverride } = {}) {
    const op = 'setVec2Tags';
    const { context, payload, rerouteBucketName } = await this._applyRules(op, { group, vec2, names }, contextOverride);
    return this._withRetry(async () => {
      const store = await this._getStoreForContext(context, rerouteBucketName);
      return store.setVec2Tags(payload.group, payload.vec2, payload.names);
    }, op);
  }

  async setVec2TagName(group, vec2, index, name, { contextOverride } = {}) {
    const op = 'setVec2TagName';
    const { context, payload, rerouteBucketName } = await this._applyRules(op, { group, vec2, index, name }, contextOverride);
    return this._withRetry(async () => {
      const store = await this._getStoreForContext(context, rerouteBucketName);
      return store.setVec2TagName(payload.group, payload.vec2, payload.index, payload.name);
    }, op);
  }

  async getVec2Tags(group, vec2, { contextOverride } = {}) {
    const op = 'getVec2Tags';
    const { context, payload, rerouteBucketName } = await this._applyRules(op, { group, vec2 }, contextOverride);
    return this._withRetry(async () => {
      const store = await this._getStoreForContext(context, rerouteBucketName);
      return store.getVec2Tags(payload.group, payload.vec2);
    }, op);
  }

  async deleteVec2Tags(group, vec2, { contextOverride } = {}) {
    const op = 'deleteVec2Tags';
    const { context, payload, rerouteBucketName } = await this._applyRules(op, { group, vec2 }, contextOverride);
    return this._withRetry(async () => {
      const store = await this._getStoreForContext(context, rerouteBucketName);
      return store.deleteVec2Tags(payload.group, payload.vec2);
    }, op);
  }

  // ---------------------- Bulk preservation ----------------------

  /**
   * bulkPreserve with context-aware routing and optional rule-driven transforms.
   * entries: [{ vec2:[x,y], values:number[], tagGroup?:string, tagNames?:string[] }, ...]
   */
  async bulkPreserve(entries, { contextOverride } = {}) {
    const op = 'bulkPreserve';
    const { context, payload, rerouteBucketName } = await this._applyRules(op, { entries }, contextOverride);
    return this._withRetry(async () => {
      const store = await this._getStoreForContext(context, rerouteBucketName);
      const toWrite = Array.isArray(payload.entries) ? payload.entries : [];
      return store.bulkPreserve(toWrite);
    }, op);
  }

  // ---------------------- Migrations & Utilities ----------------------

  /**
   * Migrate a set of vec2 keys (and optional tags) from oldContext → newContext in bulk.
   * You provide a list of {vec2, includeTags?:boolean, groups?:string[]}
   */
  async migrate({ fromContext, toContext, items }) {
    const fromStore = await this._getStoreForContext(fromContext);
    const toStore = await this._getStoreForContext(toContext);

    // Read all entries first
    const payload = [];
    for (const it of items || []) {
      const arr = await fromStore.getValue(it.vec2);
      if (arr) {
        payload.push({ vec2: it.vec2, values: Array.from(arr) });
      }
    }
    const res = await toStore.bulkPreserve(payload);

    // Copy tags if requested
    let tagged = 0;
    for (const it of items || []) {
      if (!it.includeTags) continue;
      const groups = Array.isArray(it.groups) && it.groups.length ? it.groups : [ 'default' ];
      for (const g of groups) {
        const names = await fromStore.getVec2Tags(g, it.vec2);
        if (names && names.length) {
          await toStore.setVec2Tags(g, it.vec2, names);
          tagged++;
        }
      }
    }
    return { written: res.written, tagged: res.tagged + tagged };
  }

  /**
   * Forget all cached store instances (does not delete data).
   */
  resetCache() {
    this._storeCache.clear();
  }
}
