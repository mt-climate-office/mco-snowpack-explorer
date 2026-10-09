/* verify.config.mjs — scenarios for mco-web-style's tools/verify/ harness.

   Run from a kit checkout beside this repo:
     node tools/verify/head.mjs       --root ../mco-snowpack-explorer
     node tools/verify/axe-matrix.mjs --config ../mco-snowpack-explorer/verify.config.mjs --root ../mco-snowpack-explorer
     node tools/verify/keyboard.mjs   --config ../mco-snowpack-explorer/verify.config.mjs --root ../mco-snowpack-explorer

   Render evidence is the map canvas itself, not a DOM proxy: the legend is
   built before the map exists, and a COG layer blocked by CSP (or a worker
   that never started) leaves the basemap up with nothing on it and no error.
   So `ready` samples the WebGL canvas (preserveDrawingBuffer is on for the PNG
   export) and waits for saturated pixels. The CARTO basemaps and the
   hillshade are near-grey; the USDM ramp's reds, yellows and blues are not.
   A WINTER date on purpose — in summer there is no snow, so the raster is
   legitimately empty and the check would prove nothing. */
function painted() {
  const c = document.querySelector('#map canvas');
  if (!c || !c.width) return false;
  const w = 96, h = 64;
  const o = document.createElement('canvas');
  o.width = w; o.height = h;
  const x = o.getContext('2d');
  x.drawImage(c, 0, 0, w, h);
  const d = x.getImageData(0, 0, w, h).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    const mx = Math.max(d[i], d[i + 1], d[i + 2]);
    const mn = Math.min(d[i], d[i + 1], d[i + 2]);
    if (mx - mn > 90) n++;
  }
  return n > 60;
}

export default {
  root: '.', page: 'index.html',
  // The first-visit intro modal would otherwise open over every load.
  storage: { 'mco-snodas-info-seen': '1' },
  scenarios: [
    { name: 'gridded-winter', query: '?date=2026-02-15', ready: painted },
    { name: 'zonal-winter', query: '?date=2026-02-15&view=zonal&huc=4', ready: painted },
  ],
  exemptTargets: '',
  // Pre-existing, proven at baseline (pristine @0.7.1 checkout, 2026-10-09)
  // and in the 0.7.0 migration notes: the KIT's cog-protocol.js emptyTile()
  // calls OffscreenCanvas.convertToBlob() on a canvas that never had a
  // context, which the spec makes an InvalidStateError. Chromium only, at
  // 390px (where tiles fall outside the COG bounds). Reported to the kit;
  // it is not this app's code to fix. Never add a CSP line here.
  allowProblems: ['"OffscreenCanvas" has no rendering context'],
  dialogOpener: '#btn-info',
  shortcuts: [],
  probes: async ({ open, check }) => {
    const val = (p) => p.evaluate(() => document.getElementById('date-input').value);
    const waitFor = (p, d) => p.waitForFunction((d) => document.getElementById('date-input').value === d, d, { timeout: 15000 }).catch(() => {});
    // WCAG 2.1.1: the date stepper did nothing on Enter/Space before kit 0.9.0's MCO.initStepper.
    {
      const { page, close } = await open('?date=2026-02-15', { ready: painted, timeout: 45000 });
      await page.focus('#btn-date-prev'); await page.keyboard.press('Enter'); await waitFor(page, '2026-02-14');
      check('stepper: Enter on Previous day steps back', (await val(page)) === '2026-02-14', await val(page));
      await page.focus('#btn-date-next'); await page.keyboard.press('Space'); await waitFor(page, '2026-02-15');
      check('stepper: Space on Next day steps forward', (await val(page)) === '2026-02-15', await val(page));
      check('stepper: ?date= re-emitted', /date=2026-02-15/.test(await page.evaluate(() => location.search)));
      await close();
    }
    // Landscape phone: the nav rail's drawer (kit 0.10.0) — focus in, page inert, Esc back to Menu.
    {
      const { page, close } = await open('?date=2026-02-15&view=zonal&huc=4',
        { viewport: { name: '750x342', width: 750, height: 342, touch: true }, ready: painted, timeout: 45000 });
      await page.focus('#btn-rail-menu'); await page.keyboard.press('Enter'); await page.waitForTimeout(400);
      const o = await page.evaluate(() => ({ inside: document.getElementById('nav-drawer').contains(document.activeElement), inert: document.getElementById('main').inert }));
      check('rail: Enter on Menu opens the drawer with focus inside and #main inert', o.inside && o.inert, JSON.stringify(o));
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.activeElement.id === 'btn-rail-menu', null, { timeout: 5000 }).catch(() => {});
      const c = await page.evaluate(() => ({ focus: document.activeElement.id, inert: document.getElementById('main').inert }));
      check('rail: Esc closes it and returns focus to Menu', c.focus === 'btn-rail-menu' && !c.inert, JSON.stringify(c));
      await close();
    }
  },
};
