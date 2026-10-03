import { describe, it, expect } from "vitest";
import { makeSessionToken, verifySessionToken, buildSystemPrompt, parseImage, buildUserContent } from "../src/worker.js";

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
