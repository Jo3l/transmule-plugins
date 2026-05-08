/**
 * TorrentClaw Popular Movies — media provider plugin.
 *
 * Fetches popular movies from the TorrentClaw public API.
 * Clicking download opens a modal that fetches ALL torrent variants
 * for that specific movie via the search API, with rich metadata tags.
 */
const API_BASE = "https://torrentclaw.com/api/v1";

const MAGNET_TRACKERS = [
  "udp://open.demonii.com:1337/announce",
  "udp://tracker.openbittorrent.com:80",
  "udp://tracker.coppersurfer.tk:6969",
  "udp://glotorrents.pw:6969/announce",
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://torrent.gresille.org:80/announce",
  "udp://p4p.arenabg.com:1337",
  "udp://tracker.leechers-paradise.org:6969",
];

function buildMagnet(hash, title) {
  const dn = encodeURIComponent(title);
  const tr = MAGNET_TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join("");
  return `magnet:?xt=urn:btih:${hash}&dn=${dn}${tr}`;
}

function fmtBytes(bytes) {
  if (!bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, n = Number(bytes);
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// ── Tags from a torrent variant ───────────────────────────────

function buildTags(tor) {
  const tags = [];
  if (tor.qualityScore != null)
    tags.push({ label: String(tor.qualityScore), variant: "success", icon: "mdi-shield-check", tooltip: "TrueSpec Quality Score" });
  if (tor.quality)
    tags.push({ label: tor.quality.toUpperCase(), variant: "warning", tooltip: "Resolution" });
  if (tor.hdrType)
    tags.push({ label: String(tor.hdrType).toUpperCase(), variant: "warning", tooltip: "HDR Type" });
  if (tor.sourceType)
    tags.push({ label: tor.sourceType.toUpperCase(), variant: "info", tooltip: "Source" });
  if (tor.codec)
    tags.push({ label: tor.codec.toLowerCase(), variant: "info", tooltip: "Video Codec" });
  if (tor.audioCodec) {
    const ch = tor.audioChannels ? ` ${tor.audioChannels}` : "";
    tags.push({ label: `${tor.audioCodec.toUpperCase()}${ch}`, variant: "accent", tooltip: "Audio Codec" });
  }
  if (tor.subtitles?.length > 0)
    tags.push({ label: String(tor.subtitles.length), variant: "default", icon: "mdi-subtitles", tooltip: `${tor.subtitles.length} subtitle(s)` });
  if (tor.languages?.length > 0) {
    for (const lang of tor.languages) {
      const flag = langToFlag(lang);
      if (flag) tags.push({ label: `${flag} ${lang.toUpperCase()}`, variant: "default", tooltip: `Audio: ${lang}` });
    }
  }
  return tags;
}

function langToFlag(code) {
  const map = {
    en: "\u{1F1EC}\u{1F1E7}", es: "\u{1F1EA}\u{1F1F8}", fr: "\u{1F1EB}\u{1F1F7}",
    de: "\u{1F1E9}\u{1F1EA}", it: "\u{1F1EE}\u{1F1F9}", pt: "\u{1F1F5}\u{1F1F9}",
    ru: "\u{1F1F7}\u{1F1FA}", ja: "\u{1F1EF}\u{1F1F5}", ko: "\u{1F1F0}\u{1F1F7}",
    zh: "\u{1F1E8}\u{1F1F3}", ar: "\u{1F1F8}\u{1F1E6}", nl: "\u{1F1F3}\u{1F1F1}",
    pl: "\u{1F1F5}\u{1F1F1}", sv: "\u{1F1F8}\u{1F1EA}", da: "\u{1F1E9}\u{1F1F0}",
    fi: "\u{1F1EB}\u{1F1EE}", no: "\u{1F1F3}\u{1F1F4}", cs: "\u{1F1E8}\u{1F1FF}",
    hu: "\u{1F1ED}\u{1F1FA}", ro: "\u{1F1F7}\u{1F1F4}", uk: "\u{1F1FA}\u{1F1E6}",
    el: "\u{1F1EC}\u{1F1F7}", tr: "\u{1F1F9}\u{1F1F7}", th: "\u{1F1F9}\u{1F1ED}",
    vi: "\u{1F1FB}\u{1F1F3}", hi: "\u{1F1EE}\u{1F1F3}",
  };
  return map[code.toLowerCase()] ?? null;
}

// ── Build a MediaLink from a torrent variant ─────────────────

function buildLink(tor, title) {
  const infoHash = tor.infoHash ?? tor.hash ?? "";
  let hash = "", magnet = "";
  if (infoHash && infoHash.length >= 40) {
    hash = infoHash.toLowerCase();
    magnet = buildMagnet(hash, title);
  }
  return {
    url: magnet,
    label: [tor.quality, tor.sourceType?.toUpperCase()].filter(Boolean).join(" "),
    quality: tor.quality,
    type: tor.sourceType,
    size: tor.sizeBytes ? fmtBytes(tor.sizeBytes) : undefined,
    seeds: tor.seeders,
    hash,
    tags: buildTags(tor),
  };
}

// ── Item builder ───────────────────────────────────────────────

function toMediaItem(item) {
  const title = item.titleOriginal || item.title || "";
  const tmdbId = item.tmdbId;

  // Return minimal item — full links fetched via detail()
  return {
    id: String(tmdbId || item.title || Math.random()),
    title,
    cover: item.posterUrl ?? undefined,
    year: item.year ? String(item.year) : undefined,
    rating: item.ratingTmdb != null ? Number(item.ratingTmdb) : undefined,
    genres: item.genres,
    genre: item.genres?.join(", "),
    description: item.overview,
    links: [],          // populated by detail()
    needsDetail: true,  // triggers modal + detail fetch
    sourceUrl: title,   // used as search query in detail()
    isSeries: false,
  };
}

// ── Fetch popular list ─────────────────────────────────────────

async function fetchItems(params) {
  const page = params.page || 1;
  const url = new URL(`${API_BASE}/popular`);
  url.searchParams.set("limit", String(Math.min(Number(params.limit) || 20, 50)));
  url.searchParams.set("page", String(page));

  const res = await fetch(url.toString(), {
    headers: { "User-Agent": "TransMule/1.0 torrentclaw-popular" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return { items: [], total: 0 };

  let body;
  try { body = await res.json(); } catch { return { items: [], total: 0 }; }

  const rawResults = body.results ?? body.data ?? body.items ?? body.torrents ?? [];
  if (!Array.isArray(rawResults)) return { items: [], total: 0 };

  const items = rawResults
    .filter((item) => (item.contentType || item.type || "") === "movie")
    .map(toMediaItem);

  if (items.length === 0 && rawResults.length > 0) {
    return {
      items: rawResults.map(toMediaItem),
      total: body.total ?? rawResults.length,
      page,
      hasMore: rawResults.length >= (Number(params.limit) || 20),
    };
  }

  return {
    items,
    total: body.total ?? items.length,
    page,
    hasMore: items.length >= (Number(params.limit) || 20),
  };
}

// ── Detail: fetch ALL torrents for a specific movie ────────────

async function detail(searchQuery) {
  if (!searchQuery) return {};

  const url = new URL(`${API_BASE}/search`);
  url.searchParams.set("q", searchQuery);
  url.searchParams.set("type", "movie");
  url.searchParams.set("limit", "50");

  const res = await fetch(url.toString(), {
    headers: { "User-Agent": "TransMule/1.0 torrentclaw-detail" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return {};

  let body;
  try { body = await res.json(); } catch { return {}; }

  const rawResults = body.results ?? body.data ?? body.items ?? [];
  if (!Array.isArray(rawResults) || rawResults.length === 0) return {};

  // Find the first movie result
  const match = rawResults.find(
    (item) => (item.contentType || item.type || "") === "movie",
  ) ?? rawResults[0];

  if (!match) return {};

  const title = match.titleOriginal || match.title || searchQuery;
  const torrents = match.torrents ?? [];

  return {
    links: torrents.map((tor) => buildLink(tor, title)),
    needsDetail: false,
  };
}

// ── Plugin export ──────────────────────────────────────────────

export default {
  meta: {
    id: "torrentclaw-movies",
    name: "TorrentClaw Popular",
    icon: "mdi-shield-check",
    mediaType: "movies",
    description:
      "Popular movies from TorrentClaw — 30+ sources, TrueSpec quality scores, rich metadata tags.",
    version: "1.0.0",
    repository:
      "https://raw.githubusercontent.com/Jo3l/transmule-plugins/main/manifest.json",
  },

  filters: [],

  async list(params) {
    return fetchItems(params);
  },

  async detail(sourceUrl) {
    return detail(sourceUrl);
  },
};
