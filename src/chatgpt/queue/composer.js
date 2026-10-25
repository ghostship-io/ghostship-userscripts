// Reading and writing the text of ChatGPT's native composer (a ProseMirror contenteditable, or a plain
// textarea). It never submits anything: the controller uses it to stage a queued prompt for Edit, the
// live dispatcher to stage the text it is about to send.

const BLOCKS = new Set(["P", "DIV", "LI", "PRE", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE"]);

/** Text with the line structure the user sees: one line per paragraph, `<br>` as a line break. */
function textOf(node) {
  let out = "";
  for (const child of node.childNodes) {
    if (child.nodeType === 3) out += child.nodeValue;
    else if (child.nodeName === "BR") out += child.classList?.contains("ProseMirror-trailingBreak") ? "" : "\n";
    else out += textOf(child);
  }
  return out;
}

export function createComposerIO(win) {
  const doc = win.document;
  const isField = (el) => el.tagName === "TEXTAREA" || el.tagName === "INPUT";

  /** Exact text of the composer, paragraphs separated by one newline (an empty paragraph is a blank line). */
  function read(el) {
    if (isField(el)) return el.value;
    const blocks = [...el.childNodes].filter((n) => n.nodeType === 1 && BLOCKS.has(n.nodeName));
    if (!blocks.length) return textOf(el);
    // A placeholder paragraph holding only a <br> is an empty line; textOf renders it as "\n", so strip one.
    return blocks
      .map((block) => {
        const text = textOf(block);
        return block.childNodes.length === 1 && block.firstChild.nodeName === "BR" ? "" : text;
      })
      .join("\n");
  }

  const hasText = (el) => read(el).trim() !== "";

  /** Replaces the whole composer content. Returns false when the page refused the edit. */
  function write(el, text) {
    el.focus?.();
    if (isField(el)) {
      // React tracks the value through the prototype setter; assigning `.value` directly would be ignored.
      const proto = el.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
      el.dispatchEvent(new win.Event("input", { bubbles: true }));
      return true;
    }
    const selection = win.getSelection();
    const range = doc.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
    if (text === "") return doc.execCommand("delete");
    const lines = text.split("\n");
    let ok = doc.execCommand("delete") !== false;
    lines.forEach((line, index) => {
      if (index > 0) ok = doc.execCommand("insertParagraph") !== false && ok;
      if (line !== "") ok = doc.execCommand("insertText", false, line) !== false && ok;
    });
    return ok;
  }

  return { read, write, hasText };
}
