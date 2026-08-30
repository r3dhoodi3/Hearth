"use client";

import { useState } from "react";

// Formats a US phone number as the user types into (000) 000-0000 and caps it
// at 10 digits, so extra numbers past a full phone number are ignored. Submits
// the formatted value under `name`.
function format(input: string): string {
  const d = input.replace(/\D/g, "").slice(0, 10);
  if (d.length === 0) return "";
  if (d.length < 4) return `(${d}`;
  if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

export default function PhoneInput({
  name,
  id,
  defaultValue = "",
  placeholder = "(555) 123-4567",
  className = "input",
  required = false,
  pattern,
}: {
  name: string;
  // Lets a surrounding <label htmlFor> point at this input.
  id?: string;
  defaultValue?: string;
  placeholder?: string;
  className?: string;
  required?: boolean;
  // Optional HTML5 pattern the FORMATTED value must fully match, e.g. the
  // full "(000) 000-0000" shape - undefined by default, so existing callers
  // are unaffected. A caller whose form keeps every field mounted inside
  // hidden panels (the pro onboarding wizard) must NOT pass this: a pattern
  // mismatch on a hidden control blocks the submit with a message the
  // browser can neither show nor focus, the same reason that form gates
  // `required` on the visible step instead of leaving it on always. Pass it
  // only on a form where this input is always on screen.
  pattern?: string;
}) {
  const [value, setValue] = useState(() => format(defaultValue));
  return (
    <input
      name={name}
      id={id}
      type="tel"
      inputMode="tel"
      autoComplete="tel"
      maxLength={14}
      className={className}
      placeholder={placeholder}
      required={required}
      pattern={pattern}
      value={value}
      onChange={(e) => setValue(format(e.target.value))}
    />
  );
}
