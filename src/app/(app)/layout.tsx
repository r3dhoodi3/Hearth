import { redirect } from "next/navigation";
import {
  getActiveProperty,
  getProperties,
  homesForSwitcher,
} from "@/lib/property";
import { getCurrentContractor } from "@/lib/contractor";
import { getUserProfile } from "@/lib/user";
import { getUser } from "@/lib/auth";
import { hasPlus } from "@/lib/subscription";
import Nav from "@/components/Nav";
import NewMessageNotifier from "@/components/NewMessageNotifier";
import AskHearthDock from "@/components/AskHearthDock";
import ReviewPrompt from "@/components/ReviewPrompt";

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
  if (!active) redirect("/onboarding");

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
      {/* Extra bottom padding on phones keeps content clear of the fixed
          Ask Hearth dock. */}
      <main className="mx-auto max-w-5xl px-6 pb-24 pt-8 sm:pb-8">
        {children}
      </main>
      {/* A personalized opener so Ask Hearth speaks first about the home's top
          item. The layout no longer computes it: getProactiveGreeting() costs
          three DB queries (issues, home_systems, maintenance_tasks, two of
          which the Home page reads again for itself), and it was paying them
          on EVERY signed-in page view to produce a string that is only ever
          read if someone opens the dock. Suspense kept it off the critical
          path for first byte, but the queries still ran every time.
          The dock now fetches it from /api/ask-greeting on first open, and
          prefetches on hover, so a page view that never touches Ask Hearth
          costs nothing at all. */}
      <AskHearthDock greetingUrl="/api/ask-greeting" hideOnPhone />
      <NewMessageNotifier role="homeowner" />
      <ReviewPrompt />
    </div>
  );
}
