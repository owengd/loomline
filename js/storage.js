/* Small IndexedDB key-value store with a memory fallback (private windows, blocked storage). */
(function (root) {
  'use strict';
  const mem = new Map();
  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve) => {
      try {
        const req = indexedDB.open('schematic-tracer', 1);
        req.onupgradeneeded = () => { req.result.createObjectStore('kv'); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch (e) { resolve(null); }
    });
    return dbp;
  }
  async function tx(mode, fn) {
    const db = await open();
    if (!db) return fn(null);
    return new Promise((resolve) => {
      try {
        const t = db.transaction('kv', mode);
        const store = t.objectStore('kv');
        const r = fn(store);
        t.oncomplete = () => resolve(typeof IDBRequest !== 'undefined' && r instanceof IDBRequest ? r.result : r);
        t.onerror = () => resolve(undefined);
        t.onabort = () => resolve(undefined);
      } catch (e) { resolve(undefined); }
    });
  }
  const Store = {
    async get(key) {
      if (mem.has(key)) return mem.get(key);
      const v = await tx('readonly', (s) => (s ? s.get(key) : undefined));
      return v === null ? undefined : v;
    },
    async set(key, value) {
      mem.set(key, value);
      await tx('readwrite', (s) => s && s.put(value, key));
    },
    async del(key) {
      mem.delete(key);
      await tx('readwrite', (s) => s && s.delete(key));
    },
    async clearPrefix(prefix) {
      for (const k of Array.from(mem.keys())) if (k.startsWith(prefix)) mem.delete(k);
      const db = await open();
      if (!db) return;
      await new Promise((resolve) => {
        try {
          const t = db.transaction('kv', 'readwrite');
          const s = t.objectStore('kv');
          const req = s.openCursor();
          req.onsuccess = () => { const c = req.result; if (c) { if (String(c.key).startsWith(prefix)) c.delete(); c.continue(); } };
          t.oncomplete = resolve; t.onerror = resolve;
        } catch (e) { resolve(); }
      });
    },
    // Small synchronous settings in localStorage, guarded.
    pref(key, value) {
      try {
        if (value === undefined) { const v = localStorage.getItem('st.' + key); return v === null ? null : JSON.parse(v); }
        if (value === null) localStorage.removeItem('st.' + key); else localStorage.setItem('st.' + key, JSON.stringify(value));
      } catch (e) { return null; }
      return value;
    }
  };
  root.Store = Store;
})(typeof globalThis !== 'undefined' ? globalThis : this);
