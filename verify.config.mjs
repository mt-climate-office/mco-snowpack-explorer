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
// The detail panel (the kit's .mco-sheet) is open on a basin, and its plot
// has decoded.
function plotShown() {
  const img = document.getElementById('basin-img');
  const sheet = document.getElementById('detail-sheet');
  return sheet.dataset.kind === 'basin' && sheet.dataset.state !== 'closed' && !img.hidden && img.complete && img.naturalWidth > 100;
}

// The detail panel is open on a SNOTEL station, and its plot has decoded.
function stationShown() {
  const img = document.getElementById('station-img');
  const sheet = document.getElementById('detail-sheet');
  return sheet.dataset.kind === 'station' && sheet.dataset.state !== 'closed' && !img.hidden && img.complete && img.naturalWidth > 100;
}

// The phone bar's drawer is open (kit 0.21.0 compact drawer; the landscape
// rail's below 560px tall). Above compact there is no drawer, and the bar
// is the scenario. Opens it once.
function drawerOpen() {
  if (!matchMedia('(max-width: 640px), (max-height: 560px)').matches) return painted();
  const d = document.getElementById('nav-drawer');
  if (!d.classList.contains('is-open')) document.getElementById('btn-rail-menu').click();
  return d.classList.contains('is-open') && document.getElementById('main').inert;
}

