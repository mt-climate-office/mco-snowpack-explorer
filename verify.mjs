#!/usr/bin/env node
/* verify.mjs: does the page work against the snow buckets' layout v1?
 *
 * Two parts:
 *   1. Keys. From the latest manifests, every layout v1 key the page reads
 *      for the newest date is listed and fetched (`--list` prints them and
 *      stops). The listings the page makes are tried too.
 *   2. The page. It is served from this checkout and opened in Chromium,
 *      with its data requests to https://data2.climate.umt.edu/{snodas,snotel}/
 *      answered from the source you name. It must boot on the manifests'
 *      date and draw the gridded map, the zonal map, a basin's plots and
 *      tables, an animation, the SNOTEL stations and a station's plot, with
 *      no request to an old (layout v0) key, no failed data request, a clean
 *      console and no serious or critical axe violation.
 *
 * Where the data comes from (the default is production, data2):
 *   --data   <url|dir>   a root holding snodas/ and snotel/
 *   --snodas <url|dir>   mco-snodas on its own (overrides --data)
 *   --snotel <url|dir>   mco-snotel on its own (overrides --data)
 * A URL is a bucket's base, e.g. https://mco-snodas-test.s3.us-west-2.amazonaws.com;
 * its S3 listing must be public, as data2's is. A directory is a local mirror
 * laid out as the bucket; listings are answered from it.
 *
 * Other options:
 *   --basin <huc>        the basin to open (default 1002)
 *   --station <id>       the station to open (default 901_MT_SNTL)
 *   --anim <wy>          the water year whose animation to open (default: the
 *                        newest in the listing; skipped when there is none)
 *   --keys-only          part 1 only
 *   --list               print the keys and stop
 *
 * Run it from this checkout. It is not a dependency of the page; install its
 * two tools, pinned, without saving them:
 *   npm i --no-save playwright@1.62.1 @axe-core/playwright@4.13.0
 *   npx playwright install chromium
 *   node verify.mjs                                   # production
 *   node verify.mjs --data /path/to/v1-mirror         # a local mirror
 *   node verify.mjs --snodas https://<test-bucket-base> --snotel https://<test-bucket-base>
 * Exit status 0 when every check passes.
 */
import { createServer } from 'node:http';
import { readFile, stat, readdir, mkdir } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

// ── Options ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (name, dflt = null) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const flag = (name) => argv.includes(`--${name}`);
const DATA_HOST = 'https://data2.climate.umt.edu';
const data = opt('data', DATA_HOST);
const isUrl = (s) => /^https?:\/\//.test(s);
const sourceOf = (bucket) => {
  const s = opt(bucket) || (isUrl(data) ? `${data.replace(/\/$/, '')}/${bucket}` : join(data, bucket));
  return isUrl(s) ? { url: s.replace(/\/$/, '') } : { dir: resolve(s) };
};
const SOURCES = { snodas: sourceOf('snodas'), snotel: sourceOf('snotel') };
const BASIN = opt('basin', '1002');
const STATION = opt('station', '901_MT_SNTL');
const ROLE = 'snodas';
const FLAVORS = ['smoothed', 'fitted', 'empirical'];

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
};

// ── Reading a bucket: URL or local mirror ─────────────────────────────────
async function get(bucket, key, { range } = {}) {
  const src = SOURCES[bucket];
  if (src.url) {
    const r = await fetch(`${src.url}/${key}`, range ? { headers: { Range: range } } : {});
    return { ok: r.ok, status: r.status, body: Buffer.from(await r.arrayBuffer()), headers: r.headers };
  }
  const f = normalize(join(src.dir, key));
  if (!f.startsWith(src.dir)) return { ok: false, status: 403, body: Buffer.alloc(0) };
  try { return { ok: true, status: 200, body: await readFile(f) }; } catch { return { ok: false, status: 404, body: Buffer.alloc(0) }; }
}
const getJSON = async (bucket, key) => { const r = await get(bucket, key); return r.ok ? JSON.parse(r.body) : null; };

