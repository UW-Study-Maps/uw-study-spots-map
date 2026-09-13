// Refreshes cached operating hours for every study spot from the Google
// Places API, three times a day in Madison local time (6am / 12pm / 6pm).
//
// This runs as its own Worker, separate from the uw-study-spots-map Pages
// project, because Cloudflare Pages Functions don't support Cron Triggers —
// only standalone Workers do. It writes into the same STUDY_SPOTS_KV
// namespace the Pages site's /api/spots already reads from (spot-override:
// records — see functions/_shared/spot-overrides.js there), so a refresh
// shows up on the live site and app with no redeploy needed.
//
// GOOGLE_MAPS_API_KEY must be set as a secret on this Worker
// (`npx wrangler secret put GOOGLE_MAPS_API_KEY`, from this directory) —
// the same value used for the app's map key is fine, since Places API and
// Maps SDK are billed/enabled independently on the same Google Cloud key.

const OVERRIDE_PREFIX = "spot-override:";
const SPOTS_URL = "https://uw-study-spots.com/api/spots";

// Building/department-level matches — Google has no separate listing for
// every room, floor, or outdoor area, so these show the containing
// building's hours instead, flagged in the UI as approximate. This is a
// one-time human judgment call about *listing granularity*, not something
// worth re-deriving from fuzzy name-matching on every run — see the
// September 2026 conversation that set this up for how each was decided.
const APPROX_IDS = new Set([
  "limnology-library",
  "hamel-browsing-library",
  "lakefront-lounge",
  "cs-6th-floor",
  "cs-patio",
  "chemistry-upper-floors",
  "education-5th-floor",
  "biochem-301",
  "biochem-kitchen",
  "soils-258",
  "badger-market",
  "engineering-computer-labs",
  "geo-sciences-picnic",
  "greenhouse-benches",
  "lakeshore-path"
]);

/** Current hour (0-23) in Madison local time, DST-aware via the IANA zone. */
function currentMadisonHour() {
  const formatted = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hour12: false,
    timeZone: "America/Chicago"
  }).format(new Date());
  // This formatter prints midnight as "24", not "0".
  return Number(formatted) % 24;
}

/**
 * Looks up one spot's hours. Returns undefined (meaning "leave it alone") on
 * any failure or no-match, so a bad API response never blanks out a spot
 * that was working before — only a confident result overwrites anything.
 */
async function lookupHours(spot, apiKey) {
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "places.regularOpeningHours.weekdayDescriptions,places.businessStatus"
    },
    body: JSON.stringify({ textQuery: `${spot.name}, ${spot.address}` })
  });
  if (!res.ok) return undefined;

  const data = await res.json();
  const place = data.places?.[0];
  if (!place) return undefined;

  // Never show hours for a place Google itself says is gone — an honest
  // "not listed" beats a fabricated schedule for a closed business.
  if (place.businessStatus === "CLOSED_PERMANENTLY") {
    return { hours: null, hoursApprox: false };
  }

  const hours = place.regularOpeningHours?.weekdayDescriptions ?? null;
  return { hours, hoursApprox: hours ? APPROX_IDS.has(spot.id) : false };
}

async function mergeOverride(env, spotId, patch) {
  const key = OVERRIDE_PREFIX + spotId;
  const raw = await env.STUDY_SPOTS_KV.get(key);
  const existing = raw ? JSON.parse(raw) : {};
  await env.STUDY_SPOTS_KV.put(key, JSON.stringify(Object.assign({}, existing, patch)));
}

async function refreshAll(env) {
  const spotsRes = await fetch(SPOTS_URL);
  if (!spotsRes.ok) return;
  const { spots } = await spotsRes.json();

  for (const spot of spots || []) {
    const result = await lookupHours(spot, env.GOOGLE_MAPS_API_KEY).catch(() => undefined);
    if (result !== undefined) {
      await mergeOverride(env, spot.id, result).catch(() => {});
    }
    // Small gap between requests — Places API rate-limits bursts, and there
    // is no rush across a handful of seconds for a job that runs every 6 hours.
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

export default {
  async scheduled(event, env, ctx) {
    if (![6, 12, 18].includes(currentMadisonHour())) return;
    ctx.waitUntil(refreshAll(env));
  }
};
