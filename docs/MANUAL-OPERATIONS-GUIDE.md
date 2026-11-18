# Career-Ops — Manual Operations & Production Guide

This document is the definitive operational manual for running **Career-Ops** in **supervised operating mode**. It provides verified, copy-paste Windows PowerShell commands for day-to-day operation, queue inspection, tailored resume compilation, visible browser application dry-runs, review packet auditing, and Windows Task Scheduler management.

---

## 1. Operating Philosophy & Architecture Guardrails

Career-Ops operates under strict safety and architectural invariants:

1. **Supervised Staging Mode by Default:**
   The recurring pipeline discovers, normalizes, deduplicates, and evaluates job opportunities. When preparing an application, it tailors an evidence-grounded resume, compiles a 1-page PDF, launches a controlled browser session, populates DOM fields, uploads the resume, and stops cleanly at `READY_FOR_REVIEW` or `NEEDS_USER_INPUT`.
2. **Zero Unattended Submissions:**
   `auto_submit_enabled: false` is enforced in code, CLI flags, standing policy, and the recurring runner. Automatic form submission is strictly prohibited. Final submission requires explicit human review and authorization.
3. **Zero Fabrication ($R16):**
   All resume bullets and form answers trace strictly to verified candidate facts (`config/autofill-profile.yml`, `cv.md`). Any ungrounded metric or unverified technical skill (e.g., Python, Golang) triggers an immediate `AntiFabricationViolationError` fail-closed exception.
4. **Isolated Testing:**
   All diagnostic tests and validation scripts execute against isolated, disposable database copies. The canonical database (`data/job_agent.db`) is protected against test contamination.
5. **Human Checkpoints for Sensitive Questions:**
   Salary history, non-compete agreements, and legal declarations halt automation at `NEEDS_USER_INPUT` until confirmed by the candidate.

---

## 2. Pre-Flight Environment Verification

Before running operations, verify that runtime dependencies, compilers, and database files are intact:

```powershell
# 1. Change to the repository working directory
cd path\to\career-ops

# 2. Verify Node.js runtime (v24.12+ required)
node --version

# 3. Verify LaTeX engine (Tectonic 0.17.0+ required)
tectonic --version

# 4. Verify canonical SQLite database integrity
node -e "
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/job_agent.db');
const check = db.prepare('PRAGMA integrity_check').get();
console.log('Database integrity:', check.integrity_check);
const companies = db.prepare('SELECT COUNT(*) as count FROM companies').get().count;
const jobs = db.prepare('SELECT COUNT(*) as count FROM job_postings').get().count;
console.log('Total companies:', companies, '| Total job postings:', jobs);
db.close();
"
```

---

## 3. Live Job Discovery & Pipeline Execution

Career-Ops scans official career portals (Greenhouse, Lever, Ashby, Workday, etc.) using employer rotation policies.

### Run a Single Supervised Discovery Cycle

To manually execute one bounded discovery and evaluation cycle:

```powershell
# Runs discovery, candidate matching, and worker queue processing with auto-submission disabled
node scripts/recurring-runner.mjs --once
```

### Inspect Recent Scheduled Discovery Logs

The recurring runner writes execution logs to `data/runs/`:

```powershell
# View the last 50 lines of the scheduled runner log
Get-Content data\runs\scheduled-runner.log -Tail 50

# List recent cycle JSON summary reports
Get-ChildItem data\runs\cycle-*.json | Sort-Object LastWriteTime -Descending | Select-Object -First 5
```

---

## 4. Opportunity Queue & Matching Inspection

The configured candidate profile has verified professional employment (~7 months across past internships/roles; early career engineer). The matching engine enforces strict eligibility:
- **Tier 1:** Title Screening (identifies target engineering roles; eliminates non-technical or executive roles).
- **Tier 2:** Hard Eligibility Gates (Senior/Lead/Staff roles requiring 5+ years experience fail `experience_seniority`; foreign postings lacking India work authorization fail `work_authorization`; postings lacking location or compensation fail-closed to `UNKNOWN`).
- **Tier 3:** Technical Matching (0.0 to 1.0 fact-grounded score).

