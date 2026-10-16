import { put, list, head, BlobNotFoundError } from "@vercel/blob";

const PLACE_FIELDS = ["id", "displayName", "formattedAddress", "location", "types", "googleMapsUri"];
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  Cookie: "SOCS=CAESEwgDEgk0ODE3Nzk3MjQaAmVuIAEaBgiA_LyaBg; CONSENT=YES+",
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "GET") {
    try {
      const places = await readAll();
      res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=300");
      return res.status(200).json(places);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Metodo non consentito" });
  }

  if (!process.env.API_TOKEN) {
    return res.status(500).json({ error: "API_TOKEN non configurato" });
  }

  if (req.headers.authorization !== `Bearer ${process.env.API_TOKEN}`) {
    return res.status(401).json({ error: "Non autorizzato" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body ?? {};
    const text = String(body.text ?? "");
    const note = body.note ? String(body.note) : null;
    const address = body.address ? String(body.address) : null;
    const lists = [body.list].flat().filter(Boolean).map(String);
    const savedAt = toIsoDate(body.saved_at);
    const link = body.url || text.match(/https?:\/\/\S+/)?.[0];
    const hint = link ? await parseMapsLink(link) : {};
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    if (!hint.coords && isValidCoords(lat, lng)) hint.coords = { lat, lng };
    if (!hint.placeId && (hint.featureId || hint.cid)) {
      const found = await lookupGooglePlace(hint.url);
      hint.placeId = found.placeId;
      hint.coords ??= found.coords;
    }

    const textQuery = text.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
    const query = hint.name || textQuery;
    let place = null;

    if (process.env.GOOGLE_MAPS_API_KEY) {
      if (hint.placeId) place = await getPlace(hint.placeId);
      if (!place && query) place = await findPlace(address ? `${query}, ${address}` : query, hint.coords);
    }

    let row;
    if (place) {
      row = {
        id: place.id,
        name: place.displayName?.text ?? query,
        address: place.formattedAddress ?? address,
        lat: place.location.latitude,
        lng: place.location.longitude,
        types: place.types ?? [],
        maps_url: place.googleMapsUri ?? link ?? null,
      };
    } else if (hint.coords) {
      row = {
        id: hint.placeId ?? `pin_${hint.coords.lat}_${hint.coords.lng}`,
        name: query || "Punto sulla mappa",
        address,
        lat: hint.coords.lat,
        lng: hint.coords.lng,
        types: [],
        maps_url: link ?? null,
      };
    } else {
      return res.status(422).json({ error: "Impossibile identificare il luogo", debug: { link, hint } });
    }

    const safeId = row.id.replace(/[^a-zA-Z0-9_.-]/g, "_");
    const pathname = `places/${safeId}.json`;
    const existing = await readPlace(pathname);
    row.note = note ?? existing?.note ?? null;
    row.lists = [...new Set([...(existing?.lists ?? []), ...lists])];
    row.created_at = [existing?.created_at, savedAt].filter(Boolean).sort()[0] ?? new Date().toISOString();
    row.updated_at = new Date().toISOString();

    await put(pathname, JSON.stringify(row), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 60,
    });

    return res.status(200).json(row);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

async function readAll() {
  const blobs = [];
  let cursor;

  do {
    const page = await list({ prefix: "places/", cursor, limit: 1000 });
    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  const places = await Promise.all(blobs.map(fetchBlobJson));

  return places.filter(Boolean).sort((a, b) => (b.created_at > a.created_at ? 1 : -1));
}

async function readPlace(pathname) {
  try {
    return await fetchBlobJson(await head(pathname));
  } catch (error) {
    if (error instanceof BlobNotFoundError) return null;
    throw error;
  }
}

async function fetchBlobJson(blob) {
  const response = await fetch(`${blob.url}?v=${new Date(blob.uploadedAt).getTime()}`);
  return response.ok ? response.json() : null;
}

async function parseMapsLink(link) {
  let current = link;

  for (let index = 0; index < 6; index++) {
    const url = new URL(current);
    if (url.hostname.startsWith("consent.")) {
      const next = url.searchParams.get("continue");
      if (next) {
        current = next;
        continue;
      }
    }
    if (url.pathname.startsWith("/maps")) break;

    const response = await fetch(current, {
      redirect: "manual",
      headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" },
      signal: AbortSignal.timeout(10000),
    });
    const location = response.headers.get("location");
    if (!location) break;
    current = new URL(location, current).toString();
  }

  const url = new URL(current);
  const result = { url: current };
  const nameMatch = url.pathname.match(/\/maps\/(?:place|search)\/([^/]+)/);
  if (nameMatch) result.name = decodeURIComponent(nameMatch[1].replace(/\+/g, " "));
  else if (url.searchParams.get("q") || url.searchParams.get("query")) {
    result.name = url.searchParams.get("q") || url.searchParams.get("query");
  }

  const precise = current.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  const viewport = current.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  const queryCoords = (result.name || "").match(/^(-?\d+\.\d+),\s*(-?\d+\.\d+)$/);
  const coordinates = precise || viewport || queryCoords;
  if (coordinates) {
    result.coords = { lat: parseFloat(coordinates[1]), lng: parseFloat(coordinates[2]) };
  }
  if (queryCoords) delete result.name;

  const featureId = current.match(/!1s(0x[0-9a-f]+)(?::|%3A)(0x[0-9a-f]+)/i);
  if (featureId) result.featureId = `${featureId[1]}:${featureId[2]}`;
  if (url.searchParams.get("cid")) result.cid = url.searchParams.get("cid");
  if (url.searchParams.get("query_place_id")) result.placeId = url.searchParams.get("query_place_id");

  return result;
}

// Takeout links carry only Google's internal place reference, so ask the Maps web app
// (undocumented, best effort) for the coordinates and the official Place ID.
async function lookupGooglePlace(link) {
  try {
    const page = await fetch(link, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(10000) });
    const preview = (await page.text()).match(/href="(\/maps\/preview\/place\?[^"]+)"/)?.[1];
    if (!preview) return {};

    const response = await fetch(new URL(preview.replace(/&amp;/g, "&"), "https://www.google.com"), {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(10000),
    });
    const data = await response.text();
    const result = {};
    const coords = data.match(/\[null,null,(-?\d+\.\d+),(-?\d+\.\d+)\]/);
    if (coords && isValidCoords(parseFloat(coords[1]), parseFloat(coords[2]))) {
      result.coords = { lat: parseFloat(coords[1]), lng: parseFloat(coords[2]) };
    }
    const placeId = data.match(/placeid(?:=|\\u003d)([A-Za-z0-9_-]{20,})/)?.[1];
    if (placeId) result.placeId = placeId;
    return result;
  } catch {
    return {};
  }
}

async function getPlace(placeId) {
  const response = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?languageCode=it`, {
    headers: {
      "X-Goog-Api-Key": process.env.GOOGLE_MAPS_API_KEY,
      "X-Goog-FieldMask": PLACE_FIELDS.join(","),
    },
  });

  return response.ok ? response.json() : null;
}

async function findPlace(query, coords) {
  const body = { textQuery: query, maxResultCount: 1, languageCode: "it" };
  if (coords) {
    body.locationBias = {
      circle: {
        center: { latitude: coords.lat, longitude: coords.lng },
        radius: 500,
      },
    };
  }

  const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": process.env.GOOGLE_MAPS_API_KEY,
      "X-Goog-FieldMask": PLACE_FIELDS.map((field) => `places.${field}`).join(","),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) return null;
  const { places = [] } = await response.json();
  return places[0] ?? null;
}

function isValidCoords(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat !== 0 || lng !== 0);
}

function toIsoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
