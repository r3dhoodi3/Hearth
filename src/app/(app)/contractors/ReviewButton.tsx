"use client";

import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import type { ActionResult } from "@/lib/actionResult";
import { getMyInviteCodeAction } from "./inviteActions";
import InlineSpinner from "@/components/InlineSpinner";

// "Leave a review" / "Edit review" button shown on a closed job's row. Opens a
// star + comment form that submits through the saveReviewAction server action
// (which routes to the leave_review RPC). Prefills when a review already exists.
//
// The form is submitted programmatically (not a plain <form action>) so the
// modal only closes, and the invite follow-up only appears, once
// saveReviewAction actually returns ok(): a failed rating (bad RPC, network
// hiccup) keeps the modal open with the picked stars and typed comment
// intact, and shows the error inline instead of closing optimistically.
//
// Exactly ONE follow-up appears after a successful submit (owner ask,
// 2026-08-30: two stacked prompts after one review was too much): a CENTERED
// "Invite a neighbor" modal card with the homeowner's OWN Hearth invite link
// (their lazy referral code, migration 0099 - see inviteActions.ts). It shares
// Hearth itself, not the pro, and is honest neighbor-to-neighbor sharing with
// no reward, credit, or wallet of any kind. The code is fetched lazily so the
// modal only appears if a link can actually be produced, it shows at most once
// per submission, and dismissing it (X, scrim tap, Escape, or "Not now") is
// final. No native store-review prompt fires from this path either: that ask
// stays on its own moments (plan_built, job_hired), never on a review submit.
//
// The earlier SECOND follow-up, a "Share your pro" panel with an optional
// before/after photo share (CR4#2), was removed from this flow with that same
// owner ask. The proProfilePath, categoryLabel and photoUrl props stay in the
// type (accepted, unused) so page.tsx and its photo plumbing keep compiling
// untouched, and so a future share surface can pick them straight back up.
export default function ReviewButton({
  leadId,
  contractorName,
  action,
  existing,
}: {
  leadId: string;
  contractorName: string;
  action: (formData: FormData) => Promise<ActionResult>;
  existing?: { rating: number; comment: string | null } | null;
  // Retained for the call site (see the header comment): the removed pro-share
  // panel was the only consumer of these three, and dropping them from the
  // type would force churn in page.tsx for no behavior change.
  proProfilePath: string;
  categoryLabel: string;
  photoUrl?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(existing?.rating ?? 0);
  const [hover, setHover] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set on ANY fresh successful submit; arms the "Invite a neighbor" modal.
  // The code is fetched lazily once (getMyInviteCodeAction) - null means no
  // link could be made (feature not live, etc.), so the modal never shows.
  const [justSubmitted, setJustSubmitted] = useState(false);
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [inviteDismissed, setInviteDismissed] = useState(false);
  const [inviteShareState, setInviteShareState] = useState<
    "idle" | "copied" | "show-link"
  >("idle");
  const [inviteSharePending, setInviteSharePending] = useState(false);
  const inviteCardRef = useRef<HTMLDivElement>(null);
  const inviteHeadingId = useId();

  // The one condition the whole modal hangs off: armed by a successful submit,
  // real link in hand, not yet dismissed.
  const inviteOpen = justSubmitted && !!inviteCode && !inviteDismissed;

  // Lazily pull the homeowner's own invite code the moment the modal is armed,
  // so the link is ready synchronously when they tap Share (some browsers void
  // navigator.share if it isn't called straight from the user gesture). A null
  // result just leaves the modal hidden.
  useEffect(() => {
    if (!justSubmitted || inviteCode) return;
    let active = true;
    getMyInviteCodeAction()
      .then((code) => {
        if (active) setInviteCode(code);
      })
      .catch(() => {
        // Silent: no link, no modal. Never disturb the review flow.
      });
    return () => {
      active = false;
    };
  }, [justSubmitted, inviteCode]);

  // Escape closes, and body scroll is locked while the invite modal is open,
  // the same dialog manners as ProTrialNudge's takeover. Focus moves into the
  // card the moment it opens, so a keyboard or screen reader user lands on the
  // offer instead of wherever the page behind it happened to be.
  useEffect(() => {
    if (!inviteOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    inviteCardRef.current?.focus();
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setInviteDismissed(true);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [inviteOpen]);

  function inviteUrl(): string {
    const path = `/homeowner-signup?ref=${inviteCode}`;
    return typeof window !== "undefined"
      ? `${window.location.origin}${path}`
      : path;
  }

  async function handleInviteShare() {
    if (!inviteCode) return;
    setInviteSharePending(true);
    try {
      const url = inviteUrl();
      const shareData = {
        title: "Hearth",
        text: "I've been using Hearth to keep on top of my house. Thought you might find it handy for yours:",
        url,
      };
      if (typeof navigator !== "undefined" && navigator.share) {
        try {
          await navigator.share(shareData);
          // The share sheet actually went out: the modal's job is done, so it
          // closes rather than sitting behind the returning share sheet.
          setInviteDismissed(true);
          return;
        } catch (err) {
          // The user closing the share sheet is a decision, not a failure.
          // The modal stays up so they can copy the link or close it instead.
          if (err instanceof Error && err.name === "AbortError") return;
          // A real failure falls through to copying the link.
        }
      }
      try {
        await navigator.clipboard.writeText(url);
        setInviteShareState("copied");
        setTimeout(() => setInviteShareState("idle"), 2000);
      } catch {
        // Clipboard unavailable too (permissions, insecure origin): show the
        // link as selectable text so there is always SOME way to grab it.
        setInviteShareState("show-link");
      }
    } finally {
      setInviteSharePending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="btn-secondary text-sm"
      >
        {existing ? "Edit review" : "Leave a review"}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-pop dark:bg-stone-800">
            <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
              How was {contractorName}?
            </h2>
            <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
              Your rating helps other homeowners pick the right pro.
            </p>

            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setPending(true);
                setError(null);
                try {
                  const res = await action(new FormData(e.currentTarget));
                  if (res.ok) {
                    setOpen(false);
                    // Arm the neighbor-invite modal on every successful
                    // submit, whatever the rating: sharing Hearth with a
                    // neighbor isn't about the pro's stars.
                    setJustSubmitted(true);
                  } else {
                    setError(res.error);
                  }
                } catch {
                  // A rejected server action (network blip, server hiccup)
                  // must not strand the button in its pending state.
                  setError("Something went wrong. Please try again.");
                } finally {
                  setPending(false);
                }
              }}
              className="mt-4 space-y-4"
            >
              <input type="hidden" name="lead_id" value={leadId} />
              <input type="hidden" name="rating" value={rating} />

              <div className="flex justify-center gap-1">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onMouseEnter={() => setHover(n)}
                    onMouseLeave={() => setHover(0)}
                    onClick={() => setRating(n)}
                    aria-label={`${n} star${n > 1 ? "s" : ""}`}
                    // Phone only: five ~30px stars with no padding, and a
                    // mis-tap posts the wrong public rating.
                    className={`text-3xl leading-none transition max-sm:inline-flex max-sm:h-11 max-sm:min-w-11 max-sm:items-center max-sm:justify-center ${
                      (hover || rating) >= n ? "text-amber-400" : "text-stone-300 dark:text-stone-600"
                    }`}
                  >
                    ★
                  </button>
                ))}
              </div>

              <textarea
                name="comment"
                rows={3}
                maxLength={600}
                defaultValue={existing?.comment ?? ""}
                placeholder="Anything to add? (optional, up to 600 characters)"
                className="input w-full"
              />

              {error && (
                <p role="alert" className="text-sm font-medium text-red-600 dark:text-red-400">
                  {error}
                </p>
              )}

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="btn-secondary flex-1"
                  disabled={pending}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={rating === 0 || pending}
                  className="btn-primary flex-1 disabled:opacity-50"
                >
                  {pending ? "Saving…" : existing ? "Update" : "Submit"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {inviteOpen && (
        // Centered modal, not a corner toast: dark scrim over the whole page,
        // card in the middle. A tap that lands on the scrim itself closes it;
        // one that bubbles up from inside the card never does.
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setInviteDismissed(true);
          }}
        >
          <div
            ref={inviteCardRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={inviteHeadingId}
            tabIndex={-1}
            className="relative w-[92%] max-w-sm rounded-2xl bg-white p-6 shadow-pop outline-none dark:bg-stone-800"
          >
            <button
              type="button"
              onClick={() => setInviteDismissed(true)}
              aria-label="Close"
              className="absolute right-1 top-1 inline-flex h-11 w-11 items-center justify-center rounded-full text-stone-400 hover:text-stone-600 dark:text-stone-500 dark:hover:text-stone-300"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
            <h2
              id={inviteHeadingId}
              className="pr-10 text-lg font-semibold text-stone-900 dark:text-stone-100"
            >
              Know a neighbor who could use a hand with their place?
            </h2>
            <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
              Share your invite link.
            </p>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={handleInviteShare}
                disabled={inviteSharePending}
                className="btn-primary inline-flex min-h-11 flex-1 items-center justify-center gap-1.5"
              >
                {inviteSharePending && <InlineSpinner />}
                {inviteShareState === "copied" ? "Link copied" : "Share invite"}
              </button>
              <button
                type="button"
                onClick={() => setInviteDismissed(true)}
                className="btn-secondary min-h-11 flex-1"
              >
                Not now
              </button>
            </div>
            {inviteShareState === "show-link" && (
              <p className="mt-2 select-all break-all text-xs text-stone-500 dark:text-stone-400">
                {inviteUrl()}
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
