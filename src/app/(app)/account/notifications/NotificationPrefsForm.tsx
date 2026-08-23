"use client";

import SubmitButton from "@/components/SubmitButton";
import { saveNotificationPrefsAction } from "./actions";
import { NOTIFICATION_CHANNELS } from "./channels";

// A row of toggles for each notification channel. New homeowners default to
// everything on, so an unset preference reads as enabled.
export default function NotificationPrefsForm({
  prefs,
}: {
  prefs: { [key: string]: boolean } | null;
}) {
  const isOn = (key: string) => prefs?.[key] ?? true;

  return (
    <form
      action={saveNotificationPrefsAction}
      className="card p-6"
    >
      <div className="divide-y divide-stone-100 dark:divide-white/10">
        {NOTIFICATION_CHANNELS.map((c) => (
          // min-h-11: the whole row is the tap target, so it stays at least
          // 44px tall even when a channel has a one-line description.
          <label
            key={c.key}
            className="flex min-h-11 cursor-pointer items-start justify-between gap-4 py-4 first:pt-0"
          >
            <span>
              <span className="block text-sm font-medium text-stone-900 dark:text-stone-100">
                {c.label}
              </span>
              <span className="block text-sm text-stone-500 dark:text-stone-400">{c.desc}</span>
            </span>
            {/* accent-bark-600 is what actually colours the box: the project
                does not load @tailwindcss/forms, so `text-bark-600` styled
                nothing and these rendered as the browser's default blue
                checkboxes. The focus ring is drawn with outline for the same
                reason. */}
            <input
              type="checkbox"
              name={c.key}
              defaultChecked={isOn(c.key)}
              className="mt-1 h-5 w-5 shrink-0 cursor-pointer accent-bark-600 rounded border-stone-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bark-600 dark:border-white/20"
            />
          </label>
        ))}
      </div>

      <div className="mt-5">
        <SubmitButton>Save preferences</SubmitButton>
      </div>
    </form>
  );
}
