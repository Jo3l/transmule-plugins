/**
 * TorrentClaw torrent-search plugin for TransMule.
 *
 * Searches 30+ torrent sources through the TorrentClaw public API with rich
 * metadata tags: quality score, resolution, codec, HDR, audio, languages
 * (with flag emojis), source type, and TrueSpec verification.
 *
 * ## Public API (no key needed)
 *
 * The search endpoint works anonymously — results include info hashes so
 * magnet links can be constructed. Rate limits are lower without a key.
 *
 * For higher quotas, set an API key via environment variable:
 *   TORRENTCLAW_API_KEY=***  tc_your_key_here
 * Get one at https://torrentclaw.com/profile?tab=apikey
 *
 * Full API docs: https://torrentclaw.com/api/openapi.json
 *                https://torrentclaw.com/llms.txt
 */
export default {
  meta: {
    id: "torrentclaw",
    name: "TorrentClaw",
    icon: "mdi-shield-check",
    pluginType: "torrent-search",
    description:
      "TorrentClaw — 30+ sources, TrueSpec quality scores, rich metadata tags.",
    version: "1.0.0",
    repository:
      "https://raw.githubusercontent.com/Jo3l/transmule-plugins/main/manifest.json",
  },

  async search(query, limit, extraTrackers) {
    const apiKey =
      (typeof process !== "undefined" && process.env?.TORRENTCLAW_API_KEY) || "";

    const params = new URLSearchParams({
      q: query,
      limit: String(Math.min(limit, 50)),
      locale: "es",
    });
    const url = `https://torrentclaw.com/api/v1/search?${params}`;

    const headers = { "User-Agent": "TransMule/1.0 torrent-search" };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const resp = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return [];

    let body;
    try {
      body = await resp.json();
    } catch {
      return [];
    }

    const results = body.results ?? body.torrents ?? [];
    if (!Array.isArray(results) || results.length === 0) return [];

    return results.slice(0, limit).flatMap((item) => {
      const torrents = item.torrents ?? [item];
      return torrents.map((tor) =>
        buildResult(item, tor, query, extraTrackers),
      );
    });
  },
};

// ── Result builder ─────────────────────────────────────────────────────────

function buildResult(item, tor, query, extraTrackers) {
  const quality = tor.quality ?? "";
  const name = tor.rawTitle ?? tor.name ?? item.title ?? query;
  const infoHash = tor.infoHash ?? tor.hash ?? "";
  const sourceType = tor.sourceType ?? "";
  const sizeBytes = tor.sizeBytes ?? tor.size ?? 0;
  const seeders = tor.seeders ?? 0;
  const leechers = tor.leechers ?? 0;
  const score = tor.qualityScore ?? null;
  const codec = tor.codec ?? "";
  const audioCodec = tor.audioCodec ?? null;
  const languages = tor.languages ?? [];
  const hdrType = tor.hdrType ?? null;
  const subsCount = tor.subtitles?.length ?? null;
  const audioChannels = tor.audioChannels ?? null;

  // Build magnet from info hash
  let magnet = "";
  let hash = "";
  if (infoHash && infoHash.length >= 40) {
    hash = infoHash.toLowerCase();
    magnet = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}${extraTrackers}`;
  }

  // ── Build tags ───────────────────────────────────────────────────────
  const tags = [];

  // TrueSpec quality score badge
  if (score != null) {
    tags.push({
      label: String(score),
      variant: "success",
      icon: "mdi-shield-check",
      tooltip: "TrueSpec Quality Score",
    });
  }

  // Resolution / quality badge
  if (quality) {
    tags.push({
      label: quality.toUpperCase(),
      variant: "warning",
      tooltip: "Resolution",
    });
  }

  // HDR badge
  if (hdrType) {
    tags.push({
      label: String(hdrType).toUpperCase(),
      variant: "warning",
      tooltip: "HDR Type",
    });
  }

  // Source type badge (WEB-DL, BluRay, HDTV, etc.)
  if (sourceType) {
    tags.push({
      label: sourceType.toUpperCase(),
      variant: "info",
      tooltip: "Source",
    });
  }

  // Video codec badge
  if (codec) {
    tags.push({
      label: codec.toLowerCase(),
      variant: "info",
      tooltip: "Video Codec",
    });
  }

  // Audio codec badge
  if (audioCodec) {
    const ch = audioChannels ? ` ${audioChannels}` : "";
    tags.push({
      label: `${audioCodec.toUpperCase()}${ch}`,
      variant: "accent",
      tooltip: "Audio Codec",
    });
  }

  // Subtitle count badge
  if (subsCount != null && subsCount > 0) {
    tags.push({
      label: `${subsCount}`,
      variant: "default",
      icon: "mdi-subtitles",
      tooltip: `${subsCount} subtitle language(s)`,
    });
  }

  // Language flags (emoji)
  if (languages && languages.length > 0) {
    for (const lang of languages) {
      const flag = langToFlag(lang);
      if (flag) {
        tags.push({
          label: `${flag} ${lang.toUpperCase()}`,
          variant: "default",
          tooltip: `Audio: ${lang}`,
        });
      }
    }
  }

  return {
    name,
    rawTitle: item.titleOriginal || item.title || null,
    magnet,
    infoHash: hash,
    size: sizeBytes ? Number(sizeBytes) : null,
    seeders: Number(seeders) || 0,
    leechers: Number(leechers) || 0,
    uploadedAt: null,
    source: "torrentclaw",
    category: item.contentType === "show" ? "TV Shows" : "Movies",
    cover: item.posterUrl ?? null,
    tags,
  };
}

// ── Language → flag emoji mapping ─────────────────────────────────────────

function langToFlag(code) {
  const map = {
    en: "🇬🇧",
    es: "🇪🇸",
    fr: "🇫🇷",
    de: "🇩🇪",
    it: "🇮🇹",
    pt: "🇵🇹",
    ru: "🇷🇺",
    ja: "🇯🇵",
    ko: "🇰🇷",
    zh: "🇨🇳",
    ar: "🇸🇦",
    nl: "🇳🇱",
    pl: "🇵🇱",
    sv: "🇸🇪",
    da: "🇩🇰",
    fi: "🇫🇮",
    no: "🇳🇴",
    cs: "🇨🇿",
    hu: "🇭🇺",
    ro: "🇷🇴",
    uk: "🇺🇦",
    el: "🇬🇷",
    tr: "🇹🇷",
    th: "🇹🇭",
    vi: "🇻🇳",
    hi: "🇮🇳",
  };
  return map[code.toLowerCase()] ?? null;
}
