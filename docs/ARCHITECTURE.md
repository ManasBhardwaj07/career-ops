# Career Ops — System Architecture

**Version:** 1.6.0<br/>
**Status:** Feature-Frozen / Operational<br/>
**Database:** SQLite (`data/job_agent.db`) via `better-sqlite3` and Node.js SQLite<br/>
**Design Principles:** Local-first, canonical database as single source of truth, fail-closed safety, strict human authorization gate.

---

## 1. Executive System Overview

Career Ops is an end-to-end autonomous job search, matching, and application preparation platform. It shifts job searching from reactive scraping to systematic discovery across verified applicant tracking systems (ATS), rigorous dual-tier candidate qualification, safe browser autofill, and human-in-the-loop review.

```
+-----------------------------------------------------------------------------------------+
|                               DISCOVERY SUBSYSTEM                                       |
|  Greenhouse | Lever | Ashby | Workday | SmartRecruiters | Workable | Recruitee | HN/YC/Feed  |
+-----------------------------------------------------------------------------------------+
                                             |
                                             v
+-----------------------------------------------------------------------------------------+
|                          CANONICAL PERSISTENCE LAYER                                    |
|   data/job_agent.db (WAL Mode, Foreign Keys Enforced, Rerun-Safe Migrations 001-011)     |
|   Tables: companies, job_postings, candidate_facts, evidence_records, applications, ... |
+-----------------------------------------------------------------------------------------+
                                             |
                                             v
+-----------------------------------------------------------------------------------------+
|                           DUAL-TIER MATCHING ENGINE                                     |
|   Tier 1 Fast Triage: Seniority, Archetype, Role Negatives, Strict India Eligibility    |
|   Tier 2 Deep Evaluation: Text Extraction, YOE Extraction, A-G Scoring (1-5), Narrative |
|   Outputs: APPLY (>=4.0), CONSIDER (3.5-3.9), SKIP (<3.5)                              |
+-----------------------------------------------------------------------------------------+
                                             |
                                             v
+-----------------------------------------------------------------------------------------+
|                          APPLICATION & SAFETY SUBSYSTEM                                 |
|   Autofill Engine: Playwright DOM extraction & field semantic mapping                   |
|   HUMAN-IN-THE-LOOP REVIEW GATE: review CLI presents draft answers & documents          |
|   CRYPTOGRAPHIC TOKEN: HMAC-SHA256 one-time nonce with 15-min TTL                       |
|   SUBMISSION GATE: Submission strictly prohibited without valid user authorization      |
+-----------------------------------------------------------------------------------------+
                                             |
                                             v
+-----------------------------------------------------------------------------------------+
|                         TRACKING & RECONCILIATION LAYER                                 |
|   10-State Application Lifecycle: discovered -> ... -> applied -> interviewing ...       |
|   Bidirectional sync: data/job_agent.db <-> data/applications.md                        |
+-----------------------------------------------------------------------------------------+
```

---

## 2. Subsystem Architecture

### 2.1 Discovery Layer (`discovery/`)

The discovery subsystem scans verified public career endpoints directly through structured APIs rather than brittle HTML scraping:

