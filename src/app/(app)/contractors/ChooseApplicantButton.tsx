"use client";

import { useState } from "react";
import SubmitButton from "@/components/SubmitButton";

// The submit trigger for an applicant card, meant to sit inside the
// <form action={chooseApplicantAction}> that already wraps it in page.tsx.
// Choosing a pro is permanent: it assigns the job, unlocks the pro's contact
// and chat, and declines every other applicant, with no way to undo it from
// here. The first tap only arms an inline "are you sure" instead of
// submitting right away, and the actual submit button disables itself while
// the pick is in flight so a second tap can't fire a duplicate choice.
export default function ChooseApplicantButton({
  contractorName,
}: {
  contractorName: string;
}) {
  const [armed, setArmed] = useState(false);

  if (!armed) {
    return (
      <button
        type="button"
        onClick={() => setArmed(true)}
        className="btn-primary shrink-0 text-sm"
      >
        Choose
      </button>
    );
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <p className="max-w-[14rem] text-right text-xs text-stone-500 dark:text-stone-400">
        Choosing {contractorName} can&apos;t be undone: every other applicant
        is declined and can&apos;t be picked later.
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setArmed(false)}
          className="btn-secondary text-sm"
        >
          Cancel
        </button>
        <SubmitButton className="btn-primary text-sm" pendingLabel="Choosing…">
          Yes, choose them
        </SubmitButton>
      </div>
    </div>
  );
}
