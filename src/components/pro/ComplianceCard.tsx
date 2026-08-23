"use client";

import { useState } from "react";
import Link from "next/link";
import { complianceStatus, type ComplianceStatus } from "@/lib/proCompliance";
import AiNotice from "@/components/AiNotice";
import InlineSpinner from "@/components/InlineSpinner";
import { fetchWithTimeout, isTimeoutError } from "@/lib/fetchWithTimeout";

type DocState = {
  expires: string | null;
  docPath: string | null;
};

// The license NUMBER and what the CSLB said about it - a different fact from
// the uploaded document this card otherwise tracks, and the reason this card
// used to be wrong: a pro with a number on file and a failed CSLB check was
// told "Nothing on file yet", which is both false and the opposite of what
// /pro/profile showed them on the same data.
export type LicenseVerification = {
  number: string | null;
  status: "unverified" | "pending" | "verified" | "failed";
  verifiedAt: string | null;
  // license_verify_detail.statusText: the CSLB's own sentence about the
  // license ("Expired", "License is cancelled", ...) when there is one.
  statusText: string | null;
  // license_verify_detail.failure_reason: set when the failure is Hearth's
  // identity check rather than anything the CSLB said, which needs its own
  // wording (see PublicProfileForm, which offers the dispute form).
  identityFailure: boolean;
  // Whether an automatic CSLB check can run for this pro at all. Mirrors the
  // eligibility test in verifyLicenseNowAction and PublicProfileForm: a
  // null/blank service_state ("All states") or "CA" is eligible; an explicit
  // non-CA state is not, because the CSLB only holds California licenses.
  // Without it, "unverified" reads as "we are working on it" to a pro whose
  // number is never going to be checked automatically.
  cslbEligible: boolean;
};

const MAX_BYTES = 10 * 1024 * 1024; // 10MB, matches the API route's cap

function fmt(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function StatusPill({ status }: { status: ComplianceStatus }) {
  if (status === "expired") {
    return (
      <span className="chip border border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
        Expired
      </span>
    );
  }
  if (status === "expiring") {
    return (
      <span className="chip border border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300">
        Expiring soon
      </span>
    );
  }
  if (status === "ok") {
    return (
      <span className="chip border border-green-200 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200">
        On file
      </span>
    );
  }
  return <span className="chip bg-stone-100 text-stone-500 dark:bg-stone-700 dark:text-stone-400">Nothing on file</span>;
}

// "License and insurance": the pro's license number and its CSLB result, plus
// the document calendar - upload a document once and Hearth reads the
// expiration date off it so it can remind the pro before anything lapses.
// Honest by construction: an uploaded document is only ever "on file", never
// "verified", and the verified/pending/not-confirmed line is the CSLB check
// and nothing else - the same reading /pro/profile shows.
export default function ComplianceCard({
  license,
  insurance,
  verification,
}: {
  license: DocState;
  insurance: DocState;
  verification?: LicenseVerification;
}) {
  const [licenseState, setLicenseState] = useState<DocState>(license);
  const [insuranceState, setInsuranceState] = useState<DocState>(insurance);

  return (
    <section className="card space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
          License and insurance
        </h2>
        <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
          Hearth stores your documents and reminds you before they expire.
          Uploading a document does not verify it; your license number is
          checked against the CSLB separately.
        </p>
      </div>

      <ComplianceRow
        kind="license"
        label="Contractor license"
        state={licenseState}
        onChange={setLicenseState}
        verification={verification}
      />

      <div className="border-t border-stone-100 pt-5 dark:border-white/10">
        <ComplianceRow
          kind="insurance"
          label="Insurance"
          state={insuranceState}
          onChange={setInsuranceState}
        />
      </div>
    </section>
  );
}

// The license number line: what it is, what the CSLB said, and one link to the
// screen that can actually re-run the check. Deliberately read-only here -
// /pro/profile owns editing the number, reverifying, and the dispute form, and
// two places to do the same thing is how these two screens drifted apart.
function LicenseVerificationBlock({ v }: { v: LicenseVerification }) {
  if (!v.number) return null;

  // "unverified" and "pending" are different facts and used to share one pill
  // and one sentence: a number nobody has checked yet was told "Hearth is
  // checking this number", which is a promise the app was not keeping. Worse
  // for a pro outside California, where no automatic check will EVER run.
  const pill =
    v.status === "verified"
      ? {
          text: "Verified with the CSLB",
          className:
            "chip border border-green-200 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200",
        }
      : v.status === "failed"
      ? {
          text: "Not confirmed",
          className:
            "chip border border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200",
        }
      : v.status === "pending"
      ? {
          text: "Check pending",
          className:
            "chip border border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300",
        }
      : {
          text: "Not checked",
          className:
            "chip bg-stone-100 text-stone-500 dark:bg-stone-700 dark:text-stone-400",
        };

  const checkedOn = v.verifiedAt ? formatChecked(v.verifiedAt) : "";
  const detail =
    v.status === "verified"
      ? `Checked against the CSLB public database${
          checkedOn ? ` on ${checkedOn}` : ""
        }.`
      : v.status === "failed"
      ? v.identityFailure
        ? "The CSLB did not match this license to your account."
        : v.statusText
        ? `CSLB says: ${v.statusText}`
        : "The CSLB public database did not confirm this license."
      : v.status === "pending"
      ? "Hearth is checking this number against the CSLB public database."
      : v.cslbEligible
      ? "Not checked yet. Verify it on your profile."
      : "On file. Automatic checks cover California licenses only.";

  return (
    <div className="rounded-lg border border-stone-200 px-3 py-2 dark:border-white/10">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-stone-900 dark:text-stone-100">
          License #{v.number}
        </p>
        <span className={pill.className}>{pill.text}</span>
      </div>
      <p
        className={`mt-1 text-xs ${
          v.status === "failed"
            ? "text-red-600 dark:text-red-400"
            : "text-stone-500 dark:text-stone-400"
        }`}
      >
        {detail}
      </p>
      <Link
        href="/pro/profile"
        className="mt-1 inline-block text-xs font-medium text-hearth-700 hover:underline dark:text-hearth-300"
      >
        {v.status === "verified" || (v.status === "unverified" && !v.cslbEligible)
          ? "Manage on your profile →"
          : v.status === "unverified"
          ? "Verify it on your profile →"
          : "Fix or recheck it on your profile →"}
      </Link>
    </div>
  );
}

function formatChecked(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime())
    ? d.toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      })
    : "";
}