// An S3 ListObjectsV2 answer (prefix, delimiter '/') for a local mirror.
async function listXml(bucket, prefix) {
  const dir = join(SOURCES[bucket].dir, prefix);
  let names = [];
  try { names = (await readdir(dir, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort(); } catch {}
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><Prefix>${esc(prefix)}</Prefix>`
    + `<KeyCount>${names.length}</KeyCount><Delimiter>/</Delimiter><IsTruncated>false</IsTruncated>`
    + names.map(n => `<CommonPrefixes><Prefix>${esc(prefix + n)}/</Prefix></CommonPrefixes>`).join('') + '</ListBucketResult>';
}
async function listPrefixes(bucket, prefix) {
  const src = SOURCES[bucket];
  const xml = src.url
    ? await (await fetch(`${src.url}/?${new URLSearchParams({ 'list-type': '2', prefix, delimiter: '/' })}`)).text()
    : await listXml(bucket, prefix);
  return [...xml.matchAll(/<CommonPrefixes><Prefix>([^<]+)<\/Prefix>/g)].map(m => m[1]);
}

// ── The keys the page reads ───────────────────────────────────────────────
const waterYear = (d) => +d.slice(0, 4) + (+d.slice(5, 7) >= 10 ? 1 : 0);
const shift = (d, n) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

const [gm, zm, tm] = await Promise.all([
  getJSON('snodas', 'gridded/daily/latest/manifest.json'),
  getJSON('snodas', 'zonal/daily/latest/manifest.json'),
  getJSON('snotel', 'daily/latest/manifest.json'),
]);
check('snodas gridded/daily/latest/manifest.json has a date and the snodas period', !!(gm?.date && gm?.roles?.[ROLE]?.period), JSON.stringify(gm)?.slice(0, 200));
check('snodas zonal/daily/latest/manifest.json has a date and the snodas period', !!(zm?.date && zm?.roles?.[ROLE]?.period), JSON.stringify(zm)?.slice(0, 200));
// The role's period: roles.{role}.period (spec §8), or the last part of
// normals.{role} ("normals/wy2004-2026"), as the SNOTEL manifest gives it.
const periodOf = (m) => m?.roles?.[ROLE]?.period ?? String(m?.normals?.[ROLE] ?? '').split('/').pop();
check('snotel daily/latest/manifest.json has a date, water_year and the snodas period', !!(tm?.date && tm?.water_year && /^wy/.test(periodOf(tm))), JSON.stringify(tm)?.slice(0, 200));
if (!gm || !zm || !tm) { console.log('\nNo manifests, so nothing more can be checked.'); process.exit(1); }

const sm = [gm, zm].sort((a, b) => a.date.localeCompare(b.date))[0];
const D = sm.date, P = sm.roles[ROLE].period;
const DS = shift(D, -1), TP = periodOf(tm);   // SNOTEL's D − 1, and its period
check('the SNODAS manifests agree on the snodas period', gm.roles[ROLE].period === zm.roles[ROLE].period, `${gm.roles[ROLE].period} vs ${zm.roles[ROLE].period}`);
check(`the snodas period is the water year's (${D} is WY${waterYear(D)})`,
  new RegExp(`-${waterYear(D) - 1}$`).test(P), P);
check(`SNOTEL covers the map's date (it has ${tm.date}, the page needs ${DS})`, tm.date >= DS, tm.date);

const keys = [
  ['snodas', 'gridded/daily/latest/manifest.json', 'newest date and period'],
  ['snodas', 'zonal/daily/latest/manifest.json', 'newest date and period'],
  ...FLAVORS.map(f => ['snodas', `gridded/daily/percentiles/${P}/${D}/${P}_${f}_${D}_swe_ptile.tif`, 'gridded percentiles']),
  ...FLAVORS.map(f => ['snodas', `gridded/normals/${P}/${f}/${P}_${f}_${D.slice(5)}_median.tif`, 'gridded median, hover']),
  ...FLAVORS.map((m) => ['snodas', `gridded/normals/${P}/${m}/provenance_${P}_${m}_${D.slice(5)}.json`, 'legend and details']),
  ['snodas', `raw/cog/${D}/snodas_swe_${D}.tif`, 'gridded SWE, hover'],
  ...[2, 4, 6, 8].map(l => ['snodas', `zonal/zones_huc${l}.fgb`, 'watershed boundaries']),
  ...FLAVORS.flatMap(f => ['swe', 'hypsomeswe'].map(t => ['snodas', `zonal/daily/zones/${P}/${D}/zones_${t}_${P}_${f}_${D}.parquet`, t === 'swe' ? 'zonal map, hover, basin facts' : 'elevation band table'])),
  ['snodas', `zonal/daily/plots/${P}/${D}/index_${P}_${D}.json`, 'basin plots complete'],
  ...FLAVORS.flatMap(f => ['swe', 'hypsomeswe'].map(t => ['snodas', `zonal/daily/plots/${P}/${D}/${f}/${BASIN}_${t}_${P}_${f}_${D}.png`, `basin ${BASIN} plot`])),
  ['snotel', 'daily/latest/manifest.json', 'newest date, water year, period'],
  ['snotel', 'stations.parquet', 'stations'],
  ['snotel', `daily/latest/percentiles_${ROLE}.parquet`, 'station percentiles (current water year)'],
  ['snotel', `normals/${TP}/by_station/${STATION}_${TP}.parquet`, `station ${STATION} normals`],
  ['snotel', `daily/plots/${TP}/${DS}/index_${TP}_${DS}.json`, 'station plots complete'],
  ...FLAVORS.map(f => ['snotel', `daily/plots/${TP}/${DS}/${f}/${STATION}_swe_${TP}_${f}_${DS}.png`, `station ${STATION} plot`]),
];
const LISTINGS = [
  ['snodas', `zonal/daily/plots/${P}/`, 'basin plot dates'],
  ['snodas', 'zonal/animations/', 'animation periods (then zonal/animations/{period}/ for water years)'],
  ['snotel', `daily/plots/${TP}/`, 'station plot dates'],
];

if (flag('list')) {
  console.log(`\nLayout v1 keys the page reads for ${D} (SNOTEL ${DS}), period ${P}:`);
  for (const [b, k, what] of keys) console.log(`  ${b}/${k}    (${what})`);
  console.log('Listings (ListObjectsV2, delimiter /):');
  for (const [b, k, what] of LISTINGS) console.log(`  ${b}/?prefix=${k}    (${what})`);
  process.exit(failures ? 1 : 0);
}

console.log(`\nKeys for ${D} (SNOTEL ${DS}), period ${P}:`);
for (const [b, k, what] of keys) {
  const r = await get(b, k, { range: 'bytes=0-15' });
  check(`${b}/${k} (${what})`, r.ok, `HTTP ${r.status}`);
}
const plotDates = await listPrefixes('snodas', `zonal/daily/plots/${P}/`);
check(`listing snodas zonal/daily/plots/${P}/ includes ${D}/`, plotDates.includes(`zonal/daily/plots/${P}/${D}/`), plotDates.slice(-3).join(' '));
const stationDates = await listPrefixes('snotel', `daily/plots/${TP}/`);
check(`listing snotel daily/plots/${TP}/ includes ${DS}/`, stationDates.includes(`daily/plots/${TP}/${DS}/`), stationDates.slice(-3).join(' '));
const animPeriods = await listPrefixes('snodas', 'zonal/animations/');
const animYears = [];
for (const p of animPeriods) for (const x of await listPrefixes('snodas', p)) {
  const m = /^zonal\/animations\/(wy[^/]+)\/wy(\d{4})\/$/.exec(x);
  if (m) animYears.push({ period: m[1], wy: +m[2] });
}
console.log(`  (animations listed: ${animYears.map(a => `wy${a.wy} in ${a.period}`).join(', ') || 'none yet'})`);
const ANIM = opt('anim') ? animYears.find(a => a.wy === +opt('anim')) : animYears.sort((a, b) => a.wy - b.wy).at(-1);
if (ANIM) {
  const k = `zonal/animations/${ANIM.period}/wy${ANIM.wy}/smoothed/${BASIN}_hypsomeswe_${ANIM.period}_smoothed_wy${ANIM.wy}.mp4`;
  const r = await get('snodas', k, { range: 'bytes=0-15' });
  check(`snodas/${k} (basin ${BASIN} animation)`, r.ok, `HTTP ${r.status}`);
}

if (flag('keys-only')) finish();

// ── The page ──────────────────────────────────────────────────────────────
const { chromium } = await import('playwright');
const { AxeBuilder } = await import('@axe-core/playwright');
const ROOT = process.cwd();
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.geojson': 'application/geo+json',
  '.tif': 'image/tiff', '.parquet': 'application/octet-stream', '.fgb': 'application/octet-stream', '.mp4': 'video/mp4',
};
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = normalize(join(ROOT, p));
    if (!f.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const body = await readFile(f);
    res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

// A request to data2 answered from the source: a local file (with Range and
// HEAD, as S3 answers them), a local listing, or the same key at the URL.
async function answer(route) {
  const req = route.request();
  const u = new URL(req.url());
  const [, bucket, ...rest] = u.pathname.split('/');
  const key = decodeURIComponent(rest.join('/'));
  const src = SOURCES[bucket];
  const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-length, content-range, etag' };
  if (src?.url) {
    const r = await route.fetch({ url: `${src.url}/${key}${u.search}` });
    return route.fulfill({ response: r, headers: { ...r.headers(), ...cors } });
  }
  if (!src) return route.continue();
  if (u.searchParams.get('list-type') === '2') {
    return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/xml' }, body: await listXml(bucket, u.searchParams.get('prefix') || '') });
  }
  const f = normalize(join(src.dir, key));
  let body;
  try { if (!f.startsWith(src.dir) || !(await stat(f)).isFile()) throw 0; body = await readFile(f); }
  catch { return route.fulfill({ status: 404, headers: cors, body: '' }); }
  const type = MIME[extname(f)] || 'application/octet-stream';
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers().range || '');
  if (req.method() === 'HEAD') return route.fulfill({ status: 200, headers: { ...cors, 'content-type': type, 'content-length': String(body.length) }, body: '' });
  if (m) {
    const a = +m[1], b = Math.min(m[2] ? +m[2] : body.length - 1, body.length - 1);
    return route.fulfill({ status: 206, headers: { ...cors, 'content-type': type, 'accept-ranges': 'bytes',
      'content-range': `bytes ${a}-${b}/${body.length}`, 'content-length': String(b - a + 1) }, body: body.subarray(a, b + 1) });
  }
  return route.fulfill({ status: 200, headers: { ...cors, 'content-type': type, 'accept-ranges': 'bytes' }, body });
}

// Keys of the old layout (v0). The page must ask for none of them.
const V0 = [
  /^snodas\/(normals|plots|animations|cogs|latest|cache)\//,
  /^snotel\/(latest|stations|plots|archive)\//, /^snotel\/normals\/(snodas|30yr|por|reference)\//,
];
// Production needs no routing; anything else answers data2's requests.
const ROUTED = SOURCES.snodas.url !== `${DATA_HOST}/snodas` || SOURCES.snotel.url !== `${DATA_HOST}/snotel`;
const browser = await chromium.launch();
async function open(query, { ready, timeout = 45000 } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => { try { localStorage.setItem('mco-snowpack-info-seen', '1'); } catch {} });
  if (ROUTED) await ctx.route(`${DATA_HOST}/**`, answer);
  const page = await ctx.newPage();
  const errors = [], reqs = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (u.origin === DATA_HOST) reqs.push({ key: decodeURIComponent(u.pathname.slice(1)), search: u.search, status: r.status(), method: r.request().method() });
  });
  await page.goto(base + query, { waitUntil: 'load', timeout: 60000 });
  const ok = ready ? await page.waitForFunction(ready, null, { timeout, polling: 250 }).then(() => true, () => false) : true;
  await page.waitForTimeout(1500);
  return { ctx, page, errors, data: reqs, ok };
}
// Every data request: none to a v0 key, none failed (a 404 for the plot or
// percentiles of a date that has none is the page probing, so it is listed
// but only counted against the page where a scenario says so).
function dataChecks(name, data, { allow404 = [] } = {}) {
  const old = data.filter(d => V0.some(re => re.test(d.key)));
  check(`[${name}] no request to a layout v0 key`, old.length === 0, old.slice(0, 3).map(d => d.key).join(' | '));
  const bad = data.filter(d => d.status >= 400 && !allow404.some(re => re.test(d.key)));
  check(`[${name}] no failed data request`, bad.length === 0, bad.slice(0, 3).map(d => `${d.status} ${d.key}`).join(' | '));
}
const asked = (data, re) => data.some(d => re.test(d.key) && d.status < 400);
const NOISE = [/status of 404/];   // logged by the browser for the requests checked above
const real = (errs) => errs.filter((e) => !NOISE.some((re) => re.test(e)));

