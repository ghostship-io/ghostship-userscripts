// A fake ChatGPT page built from DOM fixtures: a composer (textarea or ProseMirror-like contenteditable), a Send
// button that enables on input, a Stop button while "streaming", and optionally a native steer button. Nothing here
// touches the network or the real site: Send and Stop are buttons on a jsdom page that only append log lines.
import { createComposerIO } from "../src/chatgpt/queue/composer.js";
import { loadFixture } from "./helpers.js";

export const TARGET = { accountId: "unknown", conversationId: "fixture" };

export async function fakePage({ editable = "textarea", acknowledges = true, stopWorks = true, steer = false, sendOnlyWithText = false, sendMissing = false, profile = null, sendLabel = false } = {}) {
  const dom = await loadFixture();
  const { window } = dom;
  const doc = window.document;
  const old = doc.querySelector("#prompt-textarea");
  const form = doc.createElement("form");
  form.id = "composer";
  let input;
  if (editable === "textarea") {
    input = old;
  } else {
    input = doc.createElement("div");
    input.id = "prompt-textarea";
    input.setAttribute("contenteditable", "true");
    old.remove();
    // jsdom has no execCommand; emulate what ProseMirror does: one paragraph per line, an empty one holds a <br>.
    const paragraph = (text = "") => {
      const p = doc.createElement("p");
      if (text) p.textContent = text;
      else p.append(doc.createElement("br"));
      return p;
    };
    // `page.fill`: "now" (default), a number of ms (the editor applies input late, as ProseMirror does), or "never".
    const apply = (command, value) => {
      if (command === "delete") input.replaceChildren();
      else if (command === "insertParagraph") {
        if (!input.lastElementChild) input.append(paragraph());
        input.append(paragraph());
      } else if (command === "insertText") {
        let last = input.lastElementChild;
        if (!last) input.append((last = paragraph()));
        if (last.childNodes.length === 1 && last.firstChild.nodeName === "BR") last.replaceChildren();
        last.append(doc.createTextNode(value));
      }
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    };
    doc.execCommand = (command, _ui, value) => {
      if (page.fill === "never") return true; // accepted, never shown
      if (typeof page.fill === "number") setTimeout(() => apply(command, value), page.fill);
      else apply(command, value);
      return true;
    };
  }
  form.append(input);
  doc.querySelector("main").append(form);
  if (profile) {
    const button = doc.createElement("button");
    button.setAttribute("data-testid", "accounts-profile-button");
    button.textContent = profile;
    doc.body.append(button);
  }

  const page = { window, doc, input, form, fill: "now", log: [], streaming: false, send: null, stop: null, steerButton: null };
  const text = () =>
    editable === "textarea"
      ? input.value
      : [...input.children].map((p) => (p.childNodes.length === 1 && p.firstChild.nodeName === "BR" ? "" : p.textContent)).join("\n");
  page.text = text;
  page.type = (value) => {
    if (editable === "textarea") input.value = value;
    else {
      input.replaceChildren();
      value.split("\n").forEach((line) => {
        const p = doc.createElement("p");
        if (line) p.textContent = line;
        else p.append(doc.createElement("br"));
        input.append(p);
      });
    }
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  };
  const clear = () => page.type("");
  const addTurn = (role, content) => {
    const turn = doc.createElement("article");
    turn.setAttribute("data-testid", `conversation-turn-${100 + doc.querySelectorAll("article").length}`);
    turn.innerHTML = `<div data-message-author-role="${role}"></div>`;
    turn.firstChild.textContent = content;
    doc.querySelector("[data-scroll-root]").append(turn);
  };
  const button = (testid, onClick) => {
    const b = doc.createElement("button");
    b.type = "button";
    // ChatGPT's current composer has no test ids: Send is the form's submit button labelled "Send".
    if (sendLabel && testid === "send-button") (b.setAttribute("type", "submit"), b.setAttribute("aria-label", "Send"));
    else b.setAttribute("data-testid", testid);
    b.addEventListener("click", onClick);
    form.append(b);
    return b;
  };
  const sync = () => {
    const filled = text().trim() !== "";
    if (page.send) page.send.disabled = !filled;
    if (sendOnlyWithText && !page.streaming) {
      if (filled && !page.send) page.mountSend();
      if (!filled && page.send) (page.send.remove(), (page.send = null));
    }
    if (steer && page.streaming) {
      if (filled && !page.steerButton) {
        page.steerButton = button("steer-button", () => {
          page.log.push(`steer:${text().trim()}`);
          addTurn("user", text().trim());
          clear();
        });
      }
      if (!filled && page.steerButton) (page.steerButton.remove(), (page.steerButton = null));
    }
  };
  page.startStreaming = () => {
    page.streaming = true;
    page.send?.remove();
    page.send = null;
    page.stop = button("stop-button", () => {
      page.log.push("stop");
      if (stopWorks) page.finishStreaming();
    });
    sync();
  };
  page.finishStreaming = () => {
    page.streaming = false;
    page.stop?.remove();
    page.stop = null;
    page.steerButton?.remove();
    page.steerButton = null;
    if (!sendOnlyWithText || text().trim() !== "") page.mountSend();
    addTurn("assistant", "reply");
  };
  page.mountSend = () => {
    page.send = button("send-button", () => {
      if (page.send.disabled) return;
      page.log.push(`send:${text().trim()}`);
      if (!acknowledges) return;
      addTurn("user", text().trim());
      clear();
      page.startStreaming();
    });
    page.send.disabled = text().trim() === "";
  };
  if (sendMissing) page.mountSend = () => {}; // the page never shows a Send button
  input.addEventListener("input", sync);
  if (!sendOnlyWithText) page.mountSend();
  // The conversation the active page says it holds (ChatGPT stamps its composer wrapper); null removes the stamp.
  page.holds = (id) => {
    form.parentElement.toggleAttribute("data-map-composer-conversation", id !== null);
    if (id !== null) form.parentElement.setAttribute("data-map-composer-conversation", id);
  };
  // The sidebar: a nav of conversation rows (the link holds the title span), outside the page.
  page.sidebar = (ids) => {
    doc.querySelector("nav[data-fake-sidebar]")?.remove();
    const nav = doc.createElement("nav");
    nav.setAttribute("data-fake-sidebar", "");
    for (const id of ids) {
      const a = doc.createElement("a");
      a.setAttribute("href", `/c/${id}`);
      a.innerHTML = '<span data-thread-title="true">title</span>';
      nav.append(a);
    }
    doc.body.prepend(nav);
    return nav;
  };
  page.sends = () => page.log.filter((e) => e.startsWith("send:"));
  page.io = createComposerIO(window);
  return page;
}
