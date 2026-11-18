#!/usr/bin/env python3
"""
scripts/jobspy-ingest.py — JobSpy Multi-Portal Bridge for Career-Ops

Implements Deliverable 5 Phase 4 (D3):
  - Bridges python-jobspy (Indeed, Naukri, LinkedIn, Glassdoor, ZipRecruiter) to career-ops
  - Emits canonical normalized JSON to stdout or file
  - Gracefully falls back to mock mode or structured JSON diagnostic when jobspy is not installed
  - Enforces field normalization (title, company_name, location, job_url, description, source)
"""

import sys
import json
import argparse
from datetime import datetime

def normalize_jobspy_row(row, default_source="jobspy"):
    title = str(row.get("title", "")).strip()
    company = str(row.get("company", row.get("company_name", ""))).strip()
    location = str(row.get("location", "India")).strip()
    job_url = str(row.get("job_url", row.get("url", ""))).strip()
    description = str(row.get("description", "")).strip()
    site = str(row.get("site", default_source)).strip().lower()

    if not title or not job_url:
        return None

    # Detect remote
    is_remote = False
    loc_lower = location.lower()
    desc_lower = description.lower()
    if "remote" in loc_lower or "wfh" in loc_lower or row.get("is_remote") is True:
        remote_type = "remote"
    elif "hybrid" in loc_lower or "hybrid" in desc_lower:
        remote_type = "hybrid"
    else:
        remote_type = "onsite"

    return {
        "id": f"{site}_{job_url}",
        "company_name": company or None,
        "title": title,
        "location": location or None,
        "remote_type": remote_type,
        "applicant_eligibility": "Open to India",
        "employment_type": "full-time",
        "job_url": job_url,
        "description": description or None,
        "source": f"jobspy_{site}",
        "source_job_id": str(row.get("id", job_url)),
        "discovered_at": datetime.utcnow().isoformat() + "Z"
    }

def get_mock_jobs(search_term, location, sites):
    mock_data = [
        {
            "title": f"{search_term} (MERN)",
            "company": "Swiggy",
            "location": f"{location}",
            "job_url": "https://www.naukri.com/job-listings-fullstack-dev-swiggy-101",
            "description": "Looking for Full Stack Developer with Node.js and React expertise.",
            "site": "naukri",
            "is_remote": False
        },
        {
            "title": f"Junior {search_term}",
            "company": "Paytm",
            "location": f"{location}",
            "job_url": "https://in.indeed.com/viewjob?jk=indeed_paytm_202",
            "description": "Junior developer role with REST APIs and TypeScript.",
            "site": "indeed",
            "is_remote": True
        }
    ]
    return [normalize_jobspy_row(m) for m in mock_data if normalize_jobspy_row(m) is not None]

def main():
    parser = argparse.ArgumentParser(description="JobSpy Bridge for Career-Ops")
    parser.add_argument("--search-term", default="Full Stack Developer")
    parser.add_argument("--location", default="India")
    parser.add_argument("--results-wanted", type=int, default=10)
    parser.add_argument("--sites", nargs="+", default=["naukri", "indeed"])
    parser.add_argument("--output-json", default=None)
    parser.add_argument("--mock", action="store_true", help="Force mock output for testing")

    args = parser.parse_args()

    if args.mock:
        normalized = get_mock_jobs(args.search_term, args.location, args.sites)
        out = {"status": "success", "jobs": normalized, "count": len(normalized), "mock": True}
        json_str = json.dumps(out, indent=2)
        if args.output_json:
            with open(args.output_json, "w", encoding="utf-8") as f:
                f.write(json_str)
        else:
            print(json_str)
        return

    # Attempt to use real jobspy if installed
    try:
        from jobspy import scrape_jobs
        jobs_df = scrape_jobs(
            site_name=args.sites,
            search_term=args.search_term,
            location=args.location,
            results_wanted=args.results_wanted,
            country_indeed="India"
        )
        records = jobs_df.to_dict(orient="records")
        normalized = [normalize_jobspy_row(r) for r in records]
        normalized = [j for j in normalized if j is not None]
        out = {"status": "success", "jobs": normalized, "count": len(normalized), "mock": False}
    except ImportError:
        # Fallback to structured diagnostic indicating jobspy library is not installed
        out = {
            "status": "unavailable",
            "error": "python-jobspy package not installed in environment",
            "jobs": [],
            "count": 0,
            "mock": False
        }
    except Exception as e:
        out = {
            "status": "error",
            "error": str(e),
            "jobs": [],
            "count": 0,
            "mock": False
        }

    json_str = json.dumps(out, indent=2)
    if args.output_json:
        with open(args.output_json, "w", encoding="utf-8") as f:
            f.write(json_str)
    else:
        print(json_str)

if __name__ == "__main__":
    main()