// The SNOTEL chip pressed (it lives in the phone drawer, so it is pressed by
// script there), and the stations drawn into their table twin.
function snotelChipOn() {
  const b = document.getElementById('btn-snotel');
  if (b.getAttribute('aria-pressed') !== 'true') b.click();
  const t = [...document.querySelectorAll('table')].find(x => /^SNOTEL/.test(x.caption?.textContent || ''));
  return b.classList.contains('mco-chip') && b.getAttribute('aria-pressed') === 'true' && t?.tBodies[0]?.rows.length > 0;
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
    { name: 'zonal-flavor', query: '?date=2025-10-22&view=zonal&huc=4&flavor=empirical', ready: painted },
    // Basin deep link: the detail panel opens beside the map on the
    // HypsomeSWE plot (a bottom sheet at 390).
    { name: 'basin-dialog', query: '?date=2025-10-22&view=zonal&huc=4&basin=1002&plot=hypsomeswe', ready: plotShown },
    // Place search with its listbox open (the Gazetteer and the watersheds).
    { name: 'search-list', query: '?date=2026-02-15', ready: searchListOpen },
    // SNOTEL stations over the gridded view, and the ?station= deep link:
    // the detail panel at 1440, the bottom sheet at 390, on a date its plots
    // exist (901_MT_SNTL is in the live stations.parquet).
    { name: 'snotel', query: '?date=2026-02-15&snotel=on&lng=-111.5&lat=46.0&zoom=6', ready: painted },
    { name: 'station-deeplink', query: '?date=2026-10-30&station=901_MT_SNTL', ready: stationShown },
    // The phone bar's drawer open (at 1440, the bar itself).
    { name: 'drawer-open', query: '?date=2026-02-15', ready: drawerOpen },
    // A chip toggled on: SNOTEL from a URL that has it off.
    { name: 'chip-toggle', query: '?date=2026-02-15', ready: snotelChipOn },
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
      check('URL: legacy ?method=ecdf lands on Empirical and is rewritten as ?flavor=empirical', r.checked === 'empirical' && /flavor=empirical/.test(r.q) && !/method=/.test(r.q), JSON.stringify(r));
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
    // Basin drill-down in the detail panel (HOUSE-STYLE §4): a click pushes
    // one entry, Back closes it (keeping what was chosen inside), Forward
    // reopens it, and Esc steps Back over the entry instead of leaving a
    // second one. Inside it, the normals and the date are the page's own:
    // changing them there moves the navbar's controls and the map's data too.
    {
      const { page, close } = await open('?date=2025-10-22&view=zonal&huc=2', { ready: painted, timeout: 45000 });
      const st = () => page.evaluate(() => ({
        open: document.getElementById('detail-sheet').dataset.kind === 'basin' && document.getElementById('detail-sheet').dataset.state !== 'closed',
        basin: new URLSearchParams(location.search).get('basin'),
        flavor: new URLSearchParams(location.search).get('flavor'), date: document.getElementById('date-input').value,
        navFlavor: document.querySelector('#flavor-btns input:checked').value, len: history.length,
        focus: document.activeElement && (document.activeElement.id || document.activeElement.tagName),
      }));
      const box = await page.locator('#map').boundingBox();
      await page.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.45);
      await page.waitForFunction(() => document.getElementById('detail-sheet').dataset.kind === 'basin', null, { timeout: 20000 }).catch(() => {});
      const opened = await st();
      check('basin: a watershed click opens it in the detail panel and pushes ?basin=', opened.open && /^\d+$/.test(opened.basin || ''), JSON.stringify(opened));
      await page.focus('#detail-flavor-btns input:checked');
      await page.keyboard.press('ArrowRight'); await page.waitForTimeout(800);
      const fl = await st();
      check('basin: Normals in the panel moves the navbar control and the URL', fl.navFlavor === 'fitted' && fl.flavor === 'fitted', JSON.stringify(fl));
      await page.focus('#btn-detail-next'); await page.keyboard.press('Enter');
      await waitFor(page, '2025-10-23');
      const dt = await st();
      check('basin: the panel stepper moves the page date and re-emits ?date=', dt.date === '2025-10-23' && /date=2025-10-23/.test(await search(page)), JSON.stringify(dt));
      await page.goBack({ waitUntil: 'commit' }).catch(() => {}); await page.waitForTimeout(800);
      const back = await st();
      check('basin: Back closes the panel and keeps the choices made in it', !back.open && !back.basin && back.flavor === 'fitted' && back.date === '2025-10-23', JSON.stringify(back));
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
      await page.waitForFunction(() => document.getElementById('detail-sheet').dataset.kind === 'basin', null, { timeout: 20000 }).catch(() => {});
      const r = await page.evaluate(() => ({ open: document.getElementById('detail-sheet').dataset.kind === 'basin', basin: new URLSearchParams(location.search).get('basin'),
        focus: document.activeElement.id }));
      check('basin: Enter on a table-twin row opens it in the panel, focus on its title', r.open && !!r.basin && r.focus === 'detail-title', JSON.stringify(r));
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
    // field is in the bar's drawer (kit 0.21.0): the bar's search button opens
    // it there, Esc closes the list and restores the text from before it
    // opened (empty: typing opened it), then a second Esc closes the drawer
    // with focus back on the search button.
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
      const opened = await page.evaluate(() => ({ drawer: document.getElementById('nav-drawer').classList.contains('is-open'), focus: document.activeElement.id }));
      await page.keyboard.type('Bozeman', { delay: 15 });
      await page.waitForFunction(() => !document.getElementById('search-list').hidden, null, { timeout: 20000 }).catch(() => {});
      const s = () => page.evaluate(() => ({ list: !document.getElementById('search-list').hidden, text: document.getElementById('search-input').value,
        drawer: document.getElementById('nav-drawer').classList.contains('is-open'), focus: document.activeElement.id }));
      await page.keyboard.press('Escape'); const e1 = await s();
      await page.keyboard.press('Escape'); await page.waitForTimeout(300); const e2 = await s();
      check('search (phone): the bar\'s search button opens the drawer on the field; Esc closes the list, a second Esc the drawer, back to the button',
        opened.drawer && opened.focus === 'search-input' && !e1.list && e1.drawer && e1.focus === 'search-input' && !e2.drawer && e2.focus === 'btn-search-toggle', JSON.stringify({ opened, e1, e2 }));
      await close();
    }
    // The phone bar (kit 0.21.0): one row at 390, ≤ 64px, badge at the left
    // edge and ☰ at the right; ☰ opens the right drawer with focus inside
    // and the page inert, and Esc closes it back to ☰. The bar's stepper is
    // the hot control: Enter on Next day steps the date.
    {
      const { page, close } = await open('?date=2026-02-15',
        { viewport: { name: '390x844', width: 390, height: 844, touch: true }, ready: painted, timeout: 45000 });
      const bar = await page.evaluate(() => {
        const r = (el) => el.getBoundingClientRect();
        return { h: Math.round(r(document.getElementById('navbar')).height), logoX: Math.round(r(document.querySelector('.logo-link')).left),
          menuRight: Math.round(r(document.getElementById('btn-rail-menu')).right), w: innerWidth,
          hot: ['btn-rail-prev', 'rail-readout', 'btn-rail-next', 'btn-search-toggle'].every(id => r(document.getElementById(id)).width > 0) };
      });
      check('phone bar: one row ≤ 64px, badge left, ☰ right, stepper and search in the row',
        bar.h <= 64 && bar.logoX < 20 && bar.w - bar.menuRight < 20 && bar.hot, JSON.stringify(bar));
      await page.focus('#btn-rail-menu'); await page.keyboard.press('Enter'); await page.waitForTimeout(400);
      const o = await page.evaluate(() => ({ inside: document.getElementById('nav-drawer').contains(document.activeElement), inert: document.getElementById('main').inert,
        right: Math.round(innerWidth - document.getElementById('nav-drawer').getBoundingClientRect().right) }));
      check('phone bar: Enter on ☰ opens the right drawer with focus inside and #main inert', o.inside && o.inert && o.right === 0, JSON.stringify(o));
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.activeElement.id === 'btn-rail-menu', null, { timeout: 5000 }).catch(() => {});
      const c = await page.evaluate(() => ({ focus: document.activeElement.id, inert: document.getElementById('main').inert }));
      check('phone bar: Esc closes the drawer and returns focus to ☰', c.focus === 'btn-rail-menu' && !c.inert, JSON.stringify(c));
      await page.focus('#btn-rail-next'); await page.keyboard.press('Enter');
      await waitFor(page, '2026-02-16');
      check('phone bar: Enter on the bar\'s Next day steps the date', (await val(page)) === '2026-02-16', await val(page));
      await close();
    }
    // ?station= opens the detail panel (the kit's sheet: end-docked at 1440,
    // a bottom sheet at 390), and a station opened from the map pushes one
    // entry that Back closes. The SNOTEL toggle is a chip.
    for (const vp of [{ name: '1440x900', width: 1440, height: 900 }, { name: '390x844', width: 390, height: 844, touch: true }]) {
      const shown = () => document.getElementById('detail-sheet').dataset.kind === 'station' && document.getElementById('detail-sheet').dataset.state !== 'closed';
      const deep = await open('?date=2026-10-30&station=901_MT_SNTL', { viewport: vp, ready: shown, timeout: 45000 }).catch(() => null);
      const d = deep ? await deep.page.evaluate(() => ({ state: document.getElementById('detail-sheet').dataset.state, title: document.getElementById('detail-title').textContent,
        station: new URLSearchParams(location.search).get('station'), chip: document.getElementById('btn-snotel').className + ' ' + document.getElementById('btn-snotel').getAttribute('aria-pressed') })) : null;
      check(`station (${vp.name}): ?station= opens the detail panel (${vp.touch ? 'peek' : 'full'}), SNOTEL chip pressed`,
        !!d && d.state === (vp.touch ? 'peek' : 'full') && d.station === '901_MT_SNTL' && d.title.length > 0 && /mco-chip true/.test(d.chip), JSON.stringify(d));
      if (deep) await deep.close();
      const { page, close } = await open('?date=2026-02-15&snotel=on&lng=-111.5&lat=46.0&zoom=6', { viewport: vp, ready: painted, timeout: 45000 });
      await page.waitForFunction(() => [...document.querySelectorAll('table')].find(t => /^SNOTEL/.test(t.caption?.textContent || ''))?.querySelector('button[tabindex="0"]'), null, { timeout: 20000 }).catch(() => {});
      const len0 = await page.evaluate(() => history.length);
      await page.focus('table:has(caption:text-matches("^SNOTEL")) button[tabindex="0"]').catch(() => {});
      await page.keyboard.press('Enter');
      await page.waitForFunction(shown, null, { timeout: 20000 }).catch(() => {});
      const o = await page.evaluate(() => ({ kind: document.getElementById('detail-sheet').dataset.kind, station: new URLSearchParams(location.search).get('station'), len: history.length }));
      await page.goBack({ waitUntil: 'commit' }).catch(() => {}); await page.waitForTimeout(1000);
      const b = await page.evaluate(() => ({ state: document.getElementById('detail-sheet').dataset.state, station: new URLSearchParams(location.search).get('station'),
        focus: document.activeElement && (document.activeElement.id || document.activeElement.tagName) }));
      check(`station (${vp.name}): a table-twin row opens the panel with one pushed entry, and Back closes it`,
        o.kind === 'station' && !!o.station && o.len === len0 + 1 && b.state === 'closed' && !b.station && b.focus !== 'BODY', JSON.stringify({ o, b, len0 }));
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
