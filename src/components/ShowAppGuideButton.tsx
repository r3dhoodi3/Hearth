"use client";

import { APP_GUIDE_EVENT } from "@/lib/appGuide";

// "Show the app guide again" for the help pages, both sides.
//
// A window event rather than a link or a query param: AppGuide is already
// mounted in the shell around every signed-in page (it renders null while it
// is closed), so this reopens it in place with no navigation, no refetch, and
// no route that only exists to be a switch. It also works after the account
// has been stamped as seen, which a server-decided prop could not do.
// The two shells accent their links differently (bark on the homeowner side,
// hearth on the pro side), so the colour is the caller's to pass rather than
// something this button decides and gets wrong on one of them.
const TONE = {
  homeowner: "text-bark-700 dark:text-stone-300",
  pro: "text-hearth-700 dark:text-hearth-300",
} as const;

export default function ShowAppGuideButton({
  tone = "homeowner",
  label = "Show the app guide again",
}: {
  tone?: keyof typeof TONE;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new CustomEvent(APP_GUIDE_EVENT))}
      className={`focus-ring inline-flex min-h-11 items-center text-sm font-medium hover:underline ${TONE[tone]}`}
    >
      {label}
    </button>
  );
}
