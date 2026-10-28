# Lápis Autopilot Implementation Plan

**Goal:** Process a batch end to end in the Lápis tab: auto-approve safe orders into the queue, ask customers without names through Duoke after one batch confirmation, and re-check replies on demand.

**Architecture:** Pure classification and persistence rules live in `shared/lapis-autopilot.mjs`. The extension gains a `SEND` job that reuses the collector's order search and conversation confirmation. `src/lib/lapis-collection.mjs` gains a send coordinator. `LapisImport.jsx` orchestrates collect → extract → classify → queue / ask / await.

**Tech Stack:** React 18, Vite 5, Manifest V3, Node 24 tests (`npm run test:lapis`).

**Spec:** `docs/superpowers/specs/2026-10-28-lapis-autopilot-design.md`

## Global Constraints

- A message is sent only after the operator clicks **Enviar para todos** for a displayed list and text. No code path sends from collection, extraction or page load.
- Never send twice: a code appears at most once per SEND job; `sent`/`unconfirmed` block new asks for 24 hours; `unconfirmed` is never retried automatically.
- Ask only orders with `status: 'collected'`, non-empty text and extraction `not_found`. Never ask `not_found` in Duoke, collection errors or extraction errors.
- Auto-approve only: `found`, 1–3 names, `toLabelFields` succeeds, empty `reason`, revision not already queued. Everything else stays in manual review.
- Collection and sending never run at the same time; one extension job at a time.
- Message text: trimmed, 1–500 characters, plain text.
- Awaiting list: `localStorage`, per logged user, 7-day expiry, wrapped in try/catch; failure to save is visible.
- Several target files already have uncommitted user changes (`LapisImport.jsx`, `LapisImport.css`, `duoke-content.js`, `manifest.json`, `lapis-api.mjs`, `db.js`, `App.jsx`, tests). Preserve them. Do not stage or commit them without asking the user first; do not touch `App.jsx` or `db.js`.
- Do not claim the real Duoke send works until the user confirms it in their session.

## Task 1: Autopilot rules

**Files:** `shared/lapis-autopilot.mjs` (new), `tests/lapis-autopilot.test.mjs` (new).

**Interfaces:**
- `classifyForAutopilot(source, result, { queuedRevisions, extractionError })` → `'auto' | 'review' | 'ask' | 'failed' | 'pending'` (`pending` = collected but not extracted yet).
- `validateAskMessage(text)` → trimmed string or throws.
- `planAsk(ids, awaiting, now)` → ids not blocked by a `sent`/`unconfirmed` record newer than 24 h.
- `loadAwaiting(storage, key, now)` / `saveAwaiting(storage, key, awaiting)` — `{ [id]: { sentAt, status } }`, drops entries older than 7 days and malformed entries.
- `recordSends(awaiting, results, now)` → new map; `failed` results are not recorded.
- `resolveAwaiting(awaiting, classifiedById)` → removes ids classified `auto` or `review`; keeps `ask`.
- `AUTOPILOT_DEFAULT_MESSAGE`, `MAX_SEND_ORDERS = 100`.

- [ ] Write tests first: each auto-approve criterion fails independently (4 names, 160 labels, non-empty reason, status review, queued revision); `ask` only for collected + `not_found`; Duoke `not_found` and collection error → `failed`; 24 h block boundary; 7-day expiry boundary; malformed storage ignored; storage throwing does not crash load.
- [ ] Implement, reusing `toLabelFields`, `orderRevision` and `hasNames`/`canExtract` from existing modules.
- [ ] Run `node --test tests/lapis-autopilot.test.mjs`.

## Task 2: Map the Duoke composer

**Files:** `extension/duoke-bridge/collector.js` (constants only), notes appended to `docs/duoke-gemini.md`.

- [ ] Inspect Duoke's public web bundle (as done for 1.0.3) for the chat composer: text area/editor element, send button, and the class of shop-sent bubbles (`.message_main > li.rt` is already treated as shop-side). Determine whether the composer is a `textarea` or a contenteditable editor and which event it listens to.
- [ ] Record selectors as `COMPOSER`, `SEND_BUTTON`, `SHOP_MESSAGE` constants with a short comment on their source. No sending in this task.
- [ ] If the composer cannot be identified with confidence, stop and ask the user for a screenshot or HTML of the chat input before Task 3.

## Task 3: Collector send

**Files:** `extension/duoke-bridge/collector.js`, `tests/duoke-collector.test.mjs`.

**Interfaces:** `createCollector(document).send(codes, message, { signal, onProgress, pause })` → `{ orders, completed, total, cancelled }`, each order `{ id, status: 'sent' | 'unconfirmed' | 'failed', error? }`. `pause` defaults to a random 2000–4000 ms sleep between orders.

