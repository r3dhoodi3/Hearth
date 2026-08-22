import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProperties } from "@/lib/property";
import type { HouseholdMember } from "@/lib/database.types";
import ConfirmSubmit from "@/components/ConfirmSubmit";
import SubmitButton from "@/components/SubmitButton";
import HouseholdQrCode from "./HouseholdQrCode";
import {
  inviteMemberAction,
  removeMemberAction,
  acceptInviteAction,
  declineInviteAction,
  leaveHomeAction,
} from "./actions";

const MAX_MEMBERS_PER_HOME = 4;

// Share day to day access to a home with up to a few other people. Three
// zones: pending invites addressed to me, the homes I own (manage members),
// and the homes shared with me (leave).
export default async function HouseholdPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/signin");

  const homes = await getProperties();
  const owned = homes.filter((h) => !h.isShared);
  const shared = homes.filter((h) => h.isShared);
  const ownedIds = owned.map((h) => h.id);
  const myEmail = (user.email ?? "").trim().toLowerCase();

  const [invitesToMeRes, ownerRowsRes, myMembershipsRes] = await Promise.all([
    supabase
      .from("household_members")
      .select("*")
      .eq("status", "invited")
      .is("member_user_id", null),
    ownedIds.length
      ? supabase
          .from("household_members")
          .select("*")
          .in("property_id", ownedIds)
          .order("created_at", { ascending: true })
      : Promise.resolve({ data: [] as HouseholdMember[] | null }),
    supabase
      .from("household_members")
      .select("*")
      .eq("status", "active")
      .eq("member_user_id", user.id),
  ]);

  // Rows the invitee select policy hands back include invites on homes I own
  // too (since the owner select policy also matches), so narrow to invites
  // addressed to my own email.
  const invitesToMe = (invitesToMeRes.data ?? []).filter(
    (r) => r.invited_email.trim().toLowerCase() === myEmail
  );
  const ownerRows = ownerRowsRes.data ?? [];
  const myMemberships = myMembershipsRes.data ?? [];
  const membershipByProperty = new Map(myMemberships.map((m) => [m.property_id, m]));

  const rowsByProperty = new Map<string, HouseholdMember[]>();
  for (const row of ownerRows) {
    const list = rowsByProperty.get(row.property_id) ?? [];
    list.push(row);
    rowsByProperty.set(row.property_id, list);
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">Household</h1>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          Share day to day access to a home with the rest of your household.
        </p>
      </div>

      <div className="card p-6">
        <p className="text-sm text-stone-600 dark:text-stone-300">
          A household member can see and manage the day to day of a shared
          home: systems, maintenance tasks, issues, photos, documents, job
          posts, and contractor messages. A member cannot edit the home&apos;s
          details, remove the home, or invite anyone else. Hearth Plus is a
          personal subscription, so a member does not inherit the owner&apos;s
          Plus.
        </p>
      </div>

      {invitesToMe.length > 0 && (
        <div className="space-y-3">
          {invitesToMe.map((invite) => (
            <div
              key={invite.id}
              className="rounded-2xl border border-hearth-200 bg-hearth-50 p-5 dark:border-hearth-800/40 dark:bg-hearth-900/30"
            >
              <p className="text-sm font-medium text-stone-900 dark:text-stone-100">
                You have been invited to join a home on Hearth.
              </p>
              <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                Invited on {new Date(invite.created_at).toLocaleDateString()}.
              </p>
              <div className="mt-3 flex items-center gap-2">
                <form action={acceptInviteAction}>
                  <input type="hidden" name="id" value={invite.id} />
                  <SubmitButton className="btn-primary">Accept</SubmitButton>
                </form>
                <form action={declineInviteAction}>
                  <input type="hidden" name="id" value={invite.id} />
                  <button type="submit" className="btn-secondary">
                    Decline
                  </button>
                </form>
              </div>
            </div>
          ))}
        </div>
      )}

      {owned.map((home) => {
        const rows = rowsByProperty.get(home.id) ?? [];
        const active = rows.filter((r) => r.status === "active");
        const pending = rows.filter((r) => r.status === "invited");
        const atCap = rows.length >= MAX_MEMBERS_PER_HOME;

        return (
          <div
            key={home.id}
            className="card p-6"
          >
            <h2 className="break-words text-base font-semibold text-stone-900 dark:text-stone-100">
              {home.address_line1}
            </h2>
            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
              Up to {MAX_MEMBERS_PER_HOME} members per home.
            </p>

            {(active.length > 0 || pending.length > 0) && (
              <ul className="mt-4 divide-y divide-stone-100 dark:divide-white/10">
                {active.map((m) => (
                  <li
                    key={m.id}
                    className="flex items-center justify-between gap-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="break-words text-sm text-stone-900 dark:text-stone-100">{m.invited_email}</p>
                      <p className="text-xs text-stone-500 dark:text-stone-400">Member</p>
                    </div>
                    <form action={removeMemberAction}>
                      <input type="hidden" name="id" value={m.id} />
                      <ConfirmSubmit
                        subtle
                        label="Remove"
                        note={`Remove ${m.invited_email} from this home?`}
                        yesLabel="Yes, remove"
                      />
                    </form>
                  </li>
                ))}
                {pending.map((m) => (
                  <li
                    key={m.id}
                    className="flex items-center justify-between gap-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="break-words text-sm text-stone-900 dark:text-stone-100">{m.invited_email}</p>
                      <p className="text-xs text-stone-500 dark:text-stone-400">
                        Invited. Waiting for them to sign up or sign in with
                        this email.
                      </p>
                    </div>
                    <form action={removeMemberAction}>
                      <input type="hidden" name="id" value={m.id} />
                      <ConfirmSubmit
                        subtle
                        label="Cancel invite"
                        note={`Cancel the invite to ${m.invited_email}?`}
                        yesLabel="Yes, cancel"
                      />
                    </form>
                  </li>
                ))}
              </ul>
            )}

            {atCap ? (
              <p className="mt-4 text-sm text-stone-500 dark:text-stone-400">
                This home has the maximum of {MAX_MEMBERS_PER_HOME} members.
                Remove someone to invite another person.
              </p>
            ) : (
              <>
                <form action={inviteMemberAction} className="mt-4 flex gap-2">
                  <input type="hidden" name="property_id" value={home.id} />
                  <input
                    name="email"
                    type="email"
                    required
                    placeholder="name@example.com"
                    className="input flex-1"
                  />
                  <SubmitButton className="btn-secondary">Invite</SubmitButton>
                </form>

                <p className="mt-4 text-center text-xs text-stone-400 dark:text-stone-500">
                  or
                </p>
                {/* Fresh QR token minted client-side (migration 0095), a
                    second way to reach the same membership the email invite
                    above creates. Key on home.id so a new HouseholdQrCode
                    mounts (and mints its own token) per home instead of one
                    instance being reused across homes. */}
                <HouseholdQrCode key={home.id} propertyId={home.id} />
              </>
            )}
          </div>
        );
      })}

      {shared.map((home) => {
        const membership = membershipByProperty.get(home.id);
        return (
          <div
            key={home.id}
            className="card p-6"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 className="break-words text-base font-semibold text-stone-900 dark:text-stone-100">
                  {home.address_line1}
                </h2>
                <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">Shared with you.</p>
              </div>
              {membership && (
                <form action={leaveHomeAction}>
                  <input type="hidden" name="id" value={membership.id} />
                  <ConfirmSubmit
                    subtle
                    label="Leave"
                    note={`Leave ${home.address_line1}? You'll lose access to its systems, tasks, issues, photos, and documents.`}
                    yesLabel="Yes, leave"
                  />
                </form>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
