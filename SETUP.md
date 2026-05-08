# Setup

Three steps.

## Prerequisites

- Node.js 20+
- npm 10+
- Docker Desktop (for Postgres)

## 1. Start Postgres

```bash
docker compose up -d
```

This starts Postgres 16 on port **5433** (not 5432, to avoid conflicts with any host Postgres you may have running).

Verify it's healthy:
```bash
docker compose ps
```

## 2. Install, migrate, seed

```bash
cp .env.example .env
cp apps/web/.env.example apps/web/.env.local
npm run setup
```

`npm run setup` runs `npm install` (installs all workspaces) then `prisma migrate deploy` then `prisma db seed`. You should see:

```
Seed complete.
Test users:
  - test-user-1 (role=USER, plan=STANDARD, 1000 credits)
  - test-admin-1 (role=ADMIN)
Send the x-user-id header with either of those IDs to authenticate.
```

## 3. Run

```bash
npm run dev
```

This starts the NestJS API on **http://localhost:4000** and the Next.js web app on **http://localhost:3000**.

Open http://localhost:3000 and click the seeded users to pick who you're impersonating.

## Tests

```bash
npm run test          # Backend unit tests (Jest)
```

## Troubleshooting

| Problem | Fix |
|---|---|
| Port 5433 in use | Change `docker-compose.yml` port mapping and `.env` DATABASE_URL |
| Port 4000 in use | Change `API_PORT` in `.env` |
| Port 3000 in use | Change the web dev script in `apps/web/package.json` |
| Prisma client out of date | `cd apps/api && npx prisma generate` |
| Migrations out of sync | `cd apps/api && npx prisma migrate reset --force` (destroys data) |
| Docker not running | Start Docker Desktop, then `docker compose up -d` |

## Clean slate

```bash
docker compose down -v    # Destroys DB data
npm run setup             # Re-migrates + reseeds
```
