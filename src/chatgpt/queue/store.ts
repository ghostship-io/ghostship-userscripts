import type { ConversationQueueState, LeaseRecord, QueueItem } from "./types.ts";

const DB_NAME = "ghostship-chatgpt-queue";
const DB_VERSION = 1;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Typed accessors valid only inside one `QueueStore.transact` callback. */
export class Tx {
  readonly #tx: IDBTransaction;
  constructor(tx: IDBTransaction) {
    this.#tx = tx;
  }

  getItem(id: string): Promise<QueueItem | undefined> {
    return request(this.#tx.objectStore("items").get(id));
  }
  putItem(item: QueueItem): Promise<IDBValidKey> {
    return request(this.#tx.objectStore("items").put(item));
  }
  deleteItem(id: string): Promise<undefined> {
    return request(this.#tx.objectStore("items").delete(id));
  }
  /** Items of one conversation ordered by position. */
  async itemsOf(conversationId: string): Promise<QueueItem[]> {
    const items: QueueItem[] = await request(
      this.#tx.objectStore("items").index("conversationId").getAll(conversationId),
    );
    return items.sort((a, b) => a.position - b.position);
  }
  getQueue(conversationId: string): Promise<ConversationQueueState | undefined> {
    return request(this.#tx.objectStore("queues").get(conversationId));
  }
  putQueue(state: ConversationQueueState): Promise<IDBValidKey> {
    return request(this.#tx.objectStore("queues").put(state));
  }
  getLease(conversationId: string): Promise<LeaseRecord | undefined> {
    return request(this.#tx.objectStore("leases").get(conversationId));
  }
  putLease(lease: LeaseRecord): Promise<IDBValidKey> {
    return request(this.#tx.objectStore("leases").put(lease));
  }
  deleteLease(conversationId: string): Promise<undefined> {
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
  readonly #db: IDBDatabase;
  private constructor(db: IDBDatabase) {
    this.#db = db;
  }

  static async open(factory: IDBFactory = globalThis.indexedDB, name = DB_NAME): Promise<QueueStore> {
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

  close(): void {
    this.#db.close();
  }

  transact<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const tx = this.#db.transaction(["items", "queues", "leases"], "readwrite");
      let result: T;
      let failure: unknown;
      let failed = false;
      tx.oncomplete = () => (failed ? reject(failure) : resolve(result));
      tx.onabort = () => reject(failed ? failure : tx.error);
      tx.onerror = () => undefined; // surfaced through onabort
      fn(new Tx(tx)).then(
        (value) => {
          result = value;
        },
        (error: unknown) => {
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