### Inspect Top Discovered Opportunities

```powershell
node -e "
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/job_agent.db');
const active = db.prepare(\`
    SELECT jp.id, jp.title, c.name as company, jp.location, jp.source, jp.job_url
    FROM job_postings jp
    LEFT JOIN companies c ON jp.company_id = c.id
    WHERE jp.status = 'active'
    ORDER BY jp.discovered_at DESC
    LIMIT 10
\`).all();
console.log('Latest Active Postings:', JSON.stringify(active, null, 2));
db.close();
"
```

### Check Current Review Queue States

```powershell
node -e "
import { DatabaseSync } from 'node:sqlite';
import { OPERATIONAL_APPLICATION_FILTER_SQL } from './application/fixtures.mjs';
const db = new DatabaseSync('data/job_agent.db');
const stats = db.prepare(\`
    SELECT state, COUNT(*) as count
    FROM applications a
    WHERE \${OPERATIONAL_APPLICATION_FILTER_SQL}
    GROUP BY state
\`).all();
console.log('Operational Application Pipeline Counts:');
console.table(stats);
db.close();
"
```

---

## 5. Resume Tailoring & ATS PDF Compilation

Career-Ops dynamically tailors the candidate's resume for Backend, Fullstack, or Platform roles while strictly preserving template formatting, 1-page limits, and verified candidate facts.

### Generate a Tailored Resume for a Specific Role

```powershell
# Generate tailored resume for Backend Engineer
node -e "
import { generateLatexResume } from './resume/generate-latex-resume.mjs';
const res = await generateLatexResume({
    variantLabel: 'backend',
    outputDir: 'output/resumes'
});
console.log('Generated PDF:', res.pdfPath);
console.log('1-Page Budget Passed:', res.onePageBudgetPassed);
"

# Generate tailored resume for Fullstack Developer
node -e "
import { generateLatexResume } from './resume/generate-latex-resume.mjs';
const res = await generateLatexResume({
    variantLabel: 'fullstack',
    outputDir: 'output/resumes'
});
console.log('Generated PDF:', res.pdfPath);
console.log('1-Page Budget Passed:', res.onePageBudgetPassed);
"
```

### Verify Resume Hash & ATS Link Integrity

```powershell
node -e "
import { calculatePdfHash } from './resume/generate-latex-resume.mjs';
import { validateCompiledPdf } from './resume/validate-pdf.mjs';
import fs from 'fs';

const pdfPath = 'output/resumes/jordan-lee-backend.pdf';
if (fs.existsSync(pdfPath)) {
    console.log('SHA-256:', calculatePdfHash(pdfPath));
    const val = validateCompiledPdf(pdfPath);
    console.log('Page Count:', val.pageCount);
    console.log('Valid ATS Compliance:', val.valid);
} else {
    console.log('Run the generation step first.');
}
"
```

---

## 6. Visible Browser Application Dry-Run & Browser Selection

Career-Ops automates employer portal interactions using Playwright.

### Browser Architecture & Edge vs. Chrome

- **Dedicated Automation Context:**
  Playwright requires a direct Chrome DevTools Protocol (CDP) debugging connection. Pre-existing, already-running personal browser tabs cannot be controlled or scripted by automation because Windows security and Chromium process isolation prevent attaching external automation hooks to personal browsing sessions without a dedicated debugging port (`--remote-debugging-port`).
- **Microsoft Edge Support:**
  Career-Ops supports Microsoft Edge alongside Google Chrome. By passing `--browser edge` (or setting the environment variable `$env:CAREER_OPS_BROWSER = "edge"`), Playwright directly launches Microsoft Edge with its isolated profile (`data/browser_profile`), renders the form on your screen, autofills all mapped fields, attaches the tailored resume PDF, and pauses for your inspection.

### Run a Controlled Browser Dry-Run in Microsoft Edge

```powershell
# Visible headful execution using Microsoft Edge (stops safely before submit)
node application/cli.mjs apply --job "https://jobs.ashbyhq.com/plane/188f905e-3f6f-4569-9a32-d8ec48dfe656" --headless false --browser edge --dry-run
```

