/**
 * The live-js worker, shipped as a string: the runner page
 * (./liveJsRunner, inside a sandboxed iframe) starts it from a blob: URL,
 * and unit tests pin its throw/rejection containment and lockdown
 * properties textually (jsdom can't run a real Worker).
 */
export const WORKER_SOURCE = `
// A blob: worker inherits the page CSP, including
// require-trusted-types-for 'script'. Running the fence body through
// new Function() is this worker's whole purpose (it is isolated from the
// page and has no DOM), so give it a default policy that accepts scripts.
if (self.trustedTypes && !self.trustedTypes.defaultPolicy) {
  try {
    self.trustedTypes.createPolicy("default", {
      createScript: function(s) { return s; },
    });
  } catch (e) {}
}

// Lock the run down before any user code exists. The real boundary is the
// runner iframe (opaque origin, CSP connect-src 'none' — see
// livejs-runner.html); this removes the network and storage APIs from the
// worker as a second layer, also in dev where no CSP header is served.
(function() {
  var names = ["fetch", "XMLHttpRequest", "WebSocket", "WebSocketStream", "EventSource", "WebTransport",
    "importScripts", "indexedDB", "caches", "BroadcastChannel", "Worker", "SharedWorker", "FontFace",
    // ShadowRealm#evaluate compiles a string and #importValue is an import().
    "ShadowRealm"];
  var targets = [];
  for (var o = self; o; o = Object.getPrototypeOf(o)) targets.push(o);
  names.forEach(function(name) {
    targets.forEach(function(t) {
      try { Object.defineProperty(t, name, { value: undefined, writable: false, configurable: false }); } catch (e) {}
    });
  });
})();

// Everything the runtime needs lives inside this IIFE, so none of it sits
// in the global scope that user code shares: "live-js shared" blocks keep
// their top-level bindings as globals, and a user's "const emit = ..." must
// neither collide with nor clobber the runtime.
(function() {
  var post = self.postMessage.bind(self);
  var closeWorker = self.close.bind(self);
  var setT = setTimeout;
  var setI = typeof setInterval === "function" ? setInterval : null;
  var clearT = clearTimeout;
  var MakeFunction = Function;

  // No import(), not even one built from a string. WebKit does not apply
  // the runner's script-src to a dynamic import() from a worker (blob:,
  // data: or module), and an opaque-origin frame cannot start a worker from
  // a URL that would carry its own CSP (SecurityError in every engine), so
  // the CSP cannot close this one (docs/security/headers.md, open item 11).
  // Instead: (1) a run whose source contains the word "import" anywhere is
  // refused before it is compiled. Conservative on purpose — strings and
  // comments count too — because then no lexer can be fooled (an escaped
  // keyword like \\u0069mport is a SyntaxError). (2) Every way to compile a
  // string after that check is removed: eval, the Function / AsyncFunction /
  // GeneratorFunction / AsyncGeneratorFunction constructors (also through
  // .constructor) and string handlers of setTimeout / setInterval.
  // Only ASCII identifier characters count as "part of a longer name":
  // a non-ASCII one may be whitespace (U+00A0, U+2028, …) next to a real
  // import. Treating a name like éimport as a match is the safe mistake.
  // Built from operators and primitive-string indexing only — no RegExp,
  // String or other prototype method — because in a "shared" scope an
  // earlier run can replace any built-in method (RegExp.prototype.test = …)
  // before the next run is checked.
  // Indexes stay inside the string: s[-1] or s[s.length] would be looked
  // up on String.prototype, which user code can fill in.
  var isNamePart = function(c) {
    return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_" || c === "$";
  };
  var hasImportWord = function(s) {
    var n = s.length;
    for (var i = 0; i + 6 <= n; i++) {
      if (s[i] === "i" && s[i + 1] === "m" && s[i + 2] === "p" && s[i + 3] === "o" && s[i + 4] === "r" && s[i + 5] === "t" &&
          !(i > 0 && isNamePart(s[i - 1])) && !(i + 6 < n && isNamePart(s[i + 6]))) return true;
    }
    return false;
  };
  (function() {
    var refuse = function() { throw new TypeError("live-js does not compile strings (eval, Function and string timers are off)"); };
    // Keeps \`x instanceof Function\` and Function.prototype.call working.
    refuse.prototype = MakeFunction.prototype;
    var lock = function(t, name, value) {
      try { Object.defineProperty(t, name, { value: value, writable: false, configurable: false }); } catch (e) {}
    };
    var protos = [
      MakeFunction.prototype,
      Object.getPrototypeOf(MakeFunction("return async function() {}")()),
      Object.getPrototypeOf(MakeFunction("return function*() {}")()),
      Object.getPrototypeOf(MakeFunction("return async function*() {}")()),
    ];
    protos.forEach(function(p) { if (p) lock(p, "constructor", refuse); });
    // The native timer is bound now, before any user code, and then only
    // called directly — never through .apply/.call/spread, which user code
    // can replace and would hand it the native timer as \`this\`. All it
    // ever receives is the user's function or our own wrapper around it;
    // extra arguments are passed by that wrapper (user code calling user
    // code, so a replaced apply/slice there only affects the user's own run).
    var timer = function(real) {
      var callReal = real.bind(self);
      return function(handler) {
        if (typeof handler !== "function") refuse();
        var a = arguments;
        if (a.length <= 2) return callReal(handler, a[1]);
        var withArgs = function() { return handler.apply(self, Array.prototype.slice.call(a, 2)); };
        return callReal(withArgs, a[1]);
      };
    };
    var safeTimeout = timer(setT);
    var safeInterval = setI ? timer(setI) : undefined;
    // Not on the last link (Object.prototype): a non-writable inherited name
    // would make \`obj.setTimeout = …\` on plain objects fail silently, and
    // the real functions never live there.
    for (var o = self; o && Object.getPrototypeOf(o) !== null; o = Object.getPrototypeOf(o)) {
      lock(o, "eval", refuse);
      lock(o, "Function", refuse);
      lock(o, "setTimeout", safeTimeout);
      lock(o, "setInterval", safeInterval);
    }
  })();

  var toParts = function(args) {
    var list = Array.prototype.slice.call(args);
    return list.map(function(a) {
      if (a === undefined) return "undefined";
      if (a === null) return "null";
      if (typeof a === "string") return a;
      if (typeof a === "function") return "[Function " + (a.name || "anonymous") + "]";
      try {
        return JSON.stringify(a, null, 2);
      } catch (e) {
        return String(a);
      }
    });
  };

  var emit = function(level, args, runId) {
    try {
      post({
        type: "log",
        runId: runId,
        level: level,
        parts: toParts(args),
      });
    } catch (e) {}
  };

  self.addEventListener("message", function(event) {
    var payload = event.data || {};
    if (payload.type !== "run") return;

    var runId = payload.runId || 0;
    // A primitive string or nothing: String() and toString() are user-replaceable
    // in a shared scope, and an object could stringify differently for the
    // check and for the compile.
    var source = typeof payload.source === "string" ? payload.source : "";
    var timeoutMs = Number(payload.timeoutMs || 0);
    var timer = timeoutMs > 0 ? setT(function() {
      emit("error", ["Execution timed out"], runId);
      post({ type: "done", runId: runId, timedOut: true });
      closeWorker();
    }, timeoutMs) : null;

    self.onerror = function(msg, filename, lineno, colno) {
      emit("error", [String(msg) + " (" + (filename || "inline") + ":" + (lineno || 0) + ":" + (colno || 0) + ")"], runId);
      // Returning true suppresses the default action so the error does NOT
      // bubble up to the parent (which would surface as a pageerror).
      return true;
    };
    self.onunhandledrejection = function(e) {
      var reason = e && e.reason ? e.reason : e;
      emit("error", ["Unhandled rejection: " + (reason && reason.message ? reason.message : String(reason))], runId);
      // Same as onerror — prevent default to keep the rejection from
      // escaping the worker and surfacing as a pageerror in the parent.
      if (e && typeof e.preventDefault === "function") e.preventDefault();
    };

    var finish = function() {
      if (timer) clearT(timer);
      post({ type: "done", runId: runId });
    };

    // Emitted as a plain message, not thrown: Firefox's and WebKit's
    // err.stack has only the frames, so the reason would not be shown.
    if (hasImportWord(source)) {
      emit("error", ["live-js has no import(): code that contains the word \\"import\\" does not run (the sandbox has no network)"], runId);
      finish();
      return;
    }

    try {
      var safeConsole = {
        log: function() { emit("log", arguments, runId); },
        info: function() { emit("info", arguments, runId); },
        warn: function() { emit("warn", arguments, runId); },
        error: function() { emit("error", arguments, runId); },
      };
      // Note the leading "return" — without it, the async IIFE's promise is
      // discarded and any rejection (e.g. user code throwing) becomes an
      // unhandled rejection in the worker, which propagates as a worker
      // error and surfaces as pageerror in the parent. With "return", the
      // outer .then(_, errHandler) catches it cleanly.
      var runner = new MakeFunction(
        "console",
        "return (async function() {\\n" + source + "\\n})();"
      );
      Promise.resolve().then(function() { return runner(safeConsole); }).then(
        finish,
        function(err) {
          emit("error", [err && err.stack ? err.stack : String(err)], runId);
          finish();
        },
      );
    } catch (err) {
      emit("error", [err && err.stack ? err.stack : String(err)], runId);
      finish();
    }
  });
})();
`;
