"use client";

import { useState } from "react";
import Link from "next/link";
import AiNotice from "@/components/AiNotice";
import ProgressBar, { useStagedProgress } from "@/components/ProgressBar";
import { fetchWithTimeout, isTimeoutError } from "@/lib/fetchWithTimeout";

// The honest steps /api/tax-appeal works through: gather the home's facts, then
// draft the respectful, factual appeal letter from them.
const APPEAL_STAGES = ["Gathering your home's facts", "Drafting the letter"];

// The "give me a head start" button on the "looks high" state. Plus members
// get an AI-drafted appeal letter they can adapt and file themselves; free
// users see what they'd get and a path to Plus. The letter is rendered in a
// copyable block because the whole point is taking it OUT of Hearth and into
// the county's appeal form or mailbox.
export default function AppealLetter({ isPlus }: { isPlus: boolean }) {
  const [loading, setLoading] = useState(false);
  const [letter, setLetter] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const progress = useStagedProgress(APPEAL_STAGES, 16000);

  if (!isPlus) {
    return (
      <div className="card space-y-3">
        <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100">
          Want a head start on an appeal?
        </h2>
        <p className="text-sm text-stone-600 dark:text-stone-300">
          Hearth Plus can draft a respectful appeal letter using your
          home&apos;s facts. Review it, fill in your parcel number, and file it
          with your county. You stay in control, Hearth never files anything
          for you.
        </p>
        <Link href="/plus?reason=tax" className="btn-primary inline-block">
          Unlock with Hearth Plus
        </Link>
      </div>
    );
  }

  const generate = async () => {
    setLoading(true);
    setError(null);
    setCopied(false);
    progress.start();
    try {
      // Timeout-guarded: a hung serverless call must not strand the button
      // on "Drafting your letter..." with no way to retry.
      const resp = await fetchWithTimeout("/api/tax-appeal", { method: "POST" });
      const data = await resp.json().catch(() => ({}));
      if (typeof data?.letter === "string" && data.letter) {
        setLetter(data.letter);
      } else if (data?.error === "plus_required") {
        setError("An active Hearth Plus subscription is needed to draft the letter.");
      } else if (data?.reason === "rate_limited") {
        setError("Hearth has hit today's usage limit. Please try again later.");
      } else if (data?.reason === "no_key") {
        setError("The letter drafter isn't set up yet.");
      } else {
        setError(data?.error || "Couldn't draft the letter right now. Please try again in a bit.");
      }
    } catch (e) {
      setError(
        isTimeoutError(e)
          ? "That took too long. Try again."
          : "Couldn't draft the letter right now. Please try again in a bit."
      );
    }
    progress.finish();
    setLoading(false);
  };

  const copy = async () => {
    if (!letter) return;
    try {
      await navigator.clipboard.writeText(letter);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (permissions, http): the textarea below is still
      // selectable, so the owner can copy by hand.
    }
  };

  return (
    <div className="card space-y-3">
      <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100">
        Draft an appeal letter
      </h2>
      <p className="text-sm text-stone-600 dark:text-stone-300">
        Hearth drafts a respectful, factual letter using your home&apos;s
        details. Fill in the placeholders, like your parcel number, and file it
        with your county. Every county has its own form and deadline, check
        your assessment notice for the exact steps.
      </p>

      {!letter && (
        <button
          className="btn-primary"
          onClick={generate}
          disabled={loading}
        >
          {loading ? "Drafting your letter..." : "Draft my appeal letter"}
        </button>
      )}

      {loading && (
        <ProgressBar
          value={progress.value}
          stages={APPEAL_STAGES}
          stageIndex={progress.stageIndex}
          ariaLabel="Drafting your appeal letter"
        />
      )}

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {letter && (
        <div className="space-y-2">
          <textarea
            readOnly
            value={letter}
            rows={16}
            className="input w-full font-mono text-xs leading-relaxed"
          />
          <div className="flex gap-3">
            <button className="btn-primary" onClick={copy}>
              {copied ? "Copied" : "Copy letter"}
            </button>
            <button
              className="btn-secondary"
              onClick={generate}
              disabled={loading}
            >
              {loading ? "Drafting..." : "Draft again"}
            </button>
          </div>
          <AiNotice detail="It is a starting point, not legal or tax advice: correct anything that doesn't match your situation and add the details only you have before you send it. Appeals are not guaranteed to succeed." />
        </div>
      )}
    </div>
  );
}
