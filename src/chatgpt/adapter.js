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
const ABSOLUTE = new Set(["absolute", "fixed"]);
// ChatGPT keeps pages you navigated away from mounted but inactive (hidden, with their own composer, turns and
// scroller). Everything the script attaches to must come from the active page.
const ACTIVE_PAGE = '[data-app-shell-active-page="true"]';
const scope = (root) => (root.nodeType === 9 ? root.querySelector(ACTIVE_PAGE) ?? root : root);

// ChatGPT's own pinned right-side summary pane (Outputs / Sources). Detected structurally, never by one
// class or test id: a visible, right-side region holding a heading or disclosure button titled
// "Outputs" or "Sources" outside the conversation. Everything else is derived from those titles.
const SUMMARY_TITLE = /^(outputs?|sources?)$/i;
const HEADINGS = 'h1,h2,h3,h4,h5,h6,[role="heading"]';
const SUMMARY_REGION = 'aside,[role="complementary"],[role="region"],[aria-label*="summary" i],[data-testid*="summary" i]';
// Titles are headings anywhere, or disclosure buttons inside a region; one native query, so a page with a long
// conversation list in its sidebar does not cost a JS loop per button on every layout check.
const SUMMARY_TITLES = `${HEADINGS},${SUMMARY_REGION.split(",").map((r) => `${r} button,${r} [role="button"]`).join(",")}`;
const OWN_UI = "[data-gs-ui]";

const commonAncestor = (a, b) => {
  for (let el = a; el; el = el.parentElement) if (el.contains(b)) return el;
  return null;
};

const nativeChildren = (el) => [...el.children].filter((c) => !c.matches(OWN_UI)).length;

/** The section holding `title` and its title row: climb until the parent has native siblings of its own. */
function summarySection(title, pane) {
  let head = title;
  while (head.parentElement && head.parentElement !== pane && nativeChildren(head.parentElement) < 2) head = head.parentElement;
  const section = head.parentElement;
  return !section || section === pane || section === head ? null : { section, head };
}

const nonEmptyRole = (el, sel, attr) => (el.matches(sel) ? el : el.querySelector(sel))?.getAttribute(attr) || null;

export const chatgptAdapter = {
  turns: (root) => [...scope(root).querySelectorAll(TURN)],
  role: (turn) => nonEmptyRole(turn, ROLE, "data-message-author-role") ?? (turn.querySelector("[data-user-message-bubble]") ? "user" : nonEmptyRole(turn, REPLY, "data-conversation-role")),
  blocks: (turnEls) => turnEls.flatMap((el) => [...el.querySelectorAll(BLOCKS)]),
  // Queue transport (live dispatcher): the editable composer input and its Send/Stop buttons.
  composerInput: (doc) => scope(doc).querySelector(COMPOSER),
  sendButton: (doc) => scope(doc).querySelector(SEND),
  stopButton: (doc) => scope(doc).querySelector(STOP),
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
  /**
   * ChatGPT's mounted, visible summary pane, or null (the script then shows its one fallback pane).
   * `container` is where the script's own section is appended (a child of the pane's sections, after
   * Sources); `outputs` is the native Outputs section and its title row when its list can be collapsed
   * by hiding the section's other children, else null. Nothing here changes the page.
   */
  nativeSummary(doc) {
    const page = scope(doc);
    const win = doc.defaultView;
    const found = [];
    let outputs = null;
    for (const title of page.querySelectorAll(SUMMARY_TITLES)) {
      const name = title.textContent.trim();
      if (name.length > 12 || !SUMMARY_TITLE.test(name) || title.closest(TURN) || title.closest(ROLE) || title.closest(OWN_UI)) continue;
      const rect = title.getBoundingClientRect();
      if (!rect.width || !rect.height || rect.right <= win.innerWidth / 2) continue; // hidden, or on the left
      found.push(title);
      if (/^outputs?$/i.test(name) && !outputs) outputs = title;
    }
    if (!found.length) return null;
    const apart = (el) => !el.contains(this.composer(doc)) && !el.querySelector(TURN) && !el.matches(TURN);
    let lca = found[0];
    for (const t of found.slice(1)) lca = commonAncestor(lca, t) ?? lca;
    if (lca === found[0]) lca = found[0].parentElement;
    const region = lca?.closest(SUMMARY_REGION);
    const pane = region && apart(region) ? region : lca;
    if (!pane || !apart(pane)) return null;
    const rect = pane.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const sections = found.map((t) => summarySection(t, pane)).filter(Boolean);
    let container = sections[0]?.section.parentElement ?? pane;
    for (const s of sections.slice(1)) container = commonAncestor(container, s.section.parentElement) ?? container;
    const own = outputs && summarySection(outputs, pane);
    const others = found.filter((t) => t !== outputs);
    const collapsible = !!own && nativeChildren(own.section) > 1 && !others.some((t) => own.section.contains(t));
    return { pane, container, left: rect.left, outputs: collapsible ? own : null };
  },
  /** Bottom edge of the page header (0 without one): the fallback pane docks below it. */
  headerBottom(doc) {
    return scope(doc).querySelector(HEADER)?.getBoundingClientRect().bottom ?? 0;
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
