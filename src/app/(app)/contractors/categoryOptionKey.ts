import { REMODEL_PROJECTS } from "@/lib/constants";

// Pure helpers behind the "What do you need?" select (CategoryFilter.tsx).
//
// Several REMODEL_PROJECTS entries share a category with a plain
// SERVICE_CATEGORIES option, or with each other (e.g. "Water heater" and
// "Plumbing" both map to "plumbing"; "Kitchen remodel" and "Bathroom remodel"
// both map to "remodeling"). A native <select> is matched by its VALUE, so two
// <option>s with the same value are indistinguishable to the browser: picking
// the second one visually snaps back to whichever same-valued option comes
// first in the DOM. Namespacing each project option by its index keeps every
// <option> in the list unique regardless of shared categories.
export function projectKey(index: number): string {
  return `project:${index}`;
}

// Recover the canonical contractor category (the one postJobAction /
// updateJobAction actually store and match pros against) from whatever the
// visible <select> currently has selected.
export function categoryForKey(key: string): string {
  if (key.startsWith("project:")) {
    const project = REMODEL_PROJECTS[Number(key.slice("project:".length))];
    return project?.category ?? "";
  }
  return key;
}
