import type { AttachmentRef, Clock } from "./types.ts";

/** What ChatGPT is doing right now, as the adapter can best tell. */
export type GenerationState = "idle" | "generating" | "unknown";

export interface SubmitRequest {
  itemId: string; // stable idempotency key
  attemptId: string;
  conversationId: string;
  text: string;
  attachments: AttachmentRef[];
}

export interface StopRequest {
  conversationId: string;
}

/** `rejected` means the message definitely did not leave; `uncertain` means it may have. */
export type SubmitResult =
  | { kind: "accepted" }
  | { kind: "rejected"; code: string; message: string; retryable: boolean }
  | { kind: "uncertain"; code: string; message: string };

export type StopResult =
  | { kind: "confirmed" }
  | { kind: "failed"; code: string; message: string }
  | { kind: "ambiguous"; code: string; message: string };

/**
 * The only thing that touches ChatGPT. A live adapter (later packet) clicks
 * Send/Stop; `DryRunDispatcher` has no side effects at all.
 */
export interface DispatchAdapter {
  readState(conversationId: string): Promise<GenerationState>;
  submit(request: SubmitRequest): Promise<SubmitResult>;
  stop(request: StopRequest): Promise<StopResult>;
}

export type BoundaryStopResult =
  | { kind: "confirmed" }
  | { kind: "failed"; code: string; message: string }
  | { kind: "timeout"; code: "stop-timeout"; message: string }
  | { kind: "ambiguous"; code: string; message: string };

export interface BoundaryOptions {
  clock: Clock;
  submitTimeoutMs?: number;
  stopTimeoutMs?: number;
  /** Observes every action just before it reaches the adapter. */
  onAction?: (action: { type: "submit" | "stop"; conversationId: string; itemId?: string }) => void;
}

const TIMED_OUT = Symbol("timed-out");

/**
 * The single dispatch boundary: the queue engine holds this and nothing else,
 * so every send and stop passes through it. It normalizes adapter failure into
 * the safe reading (a throw or timeout during submit is `uncertain`; a stop is
 * only `confirmed` once the adapter also reports the conversation idle).
 */
export class DispatchBoundary {
  readonly #adapter: DispatchAdapter;
  readonly #opts: Required<Omit<BoundaryOptions, "onAction">> & Pick<BoundaryOptions, "onAction">;

  constructor(adapter: DispatchAdapter, opts: BoundaryOptions) {
    this.#adapter = adapter;
    this.#opts = { submitTimeoutMs: 10_000, stopTimeoutMs: 10_000, ...opts };
  }

  async readState(conversationId: string): Promise<GenerationState> {
    try {
      return await this.#adapter.readState(conversationId);
    } catch {
      return "unknown";
    }
  }

  async submit(request: SubmitRequest): Promise<SubmitResult> {
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

  async stop(conversationId: string): Promise<BoundaryStopResult> {
    this.#opts.onAction?.({ type: "stop", conversationId });
    let result: StopResult | typeof TIMED_OUT;
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

  #race<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
    return new Promise((resolve, reject) => {
      const cancel = this.#opts.clock.after(ms, () => resolve(TIMED_OUT));
      work.then(
        (value) => {
          cancel();
          resolve(value);
        },
        (error: unknown) => {
          cancel();
          reject(error);
        },
      );
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type ScriptedOutcome<T> = T | Error | "hang";

export type DispatchLogEntry =
  | { type: "submit"; request: SubmitRequest }
  | { type: "stop"; request: StopRequest };

/**
 * No-side-effect adapter: records every action and answers from a script.
 * Defaults model a healthy ChatGPT (submit starts generation, stop ends it).
 * `generating` is the externally visible state tests and the engine observe.
 */
export class DryRunDispatcher implements DispatchAdapter {
  readonly log: DispatchLogEntry[] = [];
  state: GenerationState;
  submitScript: ScriptedOutcome<SubmitResult>[] = [];
  stopScript: ScriptedOutcome<StopResult>[] = [];
  /** Set to make `readState` throw (adapter cannot tell). */
  stateError: Error | null = null;
  #stateOverrides: GenerationState[] = [];

  constructor(initial: GenerationState = "idle") {
    this.state = initial;
  }

  /** Queue one-shot answers for the next `readState` calls (race injection). */
  overrideState(...states: GenerationState[]): void {
    this.#stateOverrides.push(...states);
  }

  async readState(): Promise<GenerationState> {
    if (this.stateError) throw this.stateError;
    return this.#stateOverrides.shift() ?? this.state;
  }

  async submit(request: SubmitRequest): Promise<SubmitResult> {
    this.log.push({ type: "submit", request });
    const outcome = this.submitScript.shift() ?? ({ kind: "accepted" } as const);
    const result = await play(outcome);
    if (result.kind === "accepted") this.state = "generating";
    return result;
  }

  async stop(request: StopRequest): Promise<StopResult> {
    this.log.push({ type: "stop", request });
    const outcome = this.stopScript.shift() ?? ({ kind: "confirmed" } as const);
    const result = await play(outcome);
    if (result.kind === "confirmed") this.state = "idle";
    return result;
  }

  /** The response finished on its own. */
  finishGeneration(): void {
    this.state = "idle";
  }

  actions(): string[] {
    return this.log.map((entry) => (entry.type === "submit" ? `submit:${entry.request.itemId}` : "stop"));
  }
}

async function play<T>(outcome: ScriptedOutcome<T>): Promise<T> {
  if (outcome === "hang") return new Promise<T>(() => undefined);
  if (outcome instanceof Error) throw outcome;
  return outcome;
}
