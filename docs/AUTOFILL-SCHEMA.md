# Canonical Autofill Schema Specification

**Version:** 1.0.0
**Status:** Canonical Reference
**Scope:** Automated & Gated Application Form Filling

This document defines the canonical schema of 72 standard application form attributes used by Career-Ops. Every attribute belongs to one of seven functional categories, specifying its standard key, data type, illustrative example, sensitive gating requirement (R18), and authoritative source of truth.

---

## 1. Safety & Provenance Discipline

1. **R16 Grounding Guarantee:** Every field value must originate directly from verified profile data (`config/autofill-profile.yml`), ingested candidate facts (`candidate_facts`), or user-attested answers (`candidate_answers`). Zero synthetic or hallucinated values are permitted.
2. **R18 Sensitive Gating Protocol:** Fields marked with `sensitive: true` (e.g., compensation numbers, government identifiers, diversity indicators, birth dates) **must never be automatically populated** on an external portal unless `confirmed_by_user: true` is explicitly stored. Unconfirmed encounters trigger `NEEDS_USER_INPUT` immediately.

---

## 2. Canonical Field Matrix

### Category 1: Identity (14 Fields)
Primary personal and contact attributes required by applicant tracking systems.

| Field Key | Type | Example Value | Sensitive | Source of Truth |
| :--- | :--- | :--- | :---: | :--- |
| `first_name` | string | `Alex` | No | Profile / CV |
| `middle_name` | string | `""` | No | Profile / CV |
| `last_name` | string | `Doe` | No | Profile / CV |
| `full_name` | string | `Alex Doe` | No | Profile / CV |
| `email` | string (email) | `alex.doe@example.com` | No | Profile / CV |
| `phone` | string (e.164) | `+1-555-0100` | No | Profile / CV |
| `phone_country_code` | string | `+1` | No | Profile |
| `current_city` | string | `San Francisco` | No | Profile / Facts |
| `current_state` | string | `California` | No | Profile / Facts |
| `current_country` | string | `United States` | No | Profile / Facts |
| `postal_code` | string | `94105` | No | Profile / Self-attested |
| `address_line1` | string | `100 Market Street` | No | Profile / Self-attested |
| `citizenship` | string | `United States` | No | Profile / Facts |
| `work_authorization_us` | boolean | `true` | No | Facts (`candidate_facts`) |

### Category 2: Links & Social (8 Fields)
Professional links, repositories, and technical portfolios.

| Field Key | Type | Example Value | Sensitive | Source of Truth |
| :--- | :--- | :--- | :---: | :--- |
| `linkedin_url` | string (url) | `https://linkedin.com/in/username` | No | Profile / CV |
| `github_url` | string (url) | `https://github.com/username` | No | Profile / CV |
| `portfolio_url` | string (url) | `https://example.com/portfolio` | No | Profile / CV |
| `twitter_url` | string (url) | `""` | No | Profile |
| `leetcode_url` | string (url) | `https://leetcode.com/u/username/` | No | Profile / Facts |
| `hackerrank_url` | string (url) | `https://hackerrank.com/profile/username` | No | Profile / Facts |
| `blog_url` | string (url) | `""` | No | Profile |
| `source_code_link` | string (url) | `https://github.com/username/project` | No | Facts |

### Category 3: Education (14 Fields)
Secondary, higher secondary, and undergraduate university education records.

| Field Key | Type | Example Value | Sensitive | Source of Truth |
| :--- | :--- | :--- | :---: | :--- |
| `tenth_school` | string | `Lohia Nagar Mount Carmel High School` | No | Self-attested |
| `tenth_board` | string | `ICSE` | No | Self-attested |
| `tenth_percentage` | number | `85` | No | Self-attested |
| `tenth_year` | integer | `2020` | No | Self-attested |
| `twelfth_school` | string | `Central High School` | No | Self-attested |
| `twelfth_board` | string | `CBSE` | No | Self-attested |
| `twelfth_percentage` | number | `71` | No | Self-attested |
| `twelfth_year` | integer | `2022` | No | Self-attested |
| `college_name` | string | `State University` | No | CV / `candidate_facts` |
| `college_degree` | string | `Bachelor of Technology` | No | CV / `candidate_facts` |
| `college_major` | string | `Computer Science & Engineering` | No | CV / `candidate_facts` |
| `college_cgpa` | number | `8.0` | No | CV / `candidate_facts` |
| `college_start_year` | integer | `2022` | No | CV / Facts |
| `college_graduation_year` | integer | `2026` | No | CV / Facts |

### Category 4: Experience & Skills (12 Fields)
Professional tenure, verified work history, and technical proficiencies.

