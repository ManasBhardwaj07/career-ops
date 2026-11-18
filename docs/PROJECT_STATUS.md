# Career Ops — Project Status

**Current System Status:** Production-Ready & Feature-Frozen
**Last Updated:** November 2026
**Primary Repository:** `career-ops`
**Database:** SQLite (`data/job_agent.db`) with WAL mode, foreign keys enforced, transaction durability.

---

## 1. Milestone Completion Matrix

| Milestone / Batch | Scope | Status | Verification Summary |
|---|---|---|---|
| **Milestone 1** | SQLite Database Layer & Schema Migrations | **COMPLETE** | 14 tables, WAL mode, foreign keys enabled, rerun-safe migrations 001–011. Tested in `test-db-phase1.mjs`. |
| **Milestone 2A** | Public ATS Discovery Adapters | **COMPLETE** | Greenhouse, Lever, Ashby, Workday, SmartRecruiters adapters with pagination & rate limiting. Tested in `test-discovery-milestone2a.mjs`. |
| **Milestone 2B** | Employer Registry & Domain Resolution | **COMPLETE** | Company deduplication, alias resolution, domain normalization, verified board registry. Tested in `test-employer-registry-m2b.mjs`. |
| **Milestone 2C** | Career Site Crawler & Discovery Engine | **COMPLETE** | Breadth-first crawl, career link extraction, ATS signature detection, pilot scan. Tested in `test-crawler-milestone2c.mjs`. |
| **Milestone 3A** | Candidate Profile Ingestion & Evidence Store | **COMPLETE** | `candidate_facts`, `evidence_records`, `resume_versions` tables, structured ingestion from `cv.md` and `profile.yml`. Tested in `test-milestone3a.mjs`. |
| **Milestone 3B** | Dual-Tier Matching Engine | **COMPLETE** | Tier 1 fast rule triage + Tier 2 deep requirement evaluation (A–G scoring dimensions, recommendation: APPLY / CONSIDER / SKIP). Tested in `test-milestone3b.mjs`. |
| **Milestone 3C** | Application Automation & Autofill | **COMPLETE** | Playwright browser session, ATS form detection, field semantic mapping, autofill execution. Tested in `test-milestone3c.mjs`. |
| **Milestone 3D** | Human Review & Cryptographic Authorization | **COMPLETE** | HMAC-SHA256 signed tokens, single-use nonce, payload binding, review CLI gating submission. Tested in `test-milestone3d.mjs`. |
| **Milestone 3E** | Application State Machine & Tracker Sync | **COMPLETE** | Formal 10-state lifecycle, audit event logging, bidirectional sync with `data/applications.md`. Tested in `test-milestone3e.mjs`. |
| **Milestone 3E Batch C** | State Machine Edge Cases & Failure Recovery | **COMPLETE** | Timeout, stale snapshot, rejection, and manual intervention transitions. Tested in `test-milestone3e-batch-c.mjs`. |
| **Phase 4B** | End-to-End Application Engine & Auth | **COMPLETE** | Live dry-run flows, headless/headed browser sessions, legacy auth backward compatibility. Tested in `test-phase4b-e2e.mjs` and `test-phase4b-legacy-auth.mjs`. |
| **Phase 4C Batch 1** | Pipeline Diagnostics & Status Hardening | **COMPLETE** | Health checks, status normalization, verified canonical state mapping. Tested in `test-phase4c-batch1.mjs`. |
| **Phase 4C Batch 2** | SmartRecruiters Verification & Dedup | **COMPLETE** | SmartRecruiters live API integration, company alias deduplication. Tested in `test-phase4c-batch2.mjs`. |
| **Phase 4C Batch 2.1** | Test Isolation & Database Safety | **COMPLETE** | Fail-closed guards across test suites, isolated temp DB paths, canonical DB protection. Tested in `test-phase4c-batch2-1.mjs`. |
| **Phase 4C Batch 3** | Workable & Recruitee Discovery Adapters | **COMPLETE** | Workable Widget API v1 + Recruitee Careers API offers endpoints integrated. Tested in `test-phase4c-batch3.mjs`. |
| **Phase 4C Batch 3.1** | Discovery Adapters Acceptance Closure | **COMPLETE** | Live smoke testing, schema validation, rate-limit resilience. Verified exit code 0. |
| **Phase 4C Batch 4** | India-First Employer Coverage Expansion | **COMPLETE** | 13 verified employer boards (Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Recruitee). Tested in `test-phase4c-batch4.mjs`. |
| **Phase 4C Batch 4.1** | India Opportunity Quality Audit & Matching Fixes | **COMPLETE** | 34-opportunity deep audit, HTML sentence boundary fix, en-dash normalization, negative title filters, SmartRecruiters 20-page pagination. |
| **Deliverable 1** | Submission CLI & Execution Path | **COMPLETE** | Gated submit command (`application/cli.mjs submit`), cryptographic authorization consumption, receipt capture, live DOM verification. Tested in `test-submission-cli-flow.mjs` (9/9 passed). |
| **Deliverable 2** | Scheduler-to-Application Handoff | **COMPLETE** | Atomically enqueues verified active APPLY opportunities from scheduler into `applications` queue (`state = 'NOT_STARTED'`). Idempotent skip for existing records. Tested in `test-handoff-enqueue.mjs` (9/9 passed). |
| **Deliverable 3** | Application Queue Consumer & Standing Policy | **COMPLETE** | Database-backed atomic worker leases (`application_leases`), standing authorization policy evaluator, quota enforcement, crash recovery, and automated gated submissions. Tested in `test-application-worker.mjs` (33/33 passed). |
| **Deliverable 4** | Recurring Runner, Full Isolation Audit & Release Hygiene | **COMPLETE** | Supervised recurring runner (`scripts/recurring-runner.mjs`), R13 auto-submit safety gate, PID overlap lock, bounded stage timeouts, 22-suite test isolation audit (`test-isolation-full-audit.mjs`), zero canonical DB mutations, zero orphan Chrome processes. Tested in `test-recurring-runner.mjs` (9/9 passed). |
| **Final Release Sign-off** | Production Release Verification & Hygiene | **COMPLETE** | All 22 test suites verified, canonical database verified byte-identical (`c78e6da9...`), ephemeral test review files purged, complete architectural and operational manuals delivered. |

