# Phase 1 Plan: Critical Security Gates (P0)

**Milestone:** M1 — Production Security Remediation  
**Phase ID:** 01-critical-security-gates  
**Status:** Ready to Execute

---

## 1. Phase Overview
Phase 1 addresses the two most critical release-blocking vulnerabilities discovered during the security audit:
1. **SEC-001 (Critical):** Complete absence of backend API authentication and authorization.
2. **SEC-002 (Critical):** Insecure remote APK updater allowing potential remote code execution.

---

## 2. Execution Plans

| Plan ID | Title | Primary Target | Files Modified |
| :--- | :--- | :--- | :--- |
| **01-01** | Backend API Authentication Guard | `SEC-001` | `mobile-server/server.js`, `pwa/app.js`, `pwa/index.html` |
| **01-02** | Android In-App Updater Hardening | `SEC-002` | `android/app/.../MainActivity.java` |

---

## 3. Dependency Graph & Waves

```mermaid
graph LR
    subgraph Wave 1 (Parallel Execution)
        P1[Plan 01-01: API Authentication Middleware]
        P2[Plan 01-02: Android Updater Whitelist & Verification]
    end

    subgraph Wave 2 (Phase Verification)
        V1[Automated Auth & 401 Rejection Verification]
        V2[Android Package Validation Testing]
    end

    P1 --> V1
    P2 --> V2
```

---

## 4. Phase Verification Checklist
- [ ] All unauthenticated requests to `/api/contacts`, `/api/schedules`, `/api/pair-code`, `/api/logout`, `/api/status`, `/api/qr` return `401 Unauthorized`.
- [ ] PWA and Android WebView successfully send auth credentials and interact with protected endpoints.
- [ ] Arbitrary / non-GitHub URLs passed to `downloadAndInstallUpdate()` are blocked.
- [ ] Downloaded APKs with non-matching package IDs are deleted and blocked before installer execution.