| Field Key | Type | Example Value | Sensitive | Source of Truth |
| :--- | :--- | :--- | :---: | :--- |
| `total_experience_months` | integer | `7` | No | Facts (`candidate_facts`) |
| `total_experience_years` | number | `0.58` | No | Facts (`candidate_facts`) |
| `current_job_title` | string | `""` | No | CV / Facts |
| `current_company` | string | `""` | No | CV / Facts |
| `primary_role_archetype` | string | `Full Stack Developer` | No | Profile / CV |
| `primary_languages` | array[string]| `["JavaScript", "TypeScript", "Java", "C++", "SQL"]` | No | CV / Facts |
| `backend_technologies` | array[string]| `["Node.js", "Express.js", "PostgreSQL", "Redis", "WebSockets"]` | No | CV / Facts |
| `frontend_technologies` | array[string]| `["React.js", "Next.js", "Redux Toolkit", "Tailwind CSS"]` | No | CV / Facts |
| `devops_technologies` | array[string]| `["Docker", "Docker Compose", "AWS EC2/S3", "GitHub Actions"]` | No | CV / Facts |
| `roles_history_json` | json | `[{"company":"Example Tech Corp","title":"Software Engineer","start":"2025-05","end":"2025-08"}]` | No | CV / Facts |
| `featured_projects_json`| json | `[{"name":"Distributed Engine","stack":"React, Node.js, PostgreSQL, Docker"}]` | No | CV / Evidence Records |
| `certifications_summary`| string | `Cloud Computing (NPTEL), Node.js (NIIT), Networking (Google)` | No | CV / Facts |

### Category 5: Compensation & Availability (6 Fields)
Salary baselines, notice period requirements, and current employment status.

| Field Key | Type | Example Value | Sensitive | Source of Truth |
| :--- | :--- | :--- | :---: | :--- |
| `current_ctc_lpa` | number | `0` | Yes | User Confirmed |
| `expected_ctc_lpa` | number | `5.5` | Yes | Profile (`target: 550000`) |
| `minimum_ctc_lpa` | number | `4.0` | Yes | Profile (`min: 400000`) |
| `notice_period_days` | integer | `0` | No | Profile (`immediate_joiner`) |
| `notice_period_negotiable`| boolean | `true` | No | Profile |
| `actively_serving_notice`| boolean | `false` | No | Profile |

### Category 6: Preferences & Location (8 Fields)
Mobility, workplace preferences, and shift availability.

| Field Key | Type | Example Value | Sensitive | Source of Truth |
| :--- | :--- | :--- | :---: | :--- |
| `open_to_relocation` | boolean | `true` | No | Profile |
| `preferred_locations` | array[string]| `["Bengaluru", "Pune", "Hyderabad", "Remote India"]` | No | Profile |
| `workplace_type_preference`| string | `hybrid` | No | Profile |
| `open_to_remote` | boolean | `true` | No | Profile |
| `open_to_hybrid` | boolean | `true` | No | Profile |
| `open_to_onsite` | boolean | `true` | No | Profile |
| `willing_to_work_in_shifts`| boolean | `true` | No | User Confirmed |
| `has_valid_passport` | boolean | `true` | No | User Confirmed |

### Category 7: Sensitive & Compliance (10 Fields)
Statutory compliance, EEO/diversity disclosures, and confidential identity data.

| Field Key | Type | Example Value | Sensitive | Source of Truth |
| :--- | :--- | :--- | :---: | :--- |
| `gender` | string | `Male` | Yes | User Confirmed |
| `date_of_birth` | string (iso) | `""` | Yes | User Confirmed |
| `disability_status` | string | `""` | Yes | User Confirmed |
| `veteran_status` | string | `""` | Yes | User Confirmed |
| `race_ethnicity` | string | `""` | Yes | User Confirmed |
| `passport_number` | string | `""` | Yes | User Confirmed |
| `passport_expiry_date` | string (iso) | `""` | Yes | User Confirmed |
| `current_ctc_exact_inr` | integer | `0` | Yes | User Confirmed |
| `expected_ctc_exact_inr`| integer | `550000` | Yes | User Confirmed |
| `requires_sponsorship_india`| boolean | `false` | Yes | Facts |

---

## 3. Schema Parsing & Runtime Enforcement

The schema is consumed at runtime by `application/autofill/answer-mapper.mjs`.

- **Field Resolution Precedence:**
  1. `candidate_answers` table with matching `question_key` and `confirmed_by_user = 1`.
  2. `autofill_profile_fields` database table seeded from `config/autofill-profile.yml`.
  3. Dynamic fallback to `candidate_facts` evidence ledger.
- **Enforcement Rules:**
  - If a requested portal field matches an attribute flagged with `sensitive: true` and lacks `confirmed_by_user: true`, the mapper rejects auto-population and transitions the application to `NEEDS_USER_INPUT`.
  - All numeric compensation fields report in canonical INR / LPA unless the target portal explicitly specifies another currency.
