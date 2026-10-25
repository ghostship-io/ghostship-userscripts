/**
 * What the dispatcher answers, as the engine reads it.
 *
 * readState: "idle" | "generating" | "unknown".
 * readiness: {state: "ready"} | {state: "waiting", reason} | {state: "blocked", code, message, action}.
 *   Waiting is a normal state, never an attempt and never an error.
 * submit / steer: one of
 *   {kind: "accepted"}                     ChatGPT showed it took the message.
 *   {kind: "uncertain", code, message}     Send was clicked and nothing confirmed it; never retried.
 *   {kind: "rejected", code, message, action}  Nothing was sent and it will not work until the user acts.
 *   {kind: "wait", reason}                 Nothing was sent; the page was not ready after all.
 *   {kind: "unsupported"}                  (steer only) no positively detected native steer path.
 * stop: {kind: "confirmed"} | {kind: "failed"|"ambiguous"|"timeout", code, message}.
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
    // The live dispatcher bounds itself well under these (stage 8s + acknowledgment 6s).
    this.#opts = { submitTimeoutMs: 30_000, stopTimeoutMs: 10_000, ...opts };
  }

  async readState(target) {
    try {
      return await this.#adapter.readState(target);
    } catch {
      return "unknown";
    }
  }

  async readiness(target) {
    try {
      return await this.#adapter.readiness(target);
    } catch {
      return { state: "waiting", reason: "unknown-state" };
    }
  }

  submit(request) {
    return this.#send("submit", request);
  }

  async steer(request) {
    if (typeof this.#adapter.steer !== "function") return { kind: "unsupported" };
    return this.#send("steer", request);
  }

  async #send(type, request) {
    this.#opts.onAction?.({ type, conversationId: request.conversationId, itemId: request.itemId });
    try {
      const result = await this.#race(this.#adapter[type === "steer" ? "steer" : "submit"](request), this.#opts.submitTimeoutMs);
      if (result === TIMED_OUT) {
        return { kind: "uncertain", code: `${type}-timeout`, message: "No acknowledgment before the timeout." };
      }
      return result;
    } catch (error) {
      return { kind: "uncertain", code: `${type}-threw`, message: describe(error) };
    }
  }

  async stop(target) {
    this.#opts.onAction?.({ type: "stop", conversationId: target.conversationId });
    let result;
    try {
      result = await this.#race(this.#adapter.stop(target), this.#opts.stopTimeoutMs);
    } catch (error) {
      return { kind: "ambiguous", code: "stop-threw", message: describe(error) };
    }
    if (result === TIMED_OUT) {
      return { kind: "timeout", code: "stop-timeout", message: "No stop acknowledgment before the timeout." };
    }
    if (result.kind !== "confirmed") return result;
    const state = await this.readState(target);
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
 * `state` is the externally visible state tests and the engine observe.
 */
export class DryRunDispatcher {
  /** Lets the UI label the queue as not sending anything. */
  dryRun = true;
  log = [];
  state;
  /** False models a settled response whose native Send is not (yet) available. */
  sendReady = true;
  /** True models a positively detected native steer path. */
  steerAvailable = false;
  submitScript = [];
  steerScript = [];
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

  async readiness() {
    const state = await this.readState();
    if (state === "generating") return { state: "waiting", reason: "generating" };
    if (state !== "idle") return { state: "waiting", reason: "unknown-state" };
    if (!this.sendReady) return { state: "waiting", reason: "send-unavailable" };
    return { state: "ready" };
  }

  async submit(request) {
    this.log.push({ type: "submit", request });
    const outcome = this.submitScript.shift() ?? { kind: "accepted" };
    const result = await play(outcome);
    if (result.kind === "accepted") this.state = "generating";
    return result;
  }

  async steer(request) {
    if (!this.steerAvailable) return { kind: "unsupported" };
    this.log.push({ type: "steer", request });
    const outcome = this.steerScript.shift() ?? { kind: "accepted" };
    return play(outcome);
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
    return this.log.map((entry) => (entry.type === "stop" ? "stop" : `${entry.type}:${entry.request.itemId}`));
  }
}

async function play(outcome) {
  if (outcome === "hang") return new Promise(() => undefined);
  if (outcome instanceof Error) throw outcome;
  return outcome;
}