function ComplianceRow({
  kind,
  label,
  state,
  onChange,
  verification,
}: {
  kind: "license" | "insurance";
  label: string;
  state: DocState;
  onChange: (next: DocState) => void;
  verification?: LicenseVerification;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [manualDate, setManualDate] = useState(state.expires ?? "");
  const [needsManual, setNeedsManual] = useState(false);
  const [manualReason, setManualReason] = useState<string | null>(null);

  const { status } = complianceStatus(state.expires);

  async function submit(fd: FormData) {
    setBusy(true);
    setErr(null);
    try {
      // Timeout-guarded: a hung upload/parse call must not strand the card
      // in its busy state with no way to retry.
      const res = await fetchWithTimeout("/api/pro-compliance", {
        method: "POST",
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        setErr(data.error || "That didn't go through. Please try again.");
        return;
      }
      const nextExpires: string | null = data.expires_on ?? state.expires;
      onChange({
        expires: nextExpires,
        docPath: data.doc_path ?? state.docPath,
      });
      setManualDate(nextExpires ?? "");
      setNeedsManual(Boolean(data.needs_manual_date));
      setManualReason(
        typeof data.manual_reason === "string" ? data.manual_reason : null
      );
    } catch (e) {
      setErr(
        isTimeoutError(e)
          ? "That took too long. Try again."
          : "That didn't go through. Please try again."
      );
    } finally {
      setBusy(false);
    }
  }

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.target;
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setErr("Please pick a file under 10MB.");
      input.value = "";
      return;
    }
    const fd = new FormData();
    fd.append("kind", kind);
    fd.append("file", file);
    await submit(fd);
    input.value = "";
  }

  async function saveManualDate() {
    if (!manualDate) return;
    const fd = new FormData();
    fd.append("kind", kind);
    fd.append("manual_expires_on", manualDate);
    await submit(fd);
  }

  const showDateField = needsManual || status !== "none";

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-stone-900 dark:text-stone-100">
        {label}
      </p>

      {/* The number and its CSLB result come first: it is the fact a pro looks
          for here, and it is separate from whether a copy of the document has
          been uploaded. */}
      {verification && <LicenseVerificationBlock v={verification} />}

      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* Wording says "document" on purpose: this row is the uploaded copy
            and its expiry date, not the license number above it. */}
        <p className="text-xs text-stone-500 dark:text-stone-400">
          {state.expires
            ? `Document on file, expires ${fmt(state.expires)}`
            : "No document on file yet"}
        </p>
        <StatusPill status={status} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="file"
          accept="image/*,.pdf"
          onChange={onPick}
          disabled={busy}
          className="block text-sm text-stone-600 file:mr-3 file:rounded-md file:border-0 file:bg-hearth-100 file:px-3 file:py-1.5 file:text-hearth-800 dark:text-stone-300 dark:file:bg-hearth-900/40 dark:file:text-hearth-200"
        />
        {state.docPath && (
          <a
            href={`/api/pro-compliance?path=${encodeURIComponent(state.docPath)}`}
            target="_blank"
            rel="noreferrer"
            className="text-sm font-medium text-hearth-700 hover:underline dark:text-hearth-300"
          >
            View document
          </a>
        )}
      </div>

      {showDateField && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-stone-500 dark:text-stone-400">
            {needsManual
              ? (manualReason ??
                "Hearth couldn't read a date off that document. Enter it:")
              : "Expiration date"}
          </label>
          <input
            type="date"
            value={manualDate}
            onChange={(e) => setManualDate(e.target.value)}
            className="input h-9 w-auto text-base sm:text-sm"
          />
          <button
            type="button"
            onClick={saveManualDate}
            disabled={busy || !manualDate}
            className="btn-secondary text-xs"
          >
            {busy && <InlineSpinner size={12} />}
            Save date
          </button>
        </div>
      )}

      {/* The expiration date is read off the uploaded document by a model, so
          it gets the same label as every other generated surface. Only shown
          once there's a date on screen to doubt. */}
      {showDateField && state.docPath && (
        <AiNotice detail="The expiration date was read off your document by a model. Check it against the document and correct it above if it's wrong." />
      )}

      {busy && <p className="text-xs text-stone-500 dark:text-stone-400">Uploading, one moment.</p>}
      {err && <p className="text-xs text-red-600 dark:text-red-400">{err}</p>}
    </div>
  );
}
