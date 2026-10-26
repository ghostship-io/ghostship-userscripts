// Per-conversation rail state, kept for the life of the page so that switching A -> B -> A
// restores each conversation independently (the boot controller rebuilds the rail on every route
// change). In memory only: nothing is persisted or logged, and one conversation's entry is never
// read for another. A new chat (no conversation id yet) keeps nothing.
const NEW_CHAT = "new";

/** Identity of a conversation's content: first prompt id plus a hash of its text (ids repeat in older markup). */
export function contentSignature(prompts) {
  const first = prompts[0];
  if (!first) return null;
  let h = 5381;
  for (let i = 0; i < Math.min(first.text.length, 200); i++) h = ((h * 33) ^ first.text.charCodeAt(i)) >>> 0;
  return `${first.id}|${h.toString(36)}`;
}

export function createRailStateStore({ max = 24 } = {}) {
  const slots = new Map(); // conversation id -> state; insertion order = least recently used first
  return {
    /** The stored state for a conversation, or null. */
    get: (id) => (id === NEW_CHAT ? null : slots.get(id) ?? null),
    /** The conversation whose stored content has this signature, or null. */
    owner(sig) {
      if (sig) for (const [id, slot] of slots) if (slot.sig === sig) return id;
      return null;
    },
    /**
     * Store `state` (with `sig`, the content signature) for `id`. Skipped when the content belongs to a
     * different stored conversation: that means the page still shows the previous conversation's DOM.
     */
    save(id, state) {
      if (id === NEW_CHAT) return false;
      const owner = this.owner(state.sig);
      if (owner && owner !== id) return false;
      slots.delete(id);
      slots.set(id, state);
      while (slots.size > max) slots.delete(slots.keys().next().value);
      return true;
    },
    forget: (id) => slots.delete(id),
    size: () => slots.size,
  };
}

/** A small bounded JSON map in the page's own storage; unreadable or full storage degrades to in-memory use. */
function jsonStore(storage, key) {
  return {
    read() {
      try {
        const data = JSON.parse(storage?.getItem(key) ?? "{}");
        return data && typeof data === "object" && !Array.isArray(data) ? data : {};
      } catch {
        return {};
      }
    },
    write(data) {
      try {
        storage?.setItem(key, JSON.stringify(data));
      } catch {
        // storage full or blocked: the in-memory state still works
      }
    },
  };
}

/** Whether a conversation's native Outputs list is collapsed, remembered across reloads (bounded, most recent last). */
export function createPanePrefs(storage, { max = 50, key = "gs.pane.prefs" } = {}) {
  const json = jsonStore(storage, key);
  return {
    get(id) {
      const p = id === NEW_CHAT ? null : json.read()[id];
      return p && typeof p === "object" ? { outputs: !!p.outputs } : null;
    },
    set(id, prefs) {
      if (id === NEW_CHAT) return;
      const data = json.read();
      delete data[id];
      data[id] = { outputs: !!prefs.outputs };
      for (const old of Object.keys(data).slice(0, Math.max(0, Object.keys(data).length - max))) delete data[old];
      json.write(data);
    },
  };
}

/** Whether the user wants the panels shown: one choice per browser, shown by default. */
export function createPanelPrefs(storage, { key = "gs.pane.layout" } = {}) {
  const json = jsonStore(storage, key);
  return {
    get() {
      return json.read().shown !== false;
    },
    set(shown) {
      json.write({ shown: !!shown });
    },
  };
}
