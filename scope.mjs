// Keep only Canadian postings from a harvest, for a Canada-only search.
//   node scope.mjs [in=jr_jobs.json] [out=jr_jobs_target.json]
// Matches on the card text the harvester saved (title, company, location).
// ", CA" is deliberately NOT a match: on JobRight that means California.
import fs from 'fs';
const [inp = 'jr_jobs.json', out = 'jr_jobs_target.json'] = process.argv.slice(2);
const CANADA = /\bcanada\b|,\s*(ON|BC|AB|QC|MB|SK|NS|NB|NL|PE|YT|NT|NU)\b|\b(ontario|british columbia|alberta|quebec|manitoba|saskatchewan|nova scotia|new brunswick)\b|\b(toronto|mississauga|markham|vaughan|richmond hill|brampton|oakville|burlington|hamilton|waterloo|kitchener|guelph|london, on|ottawa|montr[eé]al|vancouver|calgary|edmonton|winnipeg|halifax)\b/i;
const jobs = JSON.parse(fs.readFileSync(inp, 'utf8'));
const kept = jobs.filter(j => CANADA.test(j.txt || ''));
fs.writeFileSync(out, JSON.stringify(kept));
console.log(`${kept.length} of ${jobs.length} jobs are in Canada -> ${out}`);
kept.slice(0, 5).forEach(j => console.log('  ' + j.txt.slice(0, 100)));
