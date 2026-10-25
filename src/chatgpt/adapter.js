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
// ChatGPT's Stop control is not always the same testid. Inside the composer form any "Stop ..." button
// counts, and so does a reply that is still marked as streaming; missing one signal never reads as idle.
const STOP_FALLBACK = 'button[aria-label^="Stop" i]';
const STREAMING = ".result-streaming, [data-is-streaming='true']";
// The native steer path (Send while a response runs), only when a button says so; never guessed.
const STEER = 'button[data-testid="steer-button"], button[aria-label^="Steer" i]';
// Account identity is only ever hashed: the profile button's label never leaves the page or the store.
const PROFILE = '[data-testid="accounts-profile-button"], [data-testid="profile-button"]';
// Files attached to the message being composed, best effort. Unrestorable by the queue.
const ATTACHMENT = '[data-testid*="attachment" i], [data-testid*="file-thumbnail" i]';
const SCROLLER = "[data-scroll-root], [data-app-action-timeline-scroll]";
const HEADER = "#page-header";
const ASSISTANT = '[data-message-author-role="assistant"], [data-conversation-role="assistant"]';
const SCROLLABLE = new Set(["auto", "scroll", "overlay"]);
const ABSOLUTE = new Set(["absolute", "fixed"]);
// ChatGPT keeps pages you navigated away from mounted but inactive (hidden, with their own composer, turns and
// scroller). Everything the script attaches to must come from the active page.
const ACTIVE_PAGE = '[data-app-shell-active-page="true"]';
const scope = (root) => (root.nodeType === 9 ? root.querySelector(ACTIVE_PAGE) ?? root : root);

const nonEmptyRole = (el, sel, attr) => (el.matches(sel) ? el : el.querySelector(sel))?.getAttribute(attr) || null;

export const chatgptAdapter = {
  turns: (root) => [...scope(root).querySelectorAll(TURN)],
  role: (turn) => nonEmptyRole(turn, ROLE, "data-message-author-role") ?? (turn.querySelector("[data-user-message-bubble]") ? "user" : nonEmptyRole(turn, REPLY, "data-conversation-role")),
  blocks: (turnEls) => turnEls.flatMap((el) => [...el.querySelectorAll(BLOCKS)]),
  // Queue transport (live dispatcher): the editable composer input and its Send/Stop buttons.
  composerInput: (doc) => scope(doc).querySelector(COMPOSER),
  sendButton: (doc) => scope(doc).querySelector(SEND),
  // Inside the composer form only: the queue card has its own Steer button, which must never be mistaken for it.
  steerButton: (doc) => scope(doc).querySelector(COMPOSER)?.closest("form")?.querySelector(STEER) ?? null,
  stopButton(doc) {
    const page = scope(doc);
    return page.querySelector(STOP) ?? page.querySelector(COMPOSER)?.closest("form")?.querySelector(STOP_FALLBACK) ?? null;
  },
  /** A response is being produced: a Stop control is shown or the reply is still streaming. */
  generating(doc) {
    return this.stopButton(doc) !== null || scope(doc).querySelector(STREAMING) !== null;
  },
  /** Opaque, stable per signed-in profile ("unknown" when the page does not say); no label is kept. */
  accountId(doc) {
    const label = scope(doc).querySelector(PROFILE)?.textContent?.trim();
    if (!label) return "unknown";
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < label.length; i++) {
      const c = label.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return `acct-${(h2 >>> 0).toString(16).padStart(8, "0")}${(h1 >>> 0).toString(16).padStart(8, "0")}`;
  },
  /** Files on the message being composed; the queue cannot restore them, so it flags them. */
  composerAttachments(doc) {
    const form = scope(doc).querySelector(COMPOSER)?.closest("form");
    return [...(form?.querySelectorAll(ATTACHMENT) ?? [])].map((node) => ({
      name: node.getAttribute("aria-label")?.slice(0, 80) || "attachment",
      size: 0,
      type: "",
      restorable: false,
    }));
  },
  userTurnCount: (doc) => scope(doc).querySelectorAll(USER).length,
  userMessage: (turn) => turn.querySelector(USER),
  turnId: (turn, index) => turn.getAttribute("data-turn-key") ?? turn.getAttribute("data-testid") ?? `turn-${index}`,
  /** The stable element whose subtree contains every turn; observed for new turns. */
  turnRoot: (doc) => scope(doc).querySelector(TURN_ROOT) ?? scope(doc).querySelector(TURN)?.parentElement ?? null,
  /** The element the queue panel is inserted directly before: the composer form, else the input itself. */
  composer: (doc) => scope(doc).querySelector(COMPOSER)?.closest("form") ?? scope(doc).querySelector(COMPOSER),
  conversationId: (win) => win.location.pathname.match(/^\/c\/([\w-]+)/)?.[1] ?? "new",
  /**
   * The element that actually scrolls the conversation. The known selector is trusted unless a nearer
   * ancestor of the turns is itself scrollable and overflowing (the markup moved the scroll owner inward).
   */
  scroller(doc) {
    const page = scope(doc);
    const known = page.querySelector(SCROLLER);
    const win = doc.defaultView;
    for (let el = page.querySelector(TURN)?.parentElement; el && el !== doc.body && el !== doc.documentElement; el = el.parentElement) {
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
    const header = scope(doc).querySelector(HEADER);
    let node = scroller;
    while (node && !(node.contains(composer) && (!header || node.contains(header)))) node = node.parentElement;
    return !node || node === doc.documentElement ? doc.body : node;
  },
  /**
   * Everything the rail's reservation must be written to: the page column and, when the composer sits in an
   * absolutely positioned overlay inside it (chatgpt.com does), that overlay, which padding on the column
   * cannot move.
   */
  columns(doc) {
    const column = this.column(doc);
    if (!column) return [];
    const win = doc.defaultView;
    for (let el = this.composer(doc)?.parentElement; el && el !== column; el = el.parentElement) {
      if (column.contains(el) && ABSOLUTE.has(win.getComputedStyle(el).position)) return [column, el];
    }
    return [column];
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
    const first = scope(doc).querySelector(TURN);
    return {
      route: this.conversationId(win),
      composer: scope(doc).querySelector(COMPOSER),
      container: first ? this.turnRoot(doc) : null,
      scroller: first ? this.scroller(doc) : null,
    };
  },
  /** `ok` means the composer is there (a new chat has no turns); `hasTurns` selects the full feature set. */
  selfCheck(doc) {
    const page = scope(doc);
    const hasTurns = !!page.querySelector(TURN);
    const missing = [];
    if (!page.querySelector(COMPOSER)) missing.push("composer");
    if (!hasTurns) missing.push("turns");
    return { ok: !missing.includes("composer"), hasTurns, missing };
  },
};
