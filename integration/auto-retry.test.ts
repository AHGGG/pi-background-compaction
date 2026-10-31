import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { fixture } from "./async-compaction-fixture.js";

const checkpoint = () => {
  const item = { type: "compaction", encrypted_content: "opaque" };
  return new Response(
    `data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [item] } })}\n\n`,
  );
};

for (const mode of ["provider-checkpoint", "text-summary"] as const)
  test(`transient ${mode} failure retries once and manual compaction awaits the same job`, async () => {
    vi.useFakeTimers();
    const h = fixture({ compactionMode: mode, asyncRetryCount: 1, maxRetries: 0, requestTimeoutMs: 30_000 });
    let calls = 0;
    h.setFetch(async () => {
      if (++calls === 1) return new Response("busy", { status: 503 });
      if (mode === "provider-checkpoint") return checkpoint();
      return new Response(
        `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Summary of user goal and pending work." }] }] } })}\n\n`,
      );
    });
    try {
      await h.emit("session_start", {});
      await h.start();
      await vi.advanceTimersByTimeAsync(0);
      assert.equal(calls, 1);
      assert.equal(
        h.notifications.some(({ message }) => message.includes("Warm-ahead paused")),
        false,
      );
      let completed = false;
      const pending = h.compact("manual").then((value) => {
        completed = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(4999);
      assert.equal(completed, false);
      assert.equal(calls, 1);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      assert.ok(result && typeof result === "object" && "compaction" in result);
      assert.equal(calls, 2);
      assert.equal(
        h.notifications.some(({ message }) => message.includes("retry 1/1")),
        false,
        "logs are disabled in fixture",
      );
    } finally {
      await h.emit("session_shutdown", {});
      vi.useRealTimers();
    }
  });

for (const mode of ["provider-checkpoint", "text-summary"] as const)
  test(`authentication change during ${mode} backoff does not dispatch a retry`, async () => {
    vi.useFakeTimers();
    const h = fixture({ compactionMode: mode, asyncRetryCount: 1, maxRetries: 0, requestTimeoutMs: 30_000 });
    h.setFetch(async () => new Response("busy", { status: 503 }));
    try {
      await h.emit("session_start", {});
      await h.start();
      await vi.advanceTimersByTimeAsync(0);
      assert.equal(h.fetches, 1);
      h.setKey("changed-key");
      await vi.advanceTimersByTimeAsync(5000);
      assert.equal(h.fetches, 1);
      assert.equal(
        h.notifications.some(({ message }) => message.includes("Warm-ahead paused")),
        false,
      );
    } finally {
      await h.emit("session_shutdown", {});
      vi.useRealTimers();
    }
  });
