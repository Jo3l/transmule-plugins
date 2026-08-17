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

// Estado capturado en install(ctx). Los handlers de rutas y search() lo usan.
const state = { ctx: null };

// Los 7 trackers legacy que había antes de unificarlos en Indexerr.
// El botón "Habilitar definiciones públicas" activa estas instancias
// (ids de indexer en el catálogo Cardigann de Jackett).
const LEGACY_TRACKERS = [
  "1337x",
  "eztv",
  "nyaasi",
  "thepiratebay",
  "kickasstorrents-to",
  "torrentkitty",
  "yts",
];

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

/** Sincroniza definiciones desde Jackett y persiste el catálogo. */
async function sync() {
  const ctx = state.ctx;
  if (!ctx) return { synced: 0, freshClone: false };
  const { synced, freshClone, catalog: cat } =
    await ctx.cardigann.syncDefinitions();
  if (synced > 0) ctx.storage.set("catalog", cat);
  ctx.log(
    `definiciones sincronizadas: ${synced}${freshClone ? " (clone fresco)" : ""}`,
  );
  return { synced, freshClone };
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
    version: "1.0.0",
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
      for (const id of LEGACY_TRACKERS) {
        const d = cat.find((c) => c.id === id);
        if (!d) continue; // tracker no disponible en el catálogo
        if (existing.has(id)) continue; // ya configurado
        list.push({
          id: randomUUID(),
          tracker_id: d.id,
          name: d.name,
          enabled: true,
          config: {},
        });
        existing.add(id);
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
