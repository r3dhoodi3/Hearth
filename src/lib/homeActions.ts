"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  ACTIVE_HOME_COOKIE,
  formatAddressLine,
  getProperties,
} from "@/lib/property";
import { setFlash } from "@/lib/flash";

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: 60 * 60 * 24 * 365,
};

// Switch which home is active.
export async function setActiveHomeAction(formData: FormData) {
  const id = formData.get("id") as string;
  const props = await getProperties();
  const home = props.find((p) => p.id === id);
  if (home) {
    (await cookies()).set(ACTIVE_HOME_COOKIE, id, COOKIE_OPTS);
    // formatAddressLine, not address_line1: someone with two units in the
    // same building would otherwise be told "Switched to 123 Main St" either
    // way and have no idea which one they landed on.
    await setFlash(`Switched to ${formatAddressLine(home)}`, "info");
  }
  revalidatePath("/", "layout");
  redirect("/dashboard");
}

// Landen's call: self-serve home deletion is OFF. A free account gets one
// home, and letting someone delete-and-recreate a home is a way to cycle the
// free-home cap between neighbours (delete, hand the address to a friend,
// they sign up fresh). Deletion now goes through support instead - see the
// "Need to remove a home?" line in HomeSwitcher, which links to /contact.
//
// This action is kept, and still wired to the old <form action={...}>
// shape, specifically so a replayed/forged form post can't fall through to
// a route that no longer exists and 404 into something worse. It always
// refuses and logs; it never touches the properties table. If a future
// admin tool needs real deletion, build a separate admin-only action (with
// its own auth check against an admin role, not this one) rather than
// re-enabling this path for ordinary users.
export async function removeHomeAction(formData: FormData) {
  const id = formData.get("id") as string;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  console.error(
    "removeHomeAction: self-serve home deletion is disabled",
    { propertyId: id, userId: user?.id ?? null }
  );
  await setFlash(
    "We don't delete homes automatically. Contact us and we'll take care of it.",
    "error"
  );
  revalidatePath("/", "layout");
  redirect("/dashboard");

  // --- Former deletion logic, preserved for reference only. Do not restore
  // --- for a user-facing action; RLS alone is not the control that stops
  // --- the free-home-cycling abuse described above.
  //
  // const { error } = await supabase.from("properties").delete().eq("id", id);
  // if (error) throw new Error(error.message);
  // await setFlash("Home deleted", "info");
  //
  // const remaining = await getProperties();
  // if (remaining.length === 0) {
  //   (await cookies()).delete(ACTIVE_HOME_COOKIE);
  //   revalidatePath("/", "layout");
  //   redirect("/onboarding");
  // }
  //
  // // Keep the current active home unless it was the one just removed.
  // const current = (await cookies()).get(ACTIVE_HOME_COOKIE)?.value;
  // if (!current || !remaining.some((p) => p.id === current)) {
  //   (await cookies()).set(ACTIVE_HOME_COOKIE, remaining[0].id, COOKIE_OPTS);
  // }
  // revalidatePath("/", "layout");
  // redirect("/dashboard");
}
