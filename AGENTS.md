# AGENTS.md

## Purpose
This file helps AI coding agents understand the repository structure, tooling, and domain-specific conventions so they can make useful changes without guessing.

## Project summary
- React + TypeScript + Vite web app
- Tailwind CSS + shadcn-ui styling
- React Router v6 for routing
- Supabase client integration in `src/integrations/supabase`
- Real-time health analysis / PPG/ECG signal processing in `src/modules`
- Three.js used for rendering visualizations in `src/render`

## Important workflows
- `npm install`
- `npm run dev` — local development server
- `npm run build` — production build
- `npm run test` — run Vitest tests
- `npm run lint` — run ESLint
- `npm run typecheck` — run TypeScript type check
- `npm run check:orphans` — find orphan imports
- `npm run check:no-sim` and `npm run check:no-sim:dist` — enforce no-simulation constraints

## Key source locations
- `src/App.tsx` — app entry and route configuration
- `src/main.tsx` — Vite React bootstrap
- `src/components` — reusable UI components and camera view
- `src/pages` — page components (`Index`, `NotFound`)
- `src/hooks` — custom React hooks for health analysis, telemetry, and data persistence
- `src/modules` — domain logic for signal processing, ECG synthesis, and vital sign computation
- `src/integrations/supabase` — Supabase client and database types
- `src/render` — Three.js rendering pipeline for ECG/visual effects
- `src/utils` — shared utilities and helpers

## Conventions and special notes
- `@` resolves to `src` via Vite alias
- `src/integrations/supabase/client.ts` is generated; avoid manual edits unless the generation comment is intentionally removed
- This repo includes medical validation and audit documentation in `docs/`. Consult:
  - `docs/medical-validation.md`
  - `docs/no-simulation-audit.md`
  - `docs/dependency-audit.md`
  - `docs/pipeline-optimizations.md`
  - `docs/repository-cleanup.md`
- Use small, incremental changes for domain logic in `src/modules`, especially health signal and vital sign code
- Avoid changing the Lovable-generated `README.md` unless also updating repo metadata and instructions for local contributors

## What agents should do first
1. Read `AGENTS.md` before editing.
2. Use the declared npm scripts to validate any change locally.
3. Preserve existing behavior for signal-processing and vital-sign computations unless the user specifically requests domain updates.
4. When modifying health measurement or sensor pipeline code, check the audit docs and no-simulation checks.

## Useful links
- Local alias config: `vite.config.ts`
- Package scripts: `package.json`
- Supabase integration: `src/integrations/supabase/client.ts`
