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

  // The basin dialog's state: which watershed is open (null when closed),
  // which of its two plots shows, and which snow year's animation plays in
  // its place (null for the plot). ?basin= opens it on load; ?plot= and
  // ?anim= are only written while it is open.
  const PLOT_TYPES   = { swe: 'SWE', hypsomeswe: 'HypsomeSWE' };
  const DEFAULT_PLOT = 'swe';
  const isHuc = (s) => /^\d+$/.test(s || '') && HUC_LEVELS.includes(String(s).length);
  let currentBasin = null;   // { huc, name, level }
  let _selectedHuc = null;   // the open basin's outline on the map
  let _focusedHuc  = null;   // the table twin's keyboard focus, shown on the map
  let currentPlot  = PLOT_TYPES[getLower('plot')] ? getLower('plot') : DEFAULT_PLOT;
  const askedBasin = isHuc(urlParams.get('basin')) ? urlParams.get('basin') : null;
  const isSnowYear = (s) => /^\d{4}$/.test(s || '');
  let currentAnim  = askedBasin && isSnowYear(urlParams.get('anim')) ? +urlParams.get('anim') : null;
  if (currentAnim) currentPlot = 'hypsomeswe';

  // SNOTEL stations: ?snotel=on shows them over either view, and
  // ?station=<id> (the triplet with _ for :, as in 901_MT_SNTL) opens one
  // station's dialog, which turns them on. A basin link wins over a station.
  const isStationId = (s) => /^\d+_[A-Z]{2}_SNTL$/.test(s || '');
  const askedStation = !askedBasin && isStationId(urlParams.get('station')) ? urlParams.get('station') : null;
  let snotelOn = getLower('snotel') === 'on' || !!askedStation;
  let currentStation = null;   // the open station's row from stations.parquet

  // ?kbd=off turns off the single-character shortcut (/ for search), the
  // opt-out WCAG 2.1.4 asks for. Carried in every URL write.
  const kbdShortcuts = getLower('kbd') !== 'off';

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
      if (currentAnim) params.anim = currentAnim;
    }
    if (snotelOn) params.snotel = 'on';
    if (currentStation) params.station = currentStation.id;
    const theme = MCO.getTheme();
    if (theme !== MCO.osTheme()) params.theme = theme;
    if (!kbdShortcuts) params.kbd = 'off';
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
  // The domain outline's entry: a dashed swatch matching the map line.
  const domainSwatch = h('span', { className: 'mco-legend-swatch' });
  domainSwatch.dataset.shape = 'dash';
  domainSwatch.setAttribute('aria-hidden', 'true');
  domainSwatch.style.setProperty('--swatch', 'var(--text-secondary)');
  const domainLegendRow = h('div', { className: 'legend-row legend-domain', hidden: currentView !== 'gridded' },
    domainSwatch, h('span', { className: 'legend-lbl' }, h('span', { className: 'legend-cat', textContent: 'Edge of SNODAS data' })));
  legendRowsEl.after(domainLegendRow);

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
  const EMPTY_FC = { type: 'FeatureCollection', features: [] };
  let _searchHit = EMPTY_FC;   // the search highlight, kept across style swaps
  let _skiData = EMPTY_FC;     // the ski runs and lifts loaded so far, likewise
  let _skiNames = EMPTY_FC;    // a point per named ski area, for its label
  let _snotelData = EMPTY_FC;  // the SNOTEL stations with the date's percentiles

  // Ski runs and lifts draw from SKI_MIN_ZOOM, where a resort is a few
  // hundred pixels across; their difficulty signs from SKI_SIGN_ZOOM. The
  // colours are the North American trail signs', fixed in every theme as the
  // signs are, each line on a white casing so it holds over the raster, the
  // fills and either basemap (all ≥ 4.5:1 against white, WCAG 1.4.11).
  const SKI_MIN_ZOOM  = 11;
  const SKI_SIGN_ZOOM = 13;
  const SKI_SIGN_PX   = 14;
  const SKI_COLORS = { e: '#1e7b34', i: '#1d5fb8', a: '#111111', x: '#111111', u: '#5f5f5f' };
  const SKI_LIFT   = '#9b1c1c';
  const SKI_NAME_LIKE = 'place_villages';   // the CARTO label layer ski area names copy
  const SKI_NAME_SCALE = 1.25;               // …at this size
  const SKI_CREDIT = '<a href="https://openskimap.org" target="_blank" rel="noopener">OpenSkiMap</a>';

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

    // The edge of the SNODAS grid (data/snodas-domain.geojson, traced from the
    // grid's own NoData mask by scripts/build-domain.sh), outlined in the
    // gridded view so a blank area outside it doesn't read as "no snow".
    // Above the raster, below the basemap labels, dashed in --text-secondary:
    // a text token, so it clears the 3:1 a boundary needs (WCAG 1.4.11) on
    // the theme's surfaces, which the basemaps' land is close to (contrast
    // not measured against the tiles themselves). Read at paint time and
    // re-read on every style.load.
    if (!map.getSource('domain')) map.addSource('domain', { type: 'geojson', data: 'data/snodas-domain.geojson' });
    if (!map.getLayer('domain-line')) {
      map.addLayer({
        id: 'domain-line', type: 'line', source: 'domain',
        paint: { 'line-color': MCO.cssVar('--text-secondary'), 'line-width': 1.5, 'line-dasharray': [3, 2] },
      }, before);
    }

    // Ski runs and lifts (data/ski/, OpenSkiMap, by scripts/build-ski.sh),
    // in both views, loaded area by area as the map comes near them
    // (updateSki). Colour is never the only cue (WCAG 1.4.1): runs carry
    // their sign's shape and lifts are dashed. Not interactive.
    addSkiSigns();
    if (!map.getSource('ski')) map.addSource('ski', { type: 'geojson', data: _skiData, attribution: SKI_CREDIT });
    if (!map.getLayer('ski-casing')) {
      map.addLayer({
        id: 'ski-casing', type: 'line', source: 'ski', minzoom: SKI_MIN_ZOOM,
        filter: ['!', ['has', 'o']],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 4.5, 'line-opacity': 0.9 },
      }, before);
    }
    if (!map.getLayer('ski-run')) {
      map.addLayer({
        id: 'ski-run', type: 'line', source: 'ski', minzoom: SKI_MIN_ZOOM,
        filter: ['has', 'd'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['match', ['get', 'd'], 'e', SKI_COLORS.e, 'i', SKI_COLORS.i, 'a', SKI_COLORS.a, 'x', SKI_COLORS.x, SKI_COLORS.u],
          'line-width': 2,
        },
      }, before);
    }
    if (!map.getLayer('ski-lift')) {
      map.addLayer({
        id: 'ski-lift', type: 'line', source: 'ski', minzoom: SKI_MIN_ZOOM,
        filter: ['has', 'l'],
        paint: { 'line-color': SKI_LIFT, 'line-width': 2, 'line-dasharray': [2, 1] },
      }, before);
    }
    if (!map.getLayer('ski-sign')) {
      map.addLayer({
        id: 'ski-sign', type: 'symbol', source: 'ski', minzoom: SKI_SIGN_ZOOM,
        filter: ['all', ['has', 'd'], ['!=', ['get', 'd'], 'u']],
        layout: {
          'symbol-placement': 'line', 'symbol-spacing': 180,
          'icon-image': ['concat', 'ski-', ['get', 'd']],
          'icon-rotation-alignment': 'viewport', 'icon-padding': 2,
        },
      }, before);
    }
    // Each named area's name just below its lower edge, from SKI_MIN_ZOOM,
    // set as the basemap sets a village's but SKI_NAME_SCALE larger (its
    // layout and paint are copied from that layer, so it follows the theme)
    // and placed with the basemap's labels.
    if (!map.getSource('ski-names')) map.addSource('ski-names', { type: 'geojson', data: _skiNames });
    if (!map.getLayer('ski-name')) {
      const ref = map.getStyle().layers.find(l => l.id === SKI_NAME_LIKE);
      const pick = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => k.startsWith('text-') && k !== 'text-field'));
      // CARTO sizes it with legacy zoom stops; a plain number is scaled too.
      const size = ref?.layout?.['text-size'] ?? 10;
      const scaled = typeof size === 'number' ? size * SKI_NAME_SCALE
        : size.stops ? { ...size, stops: size.stops.map(([z, v]) => [z, v * SKI_NAME_SCALE]) } : size;
      map.addLayer({
        id: 'ski-name', type: 'symbol', source: 'ski-names', minzoom: SKI_MIN_ZOOM,
        layout: { ...pick(ref?.layout), 'text-field': ['get', 'name'], 'text-size': scaled,
                  'text-anchor': 'top', 'text-offset': [0, 0.4] },
        paint: pick(ref?.paint),
      });
    }

    // SNOTEL stations, coloured by the date's percentile in the map's own
    // ramp, over either view while they are on (updateSnotel fills them).
    // Each is ringed in #222 inside a white ring, so a station holds against
    // a fill of its own colour. One with no percentile is a smaller grey dot:
    // size, not colour alone, says "no reading" (a hollow ring read as the
    // white near-normal class over white ground). The open station gets
    // --selection-ring and the table twin's keyboard focus --accent-line, as
    // watersheds do. Colours read at paint time.
    if (!map.getSource('snotel')) map.addSource('snotel', { type: 'geojson', data: _snotelData, attribution: SNOTEL_CREDIT });
    const noRead = ['==', ['get', 'ptile'], null];
    const grow = (d) => ['interpolate', ['linear'], ['zoom'], ...SNOTEL_RADIUS.flatMap(([z, v]) =>
      [z, ['case', noRead, v * SNOTEL_NOREAD_SCALE + d, v + d]])];
    if (!map.getLayer('snotel-halo')) {
      map.addLayer({
        id: 'snotel-halo', type: 'circle', source: 'snotel', layout: { visibility: 'none' },
        paint: { 'circle-radius': grow(1.5), 'circle-color': 'rgba(0,0,0,0)',
                 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2, 'circle-stroke-opacity': 0.9 },
      }, before);
    }
    if (!map.getLayer('snotel')) {
      map.addLayer({
        id: 'snotel', type: 'circle', source: 'snotel', layout: { visibility: 'none' },
        paint: {
          'circle-radius': grow(0),
          'circle-color': ['case', noRead, SNOTEL_NOREAD,
            ['step', ['get', 'ptile'], `rgb(${COLORS[0]})`, ...HUC_COLOR_STOPS]],
          'circle-stroke-color': '#222222', 'circle-stroke-width': 1.5,
        },
      }, before);
    }
    if (!map.getLayer('snotel-focus')) {
      map.addLayer({
        id: 'snotel-focus', type: 'circle', source: 'snotel', layout: { visibility: 'none' },
        filter: ['==', ['get', 'id'], _focusedStation ?? ''],
        paint: { 'circle-radius': grow(5), 'circle-color': 'rgba(0,0,0,0)',
                 'circle-stroke-color': MCO.cssVar('--accent-line'), 'circle-stroke-width': 2 },
      }, before);
    }
    if (!map.getLayer('snotel-selected')) {
      map.addLayer({
        id: 'snotel-selected', type: 'circle', source: 'snotel', layout: { visibility: 'none' },
        filter: ['==', ['get', 'id'], currentStation?.id ?? ''],
        paint: { 'circle-radius': grow(5), 'circle-color': 'rgba(0,0,0,0)',
                 'circle-stroke-color': MCO.cssVar('--selection-ring'), 'circle-stroke-width': 3 },
      }, before);
    }
    setSnotelVisible(snotelOn);

    // What search last went to, in both views: a watershed's outline
    // (--selection-ring, as the open basin's) or a city or ZIP code's point
    // (--accent, ringed in --bg-surface so it holds on any fill). Neither is
    // interactive. Colours read at paint time, re-read on every style.load.
    if (!map.getSource('search-hit')) map.addSource('search-hit', { type: 'geojson', data: _searchHit });
    if (!map.getLayer('search-hit-line')) {
      map.addLayer({
        id: 'search-hit-line', type: 'line', source: 'search-hit',
        filter: ['!=', ['geometry-type'], 'Point'],
        paint: { 'line-color': MCO.cssVar('--selection-ring'), 'line-width': 3 },
      }, before);
    }
    if (!map.getLayer('search-hit-pin')) {
      map.addLayer({
        id: 'search-hit-pin', type: 'circle', source: 'search-hit',
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': 6, 'circle-color': MCO.cssVar('--accent'),
          'circle-stroke-width': 2, 'circle-stroke-color': MCO.cssVar('--bg-surface'),
        },
      }, before);   // under the basemap labels, so the town's name stays legible
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

    // The basemap's lakes and rivers sit under its land in the style, so the
    // raster and the HUC fills would bury them. Lift them over the data and
    // the hillshade, under every outline, as on the mesonet explorer's map.
    // Both CARTO styles name them so; the kit's blank fallback has neither.
    for (const id of ['water', 'waterway']) {
      if (map.getLayer(id)) map.moveLayer(id, 'huc-line');
    }

    // Restore visibility for current view
    setGriddedVisible(currentView === 'gridded');
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
    map.on('moveend', updateSki);
    updateSki();
    map.on('moveend', renderStationTwin);
    updateSnotel();

    // First meaningful state: the first data layer has drawn. Releases the
    // kit's html.mco-booting first-paint hold; the anti-flash snippet's 3 s
    // timeout releases it anyway if this never resolves.
    _initReady.then(() => MCO.ready(), () => MCO.ready());

    // URL-triggered export: fire only after the data layer is ready
    if (exportOnLoad) _initReady.then(exportMap);

    // ?basin= opens its dialog in place: the entry already names it, so this
    // replaces rather than pushes.
    if (askedBasin && !exportOnLoad) openBasin(askedBasin, { push: false });
    if (askedStation && !exportOnLoad) openStation(askedStation, { push: false });
  });

  // The gridded view's layers — the raster and the domain outline — and the
  // outline's legend entry, which only means something beside the raster.
  function setGriddedVisible(on) {
    const vis = on ? 'visible' : 'none';
    map.setLayoutProperty('swe', 'visibility', vis);
    map.setLayoutProperty('domain-line', 'visibility', vis);
    domainLegendRow.hidden = !on;
  }

  // Update the COG raster tiles to a new date (no-op if source not yet added).
  function setSweLayer(d) {
    map.getSource('swe')?.setTiles([`cog://ptile/${cogUrl(d)}/{z}/{x}/{y}`]);
  }

  // Refresh whichever layers are active for the current date.
  function refreshLayers() {
    if (!_layersAdded) return;
    setSweLayer(currentDate);
    if (currentView === 'zonal') setHucLayer();
    updateSnotel();
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
    if (d === currentDate) { dateInput.value = d; basinDate.value = d; stationDate.value = d; return; }

    loading.start();
    if (!(await cogExists(d))) {
      const fallback = await findLatestAvailable(d);
      if (!fallback || fallback === currentDate) {
        loading.done();
        showToast(`No SNODAS data was found near ${MCO.formatDateStr(d)}.`, 5000);
        dateInput.value = currentDate;
        basinDate.value = currentDate;
        stationDate.value = currentDate;
        return;
      }
      d = fallback;
      showToast(`Showing the latest available date, ${MCO.formatDateStr(d)}.`, 5000);
    }
    loading.done();

    currentDate = d;
    currentAnim = null;   // the animation has no date; picking one asks for its plot
    dateInput.value = currentDate;
    if (!silent) writeUrl();
    CogProtocol.preload(cogUrl(currentDate));
    refreshLayers();
    fetchProvenance(currentDate).then(updateLegendMeta);
    refreshSteppers();
    renderBasin();
    renderStation();
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
      setGriddedVisible(false);
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
  // Radio fieldsets with <select> twins, one source of truth each:
  // MCO.initSegmentedFallback. The twins take over below 1760px, not the
  // ladder's 1400: the zonal view's bar (search, date, three groups and the
  // SNOTEL toggle, labels still shown above 1400) needs about 1,720px as
  // buttons, and wrapped to a second row between 1400 and that.
  const hucGroup = document.getElementById('huc-group');
  const SEG_MQ = '(max-width: 1760px)';
  const viewCtl = MCO.initSegmentedFallback({
    group: document.getElementById('view-btns'),
    select: document.getElementById('view-select'),
    mq: SEG_MQ,
    onChange: (v) => setView(v),
  });
  const hucCtl = MCO.initSegmentedFallback({
    group: document.getElementById('huc-btns'),
    select: document.getElementById('huc-select'),
    mq: SEG_MQ,
    onChange: (v) => setHucLevel(parseInt(v, 10)),
  });
  const flavorCtl = MCO.initSegmentedFallback({
    group: document.getElementById('flavor-btns'),
    select: document.getElementById('flavor-select'),
    mq: SEG_MQ,
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
    renderStation();
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
      setGriddedVisible(true);
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
    if (stationModal.open && !isStationId(params.get('station'))) {
      _closingFromHistory = true;
      currentStation = null;
      stationModal.close();
      MCO.announce('Station closed');
      writeUrl();
      return;
    }
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
    const a = params.get('anim');
    setAnim(isSnowYear(a) ? +a : null, { silent: true });
    const station = params.get('station');
    setSnotel(params.get('snotel') === 'on' || isStationId(station), { silent: true });
    const basin = params.get('basin');
    if (isHuc(basin) && (!basinModal.open || currentBasin?.huc !== basin)) openBasin(basin, { push: false });
    else if (isStationId(station) && (!stationModal.open || currentStation?.id !== station)) openStation(station, { push: false });
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
    const st = stationAt(e.point);
    map.getCanvas().style.cursor = st ? 'pointer' : '';
    if (st) { showTooltip(stationReading(st), e); return; }
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
    const st = stationAt(e.point);
    if (st) { openStation(st.id); return; }
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
  const basinAnimGrp  = document.getElementById('basin-anim-group');
  const basinSy       = document.getElementById('basin-sy');
  const basinAnimBtn  = document.getElementById('btn-basin-anim');
  const basinVideo    = document.getElementById('basin-video');
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
    syncAnimControls();
  }

  // A plot type is a plot, so choosing one (SWE is the only change the
  // radios can make while the HypsomeSWE animation shows) ends the animation.
  function setPlotType(t, { silent = false } = {}) {
    if (!PLOT_TYPES[t] || t === currentPlot) return;
    currentPlot = t;
    currentAnim = null;
    checkRadio(basinPlotFs, t);
    syncAnimControls();
    if (!currentBasin) return;
    if (!silent) { writeUrl(); MCO.announce(`${PLOT_TYPES[t]} plot`); }
    renderBasin();
  }

  // ── Snow-year animations ──
  // Every day's HypsomeSWE plot for one snow year (1 September – 31 August,
  // named for the year it ends) as one MP4 per flavor and HUC, which
  // mco-snodas publishes at animations/sy{year}/{flavor}/hypsomeswe/usdm/
  // {huc}.mp4. Which years exist comes from one listing of animations/; the
  // control appears once it has, and starts on the newest snow year that
  // has ended by the latest date with data. The year runs in the select only
  // when there is more than one to choose.
  const ANIM_ROOT = `${DATA_HOST}/snodas/animations`;
  const animUrl = (sy, flavor, huc) => `${ANIM_ROOT}/sy${sy}/${flavor}/hypsomeswe/${PLOT_STYLE}/${huc}.mp4`;
  const snowYearSpan = (sy) => `${MCO.formatDateStr(`${sy - 1}-09-01`)} – ${MCO.formatDateStr(`${sy}-08-31`)}`;
  function animYears() {
    return _cache.cached('anim:years', async () => {
      const years = (await s3Prefixes('animations/'))
        .map(p => /^animations\/sy(\d{4})\/$/.exec(p)?.[1]).filter(Boolean).map(Number);
      return years.sort((a, b) => a - b);
    }).catch(() => []);
  }
  animYears().then((years) => {
    if (!years.length) return;
    const ended = years.filter(y => `${y}-08-31` <= latestDate);
    const dflt = ended.length ? ended[ended.length - 1] : years[years.length - 1];
    basinSy.replaceChildren(...years.slice().reverse().map(y => h('option', { value: String(y), textContent: String(y) })));
    basinSy.value = String(currentAnim && years.includes(currentAnim) ? currentAnim : dflt);
    basinSy.hidden = years.length < 2;
    basinAnimGrp.hidden = false;
    syncAnimControls();
  });
  function syncAnimControls() {
    if (currentAnim && basinSy.querySelector(`option[value="${currentAnim}"]`)) basinSy.value = String(currentAnim);
    basinAnimBtn.textContent = basinSy.hidden ? `Animate snow year ${basinSy.value}` : 'Animate snow year';
    basinAnimBtn.setAttribute('aria-pressed', String(!!currentAnim));
  }
  basinAnimBtn.addEventListener('click', () => setAnim(currentAnim ? null : +basinSy.value));
  // Choosing a year switches a running animation; otherwise it waits for the button.
  basinSy.addEventListener('change', () => { if (currentAnim) setAnim(+basinSy.value); else syncAnimControls(); });

  // The animations are HypsomeSWE only, so one starting moves the Plot
  // radios there; null goes back to the plot for the page's date.
  function setAnim(sy, { silent = false } = {}) {
    if (sy === currentAnim) return;
    currentAnim = sy;
    if (sy) currentPlot = 'hypsomeswe';
    syncBasinControls();
    if (!currentBasin) return;
    if (!silent) {
      writeUrl();
      MCO.announce(sy ? `Snow year ${sy} animation` : `${PLOT_TYPES[currentPlot]} plot`);
    }
    renderBasin();
  }

  function stopVideo() {
    if (basinVideo.hidden && !basinVideo.getAttribute('src')) return;
    basinVideo.pause();
    basinVideo.removeAttribute('src');
    basinVideo.load();   // drops the old stream rather than leaving it buffered
    basinVideo.hidden = true;
    basinFrames.hidden = true;
    _shownFrame = -1;
  }

  // ── Stepping the animation a day at a time ──
  // Frame i is day i of the snow year (1 September first), at 12 frames a
  // second (animations/README.md). A step pauses and seeks to the middle of
  // its frame, clear of the rounding at either edge.
  const ANIM_FPS = 12;
  const basinFrames    = document.getElementById('basin-frames');
  const basinFrameDate = document.getElementById('basin-frame-date');
  let _shownFrame = -1;
  const frameCount = () => (Number.isFinite(basinVideo.duration) ? Math.round(basinVideo.duration * ANIM_FPS) : 0);
  const frameAt    = () => Math.min(frameCount() - 1, Math.floor(basinVideo.currentTime * ANIM_FPS));
  const frameDate  = (i) => MCO.shiftDate(`${currentAnim - 1}-09-01`, i);
  const canStepFrame = (d) => {
    if (!currentAnim || basinVideo.hidden || !frameCount()) return false;
    const i = frameAt();
    return d < 0 ? i > 0 : i < frameCount() - 1;
  };
  function showFrame() {
    if (!currentAnim || !frameCount()) return;
    const i = frameAt();
    if (i === _shownFrame) return;
    _shownFrame = i;
    basinFrameDate.textContent = `${MCO.formatDateStr(frameDate(i))} · day ${i + 1} of ${frameCount()}`;
    frameStepper.refresh();
  }
  function stepFrame(d) {
    const i = frameAt() + d;
    basinVideo.pause();
    basinVideo.currentTime = (i + 0.5) / ANIM_FPS;
    showFrame();
    MCO.announce(MCO.formatDateStr(frameDate(i)));
  }
  const frameStepper = MCO.initStepper({
    prev: document.getElementById('btn-frame-prev'), next: document.getElementById('btn-frame-next'),
    onStep: stepFrame, canStep: canStepFrame,
  });
  // timeupdate fires only a few times a second; where the browser can say
  // when each frame is painted, the date follows every one during playback.
  const onVideoFrame = () => { showFrame(); if (!basinVideo.paused) basinVideo.requestVideoFrameCallback?.(onVideoFrame); };
  basinVideo.addEventListener('play', () => basinVideo.requestVideoFrameCallback?.(onVideoFrame));
  for (const ev of ['loadedmetadata', 'timeupdate', 'seeked', 'pause']) basinVideo.addEventListener(ev, showFrame);
  // ← / → step a day from anywhere in the dialog but a field or radio,
  // whose arrows are their own. Capture, so the native controls of a
  // focused <video> don't also seek it by seconds.
  basinModal.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || basinVideo.hidden) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    e.preventDefault();
    e.stopPropagation();
    const d = e.key === 'ArrowLeft' ? -1 : 1;
    if (canStepFrame(d)) { stepFrame(d); frameStepper.refresh(); }
  }, true);

  // Whether an animation exists, asked with a HEAD: a <video> reports a 404
  // and a codec it can't decode as the same error, and the two need
  // different messages.
  function animExists(url) {
    return _cache.cached(`anim:${url}`, async () => (await fetch(url, { method: 'HEAD' })).ok).catch(() => false);
  }

  // Resolves true once the first frame has decoded, false on an error.
  function loadVideo(url) {
    return new Promise((resolve) => {
      const done = (ok) => {
        basinVideo.removeEventListener('loadeddata', onOk);
        basinVideo.removeEventListener('error', onErr);
        resolve(ok);
      };
      const onOk = () => done(true), onErr = () => done(false);
      basinVideo.addEventListener('loadeddata', onOk);
      basinVideo.addEventListener('error', onErr);
      basinVideo.preload = 'auto';
      basinVideo.src = url;
    });
  }

  async function renderAnim(seq) {
    const { huc, name, level } = currentBasin;
    const sy = currentAnim, flavor = currentFlavor;
    const url = animUrl(sy, flavor, huc);
    // The animation's frames are the daily plots, so their data tables are
    // its text alternative, one date at a time.
    basinTable.replaceChildren(h('p', { textContent:
      `The animation shows the HypsomeSWE plot for each day of snow year ${sy}, one day per frame. `
      + 'Step through it a day at a time with the buttons under it or the left and right arrow keys. '
      + 'For the numbers behind any day, choose that date: its plot has a table of every elevation band.' }));

    if (!(await animExists(url))) {
      if (seq !== _basinSeq) return;
      basinFrame.removeAttribute('aria-busy');
      showBasinEmpty(`There's no snow year ${sy} animation for ${name} against ${flavorName(flavor).toLowerCase()}.`,
        { label: 'Show the SWE plot', onClick: () => setPlotType('swe'), focus: basinPlotFs.querySelector('input[value="swe"]') });
      return;
    }
    if (seq !== _basinSeq) return;
    if (basinVideo.getAttribute('src') !== url) {
      const ok = await loadVideo(url);
      if (seq !== _basinSeq) return;
      if (!ok) {
        basinFrame.removeAttribute('aria-busy');
        // The files are H.265 (HEVC): Safari plays them, Chrome and Edge on
        // most hardware, Firefox mostly not. The download still works.
        showBasinEmpty(`This browser can't play the snow year ${sy} animation for ${name}. Download it to watch it in a video player.`,
          { label: 'Show the plot', onClick: () => setAnim(null), focus: basinAnimBtn });
        basinCaption.replaceChildren(h('a', { href: url, download: '', textContent: 'Download the animation (MP4)' }), '.');
        return;
      }
    }
    basinFrame.removeAttribute('aria-busy');
    basinImg.hidden = true;
    basinEmpty.hidden = true;
    basinVideo.setAttribute('aria-label', `Animation of the daily HypsomeSWE plots for ${name} (HUC${level} ${huc}) through snow year ${sy}, against ${flavorName(flavor).toLowerCase()}.`);
    basinVideo.hidden = false;
    basinFrames.hidden = false;
    _shownFrame = -1;
    showFrame();
    // Started by the visitor's own press, and never under reduced motion;
    // the native controls pause it either way (WCAG 2.2.2).
    if (!MCO.reducedMotion() && basinVideo.paused) basinVideo.play().catch(() => {});
    basinCaption.replaceChildren(`HypsomeSWE · snow year ${sy}, ${snowYearSpan(sy)} · ${flavorName(flavor)}. `,
      h('a', { href: url, target: '_blank', rel: 'noopener', textContent: 'Open the full-size animation' }), '.');
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
    setSearchHit(null);   // the basin's own outline takes over
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
    currentAnim = null;
    _basinSeq++;
    stopVideo();
    syncAnimControls();
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
  // The "folders" one level under prefix, from a bucket's anonymous listing
  // (snodas, or snotel for the station plots), every page of it.
  async function s3Prefixes(prefix, bucket = 'snodas') {
    const out = [];
    let token = null;
    do {
      const q = new URLSearchParams({ 'list-type': '2', prefix, delimiter: '/' });
      if (token) q.set('continuation-token', token);
      const res = await fetch(`${DATA_HOST}/${bucket}/?${q}`);
      if (!res.ok) throw new Error(`listing of ${prefix} failed: ${res.status}`);
      const xml = new DOMParser().parseFromString(await res.text(), 'application/xml');
      for (const el of xml.getElementsByTagName('Prefix')) out.push(el.textContent);
      token = xml.getElementsByTagName('IsTruncated')[0]?.textContent === 'true'
        ? xml.getElementsByTagName('NextContinuationToken')[0]?.textContent : null;
    } while (token);
    return out;
  }
  function plotDates() {
    return _cache.cached('plots:dates', async () => (await s3Prefixes('plots/'))
      .map(p => /^plots\/(\d{4}-\d{2}-\d{2})\/$/.exec(p)?.[1]).filter(Boolean).sort()
    ).catch(() => []);
  }
  // The closest date to d whose plots are complete (its index.json exists):
  // the basins' by default, the stations' with their own two lookups.
  async function nearestPlotDate(d, { dates = plotDates, index = plotIndex } = {}) {
    const t = (x) => new Date(`${x}T12:00:00`).getTime();
    const ranked = (await dates())
      .filter(x => x !== d && x >= SNODAS_START && x <= latestDate)
      .sort((a, b) => Math.abs(t(a) - t(d)) - Math.abs(t(b) - t(d)));
    for (const x of ranked.slice(0, 5)) if (await index(x)) return x;
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
    if (basinData.open && currentBasin && currentPlot === 'hypsomeswe' && !currentAnim) renderBandTable(_basinSeq);
  });

  function showBasinEmpty(text, action) {
    basinImg.hidden = true;
    stopVideo();
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
    if (currentAnim) { renderAnim(seq); return; }

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
    stopVideo();
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
  const KIT_ASSETS = 'https://cdn.jsdelivr.net/gh/mt-climate-office/mco-web-style@0.20.0/assets';
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

  // ── Ski areas ─────────────────────────────────────────────────────────────
  // Every operating downhill area in the SNODAS domain, from OpenSkiMap
  // (scripts/build-ski.sh). data/ski/areas.json lists them with their bounds;
  // each area's runs and lifts are their own file, fetched once the map is
  // zoomed in over it and kept for the session (10 MB for all of them).
  const SKI_ROOT = 'data/ski';
  function loadSkiIndex() {
    return _cache.cached('ski:areas', async () => {
      const areas = await MCO.fetchJSON(`${SKI_ROOT}/areas.json`);
      _skiNames = { type: 'FeatureCollection', features: areas.filter(a => a[1]).map(([, name, , , w, s, e, n]) =>
        ({ type: 'Feature', properties: { name }, geometry: { type: 'Point', coordinates: [(w + e) / 2, s] } })) };
      map.getSource('ski-names')?.setData(_skiNames);
      return areas;
    });
  }
  const _skiLoaded = new Map();   // key → features
  function loadSkiArea(key) {
    return _cache.cached(`ski:${key}`, async () => {
      const fc = await MCO.fetchJSON(`${SKI_ROOT}/runs/${key}.json`);
      if (!_skiLoaded.has(key)) {
        _skiLoaded.set(key, fc.features);
        _skiData = { type: 'FeatureCollection', features: [..._skiLoaded.values()].flat() };
        map.getSource('ski')?.setData(_skiData);
      }
      return fc;
    });
  }

  // On every move: load the areas in view. A failed fetch is evicted and
  // tried again on the next move.
  async function updateSki() {
    if (map.getZoom() < SKI_MIN_ZOOM) return;
    let areas;
    try { areas = await loadSkiIndex(); } catch { return; }
    if (map.getZoom() < SKI_MIN_ZOOM) return;
    const b = map.getBounds();
    const inView = areas.filter(([, , , , w, s, e, n, runs]) =>
      runs && w <= b.getEast() && e >= b.getWest() && s <= b.getNorth() && n >= b.getSouth());
    for (const a of inView) loadSkiArea(a[0]).catch(() => {});
  }

  // The trail signs, drawn once per style (a style swap drops its images):
  // e a green circle, i a blue square, a a black diamond, x two, each ringed
  // in white.
  function skiSignCanvas(d, s) {
    const c = document.createElement('canvas');
    c.width = d === 'x' ? Math.round(s * 1.7) : s;
    c.height = s;
    const x = c.getContext('2d');
    const lw = s / 8, r = s / 2 - lw / 2;
    x.lineWidth = lw; x.lineJoin = 'round';
    x.strokeStyle = '#ffffff'; x.fillStyle = SKI_COLORS[d];
    const shape = (cx) => {
      x.beginPath();
      if (d === 'e') x.arc(cx, s / 2, r, 0, 2 * Math.PI);
      else if (d === 'i') x.rect(cx - r * 0.8, s / 2 - r * 0.8, r * 1.6, r * 1.6);
      else { x.moveTo(cx, s / 2 - r); x.lineTo(cx + r, s / 2); x.lineTo(cx, s / 2 + r); x.lineTo(cx - r, s / 2); x.closePath(); }
      x.fill(); x.stroke();
    };
    if (d === 'x') { shape(s / 2); shape(c.width - s / 2); } else shape(s / 2);
    return c;
  }
  function addSkiSigns() {
    const ratio = 2;
    for (const d of ['e', 'i', 'a', 'x']) {
      if (map.hasImage(`ski-${d}`)) continue;
      const c = skiSignCanvas(d, SKI_SIGN_PX * ratio);
      map.addImage(`ski-${d}`, c.getContext('2d').getImageData(0, 0, c.width, c.height), { pixelRatio: ratio });
    }
  }

  // ── SNOTEL stations ───────────────────────────────────────────────────────
  // NRCS SNOTEL stations with their own SWE percentiles, from mco-snotel at
  // data2.climate.umt.edu/snotel/ (its CONSUMERS.md). The `snodas` normals
  // period, whose reference years are the SNODAS normals', so a station
  // reads against the same years as the map behind it; the flavor is the
  // map's. Stations sit in water years (1 October – 30 September), the
  // SNODAS snow year a month later.
  //
  // The day's percentiles come from the water year's observed table
  // (observedOn), read only while the layer is on. The current year is read
  // from latest/, which the CDN refreshes hourly.
  //
  // The two products date the same moment a day apart. A SNODAS day is its
  // analysis at 06:00 UTC, midnight Mountain as the day begins; mco-snotel
  // stamps NRCS's daily values at the end of their day (AWDB periodRef =
  // END), so its reading at that same midnight carries the day before. Map
  // date D therefore shows SNOTEL's D − 1 (snotelDay), and every place a
  // station's date is printed names both, since the plots and NRCS's own
  // pages carry the earlier one.
  const SNOTEL_ROOT   = `${DATA_HOST}/snotel`;
  const SNOTEL_PERIOD = 'snodas';
  const SNOTEL_RADIUS = [[3, 3.5], [7, 5], [11, 7.5]];   // [zoom, px]
  const SNOTEL_NOREAD = '#9a9a9a';   // a station with no reading: grey,
  const SNOTEL_NOREAD_SCALE = 0.6;   // …and smaller
  const SNOTEL_CREDIT = 'USDA NRCS SNOTEL';
  const waterYear = (d) => +d.slice(0, 4) + (+d.slice(5, 7) >= 10 ? 1 : 0);
  const snotelDay = (d) => MCO.shiftDate(d, -1);
  const mapDay    = (d) => MCO.shiftDate(d, 1);
  const nrcsLabel = (d) => `NRCS ${MCO.formatDateStr(snotelDay(d))}, end of day`;
  const inToMm = (v) => (v == null ? null : v * 25.4);
  const isoDay = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
  const pqZstd = (pq) => ({ ZSTD: (input) => pq.zstdDecompress(input) });

  function snotelManifest() {
    return _cache.cached('snotel:manifest', () => MCO.fetchJSON(`${SNOTEL_ROOT}/latest/manifest.json`, { cache: 'no-cache' }));
  }

  // Stations in the SNODAS domain, active now or reporting past the start of
  // the earliest water year the map reaches.
  function loadStations() {
    return _cache.cached('snotel:stations', async () => {
      const pq = await parquetLib();
      const res = await fetch(`${SNOTEL_ROOT}/stations/stations.parquet`);
      if (!res.ok) throw new Error(`stations fetch failed: ${res.status}`);
      const rows = await pq.parquetReadObjects({ file: await res.arrayBuffer(), compressors: pqZstd(pq) });
      const [[w, s], [e, n]] = COG_BOUNDS;
      const since = `${waterYear(SNODAS_START) - 1}-10-01`;
      return rows
        .filter(r => r.state !== 'AK' && r.longitude >= w && r.longitude <= e && r.latitude >= s && r.latitude <= n
                  && (r.active || isoDay(r.end_date) >= since))
        .map(r => ({ id: r.station, triplet: r.triplet, siteId: r.site_id, name: r.name, state: r.state,
                     county: r.county, elev: r.elevation_ft, lon: r.longitude, lat: r.latitude }));
    });
  }

  // One water year's observed table, opened by HTTP range requests: the
  // footer once, then only the row groups a date needs. mco-snotel sorts it
  // by flavor, date and triplet and writes about a month of one flavor per
  // row group, so a date is one group, or two where a group boundary falls
  // inside it; each group's flavor and date statistics say which. A group is
  // kept once read, so stepping through a month fetches nothing more. A
  // table written as a single group (as before that layout) is read whole,
  // once. Null when the water year has no table yet.
  function observedFile(wy) {
    return _cache.cached(`snotel:obsfile:${wy}`, async () => {
      const latest = await snotelManifest().catch(() => null);
      const url = latest?.water_year === wy
        ? `${SNOTEL_ROOT}/latest/observed_${SNOTEL_PERIOD}.parquet`
        : `${SNOTEL_ROOT}/normals/${SNOTEL_PERIOD}/observed/wy${wy}.parquet`;
      const head = await fetch(url, { method: 'HEAD' });
      if (head.status === 404) return null;
      if (!head.ok) throw new Error(`observed table ${head.status}`);
      const pq = await parquetLib();
      const file = await pq.asyncBufferFromUrl({ url, byteLength: +head.headers.get('content-length') });
      // The footer is a few tens of KB; hyparquet's first guess is the last
      // 512 KB of the file, and it reads further itself if a footer is bigger.
      const metadata = await pq.parquetMetadataAsync(file, { initialFetchSize: 1 << 16 });
      // A DATE statistic comes back as a Date, or as days since 1970.
      const day = (v) => (v == null ? null : typeof v === 'number' ? isoDay(new Date(v * 864e5)) : isoDay(v));
      let start = 0;
      const groups = metadata.row_groups.map((g) => {
        const stat = (col) => g.columns.find(c => c.meta_data.path_in_schema[0] === col)?.meta_data.statistics || {};
        const f = stat('flavor'), d = stat('date');
        const out = { start, end: start + Number(g.num_rows),
                      fMin: f.min_value ?? null, fMax: f.max_value ?? null, dMin: day(d.min_value), dMax: day(d.max_value) };
        start = out.end;
        return out;
      });
      return { file, metadata, groups };
    });
  }
  // One row group: `${flavor}|${date}` → Map(triplet → { swe, ptile }), SWE
  // in inches as NRCS stores it.
  function observedGroup(wy, i) {
    return _cache.cached(`snotel:obs:${wy}:${i}`, async () => {
      const { file, metadata, groups } = await observedFile(wy);
      const pq = await parquetLib();
      const rows = await pq.parquetReadObjects({
        file, metadata, columns: ['flavor', 'date', 'triplet', 'swe', 'swe_ptile'],
        rowStart: groups[i].start, rowEnd: groups[i].end, compressors: pqZstd(pq),
      });
      const byDay = new Map();
      for (const r of rows) {
        const k = `${r.flavor}|${isoDay(r.date)}`;
        if (!byDay.has(k)) byDay.set(k, new Map());
        byDay.get(k).set(r.triplet, { swe: r.swe ?? null, ptile: r.swe_ptile ?? null });
      }
      return byDay;
    });
  }
  // A date's readings for one flavor: triplet → { swe, ptile }. A group with
  // no statistics for a column can't be ruled out, so it is read.
  async function observedOn(date, flavor) {
    const wy = waterYear(date);
    const f = await observedFile(wy);
    if (!f) return new Map();
    const within = (lo, hi, v) => lo == null || hi == null || (lo <= v && v <= hi);
    const hits = f.groups.flatMap((g, i) => (within(g.dMin, g.dMax, date) && within(g.fMin, g.fMax, flavor) ? [i] : []));
    const out = new Map();
    for (const byDay of await Promise.all(hits.map(i => observedGroup(wy, i)))) {
      for (const [t, v] of byDay.get(`${flavor}|${date}`) || []) out.set(t, v);
    }
    return out;
  }

  // One station's normals for its water year (all flavors and days, ~130 KB):
  // `${flavor}|${date}` → { mean, q10, q50, q90 }, inches. Only for the
  // dialog's data table and text alternative.
  function loadStationNormals(id, wy) {
    return _cache.cached(`snotel:normals:${id}:${wy}`, async () => {
      const pq = await parquetLib();
      const res = await fetch(`${SNOTEL_ROOT}/normals/${SNOTEL_PERIOD}/wy${wy}/by_station/${id}.parquet`);
      if (!res.ok) throw new Error(`normals fetch failed: ${res.status}`);
      const rows = await pq.parquetReadObjects({
        file: await res.arrayBuffer(), columns: ['flavor', 'date', 'mean', 'q0100', 'q0500', 'q0900'], compressors: pqZstd(pq),
      });
      return new Map(rows.map(r => [`${r.flavor}|${isoDay(r.date)}`,
        { mean: r.mean ?? null, q10: r.q0100 ?? null, q50: r.q0500 ?? null, q90: r.q0900 ?? null }]));
    });
  }

  // Draw the stations for the page's date and flavor. Silent while off.
  let _snotelSeq = 0;
  let _snotelRows = [];   // what the map drew, for the table twin
  async function updateSnotel() {
    if (!snotelOn || !_layersAdded) return;
    const seq = ++_snotelSeq;
    const date = currentDate, flavor = currentFlavor;
    loading.start();
    try {
      const [stations, obs] = await Promise.all([loadStations(), observedOn(snotelDay(date), flavor)]);
      if (seq !== _snotelSeq) return;
      _snotelRows = stations.map(st => ({ ...st, ...(obs.get(st.triplet) || { swe: null, ptile: null }) }));
      _snotelData = { type: 'FeatureCollection', features: _snotelRows.map(st => ({
        type: 'Feature', properties: { id: st.id, ptile: st.ptile },
        geometry: { type: 'Point', coordinates: [st.lon, st.lat] } })) };
      map.getSource('snotel')?.setData(_snotelData);
      renderStationTwin();
      loading.done();
      // If the stations are behind the map (a late or failed nightly run),
      // say how far they run rather than leave every station grey.
      const through = (await snotelManifest().catch(() => null))?.date;
      if (seq === _snotelSeq && through && snotelDay(date) > through && !_snotelRows.some(st => st.ptile != null)) {
        showToast(`SNOTEL readings run through ${MCO.formatDateStr(mapDay(through))}.`, 5000);
      }
    } catch (err) {
      console.error('[snotel]', err);
      if (seq !== _snotelSeq) return;
      loading.fail('SNOTEL station data failed to load.', { retry: updateSnotel });
    }
  }

  const SNOTEL_LAYERS = ['snotel-halo', 'snotel', 'snotel-focus', 'snotel-selected'];
  function setSnotelVisible(on) {
    for (const id of SNOTEL_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }

  // The on/off control: a toggle button in the navbar.
  const snotelBtn = document.getElementById('btn-snotel');
  function syncSnotelToggle() { snotelBtn.setAttribute('aria-pressed', String(snotelOn)); }
  syncSnotelToggle();
  snotelBtn.addEventListener('click', () => setSnotel(!snotelOn));

  function setSnotel(on, { silent = false } = {}) {
    if (on === snotelOn) return;
    snotelOn = on;
    syncSnotelToggle();
    if (!on && stationModal.open) { currentStation = null; stationModal.close(); }
    if (!silent) { writeUrl(); MCO.announce(on ? 'SNOTEL stations shown' : 'SNOTEL stations hidden'); }
    if (!_layersAdded) return;
    setSnotelVisible(on);
    if (on) updateSnotel();
    else { _snotelSeq++; renderStationTwin(); }
  }

  // The stations' table twin: the ones in view, by name, while they show.
  // Keyed by date and flavor too: the kit's selectable twin rebuilds only
  // when its keys change, and a percentile is part of what a row says.
  let _focusedStation = null;
  const stationTwin = MCO.srTable({
    caption: 'SNOTEL stations in view',
    selectable: true,
    rowKey: (r) => `${r.id}|${currentDate}|${currentFlavor}`,
    onSelect: (row) => openStation(row.id),
    onFocus: (row) => setFocusedStation(row ? row.id : null),
    columns: [
      { key: 'name', label: 'Station', rowHeader: true },
      { key: 'state', label: 'State' },
      { key: 'elev', label: 'Elevation (ft)', value: (r) => Math.round(r.elev).toLocaleString('en-US') },
      { key: 'ptile', label: 'SWE percentile', value: (r) => (r.ptile == null ? 'no reading' : ordinal(Math.round(r.ptile))) },
    ],
    overflowText: (n) => `…and ${n} more stations. Zoom in to list them all.`,
  });
  function renderStationTwin() {
    if (!snotelOn) { stationTwin.render([]); return; }
    const b = map.getBounds();
    const rows = _snotelRows.filter(st => b.contains([st.lon, st.lat]))
      .sort((a, z) => a.name.localeCompare(z.name));
    stationTwin.render(rows, { selected: currentStation ? `${currentStation.id}|${currentDate}|${currentFlavor}` : null });
  }
  function setFocusedStation(id) {
    _focusedStation = id;
    if (map.getLayer('snotel-focus')) map.setFilter('snotel-focus', ['==', ['get', 'id'], id ?? '']);
  }
  function setSelectedStation(id) {
    if (map.getLayer('snotel-selected')) map.setFilter('snotel-selected', ['==', ['get', 'id'], id ?? '']);
  }

  // The station under a map point (within a few pixels, for a finger), or null.
  function stationAt(point) {
    if (!snotelOn || !map.getLayer('snotel')) return null;
    const pad = 6;
    const hit = map.queryRenderedFeatures([[point.x - pad, point.y - pad], [point.x + pad, point.y + pad]], { layers: ['snotel'] })[0];
    return hit ? _snotelRows.find(st => st.id === hit.properties.id) || null : null;
  }
  // The tooltip's lines for a station, as for a watershed: no median here,
  // so the percentile alone.
  function stationReading(st) {
    return {
      title: `${st.name} (SNOTEL ${st.siteId})`,
      lines: [MCO.formatDateStr(currentDate),
        st.swe == null && st.ptile == null ? 'No reading for this date' : conditions(inToMm(st.swe), null, st.ptile),
        sweLine(inToMm(st.swe)), nrcsLabel(currentDate)].filter(Boolean),
    };
  }

  // ── The station dialog ──
  // One station's seasonal SWE plot, which mco-snotel renders per date,
  // period and flavor (plots/{date}/{period}/{flavor}/swe/usdm/{station}.png,
  // plots/{date}/index.json written last). Built like the basin dialog: its
  // date and normals controls are the page's own, and there is one plot type,
  // since a station has no elevation bands.
  const stationModal    = document.getElementById('station-modal');
  const stationCtl      = MCO.initInfoModal({ dialog: stationModal });
  const stationTitle    = document.getElementById('station-title');
  const stationSubtitle = document.getElementById('station-subtitle');
  const stationDate     = document.getElementById('station-date');
  const stationFlavorFs = document.getElementById('station-flavor-btns');
  const stationFrame    = document.getElementById('station-frame');
  const stationImg      = document.getElementById('station-img');
  const stationEmpty    = document.getElementById('station-empty');
  const stationCaption  = document.getElementById('station-caption');
  const stationTable    = document.getElementById('station-table');

  stationDate.min = SNODAS_START;
  stationDate.max = latestDate;
  stationDate.value = currentDate;
  stationDate.addEventListener('change', () => {
    if (isIsoDate(stationDate.value)) setDate(stationDate.value);
    else stationDate.value = currentDate;
  });
  steppers.push(MCO.initStepper({
    prev: document.getElementById('btn-station-prev'), next: document.getElementById('btn-station-next'), ...stepperOpts,
  }));
  stationFlavorFs.addEventListener('change', (e) => setFlavor(e.target.value));

  // Opening is drill-down, as a basin's: a pushed entry, so Back closes it.
  async function openStation(id, { push = true } = {}) {
    let st = null;
    try { st = (await loadStations()).find(x => x.id === id); } catch { /* below */ }
    if (!st) { showToast(`No SNOTEL station ${id} was found.`); return; }
    const wasOpen = stationModal.open;
    currentStation = st;
    if (!snotelOn) setSnotel(true, { silent: true });
    setSelectedStation(id);
    renderStationTwin();
    writeUrl(push && !wasOpen ? { push: true, state: { mcoDetail: `station:${id}` } } : {});
    if (!wasOpen) stationCtl.open();
    renderStation();
  }

  // The basin dialog's single close path, for this one.
  stationModal.addEventListener('close', () => {
    currentStation = null;
    _stationSeq++;
    setSelectedStation(null);
    renderStationTwin();
    if (_closingFromHistory) _closingFromHistory = false;
    else if (history.state && history.state.mcoDetail) { _backFromClose = true; history.back(); }
    else writeUrl();
    setTimeout(() => {
      if (!document.activeElement || document.activeElement === document.body) mainEl.focus();
    }, 0);
  });

  // Which dates have station plots: as for the basins, from the snotel
  // bucket. index.json's `periods` is an array, or a bare string when there
  // is only one.
  function stationPlotIndex(d) {
    return _cache.cached(`snotel:plots:${d}`, async () => {
      const idx = await MCO.fetchJSON(`${SNOTEL_ROOT}/plots/${d}/index.json`).catch(() => null);
      return idx && [].concat(idx.periods || []).includes(SNOTEL_PERIOD) ? idx : null;
    });
  }
  function stationPlotDates() {
    return _cache.cached('snotel:plots:dates', async () => (await s3Prefixes('plots/', 'snotel'))
      .map(p => /^plots\/(\d{4}-\d{2}-\d{2})\/$/.exec(p)?.[1]).filter(Boolean).sort()
    ).catch(() => []);
  }
  // The same two, in map dates (a station plot for D − 1 is the map's D),
  // for nearestPlotDate.
  const stationPlotMapDates = async () => (await stationPlotDates()).map(mapDay);
  const stationPlotMapIndex = (d) => stationPlotIndex(snotelDay(d));
  const stationPlotUrl = (idx, d, flavor, id) => `${SNOTEL_ROOT}/plots/${d}/`
    + (idx.path || '{period}/{flavor}/{type}/{style}/{station}.png')
      .replace('{period}', SNOTEL_PERIOD).replace('{flavor}', flavor).replace('{type}', 'swe')
      .replace('{style}', PLOT_STYLE).replace('{station}', id);

  function showStationEmpty(text, action) {
    stationImg.hidden = true;
    stationCaption.textContent = '';
    const kids = [h('p', { textContent: text })];
    if (action) kids.push(h('button', { type: 'button', className: 'nav-btn', textContent: action.label,
      onclick: () => { action.focus?.focus(); action.onClick(); } }));
    stationEmpty.replaceChildren(...kids);
    stationEmpty.hidden = false;
    MCO.announce(text);
  }

  function stationAlt(st, obs, norm, date, { pending = false } = {}) {
    const head = `Snow water equivalent at ${st.name} SNOTEL station through water year ${waterYear(snotelDay(date))} (October 1 to September 30), drawn against the range of ${flavorName().toLowerCase()}.`;
    const when = `At the start of ${MCO.formatDateStr(date)} (${nrcsLabel(date)})`;
    const now = pending ? '' : obs?.swe != null
      ? ` ${when} the station measured ${fmtSwe(inToMm(obs.swe))}${obs.ptile != null ? `, the ${fmtPtile(obs.ptile)}` : ''}`
        + (norm?.q50 != null ? `; the median for that date is ${fmtSwe(inToMm(norm.q50))}.` : '.')
      : ` There is no reading for the start of ${MCO.formatDateStr(date)}.`;
    return `${head}${now} The numbers are in the data table below the plot.`;
  }
  function renderStationTable(st, obs, norm, date) {
    stationTable.replaceChildren(factsTable(`${st.name}, start of ${MCO.formatDateStr(date)} (${nrcsLabel(date)}), ${flavorName().toLowerCase()}`, [
      ['Observed SWE', fmtSwe(inToMm(obs?.swe))],
      ['Percentile', obs?.ptile == null ? '—' : ordinal(Math.round(obs.ptile))],
      ['Median for this date', fmtSwe(inToMm(norm?.q50))],
      ['Normal range (10th–90th percentile)', norm ? `${fmtSwe(inToMm(norm.q10))} to ${fmtSwe(inToMm(norm.q90))}` : '—'],
      ['Mean for this date', fmtSwe(inToMm(norm?.mean))],
    ]));
  }

  let _stationSeq = 0;
  async function renderStation() {
    if (!currentStation) return;
    const seq = ++_stationSeq;
    const st = currentStation;
    const date = currentDate, flavor = currentFlavor;
    const day = snotelDay(date);   // the station's own date for that moment
    stationDate.value = date;
    checkRadio(stationFlavorFs, flavor);
    stationTitle.textContent = st.name;
    stationSubtitle.textContent = `SNOTEL ${st.siteId} · ${st.county ? `${st.county} County, ` : ''}${st.state} · ${Math.round(st.elev).toLocaleString('en-US')} ft`;
    stationFrame.setAttribute('aria-busy', 'true');

    // The numbers (the year's observed table can take seconds the first
    // time) fill the table and the text alternative when they arrive; the
    // plot doesn't wait for them.
    const numbers = Promise.all([
      observedOn(day, flavor).catch(() => null),
      loadStationNormals(st.id, waterYear(day)).catch(() => null),
    ]).then(([obsDay, normals]) => ({
      obs: obsDay?.get(st.triplet) ?? null, norm: normals?.get(`${flavor}|${day}`) ?? null,
    }));
    let got = null, shown = false;
    numbers.then((n) => {
      if (seq !== _stationSeq) return;
      got = n;
      renderStationTable(st, n.obs, n.norm, date);
      if (shown) stationImg.alt = stationAlt(st, n.obs, n.norm, date);
    });

    const idx = await stationPlotIndex(day);
    if (seq !== _stationSeq) return;

    if (!idx || (idx.flavors && !idx.flavors.includes(flavor))) {
      const near = await nearestPlotDate(date, { dates: stationPlotMapDates, index: stationPlotMapIndex });
      if (seq !== _stationSeq) return;
      stationFrame.removeAttribute('aria-busy');
      showStationEmpty(`Station plots aren't available for ${MCO.formatDateStr(date)} yet.`,
        near && { label: `Show ${MCO.formatDateStr(near)}`, onClick: () => setDate(near), focus: stationDate });
      return;
    }

    const url = stationPlotUrl(idx, day, flavor, st.id);
    const ok = await loadImage(url);
    if (seq !== _stationSeq) return;
    stationFrame.removeAttribute('aria-busy');
    if (!ok) {
      // mco-snotel plots active stations once they have SWE in the water year.
      const { obs } = await numbers;
      if (seq !== _stationSeq) return;
      showStationEmpty(obs?.swe ? `The plot for ${st.name} failed to load.`
        : `No plot for ${st.name} on ${MCO.formatDateStr(date)}. Stations are plotted once they have snow in the water year.`,
        obs?.swe ? { label: 'Retry', onClick: renderStation, focus: stationDate } : null);
      return;
    }
    stationEmpty.hidden = true;
    stationImg.alt = got ? stationAlt(st, got.obs, got.norm, date) : stationAlt(st, null, null, date, { pending: true });
    shown = true;
    stationImg.src = url;
    stationImg.hidden = false;
    const years = idx.reference_water_years?.[SNOTEL_PERIOD];
    stationCaption.replaceChildren(`SWE · start of ${MCO.formatDateStr(date)}, dated ${MCO.formatDateStr(day)} on the plot as NRCS does · ${flavorName(flavor)}`
      + (Array.isArray(years) && years.length ? ` from water years ${years[0]}–${years[years.length - 1]}` : '')
      + '. ', h('a', { href: url, target: '_blank', rel: 'noopener', textContent: 'Open the full-size plot' }), '.');

    // The other two flavors share the frame and axis: warm them for a swap.
    for (const f of Object.keys(FLAVORS)) if (f !== flavor) loadImage(stationPlotUrl(idx, day, f, st.id));
  }

  // ── Search ────────────────────────────────────────────────────────────────
  // One field over states, counties, cities and ZIP codes (data/places/,
  // built from the Census Gazetteer by scripts/build-places.sh), ski areas
  // (data/ski/, above) and the watersheds the app already loads. The
  // combobox and its ranking are the kit's (MCO.initSearchBox,
  // MCO.searchModel sections); the collapse below
  // 640px is MCO.initSearchCollapse. A pick moves the camera only: the plot
  // dialog still opens from a deliberate click.
  //
  // Point results stop at SEARCH_POINT_ZOOM, where a town shows with its
  // valley or range around it, so the reader keeps the region. Areas fit
  // their bounds, no closer than SEARCH_AREA_MAX_ZOOM. A ski area fits its
  // runs, between SKI_MIN_ZOOM (so they draw) and SEARCH_SKI_MAX_ZOOM; one
  // OSM maps only as a point stops at SEARCH_SKI_POINT_ZOOM.
  const SEARCH_POINT_ZOOM    = 9;
  const SEARCH_AREA_MAX_ZOOM = 10;
  const SEARCH_SKI_MAX_ZOOM  = 14;
  const SEARCH_SKI_POINT_ZOOM = 12;
  const PLACES_ROOT = 'data/places';
  const PLACE_KIND  = { c: 'City', t: 'Town', v: 'Village', b: 'Borough', p: 'Community' };
  // Section order is list order: what people most often type first.
  const SECTIONS = ['States', 'Cities and towns', 'Ski areas', 'Counties', 'Watersheds', 'ZIP codes'];
  const searchInput     = document.getElementById('search-input');
  const btnSearchToggle = document.getElementById('btn-search-toggle');
  const normalize = MCO.searchModel.normalize;

  // Items carry an opaque id ("~" + kind + index) that no query can match,
  // so the model ranks on labels and keywords alone; the record behind it
  // (bbox or point, and the basin's level and geometry) is looked up here.
  // _hay is the normalized text the pre-filter scans.
  const _searchRecords = new Map();
  let _searchSeq = 0;
  function searchItem(section, label, meta, keywords, rec) {
    const id = `~${section[0]}${_searchSeq++}`;
    _searchRecords.set(id, { label, ...rec });
    return { id, label, meta, keywords, section, queryOnly: true,
             _hay: normalize([label, ...keywords].join('|')) };
  }

  // Each source is loaded once, on first use; when one arrives the open
  // list refreshes. A failure is evicted (promiseCache), so the next
  // keystroke retries.
  const _searchItems = { States: [], 'Cities and towns': [], 'Ski areas': [], Counties: [], Watersheds: [], 'ZIP codes': [] };
  function loadAreasAndPlaces() {
    return _cache.cached('search:places', async () => {
      const [areas, places] = await Promise.all([
        MCO.fetchJSON(`${PLACES_ROOT}/areas.json`), MCO.fetchJSON(`${PLACES_ROOT}/places.json`)]);
      const stateName = new Map(areas.filter(a => a[0] === 's').map(a => [a[2], a[1]]));
      for (const [kind, name, st, w, s, e, n] of areas) {
        const bbox = [[w, s], [e, n]];
        if (kind === 's') _searchItems.States.push(searchItem('States', name, 'State', [st], { bbox }));
        else _searchItems.Counties.push(searchItem('Counties', `${name}, ${st}`, 'County',
          [`${name} ${st}`, `${name} ${stateName.get(st) || st}`], { bbox }));
      }
      _searchItems['Cities and towns'] = places.map(([name, st, kind, lat, lon]) =>
        searchItem('Cities and towns', `${name}, ${st}`, PLACE_KIND[kind] || 'City',
          [`${name} ${st}`, `${name} ${stateName.get(st) || st}`], { point: [lon, lat] }));
      searchBox.refresh();
    });
  }
  function loadZips() {
    return _cache.cached('search:zips', async () => {
      const zips = await MCO.fetchJSON(`${PLACES_ROOT}/zips.json`);
      _searchItems['ZIP codes'] = zips.map(([zip, lat, lon]) =>
        searchItem('ZIP codes', zip, 'ZIP code', [], { point: [lon, lat] }));
      searchBox.refresh();
    });
  }
  // Ski areas by name, with their state or province (code and name).
  // Unnamed ones still draw, but there is nothing to search them by.
  function loadSkiAreas() {
    return _cache.cached('search:ski', async () => {
      const areas = await loadSkiIndex();
      _searchItems['Ski areas'] = areas.filter(a => a[1]).map(([key, name, st, region, w, s, e, n, runs]) =>
        searchItem('Ski areas', `${name}, ${st}`, 'Ski area', [`${name} ${st}`, `${name} ${region}`],
          w === e && s === n ? { point: [w, s], ski: key, runs } : { bbox: [[w, s], [e, n]], ski: key, runs }));
      searchBox.refresh();
    });
  }
  // Watersheds from the boundaries preloadFgb() already fetches, all four
  // levels, each bbox walked from its geometry once.
  function loadWatersheds() {
    return _cache.cached('search:basins', async () => {
      const levels = await Promise.all(HUC_LEVELS.map(loadFgb));
      _searchItems.Watersheds = levels.flatMap((features, i) => features.map(f => {
        const huc = String(f.properties.huc);
        return searchItem('Watersheds', f.properties.name || `HUC${HUC_LEVELS[i]} ${huc}`,
          `HUC${HUC_LEVELS[i]} · ${huc}`, [huc], { bbox: geomBounds(f.geometry), huc, geometry: f.geometry });
      }));
      searchBox.refresh();
    });
  }
  function geomBounds(g) {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    const walk = (c) => {
      if (typeof c[0] === 'number') {
        if (c[0] < w) w = c[0]; if (c[0] > e) e = c[0];
        if (c[1] < s) s = c[1]; if (c[1] > n) n = c[1];
      } else c.forEach(walk);
    };
    walk(g.coordinates);
    return [[w, s], [e, n]];
  }
  function loadSearchSources(q) {
    const fail = () => {};   // retried on the next keystroke
    loadAreasAndPlaces().catch(fail);
    loadSkiAreas().catch(fail);
    loadWatersheds().catch(fail);
    if (/^\d/.test(q)) loadZips().catch(fail);   // ZIPs only once a digit is typed
  }

  // The model scores every item it is given on every keystroke, with typo
  // matching; ~70k items is too many for that. So it gets only the items
  // whose text contains the query, plus, when that leaves almost nothing for
  // a query of 4+ letters, every item with a word starting with its first
  // letter, so a typo ("Bozemen") can still find its match.
  function searchCandidates() {
    const q = normalize(searchInput.value.trim());
    if (!q) return [];
    const all = SECTIONS.flatMap(s => _searchItems[s]);
    const hits = all.filter(it => it._hay.includes(q));
    if (hits.length >= 5 || q.length < 4 || /\d/.test(q)) return hits;
    const initial = new RegExp(`(^|[^\\p{L}\\p{N}])${q[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u');
    return all.filter(it => initial.test(it._hay));
  }

  const searchBox = MCO.initSearchBox({
    input: searchInput,
    listbox: document.getElementById('search-list'),
    items: searchCandidates,
    onSelect: goToSearchResult,
    label: 'Places, ski areas and watersheds',
    limit: 30,
    sectionLimits: { States: 5, 'Cities and towns': 5, 'Ski areas': 5, Counties: 5, Watersheds: 5, 'ZIP codes': 8 },
  });
  const searchCollapse = MCO.initSearchCollapse({
    wrap: document.getElementById('search-wrap'),
    toggle: btnSearchToggle,
    input: searchInput,
    onClose: () => searchBox.close(),
  });
  searchInput.addEventListener('focus', () => loadSearchSources(searchInput.value));
  searchInput.addEventListener('input', () => loadSearchSources(searchInput.value));
  // The kit handles (and stops) the Esc that closes the list or clears the
  // text; the one it passes through closes the overlay, one step at a time.
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented && searchCollapse.isOpen()) {
      e.preventDefault();
      searchCollapse.close();
    }
  });

  // Bumped on every change, so a ski area's outline that arrives after the
  // reader has moved on is dropped.
  let _searchHitSeq = 0;
  function setSearchHit(feature) {
    _searchHitSeq++;
    _searchHit = feature ? { type: 'FeatureCollection', features: [feature] } : EMPTY_FC;
    map.getSource('search-hit')?.setData(_searchHit);
  }

  function goToSearchResult(id) {
    const rec = _searchRecords.get(id);
    if (!rec) return;
    const animate = !MCO.reducedMotion();
    // Focus stays in the field, unless the field is about to be hidden: the
    // collapsed overlay hands it to its toggle, the rail drawer to its menu
    // button, so it never drops to <body>.
    if (rail.isRail()) rail.close();
    else if (searchCollapse.isOpen()) searchCollapse.close();

    if (rec.ski) {
      goToSkiArea(rec, animate);
      MCO.announce(`Zoomed to ${rec.label}`);
      return;
    }
    if (rec.huc) {
      const level = rec.huc.length;
      if (currentView === 'zonal' && level !== currentHucLevel) setHucLevel(level);
      setSearchHit({ type: 'Feature', properties: {}, geometry: rec.geometry });
    } else if (rec.point) {
      setSearchHit({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: rec.point } });
    } else {
      setSearchHit(null);
    }
    if (rec.bbox) map.fitBounds(rec.bbox, { ...FIT_OPTS, padding: 40, maxZoom: SEARCH_AREA_MAX_ZOOM, animate });
    else map.easeTo({ center: rec.point, zoom: SEARCH_POINT_ZOOM, animate });
    MCO.announce(`Zoomed to ${rec.label}`);
  }

  // A ski area: its runs in view, close enough that they draw, and its
  // outline once its file arrives (a dot when OSM maps it only as a point).
  function goToSkiArea(rec, animate) {
    if (rec.point) {
      setSearchHit({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: rec.point } });
      map.easeTo({ center: rec.point, zoom: SEARCH_SKI_POINT_ZOOM, animate });
      return;
    }
    setSearchHit(null);
    const cam = map.cameraForBounds(rec.bbox, { padding: 40, maxZoom: SEARCH_SKI_MAX_ZOOM });
    map.easeTo({ center: cam.center, zoom: Math.max(cam.zoom, SKI_MIN_ZOOM), animate });
    if (!rec.runs) return;
    const seq = _searchHitSeq;
    loadSkiArea(rec.ski).then((fc) => {
      const outline = fc.features.find(f => f.properties.o);
      if (outline && seq === _searchHitSeq) setSearchHit(outline);
    }).catch(() => {});
  }

  // / jumps to the search from anywhere but another field. Gated by
  // ?kbd=off (WCAG 2.1.4).
  window.addEventListener('keydown', (e) => {
    if (!kbdShortcuts || e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (document.querySelector('dialog[open]')) return;
    e.preventDefault();
    if (rail.isRail()) { rail.open(searchInput); return; }
    if (searchCollapse.isCollapsed()) { searchCollapse.open(); return; }
    searchInput.focus();
    searchInput.select();
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
  const DEEP_LINK_PARAMS = ['date', 'view', 'huc', 'flavor', 'basin', 'station', 'snotel', 'lng', 'export'];
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
