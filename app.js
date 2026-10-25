/* ==========================================================================
   Snowpack Explorer — application code.

   A classic script, like every kit consumer: MCO / MCO.map are globals from
   the kit's classic <script> tags, which run before this one. The Parquet
   reader (hyparquet + fzstd) is vendored in vendor/ (scripts/vendor.sh, the
   mesonet-aq bundle byte for byte) and comes in by dynamic import(), which
   classic scripts allow; 'self' covers it in the CSP.

   MapLibre is different since kit 0.8.0: 6.x is ES-modules only, so there is
   no maplibregl global until MCO.map.loadMapLibre() has imported it (under
   the import map's SRI hashes in index.html). The IIFE awaits it first, so
   every maplibregl.* below — and CogProtocol.initCogProtocol — sees it.

   Extracted from an inline <script type="module"> during the mco-web-style
   migration (kit @0.6.0) — an external file is what lets the page ship a meta
   CSP without 'unsafe-inline'.
   ========================================================================== */

// Architecture overview:
//   - Gridded view: renders a COG raster tile layer via the custom cog:// MapLibre protocol.
//   - Zonal view: renders HUC watershed polygons colored by aggregated SWE percentile.
//     Boundaries are loaded from FlatGeobuf (cached in Cache API across sessions).
//     Percentiles are loaded from Parquet (cached in memory per date).
//     Feature state drives the fill color so geometry is only uploaded once per level.
//   - Layer order (back → front): swe → huc-fill → hillshade → huc-line → labels

