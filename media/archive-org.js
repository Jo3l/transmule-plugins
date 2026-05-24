/**
 * Internet Archive search plugin — direct download (MediaProvider).
 *
 * Searches ALL Internet Archive content (movies, audio, books, software,
 * images, data, etc.) using the advancedsearch.php Elasticsearch API.
 *
 * Each item shows a modal with individual file downloads fetched lazily
 * from the archive.org metadata API. Files are sent to pyLoad.
 *
 * Supports rich filter fields: mediatype, language, sort, year range.
 *
 * API: https://archive.org/advancedsearch.php
 * Docs: https://archive.org/developers/index-apis.html
 */
const API_BASE = "https://archive.org";
const SEARCH_URL = `${API_BASE}/advancedsearch.php`;

// ── Filter options ────────────────────────────────────────────────

const MEDIATYPE_OPTIONS = [
  { label: "All", value: "" },
  { label: "Movies", value: "movies" },
  { label: "Audio", value: "audio" },
  { label: "Books / Texts", value: "texts" },
  { label: "Software", value: "software" },
  { label: "Image", value: "image" },
  { label: "Data", value: "data" },
  { label: "Music (etree)", value: "etree" },
  { label: "Web", value: "web" },
];

const LANGUAGE_OPTIONS = [
  { label: "All", value: "" },
  { label: "English", value: "eng" },
  { label: "Spanish", value: "spa" },
  { label: "French", value: "fre" },
  { label: "German", value: "ger" },
  { label: "Italian", value: "ita" },
  { label: "Portuguese", value: "por" },
  { label: "Russian", value: "rus" },
  { label: "Chinese", value: "chi" },
  { label: "Japanese", value: "jpn" },
  { label: "Arabic", value: "ara" },
  { label: "Dutch", value: "dut" },
  { label: "Polish", value: "pol" },
  { label: "Turkish", value: "tur" },
  { label: "Swedish", value: "swe" },
  { label: "Danish", value: "dan" },
  { label: "Finnish", value: "fin" },
  { label: "Norwegian", value: "nor" },
  { label: "Czech", value: "cze" },
  { label: "Greek", value: "gre" },
  { label: "Hebrew", value: "heb" },
  { label: "Hindi", value: "hin" },
  { label: "Hungarian", value: "hun" },
  { label: "Indonesian", value: "ind" },
  { label: "Korean", value: "kor" },
  { label: "Latin", value: "lat" },
  { label: "Romanian", value: "rum" },
  { label: "Ukrainian", value: "ukr" },
  { label: "Vietnamese", value: "vie" },
];

const SORT_OPTIONS = [
  { label: "Popularity (downloads)", value: "downloads desc" },
  { label: "Newest first", value: "publicdate desc" },
  { label: "Oldest first", value: "publicdate asc" },
  { label: "Title A-Z", value: "title asc" },
  { label: "Title Z-A", value: "title desc" },
  { label: "Weekly popular", value: "week desc" },
  { label: "Monthly popular", value: "month desc" },
  { label: "Rating", value: "avg_rating desc" },
];

const CATEGORY_ICONS = {
  movies: "mdi-filmstrip",
  audio: "mdi-music",
  texts: "mdi-book-open-variant",
  software: "mdi-application",
  image: "mdi-image",
  etree: "mdi-account-music",
  data: "mdi-database",
  web: "mdi-web",
};

// ── Helpers ──────────────────────────────────────────────────────

function formatSize(bytes) {
  if (bytes == null || isNaN(bytes)) return undefined;
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 ** 2;
  if (mb >= 1) return `${Math.round(mb)} MB`;
  const kb = bytes / 1024;
  if (kb >= 1) return `${Math.round(kb)} KB`;
  return `${bytes} B`;
}

function formatSizeSafe(sizeStr) {
  if (sizeStr == null) return undefined;
  const n = parseInt(sizeStr, 10);
  return isNaN(n) ? undefined : formatSize(n);
}

/**
 * Build the Elasticsearch query string from user-supplied filters.
 */
function buildQuery(params) {
  const parts = [];

  const query = (params.query || "").trim();
  if (query) {
    parts.push(query.includes(" ") ? `(${query})` : query);
  }

  if (params.mediatype) {
    parts.push(`mediatype:${params.mediatype}`);
  }

  if (params.language) {
    parts.push(`language:${params.language}`);
  }

  if (params.year_start) {
    parts.push(`year:[${params.year_start} TO *]`);
  }
  if (params.year_end) {
    parts.push(`year:[* TO ${params.year_end}]`);
  }

  return parts.length ? parts.join(" AND ") : "*:*";
}

