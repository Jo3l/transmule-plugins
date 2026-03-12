/**
 * EZTV torrent-search plugin.
 *
 * Scrapes the public EZTV site — focused exclusively on TV shows.
 * Magnet links are present directly in the search results page so no
 * secondary fetch is required.
 *
 * Based on: https://github.com/Prowlarr/Indexers/blob/master/definitions/v11/eztv.yml
 *
 * Primary domain: https://eztvx.to  (first in Prowlarr's links list)
 * Fallbacks:       https://eztv.wf  |  https://eztv.tf
 *
 * NOTE: This scraper may break if the site changes its HTML layout.
 */

const DOMAINS = ["https://eztvx.to", "https://eztv.wf", "https://eztv.tf"];

export default {
  meta: {
    id: "eztv",
    name: "EZTV",
    icon: "mdi-television-play",
    pluginType: "torrent-search",
    description: "TV show torrents from EZTV (eztvx.to).",
    version: "1.0.0",
    repository: "https://raw.githubusercontent.com/Jo3l/transmule-plugins/main/manifest.json",
  },

  async search(query, limit, extraTrackers) {
    // EZTV keyword transform (from YML keywordsfilters):
    //   remove season-only tags, drop dashes, replace spaces with dashes
    const kw = query
      .replace(/\bS\d{2,3}\b/gi, "") // drop S01, S023 without episode
      .trim()
      .replace(/-/g, "")
      .replace(/&/g, "")
      .trim()
      .replace(/\s+/g, "-");

    // The cookies nudge EZTV to return 100 rows and include magnet links
    const COOKIES =
      "sort_no=100; q_filter=all; q_filter_web=on; q_filter_reality=on;" +
      " q_filter_x265=on; layout=def_wlinks";
    const HEADERS = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" +
        " (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Accept: "text/html",
      Cookie: COOKIES,
    };

    let html = null;
    for (const domain of DOMAINS) {
      try {
        const resp = await fetch(`${domain}/search/${kw || "home"}`, {
          headers: HEADERS,
          signal: AbortSignal.timeout(15_000),
        });
        if (resp.ok) {
          html = await resp.text();
          break;
        }
      } catch {
        // try next domain
      }
    }
    if (!html) return [];

    // Each result row: <tr name="hover" class="forum_header_border ...">
    const rowRe = /<tr[^>]*name=["']hover["'][^>]*>([\s\S]*?)<\/tr>/gi;
    const results = [];
    let m;

    while ((m = rowRe.exec(html)) !== null && results.length < limit) {
      const row = m[1];

      // Magnet link (anywhere in the row)
      const magMatch = row.match(/href=["'](magnet:[^"' >]+)["' ]/i);
      if (!magMatch) continue;
      const magnet = magMatch[1] + (extraTrackers || "");

      // Title: anchor pointing to /ep/... has a title= attribute
      const titleMatch =
        row.match(
          /<a[^>]+href=["']\/ep\/[^"']*["'][^>]*title=["']([^"']+)["']/i,
        ) ||
        row.match(
          /<a[^>]+title=["']([^"']+)["'][^>]*href=["']\/ep\/[^"']*["']/i,
        );
      if (!titleMatch) continue;
      const title = titleMatch[1].replace(/\[eztv\]/gi, "").trim();
      if (!title) continue;

      // infoHash from magnet
      const hashMatch = magnet.match(
        /xt=urn:btih:([0-9a-fA-F]{40}|[A-Z2-7]{32})/i,
      );
      const infoHash = hashMatch ? hashMatch[1].toUpperCase() : "";

      // Grab all TD text values (YML: td:nth-child(4)=size, td:nth-child(6)=seeders)
      const tds = getTdTexts(row);
      const size = parseSize(tds[3] || ""); // 4th td (index 3)
      const seeders = parseInt((tds[5] || "").replace(/,/g, ""), 10) || 0; // 6th td

      results.push({
        name: title,
        magnet,
        infoHash,
        size,
        seeders,
        leechers: 0,
        uploadedAt: null,
        source: "eztv",
        category: "TV",
      });
    }

    return results;
  },
};

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** Extract the stripped text from every <td> in a table row. */
function getTdTexts(rowHtml) {
  const out = [];
  const re = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = re.exec(rowHtml)) !== null) out.push(stripTags(m[1]));
  return out;
}

/** Remove all HTML tags and decode common entities. */
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

/**
 * Parse human-readable size strings (e.g. "1.5 GB", "700 MiB") to bytes.
 * Returns null if unparseable.
 */
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
