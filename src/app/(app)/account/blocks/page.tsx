import Link from "next/link";
import { listMyBlocks } from "@/lib/blocks";
import BlockedUsersPanel from "@/components/BlockedUsersPanel";

// The homeowner side of the blocked-accounts list (migration 0138). The pro
// side is the same panel at /pro/blocks - pros with no claimed home never get
// past the (app) layout's "you need a home first" redirect, so they cannot
// share this route.
//
// Renders its empty state, not an error, when 0138 has not been applied to the
// live database yet: listMyBlocks turns a missing table into an empty list.

export const metadata = {
  title: "Blocked accounts",
};

export default async function BlocksPage() {
  const blocks = await listMyBlocks();

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
          Blocked accounts
        </h1>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          People you have blocked cannot message you, and you will not be shown
          to each other for new work. Unblocking takes effect right away.
        </p>
      </div>

      <BlockedUsersPanel blocks={blocks} />

      <p className="text-sm text-stone-500 dark:text-stone-400">
        Seeing something that breaks the rules?{" "}
        <Link
          href="/contact?topic=abuse"
          className="font-medium text-bark-700 hover:underline dark:text-stone-300"
        >
          Report abuse or a safety concern
        </Link>
        .
      </p>
    </div>
  );
}
