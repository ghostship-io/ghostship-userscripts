import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

export async function loadFixture(name = "chatgpt-thread.html") {
  const html = await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
  return new JSDOM(html, { url: "https://chatgpt.com/c/fixture", pretendToBeVisual: true });
}

export const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
