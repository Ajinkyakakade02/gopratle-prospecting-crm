# GoPratle Prospecting CRM — Supabase Dashboard Deployment Guide

This guide provides the complete, authoritative instructions for deploying GoPratle Prospecting CRM (Phase 1 & Phase 2) to a new or existing Supabase project using the **Supabase Dashboard**.

> **Supabase Project Reference:** `[YOUR_SUPABASE_PROJECT_REF]` *(e.g. `vnhulnzcxhhexvainfjp` for the current development project)*
> **Google Cloud Project:** `GoPratle Prospecting CRM`
> **Calendar API Scope:** `https://www.googleapis.com/auth/calendar.events`

> [!IMPORTANT]
> **Configurable Project Reference Notice:**
> Do **not** assume `vnhulnzcxhhexvainfjp` is the project reference for your target deployment environment. Look up your actual project reference in your Supabase Dashboard URL (`https://supabase.com/dashboard/project/<your-project-ref>`) and replace `[YOUR_SUPABASE_PROJECT_REF]` throughout all redirect URIs, API URLs, and deployment commands.

---

## 1. Database Execution Order

> **CRITICAL WARNING — EXECUTE ONLY ONE METHOD:**  
> **DO NOT execute Option A and Option B together!**  
> • **Option A (Consolidated Declarative Schemas)** builds the complete, final GoPratle CRM schema in 8 clean steps for fresh projects via the Supabase Dashboard SQL Editor.  
> • **Option B (Incremental Migrations)** applies the 36 historical migrations sequentially (for CLI `supabase db push` or incremental database tracking).  
> Running both will cause `relation already exists` conflicts. Choose **Option A** for a new Supabase project setup in the Dashboard.

### Recommended Method: Consolidated Declarative Schemas (Option A)
The consolidated schema files in `supabase/schemas/` contain the complete, up-to-date GoPratle Prospecting CRM database structure (including the 5-stage contact pipeline, `lead_source`, Google Calendar connection tables, and follow-up sync fields with canonical `google_event_status IN ('unsynced', 'synced', 'failed')`).

Run each file in a **new query window** in the following order:

| Step | File Path | Responsibilities & Baseline Dependencies |
| :--- | :--- | :--- |
| **1** | `supabase/schemas/01_tables.sql` | **Extensions & Tables:**<br>• Enables extensions: `http`, `citext`, `pgcrypto`, `pgjwt`, `pg_net`, `unaccent`.<br>• Creates schema `private`.<br>• Creates tables: `sales`, `companies`, `contacts` (with `lead_source`), `contact_notes`, `deals`, `deal_notes`, `tags`, `tasks` (with `google_event_id`, `google_event_link`, `google_event_status DEFAULT 'unsynced'`, `google_event_error`), `google_calendar_connections`, `google_calendar_oauth_states`, `configuration`, `favicons_excluded_domains`, `user_invitations`.<br>• Adds foreign keys and composite indexes. |
| **2** | `supabase/schemas/02_functions.sql` | **Functions:**<br>• User handling: `handle_new_user()`, `handle_update_user()`, `set_sales_id_default()`, `is_admin()`.<br>• Data transformers: `lowercase_email_jsonb()`, `handle_contact_saved()`, `handle_company_saved()`, `cleanup_note_attachments()`. |
| **3** | `supabase/schemas/03_views.sql` | **Views:**<br>• `init_state`: App configuration & user state.<br>• `companies_summary`: Aggregates contacts and deals per company.<br>• `contacts_summary`: Contact metadata including `lead_source`, tags, and notes.<br>• `activity_log`: Unified activity history feed across contacts and deals. |
| **4** | `supabase/schemas/04_triggers.sql` | **Triggers:**<br>• `set_*_sales_id_trigger`: Auto-assigns authenticated user's sales profile.<br>• `on_auth_user_created`: Triggers `handle_new_user()` when a new user signs up.<br>• Avatar, favicon, and contact note timestamp triggers. |
| **5** | `supabase/schemas/05_policies.sql` | **Row Level Security (RLS):**<br>• Enables RLS on all public tables.<br>• Creates authenticated user policies for CRM resources.<br>• Restricts `google_calendar_connections` and `google_calendar_oauth_states` to `auth.uid() = user_id`. |
| **6** | `supabase/schemas/06_grants.sql` | **Grants:**<br>• Grants schema usage to `anon`, `authenticated`, and `service_role`.<br>• Grants table, view, sequence, and function execution permissions. |
| **7** | `supabase/schemas/07_storage.sql` | **Storage:**<br>• Creates `attachments` storage bucket.<br>• Sets storage object RLS policies for authenticated users. |
| **8** | `supabase/schemas/08_search.sql` | **Full-Text Global Search:**<br>• Full-text search functions, indexes, and weighted search rank. |

