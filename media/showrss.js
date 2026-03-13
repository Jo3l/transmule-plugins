/**
 * ShowRSS media provider plugin.
 *
 * Parses a ShowRSS personal feed (https://showrss.info/) and returns
 * TV show torrents as MediaItems with magnet links.
 *
 * The user must supply their ShowRSS feed URL in the "feed" filter.
 * Anonymous combined feed: https://showrss.info/other/all.rss
 */
export default {
  meta: {
    id: "showrss",
    name: "ShowRSS",
    icon: "mdi-rss",
    mediaType: "shows",
    description: "TV show torrents via your ShowRSS RSS feed.",
    version: "1.1.0",
    repository:
      "https://raw.githubusercontent.com/Jo3l/transmule-plugins/main/manifest.json",
  },

  filters: [
    {
      key: "feed",
      label: "ShowRSS Feed URL",
      type: "text",
      defaultValue: "https://showrss.info/other/all.rss",
    },
  ],

  async list(params) {
    const query = params.query || "";
    const feedUrl = (
      params.feed ||
      "https://showrss.info/other/all.rss"
    ).trim();
    if (!feedUrl) return { items: [] };

    const resp = await fetch(feedUrl, {
      headers: { "User-Agent": "TransMule/1.0 showrss" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return { items: [] };

    const xml = await resp.text();
    const items = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let match;

    while ((match = itemRe.exec(xml)) !== null) {
      const block = match[1];

      const title = extractTag(block, "title");
      const showName = extractTag(block, "tv:show_name") || extractShowName(title);
      const pubDate = extractTag(block, "pubDate");

      // Prefer <enclosure url="magnet:..."> attribute, then <link>, then <torrent:magnetURI>
      const enclosureMatch = block.match(/<enclosure[^>]+url="([^"]+)"/);
      const rawMagnet =
        (enclosureMatch ? enclosureMatch[1] : "") ||
        extractTag(block, "link") ||
        extractTag(block, "torrent:magnetURI") ||
        "";
      const magnetLink = decodeHtmlEntities(rawMagnet);

      if (!title) continue;
      if (!magnetLink) continue;

      // Filter by query (case-insensitive substring match on show name or full title)
      if (query) {
        const q = query.toLowerCase();
        if (!title.toLowerCase().includes(q) && !showName.toLowerCase().includes(q)) continue;
      }

      items.push({
        id: encodeURIComponent(title + (pubDate || "")),
        title,
        // Store clean show name in genre so cover() can use it
        genre: showName,
        date: pubDate ? tryIso(pubDate) : undefined,
        isSeries: true,
        links: [{ url: magnetLink, label: title }],
      });
    }

    return { items, total: items.length };
  },

  async cover(title) {
    // title may be the full episode title like "Survivor 50x03 Did You Vote...720p"
    // or the clean show name stored in item.genre — strip episode info either way
    const showName = extractShowName(title);
    try {
      const resp = await fetch(
        `https://www.episodate.com/api/search?q=${encodeURIComponent(showName)}&page=1`,
        { signal: AbortSignal.timeout(5_000) },
      );
      if (!resp.ok) return null;
      const data = await resp.json();
      return data?.tv_shows?.[0]?.image_thumbnail_path ?? null;
    } catch {
      return null;
    }
  },
};

/**
 * Strip season/episode codes, quality tags and trailing junk from a title
 * to get just the show name. Works for both ShowRSS title formats:
 *   "Survivor 50x03 Did You Vote For a Swap? 720p"  → "Survivor"
 *   "Jimmy Kimmel 2026-03-11 Conan O'Brien 720p"    → "Jimmy Kimmel"
 */
function extractShowName(title) {
  if (!title) return "";
  // Remove SxxExx / NNxNN codes and everything after
  let s = title.replace(/\s+\d+x\d+.*$/i, "");
  // Remove date patterns (YYYY-MM-DD) and everything after
  s = s.replace(/\s+\d{4}-\d{2}-\d{2}.*$/, "");
  // Remove year-in-parens like "(2026)" at end
  s = s.replace(/\s*\(\d{4}\)\s*$/, "");
  // Remove trailing quality/resolution words
  s = s.replace(/\s+(720p|1080p|480p|2160p|4k|hdtv|web|bluray|repack).*$/i, "");
  return s.trim();
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractTag(xml, tag) {
  const re = new RegExp(
    `<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`,
  );
  const m = xml.match(re);
  return m ? (m[1] ?? m[2] ?? "").trim() : "";
}

function tryIso(dateStr) {
  try {
    return new Date(dateStr).toISOString();
  } catch {
    return dateStr;
  }
}

export default {
  meta: {
    id: "showrss",
    name: "ShowRSS",
    icon: "mdi-rss",
    mediaType: "shows",
    description: "TV show torrents via your ShowRSS RSS feed.",
    version: "1.0.0",
    repository:
      "https://raw.githubusercontent.com/Jo3l/transmule-plugins/main/manifest.json",
  },

  filters: [
    {
      key: "feed",
      label: "ShowRSS Feed URL",
      type: "text",
      defaultValue: "https://showrss.info/other/all.rss",
    },
  ],

  async list({ query, filters }) {
    const feedUrl = (filters?.feed || "").trim();
    if (!feedUrl) return { items: [] };

    const resp = await fetch(feedUrl, {
      headers: { "User-Agent": "TransMule/1.0 showrss" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return { items: [] };

    const xml = await resp.text();
    const items = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let match;

    while ((match = itemRe.exec(xml)) !== null) {
      const block = match[1];

      const title = extractTag(block, "title");
      // Prefer <torrent:magnetURI>, fall back to any magnet: link in the block
      const magnetLink =
        extractTag(block, "torrent:magnetURI") ||
        (block.match(/magnet:[^\s<"']+/) ?? [])[0] ||
        "";
      const link = extractTag(block, "link");
      const pubDate = extractTag(block, "pubDate");

      if (!title) continue;
      if (!magnetLink && !link) continue;

      // Filter by query (case-insensitive substring match)
      if (query && !title.toLowerCase().includes(query.toLowerCase())) continue;

      items.push({
        id: encodeURIComponent(title + (pubDate || "")),
        title,
        date: pubDate ? tryIso(pubDate) : undefined,
        isSeries: true,
        sourceUrl: link || undefined,
        links: magnetLink ? [{ url: magnetLink, label: title }] : [],
      });
    }

    return { items, total: items.length };
  },

  async cover(title) {
    try {
      const resp = await fetch(
        `https://www.episodate.com/api/search?q=${encodeURIComponent(title)}&page=1`,
        { signal: AbortSignal.timeout(5_000) },
      );
      if (!resp.ok) return null;
      const data = await resp.json();
      return data?.tv_shows?.[0]?.image_thumbnail_path ?? null;
    } catch {
      return null;
    }
  },
};

function extractTag(xml, tag) {
  const re = new RegExp(
    `<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`,
  );
  const m = xml.match(re);
  return m ? (m[1] ?? m[2] ?? "").trim() : "";
}

function tryIso(dateStr) {
  try {
    return new Date(dateStr).toISOString();
  } catch {
    return dateStr;
  }
}
