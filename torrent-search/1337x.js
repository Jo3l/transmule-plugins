/**
 * 1337x torrent-search plugin.
 *
 * Scrapes 1337x — one of the most popular public torrent indexes.
 *
 * Because 1337x's search-results page does NOT include the magnet link,
 * this plugin does a TWO-STAGE fetch:
 *   1. Fetch the search-results page → extract title, seeders, leechers,
 *      size, and the per-torrent detail URL.
 *   2. Fetch each detail page IN PARALLEL to extract the magnet link.
 *
 * Results are capped at MAX_DETAIL_FETCHES (default 20) to keep latency
 * reasonable.  Increase it in the constant below if needed.
 *
 * Based on: https://github.com/Prowlarr/Indexers/blob/master/definitions/v11/1337x.yml
 *
 * Primary domain: https://1337x.to  (first in Prowlarr's links list)
 * Fallbacks:       https://1337x.st  |  https://x1337x.ws
 */

const DOMAINS = ["https://1337x.to", "https://1337x.st", "https://x1337x.ws"];

/** Maximum per-search detail-page fetches (each costs one extra HTTP request). */
const MAX_DETAIL_FETCHES = 20;

export default {
  meta: {
    id: "1337x",
    name: "1337x",
    icon: "mdi-numeric-1-box",
    pluginType: "torrent-search",
    description:
      "1337x — popular public torrent index (movies, TV, games, music).",
    version: "1.0.0",
    repository:
      "https://raw.githubusercontent.com/Jo3l/transmule-plugins/main/manifest.json",
  },

  async search(query, limit, extraTrackers) {
    if (!query.trim()) return [];

    const HEADERS = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" +
        " (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Accept: "text/html",
    };

    // Keyword transform from YML: normalize S2023 → 2023
    const kw = query.replace(/\bS(20\d{2})\b/gi, "$1").trim();

    // Stage 1 — search page
    let searchHtml = null;
    let baseUrl = null;
    for (const domain of DOMAINS) {
      try {
        const url = `${domain}/search/${encodeURIComponent(kw)}/1/`;
        const resp = await fetch(url, {
          headers: HEADERS,
          signal: AbortSignal.timeout(15_000),
        });
        if (resp.ok) {
          const text = await resp.text();
          if (text.includes('href="/torrent/')) {
            searchHtml = text;
            baseUrl = domain;
            break;
          }
        }
      } catch {
        // try next domain
      }
    }
    if (!searchHtml || !baseUrl) return [];

    // Extract rows: <tr> that contain a /torrent/ link
    // YML row selector: tr:has(a[href^="/torrent/"])
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    const rows = [];
    let m;
    while ((m = rowRe.exec(searchHtml)) !== null) {
      if (m[1].includes('href="/torrent/')) rows.push(m[1]);
    }

    const cap = Math.min(rows.length, limit, MAX_DETAIL_FETCHES);
    if (cap === 0) return [];

    // Per-row metadata from the search page
    // YML fields:
    //   title:    td[class^="coll-1"] a[href^="/torrent/"]  (text)
    //   detail:   td[class^="coll-1"] a[href^="/torrent/"]  (href)
    //   seeders:  td[class^="coll-2"]
    //   leechers: td[class^="coll-3"]
    //   size:     td[class^="coll-4"]
    const meta = rows.slice(0, cap).map((row) => {
      // Title & detail URL
      const linkMatch = row.match(
        /<a[^>]+href=["'](\/torrent\/[^"']+)["'][^>]*>([^<]+)<\/a>/i,
      );
      const detailPath = linkMatch ? linkMatch[1] : null;
      const titleRaw = linkMatch ? stripTags(linkMatch[2]) : "";

      // Fix title from href when it's truncated (ends with "...")
      let title = titleRaw;
      if (detailPath && titleRaw.endsWith("...")) {
        // Extract from path: /torrent/ID/the-name-of-the-torrent/
        const parts = detailPath.split("/").filter(Boolean);
        // parts = ["torrent", "ID", "slug"]
        if (parts.length >= 3) {
          title = parts[2]
            .replace(/-([a-zA-Z0-9]+(?:[[\]()a-zA-Z0-9]+)?)$/, "~$1")
            .replace(/-/g, " ")
            .replace(/~([a-zA-Z0-9]+(?:[[\]()a-zA-Z0-9]+)?)$/, "-$1")
            .trim();
        }
      }

      // Size/seeders/leechers from coll-N tds
      const coll2 = row.match(
        /<td[^>]*class=["'][^"']*coll-2[^"']*["'][^>]*>([\s\S]*?)<\/td>/i,
      );
      const coll3 = row.match(
        /<td[^>]*class=["'][^"']*coll-3[^"']*["'][^>]*>([\s\S]*?)<\/td>/i,
      );
      const coll4 = row.match(
        /<td[^>]*class=["'][^"']*coll-4[^"']*["'][^>]*>([\s\S]*?)<\/td>/i,
      );

      const seeders =
        parseInt(stripTags(coll2?.[1] || "").replace(/,/g, ""), 10) || 0;
      const leechers =
        parseInt(stripTags(coll3?.[1] || "").replace(/,/g, ""), 10) || 0;
      const size = parseSize(stripTags(coll4?.[1] || ""));

      // Category: from /sub/CAT_ID/ link in the row
      const catMatch = row.match(
        /href=["']\/sub\/\d+\/\d+\/["'][^>]*>([^<]+)<\/a>/i,
      );
      const category = catMatch ? stripTags(catMatch[1]) : null;

      return { title, detailPath, seeders, leechers, size, category };
    });

    // Stage 2 — fetch detail pages in parallel to get the magnet link
    // YML detail download: ul li a[href^="magnet:"] or a[href^="magnet:"]
    const detailResults = await Promise.allSettled(
      meta.map(({ detailPath }) =>
        detailPath
          ? fetch(baseUrl + detailPath, {
              headers: HEADERS,
              signal: AbortSignal.timeout(10_000),
            })
              .then((r) => (r.ok ? r.text() : ""))
              .catch(() => "")
          : Promise.resolve(""),
      ),
    );

    const results = [];
    for (let i = 0; i < meta.length; i++) {
      if (results.length >= limit) break;
      const { title, seeders, leechers, size, category } = meta[i];
      if (!title) continue;

      const pageHtml =
        detailResults[i].status === "fulfilled" ? detailResults[i].value : "";

      // Extract magnet from detail page
      const magMatch = pageHtml.match(/href=["'](magnet:[^"']+)["']/i);
      if (!magMatch) continue;
      const magnet = magMatch[1] + (extraTrackers || "");

      const hashMatch = magnet.match(
        /xt=urn:btih:([0-9a-fA-F]{40}|[A-Z2-7]{32})/i,
      );
      const infoHash = hashMatch ? hashMatch[1].toUpperCase() : "";

      results.push({
        name: title,
        magnet,
        infoHash,
        size,
        seeders,
        leechers,
        uploadedAt: null,
        source: "1337x",
        category: category || null,
      });
    }

    return results;
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function stripTags(html) {
  return (html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#\d+;/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseSize(s) {
  if (!s) return null;
  const m = String(s)
    .trim()
    .match(/^([\d.,]+)\s*(B|KB|KiB|MB|MiB|GB|GiB|TB|TiB)$/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(",", ""));
  const units = {
    b: 1,
    kb: 1e3,
    kib: 1024,
    mb: 1e6,
    mib: 1048576,
    gb: 1e9,
    gib: 1073741824,
    tb: 1e12,
    tib: 1099511627776,
  };
  return Math.round(n * (units[m[2].toLowerCase()] || 1));
}
