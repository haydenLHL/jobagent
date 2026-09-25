// Candidate profile. Everything personal comes from answers.json (never
// committed) so no one's identity is baked into the scripts. BANK is the flat
// view offsite3's label matcher uses; a missing or empty fact is null, which
// the callers treat as "not in the bank" and log as a gap instead of typing
// something wrong.
import fs from 'fs';
import path from 'path';

export const ROOT = process.cwd();
export const doc = name => path.join(ROOT, name);

export const FACTS = fs.existsSync(doc('answers.json'))
  ? JSON.parse(fs.readFileSync(doc('answers.json'), 'utf8')) : null;

const v = x => (x == null || x === '' ? null : String(x));
const F = FACTS || {};
const edu = (F.education || []).find(e => e.level === 'bachelors') || (F.education || [])[0] || {};
const job = (F.work_history || [])[0] || {};
const grad = F.grad_date || '';               // YYYY-MM-DD
const [gy, gm] = grad.split('-');

export const BANK = {
  firstName: v(F.first_name), lastName: v(F.last_name),
  fullName: v([F.first_name, F.last_name].filter(Boolean).join(' ')),
  email: v(F.email), phone: v(F.phone),
  linkedin: v(F.linkedin), github: v(F.github), website: v(F.website),
  school: v(edu.school), degree: v(edu.degree), major: v(edu.major),
  gpa: v(edu.gpa),
  employer: v(job.employer), jobTitle: v(job.title),
  empStart: v(job.start), empEnd: v(job.end),
  jobDuties: v(job.summary),
  salary: v(F.comp_expect_annual), salaryHourly: v(F.comp_expect_hourly),
  start: v(F.start_date_default),
  city: v(F.city), state: v(F.state_province), country: v(F.country),
  address1: v(F.address_line1), postal: v(F.postal_code),
  uniStart: edu.start_year ? `09/${edu.start_year}` : null,
  gradDate: v(grad), gradMonthYear: gy && gm ? `${gm}/${gy}` : null, gradYear: v(gy),
  locPref: v(F.location_preference_text),
  location: F.city ? [F.city, F.state_province_abbr, F.country].filter(Boolean).join(', ') : null,
};

// Education start year drives class-standing math ("Sophomore in fall 2026").
export const EDU_START_YEAR = Number(edu.start_year) || null;

// Regex for the degree option that is actually true for this candidate
// ("Bachelor of Commerce" / "Business Administration"), from answers.json.
export const DEGREE_OPTION = edu.degree_option_match ? new RegExp(edu.degree_option_match, 'i') : null;