### Run a Controlled Browser Dry-Run in Google Chrome

```powershell
# Visible headful execution using Google Chrome (stops safely before submit)
node application/cli.mjs apply --job "https://jobs.ashbyhq.com/plane/188f905e-3f6f-4569-9a32-d8ec48dfe656" --headless false --dry-run
```

*Note: The browser window remains open on your screen strictly for visual field and PDF inspection. In dry-run mode, form submission is intentionally disabled. When finished inspecting, press Enter in the terminal to close the session. Never attempt to submit an application after closing the session.*

---

## 7. Public Job Feed Scanner (Phase 4C)

In addition to career-page crawling, Career-Ops scans configured public job feeds (Remote OK, Himalayas, Remotive, Jobicy, We Work Remotely, Adzuna).

```powershell
# Preview public feed discovery without database mutation
node scan-sqlite.mjs --dry-run --feeds-only

# Execute live public feed discovery and job ingestion
node scan-sqlite.mjs --feeds-only

# Scan a specific public feed provider
node scan-sqlite.mjs --source remoteok
```

---

## 8. Application Review CLI & Review Packets

Whenever an application reaches `READY_FOR_REVIEW` or `NEEDS_USER_INPUT`, Career-Ops produces a Markdown review packet in `output/review-packets/`.

### Application Management CLI Commands

```powershell
# 1. List operational applications (excludes all synthetic test fixtures)
node application/cli.mjs list

# 2. Inspect a specific application review packet
node application/cli.mjs review --app app_1794855464239_wynfqx

# 3. Record candidate answer for a pending question (e.g. Hyderabad relocation)
node application/cli.mjs answer --app app_1794855464239_wynfqx --key "relocate_hyderabad" --value "Yes"

# 4. Authorize application submission (generates cryptographically bound single-use token)
node application/cli.mjs approve --app app_1794855464239_wynfqx

# 5. Execute controlled submission under explicit authorization
node application/cli.mjs submit --app app_1794855464239_wynfqx --headless false

# 6. Reconcile an ambiguous outcome (if portal timed out during submit)
node application/cli.mjs reconcile --app app_1794855464239_wynfqx --outcome confirmed --ref "CONF-MANUAL-1234"
```

### Inspect the Raw Markdown Review Packet

```powershell
# List generated review packets
Get-ChildItem output\review-packets\*.md | Sort-Object LastWriteTime -Descending | Select-Object -First 5

# View the latest review packet
$latestPacket = Get-ChildItem output\review-packets\*.md | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Get-Content $latestPacket.FullName
```

The review packet includes:
- Company and job details.
- Attached resume PDF path, page count, and SHA-256 hash.
- Complete table of mapped form answers with confidence scores and source facts.
- Validation findings (any unmapped required fields, unconfirmed sensitive questions).
- Submission status and authorization requirement.

---

## 9. Managing Windows Task Scheduler Background Runner

The recurring runner is registered in Windows Task Scheduler as `\CareerOps-PipelineRunner` with a 4-hour recurrence.

### Check Task Scheduler Status

```powershell
schtasks /query /tn "\CareerOps-PipelineRunner" /fo list /v
```

### Trigger an Immediate Run via Task Scheduler

```powershell
schtasks /run /tn "\CareerOps-PipelineRunner"
```

### Temporarily Disable Scheduled Execution

```powershell
schtasks /change /tn "\CareerOps-PipelineRunner" /disable
```

### Re-Enable Scheduled Execution

```powershell
schtasks /change /tn "\CareerOps-PipelineRunner" /enable
```

---

## 10. Go Dashboard TUI & Unit Testing

Career-Ops includes an interactive terminal dashboard in `dashboard/` implemented in Go for real-time tracking of applications and pipeline metrics.

