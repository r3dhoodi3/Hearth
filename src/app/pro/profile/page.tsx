import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  getCurrentContractor,
  countPaidLeadApplications,
} from "@/lib/contractor";
import { getPasswordStatus, providerLabel } from "@/lib/auth";
import { hasProPlan, getProSubscription } from "@/lib/subscription";
import { isCheckrConfigured } from "@/lib/checkr";
import ProfileTabs from "./ProfileTabs";
import type { ProProject, ProProjectPhoto } from "./ProjectsCard";
import Breadcrumbs from "@/components/Breadcrumbs";

export default async function ProProfilePage() {
  const contractor = await getCurrentContractor();
  if (!contractor) redirect("/pro/onboarding");

  // Membership only decides which public-page extras (logo, about, badge) can
  // be edited, plus the project limits. It never touches leads, ratings, or
  // reviews.
  const member = await hasProPlan();

  // Whether the upgrade prompts on the Projects and Public Page tabs may lead
  // with the free trial. Only a pro with no pro-side subscriptions row will
  // actually get one (the row survives a cancellation), so this is resolved on
  // the server and passed down: the tab cards are client components and must
  // not guess. Free to ask for, hasProPlan() read the same cached rows.
  const trialEligible = !member && !(await getProSubscription());

  // The pro's project portfolio (0045) with photos, for the Projects tab.
  // Cast: the 0045 tables aren't in the generated types (database.types.ts is
  // not regenerated here). Degrades to an empty list if the migration hasn't
  // run yet.
  const supabase = await createClient();
  const { data: projectRows } = await (supabase.from as any)("pro_projects")
    .select("*, pro_project_photos(*)")
    .eq("contractor_id", contractor.id)
    .order("sort", { ascending: true })
    .order("created_at", { ascending: true });

  const projects: ProProject[] = (
    Array.isArray(projectRows) ? projectRows : []
  ).map((row: any) => ({
    id: row.id,
    title: row.title,
    category: row.category ?? null,
    description: row.description ?? null,
    months: row.months ?? null,
    sort: row.sort ?? 0,
    created_at: row.created_at,
    photos: (Array.isArray(row.pro_project_photos)
      ? (row.pro_project_photos as ProProjectPhoto[])
      : []
    )
      .slice()
      .sort((a, b) => a.sort - b.sort),
  }));

  // Checkr background checks (0057): dormant without CHECKR_API_KEY, so this
  // gates the whole card, not just the button inside it.
  const checkrEnabled = isCheckrConfigured();

  // Earn-in progress for the Hearth-funded check. Only counted when the card
  // can actually render, so a database without Checkr configured pays for no
  // extra query. Null (an unreadable count) shows as 0 of 3 and offers no
  // button, matching how the server action fails closed.
  const paidLeads = checkrEnabled
    ? await countPaidLeadApplications(contractor.id)
    : null;

  // The auth email the pro signs in with, for the security tab's email card.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Whether they have a password at all. A pro who signed up with Google has
  // none, so the security tab offers the set-a-password flow instead of a form
  // asking for a current password that doesn't exist. Read on every load.
  const { hasPassword, provider } = await getPasswordStatus();

  // TCPA SMS consent (users.sms_consent, migration 0075). It lives on the
  // account row rather than the company row, so the profile form has to be
  // handed its current value; without it the checkbox would render unticked
  // for a pro who already opted in and a save would silently switch their
  // texts off. Reads as false when the column is not live yet, which is the
  // safe direction (no texts).
  const { data: accountRow } = await (supabase as any)
    .from("users")
    .select("sms_consent")
    .eq("id", user?.id ?? "")
    .maybeSingle();
  const smsConsent = accountRow?.sms_consent === true;

  return (
    <div className="mx-auto max-w-4xl">
      {/* This was a pro-side page with no trail; one route holds all four
          tabs (public/page/projects/security), so the crumb names the route
          itself rather than whichever tab happens to be open. Label matches
          the ProNav profile menu entry verbatim ("Edit business profile") so
          the two never disagree. Rendered here, server-side, above the
          client ProfileTabs component - not inside it - so it is always in
          the served HTML regardless of which tab is selected client-side. */}
      <Breadcrumbs
        items={[
          { label: "Home", href: "/pro" },
          { label: "Edit business profile" },
        ]}
      />
      <ProfileTabs
        contractor={contractor}
        member={member}
        smsConsent={smsConsent}
        trialEligible={trialEligible}
        projects={projects}
        checkrEnabled={checkrEnabled}
        paidLeads={paidLeads}
        email={user?.email ?? null}
        hasPassword={hasPassword}
        providerName={providerLabel(provider)}
      />
    </div>
  );
}
