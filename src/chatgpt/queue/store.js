const DB_NAME = "ghostship-chatgpt-queue";
const DB_VERSION = 1;

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Typed accessors valid only inside one `QueueStore.transact` callback. */
export class Tx {
  #tx;
  constructor(tx) {
    this.#tx = tx;
  }

  getItem(id) {
    return request(this.#tx.objectStore("items").get(id));
  }
  putItem(item) {
    return request(this.#tx.objectStore("items").put(item));
  }
  deleteItem(id) {
    return request(this.#tx.objectStore("items").delete(id));
  }
  /** Items of one conversation ordered by position. */
  async itemsOf(conversationId) {
    const items = await request(this.#tx.objectStore("items").index("conversationId").getAll(conversationId));
    return items.sort((a, b) => a.position - b.position);
  }
  getQueue(conversationId) {
    return request(this.#tx.objectStore("queues").get(conversationId));
  }
  putQueue(state) {
    return request(this.#tx.objectStore("queues").put(state));
  }
  getLease(conversationId) {
    return request(this.#tx.objectStore("leases").get(conversationId));
  }
  putLease(lease) {
    return request(this.#tx.objectStore("leases").put(lease));
  }
  deleteLease(conversationId) {
    return request(this.#tx.objectStore("leases").delete(conversationId));
  }
}

/**
 * IndexedDB persistence. Every state transition runs inside exactly one
 * readwrite transaction through `transact`; a thrown error aborts it, so a
 * transition is either fully applied or not at all. IndexedDB serializes
 * overlapping readwrite transactions across tabs, which is what makes the
 * lease and the compare-and-set claims atomic.
 */
export class QueueStore {
  #db;
  constructor(db) {
    this.#db = db;
  }

  static async open(factory = globalThis.indexedDB, name = DB_NAME) {
    const open = factory.open(name, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      const items = db.createObjectStore("items", { keyPath: "id" });
      items.createIndex("conversationId", "conversationId");
      db.createObjectStore("queues", { keyPath: "conversationId" });
      db.createObjectStore("leases", { keyPath: "conversationId" });
    };
    return new QueueStore(await request(open));
  }

  close() {
    this.#db.close();
  }

  transact(fn) {
    return new Promise((resolve, reject) => {
      const tx = this.#db.transaction(["items", "queues", "leases"], "readwrite");
      let result;
      let failure;
      let failed = false;
      tx.oncomplete = () => (failed ? reject(failure) : resolve(result));
      tx.onabort = () => reject(failed ? failure : tx.error);
      tx.onerror = () => undefined; // surfaced through onabort
      fn(new Tx(tx)).then(
        (value) => {
          result = value;
        },
        (error) => {
          failed = true;
          failure = error;
          try {
            tx.abort();
          } catch {
            // already finished
          }
        },
      );
    });
  }
}
