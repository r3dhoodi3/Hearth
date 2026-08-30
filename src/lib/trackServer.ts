import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingSchemaError } from "@/lib/dbErrors";
import { logSafe } from "@/lib/logSafe";
import type { Json } from "@/lib/database.types";

// Server-side counterpart to src/lib/analytics.ts's client-side track():
// writes straight into app_events with the admin client (RLS on that table
// is service-role-only by design, migration 0093, so no user-scoped client
// can write it), and degrades to a log line rather than throwing if the
// table hasn't been migrated onto a given DB yet - same graceful-degrade
// convention as the /api/track sink.
//
// Extracted from two near-identical copies (src/app/pro/actions.ts and
// src/app/(app)/contractors/actions.ts both defined a private
// `trackServerEvent`, each with its own copy of this exact body) so the
// growing homeowner/pro event list does not turn into a third, fourth, fifth
// copy-paste. See docs/ANALYTICS.md for the full event list and payload
// rules: ids and enums only, never free text, never email/phone/address.
export async function trackServerEvent(
  userId: string | null,
  event: string,
  props?: Record<string, unknown>
): Promise<void> {
  try {
    const admin = createAdminClient();
    const { error } = await admin.from("app_events").insert({
      event,
      props: (props ?? null) as Json | null,
      user_id: userId,
    });
    if (error && !isMissingSchemaError(error)) {
      console.error(`trackServerEvent(${event}): insert failed:`, error.message);
    } else if (error) {
      // logSafe, not console.log: props is a loose bag built by whichever
      // caller fired the event, so the shape is not fixed here. The redactor
      // drops token/email/phone-shaped keys before the line is written.
      logSafe("[track]", event, props ?? {});
    }
  } catch (err) {
    console.error(
      `trackServerEvent(${event}) failed:`,
      err instanceof Error ? err.message : err
    );
  }
}
