import { describe, it, expect } from "vitest";
import { evaluate, calculate } from "../src/calc.js";
import { parseICS, expandEvents, describeEvent, eventsBetween, normalizeIcsUrl, zonedToUtc } from "../src/ics.js";

describe("calculator", () => {
  it("does arithmetic with the right precedence", () => {
    expect(evaluate("2+3*4")).toBe(14);
    expect(evaluate("(2+3)*4")).toBe(20);
    expect(evaluate("2^3^2")).toBe(512);
    expect(evaluate("-2^2")).toBe(-4);
    expect(evaluate("2^-1")).toBe(0.5);
    expect(evaluate("10 % 4")).toBe(2);
    expect(evaluate("1,234.5 * 2")).toBe(2469);
    expect(evaluate("sqrt(16) + abs(-3)")).toBe(7);
    expect(evaluate("round(2.567, 2)")).toBe(2.57);
    expect(evaluate("max(3, 9, 4) - min(3, 9, 4)")).toBe(6);
    expect(evaluate("2*pi")).toBeCloseTo(6.283185, 5);
  });
  it("formats cleanly and reports errors instead of throwing", () => {
    expect(calculate("0.1+0.2").result).toBe("0.3");
    expect(calculate("1/3").result).toBe("0.333333333333");
    expect(calculate("2**10").result).toBe("1024");
    expect(calculate("1/0").error).toMatch(/zero/);
    expect(calculate("foo(2)").error).toMatch(/unknown function/);
    expect(calculate("2 2").error).toBeTruthy();
    expect(calculate("(1+2").error).toMatch(/missing/);
    expect(calculate("").error).toBeTruthy();
    expect(calculate("alert(1)").error).toBeTruthy();
    expect(calculate("constructor").error).toMatch(/unknown/);
    expect(calculate("(".repeat(100) + "1" + ")".repeat(100)).error).toMatch(/nested/);
    expect(calculate("9".repeat(400)).error).toMatch(/long/);
  });
});

