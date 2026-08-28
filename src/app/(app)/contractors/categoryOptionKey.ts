import { REMODEL_PROJECTS, SERVICE_CATEGORIES } from "@/lib/constants";

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

// One option in the picker's "Popular projects" group.
export type ProjectOption = { key: string; label: string };

// The "Popular projects" half of the picker, with repeated LABELS removed.
//
// Two REMODEL_PROJECTS entries are word-for-word repeats of a
// SERVICE_CATEGORIES option: "Garage door" and "Landscaping". Both lists get
// rendered into the same <select>, so the dropdown showed each of those twice,
// in two different groups, with nothing to tell them apart - testers on
// 2026-08-28 reported exactly that. The project copy is the redundant one (it
// carries no extra meaning: same words, same category), so it is the one that
// goes.
//
// Deduped by LABEL, never by category. Projects sharing a category with a
// service option but reading differently - "Water heater" and "Plumbing",
// "Kitchen remodel" and "Remodeling" - are the entire point of the projects
// group and all stay.
//
// The key stays projectKey() of the entry's ORIGINAL index in
// REMODEL_PROJECTS, so categoryForKey keeps resolving it and dropping an entry
// here can never shift what another option means.
export function projectOptions(): ProjectOption[] {
  const seen = new Set(SERVICE_CATEGORIES.map((c) => c.label.toLowerCase()));
  const options: ProjectOption[] = [];
  REMODEL_PROJECTS.forEach((project, index) => {
    const label = project.label.toLowerCase();
    if (seen.has(label)) return;
    seen.add(label);
    options.push({ key: projectKey(index), label: project.label });
  });
  return options;
}
