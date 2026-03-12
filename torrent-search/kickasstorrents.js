/**
 * KickassTorrents torrent-search plugin.
 *
 * Scrapes the KAT clone at kickass.torrentbay.st.
 * Magnet links are present directly in the search-results table so no
 * secondary page fetch is required.
 *
 * Based on: https://github.com/Prowlarr/Indexers/blob/master/definitions/v11/kickasstorrents-to.yml
 *
 * Try-list mirrors (in order):
 *   kickass.torrentbay.st
 *   kickass.torrentsbay.org
 *   kickasstorrents.unblockninja.com
 *
 * NOTE: Some mirrors are behind Cloudflare and will fail silently.
 *       If all mirrors fail the plugin returns [].
 */

const DOMAINS = [
  "https://kickass.torrentbay.st",
  "https://kickass.torrentsbay.org",
  "https://kickasstorrents.unblockninja.com",
];

export default {
  meta: {
    id: "kickasstorrents",
    name: "KickassTorrents",
    icon: "mdi-skull-crossbones",
    pluginType: "torrent-search",
    description: "General torrent index — KickassTorrents public clone.",
    version: "1.0.0",
    repository: "https://raw.githubusercontent.com/Jo3l/transmule-plugins/main/manifest.json",
  },

  async search(query, limit, extraTrackers) {
    if (!query.trim()) return [];

    const HEADERS = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" +
        " (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Accept: "text/html",
    };

    // Two pages from the YML (each page returns ~49 unique results)
    const paths =
      limit > 49
        ? [
            `/search/?q=${encodeURIComponent(query)}`,
            `/search/?page=2&q=${encodeURIComponent(query)}`,
          ]
        : [`/search/?q=${encodeURIComponent(query)}`];

    let html = null;
    for (const domain of DOMAINS) {
      try {
        const pages = await Promise.all(
          paths.map((p) =>
            fetch(domain + p, {
              headers: HEADERS,
              signal: AbortSignal.timeout(15_000),
            }).then((r) => (r.ok ? r.text() : "")),
          ),
        );
        const combined = pages.join("\n");
        if (combined.includes("cellMainLink")) {
          html = combined;
          break;
        }
      } catch {
        // try next domain
      }
    }
    if (!html) return [];

    // Rows that have both a cellMainLink (title) and a magnet link
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    const results = [];
    let m;

    while ((m = rowRe.exec(html)) !== null && results.length < limit) {
      const row = m[1];

      if (!row.includes("magnet:?xt=") || !row.includes("cellMainLink"))
        continue;

      // Magnet link
      const magMatch = row.match(/href=["'](magnet:\?xt=[^"' >]+)["' ]/i);
      if (!magMatch) continue;
      const magnet = magMatch[1] + (extraTrackers || "");

      // Title: <a class="cellMainLink ...">Title</a>
      const titleMatch = row.match(
        /<a[^>]*class=["'][^"']*cellMainLink[^"']*["'][^>]*>([^<]+)<\/a>/i,
      );
      const title = titleMatch ? stripTags(titleMatch[1]) : "";
      if (!title) continue;

      // infoHash from magnet
      const hashMatch = magnet.match(
        /xt=urn:btih:([0-9a-fA-F]{40}|[A-Z2-7]{32})/i,
      );
      const infoHash = hashMatch ? hashMatch[1].toUpperCase() : "";

      // TDs: td[1]=size, td[3]=date, td[4]=seeders(5th), td[5]=leechers(6th)
      const tds = getTdTexts(row);
      const size = parseSize(tds[1] || "");
      const seeders = parseInt((tds[4] || "").replace(/,/g, ""), 10) || 0;
      const leechers = parseInt((tds[5] || "").replace(/,/g, ""), 10) || 0;

      // Category: found in a <span><strong>Cat</strong></span> in the first td
      const catMatch = row.match(/<strong>([^<]+)<\/strong>/i);
      const category = catMatch
        ? stripTags(catMatch[1]).replace(/[>| ]+/g, "")
        : null;

      results.push({
        name: title,
        magnet,
        infoHash,
        size,
        seeders,
        leechers,
        uploadedAt: null,
        source: "kickasstorrents",
        category: category || null,
      });
    }

    return results;
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getTdTexts(rowHtml) {
  const out = [];
  const re = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = re.exec(rowHtml)) !== null) out.push(stripTags(m[1]));
  return out;
}

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
