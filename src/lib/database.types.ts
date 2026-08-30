// Hand-written to match supabase/migrations. Once the Supabase CLI is wired up
// you can regenerate this exactly with:  npm run db:types
// (which runs `supabase gen types typescript --local`).

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

// contractors.license_verify_detail (migration 0055): what src/lib/cslb.ts's
// CslbLookupResult carries onto the row, minus the outcome itself (that's
// license_verified_status). Set on both a 'verified' and a 'failed' check;
// left alone on an 'error' outcome.
export interface CslbVerifyDetail {
  businessName: string | null;
  statusText: string | null;
  classifications: string[] | null;
  expires: string | null;
  // When the check ran. Written on every decided outcome since 0055's app code
  // shipped; it is what the "already checked recently" debounce in
  // src/app/pro/actions.ts reads.
  checked_at?: string | null;
  // Why a 'failed' status is failed, when the reason is NOT the CSLB status
  // sentence itself (migration 0125). 'name_mismatch': the license is active,
  // but CSLB registered it under a name that does not line up with this
  // account (src/lib/licenseMatch.ts). 'duplicate_license': the number is
  // already verified on another Hearth account - deliberately says nothing
  // about which one. 'duplicate_license_demoted_0125': written by migration
  // 0125's cleanup onto the later claimants of a number that had been verified
  // more than once before the unique index existed. Absent on an ordinary
  // CSLB-said-no failure.
  failure_reason?:
    | "name_mismatch"
    | "duplicate_license"
    | "duplicate_license_demoted_0125"
    | null;
}

// contractors.background_check_detail (migration 0057): report id, package
// slug, completed_at, and the last processed webhook event id (for replay
// dedupe in src/app/api/checkr/webhook). NEVER the report contents - Hearth
// stores status, not findings. All fields optional: an 'invited'/'none'
// contractor has no report yet, and every branch merges onto whatever was
// already here rather than replacing it wholesale.
export interface BackgroundCheckDetail {
  report_id?: string | null;
  package?: string | null;
  completed_at?: string | null;
  last_event_id?: string | null;
}

// One line item read off a pro's past invoice or quote. All monetary values
// are kept as strings, exactly as printed on the source document: nothing
// here is recomputed.
export interface ProPastJobLineItem {
  label: string;
  category: string;
  quantity: string | null;
  unit_price: string | null;
  line_total: string | null;
}

// One line item on a structured quote sent in chat (lead_quotes.line_items).
// amount_cents is the only money value stored per item; it is computed once,
// server side, from the dollar string the pro typed.
export interface QuoteLineItem {
  label: string;
  amount_cents: number;
}

// One line item on an invoice sent in chat (invoices.line_items). Same
// cents-only convention as QuoteLineItem, computed once server side from the
// dollar string the pro typed.
export interface InvoiceLineItem {
  description: string;
  amount_cents: number;
}

