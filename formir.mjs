/**
 * formir.mjs — extract a normalized, serializable description of a form.
 *
 * Pure extraction. Does not fill, click, or decide anything.
 * Output feeds resolve.mjs and doubles as a replayable test fixture.
 */

export async function extractForm(page) {
  return page.evaluate(() => {
    // ---------- visibility ----------
    const visible = (el) => {
      if (!el || !el.isConnected) return false;
      if (el.closest('[aria-hidden="true"]')) return false;
      if (el.type === 'hidden') return false;
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') return false;
      const r = el.getBoundingClientRect();
      return r.width > 1 && r.height > 1;
    };

    const txt = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

    // Walk up from an element until the ancestor's own text, with every known
    // option label stripped out, still has real content left over. Lever (and
    // others) sometimes nest the actual question several levels above the
    // input, with every closer ancestor containing only the option labels or
    // a shared section heading - the exact bug class this closes.
    const stripOptions = (t, opts) => {
      let r = t;
      for (const o of opts || []) if (o) r = r.split(o).join(' ');
      return r.replace(/[*✱＊]/g, ' ').replace(/\s+/g, ' ').trim();
    };
    const walkUpForQuestion = (el, opts) => {
      let n = el, hops = 0;
      while (n && hops++ < 7) {
        n = n.parentElement;
        if (!n) break;
        const t = txt(n);
        if (!t || t.length > 600) continue;
        if (stripOptions(t, opts).length >= 8) return t;
      }
      return '';
    };

    // ---------- label cascade ----------
    // Most extractors stop after step 2 and lose ~half of Lever/Ashby fields.
    const labelFor = (el) => {
      if (el.id) {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l) return txt(l);
      }
      const lb = el.getAttribute('aria-labelledby');
      if (lb) {
        const t = lb.split(/\s+/).map(id => txt(document.getElementById(id))).filter(Boolean).join(' ');
        if (t) return t;
      }
      const al = el.getAttribute('aria-label');
      if (al?.trim()) return al.trim();

      const wrap = el.closest('label');
      if (wrap) {
        const clone = wrap.cloneNode(true);
        clone.querySelectorAll('input,select,textarea').forEach(n => n.remove());
        const t = txt(clone);
        if (t) return t;
      }
      // preceding sibling text inside the field container
      const cont = el.closest('.field,.form-field,[class*="field"],[class*="question"],div');
      if (cont) {
        for (const n of cont.childNodes) {
          if (n === el || n.contains?.(el)) break;
          const t = txt(n);
          if (t && t.length < 300) return t;
        }
      }
      if (el.placeholder?.trim()) return el.placeholder.trim();
      return (el.name || '').replace(/[_\-.]+/g, ' ').trim();
    };

    // ---------- required cascade ----------
    // Lever: <span class="required">✱</span>  |  Ashby: aria-required  |  Greenhouse: label "*"
    const isRequired = (el, label) => {
      if (el.required) return true;
      if (el.getAttribute('aria-required') === 'true') return true;
      if (/[*✱＊]/.test(label)) return true;
      const c = el.closest('[class*="required"],[data-required="true"]');
      if (c) return true;
      const near = el.closest('.field,.form-field,div');
      if (near && near.querySelector('.required,[class*="asterisk"]')) return true;
      return false;
    };

    // ---------- section context ----------
    // This is what disambiguates a bare "Year" or "Start Date".
    const sectionFor = (el) => {
      const fs = el.closest('fieldset');
      if (fs) {
        const lg = fs.querySelector('legend');
        if (lg) return txt(lg);
      }
      let n = el;
      while ((n = n.parentElement)) {
        const h = n.querySelector(':scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > legend');
        if (h && txt(h)) return txt(h);
        if (n.tagName === 'FORM') break;
      }
      return null;
    };

    const helpFor = (el) => {
      const d = el.getAttribute('aria-describedby');
      if (!d) return null;
      const t = d.split(/\s+/).map(id => txt(document.getElementById(id))).filter(Boolean).join(' ');
      return t || null;
    };

    const errorFor = (el) => {
      if (el.getAttribute('aria-invalid') === 'true') {
        const d = el.getAttribute('aria-errormessage') || el.getAttribute('aria-describedby');
        if (d) {
          const t = d.split(/\s+/).map(id => txt(document.getElementById(id))).filter(Boolean).join(' ');
          if (t) return t;
        }
        return 'invalid';
      }
      const near = el.closest('.field,.form-field,div');
      const e = near?.querySelector('[role="alert"],[class*="error"]:not(input)');
      return e && visible(e) ? txt(e) : null;
    };

    // stable-ish selector, preferring attributes that survive re-renders
    const sel = (el) => {
      if (el.id) return `#${CSS.escape(el.id)}`;
      if (el.name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`;
      const dt = el.getAttribute('data-testid') || el.getAttribute('data-qa');
      if (dt) return `[data-testid="${CSS.escape(dt)}"]`;
      const all = [...document.querySelectorAll(el.tagName)];
      return `${el.tagName.toLowerCase()}:nth-of-type(${all.indexOf(el) + 1})`;
    };

    const fields = [];
    const seenGroups = new Set();

    // ---------- native controls ----------
    for (const el of document.querySelectorAll('input,select,textarea')) {
      if (!visible(el)) continue;
      if (['submit', 'button', 'reset', 'image'].includes(el.type)) continue;

      // radios/checkboxes collapse into one grouped field keyed by name
      if (el.type === 'radio' || el.type === 'checkbox') {
        const key = el.name || sel(el.closest('[role="radiogroup"]') || el);
        if (seenGroups.has(key)) continue;
        seenGroups.add(key);

        const members = el.name
          ? [...document.querySelectorAll(`input[name="${CSS.escape(el.name)}"]`)].filter(visible)
          : [el];

        const memberLabels = members.map(m => labelFor(m) || m.value);
        // A section heading is a legitimate LAST resort, but never a first
        // one: two distinct questions in the same section both fall back to
        // it, becoming indistinguishable. Try the ancestor-strip walk first.
        const groupLabel =
          txt(el.closest('fieldset')?.querySelector('legend')) ||
          txt(el.closest('[role="radiogroup"]')?.querySelector('[class*="label"],legend')) ||
          walkUpForQuestion(el, memberLabels) ||
          sectionFor(el) || labelFor(el);

        fields.push({
          id: `group:${key}`,
          selector: null,
          control: el.type === 'radio' ? 'radio' : 'checkbox',
          label: groupLabel,
          section: sectionFor(el),
          help: helpFor(el),
          required: members.some(m => isRequired(m, groupLabel)),
          options: members.map(m => ({
            label: labelFor(m) || m.value,
            value: m.value,
            selector: sel(m),
            checked: m.checked,
          })),
          value: members.filter(m => m.checked).map(m => labelFor(m) || m.value),
          error: errorFor(el),
        });
        continue;
      }

      const label = labelFor(el);
      const isSelect = el.tagName === 'SELECT';
      const opts = isSelect
        ? [...el.options].map((o, i) => ({ label: txt(o), value: o.value, index: i }))
        : null;
      // a select still sitting on its placeholder counts as empty
      const onPlaceholder =
        isSelect && (el.selectedIndex <= 0 || !el.value ||
          /^(select|choose|please|--)/i.test(txt(el.selectedOptions[0]) || ''));

      fields.push({
        id: sel(el),
        selector: sel(el),
        control: isSelect ? 'select' : (el.type === 'file' ? 'file' : (el.tagName === 'TEXTAREA' ? 'textarea' : (el.type || 'text'))),
        label,
        section: sectionFor(el),
        help: helpFor(el),
        required: isRequired(el, label),
        options: opts,
        value: el.type === 'file' ? (el.files?.length ? `${el.files.length} file(s)` : '') : el.value,
        empty: el.type === 'file' ? !el.files?.length : (isSelect ? onPlaceholder : !el.value?.trim()),
        error: errorFor(el),
      });
    }

    // ---------- ARIA comboboxes (Workday, Ashby dropdowns) ----------
    // Options don't exist in the DOM until opened — mark deferred, don't guess.
    for (const el of document.querySelectorAll('[role="combobox"],[role="listbox"]')) {
      if (!visible(el)) continue;
      if (el.closest('label')?.querySelector('input,select')) continue;
      const label = labelFor(el) || txt(el.closest('[class*="field"]')?.querySelector('label'));
      fields.push({
        id: sel(el),
        selector: sel(el),
        control: 'combobox',
        label,
        section: sectionFor(el),
        help: helpFor(el),
        required: isRequired(el, label),
        options: 'deferred',
        value: txt(el) || el.getAttribute('aria-activedescendant') || '',
        empty: !txt(el),
        error: errorFor(el),
      });
    }

    // ---------- wizard position ----------
    const stepText = [...document.querySelectorAll('body *')]
      .map(n => (n.childElementCount === 0 ? txt(n) : ''))
      .find(t => /step\s+\d+\s+of\s+\d+/i.test(t)) || null;

    return {
      url: location.href,
      host: location.host,
      title: document.title,
      step: stepText,
      capturedAt: new Date().toISOString(),
      fields,
    };
  });
}

/** Fields that still need a value. This is the resolver's input set. */
export const unresolved = (ir) =>
  ir.fields.filter(f =>
    f.required &&
    (f.control === 'radio' || f.control === 'checkbox'
      ? !f.value?.length
      : f.empty) || f.error
  );

/** Snapshot for offline replay. Every failure should write one of these. */
export async function snapshot(ir, dir = './fixtures') {
  const fs = await import('node:fs/promises');
  await fs.mkdir(dir, { recursive: true });
  const name = `${ir.host}-${Date.now()}.json`;
  await fs.writeFile(`${dir}/${name}`, JSON.stringify(ir, null, 2));
  return `${dir}/${name}`;
}