- **Greenhouse (`GreenhouseAdapter`)**: Consumes `https://boards.greenhouse.io/v1/boards/{board}/jobs?content=true`. Extracts structured title, location, departments, and HTML descriptions.
- **Lever (`LeverAdapter`)**: Consumes `https://api.lever.co/v0/postings/{site}?mode=json`. Parses structured workplace type (remote/hybrid/onsite) and categorical tags.
- **Ashby (`AshbyAdapter`)**: Consumes `https://api.ashbyhq.com/posting-api/job-board/{board}`. Parses compensation tiers and employment types.
- **Workday (`WorkdayAdapter`)**: Interacts with the Workday CXS JSON endpoint (`https://{tenant}.wd3.myworkdayjobs.com/wday/cxs/...`). Supports multi-tenant corporate boards.
- **SmartRecruiters (`SmartRecruitersAdapter`)**: Interacts with `https://api.smartrecruiters.com/v1/companies/{company}/postings`. Implements offset pagination (`page`, `limit`) up to 20 pages (2,000 postings) per company run.
- **Workable (`WorkableAdapter`)**: Consumes `https://apply.workable.com/api/v1/widget/accounts/{board}`. Normalizes shortcodes, remote indicators, and experience levels.
- **Recruitee (`RecruiteeAdapter`)**: Consumes `https://{company}.recruitee.com/api/offers`. Normalizes department groupings and country tags.
- **Unstructured / Secondary Feeds**:
  - `HackerNewsAdapter`: Parses monthly "Who is hiring?" threads using custom regex and entity extraction.
  - `YCAdapter`: Ingests Work at a Startup job feeds.
  - `FeedAdapter`: Parses generic XML Atom/RSS career feeds.
- **Company Registry & Policy (`company-resolver.mjs`, `source-policy.mjs`)**: Normalizes domains, enforces rate limits, backoff schedules, and deduplicates company aliases.
- **Web Crawler (`discovery/crawler/`)**: Discovers candidate career pages from company homepages using breadth-first link crawling, SSRF protection, robots.txt compliance, and DNS pinning.

### 2.2 Persistence & Database Layer (`db/`, `data/`)

All system state is stored locally in SQLite (`data/job_agent.db`) via `better-sqlite3` and Node.js `node:sqlite`.

#### Critical DB PRAGMAs:
- `PRAGMA journal_mode = WAL;` (Concurrent read/write performance)
- `PRAGMA foreign_keys = ON;` (Strict relational integrity)
- `PRAGMA synchronous = NORMAL;` (Safe ACID durability)
- `PRAGMA busy_timeout = 5000;` (Handles transient lock contention)

#### Core Database Tables:
1. `schema_migrations`: Version tracking for migrations 001 through 011.
2. `companies`: Canonical employer entities (name, domain, ATS provider, board identifier, status).
3. `source_policies`: Scan policies, polling cadences, and rate limit rules.
4. `source_scans`: Scan audit log (records scanned, duration, status, errors).
5. `job_postings`: Normalized job records (title, company, URL, location, workplace type, source).
6. `job_snapshots`: Full immutable snapshots of raw posting payloads and timestamps.
7. `candidate_facts`: Atomic facts (education, experience, projects, skills, contact).
8. `evidence_records`: Verifiable proof points (metrics, publications, GitHub PRs, repo links) tied to facts.
9. `resume_versions`: Rendered versions of candidate CVs tailored to specific archetypes.
10. `candidate_answers`: Pre-approved answers to standard application questions.
11. `applications`: Active applications tracked against specific jobs.
12. `application_events`: Immutable state transition history with timestamps and actor telemetry.
13. `duplicate_suggestions`: Detected duplicate postings flagged for deduplication.
14. `job_evaluations`: Detailed Tier 1 and Tier 2 evaluation scores, rationale, and timestamps.

### 2.3 Candidate Profile & Evidence Ledger (`candidate_facts`, `evidence_records`)

The candidate's qualifications are ingested from `cv.md` and `config/profile.yml` into structured relational records:
- **Education**: Degree, institution, graduation date, GPA/CGPA.
- **Experience**: Verified past employment history with associated dates and technical scope.
- **Verified Projects**: Portfolio projects and documented technical implementations.
- **Proof Points**: Mapped to specific metric achievements and verified repository references.

### 2.4 Matching Engine (`matching/`)

The matching engine employs a two-tier evaluation model to combine high-throughput filtering with deep contextual analysis:

