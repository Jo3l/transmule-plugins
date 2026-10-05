/**
 * DonTorrent — series (plugin de contenido).
 *
 * Dos cosas que la web cambia a menudo y que antes rompían el plugin:
 *
 * 1. **El dominio rota.** El dominio vigente se resuelve en caliente desde la
 *    página oficial de enlaces (privtr.ee/@DonTorrent → bloque "Dominio
 *    Actual") y se cachea. Cualquier URL que llegue por `params.url` conserva
 *    su ruta (incluido el antiguo `/descargar-series` → `/series`) pero se
 *    reescribe al dominio vigente.
 *
 * 2. **Las descargas llevan Proof-of-Work.** Cada episodio es ahora un botón
 *    `class="protected-download"` con `data-content-id`/`data-tabla`, y el
 *    `.torrent` se obtiene resolviendo el PoW contra `/api_validate_pow.php`.
 *    Se resuelven con concurrencia limitada y se cachean por episodio.
 */
import { createHash } from "node:crypto";

const DOMAIN_PAGE = "https://privtr.ee/@DonTorrent";
const FALLBACK_ORIGIN = "https://dontorrent.moi";
const DEFAULT_PATH = "/series"; // `/descargar-series` redirige aquí
const HD_PATH = "/series/hd";

const DOMAIN_TTL_MS = 30 * 60 * 1000; // re-resolver el dominio cada 30 min
const DOMAIN_RETRY_MS = 5 * 60 * 1000; // si privtr falla, reintentar en 5 min
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // listado / detalle

const POW_PATH = "/api_validate_pow.php";
const POW_DIFFICULTY = 3;
const EPISODE_CONCURRENCY = 4; // PoW en paralelo, sin martillear la web

/** Rutas antiguas que siguen guardadas en las preferencias de los usuarios. */
const LEGACY_PATHS = Object.assign(Object.create(null), {
  "/descargar-series": "/series",
});

const OUR_HOST = /dontorrent/i;

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
  "Accept-Language": "es-ES,es;q=0.9",
};

// ── Dominio rotatorio ──────────────────────────────────────────────

let _origin = null;
let _originTs = 0;

function normalizeOrigin(value) {
  if (!value) return null;
  let raw = String(value).trim();
  if (raw.startsWith("//")) raw = "https:" + raw;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/** Extrae el dominio vigente del HTML de privtr.ee/@DonTorrent. */
function extractDomain(html) {
  const boot =
    /<script[^>]*id=["']visitor-bootstrap["'][^>]*>([\s\S]*?)<\/script>/i.exec(
      html,
    );
  if (boot) {
    try {
      const data = JSON.parse(boot[1]);
      const links = Array.isArray(data?.links) ? data.links : [];
      const pick = (pred) =>
        links.find((l) => typeof l?.url === "string" && pred(l));
      const hit =
        pick((l) => /dominio\s*actual/i.test(l.title || "")) ||
        pick((l) => OUR_HOST.test(l.url));
      const origin = normalizeOrigin(hit?.url);
      if (origin) return origin;
    } catch {
      /* bootstrap no parseable — probamos el HTML crudo */
    }
  }
  const raw = /https?:\/\/[a-z0-9.-]*dontorrent[a-z0-9.-]*/i.exec(html);
  return raw ? normalizeOrigin(raw[0]) : null;
}

/** Devuelve el origen vigente de DonTorrent (cacheado, con último-conocido). */
async function getBaseOrigin(force = false) {
  const now = Date.now();
  if (!force && _origin && now - _originTs < DOMAIN_TTL_MS) return _origin;
  try {
    const res = await fetch(DOMAIN_PAGE, {
      headers: FETCH_HEADERS,
      redirect: "follow",
    });
    if (res.ok) {
      const origin = extractDomain(await res.text());
      if (origin) {
        _origin = origin;
        _originTs = now;
        return origin;
      }
    }
  } catch {
    /* red caída o página bloqueada: tiramos del último dominio conocido */
  }
  if (!_origin) _origin = FALLBACK_ORIGIN;
  // Reintento rápido si falló, sin martillear la página en cada petición.
  _originTs = now - DOMAIN_TTL_MS + DOMAIN_RETRY_MS;
  return _origin;
}

/**
 * Reescribe una URL al dominio vigente conservando la ruta.
 * - URL de nuestro dominio (aunque esté caducado) → mismo path, host nuevo.
 * - URL ajena → se respeta tal cual.
 * - Sin URL → `origin + fallbackPath`.
 */
function withCurrentOrigin(url, origin, fallbackPath) {
  if (!url) return origin + fallbackPath;
  let u;
  try {
    u = new URL(String(url).startsWith("//") ? "https:" + url : String(url));
  } catch {
    const path = String(url).startsWith("/") ? url : "/" + url;
    return origin + path;
  }
  if (!OUR_HOST.test(u.hostname)) return url;
  const path = LEGACY_PATHS[u.pathname] || u.pathname;
  return origin + path + u.search;
}

/** Recoloca una URL resuelta (p. ej. el .torrent) en el dominio vigente. */
function rebaseUrl(url, origin) {
  try {
    const u = new URL(url);
    if (!OUR_HOST.test(u.hostname)) return url;
    return origin + u.pathname + u.search;
  } catch {
    return url;
  }
}


/**
 * Página pedida por el frontend (1 si no viene o no es válida). El middleware
 * convierte `?page=` a número antes de llamar al plugin.
 */
function pageNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 1 ? Math.floor(n) : 1;
}