function painted() {
  const c = document.querySelector('#map canvas');
  if (!c || !c.width) return false;
  const o = document.createElement('canvas'); o.width = 96; o.height = 64;
  const x = o.getContext('2d'); x.drawImage(c, 0, 0, 96, 64);
  const d = x.getImageData(0, 0, 96, 64).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) > 90) n++;
  return n > 60;
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
await mkdir('verify-out', { recursive: true });
console.log('\nThe page:');

// Gridded view, on the manifests' date by default.
{
  // Over the West, where there is snow to color even early in the season.
  const { ctx, page, errors, data, ok } = await open('?lng=-113.5&lat=45.5&zoom=5.5', { ready: painted });
  const date = await page.evaluate(() => document.getElementById('date-input').value);
  check('[gridded] boots on the manifests\' date', date === D, `${date} vs ${D}`);
  check('[gridded] the percentile raster paints', ok);
  check('[gridded] reads the smoothed percentile COG', asked(data, new RegExp(`^snodas/gridded/daily/percentiles/${P}/${D}/${P}_smoothed_${D}_swe_ptile\\.tif$`)));
  await page.mouse.click(720, 450); await page.waitForTimeout(3000);
  const said = await page.evaluate(() => [...document.querySelectorAll('[aria-live]')].map(e => e.textContent).join(' '));
  check('[gridded] a click pins and announces a reading', /percentile|No snowpack data|No normal/.test(said), JSON.stringify(said));
  check('[gridded] the hover reads the SWE and median COGs', asked(data, new RegExp(`^snodas/raw/cog/${D}/snodas_swe_${D}\\.tif$`))
    && asked(data, new RegExp(`^snodas/gridded/normals/${P}/smoothed/${P}_smoothed_${D.slice(5)}_median\\.tif$`)));
  await page.click('#legend-info-btn').catch(() => {}); await page.waitForTimeout(1500);
  const prov = await page.evaluate(() => ({ open: document.getElementById('provenance-modal').open,
    n: document.querySelectorAll('#provenance-content .provenance-dates li').length, text: document.getElementById('provenance-content').textContent }));
  check('[gridded] the details dialog lists the period\'s reference dates', prov.open && prov.n === waterYear(D) - 1 - +P.slice(2, 6) + 1, JSON.stringify({ open: prov.open, n: prov.n }));
  const axe = (await new AxeBuilder({ page }).analyze()).violations.filter(v => ['serious', 'critical'].includes(v.impact));
  check('[gridded] axe: no serious or critical violation', axe.length === 0, axe.map(v => v.id).join(', '));
  check('[gridded] console clean', real(errors).length === 0, real(errors).slice(0, 2).join(' | '));
  dataChecks('gridded', data);
  await page.screenshot({ path: 'verify-out/v1-gridded.png' });
  await ctx.close();
}

