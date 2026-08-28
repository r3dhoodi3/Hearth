"use client";

import { useEffect, useState } from "react";
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

// `short` is the phone label. Four tabs at their full names do not fit a
// 390px screen, and the strip scrolled with no hint that it did, so the last
// tab was simply invisible. Shorter names fit all four with no scrolling; the
// full names come back at sm.
const TABS = [
  {
    key: "public" as const,
    label: "Public Profile",
    short: "Profile",
    title: "Public Profile",
    subtitle: "Manage your public business profile and service offerings.",
  },
  {
    key: "page" as const,
    label: "Your Public Page",
    short: "Public page",
    title: "Your Public Page",
    subtitle: "Share your Hearth page and manage what appears on it.",
  },
  {
    key: "projects" as const,
    label: "Projects",
    short: "Projects",
    title: "Projects",
    subtitle: "Showcase completed work with photo albums on your public page.",
  },
  {
    key: "security" as const,
    label: "Account Security",
    short: "Security",
    title: "Account Security",
    subtitle: "Your sign-in email, password, sessions, and account deletion.",
  },
];

type TabKey = (typeof TABS)[number]["key"];

// Deep links from elsewhere in the pro app point at a field that lives inside
// one of these panels - /pro/profile#reviews, from the setup checklist on the
// pro dashboard, is the review-link pair in the Public Profile form. Only the
// selected panel is rendered, so the browser's own hash scroll finds nothing:
// this map says which tab has to be showing before the id exists at all.
const HASH_TAB: Record<string, TabKey> = {
  reviews: "public",
};

export default function ProfileTabs({
  contractor,
  member,
  trialEligible,
  projects,
  checkrEnabled,
  paidLeads,
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
  // Paid lead applications, for the background check's earn-in meter. Counted
  // on the server (page.tsx); this component cannot query.
  paidLeads: number | null;
}) {
  const [tab, setTab] = useState<TabKey>("public");
  // The id a deep link asked for, held until the tab that owns it has mounted.
  const [pendingHash, setPendingHash] = useState<string | null>(null);
  const meta = TABS.find((t) => t.key === tab)!;

  // Read the hash once, on mount, and switch to the tab that holds it.
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.replace(/^#/, ""));
    if (!id || !(id in HASH_TAB)) return;
    setTab(HASH_TAB[id]);
    setPendingHash(id);
  }, []);

  // Then scroll, after the panel above has actually rendered the element. The
  // effect re-runs on the tab change that the effect above queued, which is
  // the first pass where getElementById can find anything.
  useEffect(() => {
    if (!pendingHash) return;
    const el = document.getElementById(pendingHash);
    if (!el) return;
    el.scrollIntoView({ block: "start" });
    // block:"start" puts the section's top edge at y=0, which on this shell is
    // behind the pinned top bar - the first field of the pair ends up covered.
    // Give back exactly the bar's height so the whole section is on screen.
    const bar = document.querySelector("header");
    const pinned =
      bar && ["sticky", "fixed"].includes(getComputedStyle(bar).position);
    if (bar && pinned) window.scrollBy(0, -bar.getBoundingClientRect().height);
    setPendingHash(null);
  }, [pendingHash, tab]);

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
            className={`flex-1 whitespace-nowrap rounded-lg px-2 py-1.5 text-sm font-medium transition-colors max-sm:inline-flex max-sm:min-h-11 max-sm:items-center max-sm:justify-center sm:flex-none sm:px-4 ${
              tab === t.key
                ? "bg-white text-stone-900 shadow-sm dark:bg-stone-700 dark:text-stone-100"
                : "text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200"
            }`}
          >
            <span className="sm:hidden">{t.short}</span>
            <span className="hidden sm:inline">{t.label}</span>
          </button>
        ))}
      </div>

      {tab === "public" ? (
        <div className="space-y-6">
          <PublicProfileForm contractor={contractor} />
          {checkrEnabled && (
            <BackgroundCheckCard
              contractor={contractor}
              paidLeads={paidLeads}
            />
          )}
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
