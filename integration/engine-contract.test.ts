import assert from "node:assert/strict";
import { test } from "vitest";
import { fixture } from "./async-compaction-fixture.js";

for (const order of ["core-first", "background-first"] as const) {
  test(`real engine bridge prepares and adopts with ${order} registration`, async () => {
    const h = fixture({}, order);
    try {
      await h.emit("session_start", {});
      await h.start();
      await h.started;
      h.release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      const result = await h.compact("manual");
      assert.ok(result && typeof result === "object" && "compaction" in result);
      assert.equal(h.fetches, 1, "adopt the same request, never run a second compaction");
    } finally {
      h.release();
      await h.emit("session_shutdown", {});
    }
  });
}

test("core alone ignores legacy background opt-in and preserves manual compaction", async () => {
  const h = fixture({ asyncEnabled: true, asyncAutoApply: true }, "core-only");
  try {
    await h.emit("session_start", {});
    await h.start();
    await h.emit("input", {});
    assert.equal(h.fetches, 0, "no companion means no proactive preparation");
    h.release();
    const result = await h.compact("manual");
    assert.ok(result && typeof result === "object" && "compaction" in result);
    assert.equal(h.fetches, 1);
  } finally {
    h.release();
    await h.emit("session_shutdown", {});
  }
});
