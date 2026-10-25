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

/**
 * Which sections of a conversation's pane the user collapsed, remembered across reloads (bounded, most
 * recent last). Only these booleans are stored, under the conversation id, in the page's own storage.
 */
export function createPanePrefs(storage, { max = 50, key = "gs.pane.prefs" } = {}) {
  const read = () => {
    try {
      const data = JSON.parse(storage?.getItem(key) ?? "{}");
      return data && typeof data === "object" && !Array.isArray(data) ? data : {};
    } catch {
      return {};
    }
  };
  return {
    get(id) {
      const p = id === NEW_CHAT ? null : read()[id];
      return p && typeof p === "object" ? { outputs: !!p.outputs, overview: !!p.overview, prompts: !!p.prompts } : null;
    },
    set(id, prefs) {
      if (id === NEW_CHAT) return;
      const data = read();
      delete data[id];
      data[id] = { outputs: !!prefs.outputs, overview: !!prefs.overview, prompts: !!prefs.prompts };
      for (const old of Object.keys(data).slice(0, Math.max(0, Object.keys(data).length - max))) delete data[old];
      try {
        storage?.setItem(key, JSON.stringify(data));
      } catch {
        // storage full or blocked: the in-memory state still works
      }
    },
  };
}
