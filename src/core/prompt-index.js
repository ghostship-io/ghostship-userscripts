// Chronological index of the user's prompts (oldest first). The adapter owns
// every selector; this module only reads through it.
const PREVIEW_LENGTH = 120;

export function buildPromptIndex(root, adapter) {
  const prompts = [];
  adapter.turns(root).forEach((turn, turnIndex) => {
    const el = adapter.userMessage(turn);
    if (!el) return;
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    prompts.push({ id: adapter.turnId(turn, turnIndex), turnIndex, preview: text.slice(0, PREVIEW_LENGTH), text });
  });
  return prompts;
}

export function searchPrompts(index, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return index;
  return index.filter((p) => p.text.toLowerCase().includes(needle));
}
