// Host-half test for dsh-notify: the loopback activation endpoint, the toast
// XML contract, and the completion path (dry-run, no real toast).
//
//   node test/host.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.DSH_NOTIFY_DRY = "1";

const { apply, diagnose, buildToastXml } = await import("../lib/index.js");

// ── fake host root ─────────────────────────────────────────────────────────
const listeners = new Map();
const titles = new Map([["session-abc12345", "测试通知插件是否生效"]]);
// Goal views the fake `ctx.goals` serves, keyed by session id.
const goalViews = new Map();
const agentIds = new Set();
const root = {
  on(name, handler) {
    if (!listeners.has(name)) listeners.set(name, []);
    listeners.get(name).push(handler);
    return () => {};
  },
  get(name) {
    if (name === "sessions") {
      return {
        get: (id) => (titles.has(id) ? { id, title: titles.get(id) } : undefined),
      };
    }
    if (name === "sessionTitle") {
      return {
        get: (session) => ({ title: titles.get(session?.id) || "" }),
      };
    }
    if (name === "agents") {
      return { get: (id) => (agentIds.has(id) ? { id } : undefined) };
    }
    if (name === "goals") {
      return { get: (agent) => goalViews.get(agent?.id) };
    }
    return undefined;
  },
};
const ctx = {
  root,
  effect(fn) {
    ctx.__dispose = fn();
  },
};

apply(ctx);