---

## 2. Component Inventory

### Discovery Subsystem (`discovery/`)
- **Adapters**:
  - `GreenhouseAdapter`: Public board REST API (`boards.greenhouse.io/v1/boards/{board}/jobs`).
  - `LeverAdapter`: Public postings API (`api.lever.co/v0/postings/{site}`).
  - `AshbyAdapter`: Public board API (`api.ashbyhq.com/posting-api/job-board/{board}`).
  - `WorkdayAdapter`: JSON CXS API (`{tenant}.wd3.myworkdayjobs.com/wday/cxs/...`).
  - `SmartRecruitersAdapter`: Public postings API (`api.smartrecruiters.com/v1/companies/{company}/postings`) with 20-page offset pagination (up to 2,000 jobs per scan).
  - `WorkableAdapter`: Widget API v1 (`apply.workable.com/api/v1/widget/accounts/{board}`).
  - `RecruiteeAdapter`: Public careers API (`{company}.recruitee.com/api/offers`).
  - `HackerNewsAdapter`: Monthly "Who is hiring?" thread parser with regex extraction.
  - `YCAdapter`: Work at a Startup job directory ingestion.
  - `FeedAdapter`: Generic Atom/RSS XML discovery.
- **Registry & Resolvers**:
  - `company-resolver.mjs`: Normalizes company names, domains, and board URLs to canonical entities.
  - `source-policy.mjs`: Governs scan frequency, rate limits, backoff, and adapter selection.
- **Crawler**:
  - `discovery/crawler/`: Breadth-first spider for locating careers pages and identifying ATS signatures from DNS, headers, and DOM links.

