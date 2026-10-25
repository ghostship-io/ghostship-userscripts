// The only module allowed to write scroll position. Everything else asks.
// Only explicit user intent may move the viewport; other sources are refused.
export const MOVING_SOURCES = Object.freeze(["user", "prompt-nav", "minimap", "keyboard"]);

export function createScrollManager({ scroller, diagnostics }) {
  return {
    // Explicit navigation or user scroll.
    scrollTo(source, top) {
      if (!MOVING_SOURCES.includes(source)) {
        diagnostics?.count(`scroll.refused.${source}`);
        return false;
      }
      scroller.scrollTop = top;
      diagnostics?.count(`scroll.moved.${source}`);
      return true;
    },
    // Run a DOM change while keeping `anchor` at the same viewport offset, so
    // adding/removing turns above it does not shift what the user is reading.
    preserve(anchor, mutate) {
      const before = anchor.getBoundingClientRect().top;
      mutate();
      const drift = anchor.getBoundingClientRect().top - before;
      if (drift !== 0) {
        scroller.scrollTop += drift;
        diagnostics?.count("scroll.anchor-compensated");
      }
      return drift;
    },
  };
}
