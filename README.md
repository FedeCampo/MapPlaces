# MapPlaces

Your Google Maps places, saved to your own Vercel Blob store and shown on one map at https://mapplaces.vercel.app.

Google Maps has no API for your saved places, so places come in two ways:

- **New places:** Google Maps → Share → **MapSaver** (an iPhone Shortcut that calls `POST /api/places`).
- **Places you already saved:** a one-time bulk import from Google Takeout.

The same place saved twice (or present in several lists) is stored once. Its lists are merged, the newest note wins and the oldest save date is kept.

## Environment variables (Vercel)

| Name | Required | Purpose |
| --- | --- | --- |
| `API_TOKEN` | yes | Password for adding places. Pick any long random string. |
| `GOOGLE_MAPS_API_KEY` | no | Places API (New) key. Adds official names, addresses and categories. Without it, places are saved as pins using the name from the link. |

Blob access uses Vercel OIDC (`BLOB_STORE_ID`), set up when the store is connected.

## iPhone Shortcut

In the Shortcuts app, create a shortcut named **MapSaver**:

1. Open its settings (ⓘ): turn on **Show in Share Sheet** and accept **URLs** and **Text**.
2. Add **Get Contents of URL**:
   - URL: `https://mapplaces.vercel.app/api/places`
   - Method: `POST`
   - Header: `Authorization` = `Bearer <your API_TOKEN>`
   - Request Body: JSON, with field `text` (Text) = **Shortcut Input**
3. Optional: before step 2, add **Ask for Input** ("Nota") and add a JSON field `note` = **Provided Input**.
4. Add **Get Dictionary Value** `name` from **Contents of URL**, then **Show Notification** with it.

In Google Maps: open a place → Share → MapSaver.

## Bulk import from Google Takeout

1. At https://takeout.google.com, deselect all, then select **Saved** (your lists, one CSV each) and **Maps (your places)** (starred places). Export and unzip.
2. Create `.env.local` in this folder with `API_TOKEN=<your API_TOKEN>`.
3. Check what will be imported:

   ```
   npm run import -- "C:\path\to\Takeout" --dry-run
   ```

4. Import:

   ```
   npm run import -- "C:\path\to\Takeout"
   ```

Each file becomes a list name. Progress is kept in `.import-progress.json`, so re-running only sends what is missing; failures are written to `import-failures.json`. Options: `--api=<url>` (default `https://mapplaces.vercel.app`), `--concurrency=<n>` (default 3).
