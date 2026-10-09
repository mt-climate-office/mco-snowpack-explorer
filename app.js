/* ==========================================================================
   Snowpack Explorer — application code.

   An ES module, not a classic script: it imports hyparquet from esm.sh at
   runtime for the Parquet zonal statistics. The kit ships MCO / MCO.map as
   plain globals via classic <script> tags, which run before this deferred
   module, so both are available here without importing anything.

   MapLibre is different since kit 0.8.0: 6.x is ES-modules only, so there is
   no maplibregl global until MCO.map.loadMapLibre() has imported it (under
   the import map's SRI hashes in index.html). The IIFE awaits it first, so
   every maplibregl.* below — and CogProtocol.initCogProtocol — sees it.

   Extracted from an inline <script type="module"> during the mco-web-style
   migration (kit @0.6.0) — an external file is what lets the page ship a meta
   CSP without 'unsafe-inline'.
   ========================================================================== */
import { parquetRead } from 'https://esm.sh/hyparquet@1';

// Architecture overview:
//   - Gridded view: renders a COG raster tile layer via the custom cog:// MapLibre protocol.
//   - Zonal view: renders HUC watershed polygons colored by aggregated SWE percentile.
//     Boundaries are loaded from FlatGeobuf (cached in Cache API across sessions).
//     Percentiles are loaded from Parquet (cached in memory per date+method).
//     Feature state drives the fill color so geometry is only uploaded once per level.
//   - Layer order (back → front): swe → huc-fill → hillshade → huc-line → labels

