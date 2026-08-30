"use client";

import Link from "next/link";
import { track } from "@/lib/analytics";

// The "line up quotes early" link on the forecast's highest-risk systems.
//
// A plain <Link> with one job on top: fire forecast_quote_started before the
// navigation, so the funnel can tell a quote that started from planning ahead
// apart from one that started from something already broken. track() is
// sendBeacon-based and fire-and-forget, so it never delays or blocks the
// navigation (see src/lib/analytics.ts).
//
// props carry the system type only, which is a SYSTEM_TYPES enum value, never
// free text (docs/ANALYTICS.md).
export default function QuoteEarlyLink({
  href,
  systemType,
  className,
  children,
}: {
  href: string;
  systemType: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={className}
      onClick={() => track("forecast_quote_started", { system: systemType })}
    >
      {children}
    </Link>
  );
}
