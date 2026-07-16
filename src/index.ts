interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * SEPTA MCP — Philadelphia SEPTA real-time transit (www3.septa.org/api, keyless)
 *
 * Tools:
 * - septa_rail_arrivals: regional rail departures board at a station
 * - septa_next_to_arrive: next trains from origin to destination (with connections)
 * - septa_train_view: all live regional-rail trains with position + lateness
 * - septa_bus_positions: live bus/trolley vehicle positions for a route
 * - septa_alerts: system service alerts, advisories, and detours by route
 *
 * API quirks (probed live 2026-07-15):
 * - Arrivals responds with ONE dynamic top-level key like
 *   "Ardmore Departures: July 15, 2026, 6:54 pm" — parse via Object.entries.
 * - Station names are strict (case-sensitive, exact): "suburban station" and
 *   "Suburban" both error. We resolve user input against the embedded
 *   station list (exact → alias → substring → edit-distance) before calling.
 * - Alerts route ids: bus_route_<n>, trolley_route_<n> (LEGACY numbers),
 *   rr_route_<code> (pao, trent, wtren, warm, wilm, med, nor, landdoy, apt,
 *   che, chw, cyn, fxc, gc), rr_route_bsl / rr_route_mfl / rr_route_nhsl for
 *   the subways, plus "generic" for system-wide.
 * - TransitView requires SEPTA Metro trolley codes (T1..T5, G1, D1, D2);
 *   legacy trolley numbers return a bare []. Unknown routes also return [].
 */


const BASE_URL = 'https://www3.septa.org/api';

// ── Regional Rail station list ──────────────────────────────────────
// Every name below was verified against the live Arrivals API (2026-07-15).
// The API requires an exact match, so user input is fuzzy-resolved to one
// of these canonical names.
const STATIONS: string[] = [
  // Center City + trunk
  'Gray 30th Street', 'Suburban Station', 'Jefferson Station', 'Temple University',
  'Wayne Junction', 'Fern Rock TC', 'North Broad', 'North Philadelphia',
  // Airport Line
  'Airport Terminal E-F', 'Airport Terminal C-D', 'Airport Terminal B',
  'Airport Terminal A', 'Eastwick',
  // Manayunk/Norristown Line
  'Allegheny', 'East Falls', 'Wissahickon', 'Manayunk', 'Ivy Ridge', 'Miquon',
  'Spring Mill', 'Conshohocken', 'Norristown Elm Street', 'Main Street', 'Norristown TC',
  // Chestnut Hill East Line
  'Wister', 'Germantown', 'Washington Lane', 'Stenton', 'Sedgwick', 'Mount Airy',
  'Wyndmoor', 'Gravers', 'Chestnut Hill East',
  // Chestnut Hill West Line
  'Queen Lane', 'Chelten Avenue', 'Tulpehocken', 'Upsal', 'Carpenter', 'Allen Lane',
  'St. Martins', 'Highland', 'Chestnut Hill West',
  // Cynwyd Line
  'Wynnefield Avenue', 'Bala', 'Cynwyd',
  // Fox Chase Line
  'Olney', 'Lawndale', 'Cheltenham', 'Ryers', 'Fox Chase',
  // Lansdale/Doylestown + Warminster Lines
  'Melrose Park', 'Elkins Park', 'Jenkintown-Wyncote', 'Glenside', 'Ardsley',
  'Roslyn', 'Crestmont', 'Willow Grove', 'Hatboro', 'Warminster', 'North Hills',
  'Oreland', 'Fort Washington', 'Ambler', 'Penllyn', 'Gwynedd Valley', 'North Wales',
  'Pennbrook', 'Lansdale', 'Fortuna', 'Colmar', 'Link Belt', 'Chalfont',
  'New Britain', 'Delaware Valley College', 'Doylestown',
  // Media/Wawa Line
  'Penn Medicine Station', '49th Street', 'Angora', 'Fernwood-Yeadon', 'Lansdowne',
  'Gladstone', 'Clifton-Aldan', 'Primos', 'Secane', 'Morton', 'Swarthmore',
  'Wallingford', 'Moylan-Rose Valley', 'Media', 'Elwyn', 'Wawa',
  // Paoli/Thorndale Line
  'Overbrook', 'Merion', 'Narberth', 'Wynnewood', 'Ardmore', 'Haverford',
  'Bryn Mawr', 'Rosemont', 'Villanova', 'Radnor', 'St. Davids', 'Wayne',
  'Strafford', 'Devon', 'Berwyn', 'Daylesford', 'Paoli', 'Malvern', 'Exton',
  'Whitford', 'Downingtown', 'Thorndale',
  // Trenton Line
  'Bridesburg', 'Tacony', 'Holmesburg Jct', 'Torresdale', 'Cornwells Heights',
  'Eddington', 'Croydon', 'Bristol', 'Levittown', 'Trenton',
  // West Trenton Line
  'Noble', 'Rydal', 'Meadowbrook', 'Bethayres', 'Philmont', 'Forest Hills',
  'Somerton', 'Trevose', 'Neshaminy Falls', 'Langhorne', 'Woodbourne', 'Yardley',
  'West Trenton',
  // Wilmington/Newark Line
  'Darby', 'Curtis Park', 'Sharon Hill', 'Folcroft', 'Glenolden', 'Norwood',
  'Prospect Park', 'Ridley Park', 'Crum Lynne', 'Eddystone', 'Chester TC',
  'Highland Avenue', 'Marcus Hook', 'Claymont', 'Wilmington', 'Churchmans Crossing',
  'Newark',
];

