"use client";

import { useState } from "react";
import PublicProfileForm from "./PublicProfileForm";
import PublicPageCard from "./PublicPageCard";
import ProjectsCard, { type ProProject } from "./ProjectsCard";
import AccountSecurityPanel from "@/components/AccountSecurityPanel";
import BackgroundCheckCard from "./BackgroundCheckCard";
import {
  updateEmailAction,
  updatePasswordAction,
  signOutOthersAction,
  deleteAccountAction,
} from "./actions";
import type { Contractor } from "@/lib/database.types";

const TABS = [
  {
    key: "public" as const,
    label: "Public Profile",
    title: "Public Profile",
    subtitle: "Manage your public business profile and service offerings.",
  },
  {
    key: "page" as const,
    label: "Your Public Page",
    title: "Your Public Page",
    subtitle: "Share your Hearth page and manage what appears on it.",
  },
  {
    key: "projects" as const,
    label: "Projects",
    title: "Projects",
    subtitle: "Showcase completed work with photo albums on your public page.",
  },
  {
    key: "security" as const,
    label: "Account Security",
    title: "Account Security",
    subtitle: "Your sign-in email, password, sessions, and account deletion.",
  },
];

export default function ProfileTabs({
  contractor,
  member,
  trialEligible,
  projects,
  checkrEnabled,
  email,
  hasPassword,
  providerName,
}: {
  contractor: Contractor;
  member: boolean;
  // Whether the upgrade prompts below may lead with the free trial. Resolved
  // on the server (see page.tsx): only a pro who has never held a membership
  // gets one, and this component has no way to check that itself.
  trialEligible: boolean;
  projects: ProProject[];
  // The auth email the pro signs in with, for the security tab's email card.
  email: string | null;
  // Passed straight through to AccountSecurityPanel: false when this account
  // signed up with Google and has never set a password.
  hasPassword: boolean;
  providerName: string;
  // Checkr background checks (0057): only passed true when CHECKR_API_KEY is
  // set server-side (isCheckrConfigured() in page.tsx). Fully dormant
  // otherwise - BackgroundCheckCard never renders.
  checkrEnabled: boolean;
}) {
  const [tab, setTab] = useState<"public" | "page" | "projects" | "security">(
    "public"
  );
  const meta = TABS.find((t) => t.key === tab)!;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-stone-900 dark:text-stone-100">{meta.title}</h1>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">{meta.subtitle}</p>
      </div>

      {/* Segmented tab switcher */}
      <div
        role="tablist"
        className="flex w-full overflow-x-auto rounded-xl border border-stone-200 bg-stone-100 p-1 sm:inline-flex sm:w-auto dark:border-white/10 dark:bg-stone-800"
      >
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`shrink-0 whitespace-nowrap rounded-lg px-4 py-1.5 text-sm font-medium transition-colors ${
              tab === t.key
                ? "bg-white text-stone-900 shadow-sm dark:bg-stone-700 dark:text-stone-100"
                : "text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "public" ? (
        <div className="space-y-6">
          <PublicProfileForm contractor={contractor} />
          {checkrEnabled && <BackgroundCheckCard contractor={contractor} />}
        </div>
      ) : tab === "page" ? (
        <PublicPageCard
          contractor={contractor}
          member={member}
          trialEligible={trialEligible}
        />
      ) : tab === "projects" ? (
        <ProjectsCard
          contractorId={contractor.id}
          member={member}
          trialEligible={trialEligible}
          projects={projects}
        />
      ) : (
        <AccountSecurityPanel
          email={email}
          hasPassword={hasPassword}
          providerName={providerName}
          updateEmailAction={updateEmailAction}
          updatePasswordAction={updatePasswordAction}
          signOutOthersAction={signOutOthersAction}
          deleteAccountAction={deleteAccountAction}
          privacyHref="/pro/privacy"
        />
      )}
    </div>
  );
}
