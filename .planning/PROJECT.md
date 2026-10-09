# Project Specification: WhatsApp Scheduler (Production Security Hardening)

## 1. Vision & Overview
The **WhatsApp Scheduler** is an automated scheduling platform consisting of an Android APK wrapper, a mobile Progressive Web App (PWA), and a Node.js/Express cloud server deployed on Render. It enables users to link their WhatsApp account via an 8-digit pairing code, synchronize phone contacts, attach media/documents, and schedule outbound message dispatches.

## 2. Strategic Goal
Transition the application from an insecure single-user prototype to an enterprise-grade, secure, multi-tenant capable production platform by executing a phased remediation of all 13 findings identified in the pre-production security audit.

## 3. Core Architectural Requirements
1. **Application Identity & Auth Layer:** Every request must resolve to an authenticated user session. Possession of a WhatsApp pairing code does not prove application ownership.
2. **Multi-Tenant Data & Session Isolation:** Each user owns isolated contacts, scheduled messages, file attachments, and an independent WhatsApp socket connection.
3. **Defense-in-Depth Native Security:** The Android APK must enforce strict signing validation, domain whitelisting for in-app updates, and hardened WebView security configurations.
4. **Resilient & Safe Storage:** Arbitrary file deletion vectors eliminated; file upload sizes, counts, and MIME types strictly enforced within storage quotas.