#### Tier 1 (Fast Triage):
- **Archetype Fit**: Categorizes role into Backend, Fullstack, Systems, DevOps, or AI/ML Platform.
- **Seniority Exclusion**: Immediately rejects Senior, Staff, Principal, Lead, Director, VP, and level designations (II/III/IV/2/3/4).
- **Title Negative Patterns**: Excludes managerial and ancillary titles (`Program Manager`, `Project Manager`, `Community Manager`, `Solution Architect`, `People Systems`).
- **India Location Gate**: Enforces geographic criteria:
  - Allowed: Explicit India locations (Bengaluru, Hyderabad, Pune, Delhi NCR, Mumbai, Chennai, Remote - India).
  - Allowed: Explicit global/worldwide remote roles that include India.
  - Rejected: Geographic restrictions excluding India (US/EU/UK only, LatAm only, specific non-India time zones).

#### Tier 2 (Deep Evaluation):
- **Text Preprocessing**: Replaces HTML block tags (`</p>`, `</li>`, `</div>`, `<br>`) with sentence delimiters (`. `) to ensure list items maintain sentence isolation.
- **Experience Extraction**: Normalizes Unicode en-dash (`–`) and hyphenated ranges (`4-6 years`), detects prepositional variations (`experience of X years`), and differentiates mandatory requirements from optional preferences (`is a plus`).
- **A–G Scoring Rubric (1–5 scale)**:
  - **A: Role Summary & Alignment** (Core tech stack match)
  - **B: CV & Skills Overlap** (Concrete overlap with verified candidate facts)
  - **C: Level & Seniority Fit** (0–2 years SWE calibration)
  - **D: Compensation & Terms** (Market alignment and transparency)
  - **E: Track Record & Proof Points** (Direct mapping to candidate projects)
  - **F: Interview Readiness** (STAR+R story coverage)
  - **G: Growth & Career Vector** (Technical runway)
- **Output Recommendations**:
  - `APPLY`: Score >= 4.0/5.0 with zero hard-blocker violations.
  - `CONSIDER`: Score 3.5–3.9 or high-potential role with minor addressable gap.
  - `SKIP`: Score < 3.5 or violation of hard criteria (excessive YOE, non-India remote).

### 2.5 Application & Review Safety Engine (`application/`)

The application engine provides automated form filling while maintaining absolute human oversight:

```
[Job Posting] -> [Playwright Form Autofill] -> [Review Packet Generated]
                                                       |
                                                       v
                                            [CLI: career-ops review]
                                                       |
                                                       v
                                             (User inspects data)
                                                       |
                                                       v
                                            [CLI: career-ops approve]
                                                       |
                                                       v
                                [Cryptographically Bound Submission Authorization]
                                                       |
                                                       v
                                            [CLI: career-ops submit]
                                                       |
                                                       v
                            (Submission with valid authorization token & receipt capture)
```

#### Non-Negotiable Safety Invariants:
1. **Zero Unattended Submissions**: The system CANNOT submit an application without a valid, cryptographic authorization token generated by explicit user approval.
2. **Cryptographic Authorization (`submission_authorizations`)**:
   - Cryptographic Bindings: Binds `packet_hash` (SHA-256 of review packet markdown), `resume_version_id`, and `payload_digest` (deterministic SHA-256 of mapped form values).
   - Single-use consumption: Consumed immediately prior to DOM submit click (`used_count = 1`). Cannot be reused.
   - Live DOM Verification: Resumption verifies live DOM fields against authorized `payload_digest`. On mismatch, retreats to `NEEDS_USER_INPUT` and halts.
3. **Form Detection & Field Mapping**: Identifies inputs, selects, textareas, and file upload buttons, mapping them semantically to pre-approved candidate facts.

### 2.6 Canonical State Machine & Tracking (`db/repo.mjs`, `tracking/`)

Applications progress through a strictly validated finite state machine defined in `templates/states.yml` and enforced by `LEGAL_TRANSITIONS` in `db/repo.mjs`:

```
NOT_STARTED
    │
    ▼
DRAFTING ──► PORTAL_OPENED ──► FORM_FILLING ──► READY_FOR_REVIEW ──► SUBMISSION_APPROVED ──► SUBMITTING ──► CONFIRMED
    ▲              │                 ▲               │      ▲                  │                   │
    │              ▼                 │               │      │                  ▼                   ▼
    └────── NEEDS_USER_INPUT ────────┴───────────────┘      └── (button disabled)           UNCERTAIN_OUTCOME
```

