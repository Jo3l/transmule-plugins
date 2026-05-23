/**
 * Archive.org search plugin — torrent + direct download.
 *
 * Searches the Internet Archive for ALL content (not just torrents).
 * - Items WITH a BitTorrent info hash (btih) are returned as torrent results → Transmission.
 * - Items WITHOUT btih are returned with a downloadUrl → pyLoad.
 *
 * API: https://archive.org/advancedsearch.php
 * Docs: https://archive.org/developers/index-apis.html
 */
const API_BASE = "https://archive.org";

// Category → MDI icon mapping (returned as tags for visual hint)
const CATEGORY_ICONS = {
  movies: "mdi-filmstrip",
  audio: "mdi-music",
  texts: "mdi-book-open-variant",
  software: "mdi-application",
  image: "mdi-image",
  etree: "mdi-account-music",
};

function categoryTag(mediatype) {
  const icon = CATEGORY_ICONS[mediatype] || "mdi-file";
  return { label: (mediatype || "other").toUpperCase(), variant: "info", icon };
}

function downloadTag(hasBtih) {
  if (hasBtih) {
    return { label: "TORRENT", variant: "success", icon: "mdi-magnet" };
  }
  return { label: "DIRECT", variant: "accent", icon: "mdi-download-network" };
}

export default {
  meta: {
    id: "archive-org",
    name: "Archive.org",
    icon: "mdi-archive",
    pluginType: "torrent-search",
    description:
      "Internet Archive search — torrents go to Transmission, direct downloads to pyLoad.",
    version: "1.0.0",
    repository:
      "https://raw.githubusercontent.com/Jo3l/transmule-plugins/main/manifest.json",
  },

  async search(query, limit, extraTrackers) {
    // Build advanced search — no format restriction, search ALL content
    const q = query.trim()
      ? `(${query})`
      : "";

    const qs = new URLSearchParams();
    qs.set("q", q);
    qs.append("fl[]", "identifier,title,mediatype,item_size,btih,publicdate,downloads");
    qs.set("sort", "downloads desc");
    qs.set("rows", String(Math.min(limit, 100)));
    qs.set("output", "json");

    let resp;
    try {
      resp = await fetch(`${API_BASE}/advancedsearch.php?${qs}`, {
        headers: { "User-Agent": "TransMule/1.0 archive-org" },
        signal: AbortSignal.timeout(20_000),
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

      const identifier = doc.identifier;
      if (!identifier) continue;

      const title = doc.title || identifier || "Unknown";
      const tags = [categoryTag(doc.mediatype)];
      const name = `${title}`;

      if (doc.btih) {
        // ── Has torrent info hash → send to Transmission ──────────
        const hash = String(doc.btih).toUpperCase();
        const magnet =
          `magnet:?xt=urn:btih:${hash}` +
          `&dn=${encodeURIComponent(title)}` +
          (extraTrackers || "");

        tags.push(downloadTag(true));

        results.push({
          name,
          magnet,
          infoHash: hash,
          size: doc.item_size != null ? Number(doc.item_size) : null,
          seeders: null,
          leechers: null,
          uploadedAt: doc.publicdate ? new Date(doc.publicdate).toISOString() : null,
          source: "archive-org",
          category: doc.mediatype || "Other",
          tags,
        });
      } else {
        // ── No torrent → send to pyLoad via item details page ────
        tags.push(downloadTag(false));

        results.push({
          name,
          magnet: "",
          infoHash: identifier,
          size: doc.item_size != null ? Number(doc.item_size) : null,
          seeders: null,
          leechers: null,
          uploadedAt: doc.publicdate ? new Date(doc.publicdate).toISOString() : null,
          source: "archive-org",
          category: doc.mediatype || "Other",
          tags,
          // Item details page — pyLoad's generic downloader can parse it
          downloadUrl: `${API_BASE}/details/${identifier}`,
        });
      }
    }

    return results;
  },
};
