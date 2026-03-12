/**
 * Internet Archive torrent-search plugin.
 *
 * Uses the Internet Archive's Elasticsearch JSON API (no scraping needed).
 * Covers public-domain movies, music, books, software, and more.
 *
 * API docs: https://archive.org/advancedsearch.php
 * Based on: https://github.com/Prowlarr/Indexers/blob/master/definitions/v11/internetarchive.yml
 */
export default {
  meta: {
    id: "internet-archive",
    name: "Internet Archive",
    icon: "mdi-archive",
    pluginType: "torrent-search",
    description:
      "Public-domain movies, music, books & software torrents from archive.org.",
    version: "1.0.0",
    repository:
      "https://raw.githubusercontent.com/Jo3l/transmule-plugins/main/manifest.json",
  },

  async search(query, limit, extraTrackers) {
    // Build Elasticsearch query — always require the "Archive BitTorrent" format
    const q = query.trim()
      ? `title:(${query}) AND format:("Archive BitTorrent")`
      : `format:("Archive BitTorrent")`;

    const qs = new URLSearchParams();
    qs.set("q", q);
    qs.append("fl[]", "identifier,title,mediatype,item_size,btih,publicdate");
    qs.set("sort", "-publicdate");
    qs.set("rows", String(Math.min(limit, 100)));
    qs.set("output", "json");

    let resp;
    try {
      resp = await fetch(`https://archive.org/advancedsearch.php?${qs}`, {
        headers: { "User-Agent": "TransMule/1.0 torrent-search" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return [];
    }

    if (!resp.ok) return [];

    let data;
    try {
      data = await resp.json();
    } catch {
      return [];
    }

    const docs = data?.response?.docs;
    if (!Array.isArray(docs)) return [];

    const results = [];
    for (const doc of docs) {
      if (results.length >= limit) break;
      const hash = (doc.btih || "").toUpperCase();
      if (!hash) continue;

      const title = doc.title || doc.identifier || "Unknown";
      const magnet =
        `magnet:?xt=urn:btih:${hash}` +
        `&dn=${encodeURIComponent(title)}` +
        (extraTrackers || "");

      results.push({
        name: title,
        magnet,
        infoHash: hash,
        size: doc.item_size != null ? Number(doc.item_size) : null,
        seeders: 1,
        leechers: 0,
        uploadedAt: doc.publicdate
          ? new Date(doc.publicdate).toISOString()
          : null,
        source: "internet-archive",
        category: doc.mediatype || "Other",
      });
    }

    return results;
  },
};
