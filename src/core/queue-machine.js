// Pure queue state machine. #630 builds the UI and the real transport on top;
// the transport is injected so tests and dry runs never touch the page.
export const ITEM = Object.freeze({ QUEUED: "queued", SENDING: "sending", SENT: "sent", FAILED: "failed", CANCELLED: "cancelled" });

export function initialQueue() {
  return { items: [], interrupting: false };
}

const sending = (state) => state.items.find((i) => i.status === ITEM.SENDING);

function setStatus(state, id, from, to) {
  const item = state.items.find((i) => i.id === id);
  if (!item || item.status !== from) return state;
  return { ...state, items: state.items.map((i) => (i === item ? { ...i, status: to } : i)) };
}

// Actions: enqueue, start, sent, fail, cancel, interrupt, interrupted.
export function reduce(state, action) {
  switch (action.type) {
    case "enqueue":
      if (state.items.some((i) => i.id === action.id)) return state; // idempotent: no duplicate sends
      return { ...state, items: [...state.items, { id: action.id, text: action.text, status: ITEM.QUEUED }] };
    case "start":
      if (sending(state) || state.interrupting) return state; // one in flight at a time
      return setStatus(state, action.id, ITEM.QUEUED, ITEM.SENDING);
    case "sent":
      return setStatus(state, action.id, ITEM.SENDING, ITEM.SENT);
    case "fail":
      return setStatus(state, action.id, ITEM.SENDING, ITEM.FAILED);
    case "cancel":
      return setStatus(state, action.id, ITEM.QUEUED, ITEM.CANCELLED);
    case "interrupt":
      return sending(state) ? state : { ...state, interrupting: true };
    case "interrupted":
      return { ...state, interrupting: false };
    default:
      return state;
  }
}

export const nextQueued = (state) => state.items.find((i) => i.status === ITEM.QUEUED);

// Dispatch boundary: transport.send(item) -> Promise. dryRun never calls it.
export async function dispatchNext(state, { transport, dryRun = true }) {
  const item = nextQueued(state);
  if (!item) return state;
  let next = reduce(state, { type: "start", id: item.id });
  if (next === state) return state;
  if (dryRun) return reduce(next, { type: "sent", id: item.id });
  try {
    await transport.send(item);
    return reduce(next, { type: "sent", id: item.id });
  } catch {
    return reduce(next, { type: "fail", id: item.id });
  }
}