let failures = 0;
function check(label, ok, detail) {
  if (ok) return;
  failures += 1;
  console.log("FAIL:", label, detail ?? "");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 1. the endpoint comes up ────────────────────────────────────────────────
let port = 0;
for (let i = 0; i < 60 && !port; i += 1) {
  port = diagnose().port;
  if (!port) await sleep(50);
}
check("loopback endpoint starts", port > 0, JSON.stringify(diagnose()));

const base = `http://127.0.0.1:${port}`;
const health = await (await fetch(`${base}/health`)).json();
check("health identifies the plugin", health.plugin === "dsh-notify" && health.ok === true, JSON.stringify(health));

// ── 2. the protocol handler is registered ──────────────────────────────────
check("dshnotify: protocol registered", diagnose().protocol === "registered", JSON.stringify(diagnose().protocolDetails || diagnose().protocol));

// `URL Protocol` is what makes the shell treat the key as a URL protocol; the
// toast click is silently ignored without it.
const probe = spawnSync("reg.exe", ["query", "HKCU\\Software\\Classes\\dshnotify", "/v", "URL Protocol"], {
  encoding: "utf8",
  windowsHide: true,
});
check("URL Protocol marker present", probe.status === 0, `${probe.stdout}${probe.stderr}`);
const command = spawnSync("reg.exe", ["query", "HKCU\\Software\\Classes\\dshnotify\\shell\\open\\command", "/ve"], {
  encoding: "utf8",
  windowsHide: true,
});
check("activation handler points at activate.ps1", String(command.stdout).includes("activate.ps1"), command.stdout);

// ── 3. activation queue ────────────────────────────────────────────────────
const post = async (query) => {
  const response = await fetch(`${base}/activate?${query}`, { method: "POST" });
  return { status: response.status, body: await response.json() };
};
const first = await post("sid=session-abc12345");
check("activate accepts a session id", first.status === 200 && first.body.ok === true, JSON.stringify(first));
const bad = await post("sid=not-a-session");
check("activate rejects a malformed id", bad.status === 400 && bad.body.ok === false, JSON.stringify(bad));

const pending = await (await fetch(`${base}/pending?after=0`)).json();
check("pending returns the activation", pending.items.length === 1 && pending.items[0].sid === "session-abc12345", JSON.stringify(pending));
const drained = await (await fetch(`${base}/pending?after=${pending.nextId - 1}`)).json();
check("pending is incremental", drained.items.length === 0, JSON.stringify(drained));

// Re-activating the same session moves it to the head instead of duplicating.
await post("sid=session-abc12345");
const again = await (await fetch(`${base}/pending?after=0`)).json();
check("re-activation does not duplicate", again.items.length === 1, JSON.stringify(again));

// ── 4. toast XML carries the protocol activation ───────────────────────────
const xml = buildToastXml({ title: "测试通知插件是否生效", body: "任务已完成 · 点击回到这个会话", sessionId: "session-abc12345", silent: true });
check("toast uses protocol activation", /activationType="protocol"/.test(xml), xml);
check("toast launch carries the session", /launch="dshnotify:activate\?sid=session-abc12345"/.test(xml), xml);
check("toast has a jump button", /content="回到会话"/.test(xml), xml);
check("toast escapes XML", !/<title>/.test(buildToastXml({ title: "<title>", body: "&", sessionId: "session-abc12345" })), xml);

// ── 5. completion toast takes the session title (dry-run) ──────────────────
const status = listeners.get("api-session/status")[0];
status("session-abc12345", true);
status("session-abc12345", false);
const toast = diagnose().lastToast;
check("completion toast uses the session title", toast?.title === "测试通知插件是否生效", JSON.stringify(toast));
check("completion toast says how to get back", String(toast?.body || "").includes("点击回到这个会话"), JSON.stringify(toast));
check("completion toast links the session", toast?.sessionId === "session-abc12345", JSON.stringify(toast));

// Manual verification endpoint (/toast) raises a toast on demand.
const manual = await (await fetch(`${base}/toast?sid=session-abc12345&force=1`)).json();
check("manual toast endpoint responds", manual.ok === true, JSON.stringify(manual));
check("manual toast keeps the session link", diagnose().lastToast?.sessionId === "session-abc12345", JSON.stringify(diagnose().lastToast));

// Unknown sessions still produce a usable toast instead of an empty body.
const status2 = listeners.get("api-session/status")[0];
status2("session-zzzzzzzz", true);
status2("session-zzzzzzzz", false);
check("unknown title falls back to the short id", String(diagnose().lastToast?.body || "").includes("zzzzzzzz"), JSON.stringify(diagnose().lastToast));

// Duplicate running=false must not notify twice.
const before = diagnose().lastToast?.title;
status2("session-zzzzzzzz", false);
check("duplicate completion is ignored", diagnose().lastToast?.title === before, JSON.stringify(diagnose().lastToast));

// ── 5b. `/goal` runs notify once, not per continuation round ───────────────
const goalSession = "session-goal9999";
const goalStatus = listeners.get("api-session/status")[0];
goalViews.set(goalSession, { phase: "active", activation: "armed", objective: "修好搜索", roundsStarted: 2 });
agentIds.add(goalSession);

const goalProbe = await (await fetch(`${base}/goal?sid=${goalSession}`)).json();
check("/goal reports the live goal", goalProbe.hasGoal === true && goalProbe.phase === "active", JSON.stringify(goalProbe));
check("/goal marks a running round intermediate", goalProbe.intermediate === true, JSON.stringify(goalProbe));

const beforeGoalRound = diagnose().lastToast?.at || 0;
goalStatus(goalSession, true);
goalStatus(goalSession, false);
check("goal round raises no toast", (diagnose().lastToast?.at || 0) === beforeGoalRound, JSON.stringify(diagnose().lastToast));
check("goal round is recorded as suppressed", diagnose().suppressed?.sid === goalSession && diagnose().suppressedCount === 1, JSON.stringify(diagnose().suppressed));

// The round that settles the goal is the one that notifies.
goalViews.set(goalSession, { phase: "complete", activation: "armed", objective: "修好搜索", roundsStarted: 3 });
const settledProbe = await (await fetch(`${base}/goal?sid=${goalSession}`)).json();
check("/goal stops marking a settled goal intermediate", settledProbe.intermediate === false && settledProbe.phase === "complete", JSON.stringify(settledProbe));
goalStatus(goalSession, true);
goalStatus(goalSession, false);
check("settled goal notifies", diagnose().lastToast?.sessionId === goalSession, JSON.stringify(diagnose().lastToast));
check("settled goal says 目标已完成", String(diagnose().lastToast?.body || "").includes("目标已完成"), JSON.stringify(diagnose().lastToast));

// A blocked goal is reported as such, not as a normal completion.
goalViews.set(goalSession, { phase: "blocked", activation: "armed", objective: "修好搜索", roundsStarted: 3, blockedReason: { code: "context", message: "上下文已满" } });
goalStatus(goalSession, true);
goalStatus(goalSession, false);
check("blocked goal says 目标受阻", String(diagnose().lastToast?.body || "").includes("目标受阻"), JSON.stringify(diagnose().lastToast));

// No goal service (or no goal) keeps the plain completion behaviour.
goalViews.clear();
const plain = await (await fetch(`${base}/goal?sid=${goalSession}`)).json();
check("/goal reports no goal after a clear", plain.hasGoal === false && plain.intermediate === false, JSON.stringify(plain));

// ── 6. endpoint file + teardown ────────────────────────────────────────────
const endpointFile = join(tmpdir(), "dsh-notify-host", "endpoint.json");
check("endpoint file published", existsSync(endpointFile), endpointFile);
if (existsSync(endpointFile)) {
  const published = JSON.parse(readFileSync(endpointFile, "utf8"));
  check("endpoint file names the live port", published.port === port, JSON.stringify(published));
}

if (typeof ctx.__dispose === "function") ctx.__dispose();
await sleep(80);
let closed = false;
try {
  await fetch(`${base}/health`);
} catch {
  closed = true;
}
check("dispose closes the endpoint", closed, "endpoint still answering after dispose");

console.log(diagnose());
console.log(failures === 0 ? "DSH-NOTIFY HOST TESTS PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