### Storage & Persistence (`db/`, `data/`)
- **Engine**: SQLite 3 via `better-sqlite3`.
- **Primary Database**: `data/job_agent.db` (3,042 postings, 626 companies, 29 scans).
- **Integrity**: WAL mode, `foreign_keys = ON`, `busy_timeout = 5000ms`, `synchronous = NORMAL`.
- **Migrations**: 11 sequential, idempotent SQL migration files (`db/migrations/001_...` through `011_...`).
- **Repositories**: `db/repo.mjs` exposes transactional helpers for jobs, snapshots, applications, reviews, and audits.

### Matching Engine (`matching/`)
- **Candidate Profile**: Ingested facts in `candidate_facts` and `resume_versions` derived from `cv.md` and `config/profile.yml`.
- **Tier 1 (Fast Triage)**:
  - Role archetype filter (Backend, Fullstack, Systems, DevOps, AI/ML Platform).
  - Explicit seniority gate (rejects Staff, Principal, Lead, Director, VP, Level II/III/IV/2/3/4).
  - Negative title exclusions (`Program Manager`, `Project Manager`, `Community Manager`, `Solution Architect`, `People Systems`).
  - Location eligibility gate (strictly verifies India presence or explicit India-eligible remote work).
- **Tier 2 (Deep Evaluation)**:
  - Text extraction with HTML block-tag sentence delimitation (`. `) to prevent bullet bleed.
  - Experience extraction supporting en-dash ranges (`4–6 years`), prepositional phrasings, and qualification scoping (`is a plus` vs required).
  - A–G dimensional scoring (Role alignment, CV overlap, Level fit, Compensation, Track record, Interview readiness, Growth vector).
  - Outputs canonical recommendations: `APPLY`, `CONSIDER`, or `SKIP`.

### Application & Safety Subsystem (`application/`)
- **Autofill Engine**: DOM tree analysis, field semantic classification (name, email, phone, LinkedIn, resume, cover letter).
- **Human-in-the-Loop Gate (CRITICAL RULE)**:
  - **No automated submissions permitted under any circumstances.**
  - `application/crypto.mjs`: Generates cryptographic authorization tokens (HMAC-SHA256, single-use nonce, 15-minute TTL, bound to applicant identity and job posting ID).
  - `application/cli.mjs review`: Displays full autofill state and draft answers to the user for explicit confirmation.
  - `application/cli.mjs approve`: Generates and persists the one-time authorization token.
  - `application/cli.mjs apply`: Requires valid token before entering submission stage.

### Tracking & Reconciliation (`tracking/`, `data/applications.md`)
- **State Machine**: 10 canonical lifecycle states (`discovered`, `evaluating`, `ready_to_apply`, `review_pending`, `approved`, `submitting`, `applied`, `interviewing`, `rejected`, `withdrawn`).
- **Reconciliation Engine**: `tracking/reconcile.mjs` synchronizes database state with `data/applications.md` and parses inbound recruiter notifications.
- **Verification**: `verify-pipeline.mjs` enforces canonical state naming and link integrity.

---

## 3. Known Limitations & Operational Boundaries

1. **Workday Form Complexity**:
   - Workday applicant portals use dynamic, multi-step shadow-DOM wizards requiring tenant-specific account credentials. While job discovery via the CXS JSON endpoint is fully operational, automated form submission requires manual human completion.
2. **Aggregator Boards vs Direct Employers**:
   - Certain job boards (e.g., `ClanX`) operate as recruiting agencies or marketplaces. Job listings under these boards may represent third-party client employers (e.g., `Live2.ai`, `AiPrise`, `BrownRiceCapital`). The system notes the hosting board as source provenance while resolving client names in the description.
3. **Geographic Policy Ambiguity**:
   - Approximately 4.6% of remote listings do not state country exclusions in their headers or bodies. The Tier 1 engine defaults to `CONSIDER` or `UNCERTAIN` for ambiguous remote roles rather than blindly classifying them as `APPLY`.
4. **Canonical Database Test Isolation**:
   - The canonical database `data/job_agent.db` contains production tracking and historical audit data. All automated tests, crawlers, and experimental runs MUST operate on temporary SQLite databases using `createTestDatabase()` or `TEST_DB_PATH`. Fail-closed guards prevent writes to the canonical DB during test runs.
