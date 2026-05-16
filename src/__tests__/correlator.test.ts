import { describe, expect, it } from "bun:test";
import { FrameCorrelator } from "../correlator.js";

describe("FrameCorrelator", () => {
  it("resolve() returns the payload to the waiter and clears state", async () => {
    const c = new FrameCorrelator();
    const reqId = "req-1";
    const promise = c.register<{ value: number }>(reqId, 5_000);
    expect(c.size).toBe(1);
    expect(c.resolve(reqId, { value: 42 })).toBe(true);
    expect(c.size).toBe(0);
    await expect(promise).resolves.toEqual({ value: 42 });
  });

  it("resolve() of an unknown / already-settled request returns false", () => {
    const c = new FrameCorrelator();
    expect(c.resolve("nope", {})).toBe(false);
    const promise = c.register("req", 5_000);
    void promise.catch(() => undefined); // suppress unhandled rejection
    c.resolve("req", {});
    expect(c.resolve("req", {})).toBe(false);
  });

  it("register() rejects on timeout and clears state", async () => {
    const c = new FrameCorrelator();
    const promise = c.register("req-t", 25);
    await expect(promise).rejects.toThrow(/timeout/);
    expect(c.size).toBe(0);
  });

  it("reject() fires the waiter with the given error", async () => {
    const c = new FrameCorrelator();
    const promise = c.register("req-r", 5_000);
    expect(c.reject("req-r", new Error("conn_dropped"))).toBe(true);
    await expect(promise).rejects.toThrow(/conn_dropped/);
    expect(c.size).toBe(0);
  });

  it("rejectAll() drains every outstanding waiter", async () => {
    const c = new FrameCorrelator();
    const p1 = c.register("a", 5_000);
    const p2 = c.register("b", 5_000);
    expect(c.size).toBe(2);
    c.rejectAll(new Error("shutdown"));
    expect(c.size).toBe(0);
    await expect(p1).rejects.toThrow(/shutdown/);
    await expect(p2).rejects.toThrow(/shutdown/);
  });

  it("register() with a duplicate request_id throws synchronously", () => {
    const c = new FrameCorrelator();
    void c.register("dup", 5_000).catch(() => undefined);
    expect(() => c.register("dup", 5_000)).toThrow(/duplicate/);
  });
});
