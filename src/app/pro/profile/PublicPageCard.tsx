"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { Image as ImageIcon, PenLine, Contact, Star } from "lucide-react";
import InlineSpinner from "@/components/InlineSpinner";
import ProUpgradeCta from "@/components/pro/ProUpgradeCta";
import { savePublicPageAction, saveLicenseInsuranceAction } from "./actions";
import LogoUpload from "./LogoUpload";
import QrCodeCard from "./QrCodeCard";
import type { Contractor } from "@/lib/database.types";

// Generic submit button. useFormStatus only reports pending state inside a
// descendant of the <form> it belongs to, so each form renders its own.
function SaveButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  // Synchronous double-submit guard, same as src/components/SubmitButton.tsx:
  // `pending` is state and lands a render behind the click, so two clicks in
  // the same tick (a fast double tap) both still read `pending` as false and
  // both reach the native submit. This ref flips the instant the first click
  // happens, before React re-renders, so the second click can see it and stop
  // that submit before it starts.
  const submittedRef = useRef(false);

  useEffect(() => {
    // Release the latch once the action is no longer in flight, so a failed
    // submit can be retried with another click. Only the pending -> not-
    // pending edge resets it, never while still pending.
    if (!pending) submittedRef.current = false;
  }, [pending]);

  function handleClick(e: React.MouseEvent<HTMLButtonElement>) {
    if (submittedRef.current) {
      e.preventDefault();
      return;
    }
    // Only latch when a submit will actually start: a form that fails the
    // browser's own constraint validation never runs the action, so `pending`
    // never flips and the effect above would never release the latch.
    const form = e.currentTarget.form;
    if (form && !form.noValidate && !form.checkValidity()) return;
    submittedRef.current = true;
  }

  return (
    <button
      type="submit"
      disabled={pending}
      className="btn-primary"
      onClick={handleClick}
    >
      {pending && <InlineSpinner />}
      {label}
    </button>
  );
}

