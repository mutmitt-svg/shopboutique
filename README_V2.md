# TeleBoutik POS v2 — tenant hardening

## Changes in this iteration

- Local PGlite schema migration adds `tenant_id` to business tables and database triggers stamp inserts with the active store tenant. Existing rows are backfilled to the existing store when one exists.
- The active local tenant is initialized from the selected local store in `AuthContext`.
- Added Supabase browser client configuration using `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` only.
- Added a new Supabase migration that adds `store_memberships`, maps each cloud user to a store, removes prior permissive policies and scopes cloud table access by membership. Mutations are role-gated.
- Added server-side store provisioning RPC `create_store_for_current_user` that creates a store and owner membership in one transaction.
- Removed `.env` from the deliverable and added `.env.example` and a secure `.gitignore`.
- Corrected the mobile top-bar / sync-banner stacking, added Escape-to-close and background scroll locking for the mobile drawer, and restored browser zoom accessibility.

## Local development

1. Install Node.js 22 or the version supported by the lockfile.
2. Run `npm ci`.
3. Copy `.env.example` to `.env` and set the public Supabase URL/key if cloud features are configured.
4. Run `npm run dev`; run `npm run build` before release.

The app currently includes demo seed data and demo PINs. Do not deploy demo data or the local PIN authentication as production-grade cloud authentication. Create individual Supabase Auth users and memberships for production staff.

## Supabase migration and existing tenant mapping

1. Back up the Supabase project.
2. Apply migrations in order, including `20261024000100_multitenant_hardening.sql`, in a staging project first.
3. If the database already contains multiple stores, the migration intentionally stops: map every legacy row to its correct `store_id` before retrying. It must never guess ownership.
4. For an existing store, add the owner's Auth UID to its membership from the Supabase SQL editor, after verifying the IDs:

```sql
INSERT INTO public.store_memberships (store_id, user_id, app_role, active)
VALUES ('YOUR_EXISTING_STORE_ID', 'YOUR_AUTH_USER_UUID', 'owner', true)
ON CONFLICT (store_id, user_id)
DO UPDATE SET app_role = 'owner', active = true;
```

5. New stores should be provisioned with the authenticated RPC `create_store_for_current_user(...)`. Do not allow client-side role assignment.
6. Test that an account belonging to store A cannot read or mutate rows from store B. Test SELECT, INSERT, UPDATE and DELETE separately for each role.

## Tenant rules

- Cloud tenant key is `store_id`; the `stores.id` is the tenant identifier.
- Each cloud account must have an active row in `store_memberships` before it can access a store.
- All cloud writes must include the correct `store_id`; RLS rejects null or mismatched tenant rows.
- The local database stamps rows with `tenant_id` and prevents an update from changing a row's tenant. This build deliberately fails closed if more than one store is found in the same local PGlite database; it does not yet offer an in-app local tenant switcher. Use one isolated local database/profile per tenant until that selector is implemented.
- Sales, stock movements, payments, journal entries and audit events must be treated as immutable business history; correct them with compensating entries rather than silent deletion.

## Release gate / remaining integration work

This iteration hardens the tenant model and the schema, but it does **not** claim that the end-to-end cloud sync processor is complete. Before production, implement and test a server-side sync RPC that validates each queued operation and applies it atomically, with idempotency keys, conflict handling and role checks. The existing `sync_ops` queue/status UI is not by itself a cloud synchronization engine. Also replace demo PIN login with a deliberate offline-authentication policy and connect local users to Supabase Auth identities.

Do not deploy the migration to a live database until the legacy row mapping and owner membership have been reviewed. The migration has not been applied to your remote Supabase project by this package build.
