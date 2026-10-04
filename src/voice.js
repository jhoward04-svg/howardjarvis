import { recordUsage, budgetState } from "./usage.js";

// OpenAI voice: text-to-speech (replies) and speech-to-text (listening), proxied through the Worker so the
// API key never reaches the browser. Both have daily ceilings so a stuck tab can't run up a bill.
//
//   POST /api/voice/speak       {text, voice?}   -> audio/mpeg
//   POST /api/voice/transcribe  raw audio body   -> {text}

export const TTS_VOICES = ["marin", "cedar", "fable", "onyx", "ash", "ballad", "echo", "sage", "verse", "alloy", "coral", "nova", "shimmer"];
export const DEFAULT_VOICE = "onyx";

// Fixed server-side: the browser can pick a voice from the list, never the instructions.
export const BUTLER =
  "Speak as J.A.R.V.I.S., a dry, composed British butler: refined Received Pronunciation, calm and unhurried, " +
  "understated warmth with a faint hint of wit. Natural pacing; never theatrical.";

const MAX_TTS_CHARS = 1500;
const MAX_AUDIO_BYTES = 10_000_000;
const DAILY_TTS_CHARS = 60_000;       // about 40 minutes of speech
const DAILY_STT_CALLS = 500;

const base = (env) => (env.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/$/, "");
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export const audioExtension = (mime) => {
  const m = String(mime || "").toLowerCase();
  if (m.includes("webm")) return "webm";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "mp4";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("wav")) return "wav";
  return null;
};

// Duration of an upload, for cost estimates. Our own clips are 16-bit mono WAV, so it is exact; anything else is guessed.
export function audioSeconds(buf, mime) {
  if (String(mime).includes("wav") && buf.byteLength > 44) {
    const v = new DataView(buf); const rate = v.getUint32(24, true) || 16000, ch = v.getUint16(22, true) || 1, bits = v.getUint16(34, true) || 16;
    return Math.max(0, (buf.byteLength - 44) / (rate * ch * (bits / 8)));
  }
  return Math.min(30, buf.byteLength / 4000);        // ~32 kbit/s compressed audio
}

async function settingValue(env, key) {
  const r = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first();
  return r ? r.value : "";
}

export function cleanSpeechText(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, MAX_TTS_CHARS);
}

// Pure helper so the limit logic is testable: returns the new usage object, or null when over the ceiling.
export function spend(usage, day, field, amount, limit) {
  const u = usage && usage.day === day ? { ...usage } : { day, tts_chars: 0, stt_calls: 0 };
  if ((u[field] || 0) + amount > limit) return null;
  u[field] = (u[field] || 0) + amount;
  return u;
}

async function takeAllowance(env, field, amount, limit) {
  const day = new Date().toISOString().slice(0, 10);
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'voice_usage'").first();
  let usage = null;
  if (row) { try { usage = JSON.parse(row.value); } catch {} }
  const next = spend(usage, day, field, amount, limit);
  if (!next) return false;
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('voice_usage', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(next)).run();
  return true;
}

export async function speak(env, request) {
  if (!env.OPENAI_API_KEY) return json({ error: "OpenAI voice isn't set up — add OPENAI_API_KEY" }, 503);
  const body = await request.json().catch(() => ({}));
  const text = cleanSpeechText(body.text);
  if (!text) return json({ error: "nothing to say" }, 400);
  const voice = TTS_VOICES.includes(body.voice) ? body.voice : DEFAULT_VOICE;
  if ((await budgetState(env, await settingValue(env, "monthly_budget"))).exceeded) return json({ error: "this month's budget is reached — using the device voice" }, 429);
  const limit = Number(env.VOICE_DAILY_CHARS) || DAILY_TTS_CHARS;
  if (!(await takeAllowance(env, "tts_chars", text.length, limit))) return json({ error: "today's OpenAI voice allowance is used up — using the device voice" }, 429);

  const model = env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
  const payload = { model, voice, input: text, response_format: "mp3" };
  if (model.includes("gpt-4o")) payload.instructions = BUTLER;           // tts-1 models don't take instructions
  let res;
  try {
    res = await fetch(base(env) + "/v1/audio/speech", {
      method: "POST",
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) { console.error("tts failed", err); return json({ error: "the voice service didn't answer" }, 502); }
  if (!res.ok) { console.error("tts error", res.status, (await res.text().catch(() => "")).slice(0, 300)); return json({ error: `the voice service refused the request (${res.status})` }, 502); }
  await recordUsage(env, [["tts_chars", text.length]]);
  return new Response(res.body, { status: 200, headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
}

export async function transcribe(env, request) {
  if (!env.OPENAI_API_KEY) return json({ error: "OpenAI voice isn't set up — add OPENAI_API_KEY" }, 503);
  const mime = (request.headers.get("content-type") || "").split(";")[0];
  const ext = audioExtension(mime);
  if (!ext) return json({ error: "unsupported audio type" }, 415);
  const buf = await request.arrayBuffer();
  if (buf.byteLength < 800) return json({ text: "" });                    // too short to hold speech
  if (buf.byteLength > MAX_AUDIO_BYTES) return json({ error: "that recording is too long" }, 413);
  if ((await budgetState(env, await settingValue(env, "monthly_budget"))).exceeded) return json({ error: "this month's budget is reached" }, 429);
  const limit = Number(env.VOICE_DAILY_STT) || DAILY_STT_CALLS;
  if (!(await takeAllowance(env, "stt_calls", 1, limit))) return json({ error: "today's OpenAI listening allowance is used up" }, 429);

  const attempt = async (model, rich) => {
    const fd = new FormData();
    fd.append("file", new File([buf], `speech.${ext}`, { type: mime }));
    fd.append("model", model);
    if (rich) { fd.append("keywords[]", "Jarvis"); fd.append("keywords[]", "J.A.R.V.I.S."); fd.append("languages[]", "en"); }
    else { fd.append("prompt", "Jarvis, J.A.R.V.I.S."); fd.append("language", "en"); }
    return fetch(base(env) + "/v1/audio/transcriptions", { method: "POST", headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` }, body: fd, signal: AbortSignal.timeout(30_000) });
  };
  try {
    const primary = env.OPENAI_STT_MODEL || "gpt-transcribe";
    let res = await attempt(primary, primary === "gpt-transcribe");
    if (!res.ok && [400, 404, 422].includes(res.status)) {              // model name / option not accepted: use the long-standing model
      console.error("stt primary refused", res.status, (await res.text().catch(() => "")).slice(0, 200));
      res = await attempt("gpt-4o-mini-transcribe", false);
    }
    if (!res.ok) { console.error("stt error", res.status); return json({ error: `the listening service refused the request (${res.status})` }, 502); }
    const data = await res.json();
    await recordUsage(env, [["stt_calls", 1], ["stt_secs", audioSeconds(buf, mime)]]);
    const text = String(data.text || "").trim();
    return json({ text: /[\p{L}\p{N}]/u.test(text) ? text : "" });       // drop "…" and other non-speech output
  } catch (err) { console.error("stt failed", err); return json({ error: "the listening service didn't answer" }, 502); }
}
