# TransMule Plugins

Official plugin collection for [TransMule](https://github.com/Jo3l/transmule) — a self-hosted media download manager.

Plugins extend TransMule in two ways:

| Type | What it does | Key method |
|------|-------------|------------|
| **Media** (`mediaType`) | Adds a sidebar browse/search section for a content type (movies, shows, …) | `list(params)` |
| **Torrent Search** (`pluginType: "torrent-search"`) | Powers the Transmission → Torrent Search page with a new index source | `search(query, limit, extraTrackers)` |

Upload any `.js` file via **Settings → Providers → Upload Plugin** — no server restart needed.

---

## Plugins in this repo

### Media providers

| File | ID | Name | Type | Description |
|------|----|------|------|-------------|
| [media/dontorrent-movies.js](media/dontorrent-movies.js) | `dontorrent-movies` | DonTorrent | `movies` | Spanish movie torrents from dontorrent.link |
| [media/dontorrent-shows.js](media/dontorrent-shows.js) | `dontorrent-shows` | DonTorrent | `shows` | Spanish series torrents from dontorrent.link |
| [media/yts.js](media/yts.js) | `yts` | YTS | `movies` | Movie browse/search via YTS.mx with quality & genre filters |
| [media/showrss.js](media/showrss.js) | `showrss` | ShowRSS | `shows` | TV show torrents from your personal ShowRSS RSS feed |

### Torrent-search providers

| File | ID | Name | Description |
|------|----|------|-------------|
| [torrent-search/nyaa.js](torrent-search/nyaa.js) | `nyaa` | Nyaa | Anime & manga torrents via nyaa.si RSS |
| [torrent-search/piratebay.js](torrent-search/piratebay.js) | `tpb` | The Pirate Bay | General torrents via apibay.org JSON API |
| [torrent-search/yts-search.js](torrent-search/yts-search.js) | `yts` | YTS | Movie torrents via YTS.mx JSON API |

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
