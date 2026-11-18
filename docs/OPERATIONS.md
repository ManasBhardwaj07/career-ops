# Career Ops — Operations & Runbook

**Version:** 1.6.0
**Environment:** Node.js (v20+), Windows / macOS / Linux
**Primary Database:** `data/job_agent.db` (SQLite)
**Safety Protocol:** Strictly zero unattended submissions. All applications require explicit cryptographic user approval.

---

## 1. Quick Reference: Core Commands

| Operational Goal | Command | Description |
|---|---|---|
| **Run Full Regression Suite** | `npm run test:all` | Runs all 18 test suites across discovery, db, matching, application, and safety. |
| **Verify Pipeline Integrity** | `npm run verify` | Verifies canonical states, links, and formatting across tracking files. |
| **Check System Health** | `npm run doctor` | Runs diagnostics on dependencies, environment variables, and directories. |
| **Scan Verified Boards (DB)** | `npm run scan:db` | Runs ATS adapter discovery directly into SQLite (`data/job_agent.db`). |
| **Crawl Pilot Employers** | `npm run crawl:pilot` | Crawls configured company domains to discover new career endpoints. |
| **Run Matching Pipeline** | `npm run pipeline:run` | Runs Tier 1 triage and Tier 2 deep evaluation on discovered postings. |
| **Review Application Draft** | `npm run career-ops:review -- <app-id>` | Inspects autofilled form fields, resume version, and answers before approval. |
| **Approve Application** | `npm run career-ops:approve -- <app-id>` | Issues a 15-minute cryptographically signed HMAC token for submission. |
| **Submit Application** | `npm run career-ops:apply -- <app-id>` | Executes browser submission with user authorization token. |
| **Reconcile Tracker** | `npm run career-ops:reconcile` | Synchronizes SQLite application states with `data/applications.md`. |
| **Backup Database** | `npm run db:backup` | Creates an atomic hot backup in `backups/`. |
| **Check DB Integrity** | `npm run db:integrity` | Executes `PRAGMA integrity_check` and `PRAGMA foreign_key_check`. |

---

## 2. Test Execution & Database Safety Protocols

### 2.1 The Golden Safety Rule
> **NEVER run tests, benchmarks, or experimental scripts against `data/job_agent.db`.**
> All test scripts must configure an isolated temporary SQLite path via `process.env.JOB_AGENT_DB_PATH` before importing any database or repository modules.

Every test file enforces a fail-closed guard:
```javascript
const resolvedDbPath = resolve(getDbPath());
if (resolvedDbPath === CANONICAL_DB_PATH) {
    throw new Error(`SAFETY ABORT: Test resolved to canonical DB (${resolvedDbPath})`);
}
```

### 2.2 Test Suite Matrix
To run individual test suites during development:

```bash
# Database & Core Storage (Phase 1)
node test-db-phase1.mjs

# Discovery Adapters (Milestone 2A)
node test-discovery-milestone2a.mjs

# Employer Registry & Normalization (Milestone 2B)
node test-employer-registry-m2b.mjs

# Web Crawler & Signature Detection (Milestone 2C)
node test-crawler-milestone2c.mjs

# Candidate Fact Ingestion (Milestone 3A)
node test-milestone3a.mjs

# Dual-Tier Matching Engine (Milestone 3B)
node test-milestone3b.mjs

# Browser Autofill Engine (Milestone 3C)
node test-milestone3c.mjs

# Cryptographic Review & Approval Gate (Milestone 3D)
node test-milestone3d.mjs

# Application State Machine & Reconciliation (Milestone 3E)
node test-milestone3e.mjs
node test-milestone3e-batch-c.mjs

# Phase 4B & 4C Verification Suites
node test-phase4b-legacy-auth.mjs
node test-phase4b-e2e.mjs
node test-phase4c-batch1.mjs
node test-phase4c-batch2.mjs
node test-phase4c-batch2-1.mjs
node test-phase4c-batch3.mjs
node test-phase4c-batch4.mjs
```

