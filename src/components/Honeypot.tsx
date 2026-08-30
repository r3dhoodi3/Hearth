import { HONEYPOT_FIELD } from "@/lib/formFields";

// The one honeypot field, shared by every form that writes to
// support_messages: the public /contact form and the two in-app help forms
// (account/help/SupportForm.tsx, pro/help/ProSupportForm.tsx). One component
// so the field NAME cannot drift from what the three actions read, and so a
// fourth form gets the same defense by importing it rather than by remembering
// to copy twenty lines of inline style.
//
// A real visitor never sees or reaches this field: it sits off-screen (NOT
// display:none - some bots specifically skip display:none fields to evade that
// trick), is hidden from assistive tech, and is skipped by keyboard tabbing. A
// script that fills every input in the form fills this one too, and the action
// then pretends the send succeeded and stores nothing, so the bot gets no
// signal to adapt on.
//
// The in-app forms are behind a session, so this is not their first line of
// defense (auth and a per-user rate limit are). It is here because a credential
// -stuffed or session-riding script hits exactly the same endpoint, and because
// having one form in the app defended differently from another is how the
// difference gets forgotten.
export default function Honeypot() {
  return (
    <div
      aria-hidden="true"
      style={{
        position: "absolute",
        left: "-9999px",
        width: 1,
        height: 1,
        overflow: "hidden",
      }}
    >
      <label htmlFor={HONEYPOT_FIELD}>Leave this field blank</label>
      <input
        type="text"
        id={HONEYPOT_FIELD}
        name={HONEYPOT_FIELD}
        tabIndex={-1}
        autoComplete="off"
      />
    </div>
  );
}
