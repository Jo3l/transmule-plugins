/**
 * TorrentCSV torrent-search plugin.
 *
 * Uses the TorrentCSV public REST API — no scraping needed.
 * TorrentCSV is an open-source BitTorrent DHT index that returns clean JSON.
 *
 * Project: https://git.torrents-csv.ml/
 * API endpoint: GET /service/search?q=QUERY&size=N&page=1
 */
export default {
  meta: {
    id: "torrent-csv",
    name: "TorrentCSV",
    icon: "mdi-database-search",
    pluginType: "torrent-search",
    description: "BitTorrent DHT index with clean JSON API (torrents-csv.ml).",
    version: "1.0.0",
    repository: "https://raw.githubusercontent.com/Jo3l/transmule-plugins/main/manifest.json",
  },

  async search(query, limit, extraTrackers) {
    if (!query.trim()) return [];

    const qs = new URLSearchParams({
      q: query.trim(),
      size: String(Math.min(limit, 100)),
      page: "1",
    });

    let resp;
    try {
      resp = await fetch(`https://torrents-csv.ml/service/search?${qs}`, {
        headers: { "User-Agent": "TransMule/1.0 torrent-search" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return [];
    }

    if (!resp.ok) return [];

    let items;
    try {
      items = await resp.json();
    } catch {
      return [];
    }

    if (!Array.isArray(items)) return [];

    return items.slice(0, limit).map((item) => {
      const hash = (item.infohash || "").toUpperCase();
      const title = item.name || "Unknown";
      const magnet =
        `magnet:?xt=urn:btih:${hash}` +
        `&dn=${encodeURIComponent(title)}` +
        (extraTrackers || "");

      return {
        name: title,
        magnet,
        infoHash: hash,
        size: item.size_bytes != null ? Number(item.size_bytes) : null,
        seeders: Number(item.seeders) || 0,
        leechers: Number(item.leechers) || 0,
        uploadedAt: item.created_unix
          ? new Date(Number(item.created_unix) * 1000).toISOString()
          : null,
        source: "torrent-csv",
        category: null,
      };
    });
  },
};
