# Lápis Duoke Gemini Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for isolated components and review the complete integration. Execute continuously within the user's approved scope.

**Goal:** Complete the approved Duoke → Gemini → review → labels workflow in the Lápis tab.

**Architecture:** Browser extension collects from a paired Duoke tab. A protected server handler extracts structured names. The existing React PrintLab consumes reviewed orders and preserves per-order quantities.

**Tech Stack:** React 18, Vite 5, Manifest V3, Node 24 tests, Gemini REST API, Supabase Edge Functions.

**Spec:** `docs/superpowers/specs/2026-10-13-lapis-duoke-gemini-design.md`

## Global Constraints

- Duoke origin is https://classic.duoke.com.
- Never expose API keys in source, browser bundles, outputs, or tests.
- CSV header is ID,Nome; sibling IDs use _1, _2; source order IDs remain unchanged internally.
- Max 150 labels per page and max 3 names per cartela; preserve explicit quantities.
- Preserve preexisting user changes; do not stage or commit App.jsx or db.js.
- No live chat messages are sent. No production publication without an explicit final activation step.
- API batches have at most 10 orders and 120000 input characters. Access code authentication is independent of the application's legacy local login.

## Task 1: Shared data and extraction server

**Files:** `shared/lapis.mjs`, `server/gemini.mjs`, `server/vite-plugin.mjs`, `supabase/functions/lapis-extract/index.ts`, `supabase/migrations/202610130001_lapis_ai_quota.sql`, `tests/lapis-data.test.mjs`, `tests/gemini.test.mjs`.

**Interfaces:** `parseOrderCodes(text): string[]`; `parseDuokeText(text): CollectedOrder[]`; `normalizeExtraction(raw, orders): ExtractedOrder[]`; `exportNamesCsv(orders): string`; `toLabelFields(order): { nome, qty, fs, font, emoji, emojiPos }[]`; `createGeminiHandler({env, fetchImpl, consumeQuota}): (Request)=>Promise<Response>`.

- [x] Add Node tests with the supplied fixture and assert two names share 150 labels: `assert.deepEqual(toLabelFields(order).map(x => x.qty), [75, 75])`.
- [x] Reject unknown output IDs, names not backed by the source text and invalid quantities. Test 401 before any fetch: `assert.equal(response.status, 401); assert.equal(calls, 0)`.
- [x] Implement bounded structured output via Gemini REST with configurable `GEMINI_MODEL`; require `GEMINI_API_KEY`, `STICKER_AI_ACCESS_CODE` and a permitted Origin. Return safe errors, not raw upstream response text.
- [x] Wire a Vite server-only plugin and a Supabase adapter. Production quota uses a service-role-only SQL function with an atomic transaction.
- [x] Run `node --test tests/lapis-data.test.mjs tests/gemini.test.mjs` and inspect evidence.

## Task 2: Duoke extension

**Files:** `extension/duoke-bridge/*`, `scripts/package-duoke-extension.mjs`, `tests/duoke-collector.test.mjs`.

**Interfaces:** Window bridge protocol is exactly the spec protocol. START carries only codes and requestId. Events retain requestId and contain no executable source strings.

- [x] Create Manifest V3 with `activeTab`, `scripting`, `storage`, host permission only for classic.duoke.com. Popup pairs the current Studio tab or current Duoke tab explicitly.
- [x] Verify sender tab and origin in the worker, and event source/origin in the bridge. Reject commands outside the enumerated protocol. Inject the collector only into the exact paired Duoke tab.
- [x] Implement shadow-root search and order attribution before extraction; use bounded waits, cancellation and incremental progress. Expose pure collector helpers for Node tests without introducing a production dependency.
- [x] Test stale search results, delayed messages, duplicate notes, not-found state and cancellation using controlled DOM fixtures.
- [x] Package only the allowlisted extension files with JSZip. Run `node scripts/package-duoke-extension.mjs`.

## Task 3: React workflow and PrintLab integration

**Files:** `src/components/LapisImport.jsx`, `src/components/LapisImport.css`, `src/lib/lapis-api.mjs`, `src/PrintLab.jsx`, `vite.config.js`, `package.json`.

**Interfaces:** `LapisImport({onAddOrders})` emits validated reviewed orders. PrintLab maps each to fields through `toLabelFields`, then calls its existing `buildLabels`.

- [x] Build connection/import controls and report missing extension or paired Duoke without pretending connected.
- [x] Collect/import raw orders, extract in chunks of ten, preserve completed chunks on failure/cancel, and expose source text for review.
- [x] Require explicit review and valid quantities before `onAddOrders`. Disable repeated enqueue of the same reviewed revision.
- [x] Export robust CSV using the shared helper and revoke download object URLs after use.
- [x] Integrate the panel without changing the existing PDF renderer or unrelated App.jsx changes. Build production and inspect the rendered page if a browser surface is available.

## Task 4: Review, documentation and handoff

**Files:** `docs/duoke-gemini.md`, plan progress below.

- [x] Independently review the component interfaces, auth, origin restrictions, cancellation, quantity handling and package contents. Fix material findings.
- [x] Run all targeted tests and `npm run build`. Search only generated source/bundles for accidental credentials, reporting counts without values.
- [x] Document extension installation, pairing, Gemini secrets, access code, allowed origins, Supabase migration/function deployment, and test limitations.
- [x] Report completed behavior and separate any unperformed live activation from completed local work.

## Progress

- Context and design approved. Existing dirty user work identified.
- Ruling: retain this checkout on a new feature branch to preserve the user's uncommitted application changes; a clean worktree would omit the working baseline.
- Ruling: use a server-validated access code for the new paid endpoint because the existing localStorage login and public users.json do not establish server-side identity.
- Preflight: Task 1 exports the API/data contract consumed by Task 3; Task 2 uses the same message contract consumed by Task 3. Each task owns separate files; root owns PrintLab/config/docs.

- Tasks 1-3: complete. Task 4 local review/validation complete; live activation remains external.
- Ruling: compact queue metadata persists in sessionStorage for eight hours, scoped by user and login timestamp. Accepted revisions derive from current queue; removal or name edits permit requeue.
- Independent final review found hidden-ancestor visibility, deployment packaging, and stale queue revisions; all fixed.
- Verification: 51 Node tests, Vite build, SSR smoke, Edge bundle syntax, unauthenticated dev route, and ZIP credential/contents checks passed. Existing app bundle-size/import warnings remain.
- Live synthetic Gemini check caught an incompatible responseFormat field. Corrected to documented responseMimeType/responseJsonSchema. Next request received provider HTTP503 high demand; no real extraction completed. No customer conversations sent.
- Activation pending: authenticated browser for Duoke, production Supabase migration/function/secrets and frontend deployment. No credentials or browser surface available for those steps. Keep feature branch and unrelated dirty work intact.
