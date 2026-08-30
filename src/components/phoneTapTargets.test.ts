import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The worst phone tap targets found in the 2026-08-29 low-vision audit. These
// controls have no render harness of their own (LeadChat and ChatDock both
// pull in a live Supabase client), so the invariant is asserted against the
// source the way src/lib/aiUsage.test.ts and src/app/pro/page.test.tsx do.
// Every assertion here is max-sm:-scoped or already breakpoint-scoped, so
// desktop rendering is untouched by design.
function read(p: string) {
  return readFileSync(p, "utf8");
}

describe("phone tap targets, 44px floor", () => {
  it("LeadChat's message-actions opener is 44px on a phone", () => {
    const src = read("src/components/LeadChat.tsx");
    // md:hidden, so on a touch screen this "..." is the ONLY way into reply,
    // copy, unsend and report. A miss means no message actions at all.
    const opener = src.slice(src.indexOf('aria-label="Message actions"'));
    expect(opener).toContain("max-sm:h-11");
    expect(opener.slice(0, 1200)).toContain("max-sm:w-11");
  });

  it("LeadChat's keep-conversation No is as big as the destructive Yes", () => {
    const src = read("src/components/LeadChat.tsx");
    const no = src.slice(src.indexOf('aria-label="No, keep conversation"'), src.indexOf('aria-label="No, keep conversation"') + 600);
    expect(no).toContain("max-sm:min-h-11");
  });

  it("FilePreview's remove-attachment badge has a 44px expander", () => {
    const src = read("src/components/FilePreview.tsx");
    // The visible badge stays small so it does not swallow the thumbnail; an
    // invisible ::after ring carries the touch area (same trick as
    // src/app/pro/profile/ProjectPhotoManager.tsx).
    expect(src).toContain("max-sm:after:-inset-2.5");
    expect(src).toContain("max-sm:after:content-['']");
  });

  it("ChatDock's three header glyphs are 44px and labelled", () => {
    const src = read("src/components/ChatDock.tsx");
    expect(src.match(/max-sm:h-11 max-sm:w-11/g) ?? []).toHaveLength(3);
    expect(src).toContain('aria-label="Close chat"');
    // The other two are ternaries (minimize/open, expand/shrink).
    expect(src).toContain('"Expand chat"');
    expect(src).toContain('"Minimize chat"');
  });

  it("the phone-only All conversations back link is 44px", () => {
    const src = read("src/app/(app)/chats/page.tsx");
    // Already md:hidden, so a bare min-h-11 is phone-scoped. This is the only
    // way out of an open thread on a phone.
    const links = src.match(/min-h-11[^"]*md:hidden/g) ?? [];
    expect(links.length).toBeGreaterThanOrEqual(3);
  });

  it("the signup consent checkbox and its label are a 44px row", () => {
    for (const p of [
      "src/app/homeowner-signup/page.tsx",
      "src/app/contractor-signup/page.tsx",
    ]) {
      const src = read(p);
      // Account creation is blocked on ticking this box.
      expect(src).toContain("max-sm:h-6 max-sm:w-6 max-sm:shrink-0");
      expect(src).toContain("max-sm:min-h-11 max-sm:py-1 max-sm:text-sm");
    }
  });

  // Part 2 of the audit: items D didn't already cover. See report-G.md /
  // report-D.md in the scratchpad for what each worker took.
  it("ToastProvider's Dismiss X is 44px, icon unchanged in size intent", () => {
    const src = read("src/components/ToastProvider.tsx");
    const btn = src.slice(src.indexOf('aria-label="Dismiss"'));
    expect(btn.slice(0, 700)).toContain("max-sm:flex max-sm:h-11 max-sm:w-11");
    expect(btn.slice(0, 700)).toContain("max-sm:items-center max-sm:justify-center");
    expect(btn).toContain("max-sm:h-5 max-sm:w-5");
  });

  it("/plus billing terms and help link are 14px+ and tappable on a phone", () => {
    const src = read("src/app/(app)/plus/page.tsx");
    // Proration terms, "you keep every benefit through", and the Change plan
    // label all read at 12px on a phone before this.
    expect(src).toContain(
      "text-left text-xs max-sm:text-sm text-stone-600 dark:border-white/10 dark:bg-stone-900 dark:text-stone-300"
    );
    expect(src.match(/text-xs max-sm:text-sm text-stone-500/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    const changePlan = src.indexOf(
      "text-xs max-sm:text-sm font-medium uppercase tracking-wide text-stone-500"
    );
    expect(changePlan).toBeGreaterThan(-1);
    expect(src.slice(changePlan, changePlan + 150)).toContain("Change plan");
    // Both "Questions? Visit help" blocks get a real hit area on the link.
    expect(src.match(/max-sm:inline-flex max-sm:min-h-11 max-sm:items-center/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("the Plus comparison table stays at 13px on a phone, not the full 14px", () => {
    const src = read("src/app/(app)/plus/page.tsx");
    // 13px + tighter px-1.5 cells (not the full sm text-sm/px-4) so three
    // columns keep fitting a 360px screen; see the comment above the table.
    expect(src).toContain('<table className="w-full text-[13px] sm:text-sm">');
    // 3 header cells + 3 body cells per row template.
    expect(src.match(/px-1\.5 py-3/g)?.length ?? 0).toBe(6);
    const summary = src.slice(src.indexOf("See everything included") - 400, src.indexOf("See everything included"));
    expect(summary).toContain("max-sm:min-h-11");
  });

  it("PlusWelcome's Skip link and fallback renewal terms clear the phone floor", () => {
    const src = read("src/app/(app)/plus/PlusWelcome.tsx");
    // Exit from the whole tour: a bare 20px link before this.
    const skipClass = src.indexOf(
      "hover:underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center dark:text-stone-400"
    );
    expect(skipClass).toBeGreaterThan(-1);
    expect(src.slice(skipClass, skipClass + 200)).toContain("Skip");
    expect(src).toContain(
      'text-xs max-sm:text-sm font-semibold uppercase tracking-wide text-stone-500'
    );
    expect(src).toContain("mt-2 text-xs max-sm:text-sm text-stone-600");
  });

  it("the dashboard's Tier 3 disclosure toggles and links clear the phone floor", () => {
    const src = read("src/app/(app)/dashboard/page.tsx");
    // "Matches county records" chip toggle, and its explainer paragraph.
    expect(src).toContain('chip-ok focus-ring w-fit cursor-pointer list-none [&::-webkit-details-marker]:hidden max-sm:min-h-11 max-sm:px-3 max-sm:text-sm');
    expect(src).toContain("mt-1.5 max-w-sm text-xs max-sm:text-sm text-stone-500");
    // "Why this score?" and "See this month's tasks" disclosures.
    expect(src).toContain("opacity-80 hover:opacity-100 max-sm:min-h-11");
    expect(src).toContain("text-sm font-medium text-stone-700 max-sm:min-h-11 dark:text-stone-300");
    // "Later"/"Done" and "Seasonal" group headers.
    expect(src.match(/max-sm:min-h-11 max-sm:text-sm/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    // "Your systems" section toggle and the "documents" / "Plan my next
    // round" links.
    expect(src).toContain("text-lg font-semibold text-stone-900 max-sm:min-h-11 dark:text-stone-100");
    expect(src).toContain(
      'className="text-bark-700 hover:underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center dark:text-stone-300"'
    );
    expect(src).toContain(
      'className="text-sm font-medium hover:underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center"'
    );
  });

  // 2026-08-30: "make the draft me button bigger and clearer" and "make the
  // text chat bigger so they can read it without small text from a small
  // box". ApplyJobButton, LeadChat's message bubbles, and ProToolsClient's
  // draft box all had this in common: 14px text and, for the draft button, a
  // link so small it read as an afterthought.
  it("ApplyJobButton's phone draft button is full-width, 44px, 16px, and clearly labelled above the message box", () => {
    const src = read("src/app/pro/ApplyJobButton.tsx");
    const phoneBtn = src.slice(
      src.indexOf("Phone only: a full-width, clearly-labelled button"),
      src.indexOf("<textarea")
    );
    expect(phoneBtn).toContain('className="btn-secondary w-full sm:hidden max-sm:min-h-11 max-sm:text-base"');
    expect(phoneBtn).toContain("<Sparkles");
    expect(phoneBtn).toContain('"Drafting..." : "Draft a message for me"');
    // Desktop keeps the original small link, hidden on phone instead of
    // deleted, with the same clearer label.
    const desktopBtn = src.slice(src.indexOf("<textarea"), src.indexOf("draftError &&"));
    expect(desktopBtn).toContain('className="flex flex-wrap items-center gap-2 max-sm:hidden"');
    expect(desktopBtn).toContain('"Drafting..." : "Draft a message for me"');
  });

  it("ApplyJobButton's message textarea grows to 6+ rows at 16px on a phone, unchanged on desktop", () => {
    const src = read("src/app/pro/ApplyJobButton.tsx");
    // No trailing "text-sm" override (that used to force 14px everywhere): the
    // shared .textarea class's own text-base/sm:text-sm now applies.
    expect(src).toContain('className="textarea w-full max-sm:min-h-40 max-sm:leading-relaxed"');
    expect(src).not.toContain('className="textarea w-full text-sm"');
  });

  it("ApplyJobButton bolds the fee amount and the credit-back words in the confirm-step disclaimer", () => {
    const src = read("src/app/pro/ApplyJobButton.tsx");
    const marker = "The fee amount and the credit-back words are bolded";
    const p = src.slice(src.indexOf(marker), src.indexOf(marker) + 800);
    expect(p).toContain("<strong>{fee}</strong>");
    expect(p).toContain("ghostProtectionGuaranteeRich()");
    expect(p).toContain("firstApplicationGuaranteeRich()");
    expect(p).toContain("creditNotCashLineRich()");
  });

  it("ProToolsClient's draft box reads at 16px on a phone, 10 rows, with a 44px Copy button", () => {
    const src = read("src/app/pro/tools/ProToolsClient.tsx");
    expect(src).toContain("rows={10}");
    expect(src).toContain("text-sm max-sm:text-base max-sm:leading-relaxed");
    const copyBtn = src.slice(src.indexOf('onClick={copyResult}'), src.indexOf('{copied ? "Copied" : "Copy"}'));
    expect(copyBtn).toContain("max-sm:min-h-11");
  });

  it("LeadChat's message bubble text is 16px on a phone with a 1.5 line-height, text-sm untouched for desktop", () => {
    const src = read("src/components/LeadChat.tsx");
    expect(src).toContain(
      "rounded-lg px-3 py-1.5 text-sm max-sm:text-base max-sm:leading-normal"
    );
  });
});
