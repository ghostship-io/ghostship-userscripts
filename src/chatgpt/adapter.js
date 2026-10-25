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
// The page header: a plain `<header>` in the active page (a hidden page keeps its own, zero-sized one), or `#page-header`.
const HEADER = "#page-header, header";
const ASSISTANT = '[data-message-author-role="assistant"], [data-conversation-role="assistant"]';
const SCROLLABLE = new Set(["auto", "scroll", "overlay"]);
const ABSOLUTE = new Set(["absolute", "fixed"]);
// ChatGPT keeps pages you navigated away from mounted but inactive (hidden, with their own composer, turns and
// scroller). Everything the script attaches to must come from the active page.
const ACTIVE_PAGE = '[data-app-shell-active-page="true"]';
const scope = (root) => (root.nodeType === 9 ? root.querySelector(ACTIVE_PAGE) ?? root : root);
/** The visible page header of the active page, or null. */
const pageHeader = (doc) => {
  for (const h of scope(doc).querySelectorAll(HEADER)) {
    if (h.closest(OWN_UI) || h.closest(TURN)) continue;
    const r = h.getBoundingClientRect();
    if (r.width && r.height) return h;
  }
  return scope(doc).querySelector("#page-header");
};

// ChatGPT's own pinned right-side summary pane (Outputs / Sources). Detected structurally, never by one
// class or test id: a visible, right-side region holding a heading or disclosure button titled
// "Outputs" or "Sources" outside the conversation. Everything else is derived from those titles.
const SUMMARY_TITLE = /^(outputs?|sources?)$/i;
const HEADINGS = 'h1,h2,h3,h4,h5,h6,[role="heading"]';
// ChatGPT marks its summary pane with data-summary-panel-* attributes (seen on the real page); they are one more
// hint for the region, never the only one.
const SUMMARY_HINT = "[data-summary-panel-variant],[data-summary-panel-density]";
const SUMMARY_REGION = `aside,[role="complementary"],[role="region"],[aria-label*="summary" i],[data-testid*="summary" i],${SUMMARY_HINT}`;
// Titles are headings anywhere, or disclosure buttons inside a region (queried per region, never page-wide).
const BUTTONS = 'button,[role="button"]';
const BUTTON_REGION = `aside,[role="complementary"],[role="region"],${SUMMARY_HINT}`;
const OWN_UI = "[data-gs-ui]";
// The header button that opens and closes ChatGPT's summary pane (aria-pressed says which).
const SUMMARY_TOGGLE = 'button[data-thread-summary-panel-toggle="true"]';
// The title of a thinking trace's disclosure button.
const THINKING_TITLE = /^(thought|worked|thinking|stopped thinking|reasoned)\b/i;

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

// ChatGPT's conversation-load failure card: a fixed message with a "Try again" control. Matched by its fixed
// strings, never by class names; nothing in a conversation turn is ever treated as this card.
const LOAD_ERROR = /could not load this chatgpt conversation/i;
const RETRY_LABEL = /^try again$/i;

const nonEmptyRole = (el, sel, attr) => (el.matches(sel) ? el : el.querySelector(sel))?.getAttribute(attr) || null;

