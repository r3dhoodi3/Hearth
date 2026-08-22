import { cookies } from "next/headers";

// Lightweight "flash" toast that survives a server action + revalidate/redirect.
// setFlash() drops a short-lived, non-httpOnly cookie.
//
// WHO DOES WHAT:
//   sets    - setFlash(), from inside a Server Action (this file).
//   renders - src/components/FlashToast.tsx, on the CLIENT, by reading
//             document.cookie. The cookie is non-httpOnly for exactly this.
//   deletes - the same client component, right after queueing the toast.
//
// The render used to happen server-side: the root layout called readFlash()
// every render and handed the result to FlashBridge. That single cookies() read
// made every route in the app dynamic, so it moved to the client. The
// setFlash/readFlash server contract is untouched - every existing setFlash()
// call site keeps working exactly as before, including the ones that were
// rerouted through ActionResult.
//
// readFlash() stays exported for any server consumer that wants to read a
// pending flash during a render; nothing in the tree does today, and anything
// that starts to should be aware it makes its own route dynamic.
export const FLASH_COOKIE = "hearth_flash";

export type FlashType = "success" | "error" | "info" | "warning";
export interface Flash {
  message: string;
  type: FlashType;
  id: string;
}

// Call from inside a Server Action, before redirect()/revalidatePath().
// Both helpers are async since Next 15, where cookies() returns a Promise.
export async function setFlash(message: string, type: FlashType = "success") {
  const id = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  (await cookies()).set(FLASH_COOKIE, JSON.stringify({ message, type, id }), {
    httpOnly: false,
    sameSite: "lax",
    path: "/",
    maxAge: 30,
  });
}

export async function readFlash(): Promise<Flash | null> {
  const raw = (await cookies()).get(FLASH_COOKIE)?.value;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Flash;
  } catch {
    return null;
  }
}
