/**
 * TorrentKitty torrent-search plugin.
 *
 * Scrapes the TorrentKitty public DHT search engine.
 * Magnet links are present directly in the search-results table so no
 * secondary page fetch is required.
 *
 * Based on: https://github.com/Prowlarr/Indexers/blob/master/definitions/v11/torrentkitty.yml
 *
 * NOTE: TorrentKitty uses Cloudflare on some mirrors. Mirrors are tried
 *       in order; if all fail the plugin returns [].
 *       Seeder/leecher counts are not available from the search page.
 */

const DOMAINS = [
  "https://www.torrentkitty.cam",
  "https://www.torrentkitty.ink",
  "https://www.torrentkitty.io",
  "https://www.torrentkitty.tv",
  "https://www.torrentkitty.app",
  "https://torkitty.com",
];

export default {
  meta: {
    id: "torrentkitty",
    name: "TorrentKitty",
    icon: "mdi-cat",
    pluginType: "torrent-search",
    description: "DHT torrent search engine (torrentkitty). No seeder data.",
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

    // Path: search/{keywords}/
    const kw = encodeURIComponent(query.trim());

    let html = null;
    for (const domain of DOMAINS) {
      try {
        const resp = await fetch(`${domain}/search/${kw}/`, {
          headers: HEADERS,
          signal: AbortSignal.timeout(15_000),
        });
        if (resp.ok) {
          const text = await resp.text();
          // Verify we got actual results (not a CF challenge page)
          if (text.includes("archiveResult") || text.includes("magnet:?xt=")) {
            html = text;
            break;
          }
        }
      } catch {
        // try next domain
      }
    }
    if (!html) return [];

    // Rows in table#archiveResult that have a magnet link
    // (YML: table#archiveResult tbody tr:has(a[href^="magnet:?xt="]))
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    const results = [];
    let m;

    while ((m = rowRe.exec(html)) !== null && results.length < limit) {
      const row = m[1];
      if (!row.includes("magnet:?xt=")) continue;

      // Magnet link (YML: a[href^="magnet:?xt="])
      const magMatch = row.match(/href=["'](magnet:\?xt=[^"' >]+)["' ]/i);
      if (!magMatch) continue;
      const magnet = magMatch[1] + (extraTrackers || "");

      // infoHash
      const hashMatch = magnet.match(
        /xt=urn:btih:([0-9a-fA-F]{40}|[A-Z2-7]{32})/i,
      );
      const infoHash = hashMatch ? hashMatch[1].toUpperCase() : "";

      // Title: <td class="name">...</td>  (YML: td.name)
      const titleTd = row.match(
        /<td[^>]*class=["'][^"']*\bname\b[^"']*["'][^>]*>([\s\S]*?)<\/td>/i,
      );
      const title = titleTd ? stripTags(titleTd[1]) : "";
      if (!title) continue;

      // Size: <td class="size">...</td>  (YML: td.size)
      const sizeTd = row.match(
        /<td[^>]*class=["'][^"']*\bsize\b[^"']*["'][^>]*>([\s\S]*?)<\/td>/i,
      );
      const size = parseSize(sizeTd ? stripTags(sizeTd[1]) : "");

      // Date: <td class="date">...</td>  (YML: td.date)
      const dateTd = row.match(
        /<td[^>]*class=["'][^"']*\bdate\b[^"']*["'][^>]*>([\s\S]*?)<\/td>/i,
      );
      let uploadedAt = null;
      if (dateTd) {
        try {
          uploadedAt = new Date(stripTags(dateTd[1])).toISOString();
        } catch {
          uploadedAt = null;
        }
      }

      results.push({
        name: title,
        magnet,
        infoHash,
        size,
        seeders: 0, // not available on search page
        leechers: 0,
        uploadedAt,
        source: "torrentkitty",
        category: null,
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
