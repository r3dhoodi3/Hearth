"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useToast } from "@/components/ToastProvider";

// The client half of the flash-toast system, and the reason the root layout is
// allowed to be static.
//
// ARCHITECTURE (unchanged contract, moved render):
//   SETS    - setFlash() in a Server Action, src/lib/flash.ts. Writes a
//             short-lived, non-httpOnly cookie that survives the action's
//             revalidatePath()/redirect().
//   RENDERS - this component, on the client, by reading document.cookie.
//   DELETES - this component, right after the toast is queued, so a refresh
//             cannot replay it.
//
// This used to be FlashBridge: the root layout called readFlash() (which calls
// cookies()) and handed the result down as a prop. That one cookies() read made
// EVERY route in the app dynamic, because the root layout wraps every page - the
// build produced zero static pages. The cookie was already httpOnly: false
// precisely so the client could clear it, so the client can read it just as
// easily, and nothing about the setFlash/readFlash server contract changes.
// readFlash() stays exported for any server consumer that wants it.
//
// The cookie name is duplicated here as a literal rather than imported from
// src/lib/flash.ts on purpose: that module imports next/headers, which must
// never be pulled into the browser bundle. Keep the two in lockstep.
const FLASH_COOKIE = "hearth_flash";

// Same ceiling as FLASH_MAX_DURATION_MS in src/lib/flash.ts, duplicated for the
// same reason the cookie name is: that module imports next/headers and must
// never reach the browser bundle. Keep the two in lockstep.
const MAX_DURATION_MS = 15000;

type FlashType = "success" | "error" | "info" | "warning";

const FLASH_TYPES: ReadonlySet<string> = new Set([
  "success",
  "error",
  "info",
  "warning",
]);

type ClientFlash = {
  message: string;
  type: FlashType;
  id: string;
  duration?: number;
};

// Reads and validates the flash cookie. Everything about the payload is
// treated as untrusted: it is a cookie, so a user can hand us anything, and a
// bad `type` would index straight into the toast API. Anything that is not a
// well-formed flash is simply ignored.
function readFlashCookie(): ClientFlash | null {
  if (typeof document === "undefined") return null;
  const raw = document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${FLASH_COOKIE}=`))
    ?.slice(FLASH_COOKIE.length + 1);
  if (!raw) return null;
  // cookies().set() serializes the value with encodeURIComponent, so the JSON
  // arrives percent-encoded. A value that somehow isn't encoded still parses.
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Malformed escape sequence; fall through and try the raw text.
  }
  try {
    const parsed = JSON.parse(decoded) as Partial<ClientFlash>;
    if (
      typeof parsed?.message !== "string" ||
      !parsed.message ||
      typeof parsed.id !== "string" ||
      typeof parsed.type !== "string" ||
      !FLASH_TYPES.has(parsed.type)
    ) {
      return null;
    }
    // duration is optional and, like everything else here, untrusted: only a
    // finite non-negative number survives, capped so a cookie cannot pin a
    // toast on screen. Anything else is dropped and the type default applies.
    const duration =
      typeof parsed.duration === "number" &&
      Number.isFinite(parsed.duration) &&
      parsed.duration >= 0
        ? Math.min(parsed.duration, MAX_DURATION_MS)
        : undefined;
    return {
      message: parsed.message,
      type: parsed.type as FlashType,
      id: parsed.id,
      ...(duration === undefined ? {} : { duration }),
    };
  } catch {
    return null;
  }
}

export default function FlashToast() {
  const toast = useToast();
  const lastId = useRef<string | null>(null);

  // Subscribes this component to route changes so a flash set by an action
  // that redirects is picked up even when nothing above it re-renders. The
  // value itself is unused - the subscription is the point. Deliberately
  // usePathname and NOT useSearchParams: the latter forces every page that
  // renders it into client-side rendering at build time, which would undo the
  // whole reason this component exists.
  usePathname();

  // No dependency array on purpose. This runs after EVERY render of this
  // component, which is what catches the common case: a Server Action that
  // calls setFlash() then revalidatePath() on the SAME path, so there is no
  // navigation to hook - only a fresh RSC payload that re-renders the tree.
  // The lastId guard (same dedupe FlashBridge used) makes the repeat runs free
  // and guarantees one flash fires exactly once.
  useEffect(() => {
    const flash = readFlashCookie();
    if (!flash || flash.id === lastId.current) return;
    lastId.current = flash.id;
    toast[flash.type](
      flash.message,
      flash.duration === undefined ? undefined : { duration: flash.duration }
    );
    document.cookie = `${FLASH_COOKIE}=; Max-Age=0; path=/`;
  });

  return null;
}
