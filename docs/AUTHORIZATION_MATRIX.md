# Endpoint Authorization Matrix & IDOR Protection Runbook

## Overview
This document specifies the access control policies, identity requirements, and IDOR (Insecure Direct Object Reference) prevention rules enforced across all API endpoints in Dechat.

## Guiding Security Principles
1. **Authorize Before Returning Sensitive Data**: Every endpoint accessing a transfer, receipt, or administrative record must verify caller identity and ownership *before* reading from the database or dispatching provider requests.
2. **Denials Must Not Reveal Record Existence**: When a caller attempts to access a record they do not own, the system responds with a uniform `404 Not Found` identical to the response for a non-existent ID. Probing attacks cannot determine whether an arbitrary ID or reference exists.
3. **No Provider Outbound Calls on Unauthorized Requests**: Handlers must reject unauthorized requests before contacting third-party settlement providers (e.g. Paystack).
4. **Strict Isolation of Admin Reconciliation**: Administrative endpoints (`/api/admin/*`) require cryptographic or bearer token verification (`ADMIN_SECRET` / IP allowlist) and are strictly decoupled from user session scopes.

---

## Route Inventory & Authorization Matrix

| Route | Method | Required Identity | Resource Owner | Allowed Operation | Denial Behavior | Provider Call Guard |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `/api/initiate-transfer` | `POST` | User (`x-client-session-id`) | Caller Session | Create transfer intent | `400` / `429` / `504` | Outbound transfer call gated by rate-limit and idempotency cache |
| `/api/verify-account` | `POST` | User | Caller Session | Read (resolve bank account) | `400` / `429` | Provider lookup gated by rate limit |
| `/api/create-recipient` | `POST` | User | Caller Session | Create recipient code | `400` / `429` | Provider recipient registration |
| `/api/transfer-status` | `POST` | User or Admin | Caller Session or Admin | Read transfer status | `404 Not Found` (non-revealing) | **No provider request dispatched if unauthorized** |
| `/api/transfer-status/:ref` | `GET` | User or Admin | Caller Session or Admin | Read transfer status | `404 Not Found` (non-revealing) | In-memory lookup only |
| `/api/transfer-status/:ref` | `POST` | User or Admin | Caller Session or Admin | Cancel pending transfer | `404 Not Found` (non-revealing) | Mutates status in-memory |
| `/api/receipt/:reference` | `GET` | User or Admin | Caller Session or Admin | Export / view receipt | `404 Not Found` (non-revealing) | In-memory receipt retrieval |
| `/api/payment-status/stream`| `GET` | User | Caller Session | Read real-time SSE stream | `400` validation failure | Scoped to caller's `sessionId` |
| `/api/admin-audit` | `GET` | Admin (`x-admin-token` / secret) | System Administrator | Paginated audit logs | `401 Unauthorized` | Read-only from audit log service |
| `/api/admin/audit-log` | `GET` | Admin | System Administrator | Paginated audit logs | `401 Unauthorized` | Read-only |
| `/api/admin/reconciliation` | `GET` | Admin | System Administrator | Read reconciliation data | `401 Unauthorized` | Isolated from user sessions |
| `/api/admin/auth/nonce` | `GET`, `POST`| Public / Admin | Admin Auth | Challenge generation & verification | `401 Unauthorized` | Cryptographic nonce verification |
| `/api/banks` | `GET` | Public | Public | Read supported banks | Public | Cached public list |
| `/api/webhook` | `POST` | Webhook Provider | System Provider | Settlement event dispatch | `401 Invalid Signature` | Verified against HMAC SHA-512 secret keyring |

---

## IDOR Regression Testing
Automated regression tests in `src/lib/auth/__tests__/authorizationAndIdor.test.ts` verify:
1. Cross-user transfer queries return uniform `404` without contacting third-party providers.
2. Cross-user cancellation requests are blocked and the underlying state remains untampered.
3. Cross-user receipt retrieval and export are blocked with uniform `404`.
4. Non-admin users cannot access administrative reconciliation or audit pagination endpoints.
