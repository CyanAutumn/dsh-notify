// Smoke test for dsh-notify: load the browser bundle with a fake host, then
// drive the Remote events and assert the notifications it raises.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const code = readFileSync(fileURLToPath(new URL("../lib/client.js", import.meta.url)), "utf8");

// ── fake browser ────────────────────────────────────────────────────────────
const notifications = [];
const osInstances = [];
class FakeNotification {
  static permission = "granted";
  static requestPermission() {
    return Promise.resolve("granted");
  }
  constructor(title, options) {
    this.title = title;
    this.options = options || {};
    this.onclick = null;
    notifications.push({ title, body: this.options.body, tag: this.options.tag });
    osInstances.push(this);
  }
  close() {}
}
globalThis.Notification = FakeNotification;
globalThis.localStorage = {
  store: new Map(),
  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  },
  setItem(key, value) {
    this.store.set(key, String(value));
  },
};

// In-app cards: counted, and their click handlers are dispatchable.
const cards = [];
const createdElements = [];
let toastCards = 0;
function element() {
  const listeners = new Map();
  const el = {
    dataset: {},
    style: {},
    textContent: "",
    type: "",
    children: [],
    classList: { add() {} },
    setAttribute() {},
    addEventListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
    },
    dispatch(name) {
      for (const fn of listeners.get(name) || []) fn({ type: name, stopPropagation() {}, altKey: false });
    },
    append(...nodes) {
      el.children.push(...nodes);
    },
    remove() {
      el.removed = true;
    },
  };
  Object.defineProperty(el, "className", {
    enumerable: true,
    get: () => el.__className ?? "",
    set: (value) => {
      el.__className = value;
      if (String(value).split(/\s+/).includes("dshn-toast")) {
        toastCards += 1;
        cards.push(el);
      }
    },
  });
  createdElements.push(el);
  return el;
}

const windowListeners = new Map();
function fireWindow(name) {
  for (const fn of windowListeners.get(name) || []) fn({ type: name });
}

globalThis.window = {
  __ModuleLoader__: { load: (def) => { globalThis.__module = def; } },
  setTimeout: (fn) => setTimeout(fn, 0),
  clearTimeout: (id) => clearTimeout(id),
  focus: () => {},
  addEventListener(name, fn) {
    if (!windowListeners.has(name)) windowListeners.set(name, []);
    windowListeners.get(name).push(fn);
  },
  removeEventListener() {},
};
globalThis.document = {
  visibilityState: "hidden",
  hasFocus: () => false,
  getElementById: () => null,
  createElement: () => element(),
  head: { append() {} },
  body: { append() {} },
  querySelector: () => null,
  addEventListener() {},
  removeEventListener() {},
};

// ── load the bundle ─────────────────────────────────────────────────────────
eval(code);
const mod = globalThis.__module.factory((name) => {
  throw new Error(`unexpected require ${name}`);
});
if (typeof mod.apply !== "function") throw new Error("apply missing");

// ── fake plugin context with a Remote event bus ─────────────────────────────
const handlers = new Map();
const remote = {
  $on(name, handler) {
    handlers.set(name, handler);
    return () => handlers.delete(name);
  },
};
const sessionsSnapshot = {
  byId: { "session-abc123def": { title: "修复武器系统" } },
  ids: ["session-abc123def"],
};
const opened = [];
const uiWorkspace = {
  openSession(target) {
    opened.push(typeof target === "string" ? target : target?.sessionId);
  },
};
const ctx = {
  remote,
  uiWorkspace,
  get(name) {
    if (name === "remote") return remote;
    if (name === "uiWorkspace") return ctx.uiWorkspace;
    if (name === "sessions") return { list: { getSnapshot: () => sessionsSnapshot } };
    return undefined;
  },
  effect(fn) {
    const dispose = fn();
    ctx.__dispose = dispose;
  },
};

mod.apply(ctx);
// The bell was the only in-page affordance; the UI must now stay button-free.
check(
  "no bell button is mounted",
  !createdElements.some((el) => String(el.__className || "").includes("dshn-bell")),
  JSON.stringify(createdElements.map((el) => el.__className)),
);
// The host endpoint is not part of this unit test: without `fetch` the goal
// lookup degrades to "unknown" immediately instead of probing a live app.
globalThis.fetch = undefined;
// The renderer OS channel is off by default now (the host half raises Windows
// toasts); enable it here so the renderer-side rules stay covered.
window.dshNotify.config({ hostOs: false });

let failures = 0;
// Completion delivery now asks the host half for goal state before notifying,
// so a status event settles on a microtask even when the endpoint is absent.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
function check(label, ok, detail) {
  if (ok) return;
  failures += 1;
  console.log("FAIL:", label, detail ?? "");
}
const status = handlers.get("api-session/status");
const snapshot = () => ({ os: notifications.length, cards: toastCards });
const delta = (before) => ({ os: notifications.length - before.os, cards: toastCards - before.cards });