---

### Alternative Method: Incremental Migrations Execution Order
If applying via migration history or Supabase CLI (`supabase db push`), execute all 36 migration files from `supabase/migrations/` in strict chronological order:

1. `20240730075029_init_db.sql` *(Initial schema)*
2. `20240730075425_init_triggers.sql`
3. `20240806124555_task_sales_id.sql`
4. `20240807082449_remove-aquisition.sql`
5. `20240808141826_init_state_configure.sql`
6. `20240813084010_tags_policy.sql`
7. `20241104153231_sales_policies.sql`
8. `20250109152531_email_jsonb.sql`
9. `20250113132531_phone_jsonb.sql`
10. `20251204172855_merge_contacts_function.sql`
11. `20251204201317_drop_merge_contacts_function.sql`
12. `20260108160722_task_default_sales.sql`
13. `20260115150819_snake_case_renaming.sql`
14. `20260127140209_imports.sql`
15. `20260128165057_sso_handling.sql`
16. `20260211194545_app_configuration.sql`
17. `20260226163952_deals_expected_closing_date_date_only.sql`
18. `20260304104600_note_attachments_trigger.sql`
19. `20260307120000_nb_tasks_pending_only.sql`
20. `20260309112831_fix_security_warnings.sql`
21. `20260314120000_activity_log_view.sql`
22. `20260320120000_lowercase_email_website.sql`
23. `20260601120000_grant_init_state_to_api_roles.sql`
24. `20260811131131_sales_secondary_emails.sql`
25. `20260924120000_deals_lost_reason.sql`
26. `20260928120000_drop_deals_lost_reason.sql`
27. `20260929120000_remove_deleted_tag_from_contacts.sql`
28. `20261010054346_global_search.sql`
29. `20261022120000_global_search_per_resource_cap.sql`
30. `20261026120000_deal_categories.sql`
31. `20261030125021_user_invitations.sql`
32. `20261102084227_global_search_rank_name_matches.sql`
33. `20261105134224_deals_expected_closing_date_range.sql`
34. `20261109180000_fetch_favicon_ico.sql`
35. `20261120190000_contact_lead_source.sql` *(Phase 1: Adds lead_source to contacts)*
36. `20261120200000_google_calendar_integration.sql` *(Phase 2: Adds Google Calendar connections, OAuth states, and task sync columns)*

---

## 2. Supabase Secrets Configuration

Before deploying the Edge Functions, set the required environment secrets in the Supabase Dashboard:

1. Navigate to: **Project Settings → Edge Functions → Secrets** (`https://supabase.com/dashboard/project/[YOUR_SUPABASE_PROJECT_REF]/settings/functions`).
2. Add the following secrets by variable name:

| Secret Name | Required | Description | Example / Notes |
| :--- | :---: | :--- | :--- |
| `GOOGLE_CLIENT_ID` | **Yes** | Google OAuth 2.0 Client ID from Google Cloud Console | `xxxxxx.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | **Yes** | Google OAuth 2.0 Client Secret from Google Cloud Console | Keep strictly confidential on server |
| `GOOGLE_CALENDAR_ENCRYPTION_KEY` | **Yes** | High-entropy master secret key for AES-256-GCM token encryption at rest | Minimum 32 characters (e.g. generated via `openssl rand -hex 32`) |
| `CRM_FRONTEND_URL` | **Yes** | Base URL of the GoPratle CRM web application | `http://localhost:5173` (dev) or `https://crm.yourdomain.com` (prod) |
| `ALLOWED_REDIRECT_ORIGINS` | Optional | Additional trusted production origins (comma-separated) | `https://staging.yourdomain.com, https://app.yourdomain.com` |
| `ENVIRONMENT` | Optional | Environment mode flag | Set to `development` to allow `localhost` / `127.0.0.1` redirects; defaults to strict production |
| `GOOGLE_CALENDAR_REDIRECT_URI` | Optional | Explicit redirect URI (defaults to `<SUPABASE_URL>/functions/v1/google-calendar-callback` if unset) | `https://[YOUR_SUPABASE_PROJECT_REF].supabase.co/functions/v1/google-calendar-callback` |

> **Note on Built-in Supabase Secrets:**  
> `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SB_PUBLISHABLE_KEY` are injected automatically by the Supabase Edge Runtime.

---

## 3. Edge Function Deployment

### The Four Google Calendar Edge Functions

