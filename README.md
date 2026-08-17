# TransMule Plugins

Official plugin collection for [TransMule](https://github.com/Jo3l/transmule) — a self-hosted media download manager.

Plugins extend TransMule in two ways:

| Type                                                | What it does                                                               | Key method                            |
| --------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------- |
| **Media** (`mediaType`)                             | Adds a sidebar browse/search section for a content type (movies, shows, …) | `list(params)`                        |
| **Torrent Search** (`pluginType: "torrent-search"`) | Powers the Transmission → Torrent Search page with a new index source      | `search(query, limit, extraTrackers)` |

Upload any `.js` file via **Settings → Providers → Upload Plugin** — no server restart needed.

---

## Plugins in this repo

### Media providers

| File                                                     | ID                  | Name       | Type     | Description                                                 |
| -------------------------------------------------------- | ------------------- | ---------- | -------- | ----------------------------------------------------------- |
| [media/dontorrent-movies.js](media/dontorrent-movies.js) | `dontorrent-movies` | DonTorrent | `movies` | Spanish movie torrents from dontorrent.link                 |
| [media/dontorrent-shows.js](media/dontorrent-shows.js)   | `dontorrent-shows`  | DonTorrent | `shows`  | Spanish series torrents from dontorrent.link                |
| [media/torrentclaw-movies.js](media/torrentclaw-movies.js) | `torrentclaw-movies` | TorrentClaw | `movies` | Popular movies — 30+ sources, TrueSpec quality scores       |
| [media/torrentclaw-shows.js](media/torrentclaw-shows.js)   | `torrentclaw-shows`  | TorrentClaw | `shows`  | Popular TV shows — 30+ sources, TrueSpec quality scores     |
| [media/yts.js](media/yts.js)                             | `yts`               | YTS        | `movies` | Movie browse/search via YTS.mx with quality & genre filters |
| [media/showrss.js](media/showrss.js)                     | `showrss`           | ShowRSS    | `shows`  | TV show torrents from your personal ShowRSS RSS feed        |
| [media/archive-org.js](media/archive-org.js)             | `archive-org`       | Archive.org | `archive` | Search all content (movies, audio, books, software, images) — direct download |

### Torrent-search providers

| File                                                                     | ID                      | Name                     | Description                                                                 |
| ------------------------------------------------------------------------ | ----------------------- | ------------------------ | --------------------------------------------------------------------------- |
| [indexerr/indexerr.js](indexerr/indexerr.js)                             | `indexerr`              | indexerr                 | Unified torrent search — reads Jackett/Cardigann indexer definitions        |
| [torrent-search/internet-archive.js](torrent-search/internet-archive.js) | `internet-archive-torrent` | Internet Archive Torrent | Public-domain movies, music, books & software torrents (Archive BitTorrent format only) |

#### indexerr

`indexerr` reemplaza a los plugins individuales de búsqueda de torrents (1337x, EZTV, Nyaa, The Pirate Bay, KickassTorrents, TorrentKitty, TorrentCSV, TorrentClaw, YTS…). En lugar de un plugin por tracker, lee **definiciones de indexers** en formato Cardigann YAML — el mismo formato declarativo que usa [Jackett](https://github.com/Jackett/Jackett) (`src/Jackett.Common/Definitions/*.yml`) — descargadas y actualizadas **una vez al día** en runtime.

Es un **plugin autónomo**: instala sus propias rutas de API (definiciones/instancias) y declara su sección de settings, que el frontend de TransMule renderiza de forma genérica. **No existe código específico de `indexerr` en el core**:

- Declara `capability: "cardigann"` y recibe el motor genérico de indexers vía `install(ctx) → ctx.cardigann` (el core inyecta la capacidad declarada, sin conocer el plugin).
- Persiste el catálogo y las instancias en `ctx.storage` (almacén JSON genérico por-plugin).
- Los indexers **públicos** funcionan sin configuración; los **privados** se configuran por-indexer (login, cookie, api_key) desde **Settings → Proveedores**.

> **Crédito:** las definiciones de indexers provienen del proyecto open-source [Jackett](https://github.com/Jackett/Jackett) (GPL-2.0), descargadas en runtime y nunca distribuidas con este repositorio.

---

## How to use

1. Open TransMule → **Settings → Providers**
2. Click **Upload Plugin** and select the `.js` file
3. Reload the page — the plugin appears immediately

To remove a plugin, click the **Remove** button next to it in the Providers panel.

---

## How to develop your own plugin

See [PLUGIN_API.md](PLUGIN_API.md) for the full API reference.

Quick summary:

```js
// Media plugin — browse/search content
export default {
  meta: {
    id: "my-source",        // unique id
    name: "My Source",      // display name
    icon: "mdi-magnify",    // MDI icon
    mediaType: "movies",    // sidebar section name
    description: "…",
  },
  async list({ query, page, filters }) {
    // fetch & return { items, hasMore, total }
  },
};

// Torrent-search plugin — powers Torrent Search page
export default {
  meta: {
    id: "my-index",
    name: "My Index",
    icon: "mdi-magnify",
    pluginType: "torrent-search",
    description: "…",
  },
  async search(query, limit, extraTrackers) {
    // fetch & return TorrentSearchResult[]
  },
};
```

---

## Contributing

Pull requests welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

GPL-3.0 — Copyright (C) 2026 Quique Ferrando