/** A summary pane that carries ChatGPT's own hint but none of the titles we know (a thread with only other sections). */
function hintedPane(page, win, composer) {
  for (const pane of page.querySelectorAll(SUMMARY_HINT)) {
    if (pane.matches(TURN) || pane.closest(TURN) || pane.closest(OWN_UI) || pane.contains(composer) || pane.querySelector(TURN)) continue;
    const rect = pane.getBoundingClientRect();
    if (!rect.width || !rect.height || rect.right <= win.innerWidth / 2) continue;
    return { pane, container: pane, left: rect.left, outputs: null };
  }
  return null;
}

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
  /**
   * A response is being produced: a Stop control is shown, the reply is still streaming, or the composer offers to steer it
   * (ChatGPT only offers Steer while a response runs, even where it hides Stop). A Send gesture then belongs to the queue.
   */
  generating(doc) {
    return this.stopButton(doc) !== null || this.steerButton(doc) !== null || scope(doc).querySelector(STREAMING) !== null;
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
  conversationId: (win) => win.location.pathname.match(/^(?:\/g\/[^/]+)?\/c\/([\w-]+)/)?.[1] ?? "new",
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
    if (!scope(doc).querySelector(TURN)) {
      // A new chat has no scroller: the column is the widest ancestor of the composer that is not the whole window
      // (it holds the composer and the greeting, and leaves the sidebar out).
      const win = doc.defaultView;
      let node = composer;
      for (let up = node.parentElement; up && up !== doc.body && up !== doc.documentElement; up = up.parentElement) {
        const width = up.getBoundingClientRect().width;
        if (width >= win.innerWidth - 40) break;
        if (width) node = up; // an element with no box of its own (display: contents) cannot be padded
      }
      return node;
    }
    const header = pageHeader(doc);
    let node = scroller;
    while (node && !(node.contains(composer) && (!header || node.contains(header)))) node = node.parentElement;
    return !node || node === doc.documentElement ? doc.body : node;
  },
  /**
   * Where the panels' room is measured and written: `frame` is the page column (its box is what the panels anchor
   * to) and gets the side padding, `header` is its page header (given opposite margins so it keeps the full width and
   * its buttons stay in the top-right corner) and, when the composer sits in an absolutely positioned overlay inside
   * the column (chatgpt.com does), that overlay is padded too, which padding on the column cannot move.
   */
  columns(doc) {
    const frame = this.column(doc);
    if (!frame) return null;
    const win = doc.defaultView;
    const pads = [frame];
    for (let el = this.composer(doc)?.parentElement; el && el !== frame; el = el.parentElement) {
      if (frame.contains(el) && ABSOLUTE.has(win.getComputedStyle(el).position)) {
        pads.push(el);
        break;
      }
    }
    const header = pageHeader(doc);
    // A fixed header spans the window whatever the column's padding, so it needs no cancelling.
    const flows = header && frame.contains(header) && header !== frame && win.getComputedStyle(header).position !== "fixed";
    return { frame, pads, header: flows ? header : null };
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
    const candidates = [...page.querySelectorAll(HEADINGS)];
    for (const region of page.querySelectorAll(BUTTON_REGION)) if (!region.matches(TURN) && !region.closest(TURN)) candidates.push(...region.querySelectorAll(BUTTONS));
    // The real pane's section titles are plain elements: inside a hinted pane, a leaf whose text is the title counts.
    for (const region of page.querySelectorAll(SUMMARY_HINT)) if (!region.matches(TURN) && !region.closest(TURN)) candidates.push(...[...region.querySelectorAll("*")].filter((el) => !el.firstElementChild));
    for (const title of new Set(candidates)) {
      const name = title.textContent.trim();
      if (name.length > 12 || !SUMMARY_TITLE.test(name) || title.closest(TURN) || title.closest(ROLE) || title.closest(OWN_UI)) continue;
      const rect = title.getBoundingClientRect();
      if (!rect.width || !rect.height || rect.right <= win.innerWidth / 2) continue; // hidden, or on the left
      if (found.some((t) => t.contains(title))) continue; // a leaf inside a title we already have
      for (let i = found.length - 1; i >= 0; i--) if (title.contains(found[i])) found.splice(i, 1);
      found.push(title);
    }
    const outputs = found.find((t) => /^outputs?$/i.test(t.textContent.trim())) ?? null;
    if (!found.length) return hintedPane(page, win, this.composer(doc));
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
  /**
   * Where the panel buttons go in the page header's button area: just before the right-most header button, as
   * `{ parent, before }`; null when there is no header or no button in it (the buttons then float top-right).
   */
  headerActions(doc) {
    const header = pageHeader(doc);
    if (!header) return null;
    const win = doc.defaultView;
    let best = null;
    for (const b of header.querySelectorAll("button,a[href]")) {
      if (b.closest(OWN_UI)) continue;
      const r = b.getBoundingClientRect();
      if (r.width && r.right > win.innerWidth / 2 && (!best || r.right > best.right)) best = { el: b, right: r.right };
    }
    if (!best) return null;
    // Insert beside the button's outermost single-child wrappers, so ours is a sibling in the same row, not stacked inside one.
    let before = best.el;
    while (before.parentElement && before.parentElement !== header && nativeChildren(before.parentElement) === 1) before = before.parentElement;
    return { parent: before.parentElement, before, right: best.right };
  },
  /**
   * Whether ChatGPT's own summary pane (Activity / Outputs / Sources) is open, wherever it renders: the header toggle says
   * so, or a pane carrying its markup hint has a box (it is a popover outside the page when the page is narrow).
   */
  summaryOpen(doc) {
    if (scope(doc).querySelector(SUMMARY_TOGGLE)?.getAttribute("aria-pressed") === "true") return true;
    for (const el of doc.querySelectorAll(SUMMARY_HINT)) if (!el.closest(OWN_UI) && !el.closest(TURN) && el.getBoundingClientRect().width) return true;
    return false;
  },
  /**
   * ChatGPT's own summary pane wherever it renders, with its box: `{ el, left, right, inPage }`, or null. In a wide page it
   * is part of the page (`inPage`); in a narrow one ChatGPT shows it as a popover outside the page.
   */
  summaryCard(doc) {
    const page = scope(doc);
    for (const el of doc.querySelectorAll(SUMMARY_HINT)) {
      if (el.closest(OWN_UI) || el.closest(TURN)) continue;
      const r = el.getBoundingClientRect();
      if (r.width) return { el, left: r.left, right: r.right, inPage: page.contains(el) };
    }
    return null;
  },
  /**
   * Any other pane docked or floating over the right edge of the page (a Subagents or canvas view, say), found by
   * what is really painted there rather than by its title: the widest element on the right edge that is neither
   * the conversation nor the composer nor ours. `{ pane, container, left, outputs: null }` like `nativeSummary`, or null.
   */
  sidePane(doc) {
    const win = doc.defaultView;
    const W = win.innerWidth;
    const H = win.innerHeight;
    if (!doc.elementFromPoint) return null;
    const composer = this.composer(doc);
    let best = null;
    for (const y of [Math.max(24, this.headerBottom(doc) + 16), H * 0.3, H * 0.55, H * 0.8]) {
      let hit = doc.elementFromPoint(W - 16, y);
      if (!hit || hit.closest(OWN_UI)) continue;
      for (let el = hit; el && el !== doc.body && el !== doc.documentElement; el = el.parentElement) {
        const r = el.getBoundingClientRect();
        if (r.width > W * 0.6) break; // the page itself
        if (r.right < W - 24) continue; // a part inside the pane, not the pane
        if (el.matches(TURN) || el.closest(TURN) || (composer && el.contains(composer)) || el.querySelector(TURN) || el.querySelector(OWN_UI)) break;
        if (r.width >= 200 && r.height >= H * 0.25 && (!best || r.left < best.left)) best = { pane: el, left: r.left };
      }
    }
    return best && { pane: best.pane, container: best.pane, left: best.left, outputs: null };
  },
  /**
   * ChatGPT's collapsed thinking traces in the active page: the disclosure buttons of assistant turns ("Thought for 12s",
   * "Worked for 1m 5s", "Stopped thinking"), as `{ button, turn, key }` where `key` names the trace within its turn.
   * Buttons outside a turn (the model picker's "Thinking effort", say) never count.
   */
  thinkingToggles(doc) {
    const out = [];
    scope(doc)
      .querySelectorAll(TURN)
      .forEach((turn, turnIndex) => {
        let nth = 0;
        for (const button of turn.querySelectorAll("button[aria-expanded]")) {
          if (button.closest(OWN_UI) || !THINKING_TITLE.test((button.textContent ?? "").trim())) continue;
          out.push({ button, turn, key: `${this.turnId(turn, turnIndex)}#${nth++}` });
        }
      });
    return out;
  },
  /** Bottom edge of the page header (0 without one): the fallback pane docks below it. */
  headerBottom(doc) {
    return pageHeader(doc)?.getBoundingClientRect().bottom ?? 0;
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
  /**
   * The conversation-load failure card of the active page, or null: `{card, control}` where `control` is the
   * "Try again" button/link inside it. Only a page without turns can hold it, and a control inside a turn
   * (a per-message "Try again") never counts.
   */
  loadError(doc) {
    const page = scope(doc);
    if (page.querySelector(TURN)) return null;
    for (const control of page.querySelectorAll('button, a, [role="button"]')) {
      if (!RETRY_LABEL.test((control.textContent ?? "").trim())) continue;
      let card = control;
      for (let depth = 0; depth < 5 && card.parentElement && card !== page; depth++) {
        card = card.parentElement;
        const text = card.textContent ?? "";
        if (text.length < 600 && LOAD_ERROR.test(text)) return { card, control };
      }
    }
    return null;
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