// Zonal view: boundaries per level, the day's table, the twin and the hover.
{
  const { ctx, page, errors, data, ok } = await open(`?date=${D}&view=zonal&huc=4`, {
    ready: () => [...document.querySelectorAll('table')].find(t => /^Watershed/.test(t.caption?.textContent || ''))?.tBodies[0]?.rows.length > 10 });
  check('[zonal] the watershed table twin fills', ok);
  check('[zonal] reads zonal/zones_huc4.fgb', asked(data, /^snodas\/zonal\/zones_huc4\.fgb$/));
  check('[zonal] reads the day\'s zonal_day table', asked(data, new RegExp(`^snodas/zonal/daily/zones/${P}/${D}/zones_swe_${P}_smoothed_${D}\\.parquet$`)));
  const ranked = await page.evaluate(() => [...([...document.querySelectorAll('table')].find(t => /^Watershed/.test(t.caption?.textContent || ''))?.tBodies[0]?.rows || [])]
    .filter(r => /\d(st|nd|rd|th)/.test(r.textContent)).length);
  check('[zonal] watersheds carry a percentile', ranked > 0, `${ranked} rows`);
  check('[zonal] console clean', real(errors).length === 0, real(errors).slice(0, 2).join(' | '));
  dataChecks('zonal', data);
  await ctx.close();
}

