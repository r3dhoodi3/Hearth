import { getUser } from "@/lib/auth";
import { getUserProfile } from "@/lib/user";
import FeedbackForm from "./FeedbackForm";

// Server half of the private feedback page. Its only job is to look up the
// signed-in account's email so the optional "email me back" field arrives
// prefilled instead of asking for something we already know. The form itself,
// with all its state, is FeedbackForm.
export default async function FeedbackPage() {
  const [profile, user] = await Promise.all([getUserProfile(), getUser()]);
  return <FeedbackForm defaultEmail={profile?.email || user?.email || ""} />;
}
