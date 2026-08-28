"use client";

import { useState } from "react";
import Link from "next/link";
import {
  assessSystem,
  replacementInfoFor,
  effectiveYearsLeft,
  systemStatus,
  lifeLeftText,
} from "@/lib/health";
import { imgSrc } from "@/lib/storage";
import {
  labelFor,
  SYSTEM_TYPES,
  ISSUE_CATEGORIES,
  STARTER_SYSTEM_NOTE,
  categoryForSystem,
  tipForSystem,
  materialLabel,
} from "@/lib/constants";
import type { HomeSystem } from "@/lib/database.types";
import { updateSystemAction, deleteSystemAction } from "./actions";
import PhotoUpload from "@/components/PhotoUpload";
import { StoredPhotoGrid } from "@/components/FilePreview";
import MonthYearInput from "@/components/MonthYearInput";
import MaterialSelect from "@/components/MaterialSelect";
import SubmitButton from "@/components/SubmitButton";

const STAGE_STYLE: Record<string, string> = {
  healthy: "bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-200 dark:border-green-900",
  aging: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30",
  due: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-200 dark:border-red-900",
  unknown: "bg-stone-50 text-stone-500 border-stone-200 dark:bg-stone-700 dark:text-stone-400 dark:border-white/10",
};

// Stored dates are YYYY-MM-DD; show them as MM/YYYY in the simple text field.
function dateToMmYyyy(d: string | null | undefined): string {
  if (!d) return "";
  const m = String(d).match(/^(\d{4})-(\d{2})/);
  return m ? `${m[2]}/${m[1]}` : "";
}

type OpenIssue = {
  category: string;
  description: string | null;
  severity?: string | null;
} | null;

