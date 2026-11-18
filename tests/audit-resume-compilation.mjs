import fs from 'node:fs';
import path from 'node:path';
import { generateLatexResume, calculatePdfHash, validateGrounding, AntiFabricationViolationError } from '../resume/generate-latex-resume.mjs';
import { extractLinksFromPdf, validateCompiledPdf } from '../resume/validate-pdf.mjs';

async function auditResumes() {
    console.log('=== AUDITING RESUME TAILORING & PDF GENERATION ===\n');

    const outDir = path.resolve('output/audit_resumes');
    fs.mkdirSync(outDir, { recursive: true });

    // Test cases for 3 representative variants
    const testVariants = [
        {
            role: 'Backend Node.js & Distributed Systems Engineer',
            variantLabel: 'backend',
            job: {
                title: 'Backend Software Engineer',
                description: 'We are seeking a Backend Engineer with strong Node.js, Express, Redis, PostgreSQL, distributed systems, and message queues (BullMQ). Experience building scalable APIs and rate limiting is required.'
            }
        },
        {
            role: 'Full Stack Engineer (React/Node.js)',
            variantLabel: 'fullstack',
            job: {
                title: 'Full Stack Developer',
                description: 'Looking for a Full Stack Developer proficient in React.js, Next.js, Node.js, Tailwind CSS, Stripe integration, and PostgreSQL RPCs.'
            }
        },
        {
            role: 'Platform / DevOps / Infrastructure Engineer',
            variantLabel: 'platform',
            job: {
                title: 'Platform Infrastructure Engineer',
                description: 'Join us to build developer platforms, Docker container sandboxing, Azure VMs, reverse proxies, and CI/CD automation pipelines.'
            }
        }
    ];

    const results = [];

    for (const tv of testVariants) {
        console.log(`Compiling resume for: ${tv.role} (Variant: ${tv.variantLabel})...`);
        const res = await generateLatexResume({
            variantLabel: tv.variantLabel,
            job: tv.job,
            outputDir: outDir,
            dryRun: true // Does not mutate canonical DB
        });

        if (!res.compiled) {
            throw new Error(`Failed to compile ${tv.role}: ${res.compileError}`);
        }

        const pdfHash = calculatePdfHash(res.pdfPath);
        const stats = fs.statSync(res.pdfPath);

        // Extract links and validation
        const val = validateCompiledPdf(res.pdfPath);

        console.log(`  -> Compiled: ${res.pdfPath}`);
        console.log(`  -> Pages: ${val.pageCount} (Expected: 1)`);
        console.log(`  -> File size: ${stats.size} bytes`);
        console.log(`  -> SHA-256: ${pdfHash}`);
        console.log(`  -> Projects Selected: ${res.projectOrder.map(p => p.title || p).join(' | ')}`);
        console.log(`  -> ATS Links count: ${val.links?.length || 0}`);

        results.push({
            role: tv.role,
            variant: tv.variantLabel,
            pdfPath: res.pdfPath,
            pages: val.pageCount,
            sizeBytes: stats.size,
            hash: pdfHash,
            projects: res.projectOrder.map(p => p.title || p),
            linksCount: val.links?.length || 0
        });
    }

    // Verify Anti-Fabrication ($R16) Validator
    console.log('\n--- VERIFYING ZERO FABRICATION (R16) GUARDRAILS ---');
    let antiFabCaught = false;
    try {
        validateGrounding([
            'Managed team of 10 engineers at Google for 5 years leading cloud infrastructure.'
        ]);
    } catch (err) {
        if (err instanceof AntiFabricationViolationError) {
            antiFabCaught = true;
            console.log(`  -> Successfully rejected fabricated claim: "${err.message}"`);
        }
    }

    if (!antiFabCaught) {
        throw new Error('Anti-fabrication validator failed to catch blatant fabrication!');
    }

    console.log('\n=== RESUME AUDIT COMPLETE: ALL CHECKS PASSED ===\n');
    console.log(JSON.stringify(results, null, 2));
}

auditResumes().catch(err => {
    console.error('Resume audit failed:', err);
    process.exit(1);
});
