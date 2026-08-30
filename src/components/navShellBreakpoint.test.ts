import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// THE APP SHELL SWITCHES AT `lg`, NOT `sm` (2026-08-30).
//
// The top nav strip used to turn on at sm (640px) but only had room for itself
// from about 1024px, so between those widths the pills were painted straight
// over the "Hearth" wordmark and the home address. The fix moved BOTH halves of
// the shell - the top strip and the fixed bottom tab bar - to lg, which hands
// tablets the phone-style bar and leaves desktop exactly as it was.
//
// These read the SOURCE rather than a render, on purpose and in a node
// environment, for the same reason src/components/proNavTabs.test.ts does: Nav
// and ProNav are server components whose chrome never reaches the DOM in a test
// (NavLinks has to be stubbed - it opens a realtime unread subscription), and
// the thing being asserted is a Tailwind breakpoint, which jsdom does not apply
// anyway. The breakpoint is a fact about the code, so the code is what gets
// asserted.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const navSrc = src("./Nav.tsx");
const proNavSrc = src("./ProNav.tsx");
const appLayoutSrc = src("../app/(app)/layout.tsx");
const proLayoutSrc = src("../app/pro/layout.tsx");
const globalsCss = src("../app/globals.css");
const toastSrc = src("./ToastProvider.tsx");
const reviewPromptSrc = src("./ReviewPrompt.tsx");
const proTrialNudgeSrc = src("./pro/ProTrialNudge.tsx");

// The className string on the fixed bottom tab bar, which both shells render as
// `<nav aria-label="Primary" className="...">`.
function bottomBarClasses(source: string): string {
  const at = source.indexOf('aria-label="Primary"');
  expect(at).toBeGreaterThan(-1);
  const m = /className="([^"]+)"/.exec(source.slice(at));
  expect(m).not.toBeNull();
  return m![1];
}

describe("app shell breakpoint: lg, never sm", () => {
  it("hides the homeowner top strip until lg", () => {
    expect(navSrc).toContain('<div className="relative hidden min-w-0 lg:block">');
    expect(navSrc).not.toContain("min-w-0 sm:block");
  });

  it("hides the pro top strip until lg", () => {
    expect(proNavSrc).toContain(
      '<nav className="-mx-1 hidden items-center gap-1 overflow-x-auto px-1 lg:flex">'
    );
    expect(proNavSrc).not.toContain("overflow-x-auto px-1 sm:flex");
  });

  it("carries no sm: breakpoint on either bottom tab bar", () => {
    for (const source of [navSrc, proNavSrc]) {
      const classes = bottomBarClasses(source);
      expect(classes).toContain("lg:hidden");
      // Any sm: utility here would be a leftover from the old shell and would
      // put the bar and the strip back on two different breakpoints.
      expect(classes).not.toMatch(/(?:^|\s)(?:max-)?sm:/);
    }
  });

  it("carries no sm: breakpoint on either top strip wrapper", () => {
    const strips = [
      /<div className="(relative hidden min-w-0[^"]*)">/.exec(navSrc)?.[1],
      /<nav className="(-mx-1 hidden items-center[^"]*)">/.exec(proNavSrc)?.[1],
    ];
    for (const classes of strips) {
      expect(classes).toBeTruthy();
      expect(classes!).not.toMatch(/(?:^|\s)(?:max-)?sm:/);
    }
  });
});

describe("everything that clears the tab bar moved to lg with it", () => {
  it("keeps both shells' <main> padding until lg", () => {
    expect(appLayoutSrc).toContain("pb-24 pt-8 lg:pb-8");
    expect(proLayoutSrc).toContain("pb-24 pt-8 lg:pb-8");
    // The class attribute specifically; both files mention the old sm:pb-8 in
    // the comment that records why it moved.
    expect(appLayoutSrc).not.toContain("pt-8 sm:pb-8");
    expect(proLayoutSrc).not.toContain("pt-8 sm:pb-8");
  });

  it("lifts the pro footer over the bar at every width the bar exists", () => {
    expect(proLayoutSrc).toContain(
      "max-lg:pb-[calc(3.5rem_+_env(safe-area-inset-bottom)_+_1rem)]"
    );
  });

  it("lifts the corner widgets over the bar up to 1023.98px", () => {
    // globals.css nudges NewMessageNotifier and ChatDock (.fixed.bottom-4
    // .right-4) off the bar; the old 639px ceiling would have dropped them
    // onto it on a tablet.
    expect(globalsCss).toContain("@media (max-width: 1023.98px)");
    expect(globalsCss).not.toContain("@media (max-width: 639px)");
  });

  it("lifts the toast stack, the review prompt and the trial nudge at lg", () => {
    expect(toastSrc).toContain(
      "max-lg:bottom-[calc(3.5rem_+_env(safe-area-inset-bottom)_+_0.5rem)]"
    );
    expect(toastSrc).not.toContain("max-sm:bottom-[");
    expect(reviewPromptSrc).toContain("lg:bottom-4");
    expect(reviewPromptSrc).not.toContain("sm:bottom-4");
    expect(proTrialNudgeSrc).toContain("lg:bottom-6");
    expect(proTrialNudgeSrc).not.toContain("sm:bottom-6");
  });

  it("leaves the phone chat frame on the phone breakpoint", () => {
    // Deliberate: .hearth-chat-frame is the iOS keyboard workaround, bound to
    // PHONE_MEDIA_QUERY in useVisualViewport.ts (which also decides textarea
    // vs input). Both halves must name the same screens, so this one stays at
    // 639.98px while the tab bar runs to lg.
    expect(globalsCss).toContain("@media (max-width: 639.98px)");
    expect(src("../lib/useVisualViewport.ts")).toContain(
      'PHONE_MEDIA_QUERY = "(max-width: 639.98px)"'
    );
  });
});
