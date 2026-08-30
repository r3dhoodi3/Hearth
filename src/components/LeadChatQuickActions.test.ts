import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// LeadChat.tsx has no render harness of its own (it pulls in a live Supabase
// client via src/lib/lazySupabase.ts), so these run against the source the
// way src/components/phoneTapTargets.test.ts and src/lib/aiUsage.test.ts do.
function read(p: string) {
  return readFileSync(p, "utf8");
}

describe("LeadChat: one-tap status texts for an active job (CR5#2)", () => {
  const src = read("src/components/LeadChat.tsx");

  it("offers exactly the three canned texts", () => {
    expect(src).toContain('{ label: "On my way", text: "On my way!" }');
    expect(src).toContain('label: "Running about 15 minutes late"');
    expect(src).toContain('text: "Running about 15 minutes late."');
    expect(src).toContain("label: \"Job's done, sending the invoice now\"");
    expect(src).toContain("text: \"Job's done, sending the invoice now.\"");
  });

  it("only renders on the contractor side", () => {
    const row = src.slice(src.indexOf("QUICK_STATUS_TEXTS.map"));
    expect(src.slice(0, src.indexOf("QUICK_STATUS_TEXTS.map"))).toMatch(
      /role === "contractor" && \(\s*$/m
    );
    expect(row.slice(0, 400)).not.toContain("!closed &&");
  });

  it("fills the composer instead of sending", () => {
    const block = src.slice(
      src.indexOf("QUICK_STATUS_TEXTS.map"),
      src.indexOf("QUICK_STATUS_TEXTS.map") + 600
    );
    expect(block).toContain("setBody(t.text)");
    expect(block).toContain("focusComposer()");
    expect(block).not.toContain("send(");
  });

  it("scrolls horizontally on phone rather than wrapping", () => {
    const block = src.slice(
      src.indexOf("QUICK_STATUS_TEXTS.map") - 200,
      src.indexOf("QUICK_STATUS_TEXTS.map")
    );
    expect(block).toContain("overflow-x-auto");
  });

  it("sits above the composer form, inside the not-closed branch", () => {
    const quickIdx = src.indexOf("QUICK_STATUS_TEXTS.map");
    const formIdx = src.indexOf('<form onSubmit={send} className="flex gap-2">');
    const closedBranchIdx = src.indexOf('{closed ? (');
    expect(closedBranchIdx).toBeGreaterThan(-1);
    expect(quickIdx).toBeGreaterThan(closedBranchIdx);
    expect(quickIdx).toBeLessThan(formIdx);
  });
});

describe("LeadChat: auto-scroll keys on the newest message id, not the array (HIGH-9)", () => {
  const src = read("src/components/LeadChat.tsx");

  it("derives newestMessageId from the last message and scrolls only on that", () => {
    const idx = src.indexOf("const newestMessageId = messages.length");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 400);
    expect(block).toContain("messages[messages.length - 1].id");
    expect(block).toContain('useEffect(() => {\n    endRef.current?.scrollIntoView({ block: "nearest" });\n  }, [newestMessageId]);');
  });

  it("no longer keys the scroll effect on the whole messages array", () => {
    expect(src).not.toMatch(
      /endRef\.current\?\.scrollIntoView\(\{ block: "nearest" \}\);\s*\}, \[messages\]\);/
    );
  });
});

describe("LeadChat: send() has a synchronous re-entrancy guard (MED-10)", () => {
  const src = read("src/components/LeadChat.tsx");
  const sendIdx = src.indexOf("async function send(e: React.FormEvent) {");
  const sendBlock = src.slice(sendIdx, sendIdx + 2500);

  it("checks and latches `busy` before the first await", () => {
    const guardIdx = sendBlock.indexOf("if (busy) return;");
    const firstSetBusyIdx = sendBlock.indexOf("setBusy(true);");
    const firstAwaitIdx = sendBlock.indexOf("await getSupabase();");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(firstSetBusyIdx).toBeGreaterThan(-1);
    expect(firstAwaitIdx).toBeGreaterThan(-1);
    // Guard comes before the latch, and both come before the first await,
    // so a synchronous second call (double-tap) is rejected before any
    // async work (and thus any re-render) has had a chance to happen.
    expect(guardIdx).toBeLessThan(firstSetBusyIdx);
    expect(firstSetBusyIdx).toBeLessThan(firstAwaitIdx);
  });

  it("clears the latch on the too-long exit path", () => {
    const tooLongIdx = sendBlock.indexOf("if (finalBody.length > MAX_MESSAGE_LENGTH) {");
    expect(tooLongIdx).toBeGreaterThan(-1);
    const branch = sendBlock.slice(tooLongIdx, tooLongIdx + 300);
    expect(branch).toContain("setTooLong(true);");
    expect(branch).toContain("setBusy(false);");
    expect(branch).toContain("return;");
  });
});

describe("LeadChat: feed sort uses an ordinal timestamp compare, not localeCompare (LOW-11)", () => {
  it("sorts the merged feed by epoch millis (consistent with src/lib/unread.ts)", () => {
    const src = read("src/components/LeadChat.tsx");
    expect(src).not.toContain(
      "items.sort((a, b) => a.created_at.localeCompare(b.created_at));"
    );
    const idx = src.indexOf("items.sort(");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 200);
    expect(block).toContain("new Date(a.created_at).getTime()");
    expect(block).toContain("new Date(b.created_at).getTime()");
  });
});

describe("LeadChat: message-actions popover has a width cap (CR3#8)", () => {
  it("caps the popover to the viewport on a phone", () => {
    const src = read("src/components/LeadChat.tsx");
    const anchor = src.indexOf("min-w-[15rem] pt-1");
    expect(anchor).toBeGreaterThan(-1);
    const popover = src.slice(anchor, anchor + 300);
    expect(popover).toContain("max-sm:max-w-[calc(100vw-2rem)]");
  });

  it("the inner pill wraps on any width, not just on phone", () => {
    const src = read("src/components/LeadChat.tsx");
    const anchor = src.indexOf(
      "rounded-2xl border border-stone-200 bg-white px-3 py-1.5"
    );
    expect(anchor).toBeGreaterThan(-1);
    const pill = src.slice(Math.max(0, anchor - 100), anchor);
    expect(pill).toContain("flex-wrap");
  });
});
