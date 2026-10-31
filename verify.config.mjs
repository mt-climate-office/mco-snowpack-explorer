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
   legitimately empty and the check would prove nothing. Functions, never
   strings: the page's CSP has no 'unsafe-eval'. */
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
// The search list is open over a typed query (for axe with the listbox
// showing). Types once; true once the options have rendered.
function searchListOpen() {
  const i = document.getElementById('search-input');
  if (i.value !== 'Gallatin') {
    i.focus(); i.value = 'Gallatin';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return document.querySelectorAll('#search-list .mco-search-option').length > 3;
}
// The basin dialog is open and its plot has decoded.
function plotShown() {
  const img = document.getElementById('basin-img');
  return document.getElementById('basin-modal').open && !img.hidden && img.complete && img.naturalWidth > 100;
}

// A SNOTEL station's dialog is open and its plot has decoded.
function stationShown() {
  const img = document.getElementById('station-img');
  return document.getElementById('station-modal').open && !img.hidden && img.complete && img.naturalWidth > 100;
}

export default {
  root: '.', page: 'index.html',
  // The first-visit intro modal would otherwise open over every load.
  storage: { 'mco-snowpack-info-seen': '1' },
  settleMs: 2000,
  scenarios: [
    { name: 'gridded-winter', query: '?date=2026-02-15', ready: painted },
    { name: 'zonal-winter', query: '?date=2026-02-15&view=zonal&huc=4', ready: painted },
    // A non-default flavor of normals (Empirical) on the zonal view.
    { name: 'zonal-flavor', query: '?date=2025-10-22&view=zonal&huc=4&flavor=ecdf', ready: painted },
    // Basin deep link: the dialog opens over the map on the HypsomeSWE plot.
    { name: 'basin-dialog', query: '?date=2025-10-22&view=zonal&huc=4&basin=1002&plot=hypsomeswe', ready: plotShown },
    // Place search with its listbox open (the Gazetteer and the watersheds).
    { name: 'search-list', query: '?date=2026-02-15', ready: searchListOpen },
    // SNOTEL stations over the gridded view, and one station's dialog on a
    // date its plots exist.
    { name: 'snotel', query: '?date=2026-02-15&snotel=on&lng=-111.5&lat=46.0&zoom=6', ready: painted },
    { name: 'station-dialog', query: '?date=2026-10-30&snotel=on&station=901_MT_SNTL', ready: stationShown },
    // Ski runs, lifts and names over Big Sky, close enough for the trail signs.
    { name: 'ski-runs', query: '?date=2026-02-15&lng=-111.40&lat=45.28&zoom=13.5', ready: painted },
  ],
  exemptTargets: '',
  allowProblems: [],
  dialogOpener: '#btn-info',
  shortcuts: [],
  probes: async ({ open, check }) => {
    const val = (p) => p.evaluate(() => document.getElementById('date-input').value);
    const search = (p) => p.evaluate(() => location.search);
    const waitFor = (p, d) => p.waitForFunction((d) => document.getElementById('date-input').value === d, d, { timeout: 15000 }).catch(() => {});
    // WCAG 2.1.1: the date stepper did nothing on Enter/Space before kit 0.9.0's MCO.initStepper.
    {
      const { page, close } = await open('?date=2026-02-15', { ready: painted, timeout: 45000 });
      await page.focus('#btn-date-prev'); await page.keyboard.press('Enter'); await waitFor(page, '2026-02-14');
      check('stepper: Enter on Previous day steps back', (await val(page)) === '2026-02-14', await val(page));
      await page.focus('#btn-date-next'); await page.keyboard.press('Space'); await waitFor(page, '2026-02-15');
      check('stepper: Space on Next day steps forward', (await val(page)) === '2026-02-15', await val(page));
      check('stepper: ?date= re-emitted', /date=2026-02-15/.test(await search(page)));
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
    // URL state (HOUSE-STYLE §4): defaults elided, bad values dropped, the
    // camera written back, an old ?method= link kept on its flavor.
    {
      const { page, close } = await open('?view=bogus&huc=7&flavor=nope&date=not-a-date', { ready: painted, timeout: 45000 });
      const q = new URLSearchParams(await search(page));
      check('URL: invalid view/huc/flavor/date are dropped; only the date is written',
        [...q.keys()].join(',') === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(q.get('date')), await search(page));
      await close();
    }
    {
      const { page, close } = await open('?date=2026-02-15&lng=-110.0000&lat=46.0000&zoom=5.00', { ready: painted, timeout: 45000 });
      check('URL: a shared camera is kept', /lng=-110\.0000&lat=46\.0000&zoom=5\.00/.test(await search(page)), await search(page));
      await close();
    }
    {
      const { page, close } = await open('?date=2026-02-15&view=zonal', { ready: painted, timeout: 45000 });
      const r = await page.evaluate(() => ({ q: location.search, checked: document.querySelector('#huc-btns input:checked').value,
        first: document.querySelector('#huc-btns input').value }));
      check('URL: the zonal view defaults to HUC8, listed first, and elides ?huc=', r.checked === '8' && r.first === '8' && !/huc=/.test(r.q), JSON.stringify(r));
      await close();
    }
    {
      const { page, close } = await open('?date=2026-02-15&method=ecdf', { ready: painted, timeout: 45000 });
      const r = await page.evaluate(() => ({ q: location.search, checked: document.querySelector('#flavor-btns input:checked').value }));
      check('URL: legacy ?method=ecdf lands on Empirical and is rewritten as ?flavor=', r.checked === 'ecdf' && /flavor=ecdf/.test(r.q) && !/method=/.test(r.q), JSON.stringify(r));
      await close();
    }
    // The first-visit intro opens on a bare URL and never over a deep link
    // (a fresh visitor: no seeded storage).
    {
      const intro = async (q) => {
        const { page, close } = await open(q, { storage: {}, ready: () => true, timeout: 45000 });
        await page.waitForTimeout(1000);
        const isOpen = await page.evaluate(() => document.getElementById('info-modal').open);
        await close();
        return isOpen;
      };
      const bare = await intro(''), deep = await intro('?date=2026-02-15');
      check('intro: opens on a bare URL, not over a ?date= deep link', bare && !deep, JSON.stringify({ bare, deep }));
    }
    // Basin dialog drill-down (HOUSE-STYLE §4): a click pushes one entry, Back
    // closes it (keeping what was chosen inside), Forward reopens it, and the
    // × steps Back over the entry instead of leaving a second one. Inside it,
    // the normals and the date are the page's own: changing them there moves
    // the navbar's controls and the map's data too.
    {
      const { page, close } = await open('?date=2025-10-22&view=zonal&huc=2', { ready: painted, timeout: 45000 });
      const st = () => page.evaluate(() => ({
        open: document.getElementById('basin-modal').open, basin: new URLSearchParams(location.search).get('basin'),
        flavor: new URLSearchParams(location.search).get('flavor'), date: document.getElementById('date-input').value,
        navFlavor: document.querySelector('#flavor-btns input:checked').value, len: history.length,
        focus: document.activeElement && (document.activeElement.id || document.activeElement.tagName),
      }));
      const box = await page.locator('#map').boundingBox();
      await page.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.45);
      await page.waitForFunction(() => document.getElementById('basin-modal').open, null, { timeout: 20000 }).catch(() => {});
      const opened = await st();
      check('basin: a watershed click opens its dialog and pushes ?basin=', opened.open && /^\d+$/.test(opened.basin || ''), JSON.stringify(opened));
      await page.focus('#basin-flavor-btns input:checked');
      await page.keyboard.press('ArrowRight'); await page.waitForTimeout(800);
      const fl = await st();
      check('basin: Normals in the dialog moves the navbar control and the URL', fl.navFlavor === 'zig' && fl.flavor === 'zig', JSON.stringify(fl));
      await page.focus('#btn-basin-next'); await page.keyboard.press('Enter');
      await waitFor(page, '2025-10-23');
      const dt = await st();
      check('basin: the dialog stepper moves the page date and re-emits ?date=', dt.date === '2025-10-23' && /date=2025-10-23/.test(await search(page)), JSON.stringify(dt));
      await page.goBack({ waitUntil: 'commit' }).catch(() => {}); await page.waitForTimeout(800);
      const back = await st();
      check('basin: Back closes the dialog and keeps the choices made in it', !back.open && !back.basin && back.flavor === 'zig' && back.date === '2025-10-23', JSON.stringify(back));
      await page.goForward({ waitUntil: 'commit' }).catch(() => {}); await page.waitForTimeout(1500);
      const fwd = await st();
      check('basin: Forward reopens it', fwd.open && fwd.basin === opened.basin, JSON.stringify(fwd));
      await page.keyboard.press('Escape'); await page.waitForTimeout(800);
      const esc = await st();
      check('basin: Esc closes without a new entry, focus off <body>', !esc.open && !esc.basin && esc.len === fwd.len && esc.focus !== 'BODY', JSON.stringify(esc));
      await close();
    }
    // The table twin is the keyboard route into a basin: Tab to it, Enter.
    {
      const { page, close } = await open('?date=2025-10-22&view=zonal&huc=2', { ready: painted, timeout: 45000 });
      await page.waitForFunction(() => document.querySelectorAll('main table button').length > 5, null, { timeout: 20000 }).catch(() => {});
      await page.focus('main table button[tabindex="0"]');
      await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.getElementById('basin-modal').open, null, { timeout: 20000 }).catch(() => {});
      const r = await page.evaluate(() => ({ open: document.getElementById('basin-modal').open, basin: new URLSearchParams(location.search).get('basin') }));
      check('basin: Enter on a table-twin row opens its dialog', r.open && !!r.basin, JSON.stringify(r));
      await close();
    }
    // A basin with no snow now and none in its normals has no HypsomeSWE plot:
    // said in words, with a way to the SWE plot.
    {
      const { page, close } = await open('?date=2025-09-01&view=zonal&huc=2&basin=03&plot=hypsomeswe', { ready: () => !document.getElementById('basin-empty').hidden, timeout: 45000 });
      const r = await page.evaluate(() => ({ text: document.getElementById('basin-empty').textContent, button: document.querySelector('#basin-empty button')?.textContent }));
      check('basin: a missing HypsomeSWE plot is explained, with Show the SWE plot', /No HypsomeSWE plot/.test(r.text) && r.button === 'Show the SWE plot', JSON.stringify(r));
      await close();
    }
    // Place search: a point stops at zoom 9 so the region stays in view, an
    // area fits its bounds no closer than 10, a watershed in the zonal view
    // switches to its level, ZIP codes load only once a digit is typed, and
    // focus stays in the field throughout.
    {
      const { page, close } = await open('?date=2026-02-15', { ready: painted, timeout: 45000 });
      const zips = [];
      page.on('request', r => { if (r.url().endsWith('/zips.json')) zips.push(r.url()); });
      const pick = async (q) => {
        const before = await search(page);
        await page.fill('#search-input', '');
        await page.focus('#search-input');
        await page.keyboard.type(q, { delay: 15 });
        await page.waitForFunction(() => document.querySelector('#search-list [aria-selected="true"]'), null, { timeout: 20000 }).catch(() => {});
        await page.keyboard.press('Enter');
        await page.waitForFunction((b) => location.search !== b, before, { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(600);
        const p = new URLSearchParams(await search(page));
        return { lng: +p.get('lng'), lat: +p.get('lat'), zoom: +p.get('zoom'), huc: p.get('huc'),
                 focus: await page.evaluate(() => document.activeElement.id) };
      };
      const city = await pick('Bozeman');
      check('search: a city zooms to 9 at that point, focus stays in the field',
        Math.abs(city.zoom - 9) < 0.01 && Math.abs(city.lng + 111.058) < 0.01 && Math.abs(city.lat - 45.684) < 0.01 && city.focus === 'search-input', JSON.stringify(city));
      const county = await pick('Gallatin County, MT');
      check('search: a county fits its bounds, no closer than zoom 10',
        county.zoom <= 10 && county.zoom > 6 && Math.abs(county.lng + 111.29) < 0.5 && Math.abs(county.lat - 45.34) < 0.5, JSON.stringify(county));
      check('search: ZIP codes not loaded before a digit is typed', zips.length === 0, String(zips.length));
      const zip = await pick('59715');
      check('search: a ZIP code loads its file and zooms to 9', zips.length === 1 && Math.abs(zip.zoom - 9) < 0.01, JSON.stringify({ ...zip, zips: zips.length }));
      await close();
    }
    {
      const { page, close } = await open('?date=2026-02-15&view=zonal&huc=4', { ready: painted, timeout: 45000 });
      await page.focus('#search-input');
      await page.keyboard.type('10020008', { delay: 15 });
      await page.waitForFunction(() => /10020008/.test(document.querySelector('#search-list [aria-selected="true"]')?.textContent || ''), null, { timeout: 30000 }).catch(() => {});
      await page.keyboard.press('Enter');
      // The level is written at once, the camera on moveend.
      await page.waitForFunction(() => !/huc=4/.test(location.search) && /zoom=/.test(location.search), null, { timeout: 15000 }).catch(() => {});
      const r = await page.evaluate(() => ({ q: location.search, level: document.querySelector('#huc-btns input:checked').value }));
      check('search: a HUC8 picked in the HUC4 view switches the level to HUC8', r.level === '8' && !/huc=/.test(r.q) && /zoom=/.test(r.q), JSON.stringify(r));
      await close();
    }
    // / jumps to the search (not with ?kbd=off, WCAG 2.1.4). At phone width the
    // field is an overlay: Esc closes the list and restores the text from
    // before it opened (empty: typing opened it), then a second Esc closes
    // the overlay with focus back on its toggle.
    {
      const { page, close } = await open('?date=2026-02-15', { ready: painted, timeout: 45000 });
      await page.focus('#main'); await page.keyboard.press('/');
      const on = await page.evaluate(() => document.activeElement.id);
      await close();
      const off = await open('?date=2026-02-15&kbd=off', { ready: painted, timeout: 45000 });
      await off.page.focus('#main'); await off.page.keyboard.press('/');
      const offFocus = await off.page.evaluate(() => ({ focus: document.activeElement.id, q: location.search }));
      await off.close();
      check('search: / focuses the field; ?kbd=off turns it off and stays in the URL',
        on === 'search-input' && offFocus.focus !== 'search-input' && /kbd=off/.test(offFocus.q), JSON.stringify({ on, off: offFocus }));
    }
    {
      const { page, close } = await open('?date=2026-02-15',
        { viewport: { name: '375x812', width: 375, height: 812, touch: true }, ready: painted, timeout: 45000 });
      await page.focus('#btn-search-toggle'); await page.keyboard.press('Enter'); await page.waitForTimeout(300);
      await page.keyboard.type('Bozeman', { delay: 15 });
      await page.waitForFunction(() => !document.getElementById('search-list').hidden, null, { timeout: 20000 }).catch(() => {});
      const s = () => page.evaluate(() => ({ list: !document.getElementById('search-list').hidden, text: document.getElementById('search-input').value,
        overlay: document.getElementById('search-wrap').classList.contains('is-open'), focus: document.activeElement.id }));
      await page.keyboard.press('Escape'); const e1 = await s();
      await page.keyboard.press('Escape'); await page.waitForTimeout(200); const e2 = await s();
      check('search (phone): Esc closes the list, a second Esc closes the overlay to its toggle',
        !e1.list && e1.overlay && e1.focus === 'search-input' && !e2.overlay && e2.focus === 'btn-search-toggle', JSON.stringify({ e1, e2 }));
      await close();
    }
    // ?export=light downloads the branded PNG headlessly. It fires as soon as
    // the data has drawn, which is before open() returns (it waits for the
    // network to go quiet), so listen first and load it again. Not a reload:
    // the first load has already rewritten the URL without ?export, as it
    // should (a shared link never re-exports).
    {
      const { page, close } = await open('?date=2026-02-15&export=light', { ready: () => true, settleMs: 0 });
      let ok = false;
      try {
        const dl = page.waitForEvent('download', { timeout: 60000 });
        await page.goto(new URL('?date=2026-02-15&export=light', page.url()).href);
        ok = /\.png$/.test((await dl).suggestedFilename());
      } catch { ok = false; }
      check('?export=light downloads a PNG', ok);
      await close();
    }
  },
};
