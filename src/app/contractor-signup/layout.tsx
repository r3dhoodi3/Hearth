import type { Metadata } from "next";

// The sign-up page is a client component ("use client" files can't export
// metadata), so the title/description live on this pass-through layout.
// `absolute` opts out of the root layout's "%s | OakTend" template, which
// would otherwise double-brand this to "... | OakTend for Pros | OakTend".
export const metadata: Metadata = {
  title: { absolute: "Create your pro account | OakTend for Pros" },
  description:
    "Pay per lead you choose, not per month. Ghost protection, capped competition, and the price on every job card.",
};

export default function ContractorSignUpLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