/**
 * Fija la página en una URL de listado. DonTorrent pagina con un sufijo de
 * ruta (`/series/page/3`) y sirve la primera página sin sufijo. Un sufijo que
 * venga en la URL entrante (preferencias antiguas, recargas) se descarta para
 * no acumular `/page/2/page/3`.
 */
function withPage(url, page) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const base = u.pathname.replace(/\/page\/\d+\/?$/i, "").replace(/\/+$/, "");
  const path = page > 1 ? `${base}/page/${page}` : base || "/";
  return u.origin + path + u.search;
}

/**
 * Lee la paginación del nav de la propia web. La numeración viene recortada a
 * una ventana, así que el número mayor NO es el total: la señal fiable de "no
 * hay más" es el chevron derecho dentro de un `li.disabled` (y cuando se pide
 * una página mayor que la última, la web recorta y deshabilita el chevron).
 */
function parsePagination(html) {
  const nav =
    /<nav[^>]*class=["'][^"']*page-navigator[^"']*["'][^>]*>([\s\S]*?)<\/nav>/i.exec(
      html,
    )?.[1] ?? "";
  if (!nav) return { hasMore: false, page: 1 };

  const nextChunk =
    nav.split(/<li\b/i).slice(1).find((c) => /fa-chevron-right/i.test(c)) ?? "";
  const nextHead = nextChunk.slice(0, nextChunk.indexOf(">"));
  const nextDisabled = /\bdisabled\b/i.test(nextHead);

  const numbers = [...nav.matchAll(/\/page\/(\d+)/gi)].map((m) => Number(m[1]));
  const active =
    Number(
      /<li[^>]*class=["'][^"']*\bactive\b[^"']*["'][^>]*>[\s\S]*?<a[^>]*>\s*(\d+)\s*</i.exec(
        nav,
      )?.[1] ?? 0,
    ) || 1;
  const maxPage = numbers.length ? Math.max(...numbers) : active;

  return { hasMore: !nextDisabled && maxPage > active, page: active };
}

/** Descarga HTML con un reintento si el dominio ha rotado o el fetch falla. */
async function fetchHtml(url, retry = true) {
  let status = 0;
  let lastErr = null;
  try {
    const res = await fetch(url, { headers: FETCH_HEADERS, redirect: "follow" });
    if (res.ok) return { html: await res.text(), finalUrl: res.url || url };
    status = res.status;
  } catch (err) {
    lastErr = err;
  }
  if (retry) {
    const origin = await getBaseOrigin(true);
    let path = "/";
    try {
      path = new URL(url).pathname;
    } catch {
      /* conservamos "/" */
    }
    const next = withCurrentOrigin(url, origin, path);
    if (next !== url) return fetchHtml(next, false);
  }
  throw new Error(
    `DonTorrent error${status ? `: ${status}` : `: ${lastErr?.message || "red"}`}`,
  );
}

