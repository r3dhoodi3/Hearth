import { redirect } from "next/navigation";
import { getUserProfile } from "@/lib/user";
import NotificationPrefsForm from "./NotificationPrefsForm";
import Breadcrumbs from "@/components/Breadcrumbs";
import PushSettingsCard from "@/components/PushSettingsCard";

export default async function NotificationsPage() {
  const profile = await getUserProfile();
  if (!profile) redirect("/signin");

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Breadcrumbs
        items={[
          { label: "Home", href: "/dashboard" },
          { label: "Account", href: "/account" },
          { label: "Notifications" },
        ]}
      />
      <div>
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">Notifications</h1>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          Choose what Hearth notifies you about. You can change these at any time.
        </p>
      </div>
      {/* Above the channel toggles on purpose: this is the only control that
          reaches somebody with the app CLOSED, which is what people come to
          this page looking for. */}
      <PushSettingsCard side="homeowner" />
      <NotificationPrefsForm prefs={profile.notification_prefs} />
    </div>
  );
}
