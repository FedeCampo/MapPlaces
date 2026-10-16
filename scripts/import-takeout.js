import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

const PROGRESS_FILE = ".import-progress.json";
const FAILURES_FILE = "import-failures.json";

try {
  process.loadEnvFile(".env.local");
} catch {}

const args = process.argv.slice(2);
const option = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const source = args.find((arg) => !arg.startsWith("--"));
const dryRun = args.includes("--dry-run");
const api = (option("api") ?? process.env.MAPPLACES_URL ?? "https://mapplaces.vercel.app").replace(/\/$/, "");
const concurrency = Number(option("concurrency") ?? 3);

if (!source) {
  console.log(`Uso: npm run import -- "<cartella Takeout>" [--dry-run] [--api=https://...] [--concurrency=3]`);
  process.exit(1);
}

const files = (await stat(source)).isDirectory() ? await walk(source) : [source];
const entries = [];

for (const file of files) {
  const extension = extname(file).toLowerCase();
  if (extension === ".csv") entries.push(...fromCsv(file, await readFile(file, "utf8")));
  if (extension === ".json" || extension === ".geojson") {
    try {
      const data = JSON.parse(await readFile(file, "utf8"));
      if (data?.type === "FeatureCollection") entries.push(...fromGeoJson(file, data));
    } catch {}
  }
}

const places = mergeEntries(entries);
const perList = {};
for (const entry of entries) perList[entry.list] = (perList[entry.list] ?? 0) + 1;

console.log(`Trovati ${entries.length} luoghi in ${Object.keys(perList).length} liste (${places.length} unici):`);
for (const [name, count] of Object.entries(perList)) console.log(`  ${name}: ${count}`);

if (dryRun) {
  console.log("\nEsempi:");
  for (const place of places.slice(0, 5)) console.log(" ", JSON.stringify(place));
  process.exit(0);
}

if (!process.env.API_TOKEN) {
  console.log("\nAPI_TOKEN mancante: aggiungilo in .env.local (API_TOKEN=...)");
  process.exit(1);
}

const done = new Set(await readJson(PROGRESS_FILE, []));
const pending = places.filter((place) => !done.has(place.key));
const failures = [];
let next = 0;
let finished = 0;
let aborted = null;

console.log(`\n${places.length - pending.length} già importati, ${pending.length} da importare su ${api}\n`);

await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (!aborted && next < pending.length) {
      const place = pending[next++];
      try {
        const saved = await send(place);
        done.add(place.key);
        await writeFile(PROGRESS_FILE, JSON.stringify([...done]));
        console.log(`[${++finished}/${pending.length}] ok   ${saved.name}`);
      } catch (error) {
        if (error.status === 401) aborted = "Token non valido (401): controlla API_TOKEN in .env.local";
        if (error.status === 429) aborted = "Limite giornaliero Google raggiunto: rilancia lo stesso comando domani, riparte da qui";
        failures.push({ ...place, error: error.message });
        console.log(`[${++finished}/${pending.length}] FAIL ${place.title || place.url} - ${error.message}`);
      }
    }
  })
);

if (aborted) console.log(`\n${aborted}`);
if (failures.length) {
  await writeFile(FAILURES_FILE, JSON.stringify(failures, null, 2));
  console.log(`\n${failures.length} non importati, dettagli in ${FAILURES_FILE}. Rilancia lo stesso comando per riprovare.`);
}
console.log(`\nImportati ${finished - failures.length}/${pending.length}.`);

async function walk(dir) {
  const items = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    items.map((item) => (item.isDirectory() ? walk(join(dir, item.name)) : [join(dir, item.name)]))
  );
  return nested.flat();
}

function fromCsv(file, text) {
  const [header = [], ...rows] = parseCsv(text);
  const column = (pattern) => header.findIndex((name) => pattern.test(name.trim()));
  let url = column(/^(url|link)$/i);
  if (url < 0) url = rows[0]?.findIndex((cell) => /^https?:\/\//.test(cell)) ?? -1;
  if (url < 0) return [];

  const title = Math.max(column(/^(title|titolo|nome|name)$/i), 0);
  const note = column(/^(note|nota|notes)$/i);
  const comment = column(/^(comment|commento)$/i);

  return rows
    .filter((row) => row[url]?.startsWith("http"))
    .map((row) => ({
      list: basename(file, extname(file)),
      title: row[title]?.trim() ?? "",
      url: row[url].trim(),
      note: [row[note], row[comment]].map((value) => value?.trim()).filter(Boolean).join(" · ") || null,
    }));
}

function fromGeoJson(file, data) {
  return data.features.map((feature) => {
    const props = feature.properties ?? {};
    const location = props.location ?? props.Location ?? {};
    const [lng, lat] = feature.geometry?.coordinates ?? [];
    return {
      list: basename(file, extname(file)),
      title: location.name ?? location["Business Name"] ?? props.Title ?? props.name ?? "",
      url: props.google_maps_url ?? props["Google Maps URL"] ?? null,
      note: props.Comment ?? props.comment ?? null,
      address: location.address ?? location.Address ?? null,
      saved_at: props.date ?? props.Published ?? null,
      lat: lat || null,
      lng: lng || null,
    };
  });
}

function mergeEntries(items) {
  const byKey = new Map();
  for (const item of items) {
    const id = item.url || `${item.title}|${item.lat},${item.lng}`;
    const place = byKey.get(id) ?? { title: "", url: item.url, lists: [], notes: [] };
    place.title ||= item.title;
    place.lists.push(item.list);
    if (item.note) place.notes.push(item.note);
    place.address ??= item.address;
    place.lat ??= item.lat;
    place.lng ??= item.lng;
    place.saved_at = [place.saved_at, item.saved_at].filter(Boolean).sort()[0];
    byKey.set(id, place);
  }

  return [...byKey.entries()].map(([id, place]) => {
    const lists = [...new Set(place.lists)].sort();
    const note = [...new Set(place.notes)].join(" · ") || null;
    return { key: `${id}|${lists.join(",")}`, ...place, lists, notes: undefined, note };
  });
}

async function send(place) {
  const body = {
    text: place.title,
    url: place.url,
    note: place.note,
    list: place.lists,
    address: place.address,
    saved_at: place.saved_at,
    lat: place.lat,
    lng: place.lng,
  };

  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`${api}/api/places`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.API_TOKEN}` },
      body: JSON.stringify(body),
    });
    if (response.ok) return response.json();
    if (response.status >= 500 && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      continue;
    }
    const { error } = await response.json().catch(() => ({}));
    throw Object.assign(new Error(error ?? `HTTP ${response.status}`), { status: response.status });
  }
}

function parseCsv(text) {
  const rows = [[]];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index++;
      } else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") {
      rows.at(-1).push(field);
      field = "";
    } else if (character === "\n") {
      rows.at(-1).push(field.replace(/\r$/, ""));
      field = "";
      rows.push([]);
    } else field += character;
  }
  rows.at(-1).push(field);

  return rows.map((row) => row.map((cell, index) => (index === 0 ? cell.replace(/^﻿/, "") : cell))).filter((row) => row.some((cell) => cell.trim()));
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}
