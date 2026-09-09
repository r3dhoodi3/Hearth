// The "Other (describe it)" free-text service name (B3), and how it rides on a
// job's description.
//
// A job's category is always one of JOB_CATEGORIES server-side, so "other"
// carries no information on its own. CategoryFilter shows an inline text box
// for that case and the two job actions fold the owner's words into the
// description pros read, as a "Service needed: <name>." prefix. There is no
// column for it: pros already read issue_description, and a new column would
// have to be threaded through open_jobs_for_me(), the lead card, the pro
// alerts and the CRM to be seen at all.
//
// This module exists so the prefix is written and read in exactly one place.
// Without it, editing an "other" job re-prefixed a description that already
// carried the prefix, so every save grew another copy of it:
//   "Service needed: Chimney sweep. Service needed: Chimney sweep. Soot ..."

const PREFIX = "Service needed: ";

/** Same ceiling the CategoryFilter input and both server actions apply. */
export const MAX_OTHER_SERVICE_LEN = 80;

/**
 * Split a stored description back into the owner's service name and the rest
 * of their description. Returns an empty name (and the description untouched)
 * when there is no prefix, so this is safe to call on any description.
 */
export function parseOtherService(description: string | null | undefined): {
  name: string;
  rest: string;
} {
  const text = (description ?? "").trim();
  if (!text.startsWith(PREFIX)) return { name: "", rest: text };
  const after = text.slice(PREFIX.length);
  const split = after.indexOf(". ");
  const name = (split === -1 ? after.replace(/\.$/, "") : after.slice(0, split)).trim();
  // A "name" longer than the cap, or empty, is not a prefix this module
  // wrote - leave the description exactly as it was rather than eating it.
  if (!name || name.length > MAX_OTHER_SERVICE_LEN) return { name: "", rest: text };
  return { name, rest: split === -1 ? "" : after.slice(split + 2).trim() };
}

/**
 * The description to store for an "other" job: the owner's service name in
 * front of their description, with any previous copy of the prefix removed
 * first so repeated edits can never stack it. A blank name gives back just
 * the description (null when that is empty too).
 */
export function withOtherService(
  name: string | null | undefined,
  description: string | null | undefined
): string | null {
  const { rest } = parseOtherService(description);
  const clean = (name ?? "").trim().slice(0, MAX_OTHER_SERVICE_LEN);
  if (!clean) return rest || null;
  return rest ? `${PREFIX}${clean}. ${rest}` : `${PREFIX}${clean}`;
}
