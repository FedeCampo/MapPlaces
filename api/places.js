import { put, list } from "@vercel/blob";

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
    const link = body.url || text.match(/https?:\/\/\S+/)?.[0];
    const hint = link ? await parseMapsLink(link) : {};
    const textQuery = text.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
    const query = hint.name || textQuery;
    let place = null;

    if (process.env.GOOGLE_MAPS_API_KEY && query) {
      place = await findPlace(query, hint.coords);
    }

    let row;
    if (place) {
      row = {
        id: place.id,
        name: place.displayName?.text ?? query,
        address: place.formattedAddress ?? null,
        lat: place.location.latitude,
        lng: place.location.longitude,
        types: place.types ?? [],
        maps_url: place.googleMapsUri ?? link ?? null,
      };
    } else if (hint.coords) {
      row = {
        id: `pin_${hint.coords.lat}_${hint.coords.lng}`,
        name: query || "Punto sulla mappa",
        address: null,
        lat: hint.coords.lat,
        lng: hint.coords.lng,
        types: [],
        maps_url: link ?? null,
      };
    } else {
      return res.status(422).json({ error: "Impossibile identificare il luogo", debug: { link, hint } });
    }

    row.note = note;
    row.created_at = new Date().toISOString();
    const safeId = row.id.replace(/[^a-zA-Z0-9_.-]/g, "_");
    await put(`places/${safeId}.json`, JSON.stringify(row), {
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

  const places = await Promise.all(
    blobs.map(async (blob) => {
      const response = await fetch(`${blob.url}?v=${new Date(blob.uploadedAt).getTime()}`);
      return response.ok ? response.json() : null;
    })
  );

  return places.filter(Boolean).sort((a, b) => (b.created_at > a.created_at ? 1 : -1));
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
    });
    const location = response.headers.get("location");
    if (!location) break;
    current = new URL(location, current).toString();
  }

  const url = new URL(current);
  const result = {};
  const nameMatch = url.pathname.match(/\/maps\/place\/([^/]+)/);
  if (nameMatch) result.name = decodeURIComponent(nameMatch[1].replace(/\+/g, " "));
  else if (url.searchParams.get("q")) result.name = url.searchParams.get("q");

  const precise = current.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  const viewport = current.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  const queryCoords = (result.name || "").match(/^(-?\d+\.\d+),\s*(-?\d+\.\d+)$/);
  const coordinates = precise || viewport || queryCoords;
  if (coordinates) {
    result.coords = { lat: parseFloat(coordinates[1]), lng: parseFloat(coordinates[2]) };
  }

  return result;
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
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.formattedAddress,places.location,places.types,places.googleMapsUri",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) return null;
  const { places = [] } = await response.json();
  return places[0] ?? null;
}