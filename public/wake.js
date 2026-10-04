// Wake-word understanding for JARVIS. Pure text in, decision out (the transcript comes from speech recognition).
//
//   JarvisWake.parse("Hey Jarvis, what's the weather?")
//     -> { woke: true, command: "what's the weather?", bye: false, filler: false }
//
// woke    — the name was used to ADDRESS him: at the start (optionally after "hey"/"ok"), or at the very end.
//           A name in the middle of a sentence ("I told Travis…") is not a call.
// command — the sentence with the name and any greeting removed.
// bye     — "thanks", "that's all", "never mind"… (the caller can stand down without asking the model).
// filler  — "um", "yeah", "okay"… (ignored while he is already listening).
(function () {
  var NAME = "jarvis";
  // Common mis-hearings. Anything else within one edit of the name also counts (see isName).
  var KNOWN = { jarvis: 1, jervis: 1, jarvus: 1, jarvas: 1, jarves: 1, garvis: 1, jarvice: 1, jarviss: 1, jarvous: 1, charvis: 1, jarvist: 1 };
  var GREET = { hey: 1, hi: 1, hello: 1, okay: 1, ok: 1, yo: 1, oi: 1 };
  var NOT_A_CALL_AFTER = { is: 1, was: 1, says: 1, said: 1, told: 1, to: 1, has: 1, had: 1, did: 1, does: 1, thinks: 1, wants: 1 };
  var BYE = [
    /^(?:thanks|thank you|cheers|many thanks|much appreciated)(?:,? (?:very|so) much)?[.!]?$/,
    /^(?:that'?s all|that is all|that will be all|that'?ll be all|that'?s everything|goodbye|bye|good ?night|never ?mind|stop listening|go to sleep|stand down|dismissed|carry on)(?: for now)?[.!]?$/,
  ];
  var FILLER = /^(?:uh+|um+|hm+|mm+|er+|ah+|oh+|okay|ok|yeah|yep|yes|no|nope|right|so|well)[.!?,]*$/;

  function letters(w) { return String(w).toLowerCase().replace(/[^a-z]/g, ""); }

  function lev(a, b) {
    var m = a.length, n = b.length, d = [], i, j;
    for (i = 0; i <= m; i++) { d[i] = [i]; }
    for (j = 1; j <= n; j++) { d[0][j] = j; }
    for (i = 1; i <= m; i++) for (j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[m][n];
  }
  function isName(word) {
    var w = letters(word);
    if (!w) return false;
    if (KNOWN[w]) return true;
    return w.length >= 5 && w.length <= 8 && lev(w, NAME) <= 1;
  }

  function parse(text) {
    var raw = String(text || "").trim();
    var out = { woke: false, command: raw, bye: false, filler: false };
    if (!raw) return out;
    var ws = raw.split(/\s+/);

    // find the name: a single word, "jar vis", or spelled-out "j.a.r.v.i.s."
    var at = -1, span = 1, i;
    for (i = 0; i < ws.length && at < 0; i++) {
      var one = ws[i];
      if (isName(one)) { at = i; span = 1; }
      else if (/^j\.?a\.?r\.?v\.?i\.?s\.?[,.!?]*$/i.test(one) && /\./.test(one)) { at = i; span = 1; }
      else if (i + 1 < ws.length && letters(one) === "jar" && /^vis[,.!?]*$/i.test(ws[i + 1])) { at = i; span = 2; }
    }

    if (at >= 0) {
      var before = ws.slice(0, at), after = ws.slice(at + span);
      var greetingOnly = before.every(function (b) { return GREET[letters(b)]; });
      var atStart = before.length === 0 || (before.length <= 2 && greetingOnly);
      var atEnd = after.length <= 1 && before.length >= 1;                 // "…weather, Jarvis" / "…weather Jarvis please"
      var nameWord = ws[at];
      var calledOut = /[,:;!?]$/.test(nameWord) || after.length === 0;     // "Jarvis, …" is plainly an address
      var denied = after.length && NOT_A_CALL_AFTER[letters(after[0])] && !calledOut;   // "Jarvis is great" is about him, not to him
      if ((atStart && !denied) || atEnd) {
        out.woke = true;
        var rest = before.filter(function (b) { return !(atStart && greetingOnly && GREET[letters(b)]); }).concat(after);
        out.command = rest.join(" ").replace(/^[\s,.:;!?-]+|[\s,.:;-]+$/g, "");
      }
    }

    var bare = out.command.toLowerCase().replace(/\s+/g, " ").trim();
    out.bye = BYE.some(function (re) { return re.test(bare); });
    out.filler = FILLER.test(bare);
    return out;
  }

  var api = { parse: parse, isName: isName };
  (typeof window !== "undefined" ? window : globalThis).JarvisWake = api;
})();