---

## 3. Job Discovery & Board Scanning

### 3.1 Scanning Verified Boards into SQLite
To discover new opportunities from verified company career boards:

```bash
# Scan all active boards configured in database source policies
node scan-sqlite.mjs

# Scan only a specific ATS provider
node scan-sqlite.mjs --source greenhouse
node scan-sqlite.mjs --source lever
node scan-sqlite.mjs --source ashby
node scan-sqlite.mjs --source smartrecruiters
node scan-sqlite.mjs --source workable
node scan-sqlite.mjs --source recruitee

# Scan a single company board
node scan-sqlite.mjs --source smartrecruiters --company sixt
node scan-sqlite.mjs --source greenhouse --company enterpret

# Dry run (fetch and parse without writing to database)
node scan-sqlite.mjs --dry-run
```

### 3.2 Managing Employer Registry
To inspect, verify, and measure employer coverage:

```bash
# List all registered employers
npm run companies:list

# Verify active status and DNS/URL reachability
npm run companies:verify

# Inspect ATS coverage breakdown
npm run companies:coverage
```

---

## 4. Matching & Opportunity Evaluation

### 4.1 Running the Dual-Tier Pipeline
To process newly discovered postings through Tier 1 fast triage and Tier 2 deep scoring:

```bash
# Evaluate all un-evaluated postings in database
npm run pipeline:run

# Evaluate with limit
node matching/scheduler.mjs --pipeline --limit 50
```

### 4.2 Scoring Interpretation
- **APPLY (Score >= 4.0)**: Prime candidate match. Meets 0–2 YOE profile, core stack alignment (TypeScript, Python, Node, Go, React, Systems), verified India presence or open remote, zero disqualifiers.
- **CONSIDER (Score 3.5–3.9)**: Strong adjacent match. Minor experience delta (e.g. 2–3 years), non-primary Indian tech hub location, or adjacent technical focus.
- **SKIP (Score < 3.5)**: Disqualified due to seniority (Senior/Staff/Lead/Manager), geographic restriction (US/EU only), or stack mismatch.

---

## 5. Application Preparation & Human-in-the-Loop Workflow

Submitting an application follows a mandatory 3-step human verification sequence:

### Step 1: Form Autofill & Review
The system uses Playwright to detect form fields on the target ATS page and map them against candidate facts.
```bash
npm run career-ops:review -- <app-id>
```
The CLI displays:
- Company and job title
- Target ATS submission URL
- Pre-filled personal info, LinkedIn, GitHub, and portfolio links
- Selected resume PDF version
- Proposed answers to employer-specific questions
- Any fields flagged for manual attention

### Step 2: Explicit Human Approval
If the review is satisfactory, the user explicitly issues authorization:
```bash
npm run career-ops:approve -- <app-id>
```
This action:
1. Validates that all required fields are complete.
2. Computes an HMAC-SHA256 authorization token with a single-use random nonce and a 15-minute expiration timestamp.
3. Records an `APPROVED` event in `application_events`.
4. Writes the token to application checkpoint storage.

### Step 3: Application Submission
Once approved, the user triggers submission:
```bash
npm run career-ops:apply -- <app-id>
```
The application engine verifies the token's signature, timestamp, and nonce. If valid, the browser session completes the final submit button action and records confirmation telemetry.

---

## 6. Database Maintenance & Backups

### 6.1 Creating Atomic Hot Backups
```bash
npm run db:backup
```
Creates a timestamped snapshot in `backups/` using SQLite's online backup API, ensuring zero downtime or table locking.

### 6.2 Health & Integrity Verification
```bash
npm run db:integrity
```
Executes:
1. `PRAGMA integrity_check` (verifies B-tree structure, page allocations, indices).
2. `PRAGMA foreign_key_check` (confirms referential integrity across all 14 tables).

