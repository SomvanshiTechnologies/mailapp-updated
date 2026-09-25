# User guide tooling

Regenerates `docs/USER_GUIDE.pdf` and the screenshots in `docs/user-guide/` from a local copy of
the app filled with sample data. Needs Docker (Postgres from `docker compose up -d postgres`),
Google Chrome, and `npm i playwright-core` run inside this folder (it is not a workspace).

1. `docker exec mailapp-postgres psql -U mailapp -d postgres -c "create database mailapp_guide"`
2. Migrate and seed: from `apps/api`, with `DATABASE_URL=postgres://mailapp:mailapp@localhost:5433/mailapp_guide`,
   run `npx tsx src/db/migrate.ts` and `npx tsx src/db/seed.ts` (uses SEED_ADMIN_* from `.env`).
3. Start the api (`npx tsx src/server.ts`), the worker (`npx tsx src/worker.ts`) and the web dev
   server (`npx vite --port 5173` in `apps/web`) with the same `DATABASE_URL`, `SES_MODE=mock`,
   `LLM_PROVIDER=anthropic`, `LLM_WEB_SEARCH=false`, `STORAGE_DRIVER=local`.
4. `node make-leads.cjs` then `node setup.cjs` (settings, services, users, suppression).
5. `node walkthrough.cjs` (login and wizard screenshots; starts the campaign). Wait until the
   review queue has six or more drafts.
6. `node shots.cjs` then `node tabs.cjs` (all remaining screens).
7. `node build-guide.cjs` copies the referenced images into `docs/user-guide/` and prints the PDF.

Screenshots land in `shots/` next to these scripts.
