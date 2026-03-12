const DEFAULT_URL = "https://www21.dontorrent.link/descargar-series";
const HD_URL = "https://www21.dontorrent.link/series/hd";
const BASE_ORIGIN = "https://www21.dontorrent.link";
const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  Accept: "text/html",
};

function slugToTitle(slug) {
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function parseListingPage(html) {
  const seen = new Set();
  const items = [];

  const cardRe =
    /<a[^>]+href=["']((?:https?:\/\/[^"']*)?\/(pelicula|serie)\/(\d+)(?:\/\d+)?\/([^"'#?/]+))["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;

  while ((m = cardRe.exec(html)) !== null) {
    const [, rawHref, , id, slug, inner] = m;
    const url = rawHref.startsWith("http") ? rawHref : BASE_ORIGIN + rawHref;
    if (seen.has(url)) continue;
    seen.add(url);

    const imgMatch = /<img[^>]+src=["']([^"']+)["']/i.exec(inner);
    const cover = imgMatch?.[1] ?? "";
    const altMatch = /<img[^>]+alt=["']([^"']+)["']/i.exec(inner);
    const title = altMatch ? altMatch[1].trim() : slugToTitle(slug);
    const fmtMatch = /\(([^)]+)\)/.exec(inner);
    const format = fmtMatch?.[1] ?? "";

    items.push({ id, title, url, cover, format, date: "" });
  }

  if (items.length === 0) {
    const listRe =
      />(\d{4}-\d{2}-\d{2})<\/span>\s*<a[^>]+href=["']((?:https?:\/\/[^"']*)?\/?\b(?:pelicula|serie)\/(\d+)(?:\/\d+)?\/([^"'#?/\s]+))["'][^>]*>([^<]+)<\/a>(?:\s*<span[^>]*>\s*\(([^)]+)\)\s*<\/span>)?/gi;
    while ((m = listRe.exec(html)) !== null) {
      const [, date, rawHref, id, slug, titleRaw, format] = m;
      const href = rawHref.startsWith("/") ? rawHref : "/" + rawHref;
      const url = rawHref.startsWith("http") ? rawHref : BASE_ORIGIN + href;
      if (seen.has(url)) continue;
      seen.add(url);
      items.push({
        id,
        title: titleRaw.trim() || slugToTitle(slug),
        url,
        cover: "",
        format: format ?? "",
        date: date ?? "",
      });
    }
  }

  return items.slice(0, 24);
}

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&oacute;/g, "ó")
    .replace(/&aacute;/g, "á")
    .replace(/&eacute;/g, "é")
    .replace(/&iacute;/g, "í")
    .replace(/&uacute;/g, "ú")
    .replace(/&ntilde;/g, "ñ")
    .replace(/&Ntilde;/g, "Ñ")
    .replace(/&uuml;/g, "ü")
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)))
    .replace(/\s{2,}/g, " ")
    .trim();
}

function parseSeriesPage(html) {
  const coverMatch =
    /img[^>]+src=["'](https?:\/\/(?:images\.weserv\.nl|[^"']*cdnbeta[^"']*|[^"']*imagenes\/series[^"']*))["']/i.exec(
      html,
    );
  const cover = coverMatch?.[1] ?? "";

  const fmtMatch =
    /Formato[:\s]+([A-Z0-9][A-Z0-9\-_.]*(?:\s[A-Z0-9][A-Z0-9\-_.]*)*)/i.exec(
      html,
    );
  const format = fmtMatch ? fmtMatch[1].trim() : "";

  const epCountMatch = /Episodios[:\s]+(\d+)/i.exec(html);
  const epCount = epCountMatch ? epCountMatch[1] : "";

  let description = "";
  const textJustifyMatch =
    /<p[^>]*class=["'][^"']*text-justify[^"']*["'][^>]*>([\s\S]*?)<\/p>/i.exec(
      html,
    );
  if (textJustifyMatch) {
    description = stripTags(textJustifyMatch[1]).trim();
  }

  const episodes = [];
  const linkRe =
    /<a\s[^>]*\bhref=["']((?:magnet:\?[^"']+|(?:https?:)?\/\/[^"']+\.torrent|[^"']*torrent\/(?:file|download)=[^"']*))["'][^>]*>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const rawUrl = m[1];
    const torrentUrl = rawUrl.startsWith("//") ? "https:" + rawUrl : rawUrl;
    const pos = m.index;

    const before = html.slice(Math.max(0, pos - 400), pos);
    const codeMatch =
      /(\d+x\d+)\s*<\/td>\s*$/.exec(before) ??
      /(\d+x\d+)/.exec(before.slice(-100));
    if (!codeMatch) continue;
    const code = codeMatch[1];

    const after = html.slice(pos + m[0].length, pos + m[0].length + 400);
    const dateMatch = /(\d{4}-\d{2}-\d{2})/.exec(after);
    const date = dateMatch?.[1] ?? "";

    episodes.push({
      code,
      links: [{ label: format || "Download", url: torrentUrl }],
      date,
    });
  }

  return {
    cover,
    format,
    size: epCount ? `${epCount} ep.` : "",
    description,
    episodes,
    isSeries: true,
    links: episodes[0]?.links ?? [],
  };
}

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const _listCache = new Map();
const _detailCache = new Map();

function toMediaItem(r) {
  return {
    id: r.id,
    title: r.title,
    cover: r.cover || undefined,
    date: r.date || undefined,
    format: r.format || undefined,
    links: [],
    sourceUrl: r.url,
    needsDetail: true,
    isSeries: true,
  };
}

export default {
  meta: {
    id: "dontorrent-shows",
    name: "DonTorrent",
    icon: "mdi-movie-play",
    mediaType: "shows",
    description: "DonTorrent series torrents (Spanish)",
    version: "1.0.0",
    repository:
      "https://raw.githubusercontent.com/Jo3l/transmule-plugins/main/manifest.json",
  },

  async list(params) {
    const listUrl = params.url || DEFAULT_URL;
    const cached = _listCache.get(listUrl);
    if (cached && Date.now() - cached.ts < SIX_HOURS_MS) {
      return { items: cached.data.map(toMediaItem) };
    }

    const [mainRes, hdRes] = await Promise.all([
      fetch(listUrl, { headers: FETCH_HEADERS }),
      fetch(HD_URL, { headers: FETCH_HEADERS }).catch(() => null),
    ]);

    if (!mainRes.ok) throw new Error(`DonTorrent error: ${mainRes.status}`);
    const mainHtml = await mainRes.text();
    const mainItems = parseListingPage(mainHtml);

    let hdItems = [];
    if (hdRes?.ok) {
      const hdHtml = await hdRes.text();
      hdItems = parseListingPage(hdHtml);
    }

    const seen = new Set();
    const merged = [];
    for (const item of [...mainItems, ...hdItems]) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        merged.push(item);
      }
    }

    _listCache.set(listUrl, { ts: Date.now(), data: merged });
    return { items: merged.map(toMediaItem) };
  },

  async detail(sourceUrl) {
    const cached = _detailCache.get(sourceUrl);
    if (cached && Date.now() - cached.ts < SIX_HOURS_MS) return cached.data;
    const res = await fetch(sourceUrl, { headers: FETCH_HEADERS });
    if (!res.ok) throw new Error(`DonTorrent detail error: ${res.status}`);
    const html = await res.text();
    const result = parseSeriesPage(html);
    _detailCache.set(sourceUrl, { ts: Date.now(), data: result });
    return result;
  },
};
