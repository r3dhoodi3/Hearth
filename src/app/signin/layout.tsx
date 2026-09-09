import type { Metadata } from "next";

// The sign-in page is a client component ("use client" files can't export
// metadata), so the title/description live on this pass-through layout.
// The root layout's title template appends "| OakTend"; don't repeat it here.
export const metadata: Metadata = {
  title: "Sign in",
  description:
    "Sign in to OakTend. One sign-in for homeowners and contractors.",
};

export default function SignInLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
