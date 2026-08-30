import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentContractor } from "@/lib/contractor";
import { hasProPlan, getProSubscription } from "@/lib/subscription";
import { labelFor, JOB_CATEGORIES } from "@/lib/constants";
// The whole body is one client component. That is a streaming fix, not a
// behaviour change: as server markup the stage tiles, the client cards, the
// job suggestions and the Pro teaser sat past the point where React Flight
// starts deferring elements into rows of their own, and this page's Flight row
// carried 11 deferrals on a pro with real jobs. See the long comment at the
// top of CrmView.tsx. The Pro-feature and roadmap lists moved in there with
// the markup that renders them; nothing about either list changed.
import CrmView from "./CrmView";

// The four pipeline stages, in order. Defined on the server side because
// CrmView needs them for the Add-a-client picker and a server component
// cannot import a plain value back out of a "use client" module, so they are
// passed down instead of copied.
const STAGES: { value: string; label: string }[] = [
  { value: "lead", label: "Lead" },
  { value: "quoted", label: "Quoted" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
];

// Maps a lead's own pipeline status to a starting CRM stage: closed is this
// app's "Won" (see STATUS_LABEL on /pro/business and /pro), lost stays lost,
// and anything still in progress (new, accepted) starts as a plain lead.
function stageForLeadStatus(status: string): string {
  if (status === "closed") return "won";
  if (status === "lost") return "lost";
  return "lead";
}

function dollarsFromCents(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

// A pipeline CRM for pros: a stage, an estimated value, contact info the pro
// types in themselves, a notes timeline, and an optional follow up date. It
// never stores or joins to a homeowner's own email or phone: contact fields
// and notes are typed in by the pro, and lead_id only links back to a job or
// chat the pro can already open.
export default async function ProCrmPage(
  props: {
    searchParams: Promise<{ q?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const contractor = await getCurrentContractor();
  // No company yet: company setup is the only way in, whatever the account's
  // preferred-side stamp says (see /pro/page.tsx).
  if (!contractor) redirect("/pro/onboarding");

  const supabase = await createClient();
  const q = (searchParams.q ?? "").trim();

  const [{ data: clientRows }, { data: leadRows }, member, proSub] = await Promise.all([
    supabase
      .from("pro_clients")
      .select("*")
      .eq("contractor_id", contractor.id)
      .order("created_at", { ascending: false }),
    // Only the fields the pipeline already shows for a job a homeowner chose
    // this pro for. Deliberately never homeowner_email or homeowner_phone.
    supabase
      .from("contractor_leads")
      .select("id, category, status, homeowner_name, created_at")
      .eq("contractor_id", contractor.id)
      .order("created_at", { ascending: false }),
    // Paying Pro-member check: drives the locked upgrade teaser below only. It
    // never gates any of the CRM functionality above.
    hasProPlan(),
    // The Pro-side row itself, for the teaser's CTA copy: the free trial is
    // for brand-new members only, and the row survives cancellation, so a pro
    // who churned and came back must not be offered a trial they won't get.
    // Free to ask for - hasProPlan() reads the same request-cached rows.
    getProSubscription(),
  ]);

  const clients = clientRows ?? [];
  const leads = leadRows ?? [];

  // How many clients came from the "Add a client" form itself (lead_id null)
  // rather than from tapping Track on a suggested job (lead_id set). Used
  // below to reset that form's fields on a successful add, without also
  // resetting it - and blanking whatever the pro was mid-typing - every time
  // a Track tap changes the client count too.
  const addedClientCount = clients.filter((c) => !c.lead_id).length;

  // The search box narrows the grouped list below; the stage tiles, the
  // follow up digest, and the job suggestions all stay based on every client
  // so the pipeline overview never shifts just because someone is searching.
  let displayClients = clients;
  if (q) {
    const { data: filteredRows } = await supabase
      .from("pro_clients")
      .select("*")
      .eq("contractor_id", contractor.id)
      .ilike("client_name", `%${q}%`)
      .order("created_at", { ascending: false });
    displayClients = filteredRows ?? [];
  }

  const clientIds = clients.map((c) => c.id);
  const { data: noteRows } =
    clientIds.length > 0
      ? await supabase
          .from("pro_client_notes")
          .select("client_id, body, created_at")
          .in("client_id", clientIds)
          .order("created_at", { ascending: false })
      : { data: [] };
  const latestNoteByClient = new Map<string, string>();
  for (const n of noteRows ?? []) {
    if (!latestNoteByClient.has(n.client_id)) {
      latestNoteByClient.set(n.client_id, n.body);
    }
  }

  const trackedLeadIds = new Set(
    clients.map((c) => c.lead_id).filter((id): id is string => Boolean(id))
  );
  const suggestions = leads.filter((l) => !trackedLeadIds.has(l.id));

  const todayStr = new Date().toISOString().slice(0, 10);
  const dueForFollowUp = clients
    .filter((c) => c.follow_up_on && c.follow_up_on <= todayStr)
    .sort((a, b) =>
      (a.follow_up_on ?? "").localeCompare(b.follow_up_on ?? "")
    );

  // ---- View models -------------------------------------------------------
  // Everything the page renders, resolved HERE rather than in the markup, so
  // CrmView takes plain data and this page's Flight row has no elements left
  // to defer. See the long comment at the top of CrmView.tsx.
  const stageTiles = STAGES.map((s) => {
    const items = clients.filter((c) => c.stage === s.value);
    const total = items.reduce((sum, c) => sum + (c.est_value_cents ?? 0), 0);
    return {
      value: s.value,
      label: s.label,
      count: items.length,
      totalLabel: dollarsFromCents(total),
    };
  });

  const withNote = (c: any) => ({
    client: c,
    latestNote: latestNoteByClient.get(c.id) ?? null,
  });

  // The date is formatted here, not in the card: toLocaleDateString reads the
  // runtime's locale and time zone, so a client component that formatted it
  // during hydration would print something different from what SSR sent.
  const suggestionVms = suggestions.map((l) => {
    const suggestedName =
      l.homeowner_name || labelFor(JOB_CATEGORIES, l.category);
    return {
      id: l.id,
      name: suggestedName,
      metaLine: `${labelFor(JOB_CATEGORIES, l.category)} · ${new Date(
        l.created_at
      ).toLocaleDateString()}`,
      stage: stageForLeadStatus(l.status),
    };
  });

  // The grouped "Your clients" list, grouped on the server. Empty stages are
  // dropped here exactly as the old inline `if (items.length === 0) return null`
  // did, so the rendered list is unchanged.
  const groups = STAGES.map((s) => ({
    value: s.value,
    label: s.label,
    items: displayClients.filter((c) => c.stage === s.value).map(withNote),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="space-y-8">
      {/* The whole body lives in CrmView, a client component, purely so this
          page's Flight row is one client reference carrying plain data instead
          of a long tail of card elements. Nothing in it is newly interactive;
          see the comment at the top of CrmView.tsx. */}
      <CrmView
        q={q}
        stageTiles={stageTiles}
        stageOptions={STAGES}
        addedClientCount={addedClientCount}
        todayStr={todayStr}
        dueForFollowUp={dueForFollowUp.map(withNote)}
        suggestions={suggestionVms}
        displayCount={displayClients.length}
        groups={groups}
        member={member}
        hasProSubscriptionRow={Boolean(proSub)}
      />
    </div>
  );
}
