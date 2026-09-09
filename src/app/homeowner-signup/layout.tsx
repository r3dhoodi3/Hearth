import type { Metadata } from "next";

// The sign-up page is a client component ("use client" files can't export
// metadata), so the title/description live on this pass-through layout.
// The root layout's title template appends "| OakTend"; don't repeat it here.
export const metadata: Metadata = {
  title: "Create your account",
  description:
    "Create a free OakTend account to keep your house in good shape, store your home docs, and reach a pro when something breaks.",
};

export default function HomeownerSignUpLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