#### Transition Rules & Guarantees:
- **`READY_FOR_REVIEW -> SUBMISSION_APPROVED`**: Transitioned only after user grants explicit submission authorization.
- **`SUBMISSION_APPROVED -> READY_FOR_REVIEW`**: If the submit button in the portal DOM is disabled, execution safely retreats to `READY_FOR_REVIEW` without consuming authorization tokens.
- **`READY_FOR_REVIEW -> NEEDS_USER_INPUT`**: If live DOM form fields differ from authorized `payload_digest`, submission halts and retreats to `NEEDS_USER_INPUT`.
- **`SUBMITTING -> UNCERTAIN_OUTCOME`**: On browser crash or network interruption during submission, marks `UNCERTAIN_OUTCOME`; blind resubmission is blocked without manual reconciliation.
- **Receipt Persistence**: Successful submissions record portal confirmation codes into the canonical SQLite attribute: `applications.confirmation_reference` (deprecated alias: `confirmation_code`).
- Every state transition emits an immutable, idempotency-keyed audit event in `application_events`.
- `tracking/export-tracker.mjs` projects canonical database state into `data/applications.md`.
- `verify-pipeline.mjs` enforces canonical state naming and link validity.

### 2.7 Application Queue Consumer, Standing Authorization & Worker Leases (`application/worker.mjs`, `application/submission/standing-policy.mjs`)

Bridges the scheduler handoff queue (`applications.state = 'NOT_STARTED'`) and the execution/submission workflow.

#### 1. Atomic Database Leases (`application_leases`)
- Worker concurrency is coordinated through the `application_leases` table (Migration `012_application_worker_leases.sql`).
- Claim operation uses an atomic `INSERT ... ON CONFLICT DO UPDATE WHERE lease_expires_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now') OR status IN ('RELEASED', 'EXPIRED')`.
- Zero race conditions: concurrent workers trying to claim the same row fail atomically with 0 affected rows.
- Claims maintain worker identity, timestamp, lease expiry (default 300s), attempt counter, and heartbeat.

#### 2. Standing Authorization Policy Evaluator
- Automates high-fit opportunities through explicit, configurable standing criteria without manual approval:
  - **Job Eligibility**: Verified active status, permitted source, technical engineering title, India work authorization / location policy satisfied.
  - **Candidate Groundedness**: Zero unmapped required fields, zero unconfirmed sensitive questions, all claims backed by candidate facts.
  - **Payload Integrity**: Valid form mapping, review packet SHA-256 hash, tailored resume version ID, and payload digest verified.
  - **Policy Constraints**: Match score >= threshold (default 0.70), daily quota not exceeded (default 10/day), `auto_submit_enabled` safety gate active.
- Decision outcomes:
  - `AUTO_SUBMIT`: Issues standing authorization token and submits via existing submission path.
  - `PREPARE_AND_PAUSE`: Pauses safely at `READY_FOR_REVIEW` (or `NEEDS_USER_INPUT`) with structured review packet.
  - `REJECT`: Ineligible or terminal roles discarded safely.

#### 3. Quota Enforcement & Crash Recovery
- Daily quota accounts for `CONFIRMED`, `SUBMITTING`, `SUBMISSION_APPROVED`, and `UNCERTAIN_OUTCOME` applications on the current calendar day.
- Expired lease recovery (`recoverExpiredLeases`):
  - Applications in `CONFIRMED`: Marks lease `COMPLETED`.
  - Applications in `UNCERTAIN_OUTCOME`: Marks lease `UNCERTAIN` (blind retries strictly prohibited).
  - Applications in `NEEDS_USER_INPUT` or `READY_FOR_REVIEW`: Releases lease for manual/continuation handling.
  - Intermediate crashes (`DRAFTING`, `PORTAL_OPENED`, `FORM_FILLING`): Resets state to `NOT_STARTED` if `attempt_count < 3`; transitions to `FAILED` if retries exhausted.

