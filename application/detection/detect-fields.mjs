/**
 * application/detection/detect-fields.mjs — Application Form Field Detector
 *
 * Implements Milestone 3D Part 7:
 *   - Detects all form input elements in the active application DOM
 *   - Associates labels (via for="", enclosing <label>, aria-labelledby, aria-label)
 *   - Extracts options for selects and radio groups
 *   - Classifies fields semantically and identifies required fields
 */

import { classifyField } from './classify-fields.mjs';

/**
 * Detects all interactive form fields on the page.
 */
export async function detectFields(page) {
    if (!page) throw new Error('Page instance required for detectFields');

    // Run in-page inspection to collect raw field attributes
    const rawFields = await page.evaluate(() => {
        const results = [];
        const selectorQuery = 'input:not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), textarea, select';
        const elements = Array.from(document.querySelectorAll(selectorQuery));

        elements.forEach((el, index) => {
            // Check visibility (unless hidden input)
            const style = window.getComputedStyle(el);
            const isVisible = el.type === 'hidden' || (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && el.offsetWidth > 0);
            if (!isVisible && el.type !== 'hidden') return;

            // 1. Determine Label
            let labelText = '';

            // Check explicit label[for="id"]
            if (el.id) {
                const labelEl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
                if (labelEl) labelText = labelEl.innerText.trim();
            }

            // Check enclosing label
            if (!labelText) {
                const parentLabel = el.closest('label');
                if (parentLabel) {
                    // Clone and remove the input itself to avoid duplicating input text
                    const clone = parentLabel.cloneNode(true);
                    const childInput = clone.querySelector('input, select, textarea');
                    if (childInput) childInput.remove();
                    labelText = clone.innerText.trim();
                }
            }

            // Check aria-labelledby
            if (!labelText && el.getAttribute('aria-labelledby')) {
                const ids = el.getAttribute('aria-labelledby').split(/\s+/);
                const texts = ids.map(id => document.getElementById(id)?.innerText?.trim()).filter(Boolean);
                if (texts.length > 0) labelText = texts.join(' ');
            }

            // Check aria-label
            if (!labelText && el.getAttribute('aria-label')) {
                labelText = el.getAttribute('aria-label').trim();
            }

            // Check preceding text or fieldset legend for radio groups
            if (!labelText && (el.type === 'radio' || el.type === 'checkbox')) {
                const fieldset = el.closest('fieldset');
                const legend = fieldset ? fieldset.querySelector('legend') : null;
                const legendText = legend ? legend.innerText.trim() : '';
                const immediateText = el.parentElement?.innerText?.trim() || '';
                labelText = [legendText, immediateText].filter(Boolean).join(' - ');
            }

            // Check placeholder
            const placeholder = el.getAttribute('placeholder') || '';

            // Check required
            const isRequired = el.hasAttribute('required') ||
                               el.getAttribute('aria-required') === 'true' ||
                               Boolean(el.closest('[class*="required"]')) ||
                               labelText.includes('*');

            // Collect options if select element
            const options = [];
            if (el.tagName.toLowerCase() === 'select') {
                const optEls = Array.from(el.querySelectorAll('option'));
                optEls.forEach(o => {
                    if (o.value || o.text) {
                        options.push({ value: o.value, text: o.text.trim() });
                    }
                });
            }

            // Formulate optimal selector
            let selector = '';
            if (el.id) {
                selector = `#${CSS.escape(el.id)}`;
            } else if (el.name) {
                selector = `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`;
            } else {
                selector = `${el.tagName.toLowerCase()}:nth-of-type(${index + 1})`;
            }

            results.push({
                index,
                tagName: el.tagName.toLowerCase(),
                type: el.type ? el.type.toLowerCase() : el.tagName.toLowerCase(),
                id: el.id || '',
                name: el.name || '',
                selector,
                label: labelText,
                placeholder,
                ariaLabel: el.getAttribute('aria-label') || '',
                autocomplete: el.getAttribute('autocomplete') || '',
                required: isRequired,
                options,
                currentValue: el.value || ''
            });
        });

        return results;
    });

    // 2. Classify each detected field
    return rawFields.map(f => {
        const { classification, confidence, isSensitive } = classifyField(f);
        return {
            ...f,
            classification,
            confidence,
            isSensitive,
            status: 'unmapped',
            answerKey: null
        };
    });
}
