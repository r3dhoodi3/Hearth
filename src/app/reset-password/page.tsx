import type { Metadata } from "next";
import ResetPasswordForm from "./ResetPasswordForm";

// Server wrapper so the route can export metadata; the form itself is a
// client component. Two steps in one route:
//   /reset-password              → ask for an email, send the recovery link
//   /reset-password?step=update  → back from the emailed link (via
//                                  /auth/callback, which exchanges the code
//                                  for a recovery session) → set a new
//                                  password.
export const metadata: Metadata = {
  // The root layout's title template appends "| Hearth"; don't repeat it here.
  title: "Reset your password",
  description:
    "Forgot your Hearth password? Enter your email and we'll send you a link to set a new one.",
};

export default async function ResetPasswordPage(
  props: {
    searchParams?: Promise<{ step?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  return (
    <ResetPasswordForm
      step={searchParams?.step === "update" ? "update" : "request"}
    />
  );
}
