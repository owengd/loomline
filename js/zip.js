/* Minimal ZIP reader (stored + deflate) using the browser's DecompressionStream. */
(function (root) {
  'use strict';
  async function inflateRaw(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  /** Returns [{path, bytes()}] for entries whose path passes `filter`. */
  async function readZip(buffer, filter) {
    const u8 = new Uint8Array(buffer);
    const dv = new DataView(buffer);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('That file is not a ZIP archive.');
    let count = dv.getUint16(eocd + 10, true);
    let cdOff = dv.getUint32(eocd + 16, true);
    if (cdOff === 0xffffffff || count === 0xffff) {
      // ZIP64 end of central directory locator
      const loc = eocd - 20;
      if (loc >= 0 && dv.getUint32(loc, true) === 0x07064b50) {
        const z64 = Number(dv.getBigUint64(loc + 8, true));
        count = Number(dv.getBigUint64(z64 + 32, true));
        cdOff = Number(dv.getBigUint64(z64 + 48, true));
      }
    }
    const dec = new TextDecoder();
    const out = [];
    let p = cdOff;
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      let csize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
      let local = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
      // ZIP64 extra field
      if (csize === 0xffffffff || local === 0xffffffff) {
        let e = p + 46 + nameLen;
        const end = e + extraLen;
        while (e + 4 <= end) {
          const id = dv.getUint16(e, true), sz = dv.getUint16(e + 2, true);
          if (id === 1) {
            let q = e + 4;
            if (dv.getUint32(p + 24, true) === 0xffffffff) q += 8;
            if (csize === 0xffffffff) { csize = Number(dv.getBigUint64(q, true)); q += 8; }
            if (local === 0xffffffff) { local = Number(dv.getBigUint64(q, true)); }
          }
          e += 4 + sz;
        }
      }
      p += 46 + nameLen + extraLen + commentLen;
      if (name.endsWith('/') || (filter && !filter(name))) continue;
      const lNameLen = dv.getUint16(local + 26, true), lExtra = dv.getUint16(local + 28, true);
      const start = local + 30 + lNameLen + lExtra;
      const data = u8.subarray(start, start + csize);
      out.push({
        path: name,
        bytes: async () => {
          if (method === 0) return data;
          if (method === 8) return inflateRaw(data);
          throw new Error('Unsupported compression in ' + name);
        }
      });
    }
    return out;
  }
  root.Zip = { readZip };
})(typeof globalThis !== 'undefined' ? globalThis : this);