| Function Name | JWT Verification Setting | Purpose |
| :--- | :---: | :--- |
| `google-calendar-connect` | **OFF** *(handled in-code)* | Initiates OAuth flow, creates CSRF state, returns Google Auth URL |
| `google-calendar-callback` | **MUST BE OFF (Disabled)** | Receives Google redirect (`code`, `state`), consumes state, exchanges tokens, encrypts tokens, redirects to frontend |
| `google-calendar-create-event` | **OFF** *(handled in-code)* | Schedules/updates calendar event for task, verifies task ownership, formats Asian timezone |
| `google-calendar-disconnect` | **OFF** *(handled in-code)* | Revokes Google token and removes connection record from database |

> **CRITICAL: Why `google-calendar-callback` JWT Verification MUST BE OFF:**  
> When the user authorizes the app in Google, Google's servers redirect the browser directly to `https://[YOUR_SUPABASE_PROJECT_REF].supabase.co/functions/v1/google-calendar-callback?code=...&state=...`. Google does NOT provide a Supabase Authorization header. If Gateway JWT verification is enabled, Supabase will reject the redirect with a `401 Unauthorized` before the code can run. The endpoint is protected against CSRF via the single-use cryptographic `state` token verified against Postgres.

---

### Deployment Option A: Supabase Dashboard In-Browser Editor (Recommended for Dashboard)

The Supabase Dashboard editor only accepts a single `index.ts` file per function and cannot resolve relative imports like `../_shared/`. Pre-bundled, self-contained standalone files are available in `supabase/functions/dashboard-standalone/`.

