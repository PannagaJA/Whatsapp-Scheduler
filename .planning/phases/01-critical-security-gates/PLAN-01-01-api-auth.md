# Plan 01-01: Backend API Authentication & Protection

**Phase:** Phase 1 — Critical Security Gates & Core Authentication  
**Finding ID:** `SEC-001`  
**Priority:** P0 (Release Blocker)  
**Target Files:**
- [`mobile-server/server.js`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/mobile-server/server.js)
- [`mobile-server/pwa/app.js`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/mobile-server/pwa/app.js)
- [`mobile-server/pwa/index.html`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/mobile-server/pwa/index.html)

---

## 1. Objective
Implement server-side authentication middleware protecting all sensitive REST API routes (`/api/contacts`, `/api/schedules`, `/api/pair-code`, `/api/logout`, `/api/status`, `/api/qr`, `/api/profile-pic`, `/share-target`) so unauthenticated requests receive `401 Unauthorized`.

---

## 2. Tasks

### Task 1: Create Authentication Guard Middleware in `server.js`
1. Define a configurable `API_SECRET_KEY` from environment variables (with a generated fallback for secure local dev).
2. Implement `requireAuth(req, res, next)`:
   - Checks `req.headers.authorization` (Bearer token) or session header.
   - Validates token against configured key.
   - Rejects missing/invalid tokens with `{ success: false, error: "Unauthorized access. Valid API key required." }` and HTTP status `401`.
3. Mount `requireAuth` on all sensitive `/api/*` and `/share-target` routes.
4. Leave `/api/version` and static web assets public.

### Task 2: Update Frontend PWA to Send Authentication Headers
1. Update `mobile-server/pwa/app.js` API fetch wrapper to automatically include `Authorization: Bearer <key>` header on all requests.
2. If `localStorage` has no key, or if an API returns `401`, prompt for authorization or display an unlock/setup modal.
3. Handle 401 errors gracefully across `checkStatus`, `loadContacts`, `loadSchedules`, `submitSchedule`, and `requestPairCode`.

---

## 3. Verification & Acceptance Criteria
- [ ] Direct curl to `GET /api/contacts` without auth returns `401 Unauthorized`.
- [ ] Direct curl to `POST /api/schedules` without auth returns `401 Unauthorized`.
- [ ] Direct curl to `POST /api/pair-code` without auth returns `401 Unauthorized`.
- [ ] Direct curl with `Authorization: Bearer <API_SECRET_KEY>` succeeds with `200 OK`.
- [ ] PWA frontend and Android WebView function seamlessly when configured with the key.
