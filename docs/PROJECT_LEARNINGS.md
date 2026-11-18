# Career Ops — Project Learnings & Architectural Register

**Version:** 1.6.0
**Status:** Feature-Frozen / Operational Archive
**Scope:** Cumulative insights and design lessons across Milestones 1–3, Phase 4B, and Phase 4C (Batches 1–4.1).

---

## 1. Candidate Profile & Career Targeting

1. **Explicit Career Stage Anchoring**:
   - The candidate profile is an early-career software engineer with verified industry internships and projects.
   - Matching models that lack an explicit hard upper ceiling on years-of-experience (YOE) will inevitably waste evaluation cycles and introduce false positives for Senior (4–6+ years), Staff, and Principal listings.
2. **Title Level Nuance**:
   - Many companies (e.g. SIXT, Sarvam, ClanX) use ambiguous numerical suffixes (e.g., "SRE II", "AI/ML Ops SWE II") that map to 3–6 years of experience rather than entry-level roles.
   - Suffixes like `II`, `III`, `IV`, `2`, `3`, `4` must be treated as senior/mid-plus exclusions unless explicitly verified otherwise by the job description text.
3. **Managerial Title Rejections**:
   - Roles like "Technical Program Manager", "Project Manager", "Developer Community Manager", and "People Systems" frequently pass naive keyword filters because they include words like "developer", "technical", or "systems". Strict negative title pattern matching is required.
4. **Geographic Eligibility Realities**:
   - Remote listings fall into five distinct categories:
     1. Explicitly India-based.
     2. Roles with an Indian office/entity but uncertain applicant qualification.
     3. Global remote explicitly accepting Indian talent.
     4. Remote with unspecified geographic restrictions (often US/EU only in practice).
     5. Roles explicitly excluding India.
   - Defaulting ambiguous remote roles to `APPLY` causes severe false positive rates. They must be routed to `CONSIDER` or `UNCERTAIN` for manual human review.

---

## 2. Job Discovery & ATS Architecture

5. **Direct ATS APIs vs HTML Scraping**:
   - HTML scraping of career pages is notoriously brittle due to client-side hydration, SPAs, and changing CSS classes.
   - Directly integrating with ATS backend APIs (Greenhouse REST, Lever JSON, Ashby Posting API, SmartRecruiters Postings API, Workable Widget API, Recruitee API) yields 100% structured data reliability, zero DOM parsing failures, and clean metadata (published dates, employment types, workplace categories).
6. **SmartRecruiters Pagination**:
   - SmartRecruiters' public posting endpoint (`api.smartrecruiters.com/v1/companies/{company}/postings`) defaults to 100 results per page. Large global employers (such as SIXT with 550+ vacancies) will silently truncate unless offset-based pagination (`page`, `limit`) is implemented.
   - Increasing page depth to 20 pages (up to 2,000 jobs) ensures full catalog capture.
7. **Workable Widget API Architecture**:
   - Workable's widget API (`apply.workable.com/api/v1/widget/accounts/{board}`) returns high-fidelity job cards with shortcodes, remote indicators, and department hierarchies without requiring private API tokens.
8. **Recruitee Careers API Architecture**:
   - Recruitee's public offers endpoint (`{company}.recruitee.com/api/offers`) provides clean, unauthenticated JSON with country tags and publication timestamps.
9. **Agency & Aggregator Boards**:
   - Recruiting agencies and talent marketplaces (e.g., ClanX) host jobs on behalf of client employers. The discovery adapter must attribute the hosting board as provenance while extracting client names from listing descriptions.
10. **SSRF & DNS Rebinding Protection in Web Crawlers**:
    - Pilot career crawlers must implement DNS pinning and IP validation to block intranet/metadata endpoints (e.g., `169.254.169.254`, `127.0.0.1`, `::1`) and reject off-host 303/302 redirects.

---

## 3. Persistence, Lifecycle & Canonical Data

11. **Single Source of Truth**:
    - The SQLite database (`data/job_agent.db`) is the sole canonical source of truth for all entities. Markdown files (`applications.md`, `pipeline.md`) and TSV logs are derived views and ingestion buffers.
12. **Foreign Key Enforcement**:
    - In SQLite, `PRAGMA foreign_keys = ON;` must be set per connection. Enabling it universally prevents orphaned records across jobs, snapshots, applications, and events.
