import Link from "next/link";
import { LEGAL } from "@/lib/legal";

// Cal. Bus. & Prof. Code 17538: the legal name and address of who is charging
// the buyer, plus a route to the refund policy, shown before purchase. One
// line, reused verbatim everywhere a subscription or a per-lead fee is about
// to be charged: the homeowner Plus and Hearth Pro pricing/plan pages, inside
// each checkout block itself, and the pro per-lead "Confirm and pay" card
// (src/app/pro/ApplyJobButton.tsx).
//
// LEGAL.legalName and LEGAL.address render their bracketed
// "[TODO(legal): ...]" placeholder text until the owner sets the
// corresponding env vars - see src/lib/legal.ts. That is the intended safety
// net, not a bug: it makes the gap visible everywhere this line appears
// instead of silently shipping a blank.
export default function BillingLegalLine({
  className = "text-xs text-stone-500 max-sm:text-sm dark:text-stone-400",
}: {
  className?: string;
}) {
  return (
    <p className={className}>
      {LEGAL.legalName}, {LEGAL.address}. See our{" "}
      <Link href="/billing" className="underline hover:text-stone-700 dark:hover:text-stone-300">
        Billing and Refund Policy
      </Link>
      .
    </p>
  );
}
