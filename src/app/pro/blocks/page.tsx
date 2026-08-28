import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentContractor } from "@/lib/contractor";
import { listMyBlocks } from "@/lib/blocks";
import BlockedUsersPanel from "@/components/BlockedUsersPanel";

// The pro's view of the blocked-accounts list. Same panel and same two server
// actions as /account/blocks; it needs its own route for the same reason
// /pro/privacy does - a pro with no claimed home is redirected to /onboarding
// by the (app) layout before /account/blocks can render.

export const metadata = {
  title: "Blocked accounts",
};

export default async function ProBlocksPage() {
  const contractor = await getCurrentContractor();
  if (!contractor) redirect("/pro/onboarding");

  const blocks = await listMyBlocks();

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
          Blocked accounts
        </h1>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          Homeowners you have blocked cannot message you, and their jobs no
          longer show on your board. Unblocking takes effect right away.
        </p>
      </div>

      <BlockedUsersPanel blocks={blocks} />

      <p className="text-sm text-stone-500 dark:text-stone-400">
        Seeing something that breaks the rules?{" "}
        <Link
          href="/contact?topic=abuse"
          className="font-medium text-hearth-700 hover:underline dark:text-hearth-300"
        >
          Report abuse or a safety concern
        </Link>
        .
      </p>
    </div>
  );
}
