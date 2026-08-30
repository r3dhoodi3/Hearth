"use client";

import { useState } from "react";
import Link from "next/link";
import InlineSpinner from "@/components/InlineSpinner";
import { blockUserAction } from "@/app/(app)/account/blocks/actions";
import type { ActionResult } from "@/lib/actionResult";

// The Block control. A small overflow menu rather than a bare button, because
// blocking sits next to Report and neither deserves to be the loudest thing on
// a chat header or a business page.
//
// Three steps on purpose: menu, confirm, done. Blocking is not reversible from
// the surface you did it on - once a thread is blocked the pro's board no
// longer shows that homeowner - so the confirm step is the difference between
// a deliberate action and a mis-tap on a phone. The undo lives on the blocked
// list page, and the "done" state links straight to it so nobody has to go
// hunting for it.
//
// The form never says WHO to block. It passes the lead or the contractor
// profile this menu was rendered on, and the server action resolves the other
// party from it. See src/app/(app)/account/blocks/actions.ts.
//
// WHAT THE CONFIRM STEP HAS TO SAY, and why it is worth the extra lines. A
// block stops NEW contact: the other account cannot message you, cannot apply
// to jobs you post from now on, and the two of you stop being shown to each
// other. It does NOT touch a job or a conversation that already exists -
// migration 0138's guard sits on message INSERT and on apply_to_lead, not on
// can_access_lead, so a pro blocked mid-job still opens the thread they are
// already assigned to and still sees what that lead exposed to them. The old
// copy implied more than the enforcement delivers, which is the worst way for
// someone to find out. So the confirm step says it plainly, and where the
// surrounding screen already has the control that DOES end the thing
// (LeadChat's "End" in the conversation header), it is offered right here
// rather than left to be hunted for.
export default function BlockMenu({
  leadId,
  contractorId,
  personLabel,
  manageHref = "/account/blocks",
  onEndConversation,
  endLabel = "End this conversation",
  action = blockUserAction,
}: {
  // Exactly one of these. leadId blocks whoever is on the other end of that
  // thread; contractorId blocks the pro whose profile this is.
  leadId?: string;
  contractorId?: string;
  // How to name them in the confirm copy, e.g. "this pro" or a company name.
  personLabel: string;
  manageHref?: string;
  // The surrounding screen's own "end this" control, surfaced inside the
  // confirm step. Omitted where there is nothing to end (a pro's public
  // profile), and omitted once the thread is already closed.
  onEndConversation?: () => void;
  endLabel?: string;
  // Injectable for tests. Production always uses the real server action.
  action?: (formData: FormData) => Promise<ActionResult>;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmBlock() {
    setBusy(true);
    setError(null);
    const fd = new FormData();
    if (leadId) fd.set("lead_id", leadId);
    if (contractorId) fd.set("contractor_id", contractorId);
    try {
      const res = await action(fd);
      if (res && !res.ok) {
        // Stay on the confirm step. Nothing claims success that did not
        // happen, and the person can try again without re-opening the menu.
        setError(res.error);
        return;
      }
      setBlocked(true);
      setConfirming(false);
      setOpen(false);
    } catch {
      setError("Couldn't block this person just now. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (blocked) {
    return (
      <p className="text-xs text-stone-500 max-sm:text-sm dark:text-stone-400">
        Blocked.{" "}
        <Link href={manageHref} className="underline hover:text-stone-600 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center dark:hover:text-stone-300">
          Manage blocked accounts
        </Link>
      </p>
    );
  }

  if (confirming) {
    return (
      // Phone only: this whole panel is the consent copy for a block, and
      // 12px is too small to read before agreeing to it. Hit areas here are
      // already 44px.
      <div className="text-xs max-sm:text-sm">
        <p className="text-stone-700 dark:text-stone-300">
          Block {personLabel}? They will not be able to message you or apply to
          jobs you post from now on, and you will not be shown to each other
          for new work.
        </p>
        <p className="mt-1.5 text-stone-500 dark:text-stone-400">
          {onEndConversation
            ? "Blocking does not cancel a job or conversation you already have. This one stays open, with everything already in it, until one of you ends it."
            : "Blocking does not cancel a job or conversation you already have. Anything already underway stays as it is until one of you ends it."}{" "}
          You can undo a block from Blocked accounts.
        </p>
        {onEndConversation && (
          <p className="mt-1.5">
            <button
              type="button"
              onClick={onEndConversation}
              className="underline text-stone-600 hover:text-stone-900 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center dark:text-stone-300 dark:hover:text-stone-100"
            >
              {endLabel}
            </button>
          </p>
        )}
        {error && (
          <p role="alert" className="mt-1 text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            onClick={confirmBlock}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1 font-medium text-white max-sm:min-h-11 max-sm:px-4 disabled:opacity-50"
          >
            {busy && <InlineSpinner size={12} />}
            Block
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirming(false);
              setError(null);
            }}
            disabled={busy}
            className="text-stone-500 hover:text-stone-600 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center disabled:opacity-50 dark:text-stone-400 dark:hover:text-stone-300"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (open) {
    return (
      <div className="flex items-center gap-3 text-xs">
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="text-stone-500 hover:text-red-600 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center dark:text-stone-400 dark:hover:text-red-400"
        >
          Block {personLabel}
        </button>
        <Link
          href={manageHref}
          className="text-stone-500 hover:text-stone-600 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center dark:text-stone-400 dark:hover:text-stone-300"
        >
          Blocked accounts
        </Link>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-stone-500 hover:text-stone-600 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center dark:text-stone-400 dark:hover:text-stone-300"
        >
          Close
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label="More options"
      // A full 44px tap target on a phone, which is exactly the height of the
      // row these sit in, so nothing grows; desktop keeps the compact 24px
      // control. Kept as a text control, not an icon button, so it reads the
      // same next to the "Report chat" link it sits beside.
      className="px-1 text-xs text-stone-500 hover:text-stone-600 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center dark:text-stone-400 dark:hover:text-stone-300"
    >
      More
    </button>
  );
}