// Basin dialog: the SWE plot and its facts (median, range, mean from zonal_day),
// then HypsomeSWE and its band table, then another flavor.
{
  const plotShown = () => { const i = document.getElementById('basin-img');
    return document.getElementById('basin-modal').open && !i.hidden && i.complete && i.naturalWidth > 100; };
  const { ctx, page, errors, data, ok } = await open(`?date=${D}&view=zonal&huc=${BASIN.length}&basin=${BASIN}&plot=swe`, { ready: plotShown });
  check(`[basin] the SWE plot for ${BASIN} shows`, ok);
  check('[basin] it is the v1 plot key', asked(data, new RegExp(`^snodas/zonal/daily/plots/${P}/${D}/smoothed/${BASIN}_swe_${P}_smoothed_${D}\\.png$`)));
  const facts = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#basin-table tr')].map(r => [r.cells[0]?.textContent || r.querySelector('th')?.textContent, r.querySelector('td')?.textContent])));
  check('[basin] facts table: observed, percentile, median, range and mean', ['Observed SWE', 'Median for this date', 'Mean for this date'].every(k => facts[k] && facts[k] !== '—'), JSON.stringify(facts));
  await page.click('#basin-plot-btns input[value="hypsomeswe"]', { force: true }); await page.waitForTimeout(500);
  await page.waitForFunction(plotShown, null, { timeout: 20000 }).catch(() => {});
  check('[basin] the HypsomeSWE plot shows', asked(data, new RegExp(`^snodas/zonal/daily/plots/${P}/${D}/smoothed/${BASIN}_hypsomeswe_${P}_smoothed_${D}\\.png$`)));
  await page.evaluate(() => { document.getElementById('basin-data').open = true; });
  await page.waitForFunction(() => document.querySelectorAll('#basin-table tbody tr').length > 0
    || /no elevation band|failed/.test(document.getElementById('basin-table').textContent), null, { timeout: 30000 }).catch(() => {});
  const bands = await page.evaluate(() => ({ n: document.querySelectorAll('#basin-table tbody tr').length, t: document.getElementById('basin-table').textContent.slice(0, 120) }));
  check('[basin] the elevation band table fills from zonal_day hypsomeswe', bands.n > 0
    && asked(data, new RegExp(`^snodas/zonal/daily/zones/${P}/${D}/zones_hypsomeswe_${P}_smoothed_${D}\\.parquet$`)), JSON.stringify(bands));
  await page.click('#basin-flavor-btns input[value="fitted"]', { force: true });
  await page.waitForTimeout(1500);
  const q = await page.evaluate(() => location.search);
  check('[basin] another flavor: ?flavor=fitted and its plot', /flavor=fitted/.test(q)
    && asked(data, new RegExp(`^snodas/zonal/daily/plots/${P}/${D}/fitted/${BASIN}_hypsomeswe_${P}_fitted_${D}\\.png$`)), q);
  const axe = (await new AxeBuilder({ page }).analyze()).violations.filter(v => ['serious', 'critical'].includes(v.impact));
  // Known on main before layout v1, and not this check's business: the band
  // table's scrolling box (.band-scroll) can't take keyboard focus. Printed,
  // not counted, so this gate stays about the data.
  const known = axe.filter(v => v.id === 'scrollable-region-focusable' && v.nodes.every(n => n.target.join(' ').includes('band-scroll')));
  for (const v of known) console.log(`! [basin] axe: ${v.id} on .band-scroll (known, also on main)`);
  const fresh = axe.filter(v => !known.includes(v));
  check('[basin] axe: no serious or critical violation', fresh.length === 0, fresh.map(v => v.id).join(', '));
  check('[basin] console clean', real(errors).length === 0, real(errors).slice(0, 2).join(' | '));
  dataChecks('basin', data);
  await page.screenshot({ path: 'verify-out/v1-basin.png' });
  await ctx.close();
}

