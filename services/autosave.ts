/**
 * Automatic safety copy of the current project in the browser (IndexedDB).
 * Holds the project JSON (pitch data, notes, texts, view/settings) - NOT the audio file.
 * After a crash / accidental reload the project is offered for restoring; the audio file
 * then has to be located again (same flow as loading a .tonyweb project).
 */
const DB_NAME = 'tonyweb-autosave';
const STORE = 'kv';
const KEY = 'last';

const openDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

export interface AutosaveEntry { json: string; savedAt: number; }

export const saveAutosave = async (json: string): Promise<void> => {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ json, savedAt: Date.now() } as AutosaveEntry, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
};

export const loadAutosave = async (): Promise<AutosaveEntry | null> => {
  const db = await openDb();
  const result = await new Promise<AutosaveEntry | null>((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
    req.onsuccess = () => resolve((req.result as AutosaveEntry) ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result;
};

export const clearAutosave = async (): Promise<void> => {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
};
