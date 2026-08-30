import { Hammer, Bell, FileText } from "lucide-react";

// The three value bullets a new homeowner sees before they type anything:
// once on the sign-up screen (the first thing a visitor reads, CR2#2), and
// again on the address step of onboarding right after. Pulled into one
// component so the two can never drift apart in wording - the sign-up page
// used to say only "Start tracking your home with Hearth" and left the real
// pitch for a screen later, which is the "welcome ≠ menu, but welcome ≠
// blank either" gap CR2 flagged.
export default function OnboardingValueBullets() {
  return (
    <ul className="space-y-1.5 rounded-lg bg-bark-50 p-3 text-sm text-bark-700 dark:bg-bark-700/40 dark:text-stone-300">
      <li className="flex items-start gap-2">
        <Hammer className="h-4 w-4 shrink-0 translate-y-0.5" aria-hidden="true" />
        <span>Track every system and know what needs attention</span>
      </li>
      <li className="flex items-start gap-2">
        <Bell className="h-4 w-4 shrink-0 translate-y-0.5" aria-hidden="true" />
        <span>Proactive freeze, heat, and recall alerts for YOUR home</span>
      </li>
      <li className="flex items-start gap-2">
        <FileText className="h-4 w-4 shrink-0 translate-y-0.5" aria-hidden="true" />
        <span>Scan a warranty or receipt and Hearth files it for you</span>
      </li>
    </ul>
  );
}