const TZ = "America/New_York";
const ics = (...events) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events.map((e) => `BEGIN:VEVENT\r\n${e}\r\nEND:VEVENT`).join("\r\n")}\r\nEND:VCALENDAR\r\n`;
const win = (a, b) => [zonedToUtc(...a, TZ), zonedToUtc(...b, TZ)];
const run = (text, from = [2026, 10, 1, 0, 0, 0], to = [2026, 12, 1, 0, 0, 0]) => eventsBetween(text, ...win(from, to), TZ);
const brief = (list) => list.map((e) => `${e.date} ${e.start || "all-day"} ${e.title}`);

describe("calendar feed", () => {
  it("reads a zoned event and shows it in the owner's time zone", () => {
    const r = run(ics("UID:a\r\nDTSTART;TZID=America/New_York:20261005T090000\r\nDTEND;TZID=America/New_York:20261005T093000\r\nSUMMARY:Dentist\r\nLOCATION:12 Main St\\, Suite 4"));
    expect(r).toEqual([{ date: "2026-10-05", day: "Mon", title: "Dentist", location: "12 Main St, Suite 4", start: "9:00 AM", end: "9:30 AM" }]);
  });
  it("converts UTC times and unfolds long lines", () => {
    const r = run(ics("UID:u\r\nDTSTART:20261006T150000Z\r\nDTEND:20261006T160000Z\r\nSUMMARY:Call with a very long\r\n  title that wraps"));
    expect(brief(r)).toEqual(["2026-10-06 11:00 AM Call with a very long title that wraps"]);
  });
  it("handles multi-day all-day events (end date is exclusive)", () => {
    const r = run(ics("UID:b\r\nDTSTART;VALUE=DATE:20261010\r\nDTEND;VALUE=DATE:20261012\r\nSUMMARY:Conference"));
    expect(r).toEqual([{ date: "2026-10-10", day: "Sat", title: "Conference", all_day: true, through: "2026-10-11" }]);
  });
  it("expands DAILY with COUNT and skips an EXDATE", () => {
    const r = run(ics("UID:c\r\nDTSTART;TZID=America/New_York:20261001T080000\r\nDTEND;TZID=America/New_York:20261001T083000\r\nRRULE:FREQ=DAILY;COUNT=10\r\nEXDATE;TZID=America/New_York:20261003T080000\r\nSUMMARY:Standup"), [2026, 10, 1, 0, 0, 0], [2026, 10, 20, 0, 0, 0]);
    expect(r.map((e) => e.date)).toEqual(["2026-10-01", "2026-10-02", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10"]);
  });
  it("expands WEEKLY with BYDAY and COUNT", () => {
    const r = run(ics("UID:d\r\nDTSTART;TZID=America/New_York:20261005T180000\r\nDTEND;TZID=America/New_York:20261005T190000\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4\r\nSUMMARY:Gym"));
    expect(r.map((e) => e.date)).toEqual(["2026-10-05", "2026-10-07", "2026-10-12", "2026-10-14"]);
  });
  it("expands MONTHLY on the 2nd Tuesday and keeps wall-clock time across the DST change", () => {
    const r = run(ics("UID:m\r\nDTSTART;TZID=America/New_York:20261013T100000\r\nDTEND;TZID=America/New_York:20261013T110000\r\nRRULE:FREQ=MONTHLY;BYDAY=2TU\r\nSUMMARY:Board"));
    expect(brief(r)).toEqual(["2026-10-13 10:00 AM Board", "2026-11-10 10:00 AM Board"]);   // Nov 10 is after clocks fell back
  });
  it("expands MONTHLY on the last Friday and YEARLY", () => {
    const r = run(ics("UID:l\r\nDTSTART;TZID=America/New_York:20261030T120000\r\nDTEND;TZID=America/New_York:20261030T130000\r\nRRULE:FREQ=MONTHLY;BYDAY=-1FR\r\nSUMMARY:Lunch"));
    expect(r.map((e) => e.date)).toEqual(["2026-10-30", "2026-11-27"]);
    const y = eventsBetween(ics("UID:y\r\nDTSTART;VALUE=DATE:20200315\r\nRRULE:FREQ=YEARLY\r\nSUMMARY:Anniversary"), ...win([2026, 3, 1, 0, 0, 0], [2027, 4, 1, 0, 0, 0]), TZ);
    expect(y.map((e) => e.date)).toEqual(["2026-03-15", "2027-03-15"]);
  });
  it("honours UNTIL", () => {
    const r = run(ics("UID:t\r\nDTSTART;TZID=America/New_York:20261001T120000\r\nDTEND;TZID=America/New_York:20261001T130000\r\nRRULE:FREQ=DAILY;UNTIL=20261003T235959Z\r\nSUMMARY:Short run"));
    expect(r.map((e) => e.date)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
  });
  it("applies an edited occurrence and drops cancelled events", () => {
    const text = ics(
      "UID:g\r\nDTSTART;TZID=America/New_York:20261001T120000\r\nDTEND;TZID=America/New_York:20261001T130000\r\nRRULE:FREQ=DAILY;COUNT=3\r\nSUMMARY:Sync",
      "UID:g\r\nRECURRENCE-ID;TZID=America/New_York:20261002T120000\r\nDTSTART;TZID=America/New_York:20261002T150000\r\nDTEND;TZID=America/New_York:20261002T160000\r\nSUMMARY:Sync (moved)",
      "UID:x\r\nDTSTART;TZID=America/New_York:20261004T120000\r\nDTEND;TZID=America/New_York:20261004T130000\r\nSTATUS:CANCELLED\r\nSUMMARY:Called off"
    );
    expect(brief(run(text))).toEqual(["2026-10-01 12:00 PM Sync", "2026-10-02 3:00 PM Sync (moved)", "2026-10-03 12:00 PM Sync"]);
  });
  it("respects the window and sorts by time", () => {
    const text = ics("UID:1\r\nDTSTART:20260101T120000Z\r\nDTEND:20260101T130000Z\r\nSUMMARY:Old", "UID:3\r\nDTSTART:20261009T120000Z\r\nDTEND:20261009T130000Z\r\nSUMMARY:Later", "UID:2\r\nDTSTART:20261007T120000Z\r\nDTEND:20261007T130000Z\r\nSUMMARY:Sooner");
    expect(run(text).map((e) => e.title)).toEqual(["Sooner", "Later"]);
  });
  it("ignores garbage and unknown time zones without throwing", () => {
    expect(run("not a calendar")).toEqual([]);
    const r = run(ics("UID:w\r\nDTSTART;TZID=Eastern Standard Time:20261005T090000\r\nDTEND;TZID=Eastern Standard Time:20261005T100000\r\nSUMMARY:Windows zone"));
    expect(r).toHaveLength(1);
  });
  it("only accepts safe feed URLs", () => {
    expect(normalizeIcsUrl("webcal://calendar.google.com/calendar/ical/x/private-abc/basic.ics")).toBe("https://calendar.google.com/calendar/ical/x/private-abc/basic.ics");
    expect(normalizeIcsUrl("https://example.com/cal.ics")).toBeTruthy();
    expect(normalizeIcsUrl("http://example.com/cal.ics")).toBeNull();
    expect(normalizeIcsUrl("https://localhost/cal.ics")).toBeNull();
    expect(normalizeIcsUrl("https://127.0.0.1/cal.ics")).toBeNull();
    expect(normalizeIcsUrl("https://user:pw@example.com/c.ics")).toBeNull();
    expect(normalizeIcsUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeIcsUrl("")).toBeNull();
  });
});

import { splitSpoken, extractSources, normalizeHistory, buildRequest, buildSystemPrompt, CLIENT_TOOLS, SERVER_TOOLS, pickModel, validPdfBase64 } from "../src/brain.js";
import { chunkText, ftsQuery } from "../src/library.js";

describe("reply parsing", () => {
  it("splits a trailing SPOKEN line from the on-screen answer", () => {
    expect(splitSpoken("Full text.\n\nSPOKEN: Short version, Sir.")).toEqual({ answer: "Full text.", spoken: "Short version, Sir." });
    expect(splitSpoken("Just a short reply.")).toEqual({ answer: "Just a short reply.", spoken: "" });
    expect(splitSpoken("It said SPOKEN: in the middle of a sentence").spoken).toBe("");   // only when it starts a line
    expect(splitSpoken("Body\nSPOKEN: `Wrapped in ticks.`").spoken).toBe("Wrapped in ticks.");
    expect(splitSpoken("")).toEqual({ answer: "", spoken: "" });
  });
  it("collects unique sources from citations, falling back to search hits", () => {
    const cited = [{ type: "text", text: "a", citations: [{ url: "https://a.example", title: "A" }, { url: "https://a.example", title: "A again" }, { url: "javascript:x", title: "bad" }] }];
    expect(extractSources(cited)).toEqual([{ title: "A", url: "https://a.example" }]);
    const hits = [{ type: "web_search_tool_result", content: [{ url: "https://b.example", title: "B" }, { url: "https://c.example", title: "C" }] }, { type: "text", text: "no citations" }];
    expect(extractSources(hits).map((s) => s.url)).toEqual(["https://b.example", "https://c.example"]);
    expect(extractSources([], 6)).toEqual([]);
  });
  it("makes sure history starts with a user turn", () => {
    expect(normalizeHistory([{ role: "assistant", content: "briefing" }, { role: "user", content: "hi" }, { role: "assistant", content: "yo" }]).map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(normalizeHistory([{ role: "assistant", content: "only" }])).toEqual([]);
  });
});

describe("request shape", () => {
  const base = { model: "claude-sonnet-5-5", system: "s", messages: [{ role: "user", content: "hi" }], search: true };
  it("full request: effort, fallbacks, server tools, no forbidden params", () => {
    const { body, betas } = buildRequest({ ...base, deep: false, full: true });
    expect(body.output_config).toEqual({ effort: "medium" });
    expect(body.max_tokens).toBe(2500);
    expect(body.fallbacks).toBe("default");
    expect(betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(body.tools.filter((t) => t.type).map((t) => t.type)).toEqual(SERVER_TOOLS.map((t) => t.type));
    for (const k of ["thinking", "temperature", "top_p", "top_k", "tool_choice"]) expect(body).not.toHaveProperty(k);
  });
  it("deep request raises effort and the output budget; search can be switched off", () => {
    const d = buildRequest({ ...base, deep: true, full: true }).body;
    expect(d.output_config.effort).toBe("high");
    expect(d.max_tokens).toBe(6000);
    expect(buildRequest({ ...base, search: false, deep: false, full: true }).body.tools).toEqual(CLIENT_TOOLS);
  });
  it("plain request has no beta features", () => {
    const { body, betas } = buildRequest({ ...base, deep: false, full: false });
    expect(betas).toEqual([]);
    expect(body).not.toHaveProperty("output_config");
    expect(body).not.toHaveProperty("fallbacks");
    expect(body.tools).toEqual(CLIENT_TOOLS);
  });
  it("tool schemas are well-formed and uniquely named", () => {
    const names = CLIENT_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of CLIENT_TOOLS) { expect(t.input_schema.type).toBe("object"); expect(t.description.length).toBeGreaterThan(20); }
  });
  it("builds a Haiku-compatible request (no effort, no fallbacks, basic web search)", () => {
    const { body, betas } = buildRequest({ model: "claude-haiku-4-5", system: "s", messages: [{ role: "user", content: "hi" }], search: true, full: true });
    expect(body.output_config).toBeUndefined();
    expect(body.fallbacks).toBeUndefined();
    expect(betas).toEqual([]);
    expect(body.tools.filter((t) => t.type).map((t) => t.type)).toEqual(["web_search_20250305"]);
  });

  it("picks models from the environment", () => {
    expect(pickModel({}, false)).toBe("claude-sonnet-5-5");
    expect(pickModel({}, true)).toBe("claude-opus-5-5");
    expect(pickModel({ CLAUDE_DEEP_MODEL: "claude-fable-5-1" }, true)).toBe("claude-fable-5-1");
  });
  it("validates PDFs", () => {
    expect(validPdfBase64("A".repeat(300))).toBe(true);
    expect(validPdfBase64("A".repeat(50))).toBe(false);
    expect(validPdfBase64("not base64 !!" + "A".repeat(300))).toBe(false);
  });
});

describe("system prompt", () => {
  it("reflects what is switched on", () => {
    const on = buildSystemPrompt([], [], "2026-10-03", { search: true, calendar: true, libraryDocs: 2, memories: [{ id: "ab12", text: "Daughter is Emma" }] });
    expect(on).toContain("web_search");
    expect(on).toContain("get_calendar");
    expect(on).toContain("2 saved documents");
    expect(on).toContain("[ab12] Daughter is Emma");
    expect(on).toContain("SPOKEN:");
    const off = buildSystemPrompt([], [], "2026-10-03", { search: false });
    expect(off).toContain("cannot browse the web");
    expect(off).toContain("none is connected");
    expect(off).toContain("(none yet)");
    expect(buildSystemPrompt([], [], "2026-10-03", { deep: true })).toContain("deep-think");
  });
});

describe("library text handling", () => {
  it("chunks on paragraph boundaries and never exceeds the limit", () => {
    const text = Array.from({ length: 30 }, (_, i) => `Paragraph ${i}. ` + "word ".repeat(60)).join("\n\n");
    const chunks = chunkText(text, 1200);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((c) => c.length <= 1200)).toBe(true);
    expect(chunks.join(" ")).toContain("Paragraph 29");
    expect(chunkText("x".repeat(5000), 1200).every((c) => c.length <= 1200)).toBe(true);
    expect(chunkText("   ")).toEqual([]);
  });
  it("builds a safe FTS query from arbitrary input", () => {
    expect(ftsQuery("What is my monthly rent?")).toBe('"what" OR "is" OR "my" OR "monthly" OR "rent"');
    expect(ftsQuery('DROP TABLE; "quote" OR * NEAR(')).not.toMatch(/[*;(]/);
    expect(ftsQuery("a ! ?")).toBe("");
    expect(ftsQuery("café naïve")).toBe('"café" OR "naïve"');
  });
});

import { audioExtension, cleanSpeechText, spend, TTS_VOICES, DEFAULT_VOICE, BUTLER } from "../src/voice.js";

describe("OpenAI voice helpers", () => {
  it("maps recorder mime types to extensions OpenAI accepts", () => {
    expect(audioExtension("audio/webm;codecs=opus")).toBe("webm");
    expect(audioExtension("audio/mp4")).toBe("mp4");
    expect(audioExtension("audio/x-m4a")).toBe("mp4");
    expect(audioExtension("audio/mpeg")).toBe("mp3");
    expect(audioExtension("audio/wav")).toBe("wav");
    expect(audioExtension("text/html")).toBeNull();
    expect(audioExtension("")).toBeNull();
  });
  it("cleans and caps the text to speak", () => {
    expect(cleanSpeechText("  hello \n\n  world  ")).toBe("hello world");
    expect(cleanSpeechText("a".repeat(5000))).toHaveLength(1500);
    expect(cleanSpeechText(null)).toBe("");
  });
  it("enforces a per-day allowance and resets on a new day", () => {
    const day = "2026-10-03";
    let u = spend(null, day, "tts_chars", 40, 100);
    expect(u).toEqual({ day, tts_chars: 40, stt_calls: 0 });
    u = spend(u, day, "tts_chars", 60, 100);
    expect(u.tts_chars).toBe(100);
    expect(spend(u, day, "tts_chars", 1, 100)).toBeNull();                       // over the ceiling
    expect(spend(u, day, "stt_calls", 1, 5).stt_calls).toBe(1);                    // separate counter
    expect(spend(u, "2026-10-04", "tts_chars", 10, 100)).toEqual({ day: "2026-10-04", tts_chars: 10, stt_calls: 0 });
  });
  it("offers a sane voice list and a fixed butler persona", () => {
    expect(TTS_VOICES).toContain(DEFAULT_VOICE);
    expect(new Set(TTS_VOICES).size).toBe(TTS_VOICES.length);
    expect(BUTLER).toMatch(/British butler/);
  });
});

import { readFileSync } from "node:fs";
const Wake = (() => { const root = {}; new Function("window", readFileSync(new URL("../public/wake.js", import.meta.url), "utf8"))(root); return root.JarvisWake; })();

describe("wake word", () => {
  const p = (t) => Wake.parse(t);
  it("hears the name at the start, with or without a greeting", () => {
    expect(p("Jarvis, what's the weather?")).toMatchObject({ woke: true, command: "what's the weather?" });
    expect(p("Jarvis what time is it")).toMatchObject({ woke: true, command: "what time is it" });
    expect(p("Hey Jarvis, remind me to call Mom")).toMatchObject({ woke: true, command: "remind me to call Mom" });
    expect(p("OK Jarvis add milk to the list")).toMatchObject({ woke: true, command: "add milk to the list" });
    expect(p("Jarvis")).toMatchObject({ woke: true, command: "" });
    expect(p("Hey Jarvis")).toMatchObject({ woke: true, command: "" });
  });
  it("hears the name at the end of a sentence", () => {
    expect(p("what's on my calendar, Jarvis")).toMatchObject({ woke: true, command: "what's on my calendar" });
    expect(p("what is the weather Jarvis please")).toMatchObject({ woke: true, command: "what is the weather please" });
  });
  it("copes with mis-hearings and spelling", () => {
    for (const w of ["Jervis", "Garvis", "Jarvus", "Jarves", "Jarvis's"]) expect(p(`${w}, what time is it`).woke).toBe(true);
    expect(p("J.A.R.V.I.S. what time is it")).toMatchObject({ woke: true, command: "what time is it" });
    expect(p("jar vis what time is it")).toMatchObject({ woke: true, command: "what time is it" });
  });
  it("does not wake on the name used in passing, or on other names", () => {
    expect(p("I told Jarvis to order the sleeves yesterday").woke).toBe(false);
    expect(p("my friend says Jarvis is great and the weather is fine").woke).toBe(false);
    expect(p("Jarvis is a great assistant").woke).toBe(false);
    expect(p("tell Travis I will call him later").woke).toBe(false);
    expect(p("Harvey called about the order").woke).toBe(false);
    expect(p("what time is it").woke).toBe(false);
    expect(p("").woke).toBe(false);
  });
  it("recognises goodbyes and filler", () => {
    expect(p("Thanks Jarvis")).toMatchObject({ woke: true, bye: true });
    expect(p("thank you")).toMatchObject({ bye: true });
    expect(p("That's all, Jarvis")).toMatchObject({ woke: true, bye: true });
    expect(p("never mind")).toMatchObject({ bye: true });
    expect(p("stop listening")).toMatchObject({ bye: true });
    expect(p("Thanks for the update on the order").bye).toBe(false);
    expect(p("um").filler).toBe(true);
    expect(p("Okay.").filler).toBe(true);
    expect(p("yeah").filler).toBe(true);
    expect(p("okay what is next").filler).toBe(false);
  });
  it("fuzzy matching is tight enough to avoid ordinary words", () => {
    for (const w of ["service", "harvest", "travis", "jarring", "jargon", "marvels"]) expect(Wake.isName(w)).toBe(false);
    expect(Wake.isName("Jarvis")).toBe(true);
  });
});
