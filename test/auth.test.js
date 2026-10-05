import { describe, it, expect } from "vitest";
import { localParts, isDue, validTimezone, isAllowedPushEndpoint, categorize, plainBriefing, plainReminder, applySettings, vapidHeader, b64u, dayDiff } from "../src/notify.js";
import { makeSessionToken, verifySessionToken, buildSystemPrompt, parseImage, buildUserContent, localClock } from "../src/worker.js";

describe("session tokens", () => {
  it("accepts a fresh token", async () => {
    expect(await verifySessionToken("s3cret", await makeSessionToken("s3cret"))).toBe(true);
  });
  it("rejects a token signed with another secret", async () => {
    expect(await verifySessionToken("other", await makeSessionToken("s3cret"))).toBe(false);
  });
  it("rejects an expired token", async () => {
    const old = await makeSessionToken("s3cret", Date.now() - 40 * 86400_000);
    expect(await verifySessionToken("s3cret", old)).toBe(false);
  });
  it("rejects tampered expiry and garbage", async () => {
    const [, sig] = (await makeSessionToken("s3cret")).split(".");
    expect(await verifySessionToken("s3cret", `${Date.now() + 9e12}.${sig}`)).toBe(false);
    expect(await verifySessionToken("s3cret", "nope")).toBe(false);
    expect(await verifySessionToken("s3cret", null)).toBe(false);
    expect(await verifySessionToken("", "1.2")).toBe(false);
  });
});

describe("buildSystemPrompt", () => {
  it("includes today's date and data", () => {
    const p = buildSystemPrompt([{ id: "a", text: "call Mom" }], [], "2026-10-03");
    expect(p).toContain("2026-10-03");
    expect(p).toContain("call Mom");
  });
});

describe("photos", () => {
  const good = { media_type: "image/jpeg", data: "A".repeat(200) };
  it("accepts a well-formed image", () => {
    expect(parseImage(good)).toEqual(good);
  });
  it("rejects bad types, bad base64, tiny and oversized payloads", () => {
    expect(parseImage({ ...good, media_type: "image/svg+xml" })).toBeNull();
    expect(parseImage({ ...good, media_type: "text/html" })).toBeNull();
    expect(parseImage({ ...good, data: "not base64!!" })).toBeNull();
    expect(parseImage({ ...good, data: "AAAA" })).toBeNull();
    expect(parseImage({ ...good, data: "A".repeat(6_000_001) })).toBeNull();
    expect(parseImage(null)).toBeNull();
    expect(parseImage("x")).toBeNull();
    expect(parseImage({ media_type: "image/png" })).toBeNull();
  });
  it("builds plain text without an image and image+text blocks with one", () => {
    expect(buildUserContent("hi", null)).toBe("hi");
    const blocks = buildUserContent("what is this", good);
    expect(blocks[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: good.data } });
    expect(blocks[1]).toEqual({ type: "text", text: "what is this" });
  });
});

describe("notify: time logic", () => {
  const at = (iso) => new Date(iso);
  it("reads the clock in the owner's time zone", () => {
    expect(localParts(at("2026-10-03T11:30:00Z"), "America/New_York")).toEqual({ date: "2026-10-03", time: "07:30" });
    expect(localParts(at("2026-10-03T03:05:00Z"), "America/New_York")).toEqual({ date: "2026-10-02", time: "23:05" });
    expect(localParts(at("2026-10-03T00:00:00Z"), "UTC").time).toBe("00:00");   // midnight is 00, never 24
  });
  it("is due from the set time for the window, once per day", () => {
    const tz = "America/New_York";
    expect(isDue(at("2026-10-03T11:29:00Z"), tz, "07:30", "", 240)).toBe(false);     // 07:29 — too early
    expect(isDue(at("2026-10-03T11:30:00Z"), tz, "07:30", "", 240)).toBe(true);      // 07:30
    expect(isDue(at("2026-10-03T14:29:00Z"), tz, "07:30", "", 240)).toBe(true);      // 10:29 — late but inside window
    expect(isDue(at("2026-10-03T15:30:00Z"), tz, "07:30", "", 240)).toBe(false);     // 11:30 — window over
    expect(isDue(at("2026-10-03T11:40:00Z"), tz, "07:30", "2026-10-03", 240)).toBe(false);  // already sent today
    expect(isDue(at("2026-10-04T11:40:00Z"), tz, "07:30", "2026-10-03", 240)).toBe(true);   // new day
  });
  it("validates time zones and push endpoints", () => {
    expect(validTimezone("Europe/London")).toBe(true);
    expect(validTimezone("Mars/Base")).toBe(false);
    expect(validTimezone("")).toBe(false);
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(isAllowedPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true);
    expect(isAllowedPushEndpoint("https://web.push.apple.com/QAbc")).toBe(true);
    expect(isAllowedPushEndpoint("https://wns2-par02p.notify.windows.com/w/?token=x")).toBe(true);
    expect(isAllowedPushEndpoint("http://fcm.googleapis.com/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://evil.example/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com.evil.example/x")).toBe(false);
    expect(isAllowedPushEndpoint("not a url")).toBe(false);
  });
});