// ── Texto / entidades ──────────────────────────────────────────────

// Solo entidades "de texto" (acentos, símbolos). Deliberadamente NO tocamos
// `&lt;`/`&gt;`/`&quot;`/`&amp;` aquí: decodificarlas antes de parsear rompería
// el marcado y los atributos.
const TEXT_ENTITIES = {
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", uuml: "ü",
  Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú", Uuml: "Ü",
  ntilde: "ñ", Ntilde: "Ñ", iexcl: "¡", iquest: "¿", ordm: "º", ordf: "ª",
  middot: "·", laquo: "«", raquo: "»", nbsp: " ",
};

function normalizeEntities(s) {
  return String(s)
    .replace(/&([a-zA-Z]+);/g, (m, name) => TEXT_ENTITIES[name] ?? m)
    .replace(/&#(\d+);/g, (m, n) =>
      Number(n) > 127 ? String.fromCodePoint(Number(n)) : m,
    )
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) =>
      parseInt(h, 16) > 127 ? String.fromCodePoint(parseInt(h, 16)) : m,
    );
}

function stripTags(html) {
  return normalizeEntities(String(html))
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)))
    .replace(/\s{2,}/g, " ")
    .trim();
}

function slugToTitle(slug) {
  return String(slug).replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function httpsify(url) {
  const v = String(url || "").trim();
  if (!v) return "";
  return v.startsWith("//") ? "https:" + v : v;
}

/** Lee un campo `<b>Etiqueta:</b> valor…` de una ficha de detalle. */
function field(html, label) {
  const re = new RegExp(
    `<b[^>]*>\\s*${label}\\s*:\\s*<\\/b>\\s*([\\s\\S]*?)(?=<\\/p>|<\\/div>|<br|<b[^>]*>|$)`,
    "i",
  );
  const m = re.exec(html);
  if (!m) return "";
  // stripTags mete un espacio por etiqueta: arreglamos "Baker , Jay".
  return stripTags(m[1]).replace(/\s+([,.;:])/g, "$1");
}

// ── Calidad / fuente ───────────────────────────────────────────────

function detectQuality(text) {
  const m =
    /\b(?:2160[Pp]|4[Kk]|1080[Pp]|720[Pp]|480[Pp]|360[Pp]|UHD[ -]?2160[Pp]?|FULL[ -]?HD|HD[ -]?READY|SD)\b/.exec(
      text || "",
    );
  return m ? m[0].toUpperCase() : null;
}

function detectSourceType(text) {
  const m =
    /\b(BLURAY|WEB[- ]?DL|WEB[- ]?RIP|HDRIP|HDTV|DVDRIP|DVD[ -]?RIP|BRRIP|BDRIP|MICROHD|TS|CAM|TELESYNC|SCREENER)\b/i.exec(
      text || "",
    );
  return m ? m[0].toUpperCase().replace(/[-\s]/g, "-") : null;
}

/** Formato tal como aparece en el nombre de fichero: `[BluRay-1080p]`. */
const FORMAT_TAG =
  /(?:bluray|bdrip|brrip|web-?dl|web-?rip|hdrip|hdtv|dvdrip|dvd-?rip|microhd|2160p|1080p|720p|4k|vose|castellano|dual)/i;

function formatFromName(name) {
  for (const m of String(name || "").matchAll(/\[([^\]]+)\]/g)) {
    if (FORMAT_TAG.test(m[1])) return m[1];
  }
  return "";
}

const EMPTY_FORMATS = /^(ninguno|none|null|-|n\/a)$/i;

function cleanFormat(value) {
  const v = String(value || "").trim();
  return !v || EMPTY_FORMATS.test(v) ? "" : v;
}

// ── Proof of Work ──────────────────────────────────────────────────

function solvePow(challenge, difficulty = POW_DIFFICULTY) {
  const target = "0".repeat(difficulty);
  for (let nonce = 0; nonce < 5_000_000; nonce++) {
    const hex = createHash("sha256")
      .update(`${challenge}${nonce}`)
      .digest("hex");
    if (hex.startsWith(target)) return nonce;
  }
  throw new Error("DonTorrent PoW: no se encontró solución");
}

