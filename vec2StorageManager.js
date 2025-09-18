// vec2StorageManager.js
// Standalone module for a Storage Bucket + IndexedDB where:
//   • Data store "vec2Data": key = "<x>|<y>", value = { key, values: Float64Array }
//   • Tag store  "vec2Tags": key = "<group>|<x>|<y>", value = { key, names: string[] }
// Requirements:
//   • Bucket name is forced to lowercase.
//   • Storage Buckets API used if available; otherwise falls back to global indexedDB.

export default class Vec2StorageManager {
  /**
   * @param {string} bucketName  Storage Bucket name (will be lowercased).
   * @param {object} options
   *   options.dbName     : string (default "Vec2DB")
   *   options.dbVersion  : number (default 1)
   *   options.dataStore  : string (default "vec2Data")
   *   options.tagStore   : string (default "vec2Tags")
   */
  constructor(bucketName, options = {}) {
    this.bucketName  = (bucketName || 'vec2bucket').toLowerCase();
    this.dbName      = options.dbName ?? 'Vec2DB';
    this.dbVersion   = options.dbVersion ?? 1;
    this.dataStore   = options.dataStore ?? 'vec2Data';
    this.tagStore    = options.tagStore ?? 'vec2Tags';

    this.bucket = null;
    this.idb    = null; // Reference to proper indexedDB (bucket.indexedDB or window.indexedDB)
    this._openDBPromise = null;
  }

  // ---------- Bucket & DB bootstrap ----------

  async init() {
    this.bucket = await this._openBucket(this.bucketName);
    this.idb    = this.bucket?.indexedDB ?? window.indexedDB;

    // One-shot open/upgrade
    await this._openDB();
  }

  async _openBucket(name) {
    if (!('storageBuckets' in navigator)) {
      // Fallback, still usable with window.indexedDB
      return null;
    }
    // Cache buckets on window
    window.openBuckets = window.openBuckets || new Map();
    if (window.openBuckets.has(name)) return window.openBuckets.get(name);
    const bucket = await navigator.storageBuckets.open(name);
    window.openBuckets.set(name, bucket);
    return bucket;
  }

