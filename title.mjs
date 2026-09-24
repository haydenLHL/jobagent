// Shared by apply3.mjs and offsite3.mjs.
export // The recommend feed's row text carries a pile of badge metadata before the
// actual job title ("9 minutes ago Public company 2 school alumni Early
// applicant Software Engineer Intern ..."). That polluted string was being
// passed to the model as the job title, so every "which role are you most
// interested in?" question was answered against noise.
function cleanTitle(txt) {
  let t = String(txt || '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^\d+\s*/, '');
  const pats = [/^(reposted\s+)?\d*\s*(minute|hour|day|week|month)s?\s+ago\b/i, /^reposted\b/i,
                /^(public company|private company|non[- ]profit|growth company|early applicant|hidden job|actively hiring)\b/i,
                /^unicorn\s*\([^)]*\)/i, /^raised\s*\$[\d.]+[kmb]?\b/i, /^series\s+[a-z]\b/i,
                /^\d+\s*(connections?|alumni)\b/i, /^growth\s+\d+%/i,
                /^\d+\s+(school alumni|school alum|former colleagues?|connections?)\b/i,
                /^\(\+?\d+\)/, /^[-–—•·,|]\s*/];
  for (let i = 0; i < 12; i++) {
    const before = t;
    for (const re of pats) t = t.replace(re, '').trim();
    if (t === before) break;
  }
  return t || String(txt || '').slice(0, 80);
}
