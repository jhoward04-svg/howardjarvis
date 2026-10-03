import { describe, it, expect } from "vitest";
import { makeSessionToken, verifySessionToken, buildSystemPrompt } from "../src/worker.js";

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
