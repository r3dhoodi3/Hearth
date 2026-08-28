import { OUT_OF_AREA_POST_MESSAGE } from "@/lib/serviceArea";

// Why this file exists.
//
// Every failure branch in postJobAction used to end the same way: setFlash()
// plus redirect("/contractors"). Two things went wrong with that, and testers
// hit both at once.
//
//   1. The redirect dropped the query string, so the page re-rendered the
//      post-a-job form with nothing in it. Everything the homeowner had typed
//      was gone, and a blank form is indistinguishable from "the app ate my
//      post".
//   2. The flash never made it to the screen. setFlash writes a cookie and
//      FlashToast (src/components/FlashToast.tsx) reads it on the client, but
//      it only re-runs its effect when it re-renders, and it subscribes with
//      usePathname(). Redirecting to the SAME path the owner is already on
//      leaves that pathname string identical, so the root-layout component
//      holding the toast is not guaranteed to re-render at all.
//
// So the failure reason travels in the URL instead, as a short code, next to
// the values being kept. The page turns the code back into a sentence and
// renders it under the Post job button, server-side - no cookie, no timer, no
// toast timing to lose. setFlash is still called alongside it, so a reader who
// does catch the toast sees the same words twice rather than nothing once.
//
// Codes are opaque to the browser on purpose: the message text lives here, so
// a crafted ?error= can only ever select one of these sentences, never inject
// its own.
export const POST_JOB_ERRORS = {
  out_of_area: OUT_OF_AREA_POST_MESSAGE,
  rate_hour:
    "You're posting jobs too quickly. Please wait a few minutes and try again.",
  rate_day:
    "You've reached today's posting limit. Please try again tomorrow.",
  category: "Please pick a valid job category.",
  description:
    "Please describe the job in at least 20 characters so pros know what they're applying to.",
  description_photos:
    "Please describe the job in at least 20 characters so pros know what they're applying to. Your photos weren't kept, so please re-attach them.",
  budget:
    "Pros need a budget range to bid seriously on projects this size. Please pick one and post again.",
  failed:
    "We couldn't post your job just now. Nothing was charged and nothing was sent to pros. Please try again in a moment.",
} as const;

export type PostJobErrorCode = keyof typeof POST_JOB_ERRORS;

// The sentence for a ?error= value, or null when there isn't one. hasOwnProperty
// rather than a bare index because the input is a URL parameter: a bare lookup
// would happily return Object.prototype's members for a crafted key.
export function postJobErrorMessage(
  code: string | undefined | null
): string | null {
  if (!code) return null;
  return Object.prototype.hasOwnProperty.call(POST_JOB_ERRORS, code)
    ? POST_JOB_ERRORS[code as PostJobErrorCode]
    : null;
}
