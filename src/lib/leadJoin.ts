// How a contractor_leads row asks PostgREST for the pro attached to it.
//
// Why this is not just "contractors": contractor_leads has TWO foreign keys
// into contractors -
//
//   contractor_leads_contractor_id_fkey  (contractor_id) - the pro who was
//                                        picked for this job.
//   contractor_leads_direct_to_fkey      (direct_to, added by migration 0105)
//                                        - the one pro a direct request is
//                                        aimed at, before anyone unlocks it.
//
// From the moment 0105 landed, a bare `contractors(...)` embed became
// ambiguous and PostgREST stopped answering it: it returns HTTP 300 with
// {"code":"PGRST201", ...} listing both candidate relationships instead of
// rows. supabase-js surfaces that as `error`, not as a throw, so every caller
// that did `const { data } = await ...` silently got null and rendered an
// empty list. That is exactly what happened to "Your jobs" on /contractors: a
// homeowner posted a job, the row was inserted, and the page showed them
// nothing at all - no jobs section, and a success banner linking to a
// #your-jobs anchor that was not in the document.
//
// The disambiguating hint is the FK constraint name (PostgREST's `!hint`
// syntax). It is written once, here, so the three pages that read a lead's pro
// cannot drift apart again, and so a new second FK on any of these tables
// fails loudly in one place instead of quietly emptying three screens.
//
// Note this is the CHOSEN pro (contractor_id). Nothing reads the direct_to pro
// through an embed - /contractors looks those names up with the admin client,
// because a pro who has not accepted a direct request yet is not "related" to
// the homeowner and RLS will not show them.
export const LEAD_CONTRACTOR_EMBED =
  "contractors!contractor_leads_contractor_id_fkey" as const;

// The same embed with a column list, e.g.
//   leadContractorEmbed("name, rating")
//   -> "contractors!contractor_leads_contractor_id_fkey(name, rating)"
// The key on the returned row is still `contractors` - the hint only picks
// which relationship to follow, it does not rename the embedded object.
//
// Generic on the column list, and returning a template LITERAL type, because
// supabase-js parses the select string at the type level to work out the row
// shape. A plain `string` return makes that parser give up and hand every
// caller a ParserError, so `row.contractors?.name` stops type checking - the
// helper would have traded a runtime bug for a compile-time one.
export function leadContractorEmbed<C extends string>(
  columns: C
): `${typeof LEAD_CONTRACTOR_EMBED}(${C})` {
  return `${LEAD_CONTRACTOR_EMBED}(${columns})`;
}