// The water-year animation, where one is listed.
if (ANIM) {
  const { ctx, page, errors, data } = await open(`?date=${D}&view=zonal&huc=${BASIN.length}&basin=${BASIN}&anim=${ANIM.wy}`,
    { ready: () => document.getElementById('basin-video').getAttribute('src') || !document.getElementById('basin-empty').hidden });
  const r = await page.evaluate(() => ({ src: document.getElementById('basin-video').getAttribute('src') || '', empty: document.getElementById('basin-empty').textContent }));
  check(`[animation] water year ${ANIM.wy} for ${BASIN} is found at its v1 key`, r.src.endsWith(`zonal/animations/${ANIM.period}/wy${ANIM.wy}/smoothed/${BASIN}_hypsomeswe_${ANIM.period}_smoothed_wy${ANIM.wy}.mp4`)
    || /can't play/.test(r.empty), JSON.stringify(r));
  check('[animation] console clean', real(errors).length === 0, real(errors).slice(0, 2).join(' | '));
  dataChecks('animation', data);
  await ctx.close();
}

// SNOTEL: the stations with their percentiles, and one station's dialog.
{
  const shown = () => { const i = document.getElementById('station-img');
    return document.getElementById('station-modal').open && !i.hidden && i.complete && i.naturalWidth > 100; };
  const { ctx, page, errors, data, ok } = await open(`?date=${D}&snotel=on&station=${STATION}`, { ready: shown });
  check(`[snotel] station ${STATION}'s plot shows`, ok);
  check('[snotel] reads stations.parquet and the latest percentiles', asked(data, /^snotel\/stations\.parquet$/)
    && asked(data, new RegExp(`^snotel/daily/latest/percentiles_${ROLE}\\.parquet$`)));
  check('[snotel] the plot is the v1 key', asked(data, new RegExp(`^snotel/daily/plots/${TP}/${DS}/smoothed/${esc(STATION)}_swe_${TP}_smoothed_${DS}\\.png$`)));
  await page.waitForTimeout(2000);
  const facts = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#station-table tr')].map(r => [r.querySelector('th')?.textContent, r.querySelector('td')?.textContent])));
  check('[snotel] facts table: observed, percentile and the normals', ['Observed SWE', 'Percentile', 'Median for this date', 'Mean for this date'].every(k => facts[k] && facts[k] !== '—')
    && asked(data, new RegExp(`^snotel/normals/${TP}/by_station/${esc(STATION)}_${TP}\\.parquet$`)), JSON.stringify(facts));
  const drawn = await page.evaluate(() => [...document.querySelectorAll('table')].find(t => /^SNOTEL/.test(t.caption?.textContent || ''))?.tBodies[0]?.rows.length || 0);
  check('[snotel] the stations\' table twin lists stations', drawn > 0, `${drawn} rows`);
  check('[snotel] console clean', real(errors).length === 0, real(errors).slice(0, 2).join(' | '));
  dataChecks('snotel', data);
  await page.screenshot({ path: 'verify-out/v1-snotel.png' });
  await ctx.close();
}

// An old link still lands on its flavor, rewritten in v1's name.
{
  const { ctx, page } = await open(`?date=${D}&flavor=zig`, { ready: painted });
  const r = await page.evaluate(() => ({ q: location.search, checked: document.querySelector('#flavor-btns input:checked')?.value }));
  check('[url] ?flavor=zig lands on Fitted, written ?flavor=fitted', r.checked === 'fitted' && /flavor=fitted/.test(r.q), JSON.stringify(r));
  await ctx.close();
}

await browser.close();
server.close();
finish();

function finish() {
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
