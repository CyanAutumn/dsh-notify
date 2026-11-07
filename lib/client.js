window.__ModuleLoader__.load({
  id: "dsh-notify",
  factory(require) {
    const STYLE_ID = "dsh-notify-style";
    const CONFIG_KEY = "dsh-notify:config";
    const DIAG_KEY = "dsh-notify:diagnosed";
    const DEFAULTS = {
      enabled: true,
      onComplete: true,
      onQuestion: true,
      onError: true,
      sound: false,
      onlyWhenUnfocused: true,
      showToast: true,
      toastMs: 15000,
      // Windows toasts are raised by the host half (explicit AUMID); the
      // renderer only decides about the in-app card and the session jump.
      hostOs: true,
    };

    function readConfig() {
      try {
        const raw = localStorage.getItem(CONFIG_KEY);
        return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
      } catch {
        return { ...DEFAULTS };
      }
    }

    function installStyle() {
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = `
.dshn-stack{position:fixed;right:18px;bottom:18px;z-index:2147483000;display:flex;flex-direction:column;gap:10px;max-width:360px;pointer-events:none}
.dshn-toast{pointer-events:auto;background:var(--dsw-alias-bg-layer-1,#fff);border:0.5px solid var(--dsw-alias-border-l2,#e5e7eb);border-left:3px solid var(--dsw-alias-brand-primary,#4f5bf6);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.18);padding:11px 13px;font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--dsw-alias-label-primary,#111827);cursor:pointer;animation:dshn-in .18s ease-out}
.dshn-toast[data-kind="error"]{border-left-color:var(--dsw-alias-state-error-primary,#dc2626)}
.dshn-toast[data-kind="question"]{border-left-color:var(--dsw-alias-state-warning-primary,#d97706)}
.dshn-title{font-weight:600;display:flex;align-items:center;gap:6px}
.dshn-body{margin-top:3px;color:var(--dsw-alias-label-secondary,#4b5563);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}
.dshn-close{margin-left:auto;border:0;background:none;color:var(--dsw-alias-label-tertiary,#8b93a1);font-size:14px;cursor:pointer;line-height:1;padding:0 2px}
@keyframes dshn-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
`;
      document.head.append(style);
    }

    function osPermission() {
      try {
        if (typeof Notification === "undefined") return "unsupported";
        return Notification.permission;
      } catch {
        return "unsupported";
      }
    }

    function requestOsPermission() {
      try {
        if (osPermission() === "default") {
          const result = Notification.requestPermission();
          if (result && typeof result.catch === "function") result.catch(() => {});
        }
      } catch {
        /* the toast fallback still works */
      }
    }

    function toast(title, body, kind, ms, onActivate) {
      const config = readConfig();
      if (!config.showToast) return;
      installStyle();
      let stack = document.querySelector(".dshn-stack");
      if (!stack) {
        stack = document.createElement("div");
        stack.className = "dshn-stack";
        document.body.append(stack);
      }
      const card = document.createElement("div");
      card.className = "dshn-toast";
      card.dataset.kind = kind || "info";
      card.setAttribute("role", "status");

      const head = document.createElement("div");
      head.className = "dshn-title";
      const label = document.createElement("span");
      label.textContent = title;
      const close = document.createElement("button");
      close.className = "dshn-close";
      close.type = "button";
      close.textContent = "×";
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        card.remove();
      });
      head.append(label, close);

      const text = document.createElement("div");
      text.className = "dshn-body";
      text.textContent = body || "";

      card.append(head, text);
      card.addEventListener("click", () => {
        try {
          window.focus();
        } catch {
          /* nothing to focus */
        }
        card.remove();
        try {
          if (typeof onActivate === "function") onActivate();
        } catch {
          /* navigation is best-effort */
        }
      });
      stack.append(card);
      const keepMs = Number(ms) || Number(config.toastMs) || 8000;
      const timer = window.setTimeout(() => card.remove(), keepMs);
      card.addEventListener("click", () => window.clearTimeout(timer));
      return card;
    }

    /**
     * Deliver one notification over two independent channels:
     *  - OS toast: only while the window is unfocused (unless `force`, or
     *    `onlyWhenUnfocused` is off), so Windows never pops a balloon over the
     *    app you are already looking at;
     *  - in-app card: whenever `showToast` is on, focused or not.
     */
    function deliver(title, body, kind, tag, options) {
      const config = readConfig();
      if (!config.enabled) return { os: false, toast: false };
      const force = Boolean(options && options.force);
      const sessionId = options && options.sessionId;
      // Clicking either channel focuses the window and jumps to the session
      // that raised the notification.
      const activate = () => {
        try {
          window.focus();
        } catch {
          /* ignore */
        }
        if (!sessionId) return;
        const jump = openSession(sessionId);
        lastJump = { at: Date.now(), sessionId, ...jump };
        if (!jump.ok) toast("跳转会话失败", `${jump.reason}（会话 ${shortId(sessionId)}）`, "error", 20000);
        else console.info("[dsh-notify] jumped to session", sessionId);
      };
      const willOs = !config.hostOs && (Boolean(force) || !config.onlyWhenUnfocused || !isFocused());
      const allowOs = willOs;
      let os = false;
      if (allowOs && osPermission() === "granted") {
        try {
          const notification = new Notification(title, { body, tag, silent: !config.sound });
          notification.onclick = () => {
            activate();
            notification.close();
          };
          os = true;
        } catch {
          /* fall through to the toast */
        }
      }
      // Questions, approvals and turn completions stay longer than plain hints.
      const keepMs = (options && options.ms) || (kind === "question" || kind === "complete" ? 30000 : undefined);
      const card = config.showToast ? toast(title, body, kind, keepMs, activate) : undefined;
      return { os, toast: Boolean(card) };
    }

    // Window focus tracking. `document.hasFocus()` reports false while a child
    // view (sidebar webview / embedded panel) owns the DOM focus, which would
    // wrongly read as "unfocused" and pop an OS toast over the window the user
    // is looking at. Track real window focus/blur events instead and fall back
    // to hasFocus() only until the first event arrives.
    let windowBlurred = null;

    function isFocused() {
      try {
        if (document.visibilityState !== "visible") return false;
        if (windowBlurred !== null) return !windowBlurred;
        return typeof document.hasFocus === "function" ? document.hasFocus() : true;
      } catch {
        return false;
      }
    }

    function trackWindowFocus() {
      try {
        if (typeof window.addEventListener !== "function") return;
        window.addEventListener("blur", () => {
          windowBlurred = true;
        });
        window.addEventListener("focus", () => {
          windowBlurred = false;
        });
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "hidden") windowBlurred = true;
        });
      } catch {
        /* keep the hasFocus() fallback */
      }
    }

    function sessionTitle(ctx, sessionId) {
      try {
        const sessions = ctx.get ? ctx.get("sessions") : undefined;
        const snapshot = sessions && sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot() : undefined;
        const row = snapshot && snapshot.byId ? snapshot.byId[sessionId] : undefined;
        if (row && (row.title || row.name)) return String(row.title || row.name);
        const live = sessions && sessions.sessionOf ? sessions.sessionOf(sessionId) : undefined;
        const snapshot2 = live && live.snapshot && live.snapshot.value;
        if (snapshot2 && (snapshot2.title || snapshot2.name)) return String(snapshot2.title || snapshot2.name);
      } catch {
        /* title is best-effort */
      }
      return "";
    }

    function shortId(sessionId) {
      const id = String(sessionId || "");
      return id.replace(/^session-/, "").slice(0, 8);
    }

    // Set once `apply` runs so click handlers can reach client services.
    let pluginCtx = null;
    // Last jump attempt, surfaced by dshNotify.diag().
    let lastJump = null;

    // Rendering half of the toast → session jump. The Windows toast carries a
    // `dshnotify:` protocol activation; the host half serves it on loopback and
    // we pick the session id up here, because only the renderer can call
    // uiWorkspace.openSession().
    const PORTS = [48235, 48236, 48237, 48238];
    const POLL_MS = 1200;
    const poll = { port: 0, after: 0, timer: null, lastAt: 0, lastError: "", activations: 0 };

    function endpoint(path) {
      return `http://127.0.0.1:${poll.port}${path}`;
    }

    async function fetchJson(url, timeoutMs) {
      if (typeof fetch !== "function") return null;
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      const timer = controller ? window.setTimeout(() => controller.abort(), timeoutMs || 900) : null;
      try {
        const response = await fetch(url, controller ? { signal: controller.signal } : undefined);
        if (!response || !response.ok) return null;
        return await response.json();
      } catch (error) {
        poll.lastError = String((error && error.message) || error);
        return null;
      } finally {
        if (timer) window.clearTimeout(timer);
      }
    }

    /** Find the host half's loopback endpoint (first port that answers). */
    async function discover() {
      for (const port of PORTS) {
        poll.port = port;
        const health = await fetchJson(endpoint("/health"), 600);
        if (health && health.plugin === "dsh-notify") return port;
      }
      poll.port = 0;
      return 0;
    }

    /** Switch to the session a clicked toast was raised for. */
    function activateFromToast(sessionId) {
      if (!sessionId) return { ok: false, reason: "no session id" };
      const jump = openSession(sessionId);
      lastJump = { at: Date.now(), sessionId, ...jump };
      poll.activations += 1;
      try {
        window.focus();
      } catch {
        /* ignore */
      }
      if (!jump.ok) toast("跳转会话失败", `${jump.reason}（会话 ${shortId(sessionId)}）`, "error", 20000);
      return jump;
    }

    async function pollOnce() {
      if (!poll.port && !(await discover())) return;
      const payload = await fetchJson(endpoint(`/pending?after=${poll.after}`), 900);
      if (!payload) {
        // The host restarted on another port (or is gone): re-discover next time.
        if (!(await discover())) return;
        return;
      }
      poll.lastAt = Date.now();
      for (const item of payload.items || []) {
        if (item && item.id > poll.after) poll.after = item.id;
        if (item && item.sid) activateFromToast(item.sid);
      }
    }

    function startPolling() {
      if (poll.timer || typeof window.setInterval !== "function") return;
      poll.timer = window.setInterval(() => {
        pollOnce();
      }, POLL_MS);
      // A click raises the window; the open/focus event is the moment to look.
      try {
        window.addEventListener("focus", () => {
          pollOnce();
        });
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") pollOnce();
        });
      } catch {
        /* keep the interval only */
      }
      pollOnce();
    }

    /**
     * Ask the host half whether this session is still inside a `/goal` run.
     * A goal is one objective split into continuation rounds; each round ends
     * with a turn completion, and only the round that settles the goal should
     * notify. The host owns that state (`ctx.goals`), the renderer can't read
     * it, so this is one loopback call on completion — not on every tick.
     */
    async function goalStateFor(sessionId) {
      if (!sessionId) return null;
      if (!poll.port && !(await discover())) return null;
      const query = `/goal?sid=${encodeURIComponent(String(sessionId))}`;
      let goal = await fetchJson(endpoint(query), 900);
      if (!goal) {
        // Stale port after a host restart: re-discover and try once more.
        if (!(await discover())) return null;
        goal = await fetchJson(endpoint(query), 900);
      }
      return goal && goal.ok ? goal : null;
    }

    function workspaceService() {
      const ctx = pluginCtx;
      if (!ctx) return undefined;
      // Cordis throws when reading a service property the fiber did not inject,
      // so every strategy gets its own try/catch — a throw in one must not hide
      // the others. `root`/`reflect` read outside the fiber chain and reach
      // services provided by sibling plugins.
      const strategies = [
        () => ctx.uiWorkspace,
        () => (typeof ctx.get === "function" ? ctx.get("uiWorkspace", false) : undefined),
        () => (ctx.root ? ctx.root.uiWorkspace : undefined),
        () => (ctx.reflect && typeof ctx.reflect.get === "function" ? ctx.reflect.get("uiWorkspace", false) : undefined),
      ];
      for (const read of strategies) {
        try {
          const value = read();
          if (value && typeof value.openSession === "function") return value;
        } catch {
          /* try the next strategy */
        }
      }
      return undefined;
    }

    function canJump() {
      const workspace = workspaceService();
      return Boolean(workspace && typeof workspace.openSession === "function");
    }

    /**
     * Switch the main view to `sessionId` through the workspace UI service
     * (`ctx.uiWorkspace.openSession`), the same entry point DSH's own session
     * links use.
     */
    function openSession(sessionId) {
      const workspace = workspaceService();
      if (!workspace) {
        console.warn("[dsh-notify] uiWorkspace service unavailable; cannot jump to the session");
        return { ok: false, reason: "uiWorkspace 服务不可用" };
      }
      if (typeof workspace.openSession !== "function") {
        console.warn("[dsh-notify] uiWorkspace.openSession missing");
        return { ok: false, reason: "uiWorkspace.openSession 方法缺失" };
      }
      try {
        workspace.openSession(sessionId);
        return { ok: true };
      } catch (error) {
        console.warn("[dsh-notify] jump to session failed", error);
        return { ok: false, reason: String((error && error.message) || error) };
      }
    }

    function apply(ctx) {
      installStyle();
      trackWindowFocus();
      pluginCtx = ctx;
      const config = readConfig();
      const remote = ctx.remote || (ctx.get ? ctx.get("remote") : undefined);
      const bridged = Boolean(remote && typeof remote.$on === "function");
      if (!bridged) {
        console.warn("[dsh-notify] remote service unavailable; notifications disabled");
      }

      const runningBySession = new Map();
      const seenQuestions = new Set();
      const disposers = [];
      const stats = {
        loadedAt: Date.now(),
        status: 0,
        completions: 0,
        error: 0,
        question: 0,
        approval: 0,
        notified: 0,
        osSent: 0,
        toastsShown: 0,
        lastStatus: null,
        goalSkipped: 0,
        lastGoal: null,
      };

      const emit = (title, body, kind, tag, options) => {
        const focused = isFocused();
        const result = deliver(title, body, kind, tag, options);
        if (result.os) stats.osSent += 1;
        if (result.toast) stats.toastsShown += 1;
        if (result.os || result.toast) stats.notified += 1;
        stats.lastDelivery = { at: Date.now(), focused, ...result, title };
        return result;
      };

      /**
       * Completion of one turn — but a `/goal` run closes one turn per round,
       * so ask the host whether the goal is still running before notifying.
       * Only the round that settles the goal (complete / blocked / paused /
       * disarmed) reaches the card.
       */
      const notifyCompletion = async (sessionId) => {
        const cfg = readConfig();
        if (!cfg.onComplete) return;
        const goal = await goalStateFor(sessionId);
        stats.lastGoal = goal
          ? { at: Date.now(), sessionId: String(sessionId || ""), phase: goal.phase, roundsStarted: goal.roundsStarted, intermediate: Boolean(goal.intermediate) }
          : null;
        if (goal && goal.intermediate) {
          stats.goalSkipped = (stats.goalSkipped || 0) + 1;
          return;
        }
        const title = sessionTitle(ctx, sessionId);
        const heading =
          goal && goal.phase === "complete" ? "目标已完成" : goal && goal.phase === "blocked" ? "目标受阻" : "任务已完成";
        emit(heading, title || `会话 ${shortId(sessionId)}`, "complete", `complete:${sessionId}`, { sessionId });
      };

      if (bridged) {
        // 1. Turn completion / failure comes from the session status bridge.
        disposers.push(
          remote.$on("api-session/status", (sessionId, running) => {
            stats.status += 1;
            stats.lastStatus = { sessionId: String(sessionId || ""), running: Boolean(running), at: Date.now() };
            const previous = runningBySession.get(sessionId);
            runningBySession.set(sessionId, Boolean(running));
            if (running) return;
            // A `running === false` event only happens on a true -> false
            // transition, so the completion is real even when this plugin missed
            // the `true` (it may have (re)loaded in the middle of a turn).
            // Repeated `false` events are still ignored.
            if (previous === false) return;
            stats.completions += 1;
            void notifyCompletion(sessionId).catch(() => {
              /* notifications must never break the bridge */
            });
          }),
        );

        disposers.push(
          remote.$on("api-session/error", (sessionId, message) => {
            stats.error += 1;
            const cfg = readConfig();
            if (!cfg.onError) return;
            emit("任务出错", String(message || "").slice(0, 300) || `会话 ${shortId(sessionId)}`, "error", `error:${sessionId}`, { sessionId });
          }),
        );

        // 2. A pending question / approval is a waterfall: pass through `next()`
        //    untouched so the normal UI still receives the request.
        disposers.push(
          remote.$on("user-questions/request", function (request, next) {
            try {
              stats.question += 1;
              const cfg = readConfig();
              const key = String(request?.callId || request?.id || request?.key || "question");
              if (cfg.onQuestion && !seenQuestions.has(key)) {
                seenQuestions.add(key);
                window.setTimeout(() => seenQuestions.delete(key), 5 * 60 * 1000);
                const title = sessionTitle(ctx, request?.sessionId);
                const count = Array.isArray(request?.questions) ? request.questions.length : 1;
                emit("需要你回答", `${title || `会话 ${shortId(request?.sessionId)}`}：${count} 个问题待处理`, "question", `question:${key}`, {
                  sessionId: request?.sessionId,
                });
              }
            } catch {
              /* never break the waterfall */
            }
            return typeof next === "function" ? next() : undefined;
          }),
        );

        disposers.push(
          remote.$on("approval/request", function (request, next) {
            try {
              stats.approval += 1;
              const cfg = readConfig();
              const key = String(request?.callId || request?.id || request?.key || "approval");
              if (cfg.onQuestion && !seenQuestions.has(key)) {
                seenQuestions.add(key);
                window.setTimeout(() => seenQuestions.delete(key), 5 * 60 * 1000);
                const tool = request?.toolName || request?.name || "工具";
                emit("需要授权", `是否允许执行 ${tool}`, "question", `approval:${key}`, { sessionId: request?.sessionId });
              }
            } catch {
              /* never break the waterfall */
            }
            return typeof next === "function" ? next() : undefined;
          }),
        );
      }

      if (typeof ctx.effect === "function") {
        ctx.effect(
          () => () => {
            for (const dispose of disposers) {
              try {
                if (typeof dispose === "function") dispose();
              } catch {
                /* ignore */
              }
            }
          },
          "dsh-notify: remote listeners",
        );
      }

      // Ask for the OS permission on the first user gesture (browsers require it).
      requestOsPermission();
      const onFirstGesture = () => {
        requestOsPermission();
        document.removeEventListener("pointerdown", onFirstGesture, true);
      };
      document.addEventListener("pointerdown", onFirstGesture, true);

      const runTest = (force) => {
        const cfg = readConfig();
        const focused = isFocused();
        const willOs = !cfg.hostOs && (Boolean(force) || !cfg.onlyWhenUnfocused || !focused);
        const body = [
          `事件：status ${stats.status} · 完成 ${stats.completions} · question ${stats.question} · error ${stats.error}`,
          `判定：${focused ? "前台" : "后台"}`,
          `权限：${osPermission()}`,
          `跳转：${canJump() ? "可用" : "uiWorkspace 缺失"}`,
          cfg.hostOs ? "系统通知：宿主侧（窗口失焦时弹）" : willOs ? "系统通知：发送" : "系统通知：抑制",
          "停留45秒",
        ]
          .filter(Boolean)
          .join(" · ");
        return emit("测试通知", body, "info", "test", { force: Boolean(force), ms: 45000 });
      };

      // Expose a tiny runtime switch for debugging: dshNotify.config({...})
      window.dshNotify = {
        config(patch) {
          const next = { ...readConfig(), ...(patch || {}) };
          try {
            localStorage.setItem(CONFIG_KEY, JSON.stringify(next));
          } catch {
            /* ignore */
          }
          return next;
        },
        get current() {
          return readConfig();
        },
        /** One test notification. `{ force: true }` forces both channels. */
        test(options) {
          return runTest(Boolean(options && options.force));
        },
        diag() {
          return {
            loaded: true,
            bridged,
            permission: osPermission(),
            focused: isFocused(),
            jump: canJump(),
            lastJump,
            config: readConfig(),
            stats,
            endpoint: { port: poll.port, after: poll.after, lastAt: poll.lastAt, lastError: poll.lastError, activations: poll.activations },
            goals: { skipped: stats.goalSkipped || 0, last: stats.lastGoal || null },
          };
        },
        /** Manual jump (DevTools): `dshNotify.open("session-…")`. */
        open(sessionId) {
          return activateFromToast(sessionId);
        },
        /** Diagnostics: ask the host half what it knows. */
        async endpoint() {
          if (!poll.port && !(await discover())) return null;
          return fetchJson(endpoint("/diag"), 900);
        },
        /** Goal state for a session (host-owned); `intermediate` means "still in a goal run". */
        goal(sessionId) {
          return goalStateFor(sessionId);
        },
      };

      console.info("[dsh-notify] ready", { bridged, permission: osPermission(), config });
      // Watch the loopback endpoint for toast activations (click → this session).
      startPolling();

      // First-load proof-of-life: one in-app toast per browser profile, so the
      // very first page after install shows that the bundle really loaded.
      try {
        if (localStorage.getItem(DIAG_KEY) !== "1") {
          localStorage.setItem(DIAG_KEY, "1");
          toast(
            bridged ? "通知插件已加载" : "通知插件已加载（事件桥接不可用）",
            bridged ? "在控制台执行 dshNotify.test() 可随时测试通知" : "未拿到 remote 服务，通知不会触发",
            bridged ? "info" : "error",
          );
        }
      } catch {
        /* ignore */
      }
    }

    return { inject: ["remote"], apply };
  },
});