- [ ] Extract `openConversation(code, signal)` from `collectOrder`: search, wait for the fresh result, click, wait for `headersFor(code)`. `collectOrder` keeps its exact behavior on top of it (existing tests must pass unchanged).
- [ ] `sendToOrder(code, message, signal)`: `openConversation`; not found or unconfirmed header → `failed`. Find exactly one visible composer, else `failed`. Snapshot shop messages, fill the composer with the framework-safe setter used for search, re-check `headersFor(code)` immediately before clicking send (changed → `failed`, nothing clicked). After the click, wait up to 15 s for a new shop message whose text equals the message → `sent`; otherwise `unconfirmed`. Any exception after the click is `unconfirmed`, never `failed`.
- [ ] Cancellation is checked between orders and before the click, never between click and confirmation.
- [ ] Tests with DOM fixtures: wrong conversation never receives text; missing composer → `failed`; bubble appears → `sent`; bubble never appears → `unconfirmed`; header switches before click → `failed` and no click; duplicate codes sent once; cancel between orders stops later sends; `collectOrder` regression suite still green.

## Task 4: Extension protocol 1.1.0

**Files:** `extension/duoke-bridge/worker.js`, `extension/duoke-bridge/duoke-content.js`, `extension/duoke-bridge/manifest.json`, `extension/duoke-bridge/README.md`, `public/downloads/duoke-bridge.zip` (regenerated).

- [ ] Worker accepts `SEND` on the `duoke-studio` channel with `{ requestId, codes, message }`: paired Studio sender only, no active job, 1–100 valid unique codes, message 1–500 chars after trim. `activeJob` gains `kind: 'collect' | 'send'`; `STATUS.busy` covers both; `CANCEL` works for both.
- [ ] Worker validates send PROGRESS (`status` in `sent|unconfirmed|failed`, no `text`), keeps `completed`/`seen` checks, and relays `{ order: { id, status, error? } }`. Collection PROGRESS validation is unchanged.
- [ ] Content script handles `SEND` like `START`, calling `collector.send`, with the same finished/next-job handling.
- [ ] Bump manifest to `1.1.0`; README notes that sending only happens on Studio confirmation.
- [ ] Run `node scripts/package-duoke-extension.mjs` and confirm the ZIP contains only the allowlisted files.

## Task 5: Send coordinator

**Files:** `src/lib/lapis-collection.mjs`, `tests/lapis-collection.test.mjs` (new, or the existing batch test file if that is where `createCollectionRun` is covered).

**Interfaces:** `createSendRun({ codes, message, send, makeId, onOrder, onProgress, signal, timeoutMs })` with `start()`, `receive(data)`, `dispose()` mirroring `createCollectionRun`, one `SEND` job of at most 100 codes.

- [ ] Validate `message` with `validateAskMessage` and codes with `parseOrderCodes`; reject more than 100.
- [ ] Ignore events from other request ids, unknown or repeated ids, and invalid statuses. Timeout or lost connection resolves the received results and marks the rest as not attempted (they stay askable), never as `sent`.
- [ ] Tests: happy path, cancel mid-run keeps received statuses, foreign request ids ignored, timeout leaves untouched codes askable.

## Task 6: Lápis UI

**Files:** `src/components/LapisImport.jsx`, `src/components/LapisImport.css`, `tests/lapis-ui.test.mjs`.

- [ ] **Processar lote**: runs the existing collect + extract flow, then classifies every order. `auto` orders go to `onAddOrders` in one call; on success they are marked accepted like manually reviewed ones. If `onAddOrders` fails, they fall back to review with the error shown.
- [ ] Filter **Cobrar nome** (count) with the ask panel: list of codes, editable textarea (saved to `localStorage`, default `AUTOPILOT_DEFAULT_MESSAGE`), character count, codes blocked by 24 h shown as such, button **Enviar para N clientes**. The button is disabled while collecting/extracting/sending and when the text is invalid. Clicking it is the only trigger for `createSendRun`.
- [ ] Per-order send status on the card (`Enviado`, `Envio não confirmado — confira no Duoke`, `Falhou: …`) with **Tentar de novo** only for `failed`.
- [ ] Filter **Aguardando cliente** (count) backed by the awaiting list, showing time since sending, plus **Verificar respostas**: collect + extract only those ids, classify, auto-queue, then `resolveAwaiting`.
- [ ] Summary after each run: queued automatically, to review, asked, awaiting, failures.
- [ ] Keep existing styles, 30-per-page pagination and the current manual flow. Tests render the component with mocked bridge/extraction and assert: auto orders reach `onAddOrders`; no SEND is posted before the button click; the button posts exactly the displayed codes and text; awaiting entries survive a remount and expire.

## Task 7: Docs, verification, handoff

**Files:** `docs/duoke-gemini.md`.

- [ ] Document Processar lote, cobrança, Aguardando cliente, extension 1.1.0 update steps and the changed rule (sends only after explicit batch confirmation).
- [ ] Run `npm run test:lapis` and `npm run build`; report the actual counts and any failures.
- [ ] Open the app in the browser preview, confirm the new panel renders and that no SEND happens without the click (bridge mocked or disconnected).
- [ ] Hand off a real-session checklist to the user: update the extension, send to one of their own test orders, confirm `Enviado` and the bubble in Duoke, then a small batch. Record the result in `docs/duoke-gemini.md` only after the user confirms it.
- [ ] Ask the user how to commit, given the pre-existing uncommitted changes in the same files.
