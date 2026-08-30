import { redirect } from "next/navigation";
import { getUserProfile } from "@/lib/user";
import { FOUNDER } from "@/lib/constants";
import PrivacyRightsPanel from "@/components/PrivacyRightsPanel";
import Breadcrumbs from "@/components/Breadcrumbs";

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
    // PrivacyRightsPanel is shared with /pro/privacy and owns its own
    // max-w-2xl wrapper, so the breadcrumb is added here at the page level
    // (not inside the shared component) so the pro side doesn't inherit it.
    <>
      <div className="mx-auto max-w-2xl">
        <Breadcrumbs
          items={[
            { label: "Home", href: "/dashboard" },
            { label: "Account", href: "/account" },
            { label: "Your privacy rights" },
          ]}
        />
      </div>
      <PrivacyRightsPanel
        securityHref="/account/security"
        profileHref="/account"
        profileLabel="Edit profile"
        contact={FOUNDER.email}
        blocksHref="/account/blocks"
      />
    </>
  );
}
