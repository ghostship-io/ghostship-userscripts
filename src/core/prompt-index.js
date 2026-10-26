// Chronological index of the user's prompts (oldest first). The adapter owns
// every selector; this module only reads through it.
const PREVIEW_LENGTH = 120;

const clean = (el) => (el.textContent ?? "").replace(/\s+/g, " ").trim();

export function buildPromptIndex(root, adapter) {
  const prompts = [];
  const turns = adapter.turns(root);
  turns.forEach((turn, turnIndex) => {
    const el = adapter.userMessage(turn);
    if (!el) return;
    const text = clean(el);
    prompts.push({ id: adapter.turnId(turn, turnIndex), turnIndex, preview: text.slice(0, PREVIEW_LENGTH), text });
  });
  // A thread nobody wrote in (a scheduled task's runs, say) has replies and no prompts: each reply is its own entry, so the
  // list and the conversation view still have something to show and navigate.
  if (!prompts.length) {
    turns.forEach((turn, turnIndex) => {
      // The opening blocks, spaced apart (the raw text runs a heading into the paragraph after it), without the screen-reader label.
      const lead = (adapter.blocks?.([turn]) ?? []).slice(0, 6).map(clean).filter(Boolean).join(" ");
      const text = (lead || clean(turn)).replace(/^ChatGPT said:\s*/i, "").slice(0, PREVIEW_LENGTH * 2);
      if (text) prompts.push({ id: adapter.turnId(turn, turnIndex), turnIndex, preview: text.slice(0, PREVIEW_LENGTH), text, automated: true });
    });
  }
  return prompts;
}

export function searchPrompts(index, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return index;
  return index.filter((p) => p.text.toLowerCase().includes(needle));
}
