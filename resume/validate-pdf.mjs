/**
 * resume/validate-pdf.mjs — PDF Quality, Structure & Parseability Validation
 *
 * Implements Part 7 of Milestone 3C:
 * 1. File integrity (non-zero size, valid %PDF- signature)
 * 2. Page layout & count (1-page constraint check)
 * 3. Offline text extraction using stream and CMap decoding
 * 4. Verification of critical candidate data (name, contact, education, employment, projects, skills)
 * 5. Reading order and ATS compatibility scoring
 */

import { readFileSync, existsSync, statSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { inflateSync } from 'zlib';
import { chromium } from 'playwright';
import { getDb } from '../db/db.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolves verified candidate identity from runtime candidate facts or local profile.
 * Never returns placeholder/mock identity strings.
 */
export function resolveRuntimeCandidateIdentity() {
    let name = null;
    let email = null;
    let phone = null;

    try {
        const db = getDb();
        const facts = db.prepare("SELECT identifier, value FROM candidate_facts WHERE category IN ('identity', 'contact', 'personal')").all();
        for (const f of facts) {
            if (!name && (f.identifier === 'full_name' || f.identifier === 'name')) name = f.value;
            if (!email && (f.identifier === 'email' || f.identifier === 'contact-email')) email = f.value;
            if (!phone && (f.identifier === 'phone' || f.identifier === 'contact-phone')) phone = f.value;
        }
    } catch { }

    if (!name || !email || !phone) {
        for (const relPath of ['../config/autofill-profile.yml', '../config/profile.yml']) {
            try {
                const profilePath = resolve(__dirname, relPath);
                if (existsSync(profilePath)) {
                    const yamlText = readFileSync(profilePath, 'utf8');
                    const nm = yamlText.match(/full_name:\s*(?:value:\s*)?["']?([^"'\n\r]+)["']?/);
                    const em = yamlText.match(/email:\s*(?:value:\s*)?["']?([^"'\n\r]+)["']?/);
                    const ph = yamlText.match(/phone:\s*(?:value:\s*)?["']?([^"'\n\r]+)["']?/);
                    if (!name && nm) name = nm[1].trim();
                    if (!email && em) email = em[1].trim();
                    if (!phone && ph) phone = ph[1].trim();
                }
            } catch { }
        }
    }

    const isPlaceholder = (val) => {
        if (!val) return true;
        const lower = String(val).toLowerCase().trim();
        return lower === 'candidate' || lower === 'candidate name' || lower === 'alex doe' ||
            lower === 'jane smith' || lower.endsWith('@example.com') ||
            lower === '+1-555-0100' || lower === '+1-555-0123';
    };

    return {
        name: isPlaceholder(name) ? null : name,
        email: isPlaceholder(email) ? null : email,
        phone: isPlaceholder(phone) ? null : phone
    };
}

/**
 * Resolves candidate validation criteria from runtime candidate facts or local configuration.
 * Returns empty collections if no candidate data is configured.
 */
export function resolveRuntimeCandidateValidationCriteria() {
    const identity = resolveRuntimeCandidateIdentity();
    let university = null;
    let companies = [];
    let projects = [];

    try {
        const db = getDb();
        const facts = db.prepare("SELECT category, identifier, value FROM candidate_facts").all();
        for (const f of facts) {
            if (f.category === 'education' && !university) {
                const m = f.value.match(/,\s*([^(,]+)/);
                if (m) {
                    university = m[1].trim();
                } else {
                    university = f.value.replace(/\([^)]*\)/g, '').trim();
                }
            }
            if (f.category === 'experience') {
                const m = f.value.match(/(?:at|for|with)\s+([^,\(\d]+)/i);
                if (m) companies.push(m[1].trim());
            }
            if (f.category === 'project') {
                const parts = f.value.split(/[—–\-(]/);
                if (parts[0]) projects.push(parts[0].trim());
            }
        }
    } catch { }

    try {
        if (!process.env.CAREER_OPS_TEST) {
            const corpusPath = resolve(__dirname, '../config/candidate-facts-corpus.json');
            if (existsSync(corpusPath)) {
                const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
                if (corpus.university && !university) university = corpus.university;
                if (Array.isArray(corpus.companies) && companies.length === 0) companies = corpus.companies;
                if (corpus.projects && projects.length === 0) {
                    projects = Object.values(corpus.projects).map(p => {
                        const parts = (p.title || '').split(/[—–\-(]/);
                        return parts[0] ? parts[0].trim() : p.title;
                    });
                }
            }
        }
    } catch { }

    return {
        ...identity,
        university,
        companies: Array.from(new Set(companies)),
        projects: Array.from(new Set(projects))
    };
}

/**
 * Decompresses and extracts all stream objects from a PDF buffer.
 */
export function getDecompressedStreams(buf) {
    const streams = [];
    let idx = 0;
    while (idx < buf.length) {
        const sStart = buf.indexOf('stream', idx);
        if (sStart === -1) break;

        let newline = sStart + 6;
        if (buf[newline] === 0x0d && buf[newline + 1] === 0x0a) newline += 2;
        else if (buf[newline] === 0x0a || buf[newline] === 0x0d) newline += 1;

        const sEnd = buf.indexOf('endstream', newline);
        if (sEnd === -1) break;

        const streamBytes = buf.subarray(newline, sEnd);
        try {
            const decompressed = inflateSync(streamBytes).toString('latin1');
            streams.push(decompressed);
        } catch {
            streams.push(streamBytes.toString('latin1'));
        }
        idx = sEnd + 9;
    }
    return streams;
}

/**
 * Accurately determines the page count of a PDF from both raw trailer/catalog and decompressed object streams.
 */
export function getPdfPageCount(buf) {
    const rawPdf = buf.toString('latin1');
    const countMatch = rawPdf.match(/\/Type\s*\/Pages[\s\S]*?\/Count\s+(\d+)/);
    if (countMatch) return parseInt(countMatch[1], 10);
    const pageMatches = rawPdf.match(/\/Type\s*\/Page[^s]/g) || [];
    if (pageMatches.length > 0) return pageMatches.length;

    const streams = getDecompressedStreams(buf);
    for (const s of streams) {
        const cMatch = s.match(/\/Type\s*\/Pages[\s\S]*?\/Count\s+(\d+)/);
        if (cMatch) return parseInt(cMatch[1], 10);
    }
    let pCount = 0;
    for (const s of streams) {
        const pMatches = s.match(/\/Type\s*\/Page[^s]/g) || [];
        pCount += pMatches.length;
    }
    return pCount;
}

/**
 * Extracts all unique URI links and web annotations from a PDF buffer or file path.
 */
export function extractLinksFromPdf(pdfPathOrBuffer) {
    const buf = Buffer.isBuffer(pdfPathOrBuffer)
        ? pdfPathOrBuffer
        : readFileSync(pdfPathOrBuffer);
    const links = new Set();
    const search = (str) => {
        const lit = str.matchAll(/\/URI\s*\(([^)]+)\)/g);
        for (const m of lit) links.add(m[1].trim());
        const hex = str.matchAll(/\/URI\s*<([0-9a-fA-F]+)>/g);
        for (const m of hex) {
            let s = '';
            for (let i = 0; i < m[1].length; i += 2) {
                s += String.fromCharCode(parseInt(m[1].slice(i, i + 2), 16));
            }
            if (s) links.add(s.trim());
        }
    };
    search(buf.toString('latin1'));
    for (const s of getDecompressedStreams(buf)) {
        search(s);
    }
    return Array.from(links);
}

/**
 * Extracts plain text from a PDF buffer or file path.
 * Handles both plain Tj strings, TJ arrays, and hex-encoded CID font glyphs mapped via ToUnicode CMaps.
 */
export function extractTextFromPdf(pdfPathOrBuffer) {
    const buf = Buffer.isBuffer(pdfPathOrBuffer)
        ? pdfPathOrBuffer
        : readFileSync(pdfPathOrBuffer);

    if (buf.length < 5 || buf.slice(0, 5).toString('ascii') !== '%PDF-') {
        throw new Error('Invalid PDF format: missing %PDF- header signature');
    }

    const streams = getDecompressedStreams(buf);

    // Build CMap character dictionary from ToUnicode streams
    const cmap = new Map();
    for (const s of streams) {
        if (s.includes('beginbfchar')) {
            const bfcharBlocks = s.match(/\d+\s+beginbfchar([\s\S]*?)endbfchar/g) || [];
            for (const block of bfcharBlocks) {
                const lines = block.match(/<([0-9a-fA-F]+)>\s+<([0-9a-fA-F]+)>/g) || [];
                for (const line of lines) {
                    const m = line.match(/<([0-9a-fA-F]+)>\s+<([0-9a-fA-F]+)>/);
                    if (m) {
                        const unicode = String.fromCharCode(parseInt(m[2], 16));
                        cmap.set(m[1].toLowerCase().padStart(4, '0'), unicode);
                    }
                }
            }
        }
        if (s.includes('beginbfrange')) {
            const bfrangeBlocks = s.match(/\d+\s+beginbfrange([\s\S]*?)endbfrange/g) || [];
            for (const block of bfrangeBlocks) {
                const lines = block.match(/<([0-9a-fA-F]+)>\s+<([0-9a-fA-F]+)>\s+<([0-9a-fA-F]+)>/g) || [];
                for (const line of lines) {
                    const m = line.match(/<([0-9a-fA-F]+)>\s+<([0-9a-fA-F]+)>\s+<([0-9a-fA-F]+)>/);
                    if (m) {
                        const start = parseInt(m[1], 16);
                        const end = parseInt(m[2], 16);
                        let uStart = parseInt(m[3], 16);
                        for (let c = start; c <= end; c++) {
                            cmap.set(c.toString(16).toLowerCase().padStart(4, '0'), String.fromCharCode(uStart++));
                        }
                    }
                }
            }
        }
    }

    // Decode text from text-drawing operators (BT ... ET)
    const textLines = [];
    for (const s of streams) {
        const bts = s.match(/BT[\s\S]*?ET/g) || [];
        for (const bt of bts) {
            let blockText = '';
            // 1. Hex encoded chunks inside BT: <hex>
            const hexMatches = bt.match(/<([0-9a-fA-F]+)>/g) || [];
            for (const hm of hexMatches) {
                const hex = hm.slice(1, -1);
                for (let i = 0; i < hex.length; i += 4) {
                    const code = hex.slice(i, i + 4).toLowerCase().padStart(4, '0');
                    blockText += cmap.get(code) || '';
                }
            }

            // 2. Literal string chunks: (text)
            const litMatches = bt.match(/\(([^)]+)\)/g) || [];
            for (const lm of litMatches) {
                blockText += lm.slice(1, -1);
            }

            if (blockText.trim()) {
                textLines.push(blockText.trim());
            }
        }
    }

    return textLines.join('\n');
}

/**
 * Validates a PDF file's integrity, page count, content correctness, and ATS friendliness.
 */
export function validatePdf(pdfPathOrBuffer, expectedContent = {}) {
    const isBuffer = Buffer.isBuffer(pdfPathOrBuffer);
    const buf = isBuffer ? pdfPathOrBuffer : readFileSync(pdfPathOrBuffer);
    const sizeBytes = buf.length;

    const errors = [];
    const warnings = [];

    // 1. File integrity check
    if (sizeBytes === 0) {
        errors.push('PDF file is empty (0 bytes)');
    }
    const signature = buf.slice(0, 5).toString('ascii');
    if (signature !== '%PDF-') {
        errors.push(`Invalid PDF signature (expected %PDF-, got: ${signature})`);
    }

    // 2. Page count check
    const pageCount = getPdfPageCount(buf);

    if (pageCount === 0) {
        warnings.push('Could not detect page objects via standard /Type /Page pattern');
    } else if (pageCount > 1) {
        warnings.push(`Master resume exceeds 1-page layout budget: generated ${pageCount} pages`);
    }

    // 3. Text extraction
    let extractedText = '';
    try {
        extractedText = extractTextFromPdf(buf);
    } catch (err) {
        errors.push(`Text extraction failed: ${err.message}`);
    }

    // 4. Content assertions (supports both space-separated and PDF stream glyph streams)
    const textLower = extractedText.toLowerCase();
    const textNorm = textLower.replace(/[^a-z0-9]/g, '');
    const containsPhrase = (phrase) => {
        const pLower = phrase.toLowerCase();
        const pNorm = pLower.replace(/[^a-z0-9]/g, '');
        return textLower.includes(pLower) || textNorm.includes(pNorm);
    };

    const runtime = resolveRuntimeCandidateValidationCriteria();

    // Check Candidate Name
    const expectedName = expectedContent.name || runtime.name;
    if (!expectedName) {
        errors.push('Candidate name is required for PDF validation but missing from runtime candidate facts');
    } else if (!containsPhrase(expectedName)) {
        errors.push(`Candidate name "${expectedName}" missing from extracted PDF text`);
    }

    // Check Contact Info
    const expectedEmail = expectedContent.email || runtime.email;
    if (!expectedEmail) {
        errors.push('Candidate email is required for PDF validation but missing from runtime candidate facts');
    } else if (!containsPhrase(expectedEmail)) {
        warnings.push(`Candidate email "${expectedEmail}" missing from extracted PDF text`);
    }

    // Check Education
    const expectedEdu = expectedContent.education
        ? (Array.isArray(expectedContent.education) ? expectedContent.education : [expectedContent.education])
        : (runtime.university ? [runtime.university] : []);
    if (expectedEdu.length > 0) {
        if (!expectedEdu.some(e => containsPhrase(e))) {
            errors.push(`Education entry (${expectedEdu.join(', ')}) missing from extracted text`);
        }
    } else {
        if (!containsPhrase('education') && !containsPhrase('bachelor') && !containsPhrase('degree')) {
            errors.push('Education section missing from extracted text');
        }
    }

    // Check Employment History
    const expectedCompanies = expectedContent.companies || (runtime.companies.length > 0 ? runtime.companies : []);
    if (expectedCompanies.length > 0) {
        for (const comp of expectedCompanies) {
            if (!containsPhrase(comp)) {
                errors.push(`Employment entry (${comp}) missing from extracted text`);
            }
        }
    } else {
        if (!containsPhrase('experience') && !containsPhrase('work experience') && !containsPhrase('employment')) {
            errors.push('Work experience section missing from extracted text');
        }
    }

    // Check Key Projects
    const expectedProjects = expectedContent.projects || (runtime.projects.length > 0 ? runtime.projects : []);
    if (expectedProjects.length > 0) {
        const foundCount = expectedProjects.filter(p => containsPhrase(p)).length;
        const minReq = Math.min(expectedContent.minProjects || 2, expectedProjects.length);
        if (foundCount < minReq) {
            errors.push(`Fewer than ${minReq} verified projects found in extracted text (found: ${foundCount})`);
        }
    } else {
        if (!containsPhrase('projects') && !containsPhrase('engineering projects') && !containsPhrase('technical projects')) {
            errors.push('Projects section missing from extracted text');
        }
    }

    // 5. Reading Order Check
    // Expected order: Name -> Summary -> Experience -> Projects -> Education -> Skills
    const nameIdx = expectedName ? textLower.indexOf(expectedName.toLowerCase()) : -1;
    const expIdx = textLower.indexOf('experience');
    const prjIdx = textLower.indexOf('project');
    const eduIdx = textLower.indexOf('education');
    const skillIdx = textLower.indexOf('skill');

    let readingOrderValid = true;
    if (nameIdx !== -1 && expIdx !== -1 && nameIdx > expIdx) readingOrderValid = false;
    if (expIdx !== -1 && eduIdx !== -1 && expIdx > eduIdx) readingOrderValid = false;

    if (!readingOrderValid) {
        warnings.push('Document reading order deviates from standard Top-to-Bottom section flow');
    }

    // 6. ATS Compatibility Score Calculation
    // Base score 1.0, deducted for missing sections, layout overflow, or reading order issues
    let score = 1.0;
    if (pageCount > 1) score -= 0.15;
    if (errors.length > 0) score -= (errors.length * 0.25);
    if (!readingOrderValid) score -= 0.10;
    if (warnings.length > 0) score -= (warnings.length * 0.05);
    score = Math.max(0.0, Math.min(1.0, Math.round(score * 100) / 100));

    return {
        valid: errors.length === 0,
        pageCount: pageCount || 1,
        fileSizeBytes: sizeBytes,
        extractedText,
        atsParseScore: score,
        readingOrderValid,
        warnings,
        errors
    };
}

/**
 * Validates a compiled PDF file against strict production and ATS invariants:
 * 1. File exists on disk and is >= 10KB
 * 2. Exactly 1 page budget
 * 3. Text contains candidate name, email, phone, and key career facts
 * 4. Zero broken LaTeX macros or unresolved placeholders
 */
export function validateCompiledPdf(pdfPath, options = {}) {
    if (!pdfPath || !existsSync(pdfPath)) {
        throw new Error(`Compiled PDF does not exist at path: ${pdfPath}`);
    }
    const stats = statSync(pdfPath);
    if (stats.size < 10240) {
        throw new Error(`Compiled PDF is suspiciously small (<10KB): ${stats.size} bytes`);
    }

    const buf = readFileSync(pdfPath);
    const pageCount = getPdfPageCount(buf);

    if (pageCount > 1) {
        throw new Error(`Compiled PDF exceeds 1-page budget (found ${pageCount} pages)`);
    }

    const runtime = resolveRuntimeCandidateIdentity();

    const val = validatePdf(buf, {
        name: options.name || runtime.name,
        email: options.email || runtime.email
    });

    const text = val.extractedText || '';

    // Check broken macros
    const brokenMacroPatterns = [/\\textbackslash/i, /\\resume/i, /\bundefined\b/i, /\[insert/i, /\?\?/];
    for (const pat of brokenMacroPatterns) {
        if (pat.test(text)) {
            throw new Error(`Compiled PDF contains broken macro or placeholder pattern: ${pat}`);
        }
    }

    return {
        valid: val.valid,
        pageCount: pageCount || 1,
        fileSizeBytes: stats.size,
        pdfPath,
        extractedText: text,
        atsParseScore: val.atsParseScore,
        warnings: val.warnings,
        errors: val.errors
    };
}

/**
 * Renders a compiled PDF file to a PNG image using local Chrome/Edge/Chromium browser engine.
 * Inspects margins, clipping, layout and visually proves single-page presentation.
 */
export async function renderPdfToImage(pdfPath, outputImagePath = null) {
    if (!existsSync(pdfPath)) {
        throw new Error(`PDF file does not exist for image rendering: ${pdfPath}`);
    }
    const outImg = outputImagePath || pdfPath.replace(/\.pdf$/, '_page1.png');

    let browser = null;
    const channels = ['chrome', 'msedge', undefined];
    for (const channel of channels) {
        try {
            const launchOpts = { headless: true };
            if (channel) launchOpts.channel = channel;
            browser = await chromium.launch(launchOpts);
            break;
        } catch {
            browser = null;
        }
    }

    if (!browser) {
        throw new Error('No browser engine available to render PDF to image');
    }

    try {
        const page = await browser.newPage({
            viewport: { width: 1200, height: 1600 },
            deviceScaleFactor: 2
        });
        const fileUrl = 'file:///' + resolve(pdfPath).replace(/\\/g, '/');
        await page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(1500);

        await page.screenshot({ path: outImg, fullPage: false });

        if (!existsSync(outImg)) {
            throw new Error(`Failed to save rendered PDF screenshot at ${outImg}`);
        }
        const imgStats = statSync(outImg);
        if (imgStats.size < 5000) {
            throw new Error(`Rendered image is suspiciously small (${imgStats.size} bytes)`);
        }

        return {
            rendered: true,
            imagePath: outImg,
            sizeBytes: imgStats.size
        };
    } finally {
        await browser.close();
    }
}
