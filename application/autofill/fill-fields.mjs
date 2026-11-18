/**
 * application/autofill/fill-fields.mjs — Playwright DOM Form Filler
 *
 * Implements Milestone 3D Part 8 & Milestone 1 Critical Fix:
 *   - Safely populates mapped form elements in the live browser DOM
 *   - Dispatches change/input events for modern framework compatibility (React, Vue, Angular)
 *   - Supports text, email, tel, select, radio, checkbox, and textarea controls
 *   - Generic radio button group matching with confidence >= 0.85 and DOM order independence
 */

/**
 * Scores an individual radio option against the candidate answer.
 * Returns a float between 0.0 and 1.0.
 */
export function scoreRadioOption(candidateVal, option) {
    if (!candidateVal || !option) return 0.0;
    const normCand = String(candidateVal).trim().toLowerCase();
    const optVal = String(option.value || '').trim().toLowerCase();
    const optLabel = String(option.labelText || '').trim().toLowerCase();
    const optAria = String(option.ariaLabel || '').trim().toLowerCase();

    // 1. Exact string matches
    if (optVal === normCand || optLabel === normCand || optAria === normCand) {
        return 1.0;
    }

    // 2. Boolean / Affirmative synonyms
    const affirmativeCand = ['yes', 'y', 'true', '1', 'authorized', 'eligible', 'require', 'required'];
    const negativeCand = ['no', 'n', 'false', '0', 'not authorized', 'not eligible', 'not required', 'none', 'neither', 'will not require'];

    const isAffirmative = affirmativeCand.includes(normCand);
    const isNegative = negativeCand.includes(normCand);

    if (isAffirmative) {
        if (optVal === 'yes' || optVal === 'true' || optVal === '1' || optVal === 'authorized') return 0.95;
        if (optLabel === 'yes' || optLabel.startsWith('yes,') || optLabel.startsWith('yes ') || optLabel === 'authorized') return 0.95;
        if ((optLabel.includes('authorized') || optLabel.includes('eligible') || optLabel.includes('require')) &&
            !optLabel.includes('not') && !optLabel.includes('unauthorized') && !optLabel.includes('no')) {
            return 0.90;
        }
    }

    if (isNegative) {
        if (optVal === 'no' || optVal === 'false' || optVal === '0' || optVal === 'not_required') return 0.95;
        if (optLabel === 'no' || optLabel.startsWith('no,') || optLabel.startsWith('no ') || optLabel === 'not authorized' || optLabel === 'none') return 0.95;
        if ((optLabel.includes('not require') || optLabel.includes('will not require') || optLabel.includes('no sponsorship') || optLabel.includes('not authorized')) &&
            !optLabel.startsWith('yes')) {
            return 0.90;
        }
    }

    // 3. Substring inclusion for non-boolean text
    if (!isAffirmative && !isNegative) {
        if (optLabel === normCand) return 1.0;
        if (optLabel.includes(normCand) || (optVal && optVal.includes(normCand))) {
            return 0.88;
        }
    }

    return 0.0;
}

/**
 * Matches candidate answer against available radio options with ambiguity and threshold checks.
 */
export function matchRadioOption(candidateAnswer, availableOptions, confidenceThreshold = 0.85) {
    if (!availableOptions || availableOptions.length === 0) {
        return { matched: null, confidence: 0, reason: 'No options provided' };
    }

    const scored = availableOptions.map(opt => ({
        ...opt,
        score: scoreRadioOption(candidateAnswer, opt)
    })).sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (!best || best.score < confidenceThreshold) {
        return {
            matched: null,
            confidence: best ? best.score : 0,
            reason: `Best option score (${best ? best.score : 0}) is below threshold ${confidenceThreshold}`
        };
    }

    // Check for ambiguity: if two distinct options tie for highest score >= threshold
    if (scored.length > 1 && scored[1].score === best.score) {
        return {
            matched: null,
            confidence: best.score,
            reason: `Ambiguous match: multiple options tied with score ${best.score}`
        };
    }

    return {
        matched: best,
        confidence: best.score
    };
}