### Environment Prerequisites
- Go toolchain (version 1.21 or later). Install via `winget install GoLang.Go` or from [go.dev/dl](https://go.dev/dl/).
- Ensure `go.exe` is added to system `PATH` (typically `C:\Program Files\Go\bin`).

### Running Dashboard Tests
```powershell
cd dashboard
go test ./...
```

### Launching the Terminal Dashboard
```powershell
cd dashboard
go run main.go
```

---

## 11. Controlled Manual Submission Workflow

When human review is complete and you decide to proceed with application submission:

1. **Verify Answers:**
   Review the generated review packet in `output/review-packets/` and verify that all facts are grounded.
2. **Confirm Candidate Answers in Answer Bank:**
   If the portal asked custom questions, record verified answers using `upsertCandidateAnswer` in `db/repo.mjs` or `node application/cli.mjs answer --app <appId> --key <key> --value <value>`.
3. **Approve Application (Authorization Token Generation):**
   Run `node application/cli.mjs approve --app <appId>`. This calculates cryptographic digests over the review packet, candidate payload, and resume version, creating a single-use authorization token.
4. **Execute Controlled Submission:**
   Run `node application/cli.mjs submit --app <appId> --headless false`.
   - *Important:* Do not expect or attempt manual submit clicks after a browser session has closed or during dry-run sessions.
   - The CLI opens an active browser under supervision, navigates to the portal, populates all verified answers, consumes the single-use token, submits the application, captures the confirmation page screenshot and receipt, and updates SQLite.
5. **Receipt Capture & Tracker Synchronization:**
   The submission module automatically extracts the confirmation reference, receipt URL, and timestamp, updates SQLite status to `CONFIRMED`, and syncs `data/applications.md`.

---

## 12. Routine Recovery & Disaster Procedures

### Safe Stale Runner Lock Clearance

The recurring runner has built-in staleness detection and automatically breaks orphaned locks if the PID is dead or if the cycle has exceeded max lock age. If you need to manually inspect or clear a suspected lock, **always verify that the PID is not running** before deleting:

```powershell
# Safe stale lock inspection and clearance:
if (Test-Path data\runner.lock) {
    try {
        $lock = Get-Content data\runner.lock -Raw | ConvertFrom-Json
        $proc = if ($lock.pid) { Get-Process -Id $lock.pid -ErrorAction SilentlyContinue } else { $null }
        if ($proc) {
            Write-Warning "Runner process PID $($lock.pid) is currently ACTIVE at stage '$($lock.stage)'. Do NOT delete runner.lock."
        } else {
            Write-Host "Lock file PID $($lock.pid) is no longer running. Safely removing stale lock."
            Remove-Item data\runner.lock -Force
        }
    } catch {
        Write-Warning "Unparseable or corrupted lock file. Removing: $_"
        Remove-Item data\runner.lock -Force
    }
} else {
    Write-Host "No runner.lock file present."
}
```

### Routine Worker Lease Recovery (Non-Destructive)

If a worker execution crashed midway through processing, reclaim expired leases without touching application data:

```powershell
node -e "
import { recoverExpiredLeases } from './application/worker.mjs';
const recovered = recoverExpiredLeases();
console.log('Expired leases recovered:', recovered);
"
```

### WAL Checkpoint (Non-Destructive)

To safely flush the SQLite Write-Ahead Log into the canonical database file:

```powershell
node -e "
import { getDb } from './db/db.mjs';
const db = getDb();
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
console.log('WAL checkpoint complete.');
"
```

### Destructive Disaster Recovery (NOT Routine Recovery)

> [!WARNING]
> Overwriting `data/job_agent.db` with a backup is a destructive disaster recovery operation of last resort. It wipes all live job postings, application records, review packets, and discovery history created since the backup date. NEVER run this as routine recovery or troubleshooting. Use this ONLY if `data/job_agent.db` suffers unrecoverable physical disk or SQLite corruption (`PRAGMA integrity_check` fails).

```powershell
# Verify backup directory and integrity
Get-ChildItem data\backup\*.db

# Verify backup SHA-256 hash
Get-FileHash data\backup\job_agent_backup_20261116.db -Algorithm SHA256

# ONLY IN EVENT OF CATASTROPHIC DATABASE CORRUPTION:
# Copy-Item data\backup\job_agent_backup_20261116.db data\job_agent.db -Force
```