1. Go to **Edge Functions** in your Supabase Dashboard: `https://supabase.com/dashboard/project/[YOUR_SUPABASE_PROJECT_REF]/functions`.
2. Click **Create Function**.
3. For each of the 4 functions:
   - **Function 1:** Name: `google-calendar-connect`  
     Copy all code from [dashboard-standalone/google-calendar-connect/index.ts](file:///c:/Users/Acer/INTERNSHIP%20PROJECT/gopratle-prospecting-crm/atomic-crm/supabase/functions/dashboard-standalone/google-calendar-connect/index.ts) → Paste into the editor → Ensure "Enforce JWT Verification" is unchecked → Click **Deploy**.
   - **Function 2:** Name: `google-calendar-callback`  
     Copy all code from [dashboard-standalone/google-calendar-callback/index.ts](file:///c:/Users/Acer/INTERNSHIP%20PROJECT/gopratle-prospecting-crm/atomic-crm/supabase/functions/dashboard-standalone/google-calendar-callback/index.ts) → Paste into the editor → Ensure "Enforce JWT Verification" is **unchecked (disabled)** → Click **Deploy**.
   - **Function 3:** Name: `google-calendar-create-event`  
     Copy all code from [dashboard-standalone/google-calendar-create-event/index.ts](file:///c:/Users/Acer/INTERNSHIP%20PROJECT/gopratle-prospecting-crm/atomic-crm/supabase/functions/dashboard-standalone/google-calendar-create-event/index.ts) → Paste into the editor → Ensure "Enforce JWT Verification" is unchecked → Click **Deploy**.
   - **Function 4:** Name: `google-calendar-disconnect`  
     Copy all code from [dashboard-standalone/google-calendar-disconnect/index.ts](file:///c:/Users/Acer/INTERNSHIP%20PROJECT/gopratle-prospecting-crm/atomic-crm/supabase/functions/dashboard-standalone/google-calendar-disconnect/index.ts) → Paste into the editor → Ensure "Enforce JWT Verification" is unchecked → Click **Deploy**.

---

### Deployment Option B: Pre-Packaged ZIP Archives

Pre-compressed deployment ZIP packages are generated in:
`supabase/functions/dashboard-zips/`
- `google-calendar-connect.zip`
- `google-calendar-callback.zip`
- `google-calendar-create-event.zip`
- `google-calendar-disconnect.zip`

---

### Deployment Option C: Supabase CLI (Alternative Method)

If Supabase CLI is available on your machine, deploy all functions directly from the project directory:

```bash
cd atomic-crm

# Deploy each function without gateway JWT enforcement (auth is enforced in function code)
# Replace [YOUR_SUPABASE_PROJECT_REF] with your Supabase project ID (e.g., vnhulnzcxhhexvainfjp)
npx supabase functions deploy google-calendar-connect --project-ref [YOUR_SUPABASE_PROJECT_REF] --no-verify-jwt
npx supabase functions deploy google-calendar-callback --project-ref [YOUR_SUPABASE_PROJECT_REF] --no-verify-jwt
npx supabase functions deploy google-calendar-create-event --project-ref [YOUR_SUPABASE_PROJECT_REF] --no-verify-jwt
npx supabase functions deploy google-calendar-disconnect --project-ref [YOUR_SUPABASE_PROJECT_REF] --no-verify-jwt
```

---

## 4. Google Cloud Console Configuration

1. Open [Google Cloud Console](https://console.cloud.google.com/) and select project **GoPratle Prospecting CRM**.
2. Navigate to **APIs & Services → Enabled APIs & Services**:
   - Verify that **Google Calendar API** is enabled.
3. Navigate to **APIs & Services → OAuth consent screen**:
   - User type: **External**.
   - App name: `GoPratle Prospecting CRM`.
   - Scopes added: `https://www.googleapis.com/auth/calendar.events`.
   - **Test users:** While the app is in "Testing" publishing status, add every Google account that will connect to the CRM.
4. Navigate to **APIs & Services → Credentials**:
   - Click on your OAuth 2.0 Web Client ID.
   - **Authorized JavaScript origins:**
     - `http://localhost:5173` (for local development)
     - Your production frontend domain (e.g., `https://crm.yourdomain.com`)
   - **Authorized redirect URIs (EXACT URI):**
     ```text
     https://[YOUR_SUPABASE_PROJECT_REF].supabase.co/functions/v1/google-calendar-callback
     ```
     *(Example: `https://vnhulnzcxhhexvainfjp.supabase.co/functions/v1/google-calendar-callback`)*
   - Click **Save**.

---

## 5. Frontend Production Environment Variables

Configure these variables in your hosting provider (Vercel, Netlify, Cloudflare Pages, etc.):

```env
# Supabase Project URL
VITE_SUPABASE_URL=https://[YOUR_SUPABASE_PROJECT_REF].supabase.co

# Primary Supabase Frontend Publishable Key (Required by Atomic CRM core)
VITE_SB_PUBLISHABLE_KEY=your-supabase-publishable-or-anon-key-here

# Optional Fallback Key (Also supported by renderRuntimeConfig)
# VITE_SUPABASE_ANON_KEY=your-supabase-anon-key-here
```

> **Variable Name Note:**  
> The GoPratle CRM codebase natively expects **`VITE_SB_PUBLISHABLE_KEY`** (derived from the modern Supabase Publishable Key specification). To ensure zero-friction deployments across different platforms, `scripts/renderRuntimeConfig.ts` also recognizes `VITE_SUPABASE_ANON_KEY` as an automatic fallback if `VITE_SB_PUBLISHABLE_KEY` is not set.

> **Security Mandate:**  
> Never add `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALENDAR_ENCRYPTION_KEY`, or Google refresh tokens to frontend `.env` files. All token handling and encryption occur exclusively in Supabase Edge Functions.

---

## 6. End-to-End Testing & Verification Protocol

Follow this checklist to verify your deployment:

1. **User Sign Up / Login:**
   - Log in to GoPratle CRM.
   - Verify that your user appears in `auth.users` and a corresponding row exists in `public.sales` with matching `user_id`.
2. **Calendar Connection:**
   - Go to **Settings → Profile**.
   - Locate the **Google Calendar** card (should display *Not Connected*).
   - Click **Connect Google Calendar**.
   - Complete Google OAuth consent screen with an authorized Test User Google account.
   - Verify redirect back to GoPratle CRM with a success toast.
   - Profile card should now display **Connected**, the Google Calendar email address, and last synced timestamp.
3. **Database Connection Verification:**
   - In Supabase Dashboard → **Table Editor** → `google_calendar_connections`:
   - Verify that `encrypted_access_token` and `encrypted_refresh_token` are stored as encrypted ciphertexts.
   - Verify that `user_id` matches your Supabase auth user UUID.
4. **Follow-Up Scheduling & Calendar Event Creation:**
   - Go to **Contacts**, select a contact (or create a new contact in stage *New* or *Contacted*).
   - In the right-hand panel, click **Add Task** (Follow-up).
   - Enter a date and time in the future.
   - Ensure the checkbox **"Add this follow-up to Google Calendar"** is checked.
   - Click **Add Task**.
   - Verify:
     - The task appears in GoPratle CRM with an **Open in Google Calendar** link.
     - Open [Google Calendar](https://calendar.google.com/) for that account: verify an event titled `Follow-up: <Contact Name> - <Company>` is scheduled at the exact date/time (Asia/Kolkata timezone, 30-minute default duration).
     - Event description contains the contact's email, phone, stage, and task notes.
5. **Idempotency & Retry Test:**
   - Edit the task time and save: verify the existing Google Calendar event is updated (`PATCH`) rather than creating a duplicate.
6. **Disconnection Test:**
   - Go to Profile Settings, click **Disconnect**.
   - Confirm disconnection: verify that the connection record is removed from `google_calendar_connections`.
