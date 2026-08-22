import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentContractor } from "@/lib/contractor";
import { labelFor, JOB_CATEGORIES } from "@/lib/constants";
import ConfirmSubmit from "@/components/ConfirmSubmit";
import {
  updateClientDetailsAction,
  deleteClientAction,
  addNoteAction,
  deleteNoteAction,
} from "../actions";

const STAGES: { value: string; label: string }[] = [
  { value: "lead", label: "Lead" },
  { value: "quoted", label: "Quoted" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
];

// Cents to a plain dollar string for a number input's defaultValue: whole
// dollar amounts drop the trailing .00, everything else keeps two decimals.
function dollarsFromCents(cents: number | null): string {
  if (cents === null || cents === undefined) return "";
  return (cents / 100).toFixed(2).replace(/\.00$/, "");
}

// The detail page for one tracked client: contact info and pipeline fields,
// the notes timeline, the linked job when there is one, and the delete
// action. Every query below is scoped to the signed in pro's own contractor
// row, so a client that isn't theirs (or doesn't exist) behaves exactly like
// a missing one: no information leak either way.
export default async function ClientDetailPage(
  props: {
    params: Promise<{ id: string }>;
  }
) {
  const params = await props.params;
  const contractor = await getCurrentContractor();
  if (!contractor) redirect("/pro/onboarding");

  const supabase = await createClient();

  const { data: client } = await supabase
    .from("pro_clients")
    .select("*")
    .eq("id", params.id)
    .eq("contractor_id", contractor.id)
    .maybeSingle();

  if (!client) redirect("/pro/crm");

  const { data: noteRows } = await supabase
    .from("pro_client_notes")
    .select("*")
    .eq("client_id", client.id)
    .order("created_at", { ascending: false });
  const notes = noteRows ?? [];

  let lead: { id: string; category: string | null } | null = null;
  if (client.lead_id) {
    const { data: leadRow } = await supabase
      .from("contractor_leads")
      .select("id, category")
      .eq("id", client.lead_id)
      .eq("contractor_id", contractor.id)
      .maybeSingle();
    lead = leadRow ?? null;
  }

  return (
    <div className="space-y-8">
      <div>
        <Link
          href="/pro/crm"
          className="text-sm font-medium text-hearth-700 hover:underline dark:text-hearth-300"
        >
          Back to clients
        </Link>
        <h1 className="mt-1 text-2xl font-semibold text-stone-900 dark:text-stone-100">
          {client.client_name}
        </h1>
      </div>

      <section className="card space-y-3">
        <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
          Contact and details
        </h2>
        <form
          action={updateClientDetailsAction}
          className="grid gap-3 sm:grid-cols-2"
        >
          <input type="hidden" name="id" value={client.id} />
          <label className="block sm:col-span-2">
            <span className="label">Client name</span>
            <input
              type="text"
              name="client_name"
              defaultValue={client.client_name}
              maxLength={80}
              required
              className="input"
            />
          </label>
          <label className="block">
            <span className="label">Phone</span>
            <input
              type="tel"
              name="phone"
              defaultValue={client.phone ?? ""}
              maxLength={30}
              className="input"
            />
          </label>
          <label className="block">
            <span className="label">Email</span>
            <input
              type="email"
              name="email"
              defaultValue={client.email ?? ""}
              maxLength={120}
              className="input"
            />
          </label>
          <label className="block sm:col-span-2">
            <span className="label">Address</span>
            <input
              type="text"
              name="address"
              defaultValue={client.address ?? ""}
              maxLength={200}
              className="input"
            />
          </label>
          <label className="block">
            <span className="label">Estimated value in dollars</span>
            <input
              type="number"
              name="est_value"
              min="0"
              step="0.01"
              defaultValue={dollarsFromCents(client.est_value_cents)}
              className="input"
            />
          </label>
          <label className="block">
            <span className="label">Stage</span>
            <select
              name="stage"
              defaultValue={client.stage}
              className="select"
            >
              {STAGES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">Follow up on</span>
            <input
              type="date"
              name="follow_up_on"
              defaultValue={client.follow_up_on ?? ""}
              className="input"
            />
          </label>
          <div className="sm:col-span-2">
            <button type="submit" className="btn-primary">
              Save changes
            </button>
          </div>
        </form>
      </section>

      {lead && (
        <section className="card space-y-2">
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Linked job
          </h2>
          <p className="text-sm text-stone-700 dark:text-stone-300">
            {labelFor(JOB_CATEGORIES, lead.category)}
          </p>
          <Link
            href={`/pro/chats?lead=${lead.id}`}
            className="text-sm font-medium text-hearth-700 hover:underline dark:text-hearth-300"
          >
            Open chat
          </Link>
        </section>
      )}

      <section className="card space-y-4">
        <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">Notes</h2>
        <form action={addNoteAction} className="space-y-2">
          <input type="hidden" name="client_id" value={client.id} />
          <textarea
            name="body"
            maxLength={1000}
            rows={3}
            placeholder="Add a note"
            required
            className="textarea"
          />
          <button type="submit" className="btn-primary text-sm">
            Add note
          </button>
        </form>
        {notes.length === 0 ? (
          <p className="text-sm text-stone-500 dark:text-stone-400">No notes yet.</p>
        ) : (
          <ul className="space-y-2">
            {notes.map((n) => (
              <li
                key={n.id}
                className="flex items-start justify-between gap-3 rounded-lg border border-stone-200 bg-stone-50 p-3 dark:border-white/10 dark:bg-stone-700"
              >
                <div className="min-w-0 space-y-1">
                  <p className="whitespace-pre-wrap text-sm text-stone-700 dark:text-stone-300">
                    {n.body}
                  </p>
                  <p className="text-xs text-stone-500 dark:text-stone-400">
                    {new Date(n.created_at).toLocaleString()}
                  </p>
                </div>
                <form action={deleteNoteAction} className="shrink-0">
                  <input type="hidden" name="client_id" value={client.id} />
                  <input type="hidden" name="note_id" value={n.id} />
                  <ConfirmSubmit
                    label="Remove"
                    note="Remove this note?"
                    yesLabel="Remove"
                    subtle
                  />
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card space-y-3">
        <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
          Danger zone
        </h2>
        <p className="text-sm text-stone-500 dark:text-stone-400">
          Removing a client also removes its notes. This can&apos;t be undone.
        </p>
        <form action={deleteClientAction}>
          <input type="hidden" name="id" value={client.id} />
          <ConfirmSubmit
            label="Remove client"
            note={`Remove ${client.client_name} and all of their notes?`}
            yesLabel="Remove"
          />
        </form>
      </section>
    </div>
  );
}
