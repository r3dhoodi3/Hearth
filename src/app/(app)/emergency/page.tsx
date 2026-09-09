import { redirect } from "next/navigation";
import { getActiveProperty } from "@/lib/property";
import { imgSrc } from "@/lib/storage";
import PanicCard, { type PrepKey } from "./PanicCard";
import PrepPhotoUpload from "./PrepPhotoUpload";
import { FLOWS, PREP_ITEMS } from "./content";

type PrepValue = { photo_path: string | null; note: string | null };
type PrepMap = Partial<Record<PrepKey, PrepValue>>;

// The panic flows are static content and must render even if migration
// 0031 hasn't run against the live DB yet, so we read emergency_prep
// defensively (it just won't exist as a property yet on an old row) rather
// than gating the whole page on it.
export default async function EmergencyPage() {
  const property = await getActiveProperty();
  if (!property) redirect("/onboarding");

  // emergency_prep isn't in database.types.ts yet (migration 0031), so cast at
  // the read site, same pattern as the write side in actions.ts.
  const prep = ((property as any).emergency_prep ?? {}) as PrepMap;

  const photoFor = (key?: PrepKey) => (key ? imgSrc(prep[key]?.photo_path ?? null) : null);
  const noteFor = (key?: PrepKey) => (key ? prep[key]?.note ?? null : null);

  return (
    // pb-28 gives the always-on Ask OakTend dock (fixed bottom-right) empty
    // space to float over, so its pill never sits on top of a panic card's
    // tap zone even when scrolled to the bottom.
    <div className="space-y-8 pb-28">
      <div>
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">Emergency</h1>
        <p className="mt-1 text-stone-500 dark:text-stone-400">
          Something wrong right now? Pick what&apos;s happening below. The steps are
          short, do them in order.
        </p>
      </div>

      <div className="space-y-3">
        {FLOWS.map(({ icon: _icon, ...flow }) => (
          <PanicCard
            key={flow.key}
            flow={flow}
            prepPhotoSrc={photoFor(flow.prepKey)}
            prepNote={noteFor(flow.prepKey)}
          />
        ))}
      </div>

      <section className="card space-y-4">
        <div>
          <h2 className="font-semibold text-stone-900 dark:text-stone-100">Be ready before it happens</h2>
          <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
            Take a photo of each shutoff now, on a calm day. Next time there&apos;s an
            emergency, we&apos;ll show it to you right where you need it.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {PREP_ITEMS.map((item) => (
            <PrepPhotoUpload
              key={item.key}
              propertyId={property.id}
              itemKey={item.key}
              label={item.label}
              initialPhotoSrc={photoFor(item.key)}
              initialNote={noteFor(item.key) ?? ""}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
