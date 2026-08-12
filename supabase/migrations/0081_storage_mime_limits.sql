-- =============================================================================
-- Hearth - server-side MIME/size limits on storage buckets (0079)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- HIGH (file-upload audit). None of the three existing buckets enforce a
-- content type or size at the storage layer - only client-side JS checks
-- (`file.type.startsWith("image/")`, an `accept=` hint) do, and both are
-- trivially bypassed by anyone calling the storage API directly with the
-- user's own session. Today that means an authenticated user (homeowner or
-- pro) can upload `image/svg+xml` (an SVG can carry a <script> - stored XSS
-- served off Hearth's own storage/proxy domain) or any other file into a
-- bucket dressed up as a photo. This sets `allowed_mime_types` and
-- `file_size_limit` on each bucket so Supabase Storage itself rejects
-- anything outside the allow-list, regardless of what the client claims.
--
-- Bucket ids verified against the migrations that created them:
--   home-photos  - 0004_storage.sql (created public:true),
--                  made private by 0021_private_storage.sql
--   pro-logos    - 0033_pro_public_page.sql (public, logo images)
--   pro-docs     - 0051_pro_compliance.sql (private, license/COI uploads)
--
-- image/svg+xml is NEVER included in any list below, on purpose.
--
-- ⚠️ DEVIATION FROM THE LITERAL SPEC, FLAGGED FOR THE HUMAN REVIEWER ⚠️
-- ---------------------------------------------------------------------------
-- home-photos is NOT image-only in the current app. src/components/
-- DocumentUpload.tsx (the home vault's "add a document" flow) uploads BOTH
-- photos and PDFs into this same bucket, at `${propertyId}/docs/<uuid>.<ext>`
-- (see its `accept="image/*,application/pdf"` input and the literal
-- `.from("home-photos").upload(...)` call at DocumentUpload.tsx:134). This
-- is the feature 0021's own header comment calls out by name - "home
-- documents (inspection reports, invoices, warranties)". Restricting
-- home-photos to image/png,image/jpeg,image/webp only (as a literal reading
-- of "images only" would suggest) would break every warranty/manual/receipt/
-- inspection-report PDF upload in production. So home-photos below allows
-- application/pdf alongside the three image types; pro-logos does not (its
-- only writers, LogoUpload.tsx and ProjectPhotoManager.tsx, are
-- `accept="image/*"` only, no PDF path exists into that bucket).
--
-- pro-docs already allows PDFs per the task spec, confirmed against its own
-- upload path (src/app/api/pro-compliance/route.ts sets `contentType: mime`
-- from the uploaded file, and src/components/pro/ComplianceCard.tsx's input
-- is `accept="image/*,.pdf"`).
--
-- Size: 15728640 bytes (15MB) matches the client-side MAX_BYTES already
-- enforced by PhotoUpload.tsx, ProjectPhotoManager.tsx,
-- (app)/emergency/PrepPhotoUpload.tsx, and DocumentUpload.tsx (all 15MB).
-- LogoUpload.tsx's own cap is tighter (5MB) but a bucket-level ceiling only
-- needs to be >= the tightest legitimate use, so 15MB is a safe backstop
-- there too, not a regression.
--
-- Safe to re-run.
-- =============================================================================

update storage.buckets
   set allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp', 'application/pdf'],
       file_size_limit     = 15728640
 where id = 'home-photos';

update storage.buckets
   set allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp'],
       file_size_limit     = 15728640
 where id = 'pro-logos';

update storage.buckets
   set allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp', 'application/pdf'],
       file_size_limit     = 15728640
 where id = 'pro-docs';
