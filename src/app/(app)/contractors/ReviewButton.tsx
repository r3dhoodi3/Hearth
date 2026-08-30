"use client";

import { useEffect, useState } from "react";
import type { ActionResult } from "@/lib/actionResult";
import { getMyInviteCodeAction } from "./inviteActions";
import InlineSpinner from "@/components/InlineSpinner";

// "Leave a review" / "Edit review" button shown on a closed job's row. Opens a
// star + comment form that submits through the saveReviewAction server action
// (which routes to the leave_review RPC). Prefills when a review already exists.
//
// The form is submitted programmatically (not a plain <form action>) so the
// modal only closes, and the share follow-up only appears, once
// saveReviewAction actually returns ok(): a failed rating (bad RPC, network
// hiccup) keeps the modal open with the picked stars and typed comment
// intact, and shows the error inline instead of closing optimistically.
//
// After a fresh submit of 4 or 5 stars, a "Share your pro" follow-up appears
// underneath: word of mouth is how most homeowners find a pro, and the moment
// right after a good review is the highest-intent moment to ask. No reward is
// ever offered here (FTC-clean): just the pro's own public page.
//
// CR4#2: when the job had a before/after photo attached (photoUrl, resolved
// server-side in page.tsx from the lead's issue photos), that share tries a
// FILE share first - a picture beats a bare link here - falling back to the
// same link-only share the moment a browser can't accept files, or has no
// photo to offer at all.
//
// A SECOND follow-up appears after ANY successful submit (the peak-satisfaction
// moment): a "Invite a neighbor" panel with the homeowner's OWN Hearth invite
// link (their lazy referral code, migration 0099 - see inviteActions.ts). This
// one shares Hearth itself, not the pro, and is honest neighbor-to-neighbor
// sharing with no reward, credit, or wallet of any kind. It's fetched lazily
// so it only appears if a link can actually be produced, is dismissible, shows
// at most once per submission, and never blocks the review flow.
export default function ReviewButton({
  leadId,
  contractorName,
  action,
  existing,
  proProfilePath,
  categoryLabel,
  photoUrl,
}: {
  leadId: string;
  contractorName: string;
  action: (formData: FormData) => Promise<ActionResult>;
  existing?: { rating: number; comment: string | null } | null;
  // The pro's public page PATH (e.g. "/p/<id>"). The full URL is built here
  // on the client from window.location.origin, the same way PublicPageCard
  // does: a server-side env fallback could bake "localhost:3000" into a
  // production share sheet if the env var were ever unset.
  proProfilePath: string;
  categoryLabel: string;
  // The job's first attached photo (imgSrc()'d /api/img path), when it has
  // one. Undefined/null on every existing caller until it's threaded
  // through: the photo share is additive, never required.
  photoUrl?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(existing?.rating ?? 0);
  const [hover, setHover] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set on a fresh submit of >= 4 stars; drives the share follow-up below.
  // Component state only, cleared by "Not now": no table, no persistence.
  const [justRatedHigh, setJustRatedHigh] = useState(false);
  const [shareState, setShareState] = useState<"idle" | "copied" | "show-link">(
    "idle"
  );
  // Set on ANY fresh submit; drives the "Invite a neighbor" panel below. The
  // code is fetched lazily once (getMyInviteCodeAction) - null means no link
  // could be made (feature not live, etc.), so the panel simply never shows.
  const [justSubmitted, setJustSubmitted] = useState(false);
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [inviteDismissed, setInviteDismissed] = useState(false);
  const [inviteShareState, setInviteShareState] = useState<
    "idle" | "copied" | "show-link"
  >("idle");
  const [sharePending, setSharePending] = useState(false);
  const [inviteSharePending, setInviteSharePending] = useState(false);

  // Lazily pull the homeowner's own invite code the moment the panel is armed,
  // so the link is ready synchronously when they tap Share (some browsers void
  // navigator.share if it isn't called straight from the user gesture). A null
  // result just leaves the panel hidden.
  useEffect(() => {
    if (!justSubmitted || inviteCode) return;
    let active = true;
    getMyInviteCodeAction()
      .then((code) => {
        if (active) setInviteCode(code);
      })
      .catch(() => {
        // Silent: no link, no panel. Never disturb the review flow.
      });
    return () => {
      active = false;
    };
  }, [justSubmitted, inviteCode]);

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
          return;
        } catch (err) {
          // The user closing the share sheet is a decision, not a failure.
          if (err instanceof Error && err.name === "AbortError") return;
          // A real failure falls through to copying the link.
        }
      }
      try {
        await navigator.clipboard.writeText(url);
        setInviteShareState("copied");
        setTimeout(() => setInviteShareState("idle"), 2000);
      } catch {
        setInviteShareState("show-link");
      }
    } finally {
      setInviteSharePending(false);
    }
  }

  async function handleShare() {
    setSharePending(true);
    try {
      const url = `${window.location.origin}${proProfilePath}`;
      const text = `${contractorName} did great work. Here's their Hearth page:`;
      if (typeof navigator !== "undefined" && navigator.share) {
        // A photo was attached to this job: try sharing it as a FILE first,
        // since a before/after picture is the whole point (CR4#2). Gated on
        // navigator.canShare so a browser that would silently drop an
        // unsupported `files` field falls through to the link share below
        // instead of the share sheet quietly opening with no photo in it.
        if (photoUrl && typeof navigator.canShare === "function") {
          try {
            const res = await fetch(photoUrl);
            const blob = await res.blob();
            const file = new File([blob], "hearth-photo.jpg", {
              type: blob.type || "image/jpeg",
            });
            if (navigator.canShare({ files: [file] })) {
              await navigator.share({
                title: `${contractorName} on Hearth`,
                text,
                files: [file],
              });
              return;
            }
          } catch {
            // Fetching or attaching the photo failed (CORS, network, an
            // unsupported type) - fall through to the ordinary link share
            // rather than failing the whole share over a missing picture.
          }
        }
        try {
          await navigator.share({ title: `${contractorName} on Hearth`, text, url });
          return;
        } catch (err) {
          // The user closing the share sheet is a decision, not a failure:
          // do not copy the link behind their back.
          if (err instanceof Error && err.name === "AbortError") return;
          // A real failure falls through to copying the link.
        }
      }
      try {
        await navigator.clipboard.writeText(url);
        setShareState("copied");
        setTimeout(() => setShareState("idle"), 2000);
      } catch {
        // Clipboard unavailable too (permissions, insecure origin): show the
        // link as selectable text so there is always SOME way to grab it.
        setShareState("show-link");
      }
    } finally {
      setSharePending(false);
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
                    if (rating >= 4) setJustRatedHigh(true);
                    // Arm the neighbor-invite panel on every successful submit,
                    // not just high ratings: sharing Hearth with a neighbor
                    // isn't about the pro's rating.
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

      {justRatedHigh && (
        <div className="mt-2 w-full basis-full rounded-lg border border-stone-200 bg-stone-50 p-3 dark:border-white/10 dark:bg-stone-700">
          <p className="text-sm text-stone-700 dark:text-stone-300">
            Know a neighbor who needs a good {categoryLabel.toLowerCase()} pro?
            Share {contractorName}.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={handleShare}
              disabled={sharePending}
              className="btn-primary text-sm inline-flex items-center justify-center gap-1.5"
            >
              {sharePending && <InlineSpinner />}
              {shareState === "copied"
                ? "Link copied"
                : photoUrl
                ? "Share photo"
                : "Share"}
            </button>
            <button
              type="button"
              onClick={() => setJustRatedHigh(false)}
              className="btn-secondary text-sm"
            >
              Not now
            </button>
          </div>
          {shareState === "show-link" && (
            <p className="mt-2 select-all break-all text-xs text-stone-500 dark:text-stone-400">
              {typeof window !== "undefined"
                ? `${window.location.origin}${proProfilePath}`
                : proProfilePath}
            </p>
          )}
        </div>
      )}

      {justSubmitted && inviteCode && !inviteDismissed && (
        <div className="mt-2 w-full basis-full rounded-lg border border-stone-200 bg-stone-50 p-3 dark:border-white/10 dark:bg-stone-700">
          <p className="text-sm text-stone-700 dark:text-stone-300">
            Know a neighbor who could use a hand with their place? Share your
            invite link.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={handleInviteShare}
              disabled={inviteSharePending}
              className="btn-primary text-sm inline-flex items-center justify-center gap-1.5"
            >
              {inviteSharePending && <InlineSpinner />}
              {inviteShareState === "copied" ? "Link copied" : "Share invite"}
            </button>
            <button
              type="button"
              onClick={() => setInviteDismissed(true)}
              className="btn-secondary text-sm"
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
      )}
    </>
  );
}