export interface Database {
  public: {
    Tables: {
      users: {
        Row: {
          id: string;
          email: string | null;
          phone: string | null;
          full_name: string | null;
          notification_prefs: { [key: string]: boolean } | null;
          free_quote_used_at: string | null;
          // One free maintenance-plan build for non-Plus users (migration
          // 0099), mirroring free_quote_used_at. Null while unused.
          free_plan_used_at: string | null;
          // Lifetime free AI reads a non-Plus account has spent on the
          // document vault and the inspection import (migration 0135). Counts,
          // not timestamps, because the document taste is two reads. Written
          // only by claim_free_ai_taste / refund_free_ai_taste; see
          // src/lib/freeAiTaste.ts.
          free_doc_reads_used: number;
          free_inspection_reads_used: number;
          // TCPA SMS consent (migration 0073): sms_consent_at only moves
          // forward on a false -> true transition (see
          // src/app/(app)/account/actions.ts saveAccountAction).
          sms_consent: boolean;
          sms_consent_at: string | null;
          // First-run app guide (migration 0137), one stamp per side: null
          // until the account has closed that side's guide, which is what
          // keeps it from reappearing on their other device.
          guide_seen_at: string | null;
          pro_guide_seen_at: string | null;
          created_at: string;
        };
        Insert: {
          id: string;
          email?: string | null;
          phone?: string | null;
          full_name?: string | null;
          notification_prefs?: { [key: string]: boolean } | null;
          free_quote_used_at?: string | null;
          free_plan_used_at?: string | null;
          free_doc_reads_used?: number;
          free_inspection_reads_used?: number;
          sms_consent?: boolean;
          sms_consent_at?: string | null;
          guide_seen_at?: string | null;
          pro_guide_seen_at?: string | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["users"]["Insert"]>;
        Relationships: [];
      };
      properties: {
        Row: {
          id: string;
          user_id: string;
          parcel_id: string | null;
          address_line1: string;
          // Condo/townhome unit (migration 0127). Deliberately NOT folded into
          // address_line1: that column stays the street line the parcel lookup
          // and the assessor ownership match run against, and the unit is
          // appended for display only (formatAddressLine in src/lib/property.ts).
          unit: string | null;
          city: string | null;
          state: string | null;
          zip: string | null;
          year_built: number | null;
          sqft: number | null;
          beds: number | null;
          baths: number | null;
          lot_size_sqft: number | null;
          property_type: string | null;
          purchase_date: string | null;
          // Self-attested at claim time (MVP-era), superseded by
          // ownership_status below. Server-locked (migration 0093) - a
          // client write is silently reverted, never trusted.
          ownership_verified: boolean;
          // Server-verified ownership match against the county assessor
          // record (migration 0093, src/lib/ownershipMatch.ts). Locked
          // against client writes the same way; only
          // record_ownership_check() (a service-role RPC) may set these.
          ownership_status: string;
          ownership_owner_names: Json | null;
          ownership_owner_type: string | null;
          ownership_owner_occupied: boolean | null;
          ownership_checked_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          parcel_id?: string | null;
          address_line1: string;
          unit?: string | null;
          city?: string | null;
          state?: string | null;
          zip?: string | null;
          year_built?: number | null;
          sqft?: number | null;
          beds?: number | null;
          baths?: number | null;
          lot_size_sqft?: number | null;
          property_type?: string | null;
          purchase_date?: string | null;
          ownership_verified?: boolean;
          ownership_status?: string;
          ownership_owner_names?: Json | null;
          ownership_owner_type?: string | null;
          ownership_owner_occupied?: boolean | null;
          ownership_checked_at?: string | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["properties"]["Insert"]>;
        Relationships: [];
      };
      system_lifespans: {
        Row: { system_type: string; expected_lifespan_years: number; label: string };
        Insert: { system_type: string; expected_lifespan_years: number; label: string };
        Update: Partial<Database["public"]["Tables"]["system_lifespans"]["Insert"]>;
        Relationships: [];
      };
      home_systems: {
        Row: {
          id: string;
          property_id: string;
          system_type: string;
          material_or_model: string | null;
          model_number: string | null;
          capacity: string | null;
          install_year: number | null;
          last_serviced: string | null;
          condition_rating: number | null;
          expected_lifespan_years: number | null;
          notes: string | null;
          created_at: string;
          confirmed_at: string | null;
        };
        Insert: {
          id?: string;
          property_id: string;
          system_type: string;
          material_or_model?: string | null;
          model_number?: string | null;
          capacity?: string | null;
          install_year?: number | null;
          last_serviced?: string | null;
          condition_rating?: number | null;
          expected_lifespan_years?: number | null;
          notes?: string | null;
          created_at?: string;
          confirmed_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["home_systems"]["Insert"]>;
        Relationships: [];
      };
      maintenance_tasks: {
        Row: {
          id: string;
          property_id: string;
          system_id: string | null;
          title: string;
          due_date: string | null;
          recurrence: string;
          status: string;
          completed_at: string | null;
          reminded_upcoming_at: string | null;
          reminded_overdue_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          property_id: string;
          system_id?: string | null;
          title: string;
          due_date?: string | null;
          recurrence?: string;
          status?: string;
          completed_at?: string | null;
          reminded_upcoming_at?: string | null;
          reminded_overdue_at?: string | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["maintenance_tasks"]["Insert"]>;
        Relationships: [];
      };
      issues: {
        Row: {
          id: string;
          property_id: string;
          system_id: string | null;
          category: string;
          severity: string;
          description: string | null;
          status: string;
          converted_to_lead: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          property_id: string;
          system_id?: string | null;
          category: string;
          severity: string;
          description?: string | null;
          status?: string;
          converted_to_lead?: boolean;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["issues"]["Insert"]>;
        Relationships: [];
      };
      photos: {
        Row: {
          id: string;
          property_id: string;
          related_type: string;
          related_id: string;
          url: string;
          uploaded_at: string;
        };
        Insert: {
          id?: string;
          property_id: string;
          related_type: string;
          related_id: string;
          url: string;
          uploaded_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["photos"]["Insert"]>;
        Relationships: [];
      };
      improvements: {
        Row: {
          id: string;
          property_id: string;
          system_id: string | null;
          improvement_type: string;
          description: string | null;
          completed_date: string | null;
          cost: number | null;
          permit_id: string | null;
          source: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          property_id: string;
          system_id?: string | null;
          improvement_type: string;
          description?: string | null;
          completed_date?: string | null;
          cost?: number | null;
          permit_id?: string | null;
          source?: string;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["improvements"]["Insert"]>;
        Relationships: [];
      };
      contractors: {
        Row: {
          id: string;
          user_id: string | null;
          name: string;
          license_number: string | null;
          license_expires: string | null;
          license_doc_path: string | null;
          insurance_doc_path: string | null;
          // license_verified_status: migration 0037. license_verified_at /
          // license_verify_detail: migration 0055 (real CSLB verification).
          license_verified_status: "unverified" | "pending" | "verified" | "failed";
          license_verified_at: string | null;
          license_verify_detail: CslbVerifyDetail | null;
          // Checkr background check (migration 0057). Opt-in, Hearth-paid;
          // dormant without CHECKR_API_KEY (src/lib/checkr.ts).
          background_check_status: "none" | "invited" | "pending" | "clear" | "consider";
          background_checked_at: string | null;
          checkr_candidate_id: string | null;
          background_check_detail: BackgroundCheckDetail | null;
          categories: string[] | null;
          service_area: string | null;
          // Launch-market gate: open_jobs_for_me / browse_pros / apply paths
          // all filter on it, and requestProAction re-checks it app-side.
          serves_orange_county: boolean | null;
          // Migration 0124: the per-city half of the launch gate, from the
          // signup/profile checkboxes (LAUNCH_CITY_NAMES in
          // src/lib/serviceArea.ts; widened from two cities to nine by 0126).
          // open_jobs_for_me and apply_to_lead filter the job's ZIP against it.
          // Nullable here because a database that has not run 0124 yet returns
          // no column at all (the missing-column retries treat that as "skip").
          launch_cities: string[] | null;
          // Migration 0141: the business owner's own name, shown under the
          // company name on the public /p/<id> page. Nullable, and nullable
          // here for the same reason launch_cities is: a database that has not
          // run 0141 yet returns no column at all, which the missing-column
          // retries in src/app/pro/actions.ts treat as "skip this field".
          owner_name: string | null;
          contact_email: string | null;
          contact_phone: string | null;
          vetted: boolean;
          rating: number | null;
          review_count: number;
          // Migration 0113: the pro's own Yelp / Google review pages, linked
          // out to from the public profile. Hearth never imports the review
          // text or star counts, it just points at them.
          yelp_url: string | null;
          google_reviews_url: string | null;
          balance: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string | null;
          name: string;
          license_number?: string | null;
          license_expires?: string | null;
          license_doc_path?: string | null;
          insurance_doc_path?: string | null;
          license_verified_status?: "unverified" | "pending" | "verified" | "failed";
          license_verified_at?: string | null;
          license_verify_detail?: CslbVerifyDetail | null;
          background_check_status?: "none" | "invited" | "pending" | "clear" | "consider";
          background_checked_at?: string | null;
          checkr_candidate_id?: string | null;
          background_check_detail?: BackgroundCheckDetail | null;
          categories?: string[] | null;
          service_area?: string | null;
          launch_cities?: string[] | null;
          owner_name?: string | null;
          contact_email?: string | null;
          contact_phone?: string | null;
          vetted?: boolean;
          rating?: number | null;
          review_count?: number;
          balance?: number;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["contractors"]["Insert"]>;
        Relationships: [];
      };
      wallet_config: {
        Row: {
          id: number;
          min_bonus_deposit_cents: number;
          bonus_expiry_days: number;
          spend_cash_first: boolean;
        };
        Insert: {
          id?: number;
          min_bonus_deposit_cents?: number;
          bonus_expiry_days?: number;
          spend_cash_first?: boolean;
        };
        Update: Partial<
          Database["public"]["Tables"]["wallet_config"]["Insert"]
        >;
        Relationships: [];
      };
      deposit_tiers: {
        Row: {
          id: string;
          min_cents: number;
          max_cents: number | null;
          bonus_pct: number;
        };
        Insert: {
          id?: string;
          min_cents: number;
          max_cents?: number | null;
          bonus_pct: number;
        };
        Update: Partial<
          Database["public"]["Tables"]["deposit_tiers"]["Insert"]
        >;
        Relationships: [];
      };
      wallets: {
        Row: {
          id: string;
          contractor_id: string;
          cash_balance_cents: number;
          bonus_balance_cents: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          contractor_id: string;
          cash_balance_cents?: number;
          bonus_balance_cents?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["wallets"]["Insert"]>;
        Relationships: [];
      };
      bonus_grants: {
        Row: {
          id: string;
          wallet_id: string;
          amount_cents: number;
          remaining_cents: number;
          expires_at: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          wallet_id: string;
          amount_cents: number;
          remaining_cents: number;
          expires_at: string;
          created_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["bonus_grants"]["Insert"]
        >;
        Relationships: [];
      };
      wallet_transactions: {
        Row: {
          id: string;
          wallet_id: string;
          type: string;
          cash_delta_cents: number;
          bonus_delta_cents: number;
          cash_balance_after_cents: number;
          bonus_balance_after_cents: number;
          lead_id: string | null;
          note: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          wallet_id: string;
          type: string;
          cash_delta_cents?: number;
          bonus_delta_cents?: number;
          cash_balance_after_cents: number;
          bonus_balance_after_cents: number;
          lead_id?: string | null;
          note?: string | null;
          created_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["wallet_transactions"]["Insert"]
        >;
        Relationships: [];
      };
      message_reactions: {
        Row: {
          id: string;
          message_id: string;
          lead_id: string;
          user_id: string | null;
          emoji: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          message_id: string;
          lead_id: string;
          user_id?: string | null;
          emoji: string;
          created_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["message_reactions"]["Insert"]
        >;
        Relationships: [];
      };
      lead_reads: {
        Row: {
          id: string;
          lead_id: string;
          role: string;
          read_at: string;
        };
        Insert: {
          id?: string;
          lead_id: string;
          role: string;
          read_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["lead_reads"]["Insert"]>;
        Relationships: [];
      };
      contractor_leads: {
        Row: {
          id: string;
          property_id: string;
          issue_id: string | null;
          contractor_id: string | null;
          category: string;
          status: string;
          payout_amount: number | null;
          homeowner_name: string | null;
          homeowner_email: string | null;
          homeowner_phone: string | null;
          property_address: string | null;
          issue_description: string | null;
          issue_severity: string | null;
          timing: string | null;
          paid: boolean;
          paid_at: string | null;
          direct_to: string | null;
          direct_declined_at: string | null;
          direct_unlocked_at: string | null;
          // 0114: major-tier project scope, nullable - only ever set for a
          // major-tier category (roof/structural/remodeling); null on every
          // other job and on every row from before this migration.
          square_footage: number | null;
          material_notes: string | null;
          has_plans_permits: boolean | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          property_id: string;
          issue_id?: string | null;
          contractor_id?: string | null;
          category: string;
          status?: string;
          payout_amount?: number | null;
          homeowner_name?: string | null;
          homeowner_email?: string | null;
          homeowner_phone?: string | null;
          property_address?: string | null;
          issue_description?: string | null;
          issue_severity?: string | null;
          timing?: string | null;
          paid?: boolean;
          paid_at?: string | null;
          direct_to?: string | null;
          direct_declined_at?: string | null;
          direct_unlocked_at?: string | null;
          square_footage?: number | null;
          material_notes?: string | null;
          has_plans_permits?: boolean | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["contractor_leads"]["Insert"]>;
        Relationships: [];
      };
      lead_applications: {
        Row: {
          id: string;
          lead_id: string;
          contractor_id: string;
          message: string | null;
          status: string;
          fee_cents: number;
          refunded_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          lead_id: string;
          contractor_id: string;
          message?: string | null;
          status?: string;
          fee_cents?: number;
          refunded_at?: string | null;
          created_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["lead_applications"]["Insert"]
        >;
        Relationships: [];
      };
      intent_signals: {
        Row: {
          id: string;
          property_id: string;
          signal_type: string;
          value: string | null;
          shared_consent: boolean;
          captured_at: string;
        };
        Insert: {
          id?: string;
          property_id: string;
          signal_type: string;
          value?: string | null;
          shared_consent?: boolean;
          captured_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["intent_signals"]["Insert"]>;
        Relationships: [];
      };
      documents: {
        Row: {
          id: string;
          property_id: string;
          doc_type: string | null;
          file_url: string;
          title: string | null;
          brand: string | null;
          model: string | null;
          install_year: number | null;
          warranty_expires: string | null;
          system_type: string | null;
          summary: string | null;
          applied_at: string | null;
          uploaded_at: string;
        };
        Insert: {
          id?: string;
          property_id: string;
          doc_type?: string | null;
          file_url: string;
          title?: string | null;
          brand?: string | null;
          model?: string | null;
          install_year?: number | null;
          warranty_expires?: string | null;
          system_type?: string | null;
          summary?: string | null;
          applied_at?: string | null;
          uploaded_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["documents"]["Insert"]>;
        Relationships: [];
      };
      notifications: {
        Row: {
          id: string;
          user_id: string;
          kind: string;
          title: string;
          body: string | null;
          url: string | null;
          read_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          kind: string;
          title: string;
          body?: string | null;
          url?: string | null;
          read_at?: string | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["notifications"]["Insert"]>;
        Relationships: [];
      };
      support_messages: {
        Row: {
          id: string;
          user_id: string | null;
          name: string | null;
          email: string | null;
          phone: string | null;
          message: string;
          status: string;
          created_at: string;
          // Silent account match on public /contact messages (migration 0115).
          // UNVERIFIED triage hint: anyone can type someone else's email or
          // phone, so this never proves who sent the message. user_id stays
          // null on those rows - that null is what marks them anonymous.
          matched_user_id: string | null;
          matched_via: "email" | "phone" | "both" | null;
        };
        Insert: {
          id?: string;
          user_id?: string | null;
          name?: string | null;
          email?: string | null;
          phone?: string | null;
          message: string;
          status?: string;
          created_at?: string;
          matched_user_id?: string | null;
          matched_via?: string | null;
        };
        Update: Partial<
          Database["public"]["Tables"]["support_messages"]["Insert"]
        >;
        Relationships: [];
      };
      messages: {
        Row: {
          id: string;
          lead_id: string;
          sender_role: string;
          sender_id: string | null;
          body: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          lead_id: string;
          sender_role: string;
          sender_id?: string | null;
          body: string;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["messages"]["Insert"]>;
        Relationships: [];
      };
      reviews: {
        Row: {
          id: string;
          lead_id: string;
          contractor_id: string;
          property_id: string | null;
          rating: number;
          comment: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          lead_id: string;
          contractor_id: string;
          property_id?: string | null;
          rating: number;
          comment?: string | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["reviews"]["Insert"]>;
        Relationships: [];
      };
      reports: {
        Row: {
          id: string;
          // Nullable since migration 0138: a report about a review or a pro
          // profile has no chat thread behind it and names target_type/
          // target_id instead. Chat reports (0009) still fill this in.
          lead_id: string | null;
          reporter_id: string | null;
          reporter_role: string;
          reason: string | null;
          // 'review' | 'contractor', or null on a chat report (0138).
          target_type: string | null;
          target_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          lead_id?: string | null;
          reporter_id?: string | null;
          reporter_role: string;
          reason?: string | null;
          target_type?: string | null;
          target_id?: string | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["reports"]["Insert"]>;
        Relationships: [];
      };
      // Migration 0138. One row per "this account never wants to hear from
      // that account again". RLS is self-scoped to blocker_user_id =
      // auth.uid() for select/insert/delete, and there is no update grant.
      user_blocks: {
        Row: {
          id: string;
          blocker_user_id: string;
          blocked_user_id: string;
          reason: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          blocker_user_id: string;
          blocked_user_id: string;
          reason?: string | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["user_blocks"]["Insert"]>;
        Relationships: [];
      };
      household_members: {
        Row: {
          id: string;
          property_id: string;
          invited_email: string;
          member_user_id: string | null;
          status: string;
          invited_by: string;
          created_at: string;
          accepted_at: string | null;
        };
        Insert: {
          id?: string;
          property_id: string;
          invited_email: string;
          member_user_id?: string | null;
          status?: string;
          invited_by: string;
          created_at?: string;
          accepted_at?: string | null;
        };
        Update: Partial<
          Database["public"]["Tables"]["household_members"]["Insert"]
        >;
        Relationships: [];
      };
      household_invite_tokens: {
        Row: {
          token: string;
          property_id: string;
          created_by: string;
          created_at: string;
          expires_at: string;
          scanned_at: string | null;
        };
        Insert: {
          token?: string;
          property_id: string;
          created_by: string;
          created_at?: string;
          expires_at: string;
          scanned_at?: string | null;
        };
        Update: Partial<
          Database["public"]["Tables"]["household_invite_tokens"]["Insert"]
        >;
        Relationships: [];
      };
      pro_clients: {
        Row: {
          id: string;
          contractor_id: string;
          lead_id: string | null;
          client_name: string;
          stage: string;
          note: string | null;
          follow_up_on: string | null;
          phone: string | null;
          email: string | null;
          address: string | null;
          est_value_cents: number | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          contractor_id: string;
          lead_id?: string | null;
          client_name: string;
          stage?: string;
          note?: string | null;
          follow_up_on?: string | null;
          phone?: string | null;
          email?: string | null;
          address?: string | null;
          est_value_cents?: number | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["pro_clients"]["Insert"]>;
        Relationships: [];
      };
      pro_client_notes: {
        Row: {
          id: string;
          client_id: string;
          body: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          client_id: string;
          body: string;
          created_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["pro_client_notes"]["Insert"]
        >;
        Relationships: [];
      };
      pro_past_jobs: {
        Row: {
          id: string;
          contractor_id: string;
          doc_type: string;
          job_type: string | null;
          job_summary: string | null;
          document_date: string | null;
          location: string | null;
          line_items: ProPastJobLineItem[];
          subtotal: string | null;
          total: string | null;
          currency: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          contractor_id: string;
          doc_type?: string;
          job_type?: string | null;
          job_summary?: string | null;
          document_date?: string | null;
          location?: string | null;
          line_items?: ProPastJobLineItem[];
          subtotal?: string | null;
          total?: string | null;
          currency?: string | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["pro_past_jobs"]["Insert"]>;
        Relationships: [];
      };
      pro_tool_edits: {
        Row: {
          id: string;
          contractor_id: string;
          tool: string;
          original_text: string;
          edited_text: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          contractor_id: string;
          tool: string;
          original_text: string;
          edited_text: string;
          created_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["pro_tool_edits"]["Insert"]
        >;
        Relationships: [];
      };
      subscriptions: {
        Row: {
          id: string;
          user_id: string;
          stripe_customer_id: string | null;
          stripe_subscription_id: string | null;
          status: string;
          plan: string | null;
          current_period_end: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          stripe_customer_id?: string | null;
          stripe_subscription_id?: string | null;
          status?: string;
          plan?: string | null;
          current_period_end?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["subscriptions"]["Insert"]>;
        Relationships: [];
      };
      lead_quotes: {
        Row: {
          id: string;
          lead_id: string;
          contractor_id: string;
          total_cents: number;
          line_items: QuoteLineItem[];
          note: string | null;
          status: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          lead_id: string;
          contractor_id: string;
          total_cents: number;
          line_items?: QuoteLineItem[];
          note?: string | null;
          status?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["lead_quotes"]["Insert"]>;
        Relationships: [];
      };
      invoices: {
        Row: {
          id: string;
          lead_id: string;
          contractor_id: string;
          property_id: string;
          line_items: InvoiceLineItem[];
          subtotal_cents: number;
          total_cents: number;
          status: string;
          signed_at: string | null;
          signed_by: string | null;
          signature_method: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          lead_id: string;
          contractor_id: string;
          property_id: string;
          line_items?: InvoiceLineItem[];
          subtotal_cents: number;
          total_cents: number;
          status?: string;
          signed_at?: string | null;
          signed_by?: string | null;
          signature_method?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["invoices"]["Insert"]>;
        Relationships: [];
      };
      terms_acceptances: {
        Row: {
          id: string;
          user_id: string;
          doc: string;
          version: string;
          accepted_at: string;
          ip: string | null;
          user_agent: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          doc: string;
          version: string;
          accepted_at?: string;
          ip?: string | null;
          user_agent?: string | null;
        };
        Update: Partial<
          Database["public"]["Tables"]["terms_acceptances"]["Insert"]
        >;
        Relationships: [];
      };
      promo_claims: {
        Row: {
          user_id: string;
          promo_key: string;
          claimed_at: string;
          ref: string | null;
        };
        Insert: {
          user_id: string;
          promo_key: string;
          claimed_at?: string;
          ref?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["promo_claims"]["Insert"]>;
        Relationships: [];
      };
      rate_limits: {
        Row: {
          bucket: string;
          window_start: string;
          count: number;
        };
        Insert: {
          bucket: string;
          window_start: string;
          count?: number;
        };
        Update: Partial<Database["public"]["Tables"]["rate_limits"]["Insert"]>;
        Relationships: [];
      };
      parcel_cache: {
        Row: {
          cache_key: string;
          facts: Json;
          source: string;
          fetched_at: string;
        };
        Insert: {
          cache_key: string;
          facts: Json;
          source: string;
          fetched_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["parcel_cache"]["Insert"]>;
        Relationships: [];
      };
      app_events: {
        Row: {
          id: string;
          created_at: string;
          event: string;
          props: Json | null;
          user_id: string | null;
        };
        Insert: {
          id?: string;
          created_at?: string;
          event: string;
          props?: Json | null;
          user_id?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["app_events"]["Insert"]>;
        Relationships: [];
      };
      quote_analyses: {
        Row: {
          id: string;
          user_id: string;
          status: string;
          quote_filename: string | null;
          findings: Json | null;
          error: string | null;
          created_at: string;
          finished_at: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          status?: string;
          quote_filename?: string | null;
          findings?: Json | null;
          error?: string | null;
          created_at?: string;
          finished_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["quote_analyses"]["Insert"]>;
        Relationships: [];
      };
      // Trial-abuse risk scoring (migration 0130). All three tables are
      // SERVICE ROLE ONLY: RLS is on with no policies for anon/authenticated,
      // and their privileges are revoked on top of that. They are typed here for
      // reference and for anyone who drops the untyped admin client in
      // src/lib/risk/*, not because any user-scoped client can reach them.
      //
      // account_signals stores only SALTED HASHES (see src/lib/risk/hash.ts).
      // No raw IP, device id, card fingerprint, phone, parcel or email is ever
      // written to it.
      account_signals: {
        Row: {
          user_id: string;
          kind: string;
          value_hash: string;
          first_seen: string;
          last_seen: string;
          context: string | null;
          salt_version: number;
        };
        Insert: {
          user_id: string;
          kind: string;
          value_hash: string;
          first_seen?: string;
          last_seen?: string;
          context?: string | null;
          salt_version?: number;
        };
        Update: Partial<
          Database["public"]["Tables"]["account_signals"]["Insert"]
        >;
        Relationships: [];
      };
      account_risk: {
        Row: {
          user_id: string;
          score: number;
          level: string;
          reasons: Json;
          computed_at: string;
        };
        Insert: {
          user_id: string;
          score?: number;
          level?: string;
          reasons?: Json;
          computed_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["account_risk"]["Insert"]>;
        Relationships: [];
      };
      abuse_flags: {
        Row: {
          user_id: string;
          kind: string;
          note: string | null;
          created_at: string;
        };
        Insert: {
          user_id: string;
          kind: string;
          note?: string | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["abuse_flags"]["Insert"]>;
        Relationships: [];
      };
      risk_overrides: {
        Row: {
          user_id: string;
          allow_trial: boolean;
          note: string | null;
          created_at: string;
        };
        Insert: {
          user_id: string;
          allow_trial: boolean;
          note?: string | null;
          created_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["risk_overrides"]["Insert"]
        >;
        Relationships: [];
      };
      app_feedback: {
        Row: {
          id: string;
          user_id: string;
          side: string;
          kind: string;
          message: string | null;
          contact_email: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          side?: string;
          kind: string;
          message?: string | null;
          contact_email?: string | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["app_feedback"]["Insert"]>;
        Relationships: [];
      };
      // One row per DEVICE that agreed to receive Web Push (migration 0143).
      // `endpoint` is unique, which is what the upsert in
      // src/app/api/push/subscribe keys on; p256dh/auth are the browser's
      // PUBLIC encryption keys, useless without the private half that never
      // leaves that device.
      push_subscriptions: {
        Row: {
          id: string;
          user_id: string;
          side: string | null;
          endpoint: string;
          p256dh: string;
          auth: string;
          user_agent: string | null;
          created_at: string;
          last_used_at: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          side?: string | null;
          endpoint: string;
          p256dh: string;
          auth: string;
          user_agent?: string | null;
          created_at?: string;
          last_used_at?: string | null;
        };
        Update: Partial<
          Database["public"]["Tables"]["push_subscriptions"]["Insert"]
        >;
        Relationships: [];
      };
    };
    Views: {
      lead_previews: {
        Row: {
          id: string;
          category: string;
          severity: string | null;
          lead_fee: number | null;
          area: string | null;
          created_at: string;
        };
        Relationships: [];
      };
    };
    Functions: {
      bump_ai_usage: {
        Args: { p_user: string; p_delta?: number };
        Returns: number;
      };
      // Migration 0135. Spend / hand back one lifetime free AI read on the
      // document vault or the inspection import. Service role only; see
      // src/lib/freeAiTasteServer.ts.
      claim_free_ai_taste: {
        Args: { p_user: string; p_feature: string; p_limit: number };
        Returns: boolean;
      };
      refund_free_ai_taste: {
        Args: { p_user: string; p_feature: string };
        Returns: undefined;
      };
      owns_property: {
        Args: { p_property_id: string };
        Returns: boolean;
      };
      is_active_member: {
        Args: { p_property_id: string };
        Returns: boolean;
      };
      can_access_lead: {
        Args: { p_lead_id: string };
        Returns: boolean;
      };
      can_preview_job_photo: {
        Args: { p_lead_id: string; p_photo_url: string };
        Returns: boolean;
      };
      can_view_job_photo_full: {
        Args: { p_lead_id: string; p_photo_url: string };
        Returns: boolean;
      };
      leave_review: {
        Args: { p_lead: string; p_rating: number; p_comment: string };
        Returns: undefined;
      };
      contractor_reviews: {
        Args: { p_contractor: string };
        Returns: {
          // Optional in the TYPE, not in the function: migration 0138 adds it,
          // and a live database still on 0137 returns rows without it. Every
          // reader treats a missing id as "no Report link for this row".
          id?: string;
          rating: number;
          comment: string | null;
          created_at: string;
        }[];
      };
      get_or_create_wallet: {
        Args: { p_contractor: string };
        Returns: string;
      };
      bonus_for_deposit: {
        Args: { p_deposit_cents: number };
        Returns: number;
      };
      apply_deposit: {
        Args: { p_contractor: string; p_deposit_cents: number };
        Returns: undefined;
      };
      charge_lead: {
        Args: { p_lead: string };
        Returns: boolean;
      };
      expire_bonus: {
        Args: Record<string, never>;
        Returns: undefined;
      };
      ghost_refund_application: {
        Args: { p_application: string };
        Returns: boolean;
      };
      ghost_refund_direct: {
        Args: { p_lead: string };
        Returns: boolean;
      };
      my_direct_requests: {
        Args: Record<string, never>;
        Returns: {
          id: string;
          category: string;
          timing: string | null;
          issue_description: string | null;
          issue_severity: string | null;
          payout_amount: number | null;
          fee_cents: number;
          budget_range: string | null;
          city: string | null;
          has_photos: boolean;
          photo_urls: string[] | null;
          created_at: string;
        }[];
      };
      unlock_direct_request: {
        Args: { p_lead: string };
        Returns: boolean;
      };
      decline_direct_request: {
        Args: { p_lead: string };
        Returns: undefined;
      };
      browse_pros: {
        Args: { p_category?: string | null };
        Returns: {
          id: string;
          slug: string | null;
          name: string;
          categories: string[];
          rating: number | null;
          review_count: number;
          has_license: boolean;
          license_verified_at: string | null;
          background_checked_at: string | null;
          logo_url: string | null;
          service_area: string | null;
          project_count: number;
        }[];
      };
      resolve_referral_code: {
        Args: { p_code: string };
        Returns: string | null;
      };
      rate_limit_hit: {
        Args: { p_bucket: string; p_limit: number; p_window_seconds: number };
        Returns: boolean;
      };
      claim_promo: {
        Args: { p_user: string; p_key: string; p_ref?: string | null };
        Returns: boolean;
      };
      has_claimed_promo: {
        Args: { p_key: string };
        Returns: boolean;
      };
      record_ownership_check: {
        Args: {
          p_property_id: string;
          p_status: string;
          p_owner_names: Json | null;
          p_owner_type: string | null;
          p_owner_occupied: boolean | null;
        };
        Returns: undefined;
      };
      open_jobs_for_me: {
        Args: Record<string, never>;
        Returns: {
          id: string;
          category: string;
          timing: string | null;
          issue_description: string | null;
          issue_severity: string | null;
          payout_amount: number | null;
          created_at: string;
          application_count: number;
          has_photos: boolean;
          plus_poster: boolean;
          budget_range: string | null;
          city: string | null;
          ownership_verified: boolean;
          photo_urls: string[] | null;
        }[];
      };
      // Migration 0115, service_role only. At most one row; no row means no
      // match. The result is an unverified triage hint, never proof of who
      // sent a contact message.
      match_support_contact: {
        Args: { p_email: string | null; p_phone: string | null };
        Returns: {
          user_id: string;
          matched_via: "email" | "phone" | "both";
        }[];
      };
      // Migration 0130, service_role only. Every OTHER account sharing any
      // non-email_domain signal value with p_user, and the kind of signal that
      // links them. A shared email DOMAIN is excluded on purpose: joining on it
      // would link every gmail.com account to every other one.
      linked_accounts: {
        Args: { p_user: string };
        Returns: {
          user_id: string;
          kind: string;
        }[];
      };
      redeem_household_invite_token: {
        Args: { p_token: string };
        Returns: {
          ok: boolean;
          property_id: string | null;
          member_id: string | null;
          already_member: boolean | null;
          reason: string | null;
        }[];
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}

// Convenience row aliases used across the app.
type T = Database["public"]["Tables"];
export type UserProfile = T["users"]["Row"];
export type Property = T["properties"]["Row"];
export type HomeSystem = T["home_systems"]["Row"];
export type MaintenanceTask = T["maintenance_tasks"]["Row"];
export type Issue = T["issues"]["Row"];
export type Contractor = T["contractors"]["Row"];
export type ContractorLead = T["contractor_leads"]["Row"];
export type SystemLifespan = T["system_lifespans"]["Row"];
export type Subscription = T["subscriptions"]["Row"];
export type HouseholdMember = T["household_members"]["Row"];
export type HouseholdInviteToken = T["household_invite_tokens"]["Row"];
export type ProClient = T["pro_clients"]["Row"];
export type ProClientNote = T["pro_client_notes"]["Row"];
export type ProPastJob = T["pro_past_jobs"]["Row"];
export type ProToolEdit = T["pro_tool_edits"]["Row"];
export type LeadQuote = T["lead_quotes"]["Row"];
export type Invoice = T["invoices"]["Row"];
