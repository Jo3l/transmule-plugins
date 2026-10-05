/**
 * DonTorrent — películas (plugin de contenido).
 *
 * Dos cosas que la web cambia a menudo y que antes rompían el plugin:
 *
 * 1. **El dominio rota.** El dominio vigente se resuelve en caliente desde la
 *    página oficial de enlaces (privtr.ee/@DonTorrent → bloque "Dominio
 *    Actual") y se cachea. Cualquier URL que llegue por `params.url` conserva
 *    su ruta pero se reescribe al dominio vigente, así que un dominio caducado
 *    en el frontend o en las preferencias del usuario no rompe la búsqueda.
 *
 * 2. **Las descargas llevan Proof-of-Work.** Ya no hay enlaces `.torrent`
 *    directos en el HTML: el botón tiene `class="protected-download"` con
 *    `data-content-id`/`data-tabla`, y el fichero se obtiene resolviendo el PoW
 *    contra `/api_validate_pow.php` (challenge SHA-256 con `difficulty` ceros).
 *
 * 3. **El catálogo son tres listados paginados.** `/peliculas`,
 *    `/peliculas/hd` y `/peliculas/4K` no se solapan entre sí y cada uno
 *    pagina con `/page/N`. La página N de TransMule es la mezcla de la página
 *    N de los tres. `/ultimos` (Estrenos) no está paginado y se mapea al
 *    catálogo.
 */
import { createHash } from "node:crypto";

const DOMAIN_PAGE = "https://privtr.ee/@DonTorrent";
const FALLBACK_ORIGIN = "https://dontorrent.moi";
const DEFAULT_PATH = "/peliculas"; // catálogo de películas (paginado)
const CATALOG_PATH = "/peliculas";
/** Listados que se mezclan con el catálogo, paginados en paralelo. */
const CATALOG_COMPANIONS = ["/peliculas/hd", "/peliculas/4K"];

const DOMAIN_TTL_MS = 30 * 60 * 1000; // re-resolver el dominio cada 30 min
const DOMAIN_RETRY_MS = 5 * 60 * 1000; // si privtr falla, reintentar en 5 min
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // listado / detalle

const POW_PATH = "/api_validate_pow.php";
const POW_DIFFICULTY = 3;

