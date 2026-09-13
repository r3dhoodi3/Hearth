"use client";

import ReferralCard from "@/components/pro/ReferralCard";

// Account: the pro's referral card, in one collapsed-by-default panel so
// /pro/business doesn't stack another full section below Insights.
//
// It used to hold the license/insurance compliance calendar too, and a header
// alert when a document was expiring. Both moved: credentials now live on the
// Credentials tab of /pro/profile (one place for the number and the two
// documents), and the Home tab already shows the renewal countdown chips, so
// the header alert here was a third copy of a fact nothing on this page could
// act on any more.
export default function AccountPanel({
  referralCode,
}: {
  referralCode: string;
}) {
  return (
    <details id="account" className="group space-y-4">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-2 text-lg font-semibold text-stone-900 marker:text-stone-500 [&::-webkit-details-marker]:hidden dark:text-stone-100 dark:marker:text-stone-400">
        <span className="inline-block transition-transform group-open:rotate-90">
          ▸
        </span>
        Account
      </summary>

      <div className="space-y-4">
        <ReferralCard code={referralCode} />
      </div>
    </details>
  );
}
