/**
 * indexerr — buscador unificado de torrents (definiciones Cardigann/Jackett).
 *
 * Plugin AUTÓNOMO. Instala sus propias rutas de API (definiciones + instancias)
 * y declara su sección de settings, que el frontend renderiza de forma genérica.
 * Usa la capacidad `cardigann` del core (motor genérico de indexers, inyectado
 * vía `install(ctx)`) y `ctx.storage` para persistir el catálogo y las
 * instancias. El core no conoce indexerr: solo inyecta la capacidad declarada.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Estado capturado en install(ctx). Los handlers de rutas y search() lo usan.
const state = { ctx: null };

// ─── Definiciones propias (origen mixto) ─────────────────────────────────────
// El catálogo final = definiciones de Jackett (sync en runtime, GPL-2.0) +
// definiciones NUESTRAS (autoría original, YAML escrito a mano) servidas desde
// el repo transmule-plugins (`indexerr/definitions/`, manifest.json + .yml).
// Nunca se bundlean en la imagen: se descargan en runtime como las de Jackett.
const CUSTOM_DEFS_BASE =
  "https://raw.githubusercontent.com/Jo3l/transmule-plugins/main/indexerr/definitions";
const CUSTOM_DEFS_DIR = resolve("data", "cardigann-definitions-custom");

// El botón "Habilitar definiciones públicas" activa una instancia por cada
// definición `type: public` del catálogo (Jackett + propias). Se calcula a
// partir del catálogo real (no una lista fija), así el botón hace algo útil
// aunque el sync de Jackett no esté disponible (solo definiciones propias).

// ─── Helpers de estado (ctx.storage) ────────────────────────────────────────
function catalog() {
  return state.ctx?.storage.get("catalog") ?? [];
}
function instances() {
  return state.ctx?.storage.get("instances") ?? [];
}
function saveInstances(list) {
  state.ctx?.storage.set("instances", list);
}
function configSchema(def) {
  return (def?.settings ?? []).map((s) => ({
    name: s.name,
    type: s.type,
    label: s.label ?? s.name,
    default: s.default,
    options: s.options,
    required: s.required,
  }));
}

/** Fetch con timeout (definiciones propias desde el repo de plugins). */
async function fetchText(url) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${url}`);
  return resp.text();
}

/**
 * Descarga las definiciones propias (manifest.json + .yml) desde el repo
 * transmule-plugins y las persiste en disco (mismo patrón que Jackett).
 * Devuelve las entradas de catálogo con `yml_path` apuntando al cache local.
 */
async function syncCustomDefinitions() {
  const ctx = state.ctx;
  if (!ctx) return [];
  let manifest;
  try {
    manifest = JSON.parse(await fetchText(`${CUSTOM_DEFS_BASE}/manifest.json`));
  } catch (err) {
    ctx.log(
      `definiciones custom: manifest no disponible (${err?.message ?? err})`,
    );
    return [];
  }
  if (!Array.isArray(manifest)) return [];

  mkdirSync(CUSTOM_DEFS_DIR, { recursive: true });
  const catalog = [];
  const manifestFiles = new Set();
  for (const entry of manifest) {
    if (!entry?.file) continue;
    manifestFiles.add(entry.file);
    try {
      const yml = await fetchText(`${CUSTOM_DEFS_BASE}/${entry.file}`);
      const def = ctx.cardigann.parseDefinition(yml);
      if (!def.id || !def.name) {
        ctx.log(`definicion custom '${entry.file}': sin id/name, ignorada`);
        continue;
      }
      writeFileSync(join(CUSTOM_DEFS_DIR, entry.file), yml, "utf8");
      catalog.push({
        id: String(def.id),
        name: def.name,
        description: def.description ?? null,
        type: def.type ?? null,
        language: def.language ?? null,
        yml_path: join(CUSTOM_DEFS_DIR, entry.file),
        custom: true, // marca de origen: definición propia de transmule-plugins
      });
    } catch (err) {
      ctx.log(`definicion custom '${entry.file}': ${err?.message ?? err}`);
    }
  }
  // Limpieza: borrar del cache definiciones que ya no están en el manifest.
  if (existsSync(CUSTOM_DEFS_DIR)) {
    for (const f of readdirSync(CUSTOM_DEFS_DIR)) {
      if (f.endsWith(".yml") && !manifestFiles.has(f)) {
        try {
          unlinkSync(join(CUSTOM_DEFS_DIR, f));
        } catch {}
      }
    }
  }
  return catalog;
}

/**
 * Sincroniza las definiciones de Jackett + las propias y persiste el catálogo
 * MIXTO (origen doble). Si Jackett publicara un YAML con el mismo id que una
 * definición propia, gana la de Jackett (mantenida upstream); las propias
 * rellenan los huecos (los 67 indexers que solo existen en C#).
 */
async function sync() {
  const ctx = state.ctx;
  if (!ctx) return { synced: 0, freshClone: false };
  const { synced, freshClone, catalog: jackett } =
    await ctx.cardigann.syncDefinitions();
  const custom = await syncCustomDefinitions();

  const byId = new Map();
  for (const d of jackett) byId.set(d.id, d);
  for (const d of custom) if (!byId.has(d.id)) byId.set(d.id, d);
  const catalog = [...byId.values()];

  if (catalog.length > 0) ctx.storage.set("catalog", catalog);
  ctx.log(
    `definiciones sincronizadas: ${jackett.length} jackett + ${custom.length} custom = ${catalog.length}${freshClone ? " (clone fresco)" : ""}`,
  );
  return { synced: catalog.length, freshClone };
}

export default {
  meta: {
    id: "indexerr",
    name: "Indexerr",
    icon: "mdi-magnify",
    pluginType: "torrent-search",
    capability: "cardigann",
    description:
      "Búsqueda de torrents unificada — definiciones de indexers estilo Jackett/Cardigann.",
    version: "1.2.1",
    repository:
      "https://raw.githubusercontent.com/Jo3l/transmule-plugins/main/manifest.json",
  },

  install(ctx) {
    state.ctx = ctx;
    // Sync diario + primer sync a los 15 s del arranque (fire-and-forget).
    ctx.interval(() => void sync(), 24 * 60 * 60 * 1000);
    setTimeout(() => void sync(), 15_000);
  },

  // search() es el SPI del core para torrent-search: el core solo lo invoca,
  // sin saber qué hace por dentro. `subSource` es el id de la instancia
  // (tracker_id) cuando el usuario busca una definición concreta.
  async search(query, limit, extraTrackers, subSource) {
    let insts = instances().filter((i) => i.enabled !== false && i.tracker_id);
    if (subSource) insts = insts.filter((i) => i.tracker_id === subSource);
    const results = await state.ctx.cardigann.search(
      query,
      limit,
      extraTrackers,
      insts,
      catalog(),
    );
    // Identificar cada resultado por su sub-fuente ("indexerr:1337x").
    return results.map((r) => ({ ...r, source: `indexerr:${r.source}` }));
  },

  // Rutas de API instaladas por el plugin (dispatch genérico del core).
  routes: {
    "GET /definitions": () => {
      const instanceMap = {};
      for (const i of instances()) {
        if (i.tracker_id) {
          instanceMap[i.tracker_id] = {
            id: i.id,
            name: i.name,
            enabled: i.enabled !== false,
            config: i.config ?? {},
          };
        }
      }
      return {
        definitions: catalog().map((d) => ({
          id: d.id,
          name: d.name,
          description: d.description,
          type: d.type,
          language: d.language,
          custom: d.custom === true,
        })),
        instances: instanceMap,
      };
    },

    "GET /definitions/:id": ({ params }) => {
      const meta = catalog().find((d) => d.id === params.id);
      if (!meta) throw state.ctx.httpError(404, `Indexer "${params.id}" not found`);
      const def = state.ctx.cardigann.loadDefinition(meta);
      if (!def) throw state.ctx.httpError(422, "Definition failed to load");
      return {
        id: meta.id,
        name: meta.name,
        description: meta.description,
        type: meta.type,
        language: meta.language,
        configSchema: configSchema(def),
      };
    },

    "POST /definitions/refresh": async () => {
      const { synced, freshClone } = await sync();
      return { ok: true, synced, freshClone };
    },

    "GET /instances": () => ({ instances: instances() }),

    "POST /instances": ({ body }) => {
      const { tracker_id, name, config } = body ?? {};
      if (!tracker_id) throw state.ctx.httpError(400, "tracker_id is required");
      const meta = catalog().find((d) => d.id === tracker_id);
      if (!meta) throw state.ctx.httpError(404, `Indexer "${tracker_id}" not found`);
      const inst = {
        id: randomUUID(),
        tracker_id,
        name: name || meta.name,
        enabled: true,
        config: config ?? {},
      };
      const list = instances();
      list.push(inst);
      saveInstances(list);
      return { instance: inst };
    },

    "POST /instances/enable-public": () => {
      const cat = catalog();
      const existing = new Set(instances().map((i) => i.tracker_id));
      const list = instances();
      let added = 0;
      for (const d of cat) {
        if (d.type !== "public") continue; // solo trackers públicos
        if (!d.id) continue;
        if (existing.has(d.id)) continue; // ya configurado
        list.push({
          id: randomUUID(),
          tracker_id: d.id,
          name: d.name,
          enabled: true,
          config: {},
        });
        existing.add(d.id);
        added++;
      }
      saveInstances(list);
      return { ok: true, added };
    },

    "PATCH /instances/:id": ({ params, body }) => {
      const list = instances();
      const idx = list.findIndex((i) => i.id === params.id);
      if (idx < 0) throw state.ctx.httpError(404, `Instance "${params.id}" not found`);
      const next = { ...list[idx] };
      if (body?.name !== undefined) next.name = body.name;
      if (body?.enabled !== undefined) next.enabled = !!body.enabled;
      if (body?.config !== undefined) next.config = body.config;
      list[idx] = next;
      saveInstances(list);
      return { ok: true, instance: next };
    },

    "DELETE /instances/:id": ({ params }) => {
      const list = instances().filter((i) => i.id !== params.id);
      saveInstances(list);
      return { ok: true };
    },

    "POST /instances/:id/test": async ({ params, body }) => {
      const inst = instances().find((i) => i.id === params.id);
      if (!inst) throw state.ctx.httpError(404, `Instance "${params.id}" not found`);
      const meta = catalog().find((d) => d.id === inst.tracker_id);
      if (!meta) throw state.ctx.httpError(404, `Indexer "${inst.tracker_id}" not found`);
      const def = state.ctx.cardigann.loadDefinition(meta);
      if (!def) throw state.ctx.httpError(422, "Definition failed to load");
      const query = (body?.query ?? "").trim() || "test";
      try {
        const results = await state.ctx.cardigann.runSearch(
          def,
          inst.config ?? {},
          { keywords: query },
          5,
        );
        return {
          ok: true,
          count: results.length,
          sample: results.slice(0, 3).map((r) => r.name),
        };
      } catch (err) {
        return { ok: false, count: 0, error: err?.message ?? String(err) };
      }
    },
  },

  // Sub-fuentes de búsqueda: cada instancia habilitada se muestra como fuente
  // ("Indexerr-1337x") en los buscadores global y de Transmission.
  sources: {
    list: { method: "GET", path: "/instances" },
    itemsKey: "instances",
    idField: "tracker_id",
    labelField: "name",
    enabledField: "enabled",
  },

  // Descriptor de sección de settings (render genérico en el frontend).
  settings: {
    type: "collection-manager",
    title: "Indexerr",
    description:
      "Configura los indexadores de torrents (definiciones Jackett/Cardigann).",
    toolbar: [
      {
        key: "refresh",
        label: "Actualizar definiciones",
        icon: "mdi-refresh",
        method: "POST",
        path: "/definitions/refresh",
      },
      {
        key: "enable-public",
        label: "Habilitar definiciones públicas",
        icon: "mdi-check-all",
        method: "POST",
        path: "/instances/enable-public",
        hideWhenEmpty: true,
      },
    ],
    list: {
      method: "GET",
      path: "/definitions",
      itemsKey: "definitions",
      idField: "id",
      labelField: "name",
      metaFields: ["type", "language"],
      configuredKey: "instances",
      addLabel: "Configurar",
    },
    item: {
      schema: { method: "GET", path: "/definitions/:id" },
      create: { method: "POST", path: "/instances" },
      update: { method: "PATCH", path: "/instances/:id" },
      remove: { method: "DELETE", path: "/instances/:id" },
      test: { method: "POST", path: "/instances/:id/test" },
    },
  },
};
