import { getUserProfile } from "@/lib/user";
import AppGuide from "./AppGuide";
import type { GuideSide } from "@/lib/appGuide";

// Server half of the first-run guide: decides whether this account still has
// it coming, then hands one boolean to the client component.
//
// ONBOARDING IS THE MOUNT POINT, not a check in here. This renders in exactly
// two places, and both already refuse to render at all until setup is done:
// src/app/(app)/layout.tsx redirects anyone with no claimed home to
// /onboarding before its children exist, and src/app/pro/layout.tsx only
// reaches its full shell once a contractors row is there. So "reached this
// component" already means "finished onboarding" on either side.
//
// A missing profile row, or a read that throws (migration 0137 not applied to
// the live database yet), lands on startOpen=true, and the localStorage mirror
// inside AppGuide takes over from there: the guide then behaves as
// once-per-browser instead of once-per-account, which is a good deal better
// than the feature simply not existing until the SQL is pasted.
export default async function AppGuideMount({ side }: { side: GuideSide }) {
  let seen = false;
  try {
    const profile = await getUserProfile();
    seen =
      side === "pro"
        ? Boolean(profile?.pro_guide_seen_at)
        : Boolean(profile?.guide_seen_at);
  } catch (err) {
    console.error("AppGuideMount could not read the guide stamp:", err);
  }

  return <AppGuide side={side} startOpen={!seen} />;
}