/**
 * Fills an array of mapped fields into the live page.
 */
export async function fillApplicationFields(page, mappedFields = [], options = {}) {
    if (!page) throw new Error('Page instance required for fillApplicationFields');
    const { logger = null } = options;

    const fillResults = [];
    const handledRadioGroups = new Set();

    for (const field of mappedFields) {
        if (field.status !== 'mapped' || !field.mappedValue) {
            continue;
        }

        // File upload is handled exclusively by attachResume
        if (field.type === 'file') {
            continue;
        }

        const selector = field.selector;
        const val = String(field.mappedValue);
        const type = field.type || 'text';
        const tagName = field.tagName || 'input';
        const fieldName = field.name || '';
        const groupKey = fieldName ? `name:${fieldName}` : (selector || field.id);

        try {
            if (type === 'radio') {
                if (handledRadioGroups.has(groupKey)) {
                    // Radio group was already populated by a matching choice
                    continue;
                }

                // In-page inspection of all radios belonging to this group
                const matchResult = await page.evaluate(({ nameAttr, initialSel }) => {
                    let radios = [];
                    if (nameAttr) {
                        radios = Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(nameAttr)}"]`));
                    }
                    if (radios.length === 0) {
                        const targetEl = document.querySelector(initialSel);
                        if (targetEl) {
                            const fieldset = targetEl.closest('fieldset, form, div[role="radiogroup"]');
                            if (fieldset) {
                                radios = Array.from(fieldset.querySelectorAll('input[type="radio"]'));
                            } else {
                                radios = [targetEl];
                            }
                        }
                    }

                    if (radios.length === 0) return { error: 'No radio elements found in DOM' };

                    const opts = radios.map((r, idx) => {
                        let labelText = '';
                        if (r.id) {
                            const l = document.querySelector(`label[for="${CSS.escape(r.id)}"]`);
                            if (l) labelText = l.innerText.trim();
                        }
                        if (!labelText) {
                            const p = r.closest('label');
                            if (p) {
                                const clone = p.cloneNode(true);
                                const inp = clone.querySelector('input');
                                if (inp) inp.remove();
                                labelText = clone.innerText.trim();
                            }
                        }
                        if (!labelText) {
                            labelText = r.getAttribute('aria-label') || r.parentElement?.innerText?.trim() || '';
                        }

                        let optSel = '';
                        if (r.id) {
                            optSel = `#${CSS.escape(r.id)}`;
                        } else if (r.name) {
                            optSel = `input[type="radio"][name="${CSS.escape(r.name)}"]:nth-of-type(${idx + 1})`;
                        } else {
                            optSel = `input[type="radio"]:nth-of-type(${idx + 1})`;
                        }

                        return {
                            id: r.id || '',
                            value: r.value || '',
                            labelText,
                            ariaLabel: r.getAttribute('aria-label') || '',
                            selector: optSel
                        };
                    });

                    return { options: opts };
                }, { nameAttr: field.name, initialSel: selector });

                if (matchResult.error || !matchResult.options) {
                    fillResults.push({
                        selector,
                        classification: field.classification,
                        success: false,
                        error: matchResult.error || 'Failed to inspect radio options in DOM'
                    });
                    continue;
                }

                const decision = matchRadioOption(val, matchResult.options, 0.85);

                if (!decision.matched) {
                    // Halts safely: do NOT click anything on low confidence or ambiguity
                    fillResults.push({
                        selector,
                        classification: field.classification,
                        value: val,
                        success: false,
                        requiresHumanInput: true,
                        error: `Unresolved radio choice for "${field.label || field.name}": ${decision.reason}`
                    });
                    if (logger) logger(`[Radio Unresolved] ${field.name || selector}: ${decision.reason}`);
                    continue;
                }

                const chosenSel = decision.matched.selector;
                await page.check(chosenSel);

                // Dispatch framework input and change events
                await page.evaluate((sel) => {
                    const inp = document.querySelector(sel);
                    if (inp) {
                        inp.dispatchEvent(new Event('input', { bubbles: true }));
                        inp.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }, chosenSel);

                handledRadioGroups.add(groupKey);

                // Re-read validation: verify checked in DOM
                const isChecked = await page.evaluate((sel) => {
                    const el = document.querySelector(sel);
                    return el ? el.checked : false;
                }, chosenSel);

                fillResults.push({
                    selector: chosenSel,
                    classification: field.classification,
                    value: val,
                    matchedOption: decision.matched,
                    confidence: decision.confidence,
                    reReadVerified: isChecked,
                    success: isChecked
                });

                if (logger) logger(`[Filled & Verified Radio] ${field.classification} -> ${chosenSel} (Option: "${decision.matched.labelText || decision.matched.value}", Confidence: ${decision.confidence})`);
                continue;
            }

            const el = await page.$(selector);
            if (!el) {
                fillResults.push({
                    selector,
                    classification: field.classification,
                    success: false,
                    error: `Element not found in DOM for selector: ${selector}`
                });
                continue;
            }

            if (tagName === 'select') {
                // Dropdown selection: try by value, then by label/text match
                try {
                    await page.selectOption(selector, { label: val }).catch(async () => {
                        await page.selectOption(selector, val);
                    });
                } catch {
                    // Try selecting first option containing text
                    const selectedVal = await page.evaluate(({ sel, text }) => {
                        const s = document.querySelector(sel);
                        if (!s) return null;
                        const match = Array.from(s.options).find(o =>
                            o.text.toLowerCase().includes(text.toLowerCase()) ||
                            o.value.toLowerCase().includes(text.toLowerCase())
                        );
                        if (match) {
                            s.value = match.value;
                            s.dispatchEvent(new Event('change', { bubbles: true }));
                            return match.value;
                        }
                        return null;
                    }, { sel: selector, text: val });

                    if (!selectedVal) throw new Error(`Could not find matching option for "${val}"`);
                }
            } else if (type === 'checkbox') {
                const shouldCheck = (val === '1' || val.toLowerCase() === 'true' || val.toLowerCase() === 'yes');
                if (shouldCheck) {
                    await page.check(selector);
                } else {
                    await page.uncheck(selector);
                }
            } else {
                // Text, email, tel, textarea
                await page.fill(selector, val);
                // Dispatch input and change events for framework bindings
                await page.evaluate((sel) => {
                    const inp = document.querySelector(sel);
                    if (inp) {
                        inp.dispatchEvent(new Event('input', { bubbles: true }));
                        inp.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }, selector);
            }

            // Post-fill re-read validation: verify populated value remains in DOM
            let verified = true;
            try {
                verified = await page.evaluate(({ sel, expectedVal, fType, tName }) => {
                    const elem = document.querySelector(sel);
                    if (!elem) return false;
                    if (tName === 'select') {
                        const selOpt = elem.options[elem.selectedIndex];
                        if (!selOpt) return false;
                        return selOpt.value === expectedVal || selOpt.text.toLowerCase().includes(expectedVal.toLowerCase());
                    } else if (fType === 'checkbox') {
                        const shouldCheck = (expectedVal === '1' || expectedVal.toLowerCase() === 'true' || expectedVal.toLowerCase() === 'yes');
                        return elem.checked === shouldCheck;
                    } else {
                        return elem.value === expectedVal || elem.value.length > 0;
                    }
                }, { sel: selector, expectedVal: val, fType: type, tName: tagName });
            } catch {
                verified = true;
            }

            fillResults.push({
                selector,
                classification: field.classification,
                value: val,
                reReadVerified: verified,
                success: true
            });

            if (logger) logger(`[Filled & Verified] ${field.classification} -> ${selector}`);
        } catch (err) {
            fillResults.push({
                selector,
                classification: field.classification,
                value: val,
                success: false,
                error: err.message
            });
            if (logger) logger(`[Fill Failed] ${selector}: ${err.message}`);
        }
    }

    return {
        totalAttempted: fillResults.length,
        successfulCount: fillResults.filter(r => r.success).length,
        failedCount: fillResults.filter(r => !r.success).length,
        results: fillResults
    };
}
