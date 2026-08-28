import { redirect } from "next/navigation";
import { getUserProfile } from "@/lib/user";
import { FOUNDER } from "@/lib/constants";
import PrivacyRightsPanel from "@/components/PrivacyRightsPanel";

// The homeowner's view of the California privacy rights surface. All the copy
// lives in PrivacyRightsPanel, shared with /pro/privacy, so the two sides
// can't state different things about the same law.

export const metadata = {
  title: "Your privacy rights",
};

export default async function PrivacyRightsPage() {
  const profile = await getUserProfile();
  if (!profile) redirect("/signin");

  return (
    <PrivacyRightsPanel
      securityHref="/account/security"
      profileHref="/account"
      profileLabel="Edit profile"
      contact={FOUNDER.email}
      blocksHref="/account/blocks"
    />
  );
}
