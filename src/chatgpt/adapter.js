// Every ChatGPT DOM assumption lives here. When the site changes, selfCheck()
// fails and the runtime stays in safe mode instead of touching the page. A page
// with a composer but no turns (a new chat) runs in composer-only mode.
// Turns: ChatGPT now renders one `[data-turn-key]` element per complete prompt/response
// turn (each inside its own wrapper); older builds used `conversation-turn-N` articles per message.
const TURN = '[data-turn-key], [data-testid^="conversation-turn-"]';
const TURN_ROOT = '[data-thread-find-target="conversation"]';
const ROLE = "[data-message-author-role]";
const BLOCKS = "h1,h2,h3,h4,h5,h6,p,li,pre,table,img,blockquote";
const USER = '[data-message-author-role="user"], [data-user-message-bubble]';
const REPLY = "[data-conversation-role]";
// The prompt box is a ProseMirror contenteditable inside the composer form (no #prompt-textarea any more).
const COMPOSER = '#prompt-textarea, [data-chatgpt-composer] [contenteditable="true"], form [contenteditable="true"][role="textbox"]';
const SEND = 'button[data-testid="send-button"]';
const STOP = 'button[data-testid="stop-button"]';
const SCROLLER = "[data-scroll-root], [data-app-action-timeline-scroll]";
const HEADER = "#page-header";
const ASSISTANT = '[data-message-author-role="assistant"], [data-conversation-role="assistant"]';
const SCROLLABLE = new Set(["auto", "scroll", "overlay"]);

const nonEmptyRole = (el, sel, attr) => (el.matches(sel) ? el : el.querySelector(sel))?.getAttribute(attr) || null;

export const chatgptAdapter = {
  turns: (root) => [...root.querySelectorAll(TURN)],
  role: (turn) => nonEmptyRole(turn, ROLE, "data-message-author-role") ?? (turn.querySelector("[data-user-message-bubble]") ? "user" : nonEmptyRole(turn, REPLY, "data-conversation-role")),
  blocks: (turnEls) => turnEls.flatMap((el) => [...el.querySelectorAll(BLOCKS)]),
  // Queue transport (live dispatcher): the editable composer input and its Send/Stop buttons.
  composerInput: (doc) => doc.querySelector(COMPOSER),
  sendButton: (doc) => doc.querySelector(SEND),
  stopButton: (doc) => doc.querySelector(STOP),
  userTurnCount: (doc) => doc.querySelectorAll(USER).length,
  userMessage: (turn) => turn.querySelector(USER),
  turnId: (turn, index) => turn.getAttribute("data-turn-key") ?? turn.getAttribute("data-testid") ?? `turn-${index}`,
  /** The stable element whose subtree contains every turn; observed for new turns. */
  turnRoot: (doc) => doc.querySelector(TURN_ROOT) ?? doc.querySelector(TURN)?.parentElement ?? null,
  /** The element the queue panel is inserted directly before: the composer form, else the input itself. */
  composer: (doc) => doc.querySelector(COMPOSER)?.closest("form") ?? doc.querySelector(COMPOSER),
  conversationId: (win) => win.location.pathname.match(/^\/c\/([\w-]+)/)?.[1] ?? "new",
  /**
   * The element that actually scrolls the conversation. The known selector is trusted unless a nearer
   * ancestor of the turns is itself scrollable and overflowing (the markup moved the scroll owner inward).
   */
  scroller(doc) {
    const known = doc.querySelector(SCROLLER);
    const win = doc.defaultView;
    for (let el = doc.querySelector(TURN)?.parentElement; el && el !== doc.body && el !== doc.documentElement; el = el.parentElement) {
      if (el === known) break;
      if (SCROLLABLE.has(win.getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight && (!known || known.contains(el))) return el;
    }
    return known ?? doc.scrollingElement ?? doc.documentElement;
  },
  /**
   * The page column the right rail reserves space from: the smallest element holding the conversation
   * scroller, the composer and the page header, so that shrinking it shifts all three together.
   */
  column(doc) {
    const composer = this.composer(doc);
    const scroller = this.scroller(doc);
    if (!composer || !scroller) return null;
    const header = doc.querySelector(HEADER);
    let node = scroller;
    while (node && !(node.contains(composer) && (!header || node.contains(header)))) node = node.parentElement;
    return !node || node === doc.documentElement ? doc.body : node;
  },
  /** The assistant reply of turn `index` of `turns`: inside the turn element, else the next message element. */
  reply(turns, index) {
    const own = turns[index].querySelector(ASSISTANT);
    if (own) return own;
    const next = turns[index + 1];
    return next && this.role(next) !== "user" ? next : null;
  },
  /** Identity of the pieces the script attaches to; a change means the page re-rendered or navigated. */
  layout(doc, win) {
    const first = doc.querySelector(TURN);
    return {
      route: this.conversationId(win),
      composer: doc.querySelector(COMPOSER),
      container: first ? this.turnRoot(doc) : null,
      scroller: first ? this.scroller(doc) : null,
    };
  },
  /** `ok` means the composer is there (a new chat has no turns); `hasTurns` selects the full feature set. */
  selfCheck(doc) {
    const hasTurns = !!doc.querySelector(TURN);
    const missing = [];
    if (!doc.querySelector(COMPOSER)) missing.push("composer");
    if (!hasTurns) missing.push("turns");
    return { ok: !missing.includes("composer"), hasTurns, missing };
  },
};
