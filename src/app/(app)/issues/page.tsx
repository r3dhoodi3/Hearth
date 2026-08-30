import { createClient } from "@/lib/supabase/server";
import { getActiveProperty } from "@/lib/property";
import type { HomeSystem } from "@/lib/database.types";
import IssueForm from "./IssueForm";
import IssueRow from "./IssueRow";

export default async function IssuesPage() {
  const propertyOrNull = await getActiveProperty();
  // The (app) layout (src/app/(app)/layout.tsx) is what sends an account with
  // no claimed home to the right place, and it always redirects when there is
  // no active property. But Next renders the layout and the page in PARALLEL,
  // so this function still runs on that request - and reading .id off the
  // non-null assertion below threw "Cannot read properties of null" on every
  // such GET (live log, 2026-08-30). The response was still the layout's 307,
  // so nobody ever saw it, but a TypeError thrown on a routine redirect is
  // noise that buries real errors. Bail out quietly instead and let the layout
  // own the destination: it knows whether this account belongs on /onboarding,
  // /pro/onboarding or the role picker, and this page does not.
  if (!propertyOrNull) return null;
  const property = propertyOrNull;
  const supabase = await createClient();

  const [{ data: issues }, { data: systems }] = await Promise.all([
    supabase
      .from("issues")
      // Everything IssueRow reads (id/category/severity/description/status/
      // converted_to_lead) - drops property_id and created_at, unused here
      // (ordering happens server-side via .order() below, no select needed).
      .select("id, category, severity, description, status, converted_to_lead")
      .eq("property_id", property.id)
      .order("created_at", { ascending: false }),
    supabase
      .from("home_systems")
      // IssueForm only reads id/system_type/material_or_model for its
      // "related system" dropdown.
      .select("id, system_type, material_or_model")
      .eq("property_id", property.id),
  ]);

  const open = (issues ?? []).filter((i) => i.status === "open");
  const resolved = (issues ?? []).filter((i) => i.status === "resolved");

  // Photos an owner attached when reporting an issue (or posting a job from
  // one) live in the polymorphic photos table, keyed by issue id - same
  // pattern the dashboard uses for system photos. Grouped here so each row
  // can show its own "Show photos" disclosure.
  const issueIds = (issues ?? []).map((i) => i.id);
  const photosByIssue = new Map<string, string[]>();
  if (issueIds.length) {
    const { data: pics } = await supabase
      .from("photos")
      .select("related_id, url")
      .eq("property_id", property.id)
      .eq("related_type", "issue")
      .in("related_id", issueIds);
    for (const p of pics ?? []) {
      const list = photosByIssue.get(p.related_id) ?? [];
      list.push(p.url);
      photosByIssue.set(p.related_id, list);
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">Report a problem</h1>
          <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
            Log a problem and get connected with a local pro.
          </p>
        </div>
      </div>

      {/* IssueForm's declared prop is the full HomeSystem[] shape, but it only
          reads id/system_type/material_or_model - all present in the trimmed
          select above. Safe cast, no behavior change. */}
      <IssueForm
        propertyId={property.id}
        systems={(systems ?? []) as unknown as HomeSystem[]}
      />

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">Open</h2>
        {open.length ? (
          <ul className="space-y-2">
            {open.map((i) => (
              <IssueRow
                key={`${i.id}-${i.status}`}
                issue={i}
                photos={photosByIssue.get(i.id) ?? []}
              />
            ))}
          </ul>
        ) : (
          <p className="rounded-xl border border-dashed border-stone-300 p-6 text-center text-sm text-stone-500 dark:border-stone-700 dark:text-stone-400">
            No open issues.
          </p>
        )}
      </section>

      {resolved.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">Resolved</h2>
          <ul className="space-y-2">
            {resolved.map((i) => (
              <IssueRow
                key={`${i.id}-${i.status}`}
                issue={i}
                initialResolved
                photos={photosByIssue.get(i.id) ?? []}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
