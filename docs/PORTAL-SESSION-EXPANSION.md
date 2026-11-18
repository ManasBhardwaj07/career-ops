# Career-Ops Portal Session Expansion Design & Implementation Note
**Deliverable 6: Authenticated & Walled-Garden Portal Adapters**
**Status:** IMPLEMENTED & FORENSICALLY VERIFIED
**Document Version:** 2.0.0

---

## 1. Executive Summary

Public job feeds and ATS boards (Greenhouse, Lever, Ashby, RemoteOK, Himalayas, Remotive, Jobicy, Internshala) operate via stateless HTTP GET/POST endpoints without requiring authenticated candidate identities.

In contrast, three premier tech hiring portals in India and the global startup ecosystem—**Cutshort**, **Instahyre**, and **Wellfound (formerly AngelList Talent)**—are walled gardens:
1. **No Open Candidate Feeds:** Postings and direct recruiter matches are strictly gated behind authenticated candidate sessions.
2. **Aggressive Anti-Bot Protection:** Cloudflare Turnstile, DataDome, and perimeter WAFs actively challenge and block headless HTTP requests lacking valid browser fingerprint tokens and session cookies.
3. **Session State Mechanics:** Candidate profiles require multi-factor authentication (OTP / Google OAuth) and persistent session cookies.

Under **Deliverable 6**, Career-Ops implements a dedicated secure session vault architecture (`discovery/sessions/session-vault.mjs`) and portal adapters in strict sequence:
1. **Cutshort** (`discovery/adapters/cutshort-adapter.mjs`)
2. **Instahyre** (`discovery/adapters/instahyre-adapter.mjs`)
3. **Wellfound** (`discovery/adapters/wellfound-adapter.mjs`)

---

## 2. Forensic Probe Findings & Concrete Evidence

| Portal | Target Geography / Archetype | Authentication Mechanism | Live Anti-Bot Evidence | Operational Status |
|---|---|---|---|---|
| **Cutshort** | India Startups & Mid-Market Tech (MERN/SDE) | Candidate session (`cutshort_authentication`) | Cloudflare Turnstile (`challenges.cloudflare.com/turnstile/v0/api.js`). Unauthenticated client calls return `400` with `is-authenticated: false` and redirect to login (`Unauth page loaded`). | **AUTHENTICATION_REQUIRED** (Safe fallback, 0 crash, R20 compliant) |
| **Instahyre** | India Tech Enterprises & High-Growth Unicorns | Hybrid: Public `/search-jobs/` HTML + Candidate Bearer/Session | Server-rendered public listings are discoverable via `/search-jobs/`. Private candidate opportunity feeds require session cookie / Bearer token. | **LIVE (Public Search) / AUTHENTICATION_REQUIRED (Candidate Feed)** |
| **Wellfound** | Global & Remote Startups (Seed to Series B) | Candidate session (`_angellist`) + CSRF token | GraphQL endpoint (`https://wellfound.com/graphql`) returns `HTTP 403 Forbidden` with `<title>Security Check \| Wellfound</title>` and Cloudflare Turnstile. | **AUTHENTICATION_REQUIRED (Gated by Turnstile WAF)** |

---

## 3. Architecture for Authenticated Sessions

```
┌────────────────────────────────────────────────────────┐
│                   Human Operator                       │
│      (One-time login & MFA Checkpoint via UI)          │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│             Persistent Browser Session Vault           │
│           data/sessions/<portal>/session.json          │
│            (Strictly gitignored in .gitignore)         │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│                Portal Discovery Adapter                │
│     - Checks session validity & expiration             │
│     - Injects saved session cookies/headers            │
│     - Navigates authenticated opportunity feeds        │
│     - Normalizes to career-ops schema                  │
│     - Fails closed on Turnstile challenge (R20)        │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│             Standard Discovery Ingest Pipeline         │
│     - Deduplication (cross-source URL / title hash)    │
│     - Multi-Tier Evaluation (R19 Matching Guards)      │
│     - Standing Policy Queue Worker (Deliverable 3/4)   │
└───────────────────────────┴────────────────────────────┘
```

---

## 4. Security, Isolation & Compliance Rules (R20 Enforcement)

1. **Storage Isolation:** Session tokens and authentication cookies are stored exclusively in `data/sessions/<portal>/session.json` which is protected by `.gitignore`. No credentials or cookies are ever committed to Git.
2. **Zero Automated CAPTCHA/WAF Bypass (R20):** If an endpoint serves a Cloudflare Turnstile or CAPTCHA challenge, the adapter immediately halts and transitions to `BLOCKED_BY_CHALLENGE` or `AUTHENTICATION_REQUIRED`. It NEVER attempts to solve, click through, or bypass anti-bot mechanisms.
3. **Session Expiry & Graceful Fallback:** If a stored session expires (HTTP 401/403 or redirect to login), the adapter transitions cleanly to `SESSION_EXPIRED` state, records zero jobs, and prompts for human re-authentication. It never marks a valid portal source as permanently dead.
4. **Candidate Fact Integrity:** All discovered opportunities normalize to the standard career-ops schema and pass through the three-tier matching pipeline (`matching/pipeline.mjs`) grounded strictly in verified candidate facts.

---

## 5. Verification Test Matrix

All three adapters are verified by dedicated test suites:
- `test-cutshort-adapter.mjs`: 6/6 tests PASS (missing session, expired session, upstream 401, Cloudflare challenge fail-closed, valid authenticated normalization, matching pipeline).
- `test-instahyre-adapter.mjs`: 6/6 tests PASS (public search HTML parsing, missing session, expired session, challenge fail-closed, authenticated JSON parsing, matching pipeline).
- `test-wellfound-adapter.mjs`: 5/5 tests PASS (missing session with forensic block evidence, expired session, Turnstile challenge fail-closed, authenticated GraphQL parsing, matching pipeline).
