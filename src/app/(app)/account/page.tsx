import { redirect } from "next/navigation";
import { getUserProfile } from "@/lib/user";
import { getUser } from "@/lib/auth";
import { getOrCreateReferralCode } from "@/lib/referralCode";
import ProfileInfoForm from "./ProfileInfoForm";
import AccountTabs from "./AccountTabs";
import InviteNeighbor from "./InviteNeighbor";
import Breadcrumbs from "@/components/Breadcrumbs";

// Edit profile: identity only (name, phone). Everything security-shaped -
// email, password, sessions, deletion - still lives at /account/security, now
// presented as a sibling tab of Edit profile (see AccountTabs), so each
// setting exists in exactly one place.
export default async function AccountPage() {
  // Three independent reads, issued together instead of one after the other.
  // Nothing here feeds anything else here: the profile row, the auth user, and
  // the invite code are separate lookups that only meet in the JSX below.
  //
  // The redirect guard now runs after all three are in flight rather than in
  // front of them. That is deliberate and safe: getOrCreateReferralCode()
  // resolves to null for a caller with no session, and its generate step is
  // guarded by an UPDATE against the user's own row, so a visitor who is about
  // to be bounced to /signin cannot cause a write.
  const [profile, user, inviteCode] = await Promise.all([
    getUserProfile(),
    // Mirror the toolbar's name resolution so the field shows the same value.
    getUser(),
    // Lazily produce this homeowner's invite link. Null (feature not live on
    // this DB yet, or an unusual failure) just hides the invite card - it never
    // affects the rest of the account page.
    getOrCreateReferralCode(),
  ]);
  if (!profile) redirect("/signin");

  const metaName = (user?.user_metadata?.full_name as string | undefined)?.trim();
  const name = profile.full_name || metaName || "";

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Breadcrumbs items={[{ label: "Home", href: "/dashboard" }, { label: "Account" }]} />
      <AccountTabs active="profile" />
      <ProfileInfoForm profile={profile} name={name} />
      {inviteCode && <InviteNeighbor code={inviteCode} />}
    </div>
  );
}