/** Fire one status event and let the async goal lookup settle. */
async function statusVia(running) {
  status("session-abc123def", running);
  await settle();
}

// 1. turn completes (running true -> false) -> both channels while unfocused
let before = snapshot();
await statusVia(true)
await statusVia(false)
let d = delta(before);
check("completion uses both channels when unfocused", d.os === 1 && d.cards === 1, JSON.stringify(d));
check("completion body uses session title", notifications[0]?.body === "修复武器系统", JSON.stringify(notifications[0]));

// 1b. clicking either channel jumps to the session that raised it
cards.at(-1).dispatch("click");
check("card click jumps to the session", opened.at(-1) === "session-abc123def", JSON.stringify(opened));
osInstances.at(-1).onclick();
check("OS notification click jumps to the session", opened.at(-1) === "session-abc123def", JSON.stringify(opened));

// 2. duplicate running=false does not re-notify
before = snapshot();
await statusVia(false)
d = delta(before);
check("no duplicate completion", d.os === 0 && d.cards === 0, JSON.stringify(d));

// 3. error event notifies
before = snapshot();
handlers.get("api-session/error")("session-abc123def", "boom");
d = delta(before);
check("error notified", d.os === 1 && notifications.at(-1).title === "任务出错", JSON.stringify(d));

// 4. question waterfall: notify AND still call next()
let nextCalled = 0;
before = snapshot();
handlers.get("user-questions/request")({ callId: "call-1", sessionId: "session-abc123def", questions: [{}, {}] }, () => {
  nextCalled += 1;
  return "downstream";
});
d = delta(before);
check("question notified", d.os === 1 && notifications.at(-1).title === "需要你回答", JSON.stringify(d));
check("question passes through next()", nextCalled === 1, String(nextCalled));

// 5. same callId does not notify twice
before = snapshot();
handlers.get("user-questions/request")({ callId: "call-1", sessionId: "session-abc123def" }, () => { nextCalled += 1; });
d = delta(before);
check("question deduplicated", d.os === 0 && d.cards === 0, JSON.stringify(d));
check("deduplicated question still forwards", nextCalled === 2, String(nextCalled));

// 6. approval waterfall
before = snapshot();
handlers.get("approval/request")({ callId: "call-2", toolName: "pwsh", sessionId: "session-abc123def" }, () => { nextCalled += 1; });
d = delta(before);
check("approval notified", d.os === 1 && notifications.at(-1).title === "需要授权", JSON.stringify(d));
check("approval message names the tool", String(notifications.at(-1)?.body).includes("pwsh"), JSON.stringify(notifications.at(-1)));

// 7. focused window: the OS channel stays quiet, the in-app card still shows
document.visibilityState = "visible";
document.hasFocus = () => true;
fireWindow("focus");
before = snapshot();
await statusVia(true)
await statusVia(false)
d = delta(before);
check("focused window suppresses the OS toast", d.os === 0, JSON.stringify(d));
check("focused window still shows the in-app card", d.cards === 1, JSON.stringify(d));

// 8. window blur re-enables the OS channel even if hasFocus() lags behind
fireWindow("blur");
before = snapshot();
await statusVia(true)
await statusVia(false)
d = delta(before);
check("blur re-enables the OS toast", d.os === 1 && d.cards === 1, JSON.stringify(d));

// 9. runtime switch turns everything off
window.dshNotify.config({ onlyWhenUnfocused: false, enabled: false });
before = snapshot();
await statusVia(true)
await statusVia(false)
d = delta(before);
check("disabled suppresses both channels", d.os === 0 && d.cards === 0, JSON.stringify(d));

// 10. plain test() respects the focus rules, force sends both channels
document.hasFocus = () => true;
fireWindow("focus");
window.dshNotify.config({ enabled: true, onlyWhenUnfocused: true });
before = snapshot();
const plain = window.dshNotify.test();
d = delta(before);
check("test() keeps the OS channel quiet while focused", d.os === 0 && d.cards === 1, JSON.stringify(d));
check("test() reports the verdict", plain.os === false && plain.toast === true, JSON.stringify(plain));

before = snapshot();
const result = window.dshNotify.test({ force: true });
d = delta(before);
check("forced test() sends the OS notification", d.os === 1, JSON.stringify(d));
check("forced test() also shows the in-app card", d.cards === 1, JSON.stringify(d));
check("forced test() reports both channels", result.os === true && result.toast === true, JSON.stringify(result));
check("test card explains the verdict", notifications.at(-1)?.body?.includes("判定：前台") && notifications.at(-1)?.body?.includes("权限："), JSON.stringify(notifications.at(-1)));