// Common alternate names → canonical station (keys are normalized: see norm()).
const STATION_ALIASES: Record<string, string> = {
  '30thstreet': 'Gray 30th Street',
  '30thstreetstation': 'Gray 30th Street',
  '30thst': 'Gray 30th Street',
  '30thststation': 'Gray 30th Street',
  'universitycity': 'Penn Medicine Station',
  'pennmedicine': 'Penn Medicine Station',
  'marketeast': 'Jefferson Station',
  'marketeaststation': 'Jefferson Station',
  'jefferson': 'Jefferson Station',
  'suburban': 'Suburban Station',
  'templeu': 'Temple University',
  'fernrock': 'Fern Rock TC',
  'fernrocktransportationcenter': 'Fern Rock TC',
  'norristowntransportationcenter': 'Norristown TC',
  'chestertransportationcenter': 'Chester TC',
  'phlairport': 'Airport Terminal E-F',
  'philadelphiaairport': 'Airport Terminal E-F',
  'philadelphiainternationalairport': 'Airport Terminal E-F',
  'airportterminalef': 'Airport Terminal E-F',
  'airportterminalcd': 'Airport Terminal C-D',
  'jenkintown': 'Jenkintown-Wyncote',
  'wyncote': 'Jenkintown-Wyncote',
};

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function editDistance(a: string, b: string): number {
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** Resolve loose user input ("ardmore", "30th street", "Suburban") to the
 *  exact station name the SEPTA API requires. Throws with suggestions when
 *  the input is ambiguous or unrecognized. */
function resolveStation(input: string, argName: string): string {
  const raw = (input ?? '').toString().trim();
  if (!raw) {
    throw new Error(
      `SEPTA: the \`${argName}\` argument is required — a Regional Rail station name, e.g. "Suburban Station", "Ardmore", "30th Street".`,
    );
  }
  const n = norm(raw);
  // 1. exact (normalized) match
  const exact = STATIONS.find((s) => norm(s) === n);
  if (exact) return exact;
  // 2. alias
  if (STATION_ALIASES[n]) return STATION_ALIASES[n];
  // 3. substring match
  let candidates = STATIONS.filter((s) => norm(s).includes(n) || n.includes(norm(s)));
  if (candidates.length > 1) {
    const starts = candidates.filter((s) => norm(s).startsWith(n));
    if (starts.length === 1) candidates = starts;
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw new Error(
      `SEPTA: "${raw}" matches multiple stations: ${candidates.join(', ')}. Pick one exact name for \`${argName}\`.`,
    );
  }
  // 4. edit distance (typo tolerance)
  const ranked = STATIONS
    .map((s) => ({ s, d: editDistance(norm(s), n) }))
    .sort((x, y) => x.d - y.d);
  if (ranked[0].d <= 2) return ranked[0].s;
  const suggestions = ranked.slice(0, 5).map((r) => r.s);
  throw new Error(
    `SEPTA: "${raw}" is not a recognized Regional Rail station for \`${argName}\`. Closest matches: ${suggestions.join(', ')}. Station names must be a SEPTA Regional Rail stop (buses and subways use septa_bus_positions / septa_alerts).`,
  );
}

// ── Alerts route-id resolution ──────────────────────────────────────
const RR_LINE_TO_ALERT_ID: Record<string, string> = {
  airport: 'rr_route_apt',
  chestnuthilleast: 'rr_route_che',
  chestnuthillwest: 'rr_route_chw',
  cynwyd: 'rr_route_cyn',
  foxchase: 'rr_route_fxc',
  lansdaledoylestown: 'rr_route_landdoy',
  lansdale: 'rr_route_landdoy',
  doylestown: 'rr_route_landdoy',
  mediawawa: 'rr_route_med',
  media: 'rr_route_med',
  wawa: 'rr_route_med',
  manayunknorristown: 'rr_route_nor',
  manayunk: 'rr_route_nor',
  norristown: 'rr_route_nor',
  paolithorndale: 'rr_route_pao',
  paoli: 'rr_route_pao',
  thorndale: 'rr_route_pao',
  trenton: 'rr_route_trent',
  warminster: 'rr_route_warm',
  wilmingtonnewark: 'rr_route_wilm',
  wilmington: 'rr_route_wilm',
  westtrenton: 'rr_route_wtren',
  glensidecombined: 'rr_route_gc',
  broadstreetline: 'rr_route_bsl',
  broadstreet: 'rr_route_bsl',
  bsl: 'rr_route_bsl',
  broadstreetowl: 'rr_route_bso',
  marketfrankfordline: 'rr_route_mfl',
  marketfrankford: 'rr_route_mfl',
  mfl: 'rr_route_mfl',
  marketfrankfordowl: 'rr_route_mfo',
  norristownhighspeedline: 'rr_route_nhsl',
  nhsl: 'rr_route_nhsl',
  cct: 'cct',
  system: 'generic',
  systemwide: 'generic',
  generic: 'generic',
};

// SEPTA trolley routes by legacy number (everything else numeric is a bus).
const TROLLEY_ROUTES = new Set(['10', '11', '13', '34', '36', '101', '102']);

// SEPTA Metro (2024 rebrand) trolley codes → legacy route numbers.
// TransitView requires the NEW codes (T1..T5, G1, D1, D2); the Alerts feed
// still uses the LEGACY numbers (trolley_route_10 etc.). Verified live
// 2026-07-15 by matching vehicle destinations (T1→63rd-Malvern = old 10, ...).
const METRO_TO_LEGACY: Record<string, string> = {
  T1: '10', T2: '34', T3: '13', T4: '11', T5: '36',
  G1: '15', D1: '101', D2: '102',
};
const LEGACY_TO_METRO: Record<string, string> = Object.fromEntries(
  Object.entries(METRO_TO_LEGACY).map(([m, l]) => [l, m]),
);

/** Map friendly route input ("paoli/thorndale", "23", "T1", "bus_route_23",
 *  "MFL") to a SEPTA alerts route_id. */
function resolveAlertRouteId(input: string): string {
  const raw = input.trim();
  // Already a route_id
  if (/^(bus_route_|trolley_route_|rr_route_)/i.test(raw) || raw.toLowerCase() === 'generic' || raw.toLowerCase() === 'cct') {
    return raw.toLowerCase();
  }
  // SEPTA Metro trolley code ("T1", "D2", "G1") → legacy trolley number
  const metro = METRO_TO_LEGACY[raw.toUpperCase()];
  if (metro) {
    return TROLLEY_ROUTES.has(metro) ? `trolley_route_${metro}` : `bus_route_${metro}`;
  }
  // Bare bus/trolley route number ("23", "10", "route 47")
  const numMatch = raw.match(/^(?:route\s*)?(\d{1,3}[a-z]?)$/i);
  if (numMatch) {
    const num = numMatch[1].toUpperCase();
    return TROLLEY_ROUTES.has(num) ? `trolley_route_${num}` : `bus_route_${num}`;
  }
  const mapped = RR_LINE_TO_ALERT_ID[norm(raw)];
  if (mapped) return mapped;
  throw new Error(
    `SEPTA: unrecognized route "${raw}" for alerts. Use a bus/trolley number ("23", "10"), a Regional Rail line name ("Paoli/Thorndale", "West Trenton", "Airport"), a subway line ("Broad Street Line", "Market-Frankford Line", "NHSL"), or a raw route_id like "bus_route_23" / "rr_route_pao".`,
  );
}

// ── HTTP + shaping helpers ──────────────────────────────────────────

async function septaFetch(path: string, params?: Record<string, string>): Promise<unknown> {
  const qs = params ? `?${new URLSearchParams(params)}` : '';
  const res = await fetch(`${BASE_URL}/${path}${qs}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(
      `SEPTA API error: HTTP ${res.status} on ${path}. The SEPTA real-time feed is occasionally flaky — retry once, and check septa_alerts for system-wide disruptions.`,
    );
  }
  const data = (await res.json()) as unknown;
  const err = (data as Record<string, unknown>)?.error;
  if (err && typeof err === 'string') {
    throw new Error(`SEPTA API error: ${err}`);
  }
  return data;
}

/** Strip HTML tags/entities from SEPTA alert bodies into readable plain text. */
function stripHtml(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

interface ArrivalRecord {
  direction: string;
  path: string;
  train_id: string;
  origin: string;
  destination: string;
  line: string;
  status: string;
  service_type: string;
  next_station: string | null;
  sched_time: string;
  depart_time: string;
  track: string;
  track_change: string | null;
  platform: string;
  platform_change: string | null;
}

function shapeArrival(t: ArrivalRecord) {
  return {
    train_id: t.train_id,
    line: t.line,
    origin: t.origin,
    destination: t.destination,
    sched_time: t.sched_time,
    depart_time: t.depart_time,
    status: t.status, // "On Time" or minutes late like "5 min"
    service_type: t.service_type,
    next_station: t.next_station,
    track: t.track,
    track_change: t.track_change,
    platform: t.platform || null,
  };
}

// ── Tool implementations ────────────────────────────────────────────

async function railArrivals(args: Record<string, unknown>) {
  const station = resolveStation(
    (args.station as string) ?? (args.stop as string) ?? '',
    'station',
  );
  const results = Math.min(Math.max(Number(args.results) || 8, 1), 30);
  const data = (await septaFetch('Arrivals/index.php', {
    station,
    results: String(results),
  })) as Record<string, Array<Record<string, ArrivalRecord[]>>>;

  // Response has ONE dynamic top-level key, e.g.
  // "Ardmore Departures: July 15, 2026, 6:54 pm" → [{Northbound: [...]}, {Southbound: [...]}]
  const [header, groups] = Object.entries(data)[0] ?? ['', []];
  const asOf = header.includes(':') ? header.slice(header.indexOf(':') + 1).trim() : header;
  const northbound: ReturnType<typeof shapeArrival>[] = [];
  const southbound: ReturnType<typeof shapeArrival>[] = [];
  for (const group of groups ?? []) {
    for (const [dir, trains] of Object.entries(group)) {
      const target = dir === 'Northbound' ? northbound : southbound;
      for (const t of trains ?? []) target.push(shapeArrival(t));
    }
  }
  const total = northbound.length + southbound.length;
  return {
    station,
    as_of: asOf,
    northbound,
    southbound,
    ...(total === 0
      ? { note: 'Zero upcoming departures reported — service may be finished for the night at this station.' }
      : {}),
  };
}

interface NtaRecord {
  orig_train: string;
  orig_line: string;
  orig_departure_time: string;
  orig_arrival_time: string;
  orig_delay: string;
  isdirect: string;
  term_train?: string;
  term_line?: string;
  term_depart_time?: string;
  term_arrival_time?: string;
  term_delay?: string;
  Connection?: string;
}

async function nextToArrive(args: Record<string, unknown>) {
  const orig = resolveStation(
    (args.orig as string) ?? (args.origin as string) ?? (args.from as string) ?? '',
    'orig',
  );
  const dest = resolveStation(
    (args.dest as string) ?? (args.destination as string) ?? (args.to as string) ?? '',
    'dest',
  );
  const n = Math.min(Math.max(Number(args.n) || 3, 1), 10);
  const data = (await septaFetch('NextToArrive/index.php', {
    req1: orig,
    req2: dest,
    req3: String(n),
  })) as NtaRecord[];

  return {
    origin: orig,
    destination: dest,
    trains: (data ?? []).map((t) => ({
      train_id: t.orig_train,
      line: t.orig_line,
      departure_time: t.orig_departure_time,
      arrival_time: t.orig_arrival_time,
      delay: t.orig_delay, // "On time" or e.g. "5 mins"
      direct: t.isdirect === 'true',
      ...(t.isdirect === 'true'
        ? {}
        : {
            connection_station: t.Connection,
            connecting_train_id: t.term_train,
            connecting_line: t.term_line,
            connecting_departure_time: t.term_depart_time,
            final_arrival_time: t.term_arrival_time,
            connecting_delay: t.term_delay,
          }),
    })),
    ...((data ?? []).length === 0
      ? { note: 'Zero upcoming trains found for this origin/destination pair right now.' }
      : {}),
  };
}

interface TrainViewRecord {
  lat: string;
  lon: string;
  trainno: string;
  service: string;
  dest: string;
  currentstop: string;
  nextstop: string;
  line: string;
  consist: string;
  heading: string | number;
  late: number;
  SOURCE: string;
  TRACK: string;
  TRACK_CHANGE: string;
}

async function trainView(args: Record<string, unknown>) {
  const data = (await septaFetch('TrainView/index.php')) as TrainViewRecord[];
  const lineFilter = args.line ? norm(String(args.line)) : null;
  const trains = (data ?? [])
    .filter((t) => !lineFilter || norm(t.line).includes(lineFilter) || lineFilter.includes(norm(t.line)))
    .map((t) => ({
      train_id: t.trainno,
      line: t.line,
      service: t.service, // "LOCAL" or e.g. "EXP TO JENKINTOWN"
      origin: t.SOURCE,
      destination: t.dest,
      current_stop: t.currentstop,
      next_stop: t.nextstop,
      late_minutes: t.late,
      status: t.late > 0 ? `${t.late} min late` : 'On time',
      lat: Number(t.lat),
      lon: Number(t.lon),
      track: t.TRACK,
      track_change: t.TRACK_CHANGE || null,
    }));
  if (lineFilter && trains.length === 0) {
    const lines = [...new Set((data ?? []).map((t) => t.line))].sort();
    return {
      count: 0,
      trains: [],
      note: `Zero live trains matched line "${args.line}". Lines with trains running right now: ${lines.join(', ')}.`,
    };
  }
  return { count: trains.length, trains };
}

interface BusRecord {
  lat: string;
  lng: string;
  label: string;
  route_id: string;
  trip: string;
  VehicleID: string;
  Direction: string;
  destination: string;
  heading: number;
  late: number;
  next_stop_id: string | null;
  next_stop_name: string | null;
  next_stop_sequence: number | null;
  estimated_seat_availability: string;
  timestamp: number;
}

async function busPositions(args: Record<string, unknown>) {
  let route = String(args.route ?? '').trim().replace(/^route\s*/i, '').toUpperCase();
  if (!route) {
    throw new Error(
      'SEPTA septa_bus_positions requires a `route` — a bus route number like "23" or "47", or a trolley code like "T1" (also accepts legacy trolley numbers "10", "34").',
    );
  }
  // TransitView requires SEPTA Metro trolley codes: translate legacy trolley
  // numbers (10→T1, 34→T2, 13→T3, 11→T4, 36→T5, 15→G1, 101→D1, 102→D2).
  if (LEGACY_TO_METRO[route]) route = LEGACY_TO_METRO[route];
  const data = (await septaFetch('TransitView/index.php', { route })) as
    | { bus?: BusRecord[] }
    | BusRecord[];
  // Unknown routes come back as a bare [] instead of {bus: [...]}.
  const raw = Array.isArray(data) ? [] : data.bus ?? [];
  const vehicles = raw.map((b) => ({
    vehicle_id: b.VehicleID,
    route: b.route_id,
    direction: b.Direction,
    destination: b.destination,
    next_stop: b.next_stop_name,
    late_minutes: b.late,
    status: b.late > 0 ? `${b.late} min late` : 'On time',
    seat_availability: b.estimated_seat_availability, // e.g. MANY_SEATS_AVAILABLE, CRUSHED_STANDING_ROOM_ONLY
    lat: Number(b.lat),
    lon: Number(b.lng),
    last_updated_unix: b.timestamp,
  }));
  return {
    route,
    count: vehicles.length,
    vehicles,
    ...(vehicles.length === 0
      ? { note: `Zero vehicles reporting on route "${route}" right now — either the route number is wrong or the route is between service hours. Trolleys use SEPTA Metro codes T1-T5, G1, D1, D2.` }
      : {}),
  };
}

interface AlertRecord {
  route: string;
  route_id: string;
  route_name: string;
  mode: string;
  isadvisory: string;
  isdetour: string;
  isalert: string;
  issuspended: string;
  isstrike: string;
  isdelays: string;
  last_updated: string;
  description: string;
  alert: string;
  advisory: string;
  detour: Array<{
    location_start?: string;
    location_end?: string;
    start?: string;
    end?: string;
    message?: string;
    reason?: string;
  }>;
}

function shapeAlert(a: AlertRecord) {
  return {
    route_id: a.route_id,
    route_name: a.route_name,
    mode: a.mode,
    route_description: a.description,
    has_alert: a.isalert === 'Y',
    has_advisory: a.isadvisory === 'Yes' || a.isadvisory === 'Y',
    has_detour: a.isdetour === 'Y',
    suspended: a.issuspended === 'Y',
    last_updated: a.last_updated,
    alert_text: a.alert ? stripHtml(a.alert) : null,
    advisory_text: a.advisory ? stripHtml(a.advisory).slice(0, 2000) : null,
    detours: (a.detour ?? []).map((d) => ({
      from: d.location_start,
      to: d.location_end,
      start: d.start,
      end: d.end,
      reason: d.reason,
      detour_route: d.message,
    })),
  };
}

function alertHasContent(a: AlertRecord): boolean {
  return (
    a.isalert === 'Y' ||
    a.isdetour === 'Y' ||
    a.issuspended === 'Y' ||
    a.isadvisory === 'Yes' ||
    a.isadvisory === 'Y' ||
    Boolean(a.alert) ||
    Boolean(a.advisory) ||
    (a.detour ?? []).length > 0
  );
}

async function alerts(args: Record<string, unknown>) {
  const routeInput = (args.route as string) ?? (args.route_id as string) ?? '';
  if (routeInput && String(routeInput).trim()) {
    const routeId = resolveAlertRouteId(String(routeInput));
    const data = (await septaFetch('Alerts/index.php', { req1: routeId })) as AlertRecord[];
    return {
      route_id: routeId,
      alerts: (data ?? []).map(shapeAlert),
      ...((data ?? []).length === 0
        ? { note: `Zero alert records returned for route_id "${routeId}" — verify the route id format (bus_route_23, trolley_route_10, rr_route_pao).` }
        : {}),
    };
  }
  // Route omitted → full system scan, return only routes with active content.
  const data = (await septaFetch('Alerts/index.php')) as AlertRecord[];
  const active = (data ?? []).filter(alertHasContent).map(shapeAlert);
  return {
    scope: 'all routes with an active alert, advisory, detour, or suspension',
    total_routes_checked: (data ?? []).length,
    active_count: active.length,
    alerts: active,
  };
}

// ── Tool definitions ────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'septa_rail_arrivals',
    description:
      'Philadelphia SEPTA Regional Rail departures board for a station — the next trains leaving, grouped Northbound/Southbound with train number, line, destination, scheduled vs estimated departure time, live status ("On Time" or minutes late), and track. Station names are matched forgivingly ("30th street", "ardmore", "suburban" all work). Example: septa_rail_arrivals({ station: "Suburban Station", results: 8 })',
    inputSchema: {
      type: 'object',
      properties: {
        station: {
          type: 'string',
          description:
            'Regional Rail station name, e.g. "Suburban Station", "Gray 30th Street" (accepts "30th Street"), "Temple University", "Ardmore", "Airport Terminal B". Partial names are fuzzy-matched to the official station list.',
        },
        results: {
          type: 'number',
          description: 'Departures to return per direction (default 8, max 30)',
        },
      },
      required: ['station'],
    },
  },
  {
    name: 'septa_next_to_arrive',
    description:
      'Next SEPTA Regional Rail trains from an origin station to a destination station in Philly — direct trains and connecting itineraries (with transfer station), departure/arrival times, and live delay status. Answers "when is the next train from X to Y" in Philadelphia. Example: septa_next_to_arrive({ orig: "Suburban Station", dest: "Airport Terminal B", n: 3 })',
    inputSchema: {
      type: 'object',
      properties: {
        orig: {
          type: 'string',
          description: 'Origin Regional Rail station, e.g. "Suburban Station", "Fox Chase" (fuzzy-matched)',
        },
        dest: {
          type: 'string',
          description: 'Destination Regional Rail station, e.g. "Airport Terminal B", "Ardmore" (fuzzy-matched)',
        },
        n: {
          type: 'number',
          description: 'How many upcoming trains to return (default 3, max 10)',
        },
      },
      required: ['orig', 'dest'],
    },
  },
  {
    name: 'septa_train_view',
    description:
      'Live positions of every SEPTA Regional Rail train currently running in the Philadelphia region — train number, line, destination, current and next stop, minutes late, and lat/lon. Answers "is my train late" and "where is train 456". Optionally filter to one line. Example: septa_train_view({ line: "Paoli/Thorndale" })',
    inputSchema: {
      type: 'object',
      properties: {
        line: {
          type: 'string',
          description:
            'Optional Regional Rail line filter: Airport, Chestnut Hill East, Chestnut Hill West, Cynwyd, Fox Chase, Lansdale/Doylestown, Manayunk/Norristown, Media/Wawa, Paoli/Thorndale, Trenton, Warminster, West Trenton, Wilmington/Newark. Omit for all live trains.',
        },
      },
      required: [],
    },
  },
  {
    name: 'septa_bus_positions',
    description:
      'Live SEPTA bus and trolley vehicle positions for a route in Philadelphia — each vehicle with direction, destination, next stop, minutes late, estimated seat availability (crowding), and lat/lon. Buses use route numbers ("23", "47"); trolleys use SEPTA Metro codes T1-T5, G1 (Girard), D1/D2 (Media/Sharon Hill) — legacy trolley numbers like "10" are auto-translated to T1. Example: septa_bus_positions({ route: "23" })',
    inputSchema: {
      type: 'object',
      properties: {
        route: {
          type: 'string',
          description:
            'Bus route number ("23", "47", "66") or trolley code ("T1"-"T5", "G1", "D1", "D2"; legacy trolley numbers 10/34/13/11/36/15/101/102 also accepted)',
        },
      },
      required: ['route'],
    },
  },
  {
    name: 'septa_alerts',
    description:
      'SEPTA service alerts, advisories, detours, and suspensions for Philadelphia transit. Pass a route to check one line: a bus number ("23"), a trolley ("T1" or legacy "10"), a Regional Rail line name ("Paoli/Thorndale", "West Trenton", "Airport"), a subway ("Broad Street Line", "Market-Frankford Line", "NHSL"), or a raw route_id ("bus_route_23", "trolley_route_10", "rr_route_pao"). Omit route to list every route with an active alert system-wide. Example: septa_alerts({ route: "Paoli/Thorndale" })',
    inputSchema: {
      type: 'object',
      properties: {
        route: {
          type: 'string',
          description:
            'Route to check. Bus number ("23"), trolley ("T1" or "10"), rail line name ("Media/Wawa", "Trenton"), subway ("MFL", "BSL", "NHSL"), or raw route_id ("rr_route_pao"). Omit for all active alerts.',
        },
      },
      required: [],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'septa_rail_arrivals':
      return railArrivals(args);
    case 'septa_next_to_arrive':
      return nextToArrive(args);
    case 'septa_train_view':
      return trainView(args);
    case 'septa_bus_positions':
      return busPositions(args);
    case 'septa_alerts':
      return alerts(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
