"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { mintHouseholdQrTokenAction } from "./actions";
import InlineSpinner from "@/components/InlineSpinner";

const REFRESH_LABEL = "This code refreshes every 5 minutes.";

// QR invite for one home's household tab. Mints a fresh token (5 minute
// expiry, migration 0095) on mount and silently mints another when it
// expires, for as long as this component stays mounted - so a screenshot of
// the code stops working within 5 minutes and a stranger who finds an old
// photo of it cannot join. There is no visible countdown: the refresh is
// silent, and REFRESH_LABEL is a static line, not a ticking clock. The real
// expiry is enforced server-side by redeem_household_invite_token(), which
// checks expires_at itself no matter when this component happens to re-mint.
// A code someone actually scans within its live window gets a one-time 30
// minute grace extension server-side (scanned_at, migration 0097) so a real
// signup doesn't get cut off - this component has no idea that happened,
// it just keeps re-minting on its own schedule regardless.
export default function HouseholdQrCode({ propertyId }: { propertyId: string }) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [joinUrl, setJoinUrl] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const mountedRef = useRef(true);

  const mint = useCallback(async () => {
    setError(null);
    setPending(true);
    // mintHouseholdQrTokenAction returns a typed ActionResult
    // (src/lib/actionResult.ts) rather than throwing, so a DB-side failure
    // comes back as { ok: false, error } instead of a thrown exception.
    // Still wrapped in try/catch for the QR-image encoding step below and
    // for any transport failure calling the action itself (e.g. the browser
    // losing its connection mid-request), so this component can never end
    // up rendering nothing with no explanation either way.
    try {
      const result = await mintHouseholdQrTokenAction(propertyId);
      if (!mountedRef.current) return;
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // ActionResult's `data` is typed optional (some actions return
      // ActionResult<undefined>), but this action always sets it alongside
      // ok: true - a missing value here is unreachable in practice. Still
      // guarded rather than asserted, so a future change to the action
      // can't turn this into a silent runtime crash.
      if (!result.data) {
        setError("Couldn't create an invite code. Try again.");
        return;
      }
      const expiresMs = new Date(result.data.expiresAt).getTime();
      // `qrcode` is loaded on demand rather than imported at module scope. A
      // static import drags the whole encoder into the account route's
      // first-load JS for every visitor, including the many who never open
      // the household tab. Awaited here, inside the same try/catch that
      // already guards the encoding step, so a chunk that fails to load
      // surfaces as the existing "Try again" error rather than a blank card.
      const { default: QRCode } = await import("qrcode");
      const dataUrl = await QRCode.toDataURL(result.data.joinUrl, {
        margin: 1,
        width: 240,
      });
      if (!mountedRef.current) return;
      setJoinUrl(result.data.joinUrl);
      setExpiresAt(expiresMs);
      setQrDataUrl(dataUrl);
    } catch {
      if (!mountedRef.current) return;
      setError("Couldn't create an invite code. Try again.");
    } finally {
      if (mountedRef.current) setPending(false);
    }
  }, [propertyId]);

  useEffect(() => {
    mountedRef.current = true;
    mint();
    return () => {
      mountedRef.current = false;
    };
  }, [mint]);

  // Silent re-mint when the current token expires. No visible countdown -
  // just a single timer scheduled for whenever expiresAt actually falls, so
  // there's nothing ticking on screen. Only runs while expiresAt is set
  // (i.e. after the first successful mint), and only while the
  // tab/component stays mounted - closing the household tab simply stops
  // minting new codes, it does not revoke the last one early (that's what
  // its own expiry is for).
  useEffect(() => {
    if (expiresAt == null) return;
    const remaining = Math.max(expiresAt - Date.now(), 0);
    const id = setTimeout(() => mint(), remaining);
    return () => clearTimeout(id);
  }, [expiresAt, mint]);

  return (
    <div className="mt-4 rounded-2xl border border-stone-200 bg-white p-5 text-center dark:border-white/10 dark:bg-stone-800">
      <p className="text-sm font-medium text-stone-900 dark:text-stone-100">
        Scan to join this home
      </p>

      {qrDataUrl ? (
        <img
          src={qrDataUrl}
          alt="QR code to join this home's household"
          className="mx-auto mt-3 h-48 w-48 rounded-lg border border-stone-100 bg-white p-2 dark:border-white/10"
          width={192}
          height={192}
        />
      ) : (
        <div className="mx-auto mt-3 flex h-48 w-48 items-center justify-center rounded-lg border border-stone-100 text-xs text-stone-500 dark:border-white/10 dark:text-stone-500">
          {error ? "Unavailable" : "Loading…"}
        </div>
      )}

      {error && (
        <p className="mt-3 text-xs text-red-600 dark:text-red-400">
          {error}{" "}
          <button
            type="button"
            onClick={() => mint()}
            disabled={pending}
            className="inline-flex items-center justify-center gap-1.5 font-medium underline"
          >
            {pending && <InlineSpinner size={12} />}
            Try again
          </button>
        </p>
      )}

      {qrDataUrl && !error && (
        <>
          <p className="mt-3 text-xs text-stone-500 dark:text-stone-400">{REFRESH_LABEL}</p>
          {joinUrl && (
            <p className="mt-3 break-all text-[11px] text-stone-500 dark:text-stone-500">
              {joinUrl}
            </p>
          )}
        </>
      )}
    </div>
  );
}
