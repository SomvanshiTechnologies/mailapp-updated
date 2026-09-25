import { describe, expect, it } from "vitest";
import { makeMessageId, makeUnsubscribeToken, randomToken, safeEqual, sha256, verifyUnsubscribeToken } from "../../src/lib/crypto.js";
import { TokenBucket } from "../../src/modules/ses/rate-limiter.js";
import { MemoryQueue } from "../../src/jobs/queue.js";
import { sesMessageIdHeader } from "../../src/modules/ses/sender.js";

describe("crypto", () => {
  it("round-trips unsubscribe tokens and rejects tampering", () => {
    const id = "6f1a2b3c-0000-4000-8000-000000000001";
    const token = makeUnsubscribeToken("secret-1", id);
    expect(verifyUnsubscribeToken("secret-1", token)).toBe(id);
    expect(verifyUnsubscribeToken("secret-2", token)).toBeNull();
    expect(verifyUnsubscribeToken("secret-1", token.slice(0, -2) + "zz")).toBeNull();
    expect(verifyUnsubscribeToken("secret-1", "garbage")).toBeNull();
  });

  it("misc helpers", () => {
    expect(sha256("a")).toHaveLength(64);
    expect(randomToken(8)).not.toBe(randomToken(8));
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(makeMessageId("mail.example.com")).toMatch(/^<.+@mail\.example\.com>$/);
    expect(sesMessageIdHeader("abc", "us-east-1")).toBe("<abc@email.amazonses.com>");
    expect(sesMessageIdHeader("abc", "eu-west-1")).toBe("<abc@eu-west-1.amazonses.com>");
  });
});

describe("TokenBucket", () => {
  it("allows a burst then throttles at the configured rate", () => {
    let now = 0;
    const b = new TokenBucket(2, () => now);
    expect(b.take()).toBe(0); // burst capacity = rate (2)
    expect(b.take()).toBe(0);
    expect(b.take()).toBeGreaterThan(0); // third within same ms must wait ~500ms
    now += 1000; // refill 2 tokens
    b.setRate(2);
    expect(b.take()).toBe(0);
  });
});

describe("MemoryQueue", () => {
  it("dedupes by singleton key, honours delays and drains in order", async () => {
    const q = new MemoryQueue();
    const ran: string[] = [];
    await q.work<{ n: string }>("a", { concurrency: 1 }, async (d) => {
      ran.push(d.n);
    });
    await q.publish("a", { n: "1" }, { singletonKey: "k" });
    expect(await q.publish("a", { n: "dup" }, { singletonKey: "k" })).toBeNull();
    await q.publish("a", { n: "later" }, { startAfter: new Date(Date.now() + 60_000) });
    await q.publish("a", { n: "2" });
    expect(await q.drain()).toBe(2);
    expect(ran).toEqual(["1", "2"]);
    expect(q.pendingJobs()).toHaveLength(1);
    await q.drain({ includeFuture: true });
    expect(ran).toEqual(["1", "2", "later"]);
  });

  it("records handler failures", async () => {
    const q = new MemoryQueue();
    await q.work("b", { concurrency: 1 }, async () => {
      throw new Error("boom");
    });
    await q.publish("b", {});
    await q.drain();
    expect(q.failures).toHaveLength(1);
    expect((await q.stats()).find((s) => s.queue === "b")).toBeUndefined(); // unknown queue not listed
  });
});