// "Your public page" manager. EVERY pro gets the shareable /p/<id> link AND the
// free license/insurance section that powers the "on file" trust badge (0109):
// trust signals are never pay-to-play. Pro members additionally get cosmetics:
// logo, about, and the share kit. Membership never changes the page's rating or
// reviews: those are the same for everyone.
export default function PublicPageCard({
  contractor,
  member,
  trialEligible,
}: {
  contractor: Contractor;
  member: boolean;
  // Whether the upgrade card at the bottom may lead with the free trial.
  // Decided on the server in page.tsx (no pro-side subscriptions row = a
  // first-time member), since only that side can tell a never-member from a
  // lapsed one, and a lapsed one will not get a second trial.
  trialEligible: boolean;
}) {
  // The new 0033 columns aren't in the generated types (database.types.ts is
  // not regenerated here), so read them off an any-cast view of the row.
  const extra = contractor as any;
  // One "Copied!" flag keyed by which button was clicked (link, caption,
  // widget), so the share kit rows don't need three separate states.
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  // Origin is only known in the browser; start with the bare path so the
  // server render and first client render match (no hydration mismatch).
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);

  const path = `/p/${contractor.id}`;
  const fullUrl = `${origin}${path}`;
  // Dynamic 1200x630 share card, generated at /p/<id>/opengraph-image (the
  // same image social networks pull when the link is posted).
  const shareCardUrl = `${path}/opengraph-image`;
  const caption = `${contractor.name} is on Hearth. Real reviews from real jobs: ${fullUrl}`;
  const widgetSnippet = `<iframe src="${origin}/api/pro-widget/${contractor.id}" width="320" height="120" style="border:0" title="Hearth rating"></iframe>`;
  const licenseLocked = Boolean(contractor.license_number);
  const hasVault = Boolean(
    (contractor.license_number && String(contractor.license_number).trim()) ||
      (extra.insurance_carrier && String(extra.insurance_carrier).trim())
  );

  async function copyText(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    } catch {
      // Clipboard can be unavailable (permissions, http). The visible text is
      // still selectable by hand.
    }
  }

  return (
    <div className="space-y-6">
      {/* Share link: every pro gets this, member or not. */}
      <section className="card space-y-3">
        <div>
          <h2 className="font-semibold text-stone-900 dark:text-stone-100">Share your page</h2>
          <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
            Anyone can open it, no account needed. It shows your business name,
            services, and your real Hearth reviews.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* On a phone the field is narrower than the URL, and truncating
              from the left spent every visible character on "https://hearth…"
              - the part that is the same for every pro. Below sm it shows the
              path instead, which is the half that identifies the page. The
              Copy button still copies the full URL, and sm and up still show
              it in full. */}
          <code className="min-w-0 flex-1 truncate rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-600 max-sm:basis-full max-sm:text-xs dark:border-white/10 dark:bg-stone-800 dark:text-stone-300">
            <span className="sm:hidden">{path}</span>
            <span className="max-sm:hidden">{fullUrl}</span>
          </code>
          <button
            type="button"
            onClick={() => copyText("link", fullUrl)}
            className="btn-secondary px-3"
          >
            {copiedKey === "link" ? "Copied!" : "Copy link"}
          </button>
          <a
            href={path}
            target="_blank"
            rel="noreferrer"
            className="btn-primary px-3"
          >
            View page
          </a>
        </div>

        {/* QR code: free for every pro (only renders once origin is known). */}
        <QrCodeCard
          url={origin ? fullUrl : ""}
          businessName={contractor.name}
        />
      </section>

      {/* License and insurance: FREE for every pro (0109). These feed the
          public "on file" trust badge, which is a safety fact, not a paid perk,
          so this section is never membership-gated. The details themselves stay
          private; the page only ever shows a badge. */}
      <form action={saveLicenseInsuranceAction} className="card space-y-4">
        <div>
          <h2 className="font-semibold text-stone-900 dark:text-stone-100">
            License and insurance
          </h2>
          <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
            Add these so your public page can show a &quot;license and insurance
            on file&quot; badge. Free for every pro. Kept private: the page shows
            only the badge, worded as provided by you, not verified by Hearth.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label">License number</label>
            {licenseLocked ? (
              <>
                <div className="input cursor-not-allowed select-none bg-stone-100 text-stone-500 dark:bg-stone-700 dark:text-stone-400">
                  {contractor.license_number}
                </div>
                <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                  Locked once set. Contact support to update it.
                </p>
              </>
            ) : (
              <input
                name="license_number"
                className="input"
                placeholder="LIC-000000-XX"
              />
            )}
          </div>
          <div>
            <label className="label">License state</label>
            <input
              name="license_state"
              className="input uppercase"
              maxLength={2}
              defaultValue={extra.license_state ?? ""}
              placeholder="CA"
            />
          </div>
          <div>
            <label className="label">Insurance carrier</label>
            <input
              name="insurance_carrier"
              className="input"
              maxLength={120}
              defaultValue={extra.insurance_carrier ?? ""}
              placeholder="e.g. State Farm"
            />
          </div>
          <div>
            <label className="label">Insurance expires</label>
            <input
              name="insurance_expires"
              type="date"
              className="input"
              defaultValue={extra.insurance_expires ?? ""}
            />
          </div>
        </div>

        {hasVault && (
          <p className="text-xs text-green-700 dark:text-green-400">
            Your page shows the &quot;on file&quot; badge for what you&apos;ve
            saved.
          </p>
        )}

        <div className="flex justify-end border-t border-stone-100 pt-4 dark:border-white/10">
          <SaveButton label="Save license and insurance" />
        </div>
      </form>

      {/* Share kit: member-only extras for spreading the page around. Free
          pros see these teased in the upsell card below, same as the other
          member perks. Nothing in the kit changes rating math or ordering:
          it only repackages the page and its true aggregate numbers. */}
      {member && (
        <section className="card space-y-4">
          <div>
            <h2 className="font-semibold text-stone-900 dark:text-stone-100">
              Share kit{" "}
              <span className="ml-1 rounded-full border border-hearth-200 bg-hearth-50 px-2 py-0.5 text-xs font-medium text-hearth-700 dark:border-hearth-800 dark:bg-hearth-900/40 dark:text-hearth-300">
                Pro member
              </span>
            </h2>
            <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
              Ready-made pieces for social posts and your own website. They
              always show your real Hearth numbers.
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-stone-100 pt-4 dark:border-white/10">
            <div className="min-w-0">
              <p className="text-sm font-medium text-stone-900 dark:text-stone-100">
                Share card image
              </p>
              <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
                A 1200x630 image of your page, sized for social posts. Pair it
                with the caption.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <a
                href={shareCardUrl}
                target="_blank"
                rel="noreferrer"
                className="btn-secondary text-xs px-3 py-1.5"
              >
                Download share card
              </a>
              <button
                type="button"
                onClick={() => copyText("caption", caption)}
                className="btn-secondary text-xs px-3 py-1.5"
              >
                {copiedKey === "caption" ? "Copied!" : "Copy caption"}
              </button>
            </div>
          </div>

          <div className="border-t border-stone-100 pt-4 dark:border-white/10">
            <p className="text-sm font-medium text-stone-900 dark:text-stone-100">
              Rating widget for your website
            </p>
            <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
              Paste this into your site. It shows your full Hearth rating and
              review count, exactly as they appear here.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-stone-600 dark:border-white/10 dark:bg-stone-800 dark:text-stone-300">
                {widgetSnippet}
              </code>
              <button
                type="button"
                onClick={() => copyText("widget", widgetSnippet)}
                className="btn-secondary text-xs px-3 py-1.5"
              >
                {copiedKey === "widget" ? "Copied!" : "Copy embed code"}
              </button>
            </div>
          </div>
        </section>
      )}

      {member ? (
        <form action={savePublicPageAction} className="card space-y-5">
          <div>
            <h2 className="font-semibold text-stone-900 dark:text-stone-100">
              Page extras{" "}
              <span className="ml-1 rounded-full border border-hearth-200 bg-hearth-50 px-2 py-0.5 text-xs font-medium text-hearth-700 dark:border-hearth-800 dark:bg-hearth-900/40 dark:text-hearth-300">
                Pro member
              </span>
            </h2>
            <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
              Your logo and about section appear on your public page.
            </p>
          </div>

          <LogoUpload
            contractorId={contractor.id}
            initialUrl={extra.logo_url ?? null}
          />

          <div>
            <label className="label">About your business</label>
            <textarea
              name="about"
              rows={5}
              maxLength={1000}
              defaultValue={extra.about ?? ""}
              placeholder="What you do, how long you've been at it, and what customers can expect."
              className="input h-auto"
            />
            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
              Up to 1,000 characters.
            </p>
          </div>

          <div className="flex justify-end border-t border-stone-100 pt-4 dark:border-white/10">
            <SaveButton label="Save page extras" />
          </div>
        </form>
      ) : (
        <section className="card space-y-3">
          <h2 className="font-semibold text-stone-900 dark:text-stone-100">
            Make it yours with Hearth Pro
          </h2>
          <p className="text-sm text-stone-500 dark:text-stone-400">
            Your basic page is live for every pro, license and insurance badge
            included. Members can dress it up:
          </p>
          <ul className="space-y-1.5 text-sm text-stone-600 dark:text-stone-300">
            <li className="flex items-start gap-2">
              <ImageIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>Your logo at the top of the page</span>
            </li>
            <li className="flex items-start gap-2">
              <PenLine className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>An about section in your own words</span>
            </li>
            <li className="flex items-start gap-2">
              <Contact className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>A share card image and ready-to-post caption for social media</span>
            </li>
            <li className="flex items-start gap-2">
              <Star className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                An embeddable rating widget for your own website, showing your
                full Hearth rating and review count
              </span>
            </li>
          </ul>
          <p className="text-xs text-stone-500 dark:text-stone-400">
            Membership never changes your rating or reviews: those are real
            for everyone.
          </p>
          <ProUpgradeCta trialEligible={trialEligible} />
        </section>
      )}
    </div>
  );
}
