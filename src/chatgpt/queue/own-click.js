// The live dispatcher's own Send click, visible to the controller's capture-phase interception. A native Send click
// submits ChatGPT's form synchronously, and the controller swallows a form submit while a response runs (that is how
// the owner's Enter goes to the queue); the dispatcher's click must not be swallowed by its own queue.
export const ownClick = { active: false };

/** Runs `click()` with the flag up, whatever it does. */
export function clickAsOwn(click) {
  ownClick.active = true;
  try {
    click();
  } finally {
    ownClick.active = false;
  }
}