### 6.3 Reconciling Canonical Trackers
```bash
npm run career-ops:reconcile
npm run verify
```
Ensures bidirectional synchronization between the SQLite `applications` table and the markdown tracker `data/applications.md`.

---

## 7. Application Queue Worker & Standing Policy Runbook

### 7.1 Inspecting the Queue and Daily Quota
```bash
node application/cli.mjs worker inspect
node application/cli.mjs worker quota
```
Shows the number of `NOT_STARTED` opportunities enqueued by the scheduler, active worker leases, and current daily submission quota usage.

### 7.2 Processing Queued Applications
```bash
# Process a single queued application through form preparation and policy evaluation:
node application/cli.mjs worker cycle

# Process a bounded batch of queued applications:
node application/cli.mjs worker batch --limit 5

# Enable automated submission for strong matches satisfying all standing criteria:
node application/cli.mjs worker batch --limit 5 --auto-submit
```

### 7.3 Recovering Expired Leases & Handling Crashes
```bash
node application/cli.mjs worker recover
```
Scans for worker claims whose lease has expired. Safely resets crashed jobs to `NOT_STARTED` if retry attempts < 3, while preserving `UNCERTAIN_OUTCOME`, `CONFIRMED`, and human checkpoint states without blind resubmission.

### 7.4 Individual Application Submissions
```bash
# Review prepared review packet
node application/cli.mjs review --application <appId>

# Approve application manually
node application/cli.mjs approve --application <appId>

# Submit approved application
node application/cli.mjs submit --app <appId>
```

---

## 8. Recurring Runner & Supervised Autonomous Operations

The Recurring Runner (`scripts/recurring-runner.mjs`) orchestrates unified discovery, candidate matching, handoff enqueueing, worker consumption, and lease recovery in a single supervised pipeline cycle.

### 8.1 Supervised Staging Execution

```bash
# Execute a single supervised cycle in dry-run mode (no database writes):
node scripts/recurring-runner.mjs --once --dry-run

# Execute a single supervised cycle against the canonical database:
node scripts/recurring-runner.mjs --once

# Execute against an isolated clone or sandbox database:
node scripts/recurring-runner.mjs --once --db data/clone_job_agent.db
```

### 8.2 R13 Supervised Staging Safety Gate

Under staging and recurring runner operation, automatic submission is **strictly fail-closed**:
- The runner automatically checks process environment, `config/standing-policy.json`, and `config/profile.yml`.
- If `auto_submit_enabled: true` or `AUTO_SUBMIT_ENABLED=1` is detected, the runner refuses to execute and exits immediately with an error.
- All opportunities advancing to submission readiness are safely parked at `READY_FOR_REVIEW` for operator verification.

### 8.3 Overlap Lock & Stale Lock Recovery

The runner manages process concurrency using an OS-level lockfile (`.runner.lock`):
- If another runner is actively executing, subsequent invocations exit immediately with `RUNNER_ACTIVE`.
- If a runner crashed or was abruptly terminated, subsequent invocations inspect the recorded PID. If the process is no longer active, the stale lock is safely reclaimed automatically.
- To inspect or manually clear a lock (if orphaned across OS reboots):
  ```bash
  # Check if lockfile exists
  cat .runner.lock
  # Remove lockfile manually if process is dead
  rm .runner.lock
  ```

### 8.4 Cycle Reports & Operator Alerting

Every execution writes a structured JSON report to `data/runs/cycle-<timestamp>.json`:
- Contains per-stage durations, statuses, applications enqueued, applications processed, and quota usage.
- **Operator Alert (`HIGH_PRIORITY_ALERT`)**: If the number of applications in `NEEDS_USER_INPUT` exceeds 5, the cycle report flags an alert:
  ```json
  {
    "alert": "HIGH_PRIORITY_ALERT: 6 applications require human answers/verification",
    "needs_user_input": 6
  }
  ```
- Operators can review pending questions using:
  ```bash
  node application/cli.mjs worker inspect
  node application/cli.mjs review --application <appId>
  ```
