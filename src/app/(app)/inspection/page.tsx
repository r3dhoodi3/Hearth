import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getActiveProperty } from "@/lib/property";
import { getVerifiedUser } from "@/lib/auth";
import { hasPlus } from "@/lib/subscription";
import { freeTastesLeft } from "@/lib/freeAiTasteServer";
import InspectionRequest from "./InspectionRequest";
import InspectionUpload from "./InspectionUpload";

// Home inspection hub: request a professional inspection (posts a job to
// local inspectors, same flow as any other trade), or add a report the
// owner already has so Hearth can read it and propose systems and issues.
export default async function InspectionPage() {
  const property = await getActiveProperty();
  if (!property) redirect("/onboarding");
  const supabase = await createClient();

  // Prefill the request form's contact fields from the owner's saved profile,
  // same as the contractors job-post form. getVerifiedUser() is the same live
  // auth-server check this used to make inline, shared through React's cache()
  // with the (app) layout's, so the page adds no second round trip.
  const user = await getVerifiedUser();
  const { data: profile } = await supabase
    .from("users")
    .select("full_name, email, phone")
    .eq("id", user?.id ?? "")
    .maybeSingle();

  // The report-read meter for the upload card: how many of the 1 lifetime free
  // report reads are left, keyed to the VIEWER since that is whose account
  // /api/ingest-inspection charges. Null for Plus (no meter at all) and null
  // when the counter cannot be read, so the card never guesses. See
  // src/lib/freeAiTaste.ts.
  const isPlus = await hasPlus();
  const freeReadsLeft =
    isPlus || !user ? null : await freeTastesLeft(user.id, false, "inspection");

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
          Home inspection
        </h1>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          Worth getting if you&apos;re buying, selling, setting a maintenance
          baseline, or meeting an insurance requirement.
        </p>
      </div>

      <section className="card space-y-4">
        <div>
          <h2 className="font-semibold text-stone-900 dark:text-stone-100">
            Get your home inspected
          </h2>
          <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
            Post a job and local inspectors will apply. You review them
            and pick who you want.
          </p>
        </div>
        <InspectionRequest
          defaultName={profile?.full_name ?? ""}
          defaultEmail={profile?.email ?? user?.email ?? ""}
          defaultPhone={profile?.phone ?? ""}
        />
      </section>

      <section className="card space-y-4">
        <div>
          <h2 className="font-semibold text-stone-900 dark:text-stone-100">
            Already have an inspection report? Add it to your home
          </h2>
          <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
            Upload photos of the report, or paste its text. Hearth reads it
            and suggests systems and issues for you to confirm, nothing saves
            until you do.
          </p>
        </div>
        <InspectionUpload freeReadsLeft={freeReadsLeft} />
      </section>
    </div>
  );
}
