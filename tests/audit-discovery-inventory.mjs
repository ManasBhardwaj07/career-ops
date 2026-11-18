import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';

const db = new DatabaseSync('data/job_agent.db', { readOnly: true });

const totalCompanies = db.prepare('SELECT count(1) as c FROM companies').get().c;
const withCareerUrl = db.prepare("SELECT count(1) as c FROM companies WHERE career_url IS NOT NULL AND career_url != ''").get().c;
const nullCareerUrl = db.prepare("SELECT count(1) as c FROM companies WHERE career_url IS NULL OR career_url = ''").get().c;
const withWebsiteUrl = db.prepare("SELECT count(1) as c FROM companies WHERE website_url IS NOT NULL AND website_url != ''").get().c;
const atsBreakdown = db.prepare('SELECT ats_type, count(1) as c FROM companies GROUP BY ats_type ORDER BY c DESC').all();
const lifecycleBreakdown = db.prepare('SELECT lifecycle_status, count(1) as c FROM companies GROUP BY lifecycle_status ORDER BY c DESC').all();
const monitoringBreakdown = db.prepare('SELECT monitoring_status, count(1) as c FROM companies GROUP BY monitoring_status ORDER BY c DESC').all();

const totalJobs = db.prepare('SELECT count(1) as c FROM job_postings').get().c;
const jobStatusBreakdown = db.prepare('SELECT status, count(1) as c FROM job_postings GROUP BY status ORDER BY c DESC').all();
const sourceScans = db.prepare('SELECT count(1) as c FROM source_scans').get().c;

// Check employer registry
let registryCount = 0;
if (fs.existsSync('data/employer_registry.json')) {
    const reg = JSON.parse(fs.readFileSync('data/employer_registry.json', 'utf8'));
    registryCount = Array.isArray(reg) ? reg.length : Object.keys(reg).length;
}

db.close();

console.log(JSON.stringify({
  companies: {
    total: totalCompanies,
    withCareerUrl,
    nullCareerUrl,
    withWebsiteUrl,
    atsBreakdown,
    lifecycleBreakdown,
    monitoringBreakdown
  },
  jobs: {
    total: totalJobs,
    statusBreakdown: jobStatusBreakdown
  },
  sourceScans,
  employerRegistryCount: registryCount
}, null, 2));