/**
 * Extract the identifier from an archive.org details URL.
 * e.g. "https://archive.org/details/stackexchange" → "stackexchange"
 */
function identifierFromUrl(url) {
  const m = url && url.match(/\/details\/([^/?#]+)/);
  return m ? m[1] : null;
}

/** Formats we consider "real" downloadable content (not metadata/thumb/archive). */
const DOWNLOADABLE_FORMATS = [
  "7z", "zip", "tar", "gz", "bz2", "xz",
  "mp4", "avi", "mkv", "mov", "webm", "mpg", "mpeg",
  "mp3", "flac", "ogg", "wav", "m4a", "aac", "wma",
  "pdf", "epub", "mobi", "djvu", "cbz", "cbr",
  "jpg", "jpeg", "png", "gif", "tiff", "bmp",
  "iso", "img", "bin", "cue",
  "exe", "msi", "deb", "rpm", "apk",
  "dmg", "pkg",
  "csv", "json", "xml", "sqlite", "db",
];

function isDownloadableFile(file) {
  const format = (file.format || "").trim();
  // Skip metadata / thumb / torrent files
  if (!format) return false;
  const low = format.toLowerCase();
  if (low === "metadata" || low === "item tile" || low === "unknown" ||
      low === "archive bitTorrent" || low === "torrent" || low === "zip (.zip)") {
    return false;
  }
  // Also skip by extension
  const name = file.name || "";
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  if (ext === "torrent" || ext === "txt" || ext === "nfo") return false;
  if (DOWNLOADABLE_FORMATS.includes(format)) return true;
  if (DOWNLOADABLE_FORMATS.includes(ext)) return true;
  // Accept any original source file that isn't explicitly skip-listed
  return file.source === "original";
}

// ── Plugin export ─────────────────────────────────────────────────

export default {
  meta: {
    id: "archive-org",
    name: "Archive.org",
    icon: "mdi-archive",
    mediaType: "archive",
    description:
      "Search all Internet Archive content (movies, audio, books, software, images, data) — files download via pyLoad.",
    version: "2.2.0",
    repository:
      "https://raw.githubusercontent.com/Jo3l/transmule-plugins/main/manifest.json",
  },

  filters: [
    {
      key: "query",
      label: "Search all fields",
      type: "text",
      defaultValue: "",
    },
    {
      key: "mediatype",
      label: "Media type",
      type: "select",
      defaultValue: "",
      options: MEDIATYPE_OPTIONS,
    },
    {
      key: "language",
      label: "Language",
      type: "select",
      defaultValue: "",
      options: LANGUAGE_OPTIONS,
    },
    {
      key: "sort",
      label: "Sort by",
      type: "select",
      defaultValue: "downloads desc",
      options: SORT_OPTIONS,
    },
  ],

  async list(params) {
    const q = buildQuery(params);
    const rows = Math.min(parseInt(params.limit) || 50, 100);
    const page = parseInt(params.page) || 1;
    const sort = params.sort || "downloads desc";

    const qs = new URLSearchParams();
    qs.set("q", q);
    qs.append(
      "fl[]",
      [
        "identifier",
        "title",
        "mediatype",
        "creator",
        "description",
        "subject",
        "language",
        "year",
        "publicdate",
        "downloads",
        "item_size",
        "avg_rating",
        "num_reviews",
        "collection",
        "btih",
      ].join(","),
    );
    qs.set("sort", sort);
    qs.set("rows", String(rows));
    qs.set("page", String(page));
    qs.set("output", "json");

    let resp;
    try {
      resp = await fetch(`${SEARCH_URL}?${qs}`, {
        headers: { "User-Agent": "TransMule/1.0 archive-org" },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      return { items: [], total: 0, page };
    }

    if (!resp.ok) return { items: [], total: 0, page };

    let data;
    try {
      data = await resp.json();
    } catch {
      return { items: [], total: 0, page };
    }

    const docs = data?.response?.docs;
    if (!Array.isArray(docs)) return { items: [], total: 0, page };

    const items = docs.map((doc) => {
      const identifier = doc.identifier;
      const title = doc.title || identifier || "Unknown";

      const cover = identifier
        ? `${API_BASE}/services/img/${identifier}`
        : undefined;

      const size = doc.item_size != null
        ? formatSize(Number(doc.item_size))
        : undefined;

      // Empty initial links — detail() will fetch the file list lazily
      const links = [];

      // Build torrent download link using the direct .torrent file URL
      // NOTE: archive.org's btih field is NOT the real info hash, so we use the
      // .torrent URL directly — Transmission accepts .torrent URLs as add-source.
      let magnet;
      let infoHash;
      if (doc.btih) {
        infoHash = identifier;
        magnet = `${API_BASE}/download/${identifier}/${identifier}_archive.torrent`;
      }

      // language can be a string or array from API — normalize to single string
      const lang = Array.isArray(doc.language) ? doc.language[0] : doc.language;
      const genre = doc.mediatype || "other";
      const creators = doc.creator
        ? Array.isArray(doc.creator) ? doc.creator : [doc.creator]
        : [];

      const desc = doc.description
        ? (Array.isArray(doc.description) ? doc.description[0] : doc.description)
        : undefined;

      return {
        id: identifier,
        title,
        cover,
        year: doc.year ? String(doc.year) : undefined,
        date: doc.publicdate || undefined,
        description: desc ? desc.substring(0, 500) : undefined,
        format: genre.charAt(0).toUpperCase() + genre.slice(1),
        size,
        genre: genre.charAt(0).toUpperCase() + genre.slice(1),
        genres: [genre, ...creators.slice(0, 2)],
        language: lang || undefined,
        rating: doc.avg_rating != null ? Number(doc.avg_rating) : undefined,
        links,
        magnet,
        infoHash,
        sourceUrl: `${API_BASE}/details/${identifier}`,
        needsDetail: true,
        isSeries: false,
      };
    });

    return {
      items,
      total: data?.response?.numFound ?? 0,
      page,
      hasMore: (page * rows) < (data?.response?.numFound ?? 0),
    };
  },

  /**
   * Fetch individual file list from an item's metadata API.
   * Called lazily when the user opens the item's modal.
   */
  async detail(sourceUrl) {
    const identifier = identifierFromUrl(sourceUrl);
    if (!identifier) return { links: [] };

    let resp;
    try {
      resp = await fetch(`${API_BASE}/metadata/${identifier}`, {
        headers: { "User-Agent": "TransMule/1.0 archive-org" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return { links: [] };
    }

    if (!resp.ok) return { links: [] };

    let data;
    try {
      data = await resp.json();
    } catch {
      return { links: [] };
    }

    const files = data?.files;
    if (!Array.isArray(files)) return { links: [] };

    // Build the detail page URL for metadata
    const detailsUrl = `${API_BASE}/details/${identifier}`;

    // Check if there's a .torrent file
    // NOTE: archive.org's btih field is NOT the real info hash, so we use the
    // .torrent file URL directly — Transmission accepts .torrent URLs as add-source.
    const torrentFile = files.find((f) => {
      const fmt = (f.format || '').trim().toLowerCase();
      const name = (f.name || '').toLowerCase();
      return fmt === 'archive bittorrent' || name.endsWith('.torrent');
    });
    let torrentLink = null;
    if (torrentFile) {
      const torrentUrl = `${API_BASE}/download/${identifier}/${torrentFile.name}`;
      torrentLink = {
        label: `⬇ ${torrentFile.name}`,
        url: torrentUrl,
        quality: 'TORRENT',
        size: formatSizeSafe(torrentFile.size),
        service: 'transmission',
      };
    }

    // Filter and sort files: original source first, then by size desc
    const downloadable = files
      .filter(isDownloadableFile)
      .sort((a, b) => {
        // Original files first
        if (a.source === "original" && b.source !== "original") return -1;
        if (a.source !== "original" && b.source === "original") return 1;
        // Then by size descending
        return (parseInt(b.size) || 0) - (parseInt(a.size) || 0);
      });

    if (!downloadable.length) {
      // Fallback: return the details page as a single link
      return {
        links: [
          {
            label: "View on Archive.org",
            url: detailsUrl,
            service: "pyload",
          },
        ],
      };
    }

    const fileLinks = downloadable.map((f) => {
      const downloadUrl = `${API_BASE}/download/${identifier}/${f.name}`;
      const formatted = formatSizeSafe(f.size);
      const ext = f.name.includes(".") ? f.name.split(".").pop().toUpperCase() : "";
      return {
        label: f.name,
        url: downloadUrl,
        quality: ext,
        size: formatted,
        service: "pyload",
      };
    });

    // Torrent link first (default), then individual file downloads
    const allLinks = torrentLink
      ? [torrentLink, ...fileLinks]
      : fileLinks;

    return {
      links: allLinks,
    };
  },
};
