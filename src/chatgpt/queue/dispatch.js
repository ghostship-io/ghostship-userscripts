/** What ChatGPT is doing right now, as the adapter can best tell. */

/** `rejected` means the message definitely did not leave; `uncertain` means it may have. */

/**
 * The only thing that touches ChatGPT. A live adapter (later packet) clicks
 * Send/Stop; `DryRunDispatcher` has no side effects at all.
 */

const TIMED_OUT = Symbol("timed-out");

/**
 * The single dispatch boundary: the queue engine holds this and nothing else,
 * so every send and stop passes through it. It normalizes adapter failure into
 * the safe reading (a throw or timeout during submit is `uncertain`; a stop is
 * only `confirmed` once the adapter also reports the conversation idle).
 */
export class DispatchBoundary {
  #adapter;
  #opts;

  constructor(adapter, opts) {
    this.#adapter = adapter;
    this.#opts = { submitTimeoutMs: 10_000, stopTimeoutMs: 10_000, ...opts };
  }

  async readState(conversationId) {
    try {
      return await this.#adapter.readState(conversationId);
    } catch {
      return "unknown";
    }
  }

  async submit(request) {
    this.#opts.onAction?.({ type: "submit", conversationId: request.conversationId, itemId: request.itemId });
    try {
      const result = await this.#race(this.#adapter.submit(request), this.#opts.submitTimeoutMs);
      if (result === TIMED_OUT) {
        return { kind: "uncertain", code: "submit-timeout", message: "No submit acknowledgment before the timeout." };
      }
      return result;
    } catch (error) {
      return { kind: "uncertain", code: "submit-threw", message: describe(error) };
    }
  }

  async stop(conversationId) {
    this.#opts.onAction?.({ type: "stop", conversationId });
    let result;
    try {
      result = await this.#race(this.#adapter.stop({ conversationId }), this.#opts.stopTimeoutMs);
    } catch (error) {
      return { kind: "ambiguous", code: "stop-threw", message: describe(error) };
    }
    if (result === TIMED_OUT) {
      return { kind: "timeout", code: "stop-timeout", message: "No stop acknowledgment before the timeout." };
    }
    if (result.kind !== "confirmed") return result;
    const state = await this.readState(conversationId);
    if (state !== "idle") {
      return {
        kind: "ambiguous",
        code: "stop-not-idle",
        message: `Stop was acknowledged but the conversation reads "${state}".`,
      };
    }
    return result;
  }

  #race(work, ms) {
    return new Promise((resolve, reject) => {
      const cancel = this.#opts.clock.after(ms, () => resolve(TIMED_OUT));
      work.then(
        (value) => {
          cancel();
          resolve(value);
        },
        (error) => {
          cancel();
          reject(error);
        },
      );
    });
  }
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * No-side-effect adapter: records every action and answers from a script.
 * Defaults model a healthy ChatGPT (submit starts generation, stop ends it).
 * `generating` is the externally visible state tests and the engine observe.
 */
export class DryRunDispatcher {
  /** Lets the UI label the queue as not sending anything. */
  dryRun = true;
  log = [];
  state;
  submitScript = [];
  stopScript = [];
  /** Set to make `readState` throw (adapter cannot tell). */
  stateError = null;
  #stateOverrides = [];

  constructor(initial = "idle") {
    this.state = initial;
  }

  /** Queue one-shot answers for the next `readState` calls (race injection). */
  overrideState(...states) {
    this.#stateOverrides.push(...states);
  }

  async readState() {
    if (this.stateError) throw this.stateError;
    return this.#stateOverrides.shift() ?? this.state;
  }

  async submit(request) {
    this.log.push({ type: "submit", request });
    const outcome = this.submitScript.shift() ?? { kind: "accepted" };
    const result = await play(outcome);
    if (result.kind === "accepted") this.state = "generating";
    return result;
  }

  async stop(request) {
    this.log.push({ type: "stop", request });
    const outcome = this.stopScript.shift() ?? { kind: "confirmed" };
    const result = await play(outcome);
    if (result.kind === "confirmed") this.state = "idle";
    return result;
  }

  /** The response finished on its own. */
  finishGeneration() {
    this.state = "idle";
  }

  actions() {
    return this.log.map((entry) => (entry.type === "submit" ? `submit:${entry.request.itemId}` : "stop"));
  }
}

async function play(outcome) {
  if (outcome === "hang") return new Promise(() => undefined);
  if (outcome instanceof Error) throw outcome;
  return outcome;
}
