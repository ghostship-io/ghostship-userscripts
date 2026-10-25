// Every ChatGPT DOM assumption lives here. When the site changes, selfCheck()
// fails and the runtime stays in safe mode instead of touching the page.
const TURN = '[data-testid^="conversation-turn-"]';
const ROLE = "[data-message-author-role]";
const USER = '[data-message-author-role="user"]';
const COMPOSER = "#prompt-textarea";

export const chatgptAdapter = {
  turns: (root) => [...root.querySelectorAll(TURN)],
  role: (turn) => (turn.matches(ROLE) ? turn : turn.querySelector(ROLE))?.getAttribute("data-message-author-role") || null,
  userMessage: (turn) => turn.querySelector(USER),
  turnId: (turn, index) => turn.getAttribute("data-testid") ?? `turn-${index}`,
  scroller: (doc) => doc.querySelector("[data-scroll-root]") ?? doc.scrollingElement ?? doc.documentElement,
  selfCheck(doc) {
    const missing = [];
    if (!doc.querySelector(TURN)) missing.push("turns");
    if (!doc.querySelector(COMPOSER)) missing.push("composer");
    return { ok: missing.length === 0, missing };
  },
};
