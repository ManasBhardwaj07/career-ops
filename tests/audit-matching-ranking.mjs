import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { evaluateJobOffer } from '../matching/pipeline.mjs';

const SRC_DB = path.resolve('data/backup/job_agent_backup_20261116.db');
const DISPOSABLE_DB = path.resolve('data/test_matching_disposable.db');

try {
    fs.copyFileSync(SRC_DB, DISPOSABLE_DB);
    const db = new DatabaseSync(DISPOSABLE_DB);

    const sources = db.prepare('SELECT source, COUNT(*) as cnt FROM job_postings GROUP BY source').all();
    console.log('Job sources in DB:', sources);

    const facts = db.prepare("SELECT * FROM candidate_facts").all();
    const evidence = db.prepare("SELECT * FROM evidence_records").all();

    // Retrieve active and discovered jobs from genuine non-test sources
    const jobs = db.prepare(`
        SELECT jp.id, jp.title, jp.company_id, c.name as company_name, jp.location, jp.source,
               jp.job_url as url, jp.remote_type, jp.description, jp.status
        FROM job_postings jp
        LEFT JOIN companies c ON jp.company_id = c.id
        WHERE jp.status IN ('active', 'discovered')
          AND jp.source != 'test'
          AND jp.job_url NOT LIKE '%example.com%'
    `).all();

    console.log(`\nRetrieved ${jobs.length} genuine discovered jobs for matching evaluation.`);

    const results = [];
    let t1Pass = 0, t1Fail = 0;
    let t2Pass = 0, t2Fail = 0, t2Unknown = 0;
    const recCounts = { APPLY: 0, CONSIDER: 0, DO_NOT_APPLY: 0, UNKNOWN: 0 };

    for (const job of jobs) {
        const jobObj = {
            id: job.id,
            title: job.title,
            location: job.location,
            url: job.url,
            job_url: job.url,
            remote_type: job.remote_type,
            work_model: job.remote_type,
            description: job.description
        };

        const evalRes = evaluateJobOffer(jobObj, facts, evidence);
        if (evalRes.tier1.passed) {
            t1Pass++;
            if (evalRes.tier2.eligibility === 'PASS') t2Pass++;
            else if (evalRes.tier2.eligibility === 'FAIL') t2Fail++;
            else if (evalRes.tier2.eligibility === 'UNKNOWN') t2Unknown++;
        } else {
            t1Fail++;
        }

        recCounts[evalRes.recommendation] = (recCounts[evalRes.recommendation] || 0) + 1;

        if (evalRes.tier1.passed && evalRes.tier2.eligibility === 'PASS') {
            results.push({
                job_id: job.id,
                title: job.title,
                company: job.company_name || job.company_id,
                location: job.location,
                source: job.source,
                url: job.url,
                score: evalRes.finalScore,
                recommendation: evalRes.recommendation,
                matchedSkills: evalRes.tier3?.matchedSkills || [],
                missingSkills: evalRes.tier3?.missingSkills || [],
                tier3: evalRes.tier3
            });
        }
    }

    results.sort((a, b) => b.score - a.score);

    console.log('\n--- GENUINE DISCOVERED JOBS EVALUATION SUMMARY ---');
    console.log(`Total Genuine Evaluated: ${jobs.length}`);
    console.log(`Tier 1 Passed: ${t1Pass}, Tier 1 Failed: ${t1Fail}`);
    console.log(`Tier 2 Passed: ${t2Pass}, Tier 2 Failed: ${t2Fail}, Tier 2 Unknown: ${t2Unknown}`);
    console.log(`Recommendations:`, JSON.stringify(recCounts, null, 2));
    console.log(`Eligible for Application Ranking (T1+T2 PASS): ${results.length}`);

    console.log('\n--- TOP 20 RANKED GENUINE OPPORTUNITIES ---');
    const top20 = results.slice(0, 20);
    top20.forEach((r, idx) => {
        console.log(`\n#${idx + 1}: [Score: ${r.score.toFixed(2)}] [${r.recommendation}] ${r.title} @ ${r.company}`);
        console.log(`   Location: ${r.location || 'N/A'} | Source: ${r.source}`);
        console.log(`   URL: ${r.url}`);
        console.log(`   Matched Skills: ${(r.matchedSkills || []).slice(0, 8).join(', ')}`);
        console.log(`   Missing Skills: ${(r.missingSkills || []).slice(0, 5).join(', ')}`);
    });

    db.close();
} catch (err) {
    console.error('Error during matching audit:', err);
} finally {
    if (fs.existsSync(DISPOSABLE_DB)) {
        try { fs.unlinkSync(DISPOSABLE_DB); } catch (e) {}
    }
}
