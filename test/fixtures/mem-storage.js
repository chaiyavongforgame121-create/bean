// test/fixtures/mem-storage.js — an in-memory stand-in for server/cloudstore.js (the cloud tests' long simulations
// would be slow over HTTP). Same method names and semantics as the real store: download → Buffer | null, upload
// (upsert), server-side copy, remove, folder listing (`folder: true` for sub-folders), getBucket. `ops` counts what
// would leave the host. Offline: nothing here touches the network.

export function memStore({ bucket = 'bean-garden' } = {}) {
  const objects = new Map(); // path → Buffer
  const ops = { upload: 0, copy: 0, bytes: 0 };
  let bucketPublic = false;
  const children = (folder) => {
    const base = folder ? `${folder}/` : '';
    const seen = new Map();
    for (const k of objects.keys()) {
      if (!k.startsWith(base)) continue;
      const rest = k.slice(base.length).split('/');
      seen.set(rest[0], { name: rest[0], folder: rest.length > 1 });
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  };
  return {
    enabled: true,
    objects,
    ops,
    setPublic(v) {
      bucketPublic = Boolean(v);
    },
    describe: () => ({ enabled: true, host: 'memory', bucket, prefix: '' }),
    maxCallMs: () => 50_000,
    async download(p) {
      return objects.get(p) ?? null;
    },
    async upload(p, bytes) {
      objects.set(p, Buffer.from(bytes));
      ops.upload += 1;
      ops.bytes += bytes.length;
      return { path: p, bytes: bytes.length };
    },
    async copy(from, to) {
      if (!objects.has(from)) throw new Error(`copy: ${from} not found`);
      objects.set(to, objects.get(from));
      ops.copy += 1;
      return { from, to };
    },
    async remove(paths) {
      for (const p of paths) objects.delete(p);
      return paths.length;
    },
    async list(folder = '') {
      return children(folder);
    },
    async getBucket() {
      return { id: bucket, name: bucket, public: bucketPublic };
    },
  };
}