(async () => {
  'use strict';

  // ── Constants ────────────────────────────────────────────────────────────
  // The first date with published percentiles: the normals pipeline
  // (mco-snodas) starts at snow year 2026, so nothing before 2025-09-01 has
  // a percentile file even though SNODAS itself begins in 2003. Move this
  // back if older years are ever backfilled.
  const SNODAS_START = '2025-09-01';
  const DATA_HOST  = 'https://data2.climate.umt.edu';
  // Backup: data2's CloudFront default domain serves the same paths. Swap it in
  // if data2's certificate lapses again (the CSP already allows both).
  // const DATA_HOST  = 'https://d1s8jav5n0eyyf.cloudfront.net';
  const S3_ROOT    = `${DATA_HOST}/snodas/normals/gridded`;
  const FGB_ROOT   = `${DATA_HOST}/snodas/cache/data/fgb`;
  const ZONAL_ROOT = `${DATA_HOST}/snodas/normals/zonal/wbd`;
  const BREAKS  = [0, 2, 5, 10, 20, 30, 70, 80, 90, 95, 98];
  // U.S. Drought Monitor categories, paired 1:1 with BREAKS and COLORS. These
  // are NOT decoration: the ramp is hue-only by design, so D4 (exceptional
  // drought) and W4 (exceptional wet) reduce to the same grey in print and for
  // a viewer with achromatopsia. The category name is the redundant channel
  // WCAG 1.4.1 requires, which is why the legend prints it beside every swatch
  // (HOUSE-STYLE §6).
  const CATEGORIES = [
    'D4 — Exceptional drought', 'D3 — Extreme drought', 'D2 — Severe drought',
    'D1 — Moderate drought',    'D0 — Abnormally dry',   'Near normal',
    'W0 — Abnormally wet',      'W1 — Moderate wet',     'W2 — Severe wet',
    'W3 — Extreme wet',         'W4 — Exceptional wet',
  ];
  const COLORS  = [
    [115,  0,   0], // D4 exceptional drought
    [230,  0,   0], // D3 extreme drought
    [255, 170,  0], // D2 severe drought
    [252, 211,127], // D1 moderate drought
    [255, 255,  0], // D0 abnormally dry
    [255, 255,255], // near-normal
    [130, 252,249], // W0 abnormally wet
    [ 50, 225,250], // W1 moderate wet
    [ 50,  92,254], // W2 severe wet
    [ 64,  48,227], // W3 extreme wet
    [ 48,  59,131], // W4 exceptional wet
  ];

  // Step thresholds + colors for HUC fill expressions (mirrors the COG colormap)
  const HUC_COLOR_STOPS = BREAKS.slice(1).flatMap((b, i) => [b, `rgb(${COLORS[i + 1]})`]);

  // The three normals flavors mco-snodas publishes, keyed by their path
  // segment. `short` labels the control, `name` everything a person reads.
  // Smoothed is the default: the steadiest through the season.
  const FLAVORS = {
    zig_smooth: { short: 'Smoothed',  name: 'Smoothed normals' },
    zig:        { short: 'Fitted',    name: 'Fitted normals' },
    ecdf:       { short: 'Empirical', name: 'Empirical normals' },
  };
  const DEFAULT_FLAVOR = 'zig_smooth';
  const flavorName = (f = currentFlavor) => FLAVORS[f].name;

  const VIEWS      = ['gridded', 'zonal'];
  const HUC_LEVELS = [2, 4, 6, 8];
  const LS_INFO_SEEN     = 'mco-snowpack-info-seen';
  const LS_INFO_SEEN_OLD = 'mco-snodas-info-seen';   // pre-0.18 key, still honoured
  const LS_LEGEND        = 'mco-snowpack-legend';

  const mainEl = document.getElementById('main');

  // The pipeline's pointer to the newest published date. Fetched first, in
  // parallel with MapLibre, so the page opens on a day that exists instead of
  // probing today's (usually unpublished) file. Null when it can't be read;
  // the date probe below still works without it.
  const LATEST_URL = `${DATA_HOST}/snodas/latest/manifest.json`;
  const _latestP = MCO.fetchJSON(LATEST_URL, { cache: 'no-cache' })
    .then(m => (/^\d{4}-\d{2}-\d{2}$/.test(m && m.date) ? m.date : null))
    .catch(() => null);

  // ── MapLibre 6 ───────────────────────────────────────────────────────────
  // Awaited before anything else: the UI wiring below closes over `map`, so
  // it must not run ahead of the library. A failed import (offline, CDN down,
  // an SRI mismatch) says so over the map rather than leaving an empty pane.
  try {
    await MCO.map.loadMapLibre();
  } catch (err) {
    console.error('[maplibre]', err);
    MCO.notice({
      tone: 'danger', text: 'The map library failed to load.',
      action: { label: 'Reload', onClick: () => location.reload() },
      container: mainEl, place: 'over',
    });
    MCO.ready();
    return;
  }

  // ── Colormap ─────────────────────────────────────────────────────────────
  CogProtocol.registerColormap('ptile', CogProtocol.makeStepColormap({
    breaks: BREAKS, colors: COLORS, alpha: 210, domain: [0, 100],
  }));
  CogProtocol.initCogProtocol(maplibregl);

  // ── Helpers ───────────────────────────────────────────────────────────────
  function ordinal(n) {
    const s = [,'st','nd','rd'][n % 100 >> 3 ^ 1 && n % 10] || 'th';
    return `${n}${s}`;
  }

  // SWE depth as the plots and tables print it: mm, then inches.
  const fmtSwe = (v) => (v == null || Number.isNaN(v) ? '—' : `${Math.round(v)} mm (${(v / 25.4).toFixed(1)} in)`);

  // Build an element with DOM calls only (HOUSE-STYLE §7): text children are
  // set as text, never parsed as HTML.
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) Object.assign(el, props);
    for (const c of children) if (c != null) el.append(c);
    return el;
  }

  const isIsoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !isNaN(new Date(`${s}T12:00:00`));

  // ── URL / state ───────────────────────────────────────────────────────────
  // URL is the primary state (HOUSE-STYLE §4): read once here, every value
  // checked against what it may be.
  const urlParams = MCO.urlParams();
  const getLower  = (k) => MCO.getParamLower(k, urlParams);

  // The newest date there is data for: the manifest's, or today (Mountain
  // time) when the manifest can't be read.
  let latestDate = (await _latestP) || MCO.todayMT();
  const askedDate = isIsoDate(urlParams.get('date')) ? urlParams.get('date') : null;
  let currentDate     = askedDate || latestDate;
  let currentView     = VIEWS.includes(getLower('view')) ? getLower('view') : 'gridded';
  // HUC8, the finest level, is the zonal view's default.
  const DEFAULT_HUC = 8;
  let currentHucLevel = (() => { const v = parseInt(urlParams.get('huc'), 10); return HUC_LEVELS.includes(v) ? v : DEFAULT_HUC; })();
  // ?method=zig|ecdf is how the flavor was spelled before it had a control;
  // an old link still lands on the flavor it named.
  let currentFlavor = FLAVORS[getLower('flavor')] ? getLower('flavor')
                    : ['zig', 'ecdf'].includes(getLower('method')) ? getLower('method')
                    : DEFAULT_FLAVOR;
  if (currentDate < SNODAS_START) currentDate = SNODAS_START;
  if (currentDate > latestDate)   currentDate = latestDate;

  // The basin dialog's state: which watershed is open (null when closed) and
  // which of its two plots shows. ?basin= opens it on load; ?plot= is only
  // written while it is open.
  const PLOT_TYPES   = { swe: 'SWE', hypsomeswe: 'HypsomeSWE' };
  const DEFAULT_PLOT = 'swe';
  const isHuc = (s) => /^\d+$/.test(s || '') && HUC_LEVELS.includes(String(s).length);
  let currentBasin = null;   // { huc, name, level }
  let _selectedHuc = null;   // the open basin's outline on the map
  let _focusedHuc  = null;   // the table twin's keyboard focus, shown on the map
  let currentPlot  = PLOT_TYPES[getLower('plot')] ? getLower('plot') : DEFAULT_PLOT;
  const askedBasin = isHuc(urlParams.get('basin')) ? urlParams.get('basin') : null;

  // Headless export (HOUSE-STYLE §4 ?export= convention): ?export=light|dark
  // forces the theme before the map is built, set directly rather than with
  // MCO.setTheme so a scripted run never persists a theme. ?export=true, the
  // old spelling, exports in whatever theme the page booted with.
  const _exportParam = getLower('export');
  const exportOnLoad = ['light', 'dark', 'true'].includes(_exportParam);
  if (_exportParam === 'light' || _exportParam === 'dark') {
    document.documentElement.dataset.theme = _exportParam;
  }

  // URL builders
  const cogUrl        = (d, m = currentFlavor) => `${S3_ROOT}/${m}/${d}/${d}_${m}_swe_ptile.tif`;
  const fgbUrl        = lvl   => `${FGB_ROOT}/huc${lvl}.fgb`;
  const zonalUrl      = (d, m = currentFlavor) => `${ZONAL_ROOT}/${m}/${d}/${d}_${m}_swe_normals.parquet`;
  const provenanceUrl = (d, m = currentFlavor) => `${S3_ROOT}/${m}/${d}/${d}_${m}_provenance.json`;

  async function cogExists(d, url = cogUrl(d)) {
    try {
      const r = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-3' } });
      if (!r.ok && r.status !== 206) return false;
      const buf = new Uint8Array(await r.arrayBuffer());
      // Valid TIFF starts with 'II' (0x49 0x49) or 'MM' (0x4D 0x4D)
      return buf.length >= 2 && ((buf[0] === 0x49 && buf[1] === 0x49) || (buf[0] === 0x4D && buf[1] === 0x4D));
    } catch { return false; }
  }

  // Walk backwards from the given date to find the most recent date with data.
  // Returns the original date if it has data, otherwise tries up to `maxDays`
  // prior dates. MCO.shiftDate, not a Date round-trip through toISOString():
  // that re-projects to UTC and lands a day early for viewers east of it.
  async function findLatestAvailable(startDate, maxDays = 30) {
    let d = startDate;
    for (let i = 0; i < maxDays; i++) {
      if (d < SNODAS_START) break;
      if (await cogExists(d)) return d;
      d = MCO.shiftDate(d, -1);
    }
    return null;
  }

  let map = null;
  let _mapReady = false;

  // Mirror state into the query string (HOUSE-STYLE §4). The date is always
  // written: its default is "the latest available", so a link without it
  // would show a different day tomorrow. Everything else is elided at its
  // default — the gridded view, Smoothed normals, the default extent
  // (cameraParamsIfDefault), and the theme a visitor with no choice would get
  // (MCO.osTheme()). A legacy ?method= is not carried forward.
  function writeUrl({ push = false, state } = {}) {
    const params = { date: currentDate };
    if (currentView === 'zonal') {
      params.view = 'zonal';
      if (currentHucLevel !== DEFAULT_HUC) params.huc = currentHucLevel;
    }
    if (currentFlavor !== DEFAULT_FLAVOR) params.flavor = currentFlavor;
    if (currentBasin) {
      params.basin = currentBasin.huc;
      if (currentPlot !== DEFAULT_PLOT) params.plot = currentPlot;
    }
    const theme = MCO.getTheme();
    if (theme !== MCO.osTheme()) params.theme = theme;
    if (_mapReady) Object.assign(params, MCO.map.cameraParamsIfDefault(map, { bounds: COG_BOUNDS, fitOpts: FIT_OPTS }));
    if (push) MCO.pushUrlState(params, { state });
    else MCO.replaceUrlState(params);
    updateMeta();
    updateRail();
  }

  // HOUSE-STYLE §1 page titles and link cards through the kit: the tab is
  // "<date> · Snowpack · MCO" (detail first — a tab truncates — and the SHORT
  // family); the card is the same with the long family. og:url follows the
  // shared state; the canonical link stays the static one in index.html.
  function updateMeta() {
    const dateFmt = MCO.formatDateStr(currentDate);
    const where = currentView === 'zonal' ? `HUC${currentHucLevel} watersheds` : 'the contiguous United States';
    const desc = `Snow water equivalent percentiles for ${where} on ${dateFmt}, against ${flavorName().toLowerCase()}, from NOAA SNODAS. `
               + 'A service of the Montana Climate Office.';
    MCO.setPageTitle({ short: 'Snowpack', family: 'MCO', detail: dateFmt });
    MCO.setSocialMeta({ short: 'Snowpack', family: 'MCO', detail: dateFmt, description: desc, url: location.href });
    document.querySelector('meta[name="description"]')?.setAttribute('content', desc);
  }

  // The date at a glance in the landscape rail, where the drawer is usually
  // closed. Spans built with textContent.
  const railReadout = document.getElementById('rail-readout');
  function updateRail() {
    const d = new Date(`${currentDate}T12:00:00`);
    const md = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    railReadout.replaceChildren(...[md, String(d.getFullYear())].map(t => h('span', { textContent: t })));
  }

  // ── Announcements ─────────────────────────────────────────────────────────
  // MCO.showToast owns the transient toast (and creates its own element).
  const showToast = MCO.showToast;

  // A pinned reading is an answer to a question — and the only route a
  // screen-reader user has to a gridded raster value at all — so it goes
  // through the page's one announcer, MCO.announce. The toast that shows the
  // same text is kept out of the accessibility tree for it ({announce:
  // false}), or a screen reader would hear every reading twice.
  const pinReading = (msg) => {
    showToast(msg, undefined, { announce: false });
    MCO.announce(msg);
  };

  // ── Theme ─────────────────────────────────────────────────────────────────
  // MCO.initThemeToggle owns the icon swap, the aria-label, and persistence to
  // the shared mco-theme key. The toggle only mirrors the theme into the URL;
  // the map restyles from the kit's mco:themechange event, which every theme
  // source fires. The style.load listener below re-adds the data layers.
  MCO.initThemeToggle({
    button:   document.getElementById('btn-theme'),
    iconSun:  document.getElementById('icon-sun'),
    iconMoon: document.getElementById('icon-moon'),
    // 3-state (kit 0.10.0): dark → light → high contrast. The icon and
    // aria-label name the theme a press switches TO.
    cycle: true,
    iconContrast: document.getElementById('icon-contrast'),
    onChange: () => writeUrl(),
  });
  document.addEventListener('mco:themechange', () => { if (map) map.setStyle(MCO.map.cartoStyleUrl()); });

  // ── Legend ────────────────────────────────────────────────────────────────
  // Static rows: the kit swatch (with its --border edge, so the white
  // near-normal bin can't vanish) beside "D4 — Exceptional drought · < 2",
  // category first because that is the part that survives greyscale and CVD.
  const legendRowsEl = document.getElementById('legend-rows');
  for (let i = 0; i < BREAKS.length; i++) {
    const lo  = BREAKS[i];
    const hi  = i + 1 < BREAKS.length ? BREAKS[i + 1] : null;
    const lbl = lo === 0 ? `< ${hi}` : hi === null ? `≥ ${lo}` : `${lo}–${hi}`;
    const swatch = h('span', { className: 'mco-legend-swatch' });
    swatch.setAttribute('aria-hidden', 'true');
    swatch.style.setProperty('--swatch', `rgb(${COLORS[i]})`);
    legendRowsEl.append(h('div', { className: 'legend-row' },
      swatch,
      h('span', { className: 'legend-lbl' },
        h('span', { className: 'legend-cat', textContent: CATEGORIES[i] }),
        h('span', { className: 'legend-range', textContent: lbl }))));
  }

  // The kit's collapsible panel: aria-expanded on the toggle, [hidden] on the
  // body after the slide, the choice remembered, and collapsed by default on
  // a compact screen (short landscape phones included) until the visitor
  // says otherwise.
  MCO.initCollapsible({
    toggle: document.getElementById('legend-toggle'),
    body:   document.getElementById('legend-body'),
    storageKey: LS_LEGEND,
    autoCollapseOnCompact: true,
  });

  // ── Provenance ────────────────────────────────────────────────────────────
  // Cached per date and flavor; a failed fetch is evicted, so a later open
  // tries again, and resolves to null for the callers.
  const _cache = MCO.promiseCache();
  function fetchProvenance(d, m = currentFlavor) {
    return _cache.cached(`prov:${d}_${m}`, () => MCO.fetchJSON(provenanceUrl(d, m))).catch(() => null);
  }

  function refRange(prov) {
    const years = prov.reference_dates.map(d => d.slice(0, 4));
    return `${years[0]}–${years[years.length - 1]}`;
  }

  function updateLegendMeta(prov) {
    document.getElementById('legend-sub').textContent = flavorName();
    const el = document.getElementById('legend-meta');
    if (!prov) { el.textContent = ''; return; }
    el.replaceChildren(
      h('span', { textContent: MCO.formatDateStr(prov.normals_date) }),
      h('span', { textContent: refRange(prov) }));
  }

  fetchProvenance(currentDate).then(updateLegendMeta);

  // ── Map ───────────────────────────────────────────────────────────────────
  // No API keys here: the basemap is the kit's keyless CARTO and the
  // hillshade the kit's keyless AWS terrarium DEM. The old Stadia and
  // MapTiler keys are still in git history and should be revoked at the
  // vendors.
  const COG_BOUNDS = [[-124.733, 24.95], [-66.94, 52.875]];
  const FIT_OPTS   = { padding: 20 };

  // Check the starting date in parallel with the basemap style loading, and
  // pre-fetch its COG metadata only once it is known to exist: today's file
  // is usually not published yet, and preloading a 404 throws inside the
  // kit's protocol (the CONSUMERS.md "errors on an unpublished day" item).
  const _initDateOk = cogExists(currentDate);
  _initDateOk.then(ok => { if (ok) CogProtocol.preload(cogUrl(currentDate)); });

  map = new maplibregl.Map({
    container: 'map',
    style: MCO.map.cartoStyleUrl(),
    ...MCO.map.initialCamera(urlParams, { bounds: COG_BOUNDS, fitOpts: FIT_OPTS }),
    canvasContextAttributes: { preserveDrawingBuffer: true }, // required for PNG export (MapLibre ≥ 5 option; unchanged in 6)
  });

  // House navigation: zoom buttons, top-right, no compass — rotation isn't a
  // feature here — with the full-extent button fused into the same group, and
  // the zoom floor that keeps the lower 48 filling the viewport.
  MCO.map.addNavigation(map);
  MCO.map.addFitControl(map, { bounds: COG_BOUNDS, fitOpts: FIT_OPTS, title: 'Zoom to the lower 48' });
  const zoomFloor = MCO.map.installZoomFloor(map, { bounds: COG_BOUNDS, fitOpts: FIT_OPTS });
  // …so rotation goes too, or a rotated map would have no way back north.
  map.dragRotate.disable();
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();

  // A dead basemap no longer leaves a blank page: the style is retried, then
  // replaced by the kit's blank style (which loads, so the data still draws)
  // with a Retry notice.
  MCO.map.watchBasemap(map);

  // Re-add the data layers on EVERY style.load — a theme switch, a basemap
  // retry or the blank fallback each replace the style and drop them. The
  // first load is handled by the 'load' handler below, which validates the
  // date before adding the COG source (a missing date would fill the console
  // with tile errors), so this waits until that has happened once.
  let _layersAdded = false;
  map.on('style.load', () => {
    if (!_layersAdded) return;
    addCustomLayers();
    _hucSourceLevel = null;   // the HUC source was recreated empty — force a full reload
    if (currentView === 'zonal') setHucLayer();
  });

  const HUC_LAYERS = ['huc-fill', 'huc-line', 'huc-focus', 'huc-selected'];

  // Add custom sources and layers in the correct z-order.
  // Called on initial load and after each basemap style swap.
  function addCustomLayers() {
    const before = MCO.map.firstSymbolLayerId(map);

    // Hillshade — the kit's keyless AWS terrarium DEM with per-theme paints.
    // Keeps the layer id 'hillshade' so the huc-fill insertion anchor below
    // still resolves.
    MCO.map.addHillshade(map, { layerId: 'hillshade', beforeId: before });

    // HUC zonal layers
    // Layer order (back→front): swe → huc-fill → hillshade → huc-line → labels
    if (!map.getSource('huc')) {
      map.addSource('huc', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    if (!map.getLayer('huc-fill')) {
      map.addLayer({
        id: 'huc-fill', type: 'fill', source: 'huc',
        layout: { visibility: 'none' },
        paint: {
          // Data fill, not text: a watershed with no percentile is a mid grey
          // at 10% opacity, a wash that reads as "nothing here" on either
          // basemap; its name and "no data" reach AT through the table twin.
          'fill-color': ['case',
            ['==', ['feature-state', 'swe_ptile'], null], 'rgb(128,128,128)',
            ['step', ['feature-state', 'swe_ptile'], `rgb(${COLORS[0]})`, ...HUC_COLOR_STOPS],
          ],
          'fill-opacity': ['case', ['==', ['feature-state', 'swe_ptile'], null], 0.1, 0.85],
        },
      }, 'hillshade');
    }
    if (!map.getLayer('huc-line')) {
      map.addLayer({
        id: 'huc-line', type: 'line', source: 'huc',
        layout: { visibility: 'none' },
        // Boundary between data fills (contrast, WCAG 1.4.11): #333 measures
        // 6.6–12.6:1 against the D2–W1 fills and the white near-normal bin,
        // but only 1.0–2.6:1 against D4/D3 and W2–W4; there the fill change
        // between neighbours carries the edge, and the twin carries the data.
        paint: { 'line-color': '#333', 'line-width': 0.7, 'line-opacity': 0.7 },
      }, before);
    }

    // The open basin's outline (--selection-ring) and the table twin's
    // keyboard focus (--accent-line, distinct from selection), both read at
    // paint time and re-read on every style.load, so a theme switch follows
    // (HOUSE-STYLE §7). Feature state picks the one watershed; every other
    // edge is drawn at zero opacity.
    if (!map.getLayer('huc-focus')) {
      map.addLayer({
        id: 'huc-focus', type: 'line', source: 'huc',
        layout: { visibility: 'none' },
        paint: {
          'line-color': MCO.cssVar('--accent-line'), 'line-width': 2, 'line-dasharray': [2, 1],
          'line-opacity': ['case', ['boolean', ['feature-state', 'focused'], false], 1, 0],
        },
      }, before);
    }
    if (!map.getLayer('huc-selected')) {
      map.addLayer({
        id: 'huc-selected', type: 'line', source: 'huc',
        layout: { visibility: 'none' },
        paint: {
          'line-color': MCO.cssVar('--selection-ring'), 'line-width': 3,
          'line-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 1, 0],
        },
      }, before);
    }

    // SWE COG — sits below HUC fills
    if (!map.getSource('swe')) {
      map.addSource('swe', {
        type: 'raster',
        tiles: [`cog://ptile/${cogUrl(currentDate)}/{z}/{x}/{y}`],
        tileSize: 256, minzoom: 2, maxzoom: 14,
        attribution: MCO.credit({ source: 'NOAA SNODAS' }),   // the one credit string; middots, never a pipe
      });
    }
    if (!map.getLayer('swe')) {
      map.addLayer({
        id: 'swe', type: 'raster', source: 'swe',
        paint: { 'raster-opacity': 0.85, 'raster-fade-duration': 0 },
      }, 'huc-fill');
    }

    // Restore visibility for current view
    map.setLayoutProperty('swe', 'visibility', currentView === 'gridded' ? 'visible' : 'none');
    const zonalVis = currentView === 'zonal' ? 'visible' : 'none';
    for (const id of HUC_LAYERS) map.setLayoutProperty(id, 'visibility', zonalVis);
  }

  // The progress bar over the map for the slow steps: the date probe, the
  // watershed boundaries and the zonal table. Never shown for a fast load.
  const loading = MCO.loading(mainEl, { label: 'Loading snowpack data', place: 'over' });

  map.on('load', async () => {
    zoomFloor.refresh();

    // Validate initial date — today's data may not be processed yet.
    loading.start();
    if (!(await _initDateOk)) {
      const fallback = await findLatestAvailable(MCO.shiftDate(currentDate, -1));
      if (fallback) {
        currentDate = fallback;
        dateInput.value = currentDate;
        if (!exportOnLoad) showToast(`Showing the latest available date, ${MCO.formatDateStr(currentDate)}.`, 5000);
        fetchProvenance(currentDate).then(updateLegendMeta);
      } else {
        MCO.notice({
          tone: 'danger', text: 'No SNODAS data was found for the last 30 days.',
          action: { label: 'Reload', onClick: () => location.reload() },
          container: mainEl, place: 'over',
        });
      }
      refreshSteppers();   // the fallback moved the date off its upper bound
    }
    loading.done();

    addCustomLayers();
    _layersAdded = true;

    // Preload all FGB boundary files in the background so zonal view is instant
    preloadFgb();

    // Apply initial view state.
    // Build _initReady: a promise that resolves only when the first data layer
    // is genuinely ready to render (geometry + colors applied).
    //   • Zonal  → await setHucLayer() (FGB fetch + parquet + feature states)
    //   • Gridded → triggerRepaint to issue COG tile requests, then await idle
    const _initReady = currentView === 'zonal'
      ? setHucLayer()
      : new Promise(r => { map.triggerRepaint(); map.once('idle', r); });

    // Mirror the camera on every pan or zoom. The first write publishes the
    // clean initial URL (and drops anything stale, like ?method=).
    _mapReady = true;
    map.on('moveend', () => writeUrl());
    writeUrl();

    // First meaningful state: the first data layer has drawn. Releases the
    // kit's html.mco-booting first-paint hold; the anti-flash snippet's 3 s
    // timeout releases it anyway if this never resolves.
    _initReady.then(() => MCO.ready(), () => MCO.ready());

    // URL-triggered export: fire only after the data layer is ready
    if (exportOnLoad) _initReady.then(exportMap);

    // ?basin= opens its dialog in place: the entry already names it, so this
    // replaces rather than pushes.
    if (askedBasin && !exportOnLoad) openBasin(askedBasin, { push: false });
  });

  // Update the COG raster tiles to a new date (no-op if source not yet added).
  function setSweLayer(d) {
    map.getSource('swe')?.setTiles([`cog://ptile/${cogUrl(d)}/{z}/{x}/{y}`]);
  }

  // Refresh whichever layers are active for the current date.
  function refreshLayers() {
    if (!_layersAdded) return;
    setSweLayer(currentDate);
    if (currentView === 'zonal') setHucLayer();
  }


  // ── Date picker ───────────────────────────────────────────────────────────
  const dateInput = document.getElementById('date-input');
  dateInput.min   = SNODAS_START;
  dateInput.max   = latestDate;
  dateInput.value = currentDate;

  async function setDate(dateStr, { silent = false } = {}) {
    let d = dateStr;
    if (d < SNODAS_START)  { d = SNODAS_START;  showToast(`The earliest date is ${MCO.formatDateStr(d)}.`); }
    if (d > latestDate)    { d = latestDate;    showToast(`The latest date with data is ${MCO.formatDateStr(d)}.`); }
    if (d === currentDate) { dateInput.value = d; basinDate.value = d; return; }

    loading.start();
    if (!(await cogExists(d))) {
      const fallback = await findLatestAvailable(d);
      if (!fallback || fallback === currentDate) {
        loading.done();
        showToast(`No SNODAS data was found near ${MCO.formatDateStr(d)}.`, 5000);
        dateInput.value = currentDate;
        basinDate.value = currentDate;
        return;
      }
      d = fallback;
      showToast(`Showing the latest available date, ${MCO.formatDateStr(d)}.`, 5000);
    }
    loading.done();

    currentDate = d;
    dateInput.value = currentDate;
    if (!silent) writeUrl();
    CogProtocol.preload(cogUrl(currentDate));
    refreshLayers();
    fetchProvenance(currentDate).then(updateLegendMeta);
    refreshSteppers();
    renderBasin();
  }

  dateInput.addEventListener('change', () => {
    if (isIsoDate(dateInput.value)) setDate(dateInput.value);
    else dateInput.value = currentDate;
  });

  // Date steppers — the kit's: a step on click (keyboard included), a repeat
  // while a pointer is held, and a button disabled at its bound. The navbar's
  // pair and the landscape rail's pair drive the same date. The new date is
  // announced, since the change is otherwise visible only on the map.
  const stepperOpts = {
    onStep: (d) => {
      setDate(MCO.shiftDate(currentDate, d))
        .then(() => MCO.announce(`Showing ${MCO.formatDateStr(currentDate)}`));
    },
    canStep: (d) => (d < 0 ? currentDate > SNODAS_START : currentDate < latestDate),
  };
  const steppers = [
    MCO.initStepper({ prev: document.getElementById('btn-date-prev'), next: document.getElementById('btn-date-next'), ...stepperOpts }),
    MCO.initStepper({ prev: document.getElementById('btn-rail-prev'), next: document.getElementById('btn-rail-next'), ...stepperOpts }),
  ];
  function refreshSteppers() { steppers.forEach(s => s.refresh()); }

  // ── HUC zonal layers ──────────────────────────────────────────────────────
  const _fgbCache   = new Map(); // level → GeoJSON features array (with id field)
  const _zonalCache = new Map(); // `${date}_${flavor}` → Map<zone, row>, once loaded
  let _hucSourceLevel = null;    // which level is currently loaded into the 'huc' source

  // The vendored Parquet reader, imported once on first use. A failed import
  // is not cached, so a Retry imports it again.
  let _parquetLib = null;
  function parquetLib() {
    return _parquetLib || (_parquetLib = import('./vendor/parquet.min.js')
      .catch(err => { _parquetLib = null; throw err; }));
  }

  // Fetch with Cache API persistence (falls back to plain fetch in non-secure contexts)
  async function fetchCached(url) {
    try {
      const cache = await caches.open('mco-snodas-fgb-v1');
      const hit   = await cache.match(url);
      if (hit) return hit;
      const res = await fetch(url);
      if (res.ok) cache.put(url, res.clone());
      return res;
    } catch {
      return fetch(url);
    }
  }

  // One level's boundaries, once (Cache API across sessions, memory within
  // one). A failure is evicted, so the next call retries.
  function loadFgb(level) {
    return _cache.cached(`fgb:${level}`, async () => {
      const res = await fetchCached(fgbUrl(level));
      if (!res.ok) throw new Error(`FGB fetch failed: ${res.status}`);
      const features = [];
      for await (const f of flatgeobuf.deserialize(res.body))
        features.push({ ...f, id: f.properties.huc });
      _fgbCache.set(level, features);
      return features;
    });
  }

  // Preload all FGB boundary files in the background so zonal view is instant
  function preloadFgb() {
    for (const lvl of HUC_LEVELS) loadFgb(lvl).catch(() => {});   // silent — retried on demand
  }

  // One date and flavor's watershed table: zone → { ptile, swe, mean, q10,
  // q50, q90 } (SWE in mm). The columns the map, the tooltip and the basin
  // dialog's text alternative need, and no more: about 225 KB a file.
  const ZONAL_COLUMNS = ['zone', 'swe_ptile', 'swe', 'mean', 'q0100', 'q0500', 'q0900'];
  function loadZonal(date, flavor) {
    return _cache.cached(`zonal:${date}_${flavor}`, async () => {
      const res = await fetch(zonalUrl(date, flavor));
      if (!res.ok) throw new Error(`Parquet fetch failed: ${res.status}`);
      const ab = await res.arrayBuffer();
      const pq = await parquetLib();
      const rows = await pq.parquetReadObjects({
        file: ab,
        columns: ZONAL_COLUMNS,
        compressors: { ZSTD: (input) => pq.zstdDecompress(input) },
      });
      const lookup = new Map();
      for (const r of rows) {
        if (r.zone == null) continue;
        lookup.set(String(r.zone), {
          ptile: r.swe_ptile ?? null, swe: r.swe ?? null, mean: r.mean ?? null,
          q10: r.q0100 ?? null, q50: r.q0500 ?? null, q90: r.q0900 ?? null,
        });
      }
      _zonalCache.set(`${date}_${flavor}`, lookup);
      return lookup;
    });
  }

  // "Nothing to show" over the map, for a date on which no watershed has a
  // percentile (no snow anywhere in the reference record, or a summer date).
  const emptyEl = h('div', { className: 'mco-empty', hidden: true,
    textContent: 'No watershed has snow to compare on this date.' });
  emptyEl.dataset.place = 'over';
  mainEl.append(emptyEl);

  let _hucSeq = 0;
  async function setHucLayer() {
    if (!map.getSource('huc')) return;
    const seq = ++_hucSeq;
    const level = currentHucLevel, date = currentDate;
    loading.start();
    try {
      // ── Steps 1–2: FGB geometry (once per level) and the Parquet table ──
      const [features, zonalData] = await Promise.all([loadFgb(level), loadZonal(date, currentFlavor)]);
      // A newer call (another date step, another level) has taken over.
      if (seq !== _hucSeq || currentView !== 'zonal') return;

      // ── Step 3: push geometry to source only when the level changes ──
      if (_hucSourceLevel !== level) {
        map.getSource('huc').setData({ type: 'FeatureCollection', features });
        _hucSourceLevel = level;
      }

      // ── Step 4: push swe_ptile as feature state (no geometry re-upload) ──
      // The open basin's outline rides along, since setData and a style
      // reload both drop feature state.
      const rows = [];
      for (const f of features) {
        const ptile = zonalData.get(String(f.properties.huc))?.ptile ?? null;
        map.setFeatureState({ source: 'huc', id: f.id }, { swe_ptile: ptile, selected: String(f.id) === _selectedHuc });
        rows.push({ id: String(f.properties.huc), name: f.properties.name, huc: f.properties.huc, ptile });
      }
      renderTwin(rows);
      emptyEl.hidden = rows.some(r => r.ptile != null);

      for (const id of HUC_LAYERS) map.setLayoutProperty(id, 'visibility', 'visible');
      map.setLayoutProperty('swe', 'visibility', 'none');
      loading.done();
    } catch (err) {
      console.error('[setHucLayer]', err);
      if (seq !== _hucSeq) return;
      // A danger notice with Retry, announced assertively (§5.1: load
      // failures are the one assertive case).
      loading.fail('Watershed data failed to load.', { retry: setHucLayer });
    }
  }

  // ── Table twin (HOUSE-STYLE §5.2) ─────────────────────────────────────────
  // The zonal view is canvas data: the twin gives a screen-reader user every
  // drawn watershed and its percentile (the kit caps it at 500 rows; HUC8 has
  // more, and the overflow row says so). The gridded raster has no tabular
  // form — its AT path is the click-to-pin reading — so the twin is empty
  // there and the map's label says which applies. The kit mounts it in
  // <main> and ends the caption with the row count; the level and date are
  // in the map's label, which introduces the table.
  // selectable: the twin is the keyboard route into a basin (one Tab stop,
  // arrows to move, Enter opens its dialog). Its buttons are visually hidden,
  // so the visible focus indicator is on the map: the focused watershed's
  // dashed --accent-line outline.
  const mapEl = document.getElementById('map');
  const twin = MCO.srTable({
    caption: 'Watershed SWE percentiles',
    selectable: true,
    onSelect: (row) => openBasin(row.huc),
    onFocus: (row) => setFocused(row ? String(row.huc) : null),
    columns: [
      { key: 'name', label: 'Watershed', rowHeader: true },
      { key: 'huc', label: 'HUC code' },
      { key: 'ptile', label: 'SWE percentile', value: (r) => (r.ptile == null ? 'no data' : ordinal(Math.round(r.ptile))) },
    ],
    overflowText: (n) => `…and ${n} more watersheds. Choose a coarser HUC level to list them all.`,
  });
  // The open basin is the twin's aria-current row.
  function refreshTwinSelection() { twin.render(_twinRows, { selected: _selectedHuc }); }
  let _twinRows = [];
  function renderTwin(rows) {
    if (rows) rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    _twinRows = rows || [];
    twin.render(_twinRows, { selected: _selectedHuc });
    mapEl.setAttribute('aria-label', rows
      ? `SWE percentile map, zonal view, HUC${currentHucLevel} watersheds, ${MCO.formatDateStr(currentDate)}, ${flavorName().toLowerCase()}. Click a watershed for its plots. The data is in the table that follows.`
      : 'SWE percentile map, gridded view. Click or tap the map to hear the percentile at that point.');
  }
  if (currentView !== 'zonal') renderTwin(null);

  // ── View and HUC level ────────────────────────────────────────────────────
  // Radio fieldsets with <select> twins below 1400px (the ladder rung where
  // this bar sheds), one source of truth each: MCO.initSegmentedFallback.
  const hucGroup = document.getElementById('huc-group');
  const viewCtl = MCO.initSegmentedFallback({
    group: document.getElementById('view-btns'),
    select: document.getElementById('view-select'),
    mq: '(max-width: 1400px)',
    onChange: (v) => setView(v),
  });
  const hucCtl = MCO.initSegmentedFallback({
    group: document.getElementById('huc-btns'),
    select: document.getElementById('huc-select'),
    mq: '(max-width: 1400px)',
    onChange: (v) => setHucLevel(parseInt(v, 10)),
  });
  const flavorCtl = MCO.initSegmentedFallback({
    group: document.getElementById('flavor-btns'),
    select: document.getElementById('flavor-select'),
    mq: '(max-width: 1400px)',
    onChange: (f) => setFlavor(f),
  });
  viewCtl.set(currentView);
  hucCtl.set(String(currentHucLevel));
  flavorCtl.set(currentFlavor);
  hucGroup.hidden = currentView !== 'zonal';

  function setHucLevel(lvl, { silent = false } = {}) {
    if (lvl === currentHucLevel) return;
    currentHucLevel = lvl;
    hucCtl.set(String(lvl));
    if (!silent) { writeUrl(); MCO.announce(`HUC${lvl} watersheds`); }
    if (_layersAdded) setHucLayer();
  }

  // Every percentile on the page is read against one flavor of normals, so a
  // switch redraws whichever view is showing and the legend's provenance.
  // The URL builders take the flavor as their path segment.
  function setFlavor(f, { silent = false } = {}) {
    if (!FLAVORS[f] || f === currentFlavor) return;
    currentFlavor = f;
    flavorCtl.set(f);
    if (!silent) { writeUrl(); MCO.announce(`Percentiles against ${flavorName().toLowerCase()}`); }
    CogProtocol.preload(cogUrl(currentDate));
    refreshLayers();
    fetchProvenance(currentDate).then(updateLegendMeta);
    renderBasin();
  }

  function setView(v, { silent = false } = {}) {
    if (v === currentView) return;
    currentView = v;
    viewCtl.set(v);
    hucGroup.hidden = v !== 'zonal';
    if (!silent) {
      writeUrl();
      MCO.announce(v === 'zonal' ? `Zonal view, HUC${currentHucLevel} watersheds` : 'Gridded view');
    }
    if (!_layersAdded) return;
    if (v === 'gridded') {
      _hucSeq++;            // abandon a zonal load still in flight
      loading.done();
      emptyEl.hidden = true;
      renderTwin(null);
      map.setLayoutProperty('swe', 'visibility', 'visible');
      for (const id of HUC_LAYERS) map.setLayoutProperty(id, 'visibility', 'none');
    } else {
      setHucLayer(); // hides swe only after a successful load
    }
  }

  // ── Back / Forward ────────────────────────────────────────────────────────
  // The only pushed entry is a basin dialog's opening (HOUSE-STYLE §4
  // drill-down); everything else is replaced. So a history move opens or
  // closes the dialog, and otherwise follows the entry silently — it is
  // already the URL.
  MCO.onUrlState((params) => {
    // The dialog's own close stepped Back over its entry. That entry still
    // holds the date and normals from before it opened; the page keeps what
    // the visitor chose inside the dialog, so rewrite it rather than follow.
    if (_backFromClose) { _backFromClose = false; writeUrl(); return; }
    // Back from an open dialog closes it, and only that: the date and
    // normals chosen inside it stay, exactly as the × and Esc leave them.
    if (basinModal.open && !isHuc(params.get('basin'))) {
      _closingFromHistory = true;
      currentBasin = null;   // the close event is async; this write must not carry it
      basinModal.close();
      MCO.announce('Basin closed');
      writeUrl();
      return;
    }
    const d = params.get('date');
    if (isIsoDate(d) && d !== currentDate) setDate(d, { silent: true });
    const v = (params.get('view') || 'gridded').toLowerCase();
    const lvl = parseInt(params.get('huc'), 10);
    if (HUC_LEVELS.includes(lvl)) setHucLevel(lvl, { silent: true });
    const f = (params.get('flavor') || DEFAULT_FLAVOR).toLowerCase();
    if (FLAVORS[f]) setFlavor(f, { silent: true });
    if (VIEWS.includes(v)) setView(v, { silent: true });
    const t = (params.get('plot') || DEFAULT_PLOT).toLowerCase();
    if (PLOT_TYPES[t]) setPlotType(t, { silent: true });
    const basin = params.get('basin');
    if (isHuc(basin) && (!basinModal.open || currentBasin?.huc !== basin)) openBasin(basin, { push: false });
  });

  // ── Hover tooltip ─────────────────────────────────────────────────────────
  // What a basin plot's title and subtitle say, for whatever is under the
  // pointer, against the current flavor:
  //   Duncan River (HUC: 17010109)        ← zonal only
  //   March 30, 2026
  //   148% of Normal (~90th percentile)
  //   SWE 81 mm (3.2 in)
  // App-owned rather than MCO.map.initCursorTooltip: the gridded reading is
  // an async raster sample, not a rendered feature. The lines are spans set
  // with textContent, in the kit's tooltip classes.
  const tooltip = document.getElementById('tooltip');
  let _hoverSeq = 0;

  // The daily SNODAS SWE grid (int16 mm, the percentile COGs' grid), and the
  // normal's median for the date (int16 mm; the q0500 band of the quantiles
  // COG, published on its own by mco-snodas for point queries).
  const sweCogUrl    = (d) => `${DATA_HOST}/snodas/cogs/${d}/snodas_swe_${d.replace(/-/g, '')}.tif`;
  const medianCogUrl = (d, m = currentFlavor) => `${S3_ROOT}/${m}/${d}/${d}_${m}_median.tif`;
  // Whether that median exists, asked once per date and flavor: dates built
  // before it was published have none, and the kit's reader would otherwise
  // re-request the missing file on every pointer move.
  function medianExists(d, m = currentFlavor) {
    return _cache.cached(`median:${d}_${m}`, () => cogExists(d, medianCogUrl(d, m)));
  }

  // The plots' subtitle wording, from mco-snodas R/plot.R snodas_conditions():
  // percent of the median for the date, then the percentile. Percent of
  // normal is undefined when the median is zero (or not known).
  function conditions(swe, median, ptile) {
    const pct  = swe != null && median > 0 ? `${Math.round(100 * swe / median)}% of Normal` : null;
    const rank = ptile != null ? `~${ordinal(Math.round(ptile))} percentile` : null;
    if (!pct && !rank) return 'No normal for this date';
    return !pct ? rank : !rank ? pct : `${pct} (${rank})`;
  }
  const sweLine = (swe) => (swe == null ? null : `SWE ${fmtSwe(swe)}`);

  // The reading under a map point: {title?, lines[]}, or null for no data.
  // Zonal: the watershed's row from the Parquet table (synchronous once
  // loaded). Gridded: the percentile, SWE and median grids, sampled in
  // parallel. Where the median isn't published, conditions() shows the
  // percentile alone, as the plots do when the median is zero.
  function zonalReading(f) {
    const { name, huc } = f.properties;
    const row = _zonalCache.get(`${currentDate}_${currentFlavor}`)?.get(String(huc)) ?? null;
    return {
      title: `${name || `HUC${String(huc).length}`} (HUC: ${huc})`,
      lines: [MCO.formatDateStr(currentDate),
        ...(row ? [conditions(row.swe, row.q50, row.ptile), sweLine(row.swe)] : [])].filter(Boolean),
    };
  }
  async function griddedReading(lngLat) {
    const d = currentDate, m = currentFlavor;
    const [ptile, swe, median] = await Promise.all([
      CogProtocol.queryValue(cogUrl(d, m), lngLat.lng, lngLat.lat),
      CogProtocol.queryValue(sweCogUrl(d), lngLat.lng, lngLat.lat).catch(() => null),
      medianExists(d, m).then(ok => (ok ? CogProtocol.queryValue(medianCogUrl(d, m), lngLat.lng, lngLat.lat) : null))
        .catch(() => null),
    ]);
    if (ptile == null && swe == null) return null;
    return { lines: [MCO.formatDateStr(d), conditions(swe, median, ptile), sweLine(swe)].filter(Boolean) };
  }

  function showTooltip(r, e) {
    tooltip.replaceChildren(
      ...(r.title ? [h('span', { className: 'tooltip-name', textContent: r.title })] : []),
      ...r.lines.map((t, i) => h('span', { className: i === 0 ? 'tooltip-sub' : 'tooltip-val', textContent: t })));
    tooltip.classList.add('visible');
    // Cursor + 14px, flipped at the viewport's right and bottom edges.
    const cx = e.originalEvent.clientX, cy = e.originalEvent.clientY;
    let x = cx + 14, y = cy + 14;
    if (x + tooltip.offsetWidth  > window.innerWidth  - 8) x = cx - tooltip.offsetWidth  - 14;
    if (y + tooltip.offsetHeight > window.innerHeight - 8) y = cy - tooltip.offsetHeight - 14;
    tooltip.style.left = `${Math.max(4, x)}px`;
    tooltip.style.top  = `${Math.max(4, y)}px`;
  }

  map.on('mousemove', async (e) => {
    const seq = ++_hoverSeq;
    if (currentView === 'zonal') {
      const hits = map.queryRenderedFeatures(e.point, { layers: ['huc-fill'] });
      if (hits.length) showTooltip(zonalReading(hits[0]), e);
      else tooltip.classList.remove('visible');
      return;
    }
    const r = await griddedReading(e.lngLat);
    if (seq !== _hoverSeq) return;
    if (!r) tooltip.classList.remove('visible');
    else showTooltip(r, e);
  });

  map.on('mouseout', () => { _hoverSeq++; tooltip.classList.remove('visible'); });

  // A click or tap on a watershed opens its basin dialog. On the gridded
  // raster it pins the same reading the tooltip shows and announces it: the
  // touch path and the assistive-tech path to a value, since a hover
  // tooltip is never surfaced.
  map.on('click', async (e) => {
    if (currentView === 'zonal') {
      const hits = map.queryRenderedFeatures(e.point, { layers: ['huc-fill'] });
      if (!hits.length) return;
      openBasin(String(hits[0].properties.huc));
      return;
    }

    // Gridded view: sample the pixel under the pointer.
    const r = await griddedReading(e.lngLat);
    const where = `${Math.abs(e.lngLat.lat).toFixed(2)}°${e.lngLat.lat >= 0 ? 'N' : 'S'}, `
                + `${Math.abs(e.lngLat.lng).toFixed(2)}°${e.lngLat.lng >= 0 ? 'E' : 'W'}`;
    pinReading(r ? `${where}: ${r.lines.slice(1).join(', ')}` : `No snowpack data at ${where}`);
  });

  // ── Basin dialog ──────────────────────────────────────────────────────────
  // One watershed's SWE or HypsomeSWE plot, the PNGs mco-snodas renders per
  // date, flavor and HUC (plots/{date}/{flavor}/{type}/usdm/{huc}.png, with
  // plots/{date}/index.json written last as the "date complete" marker).
  // The dialog has no state of its own beyond the basin and the plot type:
  // its date and normals controls call the page's setDate / setFlavor, and
  // those setters update every control bound to them, so the dialog and the
  // map behind it can't drift apart.
  const PLOTS_ROOT = `${DATA_HOST}/snodas/plots`;
  const PLOT_STYLE = 'usdm';
  const basinModal    = document.getElementById('basin-modal');
  const basinCtl      = MCO.initInfoModal({ dialog: basinModal });
  const basinTitle    = document.getElementById('basin-title');
  const basinSubtitle = document.getElementById('basin-subtitle');
  const basinDate     = document.getElementById('basin-date');
  const basinFlavorFs = document.getElementById('basin-flavor-btns');
  const basinPlotFs   = document.getElementById('basin-plot-btns');
  const basinFrame    = document.getElementById('basin-frame');
  const basinImg      = document.getElementById('basin-img');
  const basinEmpty    = document.getElementById('basin-empty');
  const basinCaption  = document.getElementById('basin-caption');
  const basinData     = document.getElementById('basin-data');
  const basinTable    = document.getElementById('basin-table');

  basinDate.min = SNODAS_START;
  basinDate.max = latestDate;
  basinDate.value = currentDate;
  basinDate.addEventListener('change', () => {
    if (isIsoDate(basinDate.value)) setDate(basinDate.value);
    else basinDate.value = currentDate;
  });
  steppers.push(MCO.initStepper({
    prev: document.getElementById('btn-basin-prev'), next: document.getElementById('btn-basin-next'), ...stepperOpts,
  }));
  basinFlavorFs.addEventListener('change', (e) => setFlavor(e.target.value));
  basinPlotFs.addEventListener('change', (e) => setPlotType(e.target.value));

  function checkRadio(fieldset, value) {
    for (const r of fieldset.querySelectorAll('input[type="radio"]')) r.checked = r.value === value;
  }
  function syncBasinControls() {
    basinDate.value = currentDate;
    checkRadio(basinFlavorFs, currentFlavor);
    checkRadio(basinPlotFs, currentPlot);
  }

  function setPlotType(t, { silent = false } = {}) {
    if (!PLOT_TYPES[t] || t === currentPlot) return;
    currentPlot = t;
    checkRadio(basinPlotFs, t);
    if (!currentBasin) return;
    if (!silent) { writeUrl(); MCO.announce(`${PLOT_TYPES[t]} plot`); }
    renderBasin();
  }

  // ── Selection and keyboard focus on the map ──
  function setHucState(prev, next, key) {
    if (!map.getSource('huc')) return;
    if (prev != null) map.setFeatureState({ source: 'huc', id: prev }, { [key]: false });
    if (next != null) map.setFeatureState({ source: 'huc', id: next }, { [key]: true });
  }
  function setSelected(huc) { setHucState(_selectedHuc, huc, 'selected'); _selectedHuc = huc; }
  function setFocused(huc)  { setHucState(_focusedHuc, huc, 'focused');   _focusedHuc = huc; }

  // ── Opening and closing ──
  // Opening is drill-down (HOUSE-STYLE §4): the first step pushes a history
  // entry marked {mcoDetail}, so Back closes the dialog; changes made while
  // it is open replace that entry. A basin opens the zonal view at its own
  // level, so the outline behind the dialog is the watershed it shows.
  async function openBasin(huc, { push = true } = {}) {
    huc = String(huc);
    if (!isHuc(huc)) return;
    const level = huc.length;
    let feature = null;
    try { feature = (await loadFgb(level)).find(f => String(f.properties.huc) === huc); } catch { /* below */ }
    if (!feature) { showToast(`No HUC${level} watershed ${huc} was found.`); return; }
    const wasOpen = basinModal.open;
    currentBasin = { huc, name: feature.properties.name || `HUC${level} ${huc}`, level };
    if (currentView !== 'zonal') setView('zonal', { silent: true });
    if (level !== currentHucLevel) setHucLevel(level, { silent: true });
    setSelected(huc);
    refreshTwinSelection();
    writeUrl(push && !wasOpen ? { push: true, state: { mcoDetail: huc } } : {});
    if (!wasOpen) basinCtl.open();
    renderBasin();
  }

  // Close (×, Esc, backdrop or Back) has one path. If this dialog pushed its
  // entry, step Back over it, so the close button and the browser's Back
  // land on the same entry and Forward reopens it; when Back itself closed
  // it, the URL is already right.
  let _closingFromHistory = false, _backFromClose = false;
  basinModal.addEventListener('close', () => {
    currentBasin = null;
    _basinSeq++;
    setSelected(null);
    refreshTwinSelection();
    if (_closingFromHistory) _closingFromHistory = false;
    else if (history.state && history.state.mcoDetail) { _backFromClose = true; history.back(); }
    else writeUrl();
    // A dialog opened from a deep link has no opener; never leave focus on
    // <body>. The browser restores focus after this event, hence the tick.
    setTimeout(() => {
      if (!document.activeElement || document.activeElement === document.body) mainEl.focus();
    }, 0);
  });

  // ── Which dates have plots ──
  // index.json is memoised per date, hits and misses alike. The list of
  // dates comes from one anonymous S3 listing of plots/, cached for the
  // session (mco-snodas publishes no catalog of plot dates yet).
  function plotIndex(d) {
    return _cache.cached(`plots:${d}`, () => MCO.fetchJSON(`${PLOTS_ROOT}/${d}/index.json`).catch(() => null));
  }
  function plotDates() {
    return _cache.cached('plots:dates', async () => {
      const dates = [];
      let token = null;
      do {
        const q = new URLSearchParams({ 'list-type': '2', prefix: 'plots/', delimiter: '/' });
        if (token) q.set('continuation-token', token);
        const res = await fetch(`${DATA_HOST}/snodas/?${q}`);
        if (!res.ok) throw new Error(`plot listing failed: ${res.status}`);
        const xml = new DOMParser().parseFromString(await res.text(), 'application/xml');
        for (const el of xml.getElementsByTagName('Prefix')) {
          const m = /^plots\/(\d{4}-\d{2}-\d{2})\/$/.exec(el.textContent);
          if (m) dates.push(m[1]);
        }
        token = xml.getElementsByTagName('IsTruncated')[0]?.textContent === 'true'
          ? xml.getElementsByTagName('NextContinuationToken')[0]?.textContent : null;
      } while (token);
      return dates.sort();
    }).catch(() => []);
  }
  // The closest date to d whose plots are complete (its index.json exists).
  async function nearestPlotDate(d) {
    const t = (x) => new Date(`${x}T12:00:00`).getTime();
    const ranked = (await plotDates())
      .filter(x => x !== d && x >= SNODAS_START && x <= latestDate)
      .sort((a, b) => Math.abs(t(a) - t(d)) - Math.abs(t(b) - t(d)));
    for (const x of ranked.slice(0, 5)) if (await plotIndex(x)) return x;
    return null;
  }

  // Resolves true once the image has decoded, false on a 404 or a network
  // failure. Remembered per URL, so stepping back and forth doesn't refetch.
  const _imgOk = new Map();
  function loadImage(url) {
    if (!_imgOk.has(url)) {
      _imgOk.set(url, new Promise(resolve => {
        const img = new Image();
        img.onload  = () => resolve(true);
        img.onerror = () => { _imgOk.delete(url); resolve(false); };
        img.src = url;
      }));
    }
    return _imgOk.get(url);
  }
  const plotUrl = (idx, d, flavor, type, huc) => `${PLOTS_ROOT}/${d}/` + (idx.path || '{flavor}/{type}/{style}/{huc}.png')
    .replace('{flavor}', flavor).replace('{type}', type).replace('{style}', PLOT_STYLE).replace('{huc}', huc);

  // ── Numbers for the text alternative and the table ──
  const fmtPtile = (v) => (v == null || Number.isNaN(v) ? '—' : `${ordinal(Math.round(v))} percentile`);

  function plotAlt(row, date) {
    const { name, huc, level } = currentBasin;
    const flavor = flavorName().toLowerCase();
    const head = currentPlot === 'swe'
      ? `Seasonal snow water equivalent for ${name} (HUC${level} ${huc}) through the snow year, drawn against the range of ${flavor}.`
      : `Snow water equivalent by 100-foot elevation band for ${name} (HUC${level} ${huc}), with each band's percentile and share of its median, against ${flavor}.`;
    const now = row && row.swe != null
      ? ` On ${MCO.formatDateStr(date)} the basin held ${fmtSwe(row.swe)}${row.ptile != null ? `, the ${fmtPtile(row.ptile)}` : ''}; the median for that date is ${fmtSwe(row.q50)}.`
      : ` There is no observation for ${MCO.formatDateStr(date)}.`;
    return `${head}${now} The numbers are in the data table below the plot.`;
  }

  function factsTable(caption, rows) {
    return h('table', {},
      h('caption', { className: 'sr-only', textContent: caption }),
      h('tbody', {}, ...rows.map(([k, v]) => h('tr', {},
        h('th', { scope: 'row', textContent: k }), h('td', { textContent: v })))));
  }

  // HypsomeSWE bands: one row per zone × 100-ft band in a ~6.8 MB file with a
  // single row group, so nothing can be skipped by zone. Reading only the
  // five columns the table shows, by HTTP range requests, is ~0.85 MB, and it
  // happens only when someone opens the table.
  const BAND_COLUMNS = ['zone', 'swe_elevation', 'swe', 'swe_ptile', 'q0500'];
  function loadBands(date, flavor) {
    return _cache.cached(`bands:${date}_${flavor}`, async () => {
      const pq = await parquetLib();
      const url = `${ZONAL_ROOT}/${flavor}/${date}/${date}_${flavor}_hypsomeswe_normals.parquet`;
      const file = await pq.asyncBufferFromUrl({ url });
      const rows = await pq.parquetReadObjects({
        file, columns: BAND_COLUMNS,
        compressors: { ZSTD: (input) => pq.zstdDecompress(input) },
      });
      const byZone = new Map();
      for (const r of rows) {
        const z = String(r.zone);
        if (!byZone.has(z)) byZone.set(z, []);
        byZone.get(z).push(r);
      }
      return byZone;
    });
  }

  async function renderBandTable(seq) {
    const { huc, name } = currentBasin;
    const date = currentDate, flavor = currentFlavor;
    basinTable.replaceChildren(h('p', { textContent: 'Loading the elevation bands…' }));
    let bands;
    try { bands = (await loadBands(date, flavor)).get(huc) || []; } catch (err) {
      console.error('[bands]', err);
      if (seq !== _basinSeq) return;
      basinTable.replaceChildren(h('p', { textContent: 'The elevation bands failed to load. Close and reopen this table to try again.' }));
      return;
    }
    if (seq !== _basinSeq) return;
    if (!bands.length) { basinTable.replaceChildren(h('p', { textContent: 'This basin has no elevation band data for this date.' })); return; }
    const num = (v) => (v == null || Number.isNaN(v) ? '—' : Math.round(v).toLocaleString('en-US'));
    const sorted = bands.slice().sort((a, b) => b.swe_elevation - a.swe_elevation);
    basinTable.replaceChildren(h('div', { className: 'band-scroll' }, h('table', {},
      h('caption', { className: 'sr-only', textContent: `Snow water equivalent by elevation band, ${name}, ${MCO.formatDateStr(date)}, ${flavorName(flavor).toLowerCase()}` }),
      h('thead', {}, h('tr', {}, ...['Elevation (ft)', 'SWE (mm)', 'Percentile', 'Median SWE (mm)']
        .map(t => h('th', { scope: 'col', textContent: t })))),
      h('tbody', {}, ...sorted.map(r => h('tr', {},
        h('th', { scope: 'row', textContent: `${num(r.swe_elevation)}–${num(r.swe_elevation + 100)}` }),
        h('td', { textContent: num(r.swe) }),
        h('td', { textContent: r.swe_ptile == null ? '—' : ordinal(Math.round(r.swe_ptile)) }),
        h('td', { textContent: num(r.q0500) })))))));
  }

  function renderDataTable(row, seq) {
    if (currentPlot === 'hypsomeswe') {
      if (basinData.open) renderBandTable(seq);
      else basinTable.replaceChildren(h('p', { textContent: 'Open this table to load the elevation bands.' }));
      return;
    }
    const { name } = currentBasin;
    basinTable.replaceChildren(factsTable(`${name}, ${MCO.formatDateStr(currentDate)}, ${flavorName().toLowerCase()}`, [
      ['Observed SWE', fmtSwe(row?.swe)],
      ['Percentile', row?.ptile == null ? '—' : ordinal(Math.round(row.ptile))],
      ['Median for this date', fmtSwe(row?.q50)],
      ['Normal range (10th–90th percentile)', row ? `${fmtSwe(row.q10)} to ${fmtSwe(row.q90)}` : '—'],
      ['Mean for this date', fmtSwe(row?.mean)],
    ]));
  }
  basinData.addEventListener('toggle', () => {
    if (basinData.open && currentBasin && currentPlot === 'hypsomeswe') renderBandTable(_basinSeq);
  });

  function showBasinEmpty(text, action) {
    basinImg.hidden = true;
    basinCaption.textContent = '';
    const kids = [h('p', { textContent: text })];
    // The button disappears with the message it answers, so its action says
    // where focus goes next — never left to fall to <body>.
    if (action) kids.push(h('button', { type: 'button', className: 'nav-btn', textContent: action.label,
      onclick: () => { action.focus?.focus(); action.onClick(); } }));
    basinEmpty.replaceChildren(...kids);
    basinEmpty.hidden = false;
    MCO.announce(text);
  }

  // Draw whatever the page's date and normals and the dialog's plot type
  // now name. Every await re-checks the sequence, so a fast stepper never
  // lands an old plot over a newer one.
  let _basinSeq = 0;
  async function renderBasin() {
    if (!currentBasin) return;
    const seq = ++_basinSeq;
    const { huc, name, level } = currentBasin;
    const date = currentDate, flavor = currentFlavor, type = currentPlot;
    syncBasinControls();
    basinTitle.textContent = name;
    basinSubtitle.textContent = `HUC${level} · ${huc}`;
    basinFrame.setAttribute('aria-busy', 'true');

    const [idx, zonal] = await Promise.all([plotIndex(date), loadZonal(date, flavor).catch(() => null)]);
    if (seq !== _basinSeq) return;
    const row = zonal?.get(huc) ?? null;
    renderDataTable(row, seq);

    if (!idx || (idx.flavors && !idx.flavors.includes(flavor))) {
      const near = await nearestPlotDate(date);
      if (seq !== _basinSeq) return;
      basinFrame.removeAttribute('aria-busy');
      showBasinEmpty(`Basin plots aren't available for ${MCO.formatDateStr(date)} yet.`,
        near && { label: `Show ${MCO.formatDateStr(near)}`, onClick: () => setDate(near), focus: basinDate });
      return;
    }

    const url = plotUrl(idx, date, flavor, type, huc);
    const ok = await loadImage(url);
    if (seq !== _basinSeq) return;
    basinFrame.removeAttribute('aria-busy');
    if (!ok) {
      // mco-snodas skips the HypsomeSWE plot for a basin with no snow now and
      // none in its normals; the other flavors may still have one.
      if (type === 'hypsomeswe') {
        showBasinEmpty(`No HypsomeSWE plot for ${name} on ${MCO.formatDateStr(date)}. The watershed has no snow on that date and none in its ${flavorName(flavor).toLowerCase()}.`,
          { label: 'Show the SWE plot', onClick: () => setPlotType('swe'), focus: basinPlotFs.querySelector('input[value="swe"]') });
      } else {
        showBasinEmpty(`The plot for ${name} failed to load.`, { label: 'Retry', onClick: renderBasin, focus: basinDate });
      }
      return;
    }
    basinEmpty.hidden = true;
    basinImg.alt = plotAlt(row, date);
    basinImg.src = url;
    basinImg.hidden = false;
    const years = idx.reference_water_years;
    // The full-size image in a new tab: on a phone the plot is a thumbnail.
    basinCaption.replaceChildren(`${PLOT_TYPES[type]} · ${MCO.formatDateStr(date)} · ${flavorName(flavor)}`
      + (Array.isArray(years) && years.length ? ` from snow years ${years[0]}–${years[years.length - 1]}` : '')
      + '. ', h('a', { href: url, target: '_blank', rel: 'noopener', textContent: 'Open the full-size plot' }), '.');

    // Warm the neighbours a visitor is likely to ask for next.
    for (const f of Object.keys(FLAVORS)) for (const t of Object.keys(PLOT_TYPES))
      if (f !== flavor || t !== type) loadImage(plotUrl(idx, date, f, t, huc));
  }

  // ── Share ─────────────────────────────────────────────────────────────────
  // Copy the current (deep-link) URL. The async Clipboard API where available,
  // an execCommand fallback, and always a toast, so the press has visible
  // feedback even when the clipboard is blocked (the photo explorer's).
  async function copyShareLink() {
    const url = location.href;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(url);
        showToast('Link copied to clipboard!');
        return;
      }
    } catch { /* fall through to the execCommand fallback */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      showToast(ok ? 'Link copied to clipboard!' : `Copy this link: ${url}`, ok ? undefined : 6000);
    } catch {
      showToast(`Copy this link: ${url}`, 6000);
    }
  }
  document.getElementById('btn-share').addEventListener('click', copyShareLink);

  // ── Export ────────────────────────────────────────────────────────────────
  // HOUSE-STYLE §1 Logo (kit 0.11.0): exports draw the WORDMARK from the
  // pinned kit tag, CORS-loaded (jsDelivr sends ACAO: *) so the canvas stays
  // exportable; img-src already allows cdn.jsdelivr.net. The fixed-color twin
  // is picked by the EXPORT's background, not the page theme.
  const KIT_ASSETS = 'https://cdn.jsdelivr.net/gh/mt-climate-office/mco-web-style@0.18.0/assets';
  const WORDMARK_ASPECT = 432 / 159;   // the SVGs' viewBox
  const _wordmarks = new Map();        // 'on-dark' | 'on-light' → Promise<Image|null>
  function loadWordmark(variant) {
    if (!_wordmarks.has(variant)) {
      _wordmarks.set(variant, new Promise(resolve => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload  = () => resolve(img);
        img.onerror = () => { _wordmarks.delete(variant); resolve(null); };
        img.src = `${KIT_ASSETS}/mco-wordmark-${variant}.svg`;
      }));
    }
    return _wordmarks.get(variant);
  }
  // Relative luminance (WCAG) of a computed color: '#rrggbb' or 'rgb(r, g, b)'.
  function luminance(color) {
    const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
    const rgb = m ? [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16))
                  : (color.match(/\d+(\.\d+)?/g) || [0, 0, 0]).slice(0, 3).map(Number);
    const [r, g, b] = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  async function exportMap() {
    showToast('Preparing export…');

    // map.loaded() covers raster tiles AND GeoJSON workers (setData is async);
    // areTilesLoaded() misses GeoJSON workers so we don't use it here.
    if (!map.loaded()) {
      await new Promise(r => map.once('idle', r));
    }
    // Fixed 1400×700 export at 2× — always 2800×1400 px regardless of viewport.
    const DPR     = 2;
    const px      = n => Math.round(n * DPR);
    const W       = px(1400);
    const TITLE_H = px(56);
    const FOOT_H  = px(80);
    const MAP_H   = px(700) - TITLE_H - FOOT_H;
    const PAD     = px(20);
    // Chrome colors and fonts from the live theme (MCO.chartTokens) instead
    // of hand-copied hexes. Bands are the surface tone; the rules are the
    // brand --accent (a fill, so allowed).
    const T = MCO.chartTokens();
    const C = {
      bg:     T.surface,
      text:   T.text,
      muted:  T.textMuted,
      accent: MCO.cssVar('--accent'),
    };
    const UI   = T.fontUi;
    const MONO = T.fontMono;

    // Resize the map container to the exact export dimensions so the captured
    // canvas matches without any stretching. Restore afterwards.
    const container   = map.getContainer();
    const savedWidth  = container.style.width;
    const savedHeight = container.style.height;
    const exportW_css = W   / DPR;          // 1400 CSS px
    const exportH_css = MAP_H / DPR;        // 564 CSS px
    container.style.visibility = 'hidden';
    container.style.width  = exportW_css + 'px';
    container.style.height = exportH_css + 'px';
    map.resize();

    // Wait for tiles that weren't in the original viewport to load and render.
    map.triggerRepaint();
    await new Promise(r => map.once('idle', r));

    const mapCanvas = map.getCanvas();

    const logoImg = await loadWordmark(luminance(C.bg) < 0.4 ? 'on-dark' : 'on-light');

    const canvas = document.createElement('canvas');
    canvas.width  = W;
    canvas.height = TITLE_H + MAP_H + FOOT_H;
    const ctx = canvas.getContext('2d');
    await document.fonts.ready;

    // ── Title band ──────────────────────────────────────────────────────────
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, TITLE_H);
    ctx.fillStyle = C.accent;
    ctx.fillRect(0, TITLE_H - px(2), W, px(2));

    // Wordmark 34 CSS px = 68 export px tall (minimum 40), centered in the
    // 112px band: 22px above and below and a 40px left pad, all over the
    // 15%-of-height clear space (≈10px); 24px before the title text.
    const logoH = px(34);
    const logoW = Math.round(logoH * WORDMARK_ASPECT);
    if (logoImg) ctx.drawImage(logoImg, PAD, (TITLE_H - logoH) / 2, logoW, logoH);
    const textX = PAD + (logoImg ? logoW + px(12) : 0);

    const viewLabel   = currentView === 'gridded' ? 'Gridded' : `Zonal · HUC${currentHucLevel}`;

    ctx.fillStyle = C.text;
    ctx.font = `600 ${px(14)}px ${UI}`;
    ctx.fillText('Snowpack Explorer', textX, TITLE_H * 0.42);

    ctx.fillStyle = C.muted;
    ctx.font = `400 ${px(10)}px ${UI}`;
    ctx.fillText(`${currentDate} · ${flavorName()} · ${viewLabel}`, textX, TITLE_H * 0.78);

    ctx.textAlign = 'right';
    ctx.font = `400 ${px(9)}px ${UI}`;
    ctx.fillText(MCO.credit(), W - PAD, TITLE_H * 0.55);
    ctx.textAlign = 'left';

    // ── Map ──────────────────────────────────────────────────────────────────
    ctx.drawImage(mapCanvas, 0, TITLE_H, W, MAP_H);

    // Restore map container with a camera-flash effect.
    container.style.width      = savedWidth;
    container.style.height     = savedHeight;
    container.style.visibility = '';
    map.resize();
    const flash = document.createElement('div');
    flash.style.cssText = 'position:absolute;inset:0;background:#fff;opacity:0.85;pointer-events:none;z-index:999;transition:opacity 0.5s ease-out;';
    container.appendChild(flash);
    requestAnimationFrame(() => requestAnimationFrame(() => { flash.style.opacity = '0'; }));
    flash.addEventListener('transitionend', () => flash.remove(), { once: true });

    // ── Footer ───────────────────────────────────────────────────────────────
    const footY = TITLE_H + MAP_H;
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, footY, W, FOOT_H);
    ctx.fillStyle = C.accent;
    ctx.fillRect(0, footY, W, px(2));

    const prov  = await fetchProvenance(currentDate);
    const midFY = footY + FOOT_H / 2;
    ctx.textBaseline = 'middle';

    // Left: title + method + date + ref period
    ctx.fillStyle = C.text;
    ctx.font = `600 ${px(9)}px ${UI}`;
    ctx.fillText(`SWE PERCENTILE · ${flavorName().toUpperCase()}`, PAD, midFY - px(14));
    if (prov) {
      ctx.fillStyle = C.muted;
      ctx.font = `400 ${px(7.5)}px ${MONO}`;
      ctx.fillText(MCO.formatDateStr(prov.normals_date), PAD, midFY);
      ctx.fillText(refRange(prov), PAD, midFY + px(14));
    }

    // Right: attribution
    ctx.textAlign = 'right';
    ctx.fillStyle = C.muted;
    ctx.font = `400 ${px(8)}px ${UI}`;
    ctx.fillText(MCO.credit({ source: 'NOAA SNODAS' }), W - PAD, midFY);
    ctx.textAlign = 'left';

    // Center: horizontal swatch legend — same style as sidebar, wide format
    const swW   = px(14);
    const swH   = px(12);
    const swRad = px(3);
    const swGap = px(5);  // swatch → label
    const iGap  = px(10); // label → next swatch

    ctx.font = `400 ${px(8)}px ${UI}`;
    const legItems = BREAKS.map((lo, i) => {
      const hi  = i + 1 < BREAKS.length ? BREAKS[i + 1] : null;
      const lbl = lo === 0 ? `< ${hi}` : hi === null ? `≥ ${lo}` : `${lo}–${hi}`;
      return { color: COLORS[i], lbl, lw: ctx.measureText(lbl).width };
    });
    const legW = legItems.reduce((s, { lw }) => s + swW + swGap + lw, 0)
               + (legItems.length - 1) * iGap;

    let lx = Math.round((W - legW) / 2);
    const swY = footY + (FOOT_H - swH) / 2;
    for (const { color, lbl, lw } of legItems) {
      ctx.fillStyle = `rgb(${color})`;
      ctx.beginPath();
      ctx.roundRect(lx, swY, swW, swH, swRad);
      ctx.fill();
      ctx.fillStyle = C.text;
      ctx.fillText(lbl, lx + swW + swGap, swY + swH / 2);
      lx += swW + swGap + lw + iGap;
    }
    ctx.textBaseline = 'alphabetic';

    // ── Download ────────────────────────────────────────────────────────────
    canvas.toBlob(blob => {
      const a = document.createElement('a');
      a.href     = URL.createObjectURL(blob);
      a.download = `snodas-swe-ptile-${currentDate}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
      showToast('Exported!');
    });
  }

  // ── Nav rail (kit 0.10.0) ─────────────────────────────────────────────────
  // Landscape phones: the bar becomes a left rail; its menu button opens the
  // drawer with the controls (focus in, page inert, Esc / scrim back to it).
  // Export closes the drawer first, because the map has to be visible for it.
  // The info button leaves it open: the dialog wins Esc and returns focus
  // inside the drawer (HOUSE-STYLE §3 Short landscape).
  const rail = MCO.initNavRail({
    toggle: document.getElementById('btn-rail-menu'),
    drawer: document.getElementById('nav-drawer'),
    scrim:  document.getElementById('rail-scrim'),
  });
  document.getElementById('btn-export').addEventListener('click', () => {
    rail.close({ restoreFocus: false });
    exportMap();
  });

  // ── Info modal ────────────────────────────────────────────────────────────
  const infoModal = document.getElementById('info-modal');
  MCO.initInfoModal({ dialog: infoModal, trigger: document.getElementById('btn-info') });
  document.getElementById('info-credit').textContent = MCO.credit({ source: 'NOAA SNODAS' });
  // Dates that move are read from the code's own constants, never typed into copy.
  for (const el of document.querySelectorAll('[data-fill="earliest-date"]')) el.textContent = MCO.formatDateStr(SNODAS_START);

  // First-visit auto-open, once. Not over a deep link (someone following a
  // shared view shouldn't land behind a help dialog), not in an export run,
  // not over another dialog, and never once the visitor has started using
  // the page — focus has left <body> (WCAG 3.2.1). The seen flag is written
  // at open time, so an unclosed dialog still counts.
  const DEEP_LINK_PARAMS = ['date', 'view', 'huc', 'flavor', 'basin', 'lng', 'export'];
  const hasDeepLink = DEEP_LINK_PARAMS.some(k => urlParams.has(k));
  const seenIntro = MCO.lsGet(LS_INFO_SEEN) === '1' || MCO.lsGet(LS_INFO_SEEN_OLD) === '1';
  if (!seenIntro && !hasDeepLink) {
    setTimeout(() => {
      const idle = !document.activeElement || document.activeElement === document.body;
      if (idle && !document.querySelector('dialog[open]')) {
        infoModal.showModal();
        MCO.lsSet(LS_INFO_SEEN, '1');
      }
    }, 350);
  }

  // ── Provenance modal ──────────────────────────────────────────────────────
  const provenanceModal = document.getElementById('provenance-modal');
  const provenanceCtl = MCO.initInfoModal({ dialog: provenanceModal });

  // Method detail lives here, not in the info dialog (VOICE: plain words
  // first, method last). From the normals README published beside the data.
  const FLAVOR_DESC = {
    zig_smooth: 'A zero-adjusted gamma distribution whose parameters change smoothly through the snow year (cyclic P-splines), fit to every day of the reference record at once. Neighbouring days share information, so the normal for one date does not jump around from the next.',
    zig:        'A zero-inflated gamma distribution fit separately for each calendar day by L-moments, which smooths over sparse records and can extrapolate beyond observed extremes. Pixels with fewer than four snowy reference years fall back to the empirical distribution.',
    ecdf:       'The empirical distribution of the reference years for that calendar day, with no fitted curve. This year is ranked directly against them, so it cannot be ranked beyond the highest or lowest year in the record.',
  };
  const ZERO_NOTE = 'All three count bare ground separately. Zero SWE sits at the middle of the share of reference years that were also bare, so a place that is always bare on that date reads 50.';
  const NORMALS_DOC = `${DATA_HOST}/snodas/normals/README.md`;   // mco-snodas s3-docs, published with the data
  const WBD_URL    = 'https://www.usgs.gov/national-hydrography/watershed-boundary-dataset';
  const SNODAS_URL = 'https://nsidc.org/data/g02158';

  const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener', textContent: text });
  const section = (title, ...body) => h('div', { className: 'info-section' }, h('h3', { textContent: title }), ...body);

  function showProvenance(prov) {
    if (!prov) { showToast('Details for this date are not available yet.'); return; }
    const methodLabel = FLAVORS[prov.flavor] ? flavorName(prov.flavor) : prov.flavor;
    document.getElementById('provenance-modal-subtitle').textContent =
      `${MCO.formatDateStr(prov.normals_date)} · ${methodLabel}`;

    const computedAt = new Date(prov.computed_at).toLocaleString('en-US', {
      timeZone: MCO.TZ, month: 'long', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    });
    const hucText = currentView === 'zonal'
      ? `, aggregated to HUC${currentHucLevel}.`
      : ', available at HUC levels 2, 4, 6, and 8.';

    document.getElementById('provenance-content').replaceChildren(
      section('Gridded data', h('p', {},
        link(SNODAS_URL, 'NOAA SNODAS'),
        ' (Snow Data Assimilation System) estimates snow water equivalent once a day on a 1 km grid across the contiguous United States. Its record starts in late 2003.')),
      section('Zonal data', h('p', {},
        'Watershed boundaries are from the ', link(WBD_URL, 'USGS Watershed Boundary Dataset'), ` (WBD)${hucText}`)),
      section(methodLabel, h('p', { textContent: FLAVOR_DESC[prov.flavor] || '' }), h('p', { textContent: ZERO_NOTE }),
        h('p', {}, 'The full method: ', link(NORMALS_DOC, 'SWE normals and percentiles'), '.')),
      section('Reference period', h('p', { textContent: `${prov.n_reference_years} SNODAS dates spanning ${refRange(prov)}.` })),
      section('Reference dates', h('ul', { className: 'provenance-dates' },
        ...prov.reference_dates.map(d => h('li', { textContent: MCO.formatDateStr(d) })))),
      section('Computed', h('p', { textContent: computedAt })),
    );

    provenanceCtl.open();
  }

  document.getElementById('legend-info-btn').addEventListener('click', () => {
    fetchProvenance(currentDate).then(showProvenance);
  });

  updateRail();

})().catch(e => console.error('[init]', e));
