export class SnapshotStore {
  constructor(factory = globalThis.indexedDB) { this.factory = factory; this.database = null; }
  open() {
    if (!this.database) this.database = new Promise((resolve, reject) => {
      if (!this.factory) return reject(new Error('Snapshot storage is unavailable.'));
      const request = this.factory.open('insta-unfollow-studio', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('snapshots');
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Snapshot storage is blocked by another tab.'));
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    });
    return this.database;
  }
  async read(accountId) {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('snapshots', 'readonly');
      const request = transaction.objectStore('snapshots').get(accountId);
      transaction.oncomplete = () => resolve(request.result ?? null);
      transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error('Snapshot could not be loaded.'));
    });
  }
  async write(accountId, value) {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('snapshots', 'readwrite');
      transaction.objectStore('snapshots').put(value, accountId);
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error('Snapshot could not be saved.'));
    });
  }
}