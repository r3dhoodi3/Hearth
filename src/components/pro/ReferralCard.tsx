"use client";

import { useState } from "react";

// Refer-a-pro card for /pro/business. Free for every pro: shows this
// contractor's referral code and a copyable invite link, plus the rules in
// one honest sentence. The reward itself (both sides get $25 of application
// credit when the referred pro wins their first job) is granted by the daily
// referral-rewards cron via migration 0044, never here.
export default function ReferralCard({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const path = `/pros?ref=${encodeURIComponent(code)}`;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${path}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (permissions, old browser): the visible link
      // below can still be selected by hand.
    }
  }

  return (
    <section className="card space-y-3">
      <div>
        <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">Refer a pro</h2>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          Know a good contractor? When a pro you refer wins their first job on
          OakTend, you both get $25 of application credit, up to 10 referrals a
          year.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 font-mono text-sm text-stone-700 dark:border-white/10 dark:bg-stone-800 dark:text-stone-300">
          {code}
        </span>
        <span
          className="min-w-0 truncate text-xs text-stone-500 dark:text-stone-400"
          title={path}
        >
          {path}
        </span>
        <button
          type="button"
          onClick={copyLink}
          className="btn-secondary shrink-0 text-sm"
        >
          {copied ? "Copied!" : "Copy invite link"}
        </button>
      </div>
    </section>
  );
}
