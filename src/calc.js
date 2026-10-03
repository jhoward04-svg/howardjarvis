// Exact arithmetic for Jarvis. A small recursive-descent parser — no eval, no Function.
// Numbers, + - * / % ^, parentheses, a handful of functions and the constants pi, e.

const FUNCS = {
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, floor: Math.floor, ceil: Math.ceil, sign: Math.sign,
  exp: Math.exp, ln: Math.log, log: Math.log10, log10: Math.log10, log2: Math.log2,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  round: (x, places = 0) => { const f = 10 ** places; return Math.round(x * f) / f; },
  min: Math.min, max: Math.max, pow: Math.pow,
};
const CONSTS = { pi: Math.PI, e: Math.E };
const MAX_LEN = 300, MAX_DEPTH = 40;

function tokenize(src) {
  const out = [];
  const re = /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(\*\*|[-+*/%^(),]))/y;
  let i = 0;
  while (i < src.length) {
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) { if (/^\s*$/.test(src.slice(i))) break; throw new Error(`unexpected character at position ${i + 1}`); }
    if (m[1] !== undefined) out.push({ t: "num", v: Number(m[1]) });
    else if (m[2] !== undefined) out.push({ t: "id", v: m[2].toLowerCase() });
    else out.push({ t: "op", v: m[3] === "**" ? "^" : m[3] });
    i = re.lastIndex;
  }
  return out;
}

export function evaluate(expression) {
  if (typeof expression !== "string" || !expression.trim()) throw new Error("empty expression");
  const src = expression.replace(/,(?=\d{3}(\D|$))/g, "").replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-");   // 1,234 → 1234
  if (src.length > MAX_LEN) throw new Error("expression too long");
  const toks = tokenize(src);
  let p = 0, depth = 0;
  const peek = () => toks[p], isOp = (v) => toks[p] && toks[p].t === "op" && toks[p].v === v;
  const enter = () => { if (++depth > MAX_DEPTH) throw new Error("expression too deeply nested"); };
  const leave = () => { depth--; };

  function expr() {
    enter(); let v = term();
    while (isOp("+") || isOp("-")) { const op = toks[p++].v; const r = term(); v = op === "+" ? v + r : v - r; }
    leave(); return v;
  }
  function term() {
    let v = unary();
    while (isOp("*") || isOp("/") || isOp("%")) {
      const op = toks[p++].v; const r = unary();
      if ((op === "/" || op === "%") && r === 0) throw new Error("division by zero");
      v = op === "*" ? v * r : op === "/" ? v / r : v % r;
    }
    return v;
  }
  // -2^2 is -(2^2); 2^3^2 is 2^(3^2); 2^-1 is allowed.
  function unary() {
    if (isOp("-")) { p++; enter(); const v = -unary(); leave(); return v; }
    if (isOp("+")) { p++; return unary(); }
    return power();
  }
  function power() {
    const base = primary();
    if (isOp("^")) { p++; enter(); const ex = unary(); leave(); return base ** ex; }
    return base;
  }
  function primary() {
    const t = peek();
    if (!t) throw new Error("unexpected end of expression");
    if (t.t === "num") { p++; return t.v; }
    if (t.t === "op" && t.v === "(") { p++; const v = expr(); if (!isOp(")")) throw new Error("missing )"); p++; return v; }
    if (t.t === "id") {
      p++;
      if (isOp("(")) {
        p++; const args = [];
        if (!isOp(")")) { args.push(expr()); while (isOp(",")) { p++; args.push(expr()); } }
        if (!isOp(")")) throw new Error("missing )"); p++;
        const fn = Object.hasOwn(FUNCS, t.v) ? FUNCS[t.v] : null;
        if (!fn) throw new Error(`unknown function ${t.v}`);
        return fn(...args);
      }
      if (Object.hasOwn(CONSTS, t.v)) return CONSTS[t.v];
      throw new Error(`unknown name ${t.v}`);
    }
    throw new Error(`unexpected ${t.v}`);
  }

  const result = expr();
  if (p < toks.length) throw new Error(`unexpected ${toks[p].v}`);
  if (!Number.isFinite(result)) throw new Error("result is not a finite number");
  return result;
}

export function formatNumber(n) {
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return String(n);
  return String(Number(n.toPrecision(12)));
}

export function calculate(expression) {
  try { const v = evaluate(expression); return { expression, result: formatNumber(v) }; }
  catch (err) { return { error: err.message }; }
}
