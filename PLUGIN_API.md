# Plugin API Reference

TransMule plugins are plain `.js` files uploaded via **Settings → Providers → Upload Plugin**.

Two plugin types are supported:

- **Media plugins** — add a browsable/searchable content section to the sidebar
- **Torrent-search plugins** — add a source to the Transmission → Torrent Search page

---

## Media plugins

### Minimal example

```js
export default {
  meta: {
    id: "my-source",
    name: "My Source",
    icon: "mdi-magnify",
    mediaType: "movies",
    description: "Optional short description.",
  },

  async list({ query, page, filters }) {
    const res = await fetch(
      `https://example.com/api?q=${encodeURIComponent(query)}&page=${page}`,
    );
    const data = await res.json();
    return {
      items: data.results.map((r) => ({
        id: r.id,
        title: r.title,
        year: r.year,
        cover: r.poster_url,
        links: r.torrents.map((t) => ({ url: t.magnet, label: t.quality })),
      })),
      hasMore: data.page < data.totalPages,
      total: data.totalCount,
    };
  },
};
```

### `meta` object

| Field         | Type     | Required | Description                                                                                                  |
| ------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `id`          | `string` | ✅       | Unique lowercase kebab-case identifier. Must not clash with other loaded plugins.                            |
| `name`        | `string` | ✅       | Display name shown in the UI.                                                                                |
| `icon`        | `string` | ✅       | MDI icon class, e.g. `"mdi-movie"`. Browse icons at [Pictogrammers](https://pictogrammers.com/library/mdi/). |
| `mediaType`   | `string` | ✅       | Content category (e.g. `"movies"`, `"shows"`). Each unique value gets its own collapsible sidebar section.   |
| `description` | `string` | —        | Short text shown in Settings → Providers.                                                                    |

### `list(params)` — required

Called on every search/browse action.

```js
async list({ query, page, filters }) { … }
```

| Param     | Type                     | Description                                    |
| --------- | ------------------------ | ---------------------------------------------- |
| `query`   | `string`                 | User's search query (may be empty for browse). |
| `page`    | `number`                 | 1-based page number.                           |
| `filters` | `Record<string, string>` | Values from any declared `filters`.            |

**Return value:**

```js
{
  items: MediaItem[],   // results for this page
  hasMore?: boolean,    // true if more pages exist
  total?: number,       // total result count (optional)
  page?: number,        // echoed page number (optional)
}
```

### `detail(url)` — optional

Called when the user opens an item that has `needsDetail: true`. Return the full `MediaItem` with `links` populated.

```js
async detail(sourceUrl) { … }
```

### `cover(title)` — optional

Return a cover image URL for the given title, or `null`. Used as fallback when the item has no `cover` field.

```js
async cover(title) { return "https://…/poster.jpg"; }
```

### `filters` — optional

Array of filter controls shown in the search panel.

```js
filters: [
  {
    key: "quality",
    label: "Quality",
    type: "select",           // "select" | "text"
    options: [
      { label: "Any", value: "" },
      { label: "1080p", value: "1080p" },
      { label: "4K", value: "2160p" },
    ],
    defaultValue: "",
  },
  {
    key: "genre",
    label: "Genre",
    type: "text",
    defaultValue: "",
  },
],
```

### `MediaItem` shape

```js
{
  id: string,             // unique within this provider run
  title: string,
  cover?: string,         // poster/thumbnail URL
  year?: string | number,
  date?: string,
  genre?: string,
  rating?: string | number,
  runtime?: number,       // minutes
  description?: string,
  format?: string,        // e.g. "1080p HDRip"
  size?: string,          // human-readable, e.g. "2.1 GB"
  director?: string,
  actors?: string,
  language?: string,
  links?: MediaLink[],    // for movies / single items
  episodes?: MediaEpisode[], // for series
  isSeries?: boolean,
  needsDetail?: boolean,  // true → detail(sourceUrl) called before showing links
  sourceUrl?: string,     // URL passed to detail()
}
```

### `MediaLink` shape

```js
{
  url: string,      // magnet: or https:// torrent URL
  label?: string,   // e.g. "1080p BluRay"
  quality?: string,
  type?: string,
  size?: string,    // e.g. "2.3 GB"
  seeds?: number,
  hash?: string,    // info hash (without magnet: prefix)
}
```

### `MediaEpisode` shape (series)

```js
{
  code: string,       // e.g. "S01E03"
  links: MediaLink[],
  date?: string,
}
```

---

## Torrent-search plugins

These plugins power the **Transmission → Torrent Search** page. They are not media providers — they have no sidebar entry.

### Minimal example

```js
export default {
  meta: {
    id: "my-index",
    name: "My Index",
    icon: "mdi-magnify",
    pluginType: "torrent-search",
    description: "Optional short description.",
  },

  async search(query, limit, extraTrackers) {
    const res = await fetch(
      `https://example.com/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    );
    const data = await res.json();
    return data.results.map((r) => ({
      name: r.title,
      magnet: r.magnet + extraTrackers,
      infoHash: r.hash,
      size: r.size_bytes ?? null,
      seeders: r.seeders ?? 0,
      leechers: r.leechers ?? 0,
      uploadedAt: r.date ?? null,
      source: "my-index", // should match meta.id
      category: r.category ?? null,
    }));
  },
};
```

### `meta` object

| Field         | Type               | Required | Description                                                            |
| ------------- | ------------------ | -------- | ---------------------------------------------------------------------- |
| `id`          | `string`           | ✅       | Unique lowercase id. Appears in the source dropdown of Torrent Search. |
| `name`        | `string`           | ✅       | Display name in the source dropdown.                                   |
| `icon`        | `string`           | ✅       | MDI icon class.                                                        |
| `pluginType`  | `"torrent-search"` | ✅       | Must be exactly `"torrent-search"`.                                    |
| `description` | `string`           | —        | Shown in Settings → Providers.                                         |

### `search(query, limit, extraTrackers)` — required

```js
async search(query, limit, extraTrackers) { … }
```

| Param           | Type     | Description                                                                                                |
| --------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `query`         | `string` | Search term entered by the user.                                                                           |
| `limit`         | `number` | Maximum number of results to return.                                                                       |
| `extraTrackers` | `string` | Pre-encoded tracker params to append to magnet links, e.g. `"&tr=udp%3A%2F%2Ftracker.example.com%3A1337"`. |

**Return value:** `TorrentSearchResult[]`

### `TorrentSearchResult` shape

```js
{
  name: string,           // display title
  magnet: string,         // full magnet: URI
  infoHash: string,       // 40-char hex hash
  size: number | null,    // bytes, or null if unknown
  seeders: number,
  leechers: number,
  uploadedAt: string | null, // ISO 8601 date or null
  source: string,         // should match meta.id
  category: string | null,
  cover?: string | null,  // poster / cover image URL (TMDB)
  tags?: TorrentTag[],    // optional decorative badges (see below)
}
```

### `TorrentTag` shape (decorative badges)

Since v1.0.0, torrent-search plugins can return optional **tags** — small colored badges rendered below the torrent name in the results table. They are purely decorative (no effect on search/sorting).

```js
{
  label: string,    // Display text, e.g. "2160p", "HEVC", "🇬🇧 EN"
  variant?: string, // Color variant (see table below)
  icon?: string,    // MDI icon class, e.g. "mdi-shield-check"
  tooltip?: string, // Hover tooltip text
}
```

| Variant    | Visual style         | Best for                               |
| ---------- | -------------------- | -------------------------------------- |
| `default`  | Neutral gray         | Languages, size, generic info          |
| `success`  | Green                | Quality scores, verified badges        |
| `warning`  | Amber / yellow       | Resolution, HDR type                   |
| `info`     | Blue / cyan          | Codec, source type                     |
| `accent`   | Purple               | Audio codec                            |
| `danger`   | Red                  | Low seeds, warnings                    |
| `primary`  | Indigo               | Custom highlights                      |

**Example:** A 4K HDR BluRay with TrueSpec score:

```js
tags: [
  { label: "92", variant: "success", icon: "mdi-shield-check", tooltip: "TrueSpec Quality Score" },
  { label: "2160p", variant: "warning" },
  { label: "DV+HDR10", variant: "warning", tooltip: "Dolby Vision + HDR10" },
  { label: "BLURAY", variant: "info" },
  { label: "HEVC", variant: "info" },
  { label: "TRUEHD", variant: "accent", tooltip: "Dolby TrueHD 7.1" },
  { label: "🇬🇧 EN", variant: "default" },
  { label: "🇪🇸 ES", variant: "default" },
]
```

This renders as a row of compact colored badges below the torrent name, like the tag system on TorrentClaw.

> **Note for plugin authors:** You only need to return `tags` if your source
> provides **structured metadata** (quality, codec, audio, languages, HDR as
> separate fields). If you only return the torrent `name`, the TransMule
> middleware **automatically parses the name** and extracts quality, codec,
> audio, languages, HDR, and release flags — so your results get tags
> without any extra work.

---

## Runtime environment

- Node.js 18+
- `fetch` is available globally
- `AbortSignal.timeout(ms)` is supported
- Built-in Node.js modules (`node:crypto`, `node:https`, …) are available
- **No `npm` packages** — plugins are loaded as-is without bundling

## File format

Both ESM and CommonJS work:

```js
// ESM (recommended)
export default { meta: { … }, async list(…) { … } };

// CommonJS
module.exports = { meta: { … }, async list(…) { … } };
```