// 11. diag() exposes the bridge, focus state and counters
const diag = window.dshNotify.diag();
check("diag reports a bridged remote", diag.bridged === true, JSON.stringify(diag));
check("diag counts handled status events", diag.stats.status === 9, JSON.stringify(diag.stats));
check("diag counts delivered notifications", diag.stats.notified === 8, JSON.stringify(diag.stats));
check("diag records the last delivery", diag.stats.lastDelivery?.focused === true && diag.stats.lastDelivery?.os === true, JSON.stringify(diag.stats.lastDelivery));
check("diag reports the jump service", diag.jump === true, JSON.stringify(diag));
check("diag records a successful jump", diag.lastJump?.ok === true && diag.lastJump?.sessionId === "session-abc123def", JSON.stringify(diag.lastJump));

// 12. a missing jump service surfaces an error card instead of failing silently
ctx.uiWorkspace = undefined;
before = snapshot();
await statusVia(true)
await statusVia(false)
cards.at(-1).dispatch("click");
const diag2 = window.dshNotify.diag();
check("failed jump is recorded", diag2.lastJump?.ok === false, JSON.stringify(diag2.lastJump));
check("failed jump shows an error card", cards.at(-1)?.dataset.kind === "error", JSON.stringify(cards.at(-1)?.dataset));
check("failed jump names the reason", String(diag2.lastJump?.reason || "").includes("uiWorkspace"), JSON.stringify(diag2.lastJump));

// 13. hostOs mode leaves the OS channel to the host half
window.dshNotify.config({ hostOs: true });
before = snapshot();
const hostMode = window.dshNotify.test({ force: true });
d = delta(before);
check("hostOs suppresses the renderer OS channel", d.os === 0 && d.cards === 1, JSON.stringify(d));
check("hostOs still reports a card", hostMode.toast === true && hostMode.os === false, JSON.stringify(hostMode));
window.dshNotify.config({ hostOs: false });

// 14. a running /goal must not notify per continuation round
// The host half owns goal state; here it answers "still intermediate".
let goalAnswer = { ok: true, sessionId: "session-abc123def", hasGoal: true, phase: "active", activation: "armed", intermediate: true, roundsStarted: 4 };
globalThis.fetch = async (href) => {
  const url = String(href);
  const payload = url.includes("/health")
    ? { ok: true, plugin: "dsh-notify" }
    : url.includes("/goal")
      ? goalAnswer
      : url.includes("/pending")
        ? { ok: true, items: [] }
        : { ok: false };
  return { ok: true, json: async () => payload };
};

before = snapshot();
await statusVia(true);
await statusVia(false);
d = delta(before);
check("goal round does not notify", d.os === 0 && d.cards === 0, JSON.stringify(d));
const goalDiag = window.dshNotify.diag();
check("goal round counted as skipped", goalDiag.goals.skipped === 1, JSON.stringify(goalDiag.goals));
check("goal round records the goal phase", goalDiag.goals.last?.phase === "active" && goalDiag.goals.last?.intermediate === true, JSON.stringify(goalDiag.goals.last));

// 15. the round that settles the goal notifies exactly once, with goal wording
goalAnswer = { ok: true, sessionId: "session-abc123def", hasGoal: true, phase: "complete", activation: "armed", intermediate: false, roundsStarted: 5 };
before = snapshot();
await statusVia(true);
await statusVia(false);
d = delta(before);
// The window is focused at this point, so only the in-app card is due.
check("settled goal notifies once", d.cards === 1, JSON.stringify(d));
check("settled goal uses goal wording", cards.at(-1)?.children?.[0]?.children?.[0]?.textContent === "目标已完成", JSON.stringify(cards.at(-1)?.children?.[0]?.children?.[0]?.textContent));
check("settled goal is not counted as skipped", window.dshNotify.diag().goals.skipped === 1, JSON.stringify(window.dshNotify.diag().goals));

// 16. a blocked goal says so instead of "任务已完成"
goalAnswer = { ok: true, sessionId: "session-abc123def", hasGoal: true, phase: "blocked", activation: "armed", intermediate: false, roundsStarted: 5, blockedReason: "上下文已满" };
before = snapshot();
await statusVia(true);
await statusVia(false);
check("blocked goal uses blocked wording", cards.at(-1)?.children?.[0]?.children?.[0]?.textContent === "目标受阻", JSON.stringify(cards.at(-1)?.children?.[0]?.children?.[0]?.textContent));

console.log("notifications:", notifications.map((n) => `${n.title} | ${n.body}`));
console.log("in-app cards:", toastCards, "(incl. first-load hint)");
console.log("opened sessions:", JSON.stringify(opened));
console.log("diag:", JSON.stringify(diag.stats));
console.log("goal diag:", JSON.stringify(window.dshNotify.diag().goals));
console.log(failures === 0 ? "DSH-NOTIFY TESTS PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
