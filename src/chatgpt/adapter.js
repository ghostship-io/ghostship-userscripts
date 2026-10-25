// Every ChatGPT DOM assumption lives here. When the site changes, selfCheck()
// fails and the runtime stays in safe mode instead of touching the page.
const TURN = '[data-testid^="conversation-turn-"]';
const ROLE = "[data-message-author-role]";
const BLOCKS = "h1,h2,h3,h4,h5,h6,p,li,pre,table,img,blockquote";
const USER = '[data-message-author-role="user"]';
const COMPOSER = "#prompt-textarea";
const SEND = 'button[data-testid="send-button"]';
const STOP = 'button[data-testid="stop-button"]';

export const chatgptAdapter = {
  turns: (root) => [...root.querySelectorAll(TURN)],
  role: (turn) => (turn.matches(ROLE) ? turn : turn.querySelector(ROLE))?.getAttribute("data-message-author-role") || null,
  blocks: (turnEls) => turnEls.flatMap((el) => [...el.querySelectorAll(BLOCKS)]),
  composer: (doc) => doc.querySelector(COMPOSER)?.closest("form") ?? doc.querySelector(COMPOSER),
  // Queue transport (live dispatcher): the editable composer input and its Send/Stop buttons.
  composerInput: (doc) => doc.querySelector(COMPOSER),
  sendButton: (doc) => doc.querySelector(SEND),
  stopButton: (doc) => doc.querySelector(STOP),
  userTurnCount: (doc) => doc.querySelectorAll(USER).length,
  userMessage: (turn) => turn.querySelector(USER),
  turnId: (turn, index) => turn.getAttribute("data-testid") ?? `turn-${index}`,
  /** The element the queue panel is inserted directly before: the composer form, else the input itself. */
  composer: (doc) => doc.querySelector(COMPOSER)?.closest("form") ?? doc.querySelector(COMPOSER),
  conversationId: (win) => win.location.pathname.match(/^\/c\/([\w-]+)/)?.[1] ?? "new",
  scroller: (doc) => doc.querySelector("[data-scroll-root]") ?? doc.scrollingElement ?? doc.documentElement,
  selfCheck(doc) {
    const missing = [];
    if (!doc.querySelector(TURN)) missing.push("turns");
    if (!doc.querySelector(COMPOSER)) missing.push("composer");
    return { ok: missing.length === 0, missing };
  },
};
