import { redirect } from "next/navigation";
import { getCurrentContractor } from "@/lib/contractor";
import PlaybookGuides from "./PlaybookGuides";
import { PLAYBOOK_GUIDES } from "./guides";

// The Playbook: the pro-side Learn tab. Short, honest guides on winning work
// on Hearth - speed, apply messages, and how the marketplace mechanics
// (ghost protection, aging deals, the 3-spot cap) actually work.
export default async function ProPlaybookPage() {
  const contractor = await getCurrentContractor();
  // No company yet: company setup is the only way in, whatever the account's
  // preferred-side stamp says (see /pro/page.tsx).
  if (!contractor) redirect("/pro/onboarding");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">Playbook</h1>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          Short guides on winning work here: no fluff, just what moves your win
          rate.
        </p>
      </div>

      <PlaybookGuides guides={PLAYBOOK_GUIDES} />
    </div>
  );
}
