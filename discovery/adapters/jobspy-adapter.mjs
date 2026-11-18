/**
 * discovery/adapters/jobspy-adapter.mjs — JobSpy Multi-Portal Node Bridge Adapter
 *
 * Implements Deliverable 5 Phase 4 (D3):
 *   - Invokes scripts/jobspy-ingest.py to bridge Naukri / Indeed / LinkedIn
 *   - Parses normalized jobs into career-ops repository
 *   - Enforces Rule R20 quarantine policy
 */

import { execFile } from 'child_process';
import { resolve } from 'path';
import { promisify } from 'util';
import { createNormalizedJob } from './base.mjs';
import { sourceQuarantine } from '../source-quarantine.mjs';

const execFileAsync = promisify(execFile);
const PYTHON_SCRIPT_PATH = resolve('scripts/jobspy-ingest.py');

export class JobSpyAdapter {
    constructor({ pythonPath = 'python', scriptPath = PYTHON_SCRIPT_PATH } = {}) {
        this.pythonPath = pythonPath;
        this.scriptPath = scriptPath;
        this.provider = 'jobspy';
    }

    /**
     * Executes python-jobspy bridge script.
     */
    async fetchJobs({
        searchTerm = 'Full Stack Developer',
        location = 'India',
        resultsWanted = 10,
        sites = ['naukri', 'indeed'],
        mock = false
    } = {}) {
        if (sourceQuarantine.isSourceQuarantined('jobspy')) {
            const status = sourceQuarantine.getSourceQuarantineStatus('jobspy');
            return {
                jobs: [],
                quarantined: true,
                quarantineReason: status.quarantineReason
            };
        }

        const args = [
            this.scriptPath,
            '--search-term', searchTerm,
            '--location', location,
            '--results-wanted', String(resultsWanted),
            '--sites', ...sites
        ];
        if (mock) {
            args.push('--mock');
        }

        try {
            const { stdout } = await execFileAsync(this.pythonPath, args, { timeout: 60000 });
            const data = JSON.parse(stdout);

            if (data.status === 'success' && Array.isArray(data.jobs)) {
                const normalized = data.jobs.map(j => createNormalizedJob(j));
                sourceQuarantine.recordSourceRun('jobspy', { jobsFound: normalized.length });
                return {
                    jobs: normalized,
                    quarantined: false,
                    mock: Boolean(data.mock)
                };
            } else if (data.status === 'unavailable') {
                // jobspy python library not installed
                return {
                    jobs: [],
                    quarantined: false,
                    available: false,
                    error: data.error
                };
            } else {
                sourceQuarantine.recordSourceRun('jobspy', { jobsFound: 0, error: data.error });
                return {
                    jobs: [],
                    quarantined: sourceQuarantine.isSourceQuarantined('jobspy'),
                    error: data.error
                };
            }
        } catch (err) {
            sourceQuarantine.recordSourceRun('jobspy', { jobsFound: 0, error: err });
            return {
                jobs: [],
                quarantined: sourceQuarantine.isSourceQuarantined('jobspy'),
                error: err.message
            };
        }
    }
}

export function fetchJobSpyJobs(options = {}) {
    const adapter = new JobSpyAdapter(options);
    return adapter.fetchJobs(options);
}