/** Rutas antiguas que siguen guardadas en las preferencias de los usuarios. */
const LEGACY_PATHS = Object.assign(Object.create(null), {
  // `/ultimos` (Estrenos) no tiene paginación: la sección de películas es el
  // catálogo paginado.
  "/ultimos": "/peliculas",
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
 * ruta (`/peliculas/page/3`) y sirve la primera página sin sufijo. Un sufijo
 * que venga en la URL entrante (preferencias antiguas, recargas) se descarta
 * para no acumular `/page/2/page/3`.
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

/** ¿La URL apunta al catálogo de películas? (solo ahí se mezclan HD y 4K) */
function isCatalogPath(url) {
  try {
    const p = new URL(url).pathname
      .replace(/\/page\/\d+\/?$/i, "")
      .replace(/\/+$/, "");
    return p.toLowerCase() === CATALOG_PATH;
  } catch {
    return false;
  }
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
    /<a\s[^>]*href=["']([^"']*?pelicula\/(\d+)(?:\/\d+)?\/([^"'#?/\s]+))["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;

  while ((m = linkRe.exec(H)) !== null) {
    const [, rawHref, id, slug, inner] = m;
    const path = rawHref.replace(/^https?:\/\/[^/]+/i, "").replace(/^\/?/, "/");
    if (seen.has(path)) continue;
    seen.add(path);

    const imgTag = /<img[^>]*>/i.exec(inner)?.[0] ?? "";
    const src = /src=["']([^"']+)["']/i.exec(imgTag)?.[1] ?? "";
    const alt = /alt=["']([^"']*)["']/i.exec(imgTag)?.[1] ?? "";

    // Formato: paréntesis del texto/alt (listado simple) o `[BluRay-1080p]`
    // del nombre de la carátula (listado de tarjetas).
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

async function parseDetailPage(html, origin, pageUrl) {
  const H = normalizeEntities(html);

  const coverSrc =
    /<img[^>]+src=["']([^"']*images\.weserv\.nl[^"']*)["']/i.exec(H)?.[1] ??
    /<img[^>]*class=["'][^"']*img-thumbnail[^"']*["'][^>]*src=["']([^"']+)["']/i.exec(
      H,
    )?.[1] ??
    "";

  const year = field(H, "Año");
  const genre = field(H, "Género");
  const director = field(H, "Dirección");
  const actors = field(H, "Reparto");
  const pageFormat = cleanFormat(field(H, "Formato"));
  const pageSize = field(H, "Tamaño");
  const description = field(H, "Descripción");

  // Botón de descarga protegido: aporta el id de contenido y la tabla.
  const dlTag =
    /<a\b[^>]*class=["'][^"']*\bprotected-download\b[^"']*["'][^>]*>/i.exec(
      H,
    )?.[0] ?? "";
  const contentId = /data-content-id=["'](\d+)["']/.exec(dlTag)?.[1] ?? "";
  const tabla = /data-tabla=["']([\w-]+)["']/.exec(dlTag)?.[1] ?? "peliculas";

  const links = [];
  if (contentId) {
    const url = await resolveDownloadUrl(origin, contentId, tabla, pageUrl);

    const quality =
      detectQuality(`${url} ${pageFormat}`) || detectQuality(pageFormat) || null;
    const type = detectSourceType(`${url} ${pageFormat}`) || null;

    const tags = [];
    if (quality) {
      tags.push({ label: quality, variant: "warning", tooltip: "Resolución" });
    }
    if (type) {
      tags.push({ label: type, variant: "info", tooltip: "Fuente" });
    }

    links.push({
      url,
      label:
        [quality, type].filter(Boolean).join(" ") || pageFormat || "Descargar",
      quality: quality || undefined,
      type: type || undefined,
      size: pageSize || undefined,
      tags,
    });
  } else {
    // Layout antiguo: enlace `.torrent` / magnet directo en la ficha.
    const legacy =
      /<a\s[^>]*href=["']((?:magnet:\?[^"']+|(?:https?:)?\/\/[^"']+\.torrent|[^"']*\/descargar\/[^"']*))["'][^>]*>/i.exec(
        H,
      )?.[1] ?? "";
    if (legacy) {
      const url = rebaseUrl(httpsify(legacy), origin);
      const quality = detectQuality(`${url} ${pageFormat}`) || null;
      const type = detectSourceType(`${url} ${pageFormat}`) || null;
      const tags = [];
      if (quality) {
        tags.push({ label: quality, variant: "warning", tooltip: "Resolución" });
      }
      if (type) tags.push({ label: type, variant: "info", tooltip: "Fuente" });
      links.push({
        url,
        label:
          [quality, type].filter(Boolean).join(" ") || pageFormat || "Descargar",
        quality: quality || undefined,
        type: type || undefined,
        size: pageSize || undefined,
        tags,
      });
    }
  }

  // Sin botón protegido ni enlace directo: la ficha no es descargable (404
  // encubierto o cambio de layout). Mejor un error claro que un item vacío.
  if (links.length === 0) {
    throw new Error(
      "DonTorrent: la ficha no ofrece ninguna descarga (contenido eliminado o layout cambiado)",
    );
  }

  return {
    cover: httpsify(coverSrc),
    year,
    genre,
    director,
    actors,
    format: pageFormat,
    size: pageSize,
    description,
    links,
    needsDetail: true,
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
    isSeries: false,
  };
}

export default {
  meta: {
    id: "dontorrent-movies",
    name: "DonTorrent",
    icon: "mdi-movie-play",
    mediaType: "movies",
    description: "DonTorrent movie torrents (Spanish)",
    version: "1.3.0",
    repository:
      "https://raw.githubusercontent.com/Jo3l/transmule-plugins/main/manifest.json",
  },

  async list(params = {}) {
    const origin = await getBaseOrigin();
    const page = pageNumber(params.page);
    const mainUrl = withPage(
      withCurrentOrigin(params.url, origin, DEFAULT_PATH),
      page,
    );

    // El catálogo son tres listados que no se solapan: la página N de
    // TransMule es la página N de `/peliculas` + `/peliculas/hd` +
    // `/peliculas/4K`. Si en la barra de URL hay otra sección, se respeta tal
    // cual y no se mezcla nada.
    const urls = isCatalogPath(mainUrl)
      ? [mainUrl, ...CATALOG_COMPANIONS.map((p) => withPage(origin + p, page))]
      : [mainUrl];

    if (params._noCache) {
      _listCache.clear();
      _detailCache.clear();
    }

    const cacheKey = urls.join(" ");
    const cached = _listCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      return { items: cached.data.map(toMediaItem), hasMore: cached.hasMore };
    }

    // La sección principal manda: si falla, el error sube tal cual. Las
    // acompañantes son best-effort (una sección caída no tira el listado).
    const main = await fetchHtml(urls[0]);
    const companions = await Promise.all(
      urls.slice(1).map((u) => fetchHtml(u).catch(() => null)),
    );

    const merged = [];
    const seen = new Set();
    let hasMore = false;
    for (const res of [main, ...companions]) {
      if (!res) continue;
      // Una sección más corta recorta a su última página: seguiría sirviendo
      // los mismos items en cada página siguiente, así que se ignora.
      const pag = parsePagination(res.html);
      if (pag.page !== page) continue;
      if (pag.hasMore) hasMore = true;
      const effectiveOrigin = normalizeOrigin(res.finalUrl) || origin;
      for (const item of parseListingPage(res.html, effectiveOrigin)) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        merged.push(item);
      }
    }

    // Una página vacía no debe ofrecer "Siguiente": el frontend pediría otra
    // y volvería a salir vacía.
    if (merged.length === 0) hasMore = false;

    _listCache.set(cacheKey, { ts: Date.now(), data: merged, hasMore });
    return { items: merged.map(toMediaItem), hasMore };
  },

  async detail(sourceUrl) {
    const origin = await getBaseOrigin();
    const cached = _detailCache.get(sourceUrl);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      // El dominio puede haber rotado: recolocamos los .torrent cacheados.
      return {
        ...cached.data,
        links: (cached.data.links || []).map((l) => ({
          ...l,
          url: rebaseUrl(l.url, origin),
        })),
      };
    }
    const pageUrl = withCurrentOrigin(sourceUrl, origin, "/");
    const { html, finalUrl } = await fetchHtml(pageUrl);
    const effectiveOrigin = normalizeOrigin(finalUrl) || origin;
    const result = await parseDetailPage(html, effectiveOrigin, pageUrl);
    _detailCache.set(sourceUrl, { ts: Date.now(), data: result });
    return result;
  },
};