/**
 * Resuelve la URL real del `.torrent` de un contenido protegido.
 * `contentId` + `tabla` salen del propio botón de descarga de la ficha.
 */
async function resolveDownloadUrl(origin, contentId, tabla, referer) {
  const endpoint = origin + POW_PATH;
  const headers = {
    ...FETCH_HEADERS,
    Accept: "application/json",
    "Content-Type": "application/json",
    Referer: referer || origin + "/",
  };

  const genRes = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      action: "generate",
      content_id: Number(contentId),
      tabla,
    }),
  });
  const gen = await genRes.json().catch(() => ({}));
  if (!genRes.ok || !gen?.success || !gen.challenge) {
    throw new Error(gen?.error || `DonTorrent PoW generate: ${genRes.status}`);
  }

  const nonce = solvePow(gen.challenge);

  const valRes = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      action: "validate",
      challenge: gen.challenge,
      nonce,
    }),
  });
  const val = await valRes.json().catch(() => ({}));

  if (valRes.status === 429 || val?.status === "limit_exceeded") {
    throw new Error(
      `DonTorrent: límite de descargas alcanzado (espera ${val?.wait_minutes ?? "?"} min)`,
    );
  }
  if (val?.status === "captcha_required") {
    throw new Error("DonTorrent: la web pide captcha (límite temporal por IP)");
  }
  if (!valRes.ok || !val?.success || !val.download_url) {
    throw new Error(val?.error || `DonTorrent PoW validate: ${valRes.status}`);
  }

  const raw = String(val.download_url);
  return raw.startsWith("//")
    ? "https:" + raw
    : raw.startsWith("/")
      ? origin + raw
      : raw;
}

// ── Listado ────────────────────────────────────────────────────────

function parseListingPage(html, origin) {
  const H = normalizeEntities(html);
  const seen = new Set();
  const items = [];

  const linkRe =
    /<a\s[^>]*href=["']([^"']*?serie\/(\d+)(?:\/\d+)?\/([^"'#?/\s]+))["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;

  while ((m = linkRe.exec(H)) !== null) {
    const [, rawHref, id, slug, inner] = m;
    const path = rawHref.replace(/^https?:\/\/[^/]+/i, "").replace(/^\/?/, "/");
    if (seen.has(path)) continue;
    seen.add(path);

    const imgTag = /<img[^>]*>/i.exec(inner)?.[0] ?? "";
    const src = /src=["']([^"']+)["']/i.exec(imgTag)?.[1] ?? "";
    const alt = /alt=["']([^"']*)["']/i.exec(imgTag)?.[1] ?? "";

    const after = H.slice(m.index + m[0].length, m.index + m[0].length + 220);
    const format = cleanFormat(
      /\(([^)]+)\)/.exec(alt)?.[1] ||
        /<span[^>]*>\s*\(([^)]+)\)/.exec(after)?.[1] ||
        /\(([^)]+)\)/.exec(stripTags(inner))?.[1] ||
        formatFromName(src),
    );

    const before = H.slice(Math.max(0, m.index - 220), m.index);
    const date = />(\d{4}-\d{2}-\d{2})</.exec(before)?.[1] ?? "";

    items.push({
      id,
      title: stripTags(alt) || stripTags(inner) || slugToTitle(slug),
      url: origin + path,
      cover: httpsify(src),
      format,
      date,
    });
  }

  return items;
}

// ── Detalle ────────────────────────────────────────────────────────

/** Resuelve (y cachea) la URL del .torrent de un episodio. */
const _resolvedEpisodes = new Map();

async function resolveEpisodeUrl(origin, contentId, tabla, referer) {
  const key = `${tabla}:${contentId}`;
  const hit = _resolvedEpisodes.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) {
    return rebaseUrl(hit.url, origin);
  }
  const url = await resolveDownloadUrl(origin, contentId, tabla, referer);
  _resolvedEpisodes.set(key, { ts: Date.now(), url });
  return url;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

