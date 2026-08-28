import { redirect } from "next/navigation";
import { getUserProfile } from "@/lib/user";
import { getPasswordStatus, getVerifiedUser, providerLabel } from "@/lib/auth";
import AccountSecurityPanel from "@/components/AccountSecurityPanel";
import AccountTabs from "../AccountTabs";
import {
  updateEmailAction,
  updatePasswordAction,
  signOutOthersAction,
  deleteAccountAction,
} from "../actions";

// The only home of account security for homeowners: email, password,
// sessions, data export, and deletion. Identity (name, phone) lives at
// /account, so nothing here is duplicated there. Rendered as the second tab
// of the Edit profile shell (see AccountTabs), but kept at its own URL so
// deep links and redirect("/account/security") calls still resolve.
export default async function AccountSecurityPage() {
  const profile = await getUserProfile();
  if (!profile) redirect("/signin");

  // The LIVE sign-in email, straight from the auth server - not the cookie-
  // cached getUser() and not the profile.email mirror. The delete action
  // (deleteAccountAction) compares the typed confirmation against this live
  // getUser() email, so the page has to print and enable the button on the
  // exact same address. After an email change on another device, a cached or
  // mirrored value would show the old address, the button would enable on it,
  // and the server would reject it forever (M7).
  // getVerifiedUser() IS that live auth-server read (it wraps the same
  // supabase.auth.getUser() call); the only difference is that React's cache()
  // makes this page, getPasswordStatus() below, and the layout's contractor
  // lookup share one verification instead of paying three.
  const user = await getVerifiedUser();
  const email = user?.email ?? null;

  // Read on every load, so the Password card shows the set-a-password flow to
  // a Google signup and the normal change-password form the moment they have
  // one.
  const { hasPassword, provider } = await getPasswordStatus();

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <AccountTabs active="security" />
      <AccountSecurityPanel
        email={email}
        hasPassword={hasPassword}
        providerName={providerLabel(provider)}
        updateEmailAction={updateEmailAction}
        updatePasswordAction={updatePasswordAction}
        signOutOthersAction={signOutOthersAction}
        deleteAccountAction={deleteAccountAction}
        privacyHref="/account/privacy"
      />
    </div>
  );
}
