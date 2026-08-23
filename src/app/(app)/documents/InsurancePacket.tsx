"use client";

import { useState } from "react";
import Link from "next/link";
import AiNotice from "@/components/AiNotice";
import ProgressBar, { useStagedProgress } from "@/components/ProgressBar";
import { fetchWithTimeout, isTimeoutError } from "@/lib/fetchWithTimeout";

// The honest steps /api/insurance-packet works through: gather the home's saved
// facts and upkeep, write them into a plain-language summary, then add the
// coverage questions worth asking an agent.
const PACKET_STAGES = [
  "Gathering your home's facts",
  "Writing your packet",
  "Adding questions to ask",
];

// The "give me a head start on shopping" button on the Home insurance card.
// Plus members get an AI-built requote packet: a plain-language summary of
// the home's facts and recent upkeep they can hand to insurance agents when
// shopping for quotes. Free users see what they'd get and a path to Plus.
// Rendered in a copyable block because the whole point is taking it OUT of
// Hearth and into an email or a call with an agent. Mirrors AppealLetter on
// /taxes.
export default function InsurancePacket({
  isPlus,
  daysToRenewal,
}: {
  isPlus: boolean;
  // Whole days until the home's saved policy renewal date, or null when no
  // real renewal date is on file. Only a REAL date earns the deadline framing
  // below - an invented urgency is the exact thing that copy must not be.
  daysToRenewal?: number | null;
}) {
  const [loading, setLoading] = useState(false);
  const [packet, setPacket] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const progress = useStagedProgress(PACKET_STAGES, 16000);

  if (!isPlus) {
    // Loss framing ONLY when the loss is real: a policy with a known renewal
    // date still ahead of it is a shopping window that closes on a specific
    // day. With no date on file, or one already past, there is no deadline to
    // name, so the card keeps its plain pitch.
    const renewalSoon =
      typeof daysToRenewal === "number" && daysToRenewal > 0
        ? daysToRenewal
        : null;
    return (
      <div className="card space-y-3">
        <h3 className="text-sm font-semibold text-stone-900 dark:text-stone-100">
          Want a head start on requoting?
        </h3>
        {renewalSoon !== null && (
          <p className="text-sm font-medium text-bark-700 dark:text-stone-300">
            Your policy renews in {renewalSoon} day
            {renewalSoon === 1 ? "" : "s"} - Plus builds your requote packet
            while there&apos;s still time to shop.
          </p>
        )}
        <p className="text-sm text-stone-600 dark:text-stone-300">
          Hearth Plus can build a requote packet from your home&apos;s facts:
          the details agents always ask for, your recent maintenance and
          upgrades, and the questions worth asking beyond price. You stay in
          control: Hearth never contacts insurers for you.
        </p>
        <Link href="/plus?reason=insurance" className="btn-primary inline-block">
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
      // on "Building your packet..." with no way to retry.
      const resp = await fetchWithTimeout("/api/insurance-packet", {
        method: "POST",
      });
      const data = await resp.json().catch(() => ({}));
      if (typeof data?.packet === "string" && data.packet) {
        setPacket(data.packet);
      } else if (data?.error === "plus_required") {
        setError(
          "An active Hearth Plus subscription is needed to build the packet."
        );
      } else if (data?.reason === "rate_limited") {
        setError("Hearth has hit today's usage limit. Please try again later.");
      } else if (data?.reason === "no_key") {
        setError("The packet builder isn't set up yet.");
      } else {
        setError(
          data?.error ||
            "Couldn't build the packet right now. Please try again in a bit."
        );
      }
    } catch (e) {
      setError(
        isTimeoutError(e)
          ? "That took too long. Try again."
          : "Couldn't build the packet right now. Please try again in a bit."
      );
    }
    progress.finish();
    setLoading(false);
  };

  const copy = async () => {
    if (!packet) return;
    try {
      await navigator.clipboard.writeText(packet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (permissions, http): the textarea below is still
      // selectable, so the owner can copy by hand.
    }
  };

  return (
    <div className="card space-y-3">
      <h3 className="text-sm font-semibold text-stone-900 dark:text-stone-100">
        Build my requote packet
      </h3>
      <p className="text-sm text-stone-600 dark:text-stone-300">
        Hearth will put your home&apos;s facts and recent upkeep into one
        plain-language summary you can hand to insurance agents when you shop
        for quotes, plus the coverage questions worth asking. Review it and
        fill in anything only you know, like your current coverage limits.
      </p>

      {!packet && (
        <button className="btn-primary" onClick={generate} disabled={loading}>
          {loading ? "Building your packet..." : "Build my requote packet"}
        </button>
      )}

      {loading && (
        <ProgressBar
          value={progress.value}
          stages={PACKET_STAGES}
          stageIndex={progress.stageIndex}
          ariaLabel="Building your requote packet"
        />
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      {packet && (
        <div className="space-y-2">
          <textarea
            readOnly
            value={packet}
            rows={16}
            className="input w-full font-mono text-xs leading-relaxed"
          />
          <div className="flex gap-3">
            <button className="btn-primary" onClick={copy}>
              {copied ? "Copied" : "Copy packet"}
            </button>
            <button
              className="btn-secondary"
              onClick={generate}
              disabled={loading}
            >
              {loading ? "Building..." : "Build again"}
            </button>
          </div>
          <AiNotice detail="It is a starting point, not insurance advice, and requoting is never guaranteed to save money: correct anything that doesn't match your home and add the details only you have before you share it." />
        </div>
      )}
    </div>
  );
}