13. **Migration Idempotency**:
    - Schema migrations must be strictly idempotent and versioned. Using a `schema_migrations` ledger ensures that restarting or rerunning migrations never corrupts existing state or fails on existing tables/indices.
14. **Application State Machine Integrity**:
    - Managing job applications requires a deterministic finite state machine (10 canonical states). Transitions must be validated before execution, and every transition must generate an immutable audit log entry in `application_events`.
15. **Primary Key vs Unique Constraints in Upserts**:
    - SQLite `ON CONFLICT(col)` requires targeting the specific constraint that collides. When a table has both a primary key (`id`) and a unique business key (`job_id`), application logic must resolve ID collisions before executing `ON CONFLICT(job_id)`.

---

## 4. Matching Engine Heuristics & Text Processing

16. **HTML Sentence Boundary Preservation**:
    - Converting raw HTML job descriptions into plain text by naively stripping tags causes bulleted list items to merge into adjacent sentences:
      `<li>4+ years of experience</li><li>Knowledge of Go is a plus</li>`
      becomes:
      `4+ years of experience Knowledge of Go is a plus`
    - A naive regex searching for "is a plus" in the same sentence would mistakenly treat the mandatory 4+ years requirement as optional!
    - Replacing closing block tags (`</li>`, `</p>`, `</div>`, `<br>`) with full sentence delimiters (`. `) maintains strict sentence boundaries.
17. **Unicode Range Character Normalization**:
    - Employers and ATS platforms frequently use Unicode en-dashes (`–`, `\u2013`) or em-dashes rather than standard ASCII hyphens (`-`) when describing experience ranges (e.g. `4–6 years`). Normalizing all dash variants before regex matching is critical.
18. **Prepositional and Phrasing Variations in Experience Extraction**:
    - Job descriptions describe experience in diverse ways: "experience of 4-6 years", "4+ years in backend engineering", "4 to 6 years of full-time software development". Regex patterns must accommodate prepositions, ranges with "to", and domain qualifiers.
19. **Dual-Tier Triage Efficiency**:
    - Running full LLM evaluations or deep parsing on thousands of raw postings is computationally wasteful.
    - Tier 1 fast rule triage filters out >90% of irrelevant postings (senior titles, disqualified locations, wrong tech domains) in milliseconds, allowing Tier 2 deep evaluation to focus only on genuine candidates.

---

## 5. Application Automation & Safety

20. **Zero Unattended Submissions is Non-Negotiable**:
    - Autonomous submission of job applications without human verification is ethically fraught, error-prone, and risks candidate reputation (e.g. submitting hallucinated answers or inappropriate salary expectations).
    - The system strictly enforces human review and explicit cryptographic token authorization before any submit action can execute.
21. **Cryptographic Authorization Tokens**:
    - Authorization tokens are HMAC-SHA256 digests bound to the candidate ID, job ID, submission payload hash, timestamp, and a single-use random nonce with a 15-minute TTL. This prevents replay attacks, token tampering, and stale submissions.
22. **Autofill Checkpointing & User Input Recovery**:
    - When form autofill encounters unknown or sensitive questions (e.g. legal disclosures, visa sponsorship, disability status), it must halt gracefully with a structured `NEEDS_USER_INPUT` checkpoint rather than guessing or aborting.

---

## 6. Testing, Harness Design & Database Safety

23. **Universal Fail-Closed Test Isolation**:
    - Tests must NEVER read or write from the canonical production database `data/job_agent.db`.
    - Every test suite must configure an isolated temporary database path via `process.env.JOB_AGENT_DB_PATH` *before* importing any database modules.
    - Every test entry point must enforce a fail-closed guard that aborts execution immediately if the resolved database path equals the canonical database path.
24. **Independent Test Cleanup**:
    - Tests that create temporary database files, WAL logs, or temporary directories must register cleanup routines on process exit (`process.on('exit')`, `finally` blocks) to prevent disk residue and test pollution.
25. **Realistic Offline Fixtures**:
    - Offline test suites must utilize recorded, realistic ATS payloads and HTML fixtures rather than synthetic toy mocks to ensure that edge cases (Unicode characters, unusual JSON structures, missing fields) are validated before production runs.
