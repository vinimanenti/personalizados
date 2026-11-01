// Arquivos das artes da fila no IndexedDB do navegador (o localStorage não comporta PDFs e PNGs grandes).
const DB = "sticker_art_files", STORE = "files";

const open = () => new Promise((ok, fail) => {
  const req = indexedDB.open(DB, 1);
  req.onupgradeneeded = () => req.result.createObjectStore(STORE);
  req.onsuccess = () => ok(req.result);
  req.onerror = () => fail(req.error);
});

const tx = async (mode, fn) => {
  const db = await open();
  return new Promise((ok, fail) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); ok(req?.result); };
    t.onerror = () => { db.close(); fail(t.error); };
  });
};

// file = { name, type, bytes: Uint8Array }
export const saveArtFile = (id, file) => tx("readwrite", s => s.put(file, id));
export const loadArtFile = id => tx("readonly", s => s.get(id));
export const deleteArtFile = id => tx("readwrite", s => s.delete(id));