export default function SystemRow({
  system: s,
  openIssue = null,
  photos = [],
}: {
  system: HomeSystem;
  openIssue?: OpenIssue;
  photos?: string[];
}) {
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const h = assessSystem(s);
  const issueSeverity = openIssue?.severity ?? null;
  // Status, the estimate exemption, and the "why this status" sentence all
  // come from one shared helper now (src/lib/health.ts), because the printed
  // home report renders the same facts and the two must never word a system
  // differently. mustDo = reported failing or an URGENT reported issue; a
  // low/medium issue shouldn't blare red (it lines up with the Issues tab
  // severity instead). estimatedDue = a "due" verdict the owner has never
  // weighed in on, which is a guess, not a confirmed problem.
  const status = systemStatus(s, openIssue);
  const { mustDo, estimatedDue } = status;
  // Red-bordered if it needs attention: must-do, due (and not just a guess),
  // or a medium issue.
  const needsBorder =
    mustDo || (h.stage === "due" && !estimatedDue) || issueSeverity === "medium";

  // Plain-language detail lines shown when the owner expands a system.
  const ageText =
    h.age != null ? `${h.age} years` : "Unknown, add an install year";
  // Years left adjusted for condition: a failing/worn system needs action sooner
  // than age alone implies.
  const eff = effectiveYearsLeft(s);
  const lifeLeft = lifeLeftText(s);
  const lastServicedText = dateToMmYyyy(s.last_serviced) || "Not recorded";
  const conditionText = s.condition_rating
    ? `${s.condition_rating} of 5`
    : "Not set";

  // Estimated replacement cost range + a monthly set-aside over the condition-
  // adjusted years until it's likely due.
  const cost = replacementInfoFor(s.system_type);
  const costMid = cost ? Math.round((cost.low + cost.high) / 2) : 0;
  const yearsAway = eff != null ? Math.max(0, Math.round(eff)) : null;
  const monthly =
    cost && yearsAway && yearsAway > 0
      ? Math.round(costMid / (yearsAway * 12))
      : null;
  const money = (n: number) => "$" + n.toLocaleString();

  // Prefill a job posting from this system's card info when "Find a pro" is tapped.
  const proDesc =
    `Need help with my ${labelFor(SYSTEM_TYPES, s.system_type)}.` +
    (h.age != null ? ` It is about ${h.age} years old.` : "") +
    (s.material_or_model ? ` Material/model: ${s.material_or_model}.` : "") +
    (s.condition_rating
      ? ` I rated its condition ${s.condition_rating} of 5.`
      : "");
  // A worn/failing system (2 or under) or one already due needs someone ASAP.
  const urgent =
    (s.condition_rating != null && s.condition_rating <= 2) || yearsAway === 0;
  const findProHref =
    `/contractors?category=${categoryForSystem(s.system_type)}` +
    `&desc=${encodeURIComponent(proDesc)}` +
    (urgent ? "&timing=asap" : "");

  if (editing) {
    return (
      <li className="card space-y-3">
        {/* Header + Remove sit OUTSIDE the update form (a separate delete form
            can't be nested inside another form). */}
        <div className="flex items-center justify-between gap-2">
          <p className="font-medium text-stone-900 dark:text-stone-100">
            {labelFor(SYSTEM_TYPES, s.system_type)}
          </p>
          <form action={deleteSystemAction}>
            <input type="hidden" name="id" value={s.id} />
            {confirmRemove ? (
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setConfirmRemove(false)}
                  className="inline-flex min-h-11 items-center text-xs text-stone-500 hover:text-stone-700 sm:inline-block sm:min-h-0 dark:text-stone-400 dark:hover:text-stone-200"
                >
                  Cancel
                </button>
                <SubmitButton
                  pendingLabel="Removing…"
                  className="inline-flex min-h-11 items-center text-xs font-semibold text-red-600 hover:text-red-700 sm:inline-block sm:min-h-0"
                >
                  Confirm remove?
                </SubmitButton>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmRemove(true)}
                className="inline-flex min-h-11 items-center text-xs text-stone-500 hover:text-red-600 sm:inline-block sm:min-h-0 dark:text-stone-400"
              >
                Remove
              </button>
            )}
          </form>
        </div>
        <form
          action={async (fd) => {
            const res = await updateSystemAction(fd);
            if (!res.ok) {
              setEditError(res.error);
              return;
            }
            setEditError(null);
            setEditing(false);
          }}
          className="space-y-3"
        >
          <input type="hidden" name="id" value={s.id} />

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="label">Install year</label>
              <input
                name="install_year"
                type="number"
                className="input"
                defaultValue={s.install_year ?? ""}
                placeholder="2015"
              />
            </div>
            <div>
              <label className="label">Last serviced</label>
              <MonthYearInput
                name="last_serviced"
                defaultValue={dateToMmYyyy(s.last_serviced)}
              />
            </div>
            <div>
              <label className="label">
                {materialLabel(s.system_type)} (optional)
              </label>
              <MaterialSelect
                systemType={s.system_type}
                defaultValue={s.material_or_model ?? ""}
              />
            </div>
            {/* Exact model + capacity (migration 0102), optional free text. */}
            <div>
              <label className="label">Model number (optional)</label>
              <input
                name="model_number"
                className="input"
                placeholder="XE50T10H45U0"
                maxLength={60}
                defaultValue={s.model_number ?? ""}
              />
            </div>
            <div>
              <label className="label">Capacity / size (optional)</label>
              <input
                name="capacity"
                className="input"
                placeholder="50 gal / 3 ton / 200 sq ft"
                maxLength={60}
                defaultValue={s.capacity ?? ""}
              />
            </div>
            <div>
              <label className="label">Condition</label>
              <select
                name="condition_rating"
                className="select"
                defaultValue={s.condition_rating ?? ""}
              >
                <option value="">Not sure</option>
                <option value="5">5 (like new)</option>
                <option value="4">4 (good)</option>
                <option value="3">3 (fair)</option>
                <option value="2">2 (worn)</option>
                <option value="1">1 (failing)</option>
              </select>
            </div>
            {/* HVAC only: filter size + reminder cadence for the consumables
                autopilot. Migration 0042 columns, not in the generated types
                yet, so read through a cast. */}
            {s.system_type === "hvac" && (
              <>
                <div>
                  <label className="label">Filter size (optional)</label>
                  <input
                    name="filter_size"
                    className="input"
                    placeholder="16x25x1"
                    maxLength={20}
                    defaultValue={(s as any).filter_size ?? ""}
                  />
                </div>
                <div>
                  <label className="label">Reminder every</label>
                  <select
                    name="filter_interval_months"
                    className="select"
                    defaultValue={(s as any).filter_interval_months ?? ""}
                  >
                    <option value="">No reminder</option>
                    <option value="1">1 month</option>
                    <option value="2">2 months</option>
                    <option value="3">3 months</option>
                    <option value="6">6 months</option>
                    <option value="12">12 months</option>
                  </select>
                </div>
              </>
            )}
          </div>

          <div>
            <label className="label">Notes</label>
            <textarea
              name="notes"
              className="textarea"
              rows={2}
              defaultValue={s.notes === STARTER_SYSTEM_NOTE ? "" : s.notes ?? ""}
            />
          </div>

          <PhotoUpload propertyId={s.property_id} />

          {editError && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">{editError}</p>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setEditError(null);
                setEditing(false);
              }}
            >
              Cancel
            </button>
            <SubmitButton pendingLabel="Saving…">Save changes</SubmitButton>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li
      onClick={() => setExpanded((v) => !v)}
      className={`card flex cursor-pointer items-start justify-between gap-4 ${
        needsBorder
          ? "!border !border-red-400 dark:!border-red-500"
          : estimatedDue
            ? "!border !border-amber-400 dark:!border-amber-500"
            : ""
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-stone-900 dark:text-stone-100">
            {labelFor(SYSTEM_TYPES, s.system_type)}
          </span>
          {/* One status badge. Must-do overrides the age-based stage, so a
              failing/urgent system can never read "Healthy". */}
          <span
            className={`rounded-full border px-2 py-0.5 text-xs ${
              mustDo
                ? "border-red-300 bg-red-100 font-semibold text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
                : estimatedDue
                  ? "border-amber-300 bg-amber-100 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300"
                  : STAGE_STYLE[h.stage]
            }`}
          >
            {status.label}
          </span>
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
          // min-w-11 as well as min-h-11: the label is four characters, so the
          // target measured 22x44 - tall enough and half as wide as it needs
          // to be. Widening it costs the row no height. Both minimums are
          // dropped from sm up, where this is a plain inline text link.
          className="mt-0.5 inline-flex min-h-11 min-w-11 items-center justify-center text-xs font-medium text-bark-700 hover:underline sm:inline-block sm:min-h-0 sm:min-w-0"
        >
          Edit
        </button>
        {photos.length > 0 && !expanded && (
          <span className="ml-2 text-xs text-stone-500 dark:text-stone-400">
            {photos.length} photo{photos.length === 1 ? "" : "s"} · tap to view
          </span>
        )}
        {expanded && (
          <dl
            onClick={(e) => e.stopPropagation()}
            className="mt-3 grid grid-cols-1 gap-x-4 gap-y-2 rounded-lg bg-stone-50 p-3 text-xs sm:grid-cols-2 dark:bg-stone-900"
          >
            <div className="col-span-1 sm:col-span-2 mb-2 border-b border-stone-200 pb-3 dark:border-white/10">
              <dt className="font-medium text-stone-800 dark:text-stone-200">Why this status</dt>
              <dd className="mt-1 text-stone-500 dark:text-stone-400">{status.why}</dd>
            </div>
            <div>
              <dt className="font-medium text-stone-800 dark:text-stone-200">How old it is</dt>
              <dd className="text-stone-500 dark:text-stone-400">{ageText}</dd>
            </div>
            <div>
              <dt className="font-medium text-stone-800 dark:text-stone-200">Typical replacement</dt>
              <dd className="text-stone-500 dark:text-stone-400">
                every {h.lifespan} years
              </dd>
            </div>
            <div>
              <dt className="font-medium text-stone-800 dark:text-stone-200">Life left</dt>
              <dd className="text-stone-500 dark:text-stone-400">{lifeLeft}</dd>
            </div>
            <div>
              <dt className="font-medium text-stone-800 dark:text-stone-200">Last serviced</dt>
              <dd className="text-stone-500 dark:text-stone-400">{lastServicedText}</dd>
            </div>
            <div>
              <dt className="font-medium text-stone-800 dark:text-stone-200">Condition</dt>
              <dd className="text-stone-500 dark:text-stone-400">{conditionText}</dd>
            </div>
            {s.material_or_model && (
              <div className="col-span-1 sm:col-span-2">
                <dt className="font-medium text-stone-800 dark:text-stone-200">{materialLabel(s.system_type)}</dt>
                <dd className="text-stone-500 dark:text-stone-400">
                  {s.material_or_model}
                </dd>
              </div>
            )}
            {s.model_number && (
              <div>
                <dt className="font-medium text-stone-800 dark:text-stone-200">Model number</dt>
                <dd className="text-stone-500 dark:text-stone-400">
                  {s.model_number}
                </dd>
              </div>
            )}
            {s.capacity && (
              <div>
                <dt className="font-medium text-stone-800 dark:text-stone-200">Capacity / size</dt>
                <dd className="text-stone-500 dark:text-stone-400">
                  {s.capacity}
                </dd>
              </div>
            )}
            {s.notes && s.notes !== STARTER_SYSTEM_NOTE && (
              <div className="col-span-1 sm:col-span-2">
                <dt className="font-medium text-stone-800 dark:text-stone-200">Notes</dt>
                <dd className="text-stone-500 dark:text-stone-400">{s.notes}</dd>
              </div>
            )}
            <div className="col-span-1 sm:col-span-2">
              <dt className="font-medium text-stone-800 dark:text-stone-200">Maintenance tip</dt>
              <dd className="text-stone-500 dark:text-stone-400">{tipForSystem(s.system_type)}</dd>
            </div>
            {photos.length > 0 && (
              <div className="col-span-1 sm:col-span-2">
                <dt className="font-medium text-stone-800 dark:text-stone-200">
                  Photo{photos.length === 1 ? "" : "s"}
                </dt>
                <dd>
                  <StoredPhotoGrid
                    photos={photos.map((u) => ({
                      key: u,
                      src: imgSrc(u) ?? u,
                      alt: `${labelFor(SYSTEM_TYPES, s.system_type)} photo`,
                    }))}
                  />
                </dd>
              </div>
            )}
            {cost && (
              <div className="col-span-1 sm:col-span-2 mt-1 border-t border-stone-200 pt-2 text-right dark:border-white/10">
                <dt className="font-medium text-stone-800 dark:text-stone-200">
                  Estimated replacement cost
                </dt>
                <dd className="text-stone-500 dark:text-stone-400">
                  {money(cost.low)} to {money(cost.high)}
                  {yearsAway === 0
                    ? " · due now"
                    : monthly
                      ? ` · ~${money(monthly)}/mo over ${yearsAway} yr${
                          yearsAway === 1 ? "" : "s"
                        }`
                      : ""}
                  <span className="block text-[10px] text-stone-500 dark:text-stone-400">
                    Based on this system&apos;s age and condition
                  </span>
                </dd>
              </div>
            )}
          </dl>
        )}
        {openIssue && (
          <p
            className={`mt-1 text-xs font-medium ${
              issueSeverity === "urgent"
                ? "text-red-600"
                : issueSeverity === "medium"
                  ? "text-amber-600"
                  : "text-stone-500 dark:text-stone-400"
            }`}
          >
            You reported a{" "}
            {labelFor(ISSUE_CATEGORIES, openIssue.category)} issue
            {openIssue.description ? `: ${openIssue.description}` : ""}.
          </p>
        )}
      </div>

      <div
        className="flex shrink-0 flex-col items-end justify-center self-stretch"
        onClick={(e) => e.stopPropagation()}
      >
        <Link
          href={findProHref}
          className="btn-primary px-2 py-1 text-xs"
        >
          Find a pro
        </Link>
      </div>
    </li>
  );
}
