"use client";

import { useEffect, useState, type RefObject } from "react";

// WHY THIS EXISTS.
//
// iOS Safari does not shrink the layout viewport when the software keyboard
// opens. 100dvh keeps reporting the full screen, the keyboard covers the
// bottom third of it, and Safari "helps" by scrolling the whole document so
// the focused field is somewhere on screen. On a chat that meant the composer
// the owner was typing into slid off the bottom, taking the tab bar and the
// message feed with it: "I lose what I type because it gets scrolled too far".
//
// window.visualViewport is the only thing that actually knows how much screen
// is left. This hook mirrors it onto <html> as custom properties so plain CSS
// can size a chat panel from it (see .hearth-chat-frame in globals.css), and
// marks the body while the keyboard is up so the bottom tab bar can get out of
// the way, the way iMessage's does.
//
//   --hearth-vvh          visual viewport height, px
//   --hearth-kb           how much of the layout viewport the keyboard covers
//   --hearth-chat-top     measured height of the sticky app header
//   --hearth-chat-bottom  measured height of the phone tab bar, 0 with a keyboard
//
// Every one of those is MEASURED, never hardcoded: the two headers (Nav.tsx
// and ProNav.tsx) are different heights and both grow with the text size the
// reader picked.

// Phones only, matching Tailwind's sm breakpoint (640px) so "below sm" here
// and `max-sm:` in the markup always mean the same set of screens.
export const PHONE_MEDIA_QUERY = "(max-width: 639.98px)";

// How much of the layout viewport has to go missing before we call it a
// keyboard. iOS also trims a few dozen pixels when the URL bar collapses on
// scroll, and hiding the tab bar for that would be a flicker on every swipe.
const KEYBOARD_MIN_PX = 100;

/**
 * Size a chat panel from the visual viewport for as long as this component is
 * mounted. Safe to call anywhere: with no window.visualViewport (older
 * browsers, some in-app webviews) it writes nothing at all and the CSS falls
 * back to its 100dvh defaults.
 */
export function useChatViewport() {
  useEffect(() => {
    const root = document.documentElement;
    const vv = window.visualViewport;
    if (!vv) return;

    const measure = () => {
      // What the keyboard is covering: everything the layout viewport has
      // that the visual viewport does not, minus whatever Safari has already
      // scrolled past. Never negative (pinch-zoom can make it look that way).
      const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      const open = kb > KEYBOARD_MIN_PX;
      document.body.classList.toggle("hearth-kb-open", open);

      const header = document.querySelector("header");
      const headerH = header ? header.getBoundingClientRect().height : 0;
      // The tab bar is display:none while the keyboard is up (globals.css), so
      // it would measure 0 anyway; short-circuiting means the panel does not
      // wait a frame for that rule to land.
      const tabs = open ? null : document.querySelector("nav.fixed.bottom-0");
      const tabsH = tabs ? tabs.getBoundingClientRect().height : 0;

      root.style.setProperty("--hearth-vvh", `${Math.round(vv.height)}px`);
      root.style.setProperty("--hearth-kb", `${Math.round(kb)}px`);
      root.style.setProperty("--hearth-chat-top", `${Math.round(headerH)}px`);
      root.style.setProperty("--hearth-chat-bottom", `${Math.round(tabsH)}px`);

      // Undo Safari's document shove. The panel is fixed and already sized to
      // the visual viewport, so the scroll it performed to "reveal" the field
      // only drags the panel's anchor off the top of the screen.
      const el = document.activeElement;
      const typing =
        !!el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT");
      if (typing && window.scrollY !== 0) window.scrollTo(0, 0);
    };

    measure();
    vv.addEventListener("resize", measure);
    vv.addEventListener("scroll", measure);
    window.addEventListener("orientationchange", measure);
    return () => {
      vv.removeEventListener("resize", measure);
      vv.removeEventListener("scroll", measure);
      window.removeEventListener("orientationchange", measure);
      document.body.classList.remove("hearth-kb-open");
      root.style.removeProperty("--hearth-vvh");
      root.style.removeProperty("--hearth-kb");
      root.style.removeProperty("--hearth-chat-top");
      root.style.removeProperty("--hearth-chat-bottom");
    };
  }, []);
}

/**
 * True below Tailwind's sm breakpoint. Starts false on the server and on the
 * first client render, so hydration always matches, then settles a tick later.
 *
 * Only for the handful of places a CSS breakpoint cannot reach: the composer
 * has to be an <input> on desktop (Enter sends, unchanged) and a <textarea> on
 * a phone (Return adds a line, Send sends), and that is a different ELEMENT,
 * not a different style. Anything expressible with `max-sm:` belongs in the
 * markup instead.
 */
// How tall the phone composer is allowed to get before it scrolls its own
// text instead of eating the conversation above it.
const MAX_COMPOSER_ROWS = 5;

/**
 * Keep a textarea exactly as tall as its content, up to five lines.
 *
 * `active` is the breakpoint switch: the textarea only exists on phones, so
 * this has to re-measure when it is mounted, not only when the text changes.
 * Everything is read off the computed style rather than assumed, because the
 * field is 16px on a phone and 14px on desktop and the reader can scale both.
 */
export function useAutoGrow(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  active: boolean
) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Back to nothing first, or a field that just got shorter would keep the
    // height of the longest thing ever typed into it.
    el.style.height = "auto";
    const cs = getComputedStyle(el);
    const line = parseFloat(cs.lineHeight) || 24;
    const pad =
      (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const border =
      (parseFloat(cs.borderTopWidth) || 0) +
      (parseFloat(cs.borderBottomWidth) || 0);
    // scrollHeight is content + padding; style.height is border-box here
    // (Tailwind's preflight), so the borders go back on by hand.
    const maxContent = line * MAX_COMPOSER_ROWS + pad;
    el.style.height = `${Math.min(el.scrollHeight, maxContent) + border}px`;
    el.style.overflowY = el.scrollHeight > maxContent ? "auto" : "hidden";
  }, [ref, value, active]);
}

export function useIsPhone(): boolean {
  const [isPhone, setIsPhone] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(PHONE_MEDIA_QUERY);
    const apply = () => setIsPhone(mq.matches);
    apply();
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
    // Safari below 14 only has the deprecated listener pair.
    mq.addListener(apply);
    return () => mq.removeListener(apply);
  }, []);
  return isPhone;
}
