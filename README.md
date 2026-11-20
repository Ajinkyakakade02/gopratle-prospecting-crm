# GoPratle Prospecting CRM

A modern, high-performance prospecting and outreach CRM designed for sales development representatives and account executives. GoPratle streamlines lead intake, pipeline stage tracking, outreach activity history, and scheduled calendar follow-ups.

---

## 📌 Provenance & Upstream Attribution

**GoPratle Prospecting CRM** is built upon and customized from [Atomic CRM](https://github.com/marmelab/atomic-crm), an open-source CRM developed and maintained by [Marmelab](https://marmelab.com) under the **MIT License**.

We gratefully acknowledge Marmelab and the Atomic CRM contributors for providing the foundational architecture, including the React-Admin data provider framework, layout primitives, and Supabase integration patterns. The original [MIT License](./LICENSE.md) is preserved in full.

### Our Customizations & Enhancements
1. **Application Rebranding:** Redesigned interface title, application metadata, and navigation for GoPratle Prospecting CRM.
2. **Dedicated Contact Prospecting Pipeline:** Implemented a dedicated 5-stage contact lifecycle (**New → Contacted → Follow-up → Meeting Scheduled → Closed**), independent of the deals pipeline.
3. **Prospect Information Schema:** Extended contact models with `lead_source` (LinkedIn, Cold Outreach, Referral, Website, Event, Inbound Email, Other), LinkedIn profile validation, structured multi-email and multi-phone JSONB records, and company associations.
4. **Automated Stage Change History:** Every prospect stage transition across the application—including the sidebar quick selector, desktop edit form, and mobile sheet—automatically records a timestamped audit entry in `contact_notes` capturing previous stage, new stage, sales representative ID, and last seen timestamp.
5. **Direct Google Calendar API Integration:** Developed native Google Calendar integration without external automation dependencies (no Zapier, n8n, or Make):
   - **OAuth 2.0 Authorization Code Flow:** Secure server-side exchange with offline refresh token support and single-use CSRF `state` verification.
   - **AES-256-GCM Token Encryption:** Refresh and access tokens encrypted at rest using PBKDF2 (100,000 iterations, SHA-256) with dedicated master key.
   - **Internal Follow-up Reminders:** Automatically converts CRM follow-up tasks into Google Calendar events with contact metadata, phone/email details, and customizable reminder popups (configured without unsolicited attendee invites to prospects).
   - **Idempotent Sync & Retry:** Automatically performs `PATCH` updates for existing events, recreates deleted calendar entries, and offers one-click retry for failed sync operations.
   - **Strict Redirect Security:** Validates redirect origins against allowlists in production, rejecting untrusted origins and permitting localhost only in explicit development mode.

---

## 🛠️ Technology Stack

- **Frontend:** React 19, TypeScript, React-Admin (`ra-core`), Vite 8, Tailwind CSS v4, Lucide Icons, Shadcn UI / Radix / Base UI primitives.
- **State Management & Caching:** TanStack Query (React Query v5).
- **Backend & Database:** Supabase (PostgreSQL 15+, Row Level Security, Supabase Auth, Supabase Storage).
- **Serverless Compute:** Supabase Edge Functions (Deno Runtime, Web Crypto API).
- **External APIs:** Google Calendar API v3, Google OAuth 2.0.
- **Testing & Quality Assurance:** Vitest, TypeScript compiler (`tsc`), ESLint.

---

## 🚀 Quick Start & Local Installation

### Prerequisites
- **Node.js:** Node 20 LTS or Node 24 LTS
- **Package Manager:** `npm` (v10+)
- **Supabase CLI:** (Optional, for local database containerization)
- **Docker Desktop:** (Optional, required only for local Supabase Docker instances)

### 1. Clone & Install Dependencies
```sh
git clone https://github.com/[your-org]/gopratle-prospecting-crm.git
cd gopratle-prospecting-crm/atomic-crm
npm install
```

### 2. Configure Local Environment
Create a `.env.development` file in `atomic-crm/` (or update your environment settings):

```env
# Supabase Configuration
VITE_SUPABASE_URL=https://[YOUR_SUPABASE_PROJECT_REF].supabase.co
VITE_SB_PUBLISHABLE_KEY=your-supabase-publishable-or-anon-key
```

> **Note:** The frontend application natively reads `VITE_SB_PUBLISHABLE_KEY` (with automatic fallback to `VITE_SUPABASE_ANON_KEY`).

### 3. Start Development Server
```sh
npm run dev
```
Open [http://localhost:5173/](http://localhost:5173/) in your browser.

---

## 🗄️ Supabase Database Setup

When configuring a new Supabase project, execute the declarative schema files in the **Supabase Dashboard SQL Editor** in the following exact order:

| Step | File | Purpose |
| :--- | :--- | :--- |
| **1** | `supabase/schemas/01_tables.sql` | Core tables, foreign keys, Google Calendar tables, contact `lead_source`, task calendar sync columns |
| **2** | `supabase/schemas/02_functions.sql` | User management triggers, JSONB normalization, profile setup |
| **3** | `supabase/schemas/03_views.sql` | `init_state`, `contacts_summary`, `companies_summary`, `activity_log` |
| **4** | `supabase/schemas/04_triggers.sql` | Automated sales_id assignment, contact timestamps, auth user triggers |
| **5** | `supabase/schemas/05_policies.sql` | Row Level Security (RLS) policies for CRM tables and strict user isolation for Calendar tokens |
| **6** | `supabase/schemas/06_grants.sql` | Permissions for `authenticated`, `anon`, and `service_role` roles |
| **7** | `supabase/schemas/07_storage.sql` | Creates the `attachments` storage bucket |
| **8** | `supabase/schemas/08_search.sql` | Full-text global search indexes and ranking functions |

> **IMPORTANT:** Option A (the 8 declarative schemas above) builds the complete fresh database. Do not execute Option A and Option B (the 36 incremental migrations in `supabase/migrations/`) together.

---

## 📅 Google Calendar OAuth Setup

### 1. Google Cloud Console
1. Create or select your Google Cloud project (e.g., `GoPratle Prospecting CRM`).
2. Navigate to **APIs & Services → Enabled APIs & Services** and enable the **Google Calendar API**.
3. In **OAuth consent screen**:
   - Set User Type to **External**.
   - Add scope: `https://www.googleapis.com/auth/calendar.events`.
   - Add your Google account under **Test users** while in testing mode.
4. Under **Credentials → OAuth 2.0 Client IDs**:
   - Create a **Web application** credential.
   - **Authorized JavaScript origins:**
     `http://localhost:5173` (for development) and your production CRM URL.
   - **Authorized redirect URIs:**
     `https://[YOUR_SUPABASE_PROJECT_REF].supabase.co/functions/v1/google-calendar-callback`
   - Securely save the **Client ID** and **Client Secret**.

### 2. Edge Function Secrets Configuration
Configure the required backend secrets in the Supabase Dashboard under **Project Settings → Edge Functions → Secrets** (or via `npx supabase secrets set`):

| Secret Name | Required | Description |
| :--- | :---: | :--- |
| `GOOGLE_CLIENT_ID` | **Yes** | OAuth 2.0 Web Client ID from Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | **Yes** | OAuth 2.0 Client Secret (kept strictly on server) |
| `GOOGLE_CALENDAR_ENCRYPTION_KEY` | **Yes** | Master key for AES-256-GCM token encryption at rest (min 32 characters) |
| `CRM_FRONTEND_URL` | **Yes** | Canonical frontend origin (e.g., `https://crm.yourdomain.com` or `http://localhost:5173`) |
| `ALLOWED_REDIRECT_ORIGINS` | Optional | Additional trusted production origins (comma-separated) |
| `ENVIRONMENT` | Optional | Set to `development` to allow `localhost` redirects; defaults to strict production |
| `GOOGLE_CALENDAR_REDIRECT_URI` | Optional | Explicit redirect override if custom function domains are used |

---

## ⚡ Edge Functions Deployment

The CRM utilizes four Supabase Edge Functions for Calendar integration:
1. `google-calendar-connect`: Generates secure state and returns Google OAuth authorization URL.
2. `google-calendar-callback`: Exchanges authorization code, verifies state, encrypts tokens, and updates connection.
3. `google-calendar-create-event`: Schedules/updates tasks on Google Calendar with timezone formatting and task ownership verification.
4. `google-calendar-disconnect`: Revokes Google OAuth tokens and cleans up connection records.

### Deployment via Supabase Dashboard
Because the Dashboard in-browser editor expects single self-contained files, pre-bundled standalone files and uploadable ZIPs are provided:
- **Standalone Sources:** `supabase/functions/dashboard-standalone/[function-name]/index.ts`
- **ZIP Archives:** `supabase/functions/dashboard-zips/[function-name].zip`

> **CRITICAL GATEWAY SETTING:**
> When deploying `google-calendar-callback`, **Enforce JWT Verification MUST be disabled (OFF)**. Google redirects users directly to this endpoint without a Supabase session JWT header; authentication and CSRF security are verified in code via the single-use Postgres state token.

### Deployment via Supabase CLI
```sh
cd atomic-crm
npx supabase functions deploy google-calendar-connect --project-ref [YOUR_PROJECT_REF] --no-verify-jwt
npx supabase functions deploy google-calendar-callback --project-ref [YOUR_PROJECT_REF] --no-verify-jwt
npx supabase functions deploy google-calendar-create-event --project-ref [YOUR_PROJECT_REF] --no-verify-jwt
npx supabase functions deploy google-calendar-disconnect --project-ref [YOUR_PROJECT_REF] --no-verify-jwt
```

---

## 🧪 Quality Assurance & Testing

Run the validation suite locally:

```sh
# Edge Function unit & regression tests (211 tests)
npm run test:unit:functions

# TypeScript strict type checking
npm run typecheck

# Code formatting and ESLint verification
npm run lint

# Production bundle build
npm run build
```

---

## 🔒 Security Architecture Notes

- **Credential Isolation:** OAuth secrets and refresh tokens are strictly restricted to Edge Functions and encrypted database columns. They are never transmitted to client browsers or exposed in client bundles.
- **Internal CRM Model:** CRM data (`contacts`, `companies`, `notes`, `tasks`) utilizes collaborative internal RLS where authorized team members share view and edit access. Calendar tokens and OAuth states enforce strict user isolation (`auth.uid() = user_id`).
- **Public Attachments Storage:** The `attachments` storage bucket is configured for public read access to support logo and avatar rendering without presigned URL overhead. Avoid storing confidential or restricted documents in this bucket without switching to private storage policies.

---

## 📄 License

This project is open-source under the terms of the **MIT License**.
Original codebase copyright (c) Marmelab. Customizations and extensions copyright (c) GoPratle Contributors. See [LICENSE.md](./LICENSE.md) for full license details.
