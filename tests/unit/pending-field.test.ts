// V1.0123 regression pins for the form-field flush.
//
// Live QA: typed "UNFLUSHED-VALUE" into an AcroForm text field and saved
// WITHOUT clicking away first (⌘S never blurs — the macOS menu accelerator
// fires straight into the app). The file on disk kept the PREVIOUS value, the
// toast said "Saved.", and the tab was marked clean — so what the user saw on
// screen was not what got written, and closing the tab afterwards wouldn't
// even warn. AcroForm widgets only commit on blur, so save/print have to ask
// the focused field to commit itself first.
import { describe, it, expect, beforeEach } from "vitest";
import {
  setActiveFieldFlusher,
  flushActiveFormField,
} from "../../src/renderer/lib/pending-field";

beforeEach(() => setActiveFieldFlusher(null));

describe("V1.0123: flushActiveFormField", () => {
  it("commits the focused field before the caller continues", async () => {
    const committed: string[] = [];
    setActiveFieldFlusher(async () => {
      await new Promise((r) => setTimeout(r, 10)); // async commit, like applyEdit
      committed.push("typed-value");
    });
    await flushActiveFormField();
    // Must have finished, not merely started — the save reads bytes next.
    expect(committed).toEqual(["typed-value"]);
  });

  it("is a no-op when nothing is focused", async () => {
    await expect(flushActiveFormField()).resolves.toBeUndefined();
  });

  it("never lets a failing field commit take the save down with it", async () => {
    setActiveFieldFlusher(async () => {
      throw new Error("field commit exploded");
    });
    // Save has its own error handling; a flush failure must not throw here.
    await expect(flushActiveFormField()).resolves.toBeUndefined();
  });

  it("unregisters on blur so a stale field can't commit into a later save", async () => {
    let calls = 0;
    setActiveFieldFlusher(async () => {
      calls += 1;
    });
    setActiveFieldFlusher(null); // blur / unmount
    await flushActiveFormField();
    expect(calls).toBe(0);
  });

  it("only the most recently focused field is flushed", async () => {
    const order: string[] = [];
    setActiveFieldFlusher(async () => void order.push("first"));
    setActiveFieldFlusher(async () => void order.push("second"));
    await flushActiveFormField();
    expect(order).toEqual(["second"]);
  });
});
