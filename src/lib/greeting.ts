import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { getActiveProperty } from "@/lib/property";
import { getUser } from "@/lib/auth";
import { getUserProfile } from "@/lib/user";
import { assessSystem } from "@/lib/health";
import { labelFor, SYSTEM_TYPES, ISSUE_CATEGORIES } from "@/lib/constants";

// A short, proactive opener for Ask Hearth. It names the single most important
// thing about the home right now, so the assistant speaks first instead of
// waiting to be asked. This is the "voice" that a plain chatbot lacks. Returns
// undefined when there is nothing worth leading with, so the assistant falls
// back to its normal greeting. Cached per request so both the dock and the
// Messages pane share one computation.
export const getProactiveGreeting = cache(
  async (): Promise<string | undefined> => {
    try {
      const property = await getActiveProperty();
      if (!property) return undefined;
      const supabase = createClient();

      const [profile, user] = await Promise.all([getUserProfile(), getUser()]);
      const metaName = (
        user?.user_metadata?.full_name as string | undefined
      )?.trim();
      const full = profile?.full_name || metaName || "";
      const first = full ? full.split(/\s+/)[0] : "";
      const hi = first ? `Hi ${first}.` : "Hi.";

      const [{ data: issues }, { data: systems }, { data: tasks }] =
        await Promise.all([
          supabase
            .from("issues")
            .select("category, severity")
            .eq("property_id", property.id)
            .eq("status", "open")
            .order("created_at", { ascending: false }),
          supabase
            .from("home_systems")
            .select("*")
            .eq("property_id", property.id),
          supabase
            .from("maintenance_tasks")
            .select("title, due_date")
            .eq("property_id", property.id)
            .eq("status", "open")
            .order("due_date", { ascending: true }),
        ]);

      // An open issue is the most pressing thing, urgent ones first.
      const issue =
        (issues ?? []).find((i) => i.severity === "urgent") ?? (issues ?? [])[0];
      if (issue) {
        const name = labelFor(ISSUE_CATEGORIES, issue.category).toLowerCase();
        return `${hi} I see an open ${name} issue on your home. Want me to help you sort it, or line up a local pro? [[OPTIONS]]{"options":["Help me sort it","Find a pro"]}[[/OPTIONS]]`;
      }

      // Next, a system at or near the end of its typical life.
      const due = (systems ?? [])
        .map((s) => ({ s, stage: assessSystem(s).stage }))
        .find((x) => x.stage === "due");
      if (due) {
        const name = labelFor(SYSTEM_TYPES, due.s.system_type).toLowerCase();
        return `${hi} Your ${name} is near the end of its typical life. Want to plan a replacement, or see what it might cost? [[OPTIONS]]{"options":["Plan a replacement","See costs","Not now"]}[[/OPTIONS]]`;
      }

      // Otherwise, an overdue or upcoming reminder.
      const today = new Date().toISOString().slice(0, 10);
      const rem = (tasks ?? [])[0];
      if (rem) {
        const when = rem.due_date
          ? rem.due_date < today
            ? "that is overdue"
            : "coming up"
          : "on your list";
        return `${hi} You have a task ${when}: ${rem.title}. Want a hand with it? [[OPTIONS]]{"options":["Yes, help me","Not now"]}[[/OPTIONS]]`;
      }

      return `${hi} Your home looks in good shape. Ask me anything, or tell me what is going on and I can help.`;
    } catch {
      return undefined;
    }
  }
);

// The pro's open-jobs board (category-matched, not yet applied). Two callers
// share it: src/app/pro/layout.tsx builds the pro copilot's opening line from
// it ("N open leads matching your trades"), and src/app/pro/page.tsx renders
// the actual leads board from it. Cached per request, so the RPC runs once per
// page view instead of once for each of them.
export const getOpenJobsForMe = cache(async (): Promise<any[]> => {
  try {
    const supabase = createClient();
    const { data } = await (supabase as any).rpc("open_jobs_for_me");
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
});
