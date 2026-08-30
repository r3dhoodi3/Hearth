// Shared localStorage autosave for the pro side's compose boxes: the apply
// message (ApplyJobButton.tsx), each AI tool's job description
// (ProToolsClient.tsx), and the CRM add-a-client note (CrmView.tsx). Job
// sites have bad cell coverage, and right now a backgrounded app or a failed
// fetchWithTimeout call loses whatever a pro already typed - this is the same
// idea as the homeowner onboarding draft (src/app/onboarding/draft.ts) and
// the pro signup wizard's draft (src/app/pro/onboarding/draftKey.ts), scaled
// down to plain text keyed by what is being composed and which lead/tool it
// belongs to.
//
// Storage is a convenience only: private mode, a full quota, or blocked site
// data all just mean autosave doesn't happen, never a broken compose box.

const PREFIX = "hearth.pro-draft.v1";

function draftKey(kind: string, id: string): string {
  return `${PREFIX}.${kind}.${id}`;
}

export function readComposeDraft(kind: string, id: string): string {
  if (!id) return "";
  try {
    return localStorage.getItem(draftKey(kind, id)) ?? "";
  } catch {
    return "";
  }
}

// Debounced so every keystroke doesn't hit localStorage. Timers are keyed by
// kind+id (module-level, not per-component) so typing in two different boxes
// at once - two tool tabs, say - never cancels each other's pending save.
const timers = new Map<string, ReturnType<typeof setTimeout>>();
export const DRAFT_SAVE_DEBOUNCE_MS = 400;

export function saveComposeDraftDebounced(
  kind: string,
  id: string,
  text: string
): void {
  if (!id) return;
  const key = draftKey(kind, id);
  const existing = timers.get(key);
  if (existing) clearTimeout(existing);
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      try {
        if (text.trim()) {
          localStorage.setItem(key, text);
        } else {
          // An emptied box means the draft is gone too, not a stored "".
          localStorage.removeItem(key);
        }
      } catch {
        // Storage full or blocked: the draft just doesn't persist.
      }
    }, DRAFT_SAVE_DEBOUNCE_MS)
  );
}

export function clearComposeDraft(kind: string, id: string): void {
  if (!id) return;
  const key = draftKey(kind, id);
  const pending = timers.get(key);
  if (pending) {
    clearTimeout(pending);
    timers.delete(key);
  }
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing to do: there was no draft to lose.
  }
}