describe("notify: briefing text", () => {
  const tasks = [
    { text: "Renew registration", due_date: "2026-10-01", done_at: null },
    { text: "Call Mom", due_date: "2026-10-03", done_at: null },
    { text: "Order sleeves", due_date: "2026-10-05", done_at: null },
    { text: "Someday", due_date: null, done_at: null },
    { text: "Already done", due_date: "2026-10-03", done_at: "2026-10-03 08:00:00" },
    { text: "Far off", due_date: "2026-11-30", done_at: null },
  ];
  const c = categorize(tasks, "2026-10-03");
  it("sorts tasks into overdue / today / soon / undated and ignores finished ones", () => {
    expect(c.overdue.map((t) => t.text)).toEqual(["Renew registration"]);
    expect(c.today.map((t) => t.text)).toEqual(["Call Mom"]);
    expect(c.soon.map((t) => t.text)).toEqual(["Order sleeves"]);
    expect(c.undated).toBe(1);
    expect(c.openCount).toBe(5);
  });
  it("writes a briefing and a reminder from them", () => {
    const b = plainBriefing(c);
    expect(b).toContain("Renew registration");
    expect(b).toContain("Call Mom");
    expect(b).not.toContain("Already done");
    expect(plainReminder(c)).toBe("Sir, a task is still due today: Call Mom.");
    expect(plainBriefing(categorize([], "2026-10-03"))).toContain("clear");
  });
  it("counts days between dates", () => { expect(dayDiff("2026-10-05", "2026-10-03")).toBe(2); });
});

describe("notify: settings validation", () => {
  const writes = [];
  const env = { DB: { prepare: () => ({ bind: (...a) => ({ run: async () => writes.push(a) }) }) } };
  it("rejects bad input and writes nothing", async () => {
    expect((await applySettings(env, { briefing_time: "25:00" })).error).toBeTruthy();
    expect((await applySettings(env, { briefing_time: "7:30" })).error).toBeTruthy();
    expect((await applySettings(env, { briefing_enabled: "yes" })).error).toBeTruthy();
    expect((await applySettings(env, { timezone: "Nowhere/Land" })).error).toBeTruthy();
    expect(writes.length).toBe(0);
  });
  it("stores valid input", async () => {
    expect((await applySettings(env, { briefing_time: "06:45", reminder_enabled: false, timezone: "Europe/London" })).ok).toBe(true);
    expect(writes).toHaveLength(3);
    expect(Object.fromEntries(writes)).toEqual({ briefing_time: "06:45", reminder_enabled: "0", timezone: "Europe/London" });
  });
});

describe("notify: VAPID", () => {
  it("signs a JWT the push service can verify (ES256, raw r||s)", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const pub = b64u(await crypto.subtle.exportKey("raw", pair.publicKey));
    const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const header = await vapidHeader("https://fcm.googleapis.com/fcm/send/abc", pub, jwk, 1_800_000_000);
    const m = header.match(/^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/);
    expect(m).toBeTruthy();
    const [, h, p, sig, k] = m;
    expect(k).toBe(pub);
    expect(JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/"))).aud).toBe("https://fcm.googleapis.com");
    const raw = Uint8Array.from(atob(sig.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(sig.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
    expect(raw.length).toBe(64);
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, raw, new TextEncoder().encode(`${h}.${p}`));
    expect(ok).toBe(true);
  });
});

describe("local clock", () => {
  it("uses the owner's day, not UTC's", () => {
    const night = new Date("2026-10-05T00:26:00Z");           // 8:26 PM on 4 October in New York
    expect(localClock("America/New_York", night).date).toBe("2026-10-04");
    expect(localClock("America/New_York", night).label).toContain("Sunday, 4 October 2026");
    expect(localClock("UTC", night).date).toBe("2026-10-05");
    expect(localClock("Not/AZone", night).tz).toBe("UTC");
  });
});