function buildTags(quality, type, locked) {
  const tags = [];
  if (quality) {
    tags.push({ label: quality, variant: "warning", tooltip: "Resolución" });
  }
  if (type) tags.push({ label: type, variant: "info", tooltip: "Fuente" });
  if (locked) {
    tags.push({
      label: "Contraseña",
      icon: "mdi-lock",
      variant: "warning",
      tooltip: "El torrent lleva contraseña",
    });
  }
  return tags;
}

async function parseSeriesPage(html, origin, pageUrl) {
  const H = normalizeEntities(html);

  const coverSrc =
    /<img[^>]+src=["']([^"']*images\.weserv\.nl[^"']*)["']/i.exec(H)?.[1] ??
    /<img[^>]*class=["'][^"']*img-thumbnail[^"']*["'][^>]*src=["']([^"']+)["']/i.exec(
      H,
    )?.[1] ??
    "";

  const format = cleanFormat(field(H, "Formato"));
  const epCount = field(H, "Episodios");
  const description = field(H, "Descripción");

  // Cada episodio es una fila con `<td>1x01</td>` + botón protegido + fecha.
  const btnRe =
    /<a\b[^>]*class=["'][^"']*\bprotected-download\b[^"']*["'][^>]*>/gi;
  const found = [];
  let m;
  while ((m = btnRe.exec(H)) !== null) {
    const tag = m[0];
    const contentId = /data-content-id=["'](\d+)["']/.exec(tag)?.[1];
    if (!contentId) continue;
    const tabla = /data-tabla=["']([\w-]+)["']/.exec(tag)?.[1] || "series";

    const before = H.slice(Math.max(0, m.index - 400), m.index);
    const code = [...before.matchAll(/(\d{1,2}x\d{1,3})/g)].pop()?.[1] ?? "";
    const after = H.slice(m.index + tag.length, m.index + tag.length + 400);
    const date = /(\d{4}-\d{2}-\d{2})/.exec(after)?.[1] ?? "";
    const rowEnd = H.indexOf("</tr>", m.index);
    const row = H.slice(m.index, rowEnd === -1 ? m.index + 600 : rowEnd);

    found.push({
      code,
      contentId,
      tabla,
      date,
      locked: /con\s+contrase/i.test(row),
    });
  }

  let episodes;
  if (found.length) {
    episodes = await mapLimit(found, EPISODE_CONCURRENCY, async (ep) => {
      const link = { label: format || "Descargar" };
      try {
        const url = await resolveEpisodeUrl(origin, ep.contentId, ep.tabla, pageUrl);
        const quality = detectQuality(url) || detectQuality(format) || null;
        const type = detectSourceType(`${url} ${format}`) || null;
        Object.assign(link, {
          url,
          label: [quality, type].filter(Boolean).join(" ") || format || "Descargar",
          quality: quality || undefined,
          type: type || undefined,
          tags: buildTags(quality, type, ep.locked),
        });
      } catch (err) {
        // Un episodio que falla no debe tumbar la ficha entera: se muestra la
        // fila con el motivo, sin URL de descarga.
        link.error = err?.message || "No se pudo resolver la descarga";
        link.tags = buildTags(null, null, ep.locked);
        console.warn(
          `[dontorrent-shows] ${ep.code || ep.contentId}: ${link.error}`,
        );
      }
      return { code: ep.code || "?", links: link.url ? [link] : [], date: ep.date, error: link.error };
    });
  } else {
    // Layout antiguo: enlaces directos .torrent / magnet en la ficha.
    episodes = [];
    const legacyRe =
      /<a\s[^>]*\bhref=["']((?:magnet:\?[^"']+|(?:https?:)?\/\/[^"']+\.torrent|[^"']*torrent\/(?:file|download)=[^"']*))["'][^>]*>/gi;
    const seen = new Set();
    let lm;
    while ((lm = legacyRe.exec(H)) !== null) {
      const url = rebaseUrl(httpsify(lm[1]), origin);
      if (seen.has(url)) continue;
      seen.add(url);
      const before = H.slice(Math.max(0, lm.index - 400), lm.index);
      const code = [...before.matchAll(/(\d{1,2}x\d{1,3})/g)].pop()?.[1] ?? "";
      const after = H.slice(lm.index + lm[0].length, lm.index + lm[0].length + 400);
      const date = /(\d{4}-\d{2}-\d{2})/.exec(after)?.[1] ?? "";
      const quality = detectQuality(url) || detectQuality(format) || null;
      const type = detectSourceType(`${url} ${format}`) || null;
      episodes.push({
        code: code || url.slice(-24),
        links: [
          {
            url,
            label: [quality, type].filter(Boolean).join(" ") || format || "Descargar",
            quality: quality || undefined,
            type: type || undefined,
            tags: buildTags(quality, type, false),
          },
        ],
        date,
      });
    }
  }

  // Sin episodios (ni protegidos ni legacy): la ficha no es descargable (404
  // encubierto o cambio de layout). Mejor un error claro que una lista vacía.
  if (episodes.length === 0) {
    throw new Error(
      "DonTorrent: la ficha no tiene episodios descargables (contenido eliminado o layout cambiado)",
    );
  }

  return {
    cover: httpsify(coverSrc),
    format,
    size: epCount ? `${epCount} ep.` : "",
    description,
    episodes,
    isSeries: true,
    links: episodes[0]?.links ?? [],
  };
}

// ── Cache ──────────────────────────────────────────────────────────

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
    version: "1.2.0",
    repository:
      "https://raw.githubusercontent.com/Jo3l/transmule-plugins/main/manifest.json",
  },

  async list(params = {}) {
    const origin = await getBaseOrigin();
    const page = pageNumber(params.page);
    const listUrl = withPage(
      withCurrentOrigin(params.url, origin, DEFAULT_PATH),
      page,
    );
    const hdUrl = withPage(withCurrentOrigin(null, origin, HD_PATH), page);

    if (params._noCache) {
      _listCache.clear();
      _detailCache.clear();
      _resolvedEpisodes.clear();
    }

    const cached = _listCache.get(listUrl);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      return { items: cached.data.map(toMediaItem), hasMore: cached.hasMore };
    }

    const [main, hd] = await Promise.all([
      fetchHtml(listUrl),
      fetchHtml(hdUrl).catch(() => null),
    ]);

    const effectiveOrigin = normalizeOrigin(main.finalUrl) || origin;
    const mainPag = parsePagination(main.html);
    // `/series` tiene muchas más páginas que `/series/hd`: cuando la página
    // pedida se pasa del final de HD, la web recorta a la última y repetiría
    // los mismos episodios en cada página. Solo mezclamos HD si sirvió de
    // verdad la página pedida.
    const hdPag = hd ? parsePagination(hd.html) : null;
    const hdPage = hdPag && hdPag.page === page;
    const merged = [];
    const seen = new Set();
    for (const item of [
      ...parseListingPage(main.html, effectiveOrigin),
      ...(hd && hdPage ? parseListingPage(hd.html, effectiveOrigin) : []),
    ]) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      merged.push(item);
    }

    const hasMore = mainPag.hasMore || Boolean(hdPage && hdPag.hasMore);
    _listCache.set(listUrl, { ts: Date.now(), data: merged, hasMore });
    return { items: merged.map(toMediaItem), hasMore };
  },

  async detail(sourceUrl) {
    const origin = await getBaseOrigin();
    const cached = _detailCache.get(sourceUrl);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      // El dominio puede haber rotado: recolocamos los .torrent cacheados.
      const rebase = (links) =>
        (links || []).map((l) => ({ ...l, url: rebaseUrl(l.url, origin) }));
      return {
        ...cached.data,
        links: rebase(cached.data.links),
        episodes: (cached.data.episodes || []).map((ep) => ({
          ...ep,
          links: rebase(ep.links),
        })),
      };
    }
    const pageUrl = withCurrentOrigin(sourceUrl, origin, "/");
    const { html, finalUrl } = await fetchHtml(pageUrl);
    const effectiveOrigin = normalizeOrigin(finalUrl) || origin;
    const result = await parseSeriesPage(html, effectiveOrigin, pageUrl);
    _detailCache.set(sourceUrl, { ts: Date.now(), data: result });
    return result;
  },
};
