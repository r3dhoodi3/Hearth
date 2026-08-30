-- PASTE-ME (2026-08-29): tighten the Storage bucket limits, which are the ONLY
-- server-side upload cap on most of the app.
--
-- WHY. Seven of the eleven upload paths in Hearth go straight from the browser
-- to Supabase Storage with the user's own session: PhotoUpload.tsx,
-- DocumentUpload.tsx, LeadChat.tsx (chat photos), PrepPhotoUpload.tsx,
-- LogoUpload.tsx and ProjectPhotoManager.tsx. No Next.js server action or route
-- handler ever sees those bytes, so the MAX_BYTES constants in those components
-- are advice to the browser, not a control: the same request replays with any
-- body. The bucket's own file_size_limit is the only thing an attacker cannot
-- edit, which makes these three numbers the real caps.
--
-- WHAT CHANGES. Two of them are currently looser than what the app tells the
-- user, so the honest number is put in the one place that enforces it:
--   pro-logos  15MB -> 5MB   (LogoUpload.tsx has always said 5MB, and this is
--                             the one PUBLIC bucket, so the smallest cap that
--                             still does the job is the right one)
--   pro-docs   15MB -> 10MB  (matches MAX_FILE_BYTES in
--                             src/app/api/pro-compliance/route.ts and
--                             UPLOAD_KINDS.compliance in src/lib/uploadGuard.ts)
--   home-photos      unchanged at 15MB (matches every client that writes to it)
--
-- WHAT THIS DOES NOT FIX. Supabase checks allowed_mime_types against the
-- request's Content-Type header, which the browser copies from the client-side
-- File.type. So the MIME list below stops an honest mistake, not a crafted
-- upload. The real type check reads the file's magic bytes and lives in
-- src/lib/uploadGuard.ts; it is wired into /api/pro-compliance today, and the
-- direct-to-storage paths above cannot use it until their uploads are routed
-- through a server handler. That is a code change, not a paste, and it is
-- written up in the S2 report.
--
-- Safe to run twice. Nothing is dropped, no object is touched, only three
-- numbers on three bucket rows change.

update storage.buckets
   set file_size_limit = 5242880,  -- 5MB
       allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp']
 where id = 'pro-logos';

update storage.buckets
   set file_size_limit = 10485760,  -- 10MB
       allowed_mime_types =
         array['image/png', 'image/jpeg', 'image/webp', 'application/pdf']
 where id = 'pro-docs';

update storage.buckets
   set file_size_limit = 15728640,  -- 15MB, unchanged; restated so all three
                                    -- buckets are set from one place
       allowed_mime_types =
         array['image/png', 'image/jpeg', 'image/webp', 'application/pdf']
 where id = 'home-photos';

-- Result. Copy this back: three rows, public=false for home-photos and
-- pro-docs, public=true for pro-logos only.
select id, public, file_size_limit, allowed_mime_types
  from storage.buckets
 order by id;