(async () => {

  // ── Constants ────────────────────────────────────────────────────────────
  const SNODAS_START = '2004-01-01';
  const S3_ROOT    = 'https://d1s8jav5n0eyyf.cloudfront.net/snodas/normals/gridded';
  const FGB_ROOT   = 'https://d1s8jav5n0eyyf.cloudfront.net/snodas/cache/data/fgb';
  const ZONAL_ROOT = 'https://d1s8jav5n0eyyf.cloudfront.net/snodas/normals/zonal/wbd';
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

  // ── MapLibre 6 ───────────────────────────────────────────────────────────
  // Awaited before anything else, as the UMD <script> it replaces was: the UI
  // wiring below closes over `map`, so it must not run ahead of the library.
  try {
    await MCO.map.loadMapLibre();
  } catch (err) {
    console.error('[maplibre]', err);
    MCO.notice({ tone: 'danger', text: 'The map library failed to load. Reload the page to try again.' });
    MCO.ready();
    return;
  }

  // ── Colormap ─────────────────────────────────────────────────────────────
  CogProtocol.registerColormap('ptile', CogProtocol.makeStepColormap({
    breaks: BREAKS, colors: COLORS, alpha: 210, domain: [0, 100],
  }));
  CogProtocol.initCogProtocol(maplibregl);

  // ── Helpers ───────────────────────────────────────────────────────────────
  function todayMT() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
  }

  function formatDate(isoStr) {
    return new Date(`${isoStr}T12:00:00`).toLocaleDateString('en-US', {
      month: 'long', day: 'numeric', year: 'numeric',
    });
  }

  function ordinal(n) {
    const s = [,'st','nd','rd'][n % 100 >> 3 ^ 1 && n % 10] || 'th';
    return `${n}${s}`;
  }

  // ── URL / state ───────────────────────────────────────────────────────────
  const urlParams = new URLSearchParams(location.search);
  let currentMethod   = ['zig','ecdf'].includes(urlParams.get('method')) ? urlParams.get('method') : 'zig';
  let currentDate     = urlParams.get('date') || todayMT();
  let currentView     = ['gridded','zonal'].includes(urlParams.get('view')) ? urlParams.get('view') : 'gridded';
  let currentHucLevel = (() => { const v = parseInt(urlParams.get('huc')); return [2,4,6,8].includes(v) ? v : 2; })();
  if (currentDate < SNODAS_START) currentDate = SNODAS_START;
  if (currentDate > todayMT())    currentDate = todayMT();

  // Initial map position from URL (lat/lng/zoom), if present
  const _initLat  = parseFloat(urlParams.get('lat'));
  const _initLng  = parseFloat(urlParams.get('lng'));
  const _initZoom = parseFloat(urlParams.get('zoom'));
  const _hasInitPos = !isNaN(_initLat) && !isNaN(_initLng) && !isNaN(_initZoom);

  // URL builders (defined after state so default args are readable)
  const cogUrl        = (d, m = currentMethod) => `${S3_ROOT}/${m}/${d}/${d}_${m}_swe_ptile.tif`;
  const fgbUrl        = lvl   => `${FGB_ROOT}/huc${lvl}.fgb`;
  const zonalUrl      = (d, m) => `${ZONAL_ROOT}/${m}/${d}/${d}_${m}_swe_normals.parquet`;
  const provenanceUrl = (d, m) => `${S3_ROOT}/${m}/${d}/${d}_${m}_provenance.json`;

  async function cogExists(d) {
    try {
      const r = await fetch(cogUrl(d), { method: 'GET', headers: { Range: 'bytes=0-3' } });
      if (!r.ok && r.status !== 206) return false;
      const buf = new Uint8Array(await r.arrayBuffer());
      // Valid TIFF starts with 'II' (0x49 0x49) or 'MM' (0x4D 0x4D)
      return buf.length >= 2 && ((buf[0] === 0x49 && buf[1] === 0x49) || (buf[0] === 0x4D && buf[1] === 0x4D));
    } catch { return false; }
  }

  // Walk backwards from the given date to find the most recent date with data.
  // Returns the original date if it has data, otherwise tries up to `maxDays` prior dates.
  async function findLatestAvailable(startDate, maxDays = 30) {
    const d = new Date(startDate + 'T00:00:00');
    for (let i = 0; i < maxDays; i++) {
      const iso = d.toISOString().slice(0, 10);
      if (iso < SNODAS_START) break;
      if (await cogExists(iso)) return iso;
      d.setDate(d.getDate() - 1);
    }
    return null;
  }

  function pushState() {
    const params = { date: currentDate, method: currentMethod, view: currentView };
    if (currentView === 'zonal') params.huc = currentHucLevel;
    try {
      const { lng, lat } = map.getCenter();
      params.lng  = lng.toFixed(4);
      params.lat  = lat.toFixed(4);
      params.zoom = map.getZoom().toFixed(2);
    } catch {}  // map not yet initialized on first call
    history.replaceState(null, '', `?${new URLSearchParams(params)}`);
    setTitle();
  }

  // HOUSE-STYLE §1 / CONSUMERS.md page titles: "<detail> · Snowpack · MCO",
  // detail first (a tab truncates) and the SHORT family. This used to write
  // "Snowpack Explorer · <date> · Montana Climate Office" — the wrong short
  // name, the long family and the detail in the middle.
  function setTitle() {
    MCO.setPageTitle({ short: 'Snowpack', family: 'MCO', detail: currentDate });
  }
  setTitle();

  // ── Announcements ─────────────────────────────────────────────────────────
  // MCO.showToast owns the transient toast (and creates its own element).
  const showToast = MCO.showToast;

  // A pinned reading is an answer to a question — and the only route a
  // screen-reader user has to a gridded raster value at all — so it goes
  // through the page's one announcer, MCO.announce (kit 0.8.0). The toast that
  // shows the same text is kept out of the accessibility tree for it
  // ({announce: false}), or a screen reader heard every reading twice: once
  // from the toast's role=status and once from the old #sr-announce region.
  const pinReading = (msg) => {
    showToast(msg, undefined, { announce: false });
    MCO.announce(msg);
  };

  // ── Theme ─────────────────────────────────────────────────────────────────
  // MCO.initThemeToggle owns the icon swap, the aria-label, and persistence to
  // the shared mco-theme key.
  MCO.initThemeToggle({
    button:   document.getElementById('btn-theme'),
    iconSun:  document.getElementById('icon-sun'),
    iconMoon: document.getElementById('icon-moon'),
    // 3-state (kit 0.10.0): dark → light → high contrast, so high contrast is
    // reachable from the page, not only via ?theme= or storage. The icon and
    // aria-label name the theme a press switches TO.
    cycle: true,
    iconContrast: document.getElementById('icon-contrast'),
  });
  // Any theme flip — this button or anything else calling MCO.setTheme —
  // restyles the basemap (kit 0.9.0 event; was the toggle's onChange, which
  // only saw this one button). The style.load listener below re-adds the
  // data layers, so the listener only swaps the style. MapLibre has been
  // awaited above, and the map exists before any user can flip the theme.
  document.addEventListener('mco:themechange', () => map.setStyle(MCO.map.cartoStyleUrl()));

  // ── Legend ────────────────────────────────────────────────────────────────
  const legendRowsEl = document.getElementById('legend-rows');
  for (let i = 0; i < BREAKS.length; i++) {
    const lo  = BREAKS[i];
    const hi  = i + 1 < BREAKS.length ? BREAKS[i + 1] : null;
    const lbl = lo === 0 ? `< ${hi}` : hi === null ? `≥ ${lo}` : `${lo}–${hi}`;
    const row    = document.createElement('div');
    row.className = 'legend-row';
    const swatch = document.createElement('div');
    swatch.className = 'legend-swatch';
    const [r, g, b] = COLORS[i];
    swatch.style.background = `rgb(${r},${g},${b})`;
    const label = document.createElement('div');
    label.className = 'legend-lbl';
    // "D4 — Exceptional drought · < 2" — category first, because that is the
    // part that survives greyscale and CVD; the percentile range qualifies it.
    label.innerHTML = `<span class="legend-cat">${MCO.escapeHTML(CATEGORIES[i])}</span>`
                    + `<span class="legend-range">${MCO.escapeHTML(lbl)}</span>`;
    row.appendChild(swatch);
    row.appendChild(label);
    legendRowsEl.appendChild(row);
  }

  // ── Legend toggle ─────────────────────────────────────────────────────────
  const legendEl     = document.getElementById('legend');
  const legendToggle = document.getElementById('legend-toggle-btn');

  function setLegendCollapsed(collapsed) {
    legendEl.classList.toggle('collapsed', collapsed);
    legendToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    legendToggle.setAttribute('aria-label',    collapsed ? 'Expand legend' : 'Collapse legend');
  }

  if (window.innerWidth <= 640) setLegendCollapsed(true);
  legendToggle.addEventListener('click', () =>
    setLegendCollapsed(!legendEl.classList.contains('collapsed')));

  // ── Provenance ────────────────────────────────────────────────────────────
  const _provenanceCache = new Map(); // `${date}_${method}` → provenance object

  async function fetchProvenance(d, m) {
    const key = `${d}_${m}`;
    if (_provenanceCache.has(key)) return _provenanceCache.get(key);
    try {
      const res = await fetch(provenanceUrl(d, m));
      if (!res.ok) return null;
      const prov = await res.json();
      _provenanceCache.set(key, prov);
      return prov;
    } catch { return null; }
  }

  function updateLegendMeta(prov) {
    document.getElementById('legend-sub').textContent =
      { zig: 'ZIG', ecdf: 'ECDF' }[currentMethod] || '';
    const el = document.getElementById('legend-meta');
    if (!prov) { el.textContent = ''; return; }
    const years    = prov.reference_dates.map(d => d.slice(0, 4));
    const refRange = `${years[0]}\u2013${years[years.length - 1]}`;
    el.innerHTML   = `${formatDate(prov.normals_date)}<br>${refRange}`;
  }

  fetchProvenance(currentDate, currentMethod).then(updateLegendMeta);

  // ── Map ───────────────────────────────────────────────────────────────────
  // No API keys here any more. The basemap moved from Stadia to the kit's
  // keyless CARTO and the hillshade from MapTiler terrain-rgb to the kit's
  // keyless AWS terrarium DEM, which retired both credentials this static site
  // used to ship to every visitor. The old keys are still in git history and
  // should be revoked at the vendors.
  const COG_BOUNDS     = [[-124.733, 24.95], [-66.94, 52.875]];
  const FIT_OPTS       = { padding: 20 };
  let _fitZoom;


  // Pre-fetch COG metadata in parallel with the Stadia style loading
  CogProtocol.preload(cogUrl(currentDate));

  const map = new maplibregl.Map({
    container: 'map',
    style: MCO.map.cartoStyleUrl(),
    ...(_hasInitPos
      ? { center: [_initLng, _initLat], zoom: _initZoom }
      : { bounds: COG_BOUNDS, fitBoundsOptions: FIT_OPTS }),
    canvasContextAttributes: { preserveDrawingBuffer: true }, // required for PNG export (MapLibre ≥ 5 option; unchanged in 6)
  });

  // House navigation (MCO.map.addNavigation): zoom buttons, top-right, no
  // compass — rotation isn't a feature here, and a compass that never turns
  // is one more tab stop and touch target of noise (settled precedent).
  MCO.map.addNavigation(map);
  // …so rotation goes too, or a rotated map would have no way back north.
  map.dragRotate.disable();
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();

  // A dead basemap no longer leaves a blank page (kit 0.8.0): the style is
  // retried, then replaced by the kit's blank style (which loads, so the data
  // still draws) with a Retry notice.
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

  // Add custom sources and layers in the correct z-order.
  // Called on initial load and after each basemap style swap.
  function addCustomLayers() {
    const before = map.getStyle().layers.find(l => l.type === 'symbol')?.id;

    // Hillshade — the kit's keyless AWS terrarium DEM with per-theme paints
    // (including high-contrast, which this page previously had no values for).
    // Keeps the layer id 'hillshade' so the huc-fill insertion anchor below
    // still resolves, and the same beforeId so the stack order is unchanged.
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
        paint: { 'line-color': '#333', 'line-width': 0.7, 'line-opacity': 0.7 },
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
    map.setLayoutProperty('huc-fill', 'visibility', zonalVis);
    map.setLayoutProperty('huc-line', 'visibility', zonalVis);
  }

  map.on('load', async () => {
    _fitZoom = map.cameraForBounds(COG_BOUNDS, FIT_OPTS).zoom;

    // Validate initial date — today's data may not be processed yet.
    if (!(await cogExists(currentDate))) {
      const fallback = await findLatestAvailable(currentDate);
      if (fallback) {
        currentDate = fallback;
        dateInput.value = currentDate;
        showToast(`Showing latest available: ${currentDate}`);
      } else {
        showToast('No recent SNODAS data found');
      }
      pushState();
      stepper.refresh();   // the fallback moved the date off its upper bound
    }

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

    // Push position/zoom to URL on every pan or zoom
    map.on('moveend', pushState);

    _mapReady = true;

    // First meaningful state: the first data layer has drawn. Releases the
    // kit's html.mco-booting first-paint hold (kit 0.9.0); the anti-flash
    // snippet's 3 s timeout releases it anyway if this never resolves.
    _initReady.then(() => MCO.ready(), () => MCO.ready());

    // URL-triggered export: fire only after the data layer is ready
    if (urlParams.get('export') === 'true') {
      _initReady.then(exportMap);
    }
  });

  let _mapReady = false;
  map.on('zoomend', () => {
    if (_mapReady && _fitZoom !== undefined && map.getZoom() < _fitZoom) {
      map.fitBounds(COG_BOUNDS, { ...FIT_OPTS, animate: !MCO.reducedMotion() });
    }
  });

  // Update the COG raster tiles to a new date (no-op if source not yet added).
  function setSweLayer(d) {
    map.getSource('swe')?.setTiles([`cog://ptile/${cogUrl(d)}/{z}/{x}/{y}`]);
  }

  // Refresh whichever layers are active for the current date + method.
  function refreshLayers() {
    if (!map.loaded()) return;
    setSweLayer(currentDate);
    if (currentView === 'zonal') setHucLayer();
  }


  // ── Date picker ───────────────────────────────────────────────────────────
  const dateInput = document.getElementById('date-input');
  dateInput.min   = SNODAS_START;
  dateInput.max   = todayMT();
  dateInput.value = currentDate;

  async function setDate(dateStr) {
    let d = dateStr;
    if (d < SNODAS_START) { d = SNODAS_START; showToast(`Earliest available date: ${d}`); }
    if (d > todayMT())    { d = todayMT();     showToast(`No future dates available`); }
    if (d === currentDate) { dateInput.value = d; return; }

    if (!(await cogExists(d))) {
      const fallback = await findLatestAvailable(d);
      if (!fallback || fallback === currentDate) {
        showToast(`No SNODAS data found near ${d}`);
        dateInput.value = currentDate;
        return;
      }
      d = fallback;
      showToast(`Showing latest available: ${d}`);
    }

    currentDate = d;
    dateInput.value = currentDate;
    pushState();
    CogProtocol.preload(cogUrl(currentDate));
    refreshLayers();
    fetchProvenance(currentDate, currentMethod).then(updateLegendMeta);
    stepper.refresh();
  }

  dateInput.addEventListener('change', () => setDate(dateInput.value));

  // Date stepper — the kit's (0.9.0). The hand-rolled one listened only for
  // mousedown/touchstart, so Enter and Space on a focused stepper did nothing
  // (WCAG 2.1.1). MCO.initStepper steps on click (keyboard included), repeats
  // while a pointer is held, and disables a button at its bound. The new date
  // is announced, since the change is otherwise visible only on the map.
  const stepper = MCO.initStepper({
    prev: document.getElementById('btn-date-prev'),
    next: document.getElementById('btn-date-next'),
    onStep: (d) => {
      setDate(MCO.shiftDate(currentDate, d))
        .then(() => MCO.announce(`Showing ${formatDate(currentDate)}`));
    },
    canStep: (d) => (d < 0 ? currentDate > SNODAS_START : currentDate < todayMT()),
  });

  // ── Method toggle ─────────────────────────────────────────────────────────
  function setMethod(m) {
    currentMethod = m;
    document.querySelectorAll('[data-method]').forEach(btn =>
      btn.setAttribute('aria-pressed', btn.dataset.method === m ? 'true' : 'false'));
    pushState();
    CogProtocol.preload(cogUrl(currentDate, m));
    refreshLayers();
    fetchProvenance(currentDate, currentMethod).then(updateLegendMeta);
  }

  document.querySelectorAll('[data-method]').forEach(btn => {
    btn.setAttribute('aria-pressed', btn.dataset.method === currentMethod ? 'true' : 'false');
    btn.addEventListener('click', () => setMethod(btn.dataset.method));
  });

  // ── HUC zonal layers ──────────────────────────────────────────────────────
  const _fgbCache   = new Map(); // level → GeoJSON features array (with id field)
  const _zonalCache = new Map(); // `${date}_${method}` → Map<zone, ptile>
  let _hucSourceLevel = null;    // which level is currently loaded into the 'huc' source

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

  // Preload all FGB boundary files into memory + Cache API in the background
  function preloadFgb() {
    for (const lvl of [2, 4, 6, 8]) {
      if (_fgbCache.has(lvl)) continue;
      (async () => {
        try {
          const res = await fetchCached(fgbUrl(lvl));
          if (!res.ok) return;
          const features = [];
          for await (const f of flatgeobuf.deserialize(res.body))
            features.push({ ...f, id: f.properties.huc });
          _fgbCache.set(lvl, features);
        } catch { /* silent — will retry on demand */ }
      })();
    }
  }

  async function setHucLayer() {
    if (!map.getSource('huc')) return;
    try {
      // ── Step 1: load FGB geometry (once per level, persisted in Cache API + memory) ──
      if (!_fgbCache.has(currentHucLevel)) {
        const res = await fetchCached(fgbUrl(currentHucLevel));
        if (!res.ok) throw new Error(`FGB fetch failed: ${res.status}`);
        const features = [];
        for await (const f of flatgeobuf.deserialize(res.body))
          features.push({ ...f, id: f.properties.huc });
        _fgbCache.set(currentHucLevel, features);
      }

      // ── Step 2: push geometry to source only when the level changes ──
      if (_hucSourceLevel !== currentHucLevel) {
        map.getSource('huc').setData({
          type: 'FeatureCollection',
          features: _fgbCache.get(currentHucLevel),
        });
        _hucSourceLevel = currentHucLevel;
      }

      // ── Step 3: load parquet lookup (small — cached in memory) ──
      const key = `${currentDate}_${currentMethod}`;
      if (!_zonalCache.has(key)) {
        const res = await fetch(zonalUrl(currentDate, currentMethod));
        if (!res.ok) throw new Error(`Parquet fetch failed: ${res.status}`);
        const ab = await res.arrayBuffer();
        const lookup = new Map();
        await parquetRead({
          file: ab,
          columns: ['zone', 'swe_ptile'],
          compressors: { ZSTD: (input, _len) => fzstd.decompress(input) },
          onComplete: rows => {
            for (const [zone, ptile] of rows)
              if (zone != null) lookup.set(String(zone), ptile ?? null);
          },
        });
        _zonalCache.set(key, lookup);
      }

      // ── Step 4: push swe_ptile as feature state (no geometry re-upload) ──
      const zonalData = _zonalCache.get(key);
      const rows = [];
      for (const f of _fgbCache.get(currentHucLevel)) {
        const ptile = zonalData.get(String(f.properties.huc)) ?? null;
        map.setFeatureState({ source: 'huc', id: f.id }, { swe_ptile: ptile });
        rows.push({ id: String(f.properties.huc), name: f.properties.name, huc: f.properties.huc, ptile });
      }
      renderTwin(rows);

      map.setLayoutProperty('huc-fill', 'visibility', 'visible');
      map.setLayoutProperty('huc-line', 'visibility', 'visible');
      map.setLayoutProperty('swe',      'visibility', 'none');
    } catch (err) {
      console.error('[setHucLayer]', err);
      showToast('Failed to load basin data');
    }
  }

  // ── Table twin (HOUSE-STYLE §5.2) ─────────────────────────────────────────
  // The zonal view is canvas data: the twin gives a screen-reader user every
  // drawn watershed and its percentile (the kit caps it at 500 rows; HUC8 has
  // more, and the overflow row says so). The gridded raster has no tabular
  // form — its AT path is the click-to-pin reading — so the twin is empty
  // there and the map's label says which applies.
  const mapEl = document.getElementById('map');
  const twin = MCO.srTable({
    caption: 'Watershed SWE percentiles',
    columns: [
      { key: 'name', label: 'Watershed', rowHeader: true },
      { key: 'huc', label: 'HUC code' },
      { key: 'ptile', label: 'SWE percentile', value: (r) => (r.ptile == null ? 'no data' : ordinal(Math.round(r.ptile))) },
    ],
    overflowText: (n) => `…and ${n} more watersheds. Choose a coarser HUC level to list them all.`,
  });
  function renderTwin(rows) {
    if (rows) rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    twin.render(rows || []);
    const methodLabel = { zig: 'ZIG', ecdf: 'ECDF' }[currentMethod];
    twin.element.querySelector('caption').textContent = rows
      ? `Watershed SWE percentiles, HUC${currentHucLevel}, ${currentDate}, ${methodLabel} (${rows.length})`
      : 'Watershed SWE percentiles: shown in the zonal view only (0)';
    mapEl.setAttribute('aria-label', rows
      ? `SWE percentile map, zonal view, HUC${currentHucLevel}. The data is in the table that follows.`
      : 'SWE percentile map, gridded view. Click or tap the map to hear the percentile at that point.');
  }
  if (currentView !== 'zonal') renderTwin(null);

  function setHucLevel(lvl) {
    currentHucLevel = lvl;
    document.querySelectorAll('[data-huc]').forEach(btn =>
      btn.setAttribute('aria-pressed', parseInt(btn.dataset.huc) === lvl ? 'true' : 'false'));
    pushState();
    if (map.loaded()) setHucLayer();
  }

  function setView(v) {
    currentView = v;
    document.querySelectorAll('[data-view]').forEach(btn =>
      btn.setAttribute('aria-pressed', btn.dataset.view === v ? 'true' : 'false'));
    document.getElementById('huc-level-group').style.display = v === 'zonal' ? '' : 'none';
    pushState();
    if (!map.loaded()) return;
    if (v === 'gridded') {
      renderTwin(null);
      map.setLayoutProperty('swe',      'visibility', 'visible');
      map.setLayoutProperty('huc-fill', 'visibility', 'none');
      map.setLayoutProperty('huc-line', 'visibility', 'none');
    } else {
      setHucLayer(); // hides swe only after a successful load
    }
  }

  // Wire up all segmented toggles and sync initial aria-pressed state
  document.querySelectorAll('[data-view]').forEach(btn => {
    btn.setAttribute('aria-pressed', btn.dataset.view === currentView ? 'true' : 'false');
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });
  document.getElementById('huc-level-group').style.display = currentView === 'zonal' ? '' : 'none';
  document.querySelectorAll('[data-huc]').forEach(btn => {
    btn.setAttribute('aria-pressed', parseInt(btn.dataset.huc) === currentHucLevel ? 'true' : 'false');
    btn.addEventListener('click', () => setHucLevel(parseInt(btn.dataset.huc)));
  });

  // ── Hover tooltip ─────────────────────────────────────────────────────────
  const tooltip = document.getElementById('tooltip');
  let _hoverSeq = 0;

  function showTooltip(text, e) {
    tooltip.textContent = text;
    tooltip.classList.add('visible');
    tooltip.style.left = `${e.originalEvent.clientX + 14}px`;
    tooltip.style.top  = `${e.originalEvent.clientY + 14}px`;
  }

  map.on('mousemove', async (e) => {
    const seq = ++_hoverSeq;

    // In zonal view, prefer the HUC feature name + percentile (synchronous)
    if (currentView === 'zonal') {
      const hits = map.queryRenderedFeatures(e.point, { layers: ['huc-fill'] });
      if (hits.length > 0) {
        if (seq !== _hoverSeq) return;
        const { name, huc } = hits[0].properties;
        const label = name || `HUC${currentHucLevel} ${huc}`;
        const zonalKey = `${currentDate}_${currentMethod}`;
        const ptile = _zonalCache.has(zonalKey)
          ? (_zonalCache.get(zonalKey).get(String(huc)) ?? null)
          : null;
        showTooltip(ptile != null ? `${label}: ${ordinal(Math.round(ptile))} percentile` : label, e);
        return;
      }
    }

    // Fall back to raster pixel query (async)
    const value = await CogProtocol.queryValue(cogUrl(currentDate), e.lngLat.lng, e.lngLat.lat);
    if (seq !== _hoverSeq) return;
    if (value == null) tooltip.classList.remove('visible');
    else showTooltip(`${ordinal(value)} percentile`, e);
  });

  map.on('mouseout', () => tooltip.classList.remove('visible'));

  // Tap feedback for touch devices in zonal view
  // Click or tap pins a reading and announces it. Previously this only fired in
  // zonal view, which left the GRIDDED raster reachable by hover alone — no
  // touch path and nothing for assistive tech, since a hover tooltip is never
  // surfaced. The same gesture now answers in both views.
  map.on('click', async (e) => {
    if (currentView === 'zonal') {
      const hits = map.queryRenderedFeatures(e.point, { layers: ['huc-fill'] });
      if (!hits.length) return;
      const { name, huc } = hits[0].properties;
      const label    = name || `HUC${currentHucLevel} ${huc}`;
      const zonalKey = `${currentDate}_${currentMethod}`;
      const ptile    = _zonalCache.has(zonalKey)
        ? (_zonalCache.get(zonalKey).get(String(huc)) ?? null)
        : null;
      const msg = ptile != null
        ? `${label}: ${ordinal(Math.round(ptile))} percentile`
        : `${label}: no data`;
      pinReading(msg);
      return;
    }

    // Gridded view: sample the pixel under the pointer.
    const value = await CogProtocol.queryValue(cogUrl(currentDate), e.lngLat.lng, e.lngLat.lat);
    const where = `${Math.abs(e.lngLat.lat).toFixed(2)}°${e.lngLat.lat >= 0 ? 'N' : 'S'}, `
                + `${Math.abs(e.lngLat.lng).toFixed(2)}°${e.lngLat.lng >= 0 ? 'E' : 'W'}`;
    const msg = value == null
      ? `No snowpack data at ${where}`
      : `${ordinal(value)} percentile at ${where}`;
    pinReading(msg);
  });

  // ── Share ─────────────────────────────────────────────────────────────────
  document.getElementById('btn-share').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      showToast('Link copied to clipboard!');
    } catch {
      showToast('Could not copy — try selecting the URL bar directly');
    }
  });

  // ── Export ────────────────────────────────────────────────────────────────
  // HOUSE-STYLE §1 Logo (kit 0.11.0): exports draw the WORDMARK from the
  // pinned kit tag, CORS-loaded (jsDelivr sends ACAO: *) so the canvas stays
  // exportable; img-src already allows cdn.jsdelivr.net. The fixed-color twin
  // is picked by the EXPORT's background, not the page theme.
  const KIT_ASSETS = 'https://cdn.jsdelivr.net/gh/mt-climate-office/mco-web-style@0.11.1/assets';
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
    // Chrome colors and fonts from the live theme (MCO.chartTokens, kit 0.9.0)
    // instead of hand-copied hexes. The copies knew two themes, so a
    // high-contrast export came out in the dark palette. Bands are the
    // surface tone; the rules are the brand --accent (a fill, so allowed).
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
    const methodLabel = { zig: 'ZIG', ecdf: 'ECDF' }[currentMethod];

    ctx.fillStyle = C.text;
    ctx.font = `600 ${px(14)}px ${UI}`;
    ctx.fillText('Snowpack Explorer', textX, TITLE_H * 0.42);

    ctx.fillStyle = C.muted;
    ctx.font = `400 ${px(10)}px ${UI}`;
    ctx.fillText(`${currentDate} · ${methodLabel} · ${viewLabel}`, textX, TITLE_H * 0.78);

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

    const prov  = await fetchProvenance(currentDate, currentMethod);
    const midFY = footY + FOOT_H / 2;
    ctx.textBaseline = 'middle';

    // Left: title + method + date + ref period
    ctx.fillStyle = C.text;
    ctx.font = `600 ${px(9)}px ${UI}`;
    ctx.fillText(`SWE PERCENTILE · ${methodLabel}`, PAD, midFY - px(14));
    if (prov) {
      const years = prov.reference_dates.map(d => d.slice(0, 4));
      ctx.fillStyle = C.muted;
      ctx.font = `400 ${px(7.5)}px ${MONO}`;
      ctx.fillText(formatDate(prov.normals_date), PAD, midFY);
      ctx.fillText(`${years[0]}\u2013${years[years.length - 1]}`, PAD, midFY + px(14));
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
      const lbl = lo === 0 ? `< ${hi}` : hi === null ? `\u2265 ${lo}` : `${lo}\u2013${hi}`;
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

  document.getElementById('btn-export').addEventListener('click', exportMap);

  // ── Nav rail (kit 0.10.0) ─────────────────────────────────────────────────
  // Landscape phones: the bar becomes a left rail; its menu button opens the
  // drawer with the controls (focus in, page inert, Esc / scrim back to it).
  const rail = MCO.initNavRail({
    toggle: document.getElementById('btn-rail-menu'),
    drawer: document.getElementById('nav-drawer'),
    scrim:  document.getElementById('rail-scrim'),
  });

  // ── Info modal ────────────────────────────────────────────────────────────
  const infoModal = document.getElementById('info-modal');

  let _infoOpener = null;
  document.getElementById('btn-info').addEventListener('click', () => {
    _infoOpener = document.activeElement;
    // In rail mode the info button lives in the nav drawer, which makes the
    // rest of the page inert while open: close it first (focus does not go
    // back to the toggle — the dialog takes it), and return focus to the
    // rail's menu button, since the closed drawer's buttons are display:none.
    if (rail.isOpen()) {
      rail.close({ restoreFocus: false });
      _infoOpener = document.getElementById('btn-rail-menu');
    }
    infoModal.showModal();
  });
  document.getElementById('btn-info-close').addEventListener('click', () => infoModal.close());
  infoModal.addEventListener('click', (e) => { if (e.target === infoModal) infoModal.close(); });
  infoModal.addEventListener('keydown', (e) => { if (e.key === 'Escape') infoModal.close(); });
  infoModal.addEventListener('close', () => { _infoOpener?.focus(); _infoOpener = null; });

  // Show on first visit
  try {
    if (!MCO.lsGet('mco-snodas-info-seen')) {
      infoModal.showModal();
      MCO.lsSet('mco-snodas-info-seen', '1');
    }
  } catch {}

  // ── Provenance modal ──────────────────────────────────────────────────────
  const provenanceModal = document.getElementById('provenance-modal');

  const FLAVOR_DESC = {
    zig:  'Percentiles are estimated using a zero-inflated gamma distribution fit by L-moments, which smooths over sparse historical records and can extrapolate beyond observed extremes.',
    ecdf: 'Percentiles are estimated by linearly interpolating the empirical CDF of positive reference-year values, making no distributional assumptions beyond the observed data.',
  };

  function showProvenance(prov) {
    if (!prov) return;
    const methodLabel = { zig: 'ZIG', ecdf: 'ECDF' }[prov.flavor] || prov.flavor;
    document.getElementById('provenance-modal-subtitle').textContent =
      `${formatDate(prov.normals_date)} · ${methodLabel}`;

    const years    = prov.reference_dates.map(d => d.slice(0, 4));
    const refRange = `${years[0]}\u2013${years[years.length - 1]}`;
    const computedAt = new Date(prov.computed_at).toLocaleString('en-US', {
      month: 'long', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    });
    const datesHtml = prov.reference_dates
      .map(d => `<span>${formatDate(d)}</span>`).join('');

    const hucDesc = currentView === 'zonal'
      ? `Watershed boundaries are from the <a href="https://www.usgs.gov/national-hydrography/watershed-boundary-dataset" target="_blank" rel="noopener">USGS Watershed Boundary Dataset</a> (WBD), aggregated to HUC${currentHucLevel}.`
      : `Watershed boundaries are from the <a href="https://www.usgs.gov/national-hydrography/watershed-boundary-dataset" target="_blank" rel="noopener">USGS Watershed Boundary Dataset</a> (WBD), available at HUC levels 2, 4, 6, and 8.`;

    document.getElementById('provenance-content').innerHTML = `
      <div class="info-section">
        <h3>Gridded data</h3>
        <p><a href="https://nsidc.org/data/g02158" target="_blank" rel="noopener">NOAA SNODAS</a> (Snow Data Assimilation System) provides daily ~1&thinsp;km gridded Snow Water Equivalent estimates for the contiguous United States, available from 2004 to present.</p>
      </div>
      <div class="info-section">
        <h3>Zonal data</h3>
        <p>${hucDesc}</p>
      </div>
      <div class="info-section">
        <h3>${methodLabel} method</h3>
        <p>${FLAVOR_DESC[prov.flavor] || ''}</p>
      </div>
      <div class="info-section">
        <h3>Reference period</h3>
        <p>${prov.n_reference_years} SNODAS dates spanning ${refRange}.</p>
      </div>
      <div class="info-section">
        <h3>Reference dates</h3>
        <div class="provenance-dates">${datesHtml}</div>
      </div>
      <div class="info-section">
        <h3>Computed</h3>
        <p>${computedAt}</p>
      </div>`;

    provenanceModal.showModal();
  }

  let _provenanceOpener = null;
  document.getElementById('legend-info-btn').addEventListener('click', () => {
    _provenanceOpener = document.activeElement;
    fetchProvenance(currentDate, currentMethod).then(showProvenance);
  });
  document.getElementById('btn-provenance-close').addEventListener('click', () => provenanceModal.close());
  provenanceModal.addEventListener('click', (e) => { if (e.target === provenanceModal) provenanceModal.close(); });
  provenanceModal.addEventListener('close', () => { _provenanceOpener?.focus(); _provenanceOpener = null; });


})().catch(e => console.error('[init]', e));