#### 4. Operational CLI Commands
- `node application/cli.mjs worker inspect`: Displays queue status, active leases, and daily quota.
- `node application/cli.mjs worker cycle [--auto-submit]`: Claims and processes one queued application.
- `node application/cli.mjs worker batch [--limit N] [--auto-submit]`: Processes a bounded batch of applications.
- `node application/cli.mjs worker recover`: Inspects and recovers expired leases.
- `node application/cli.mjs worker quota`: Shows current daily submission counts and limits.

### 2.8 Recurring Runner & Supervised Autonomous Pipeline (`scripts/recurring-runner.mjs`)

Coordinates recurring end-to-end cycles across Discovery, Evaluation, Handoff Enqueue, Worker Consumption, and Failure Recovery in a strictly supervised staging environment.

```
+-----------------------------------------------------------------------------------------+
|                                RECURRING RUNNER (D4)                                    |
|   1. Preflight Safety Gate (R13): Enforces auto_submit_enabled === false                |
|   2. Overlap Lock: Single-process guarantee via PID-tracked .runner.lock                |
|   3. Bounded Stage Execution:                                                           |
|      - Stage 1: Pipeline (Discovery, Verify, Dedup, Evaluate, Enqueue)  [120s budget]   |
|      - Stage 2: Application Worker Queue Consumer                      [180s budget]   |
|      - Stage 3: Expired Lease Recovery & Reconciler                     [30s budget]    |
|   4. Observability & Run Audits: Structured reports in data/runs/cycle-<timestamp>.json  |
|   5. Alerting: High-priority operator alert when NEEDS_USER_INPUT > 5                   |
+-----------------------------------------------------------------------------------------+
```

#### 1. R13 Supervised Staging Safety Gate
- Hard fail-closed requirement: under staging and recurring operation, automated submissions are strictly prohibited.
- `checkAutoSubmitSafetyGate()` evaluates:
  1. Process environment: `AUTO_SUBMIT_ENABLED=1` trips immediate rejection.
  2. Standing policy: `config/standing-policy.json` with `auto_submit_enabled: true` trips immediate rejection.
  3. User profile: `config/profile.yml` with `auto_submit: true` trips immediate rejection.
- If any trigger is present, runner refuses to start and exits with code 1.

#### 2. Process Overlap Protection & Lockfile Lifecycle
- Atomic lock acquisition via `.runner.lock` containing JSON `{ pid, startTime, timestamp }`.
- Stale lock detection: checks if the recording PID is still active on the operating system; safely reclaims stale locks if the previous process died.
- Trapped signal handlers (`SIGINT`, `SIGTERM`) and process exit listeners guarantee cleanup of `.runner.lock` on termination.

#### 3. Bounded Stage Execution & Timeouts
- Each pipeline stage executes in a time-bounded harness (`runBoundedStage`):
  - **Pipeline Stage (`120s`)**: Runs `runUnifiedPipeline({ enqueue: true })`.
  - **Worker Stage (`180s`)**: Runs `runWorkerBatch({ limit: 5 })`.
  - **Recovery Stage (`30s`)**: Runs `recoverExpiredLeases()`.
- Unhandled timeouts or stage errors are caught and recorded without taking down the orchestrator.

#### 4. Run Telemetry & Operator Alerting
- Every cycle generates a timestamped report in `data/runs/cycle-<timestamp>.json`:
  - Execution summary, total duration, stage-by-stage timings, and exit statuses.
  - Snapshot of application queue counts (`NOT_STARTED`, `NEEDS_USER_INPUT`, `READY_FOR_REVIEW`, `CONFIRMED`, `UNCERTAIN_OUTCOME`).
  - Active worker leases and daily quota utilization.
- **Operator Threshold Alert**: If `needs_user_input > 5`, report triggers `HIGH_PRIORITY_ALERT` to notify the human operator that review intervention is required.