  async _openDB() {
    if (this._openDBPromise) return this._openDBPromise;
    this._openDBPromise = new Promise((resolve, reject) => {
      const req = this.idb.open(this.dbName, this.dbVersion);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(this.dataStore)) {
          db.createObjectStore(this.dataStore, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(this.tagStore)) {
          db.createObjectStore(this.tagStore, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve();
      req.onerror = () => reject(new Error(`Failed to open ${this.dbName}: ${req.error}`));
    });
    return this._openDBPromise;
  }

  // ---------- Key helpers (order-preserving) ----------

  // Data key: "<x>|<y>"
  _k(vec2) {
    if (!Array.isArray(vec2) || vec2.length !== 2) throw new Error('vec2 must be [x, y]');
    const [x, y] = vec2;
    return `${x}|${y}`;
  }

  // Tag key: "<group>|<x>|<y>"
  _tk(group, vec2) {
    if (typeof group !== 'string' || !group.length) throw new Error('group must be a non-empty string');
    return `${group}|${this._k(vec2)}`;
  }

  // ---------- Low-level transaction helpers ----------

  _tx(storeNames, mode = 'readonly') {
    return new Promise((resolve, reject) => {
      const openReq = this.idb.open(this.dbName, this.dbVersion);
      openReq.onsuccess = () => {
        const db = openReq.result;
        const tx = db.transaction(storeNames, mode);
        resolve({ db, tx });
      };
      openReq.onerror = () => reject(new Error(`Failed to open ${this.dbName}: ${openReq.error}`));
    });
  }

  // ---------- Data CRUD ----------

  /**
   * Stores float values at a vec2 key.
   * @param {number[]} vec2      [x, y]
   * @param {number[]|Float32Array|Float64Array} values
   */
  async setValue(vec2, values) {
    await this._openDB();
    const key = this._k(vec2);
    // Persist as plain array, reconstruct to Float64Array on get.
    const payload = { key, values: Array.from(values, v => Number(v)) };

    const { db, tx } = await this._tx([this.dataStore], 'readwrite');
    await new Promise((res, rej) => {
      const store = tx.objectStore(this.dataStore);
      const r = store.put(payload);
      r.onsuccess = () => res();
      r.onerror = () => rej(new Error(`setValue failed: ${r.error}`));
    });
    await new Promise((res, rej) => {
      tx.oncomplete = () => { db.close(); res(); };
      tx.onerror = () => rej(new Error(`Transaction error: ${tx.error}`));
    });
    return true;
  }

  /**
   * Gets float array for vec2 key, reconstructed as Float64Array.
   * @param {number[]} vec2  [x, y]
   * @returns {Promise<Float64Array|null>}
   */
  async getValue(vec2) {
    await this._openDB();
    const key = this._k(vec2);

    const { db, tx } = await this._tx([this.dataStore], 'readonly');
    const out = await new Promise((res, rej) => {
      const store = tx.objectStore(this.dataStore);
      const r = store.get(key);
      r.onsuccess = () => {
        const row = r.result;
        if (!row) return res(null);
        const arr = Array.isArray(row.values) ? row.values : [];
        res(new Float64Array(arr));
      };
      r.onerror = () => rej(new Error(`getValue failed: ${r.error}`));
    });
    db.close();
    return out;
  }

  /**
   * Updates one index in the float array at vec2 (grows array if needed).
   */
  async updateValue(vec2, index, value) {
    const current = (await this.getValue(vec2)) ?? new Float64Array([]);
    const newLen = Math.max(current.length, index + 1);
    const next = new Float64Array(newLen);
    next.set(current);
    next[index] = Number(value);
    return this.setValue(vec2, next);
  }

  /**
   * Deletes a vec2 record.
   */
  async deleteValue(vec2) {
    await this._openDB();
    const key = this._k(vec2);

    const { db, tx } = await this._tx([this.dataStore], 'readwrite');
    await new Promise((res, rej) => {
      const store = tx.objectStore(this.dataStore);
      const r = store.delete(key);
      r.onsuccess = () => res();
      r.onerror = () => rej(new Error(`deleteValue failed: ${r.error}`));
    });
    await new Promise((res, rej) => {
      tx.oncomplete = () => { db.close(); res(); };
      tx.onerror = () => rej(new Error(`Transaction error: ${tx.error}`));
    });
    return true;
  }

  // ---------- Tag APIs (multiple names per vec2 tag set) ----------

  /**
   * Sets the full name array for a tag group at vec2.
   * @param {string} group
   * @param {number[]} vec2
   * @param {string[]} names  // multiple names allowed
   */
  async setVec2Tags(group, vec2, names) {
    await this._openDB();
    const key = this._tk(group, vec2);
    const clean = Array.from(names ?? [], n => (n == null ? '' : String(n)));

    const { db, tx } = await this._tx([this.tagStore], 'readwrite');
    await new Promise((res, rej) => {
      const store = tx.objectStore(this.tagStore);
      const r = store.put({ key, names: clean });
      r.onsuccess = () => res();
      r.onerror = () => rej(new Error(`setVec2Tags failed: ${r.error}`));
    });
    await new Promise((res, rej) => {
      tx.oncomplete = () => { db.close(); res(); };
      tx.onerror = () => rej(new Error(`Transaction error: ${tx.error}`));
    });
    return true;
  }

  /**
   * Adds or updates a single tag name at index for a tag group at vec2.
   * Auto-expands the name array.
   */
  async setVec2TagName(group, vec2, index, name) {
    const record = (await this.getVec2Tags(group, vec2)) ?? [];
    const nextLen = Math.max(record.length, index + 1);
    const next = new Array(nextLen).fill('');
    for (let i = 0; i < record.length; i++) next[i] = record[i] ?? '';
    next[index] = String(name ?? '');
    return this.setVec2Tags(group, vec2, next);
  }

  /**
   * Gets the name array for a tag group at vec2 (string[] or null).
   */
  async getVec2Tags(group, vec2) {
    await this._openDB();
    const key = this._tk(group, vec2);

    const { db, tx } = await this._tx([this.tagStore], 'readonly');
    const out = await new Promise((res, rej) => {
      const store = tx.objectStore(this.tagStore);
      const r = store.get(key);
      r.onsuccess = () => res(r.result ? (Array.isArray(r.result.names) ? r.result.names : []) : null);
      r.onerror = () => rej(new Error(`getVec2Tags failed: ${r.error}`));
    });
    db.close();
    return out;
  }

  /**
   * Deletes the tag array for a tag group at vec2.
   */
  async deleteVec2Tags(group, vec2) {
    await this._openDB();
    const key = this._tk(group, vec2);

    const { db, tx } = await this._tx([this.tagStore], 'readwrite');
    await new Promise((res, rej) => {
      const store = tx.objectStore(this.tagStore);
      const r = store.delete(key);
      r.onsuccess = () => res();
      r.onerror = () => rej(new Error(`deleteVec2Tags failed: ${r.error}`));
    });
    await new Promise((res, rej) => {
      tx.oncomplete = () => { db.close(); res(); };
      tx.onerror = () => rej(new Error(`Transaction error: ${tx.error}`));
    });
    return true;
  }

  // ---------- Joined read ----------

  /**
   * Gets data for vec2 and aligns with names from a given tag group.
   * If names are missing or shorter, unnamed positions are filled with "(unnamed)".
   * @returns {Promise<{vec2:number[], values:Float64Array, names:string[]}|null>}
   */
  async getValueWithNames(vec2, group) {
    const values = await this.getValue(vec2);
    if (!values) return null;

    const names = (group ? await this.getVec2Tags(group, vec2) : null) ?? [];
    const outNames = Array.from({ length: values.length }, (_, i) => names[i] ?? '(unnamed)');

    return { vec2: [vec2[0], vec2[1]], values, names: outNames };
  }

  // ---------- BULK PRESERVATION ----------

  /**
   * Bulk write for many vec2 entries and optional tag sets in ONE transaction.
   * @param {Array<{
   *   vec2: [number,number],
   *   values: number[]|Float32Array|Float64Array,
   *   tagGroup?: string,
   *   tagNames?: string[]
   * }>} entries
   * @returns {Promise<{written:number, tagged:number}>}
   */
  async bulkPreserve(entries) {
    await this._openDB();
    if (!Array.isArray(entries) || !entries.length) return { written: 0, tagged: 0 };

    const { db, tx } = await this._tx([this.dataStore, this.tagStore], 'readwrite');
    const dataStore = tx.objectStore(this.dataStore);
    const tagStore  = tx.objectStore(this.tagStore);

    let written = 0, tagged = 0;

    await new Promise((resolve, reject) => {
      let pending = 0, failed = false;

      const done = () => {
        if (failed) return;
        if (pending === 0) resolve();
      };

      for (const e of entries) {
        const key = this._k(e.vec2);
        const payload = { key, values: Array.from(e.values ?? [], v => Number(v)) };

        pending++;
        const pr = dataStore.put(payload);
        pr.onsuccess = () => { written++; if (--pending === 0) done(); };
        pr.onerror   = () => { failed = true; reject(new Error(`bulkPreserve data put failed: ${pr.error}`)); };

        if (e.tagGroup && e.tagNames) {
          const tKey = this._tk(e.tagGroup, e.vec2);
          pending++;
          const tr = tagStore.put({ key: tKey, names: Array.from(e.tagNames, s => String(s ?? '')) });
          tr.onsuccess = () => { tagged++; if (--pending === 0) done(); };
          tr.onerror   = () => { failed = true; reject(new Error(`bulkPreserve tag put failed: ${tr.error}`)); };
        }
      }

      // Edge case: if no puts were scheduled (shouldn’t happen given entries.length), resolve.
      if (pending === 0) resolve();
    });

    await new Promise((res, rej) => {
      tx.oncomplete = () => { db.close(); res(); };
      tx.onerror    = () => rej(new Error(`Transaction error: ${tx.error}`));
    });

    return { written, tagged };
  }
}
