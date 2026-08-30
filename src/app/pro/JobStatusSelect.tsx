"use client";

import { useRef } from "react";
import { useFormStatus } from "react-dom";
import InlineSpinner from "@/components/InlineSpinner";
import { updateLeadStatusAction } from "./actions";
import { STATUS_LABEL } from "./leadStatusLabel";

// Compact outcome selector for an assigned job. Replaces the Mark won / Mark
// lost buttons with one dropdown that submits as soon as you change it.
// Labels come from the shared STATUS_LABEL map (LOW-3) so this dropdown, the
// card badge and the post-change toast can never drift apart again; this array
// owns only the order and which statuses are selectable here.
const OPTIONS = (["new", "accepted", "closed", "lost"] as const).map(
  (value) => ({ value, label: STATUS_LABEL[value] })
);

export default function JobStatusSelect({
  id,
  status,
}: {
  id: string;
  status: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const current = OPTIONS.some((o) => o.value === status) ? status : "accepted";

  return (
    <form ref={formRef} action={updateLeadStatusAction}>
      <input type="hidden" name="id" value={id} />
      <StatusField current={current} formRef={formRef} />
    </form>
  );
}

// Split out from JobStatusSelect because useFormStatus only reports pending
// state inside a descendant of the <form>, not the component rendering the
// form itself.
function StatusField({
  current,
  formRef,
}: {
  current: string;
  // `| null` since React 19: useRef<T>(null) now returns RefObject<T | null>
  // rather than pretending the ref is always populated.
  formRef: React.RefObject<HTMLFormElement | null>;
}) {
  const { pending } = useFormStatus();
  return (
    <label className="flex items-center gap-2 text-sm text-stone-500 dark:text-stone-400">
      Status
      {pending && <InlineSpinner size={14} />}
      <select
        key={current}
        name="status"
        defaultValue={current}
        onChange={() => formRef.current?.requestSubmit()}
        disabled={pending}
        className="select !w-auto py-2 sm:py-1"
      >
        {OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
