import { redirect } from "next/navigation";
import {
  getActiveProperty,
  getProperties,
  homesForSwitcher,
} from "@/lib/property";
import {
  getCurrentContractor,
  landingFor,
  preferredRole,
} from "@/lib/contractor";
import { getUserProfile } from "@/lib/user";
import { getUser } from "@/lib/auth";
import { hasPlus } from "@/lib/subscription";
import Nav from "@/components/Nav";
import NewMessageNotifier from "@/components/NewMessageNotifier";
import ReviewPrompt from "@/components/ReviewPrompt";
import AppGuideMount from "@/components/AppGuideMount";

// Shell for all signed-in homeowner screens. The only rule is that a claimed
// home exists.
//
// No role check: an account can hold both sides at once (a pro who also owns a
// home), so user_metadata.role is only the side they LAND on, never a fence
// around this one. Bouncing every "contractor" to /pro is what made the pro
// who owns a home unable to reach his own dashboard at all.
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [active, homes, profile, user, plus, contractor] = await Promise.all([
    getActiveProperty(),
    getProperties(),
    getUserProfile(),
    getUser(),
    hasPlus(),
    // Only to decide what the profile menu offers ("Switch to Hearth Pro" vs
    // "Set up your business"). Cached per request, so a page that already
    // asked for the company row pays nothing extra.
    getCurrentContractor(),
  ]);
  if (!active) {
    // No claimed home. Sending EVERYONE here to the claim-a-home wizard is
    // right for a homeowner and wrong for a pro who signed up through
    // /contractor-signup and never finished company setup: with no contractors
    // row yet, the signup-side stamp is the only thing that says which side
    // they are on, and /dashboard silently deciding "homeowner" is how a
    // contractor ended up being asked to claim a house.
    //
    // A ROW still outranks the stamp, exactly as everywhere else:
    //   - a contractors row means they came here on purpose (ProNav's "Add
    //     your home" points at /dashboard), so the wizard is the right answer
    //     and nothing changes for them;
    //   - homes that exist but resolved to no active one is a homeowner with a
    //     data problem, not a side question, and /onboarding is still where
    //     that lands today.
    // Only the neither-row case is routed by the stamp, through the same
    // landingFor() every other signed-in landing uses - contractor to
    // /pro/onboarding, homeowner to /onboarding, no answer at all to the role
    // picker rather than a guess.
    if (contractor || homes.length > 0) redirect("/onboarding");
    redirect(
      landingFor({
        hasPro: false,
        hasHome: false,
        preferred: preferredRole(
          user?.user_metadata?.role ?? user?.app_metadata?.role
        ),
      })
    );
  }

  // Prefer the name from auth metadata (set at sign-up, always present) and fall
  // back to the profile row, then email.
  const metaName = (user?.user_metadata?.full_name as string | undefined)?.trim();
  const name = metaName || profile?.full_name || profile?.email || null;

  return (
    <div className="min-h-screen">
      {/* homesForSwitcher labels each home with its unit (migration 0127)
          so two condos in the same building are told apart in the
          switcher. The real address_line1 is untouched on the rows every
          address lookup reads. */}
      <Nav
        homes={homesForSwitcher(homes)}
        activeId={active.id}
        name={name}
        hasPlus={plus}
        hasPro={contractor !== null}
      />
      {/* Extra bottom padding below lg keeps content clear of the fixed bottom
          tab bar. It was sm:pb-8; the tab bar now runs to lg (Nav.tsx: the top
          strip collided with the wordmark between 640 and 1023px), so the
          padding has to reach the same width or tablets get content under the
          bar. Desktop at lg and up keeps exactly today's pb-8. */}
      <main className="mx-auto max-w-5xl px-6 pb-24 pt-8 lg:pb-8">
        {children}
      </main>
      {/* The floating Ask Hearth dock used to mount here, on every signed-in
          screen. It is gone on purpose: Messages is now the one place the
          assistant lives (the pinned Ask Hearth row at the top of /chats, and
          /ask behind it), so a pill floating over every other page was a
          second door to the same room. Its proactive opener is computed by
          /ask and /chats themselves, where it is actually read. */}
      <NewMessageNotifier role="homeowner" />
      <ReviewPrompt />
      {/* First sign-in only: four cards explaining what the app does, now that
          the phone landing page no longer explains anything. Safe to mount
          unconditionally here - the redirect above means a claimed home always
          exists by this point, and the component renders null once the account
          has been through it (or is on a page it must not cover, like
          /plus or /emergency). See src/lib/appGuide.ts. */}
      <AppGuideMount side="homeowner" />
    </div>
  );
}
