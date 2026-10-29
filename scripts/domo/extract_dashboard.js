// Extract a Domo dashboard page into canonical JSON for compare_dashboards.py.
//
// Why: Domo has no export for card definitions, and every id (card, Beast Mode, dataset) differs
// between instances. This pulls each card's full definition, swaps Beast Mode ids for their names,
// resolves nested DOMO_BEAST_MODE(n) references to formula text, and records the columns each
// dataset view exposes, so two pages in different instances can be diffed by name.
//
// Usage: open the dashboard page while signed in, paste this whole file into the DevTools console
// (Cmd+Opt+J). The JSON is copied to the clipboard; save it with e.g.
//   pbpaste > docs/_domo_export/compare/sandbox_fte_reporting.json
// The page id is read from the URL; override with window.DOMO_PAGE_ID = 123 before pasting.
(async () => {
  const pageId = window.DOMO_PAGE_ID || Number(location.pathname.match(/\/page\/(\d+)/)?.[1]);
  if (!pageId) throw new Error('Open a /page/<id> URL or set window.DOMO_PAGE_ID');
  const get = (u) => fetch(u, { credentials: 'include' });

  const stackRes = await get(`/api/content/v3/stacks/${pageId}/cards?parts=metadata,metadataOverrides,datasources,drillPathURNs,subscriptions,slicers&includeFiltered=true`);
  if (!stackRes.ok) throw new Error(`stack fetch failed: ${stackRes.status}`);
  const stack = await stackRes.json();
  const pageRes = await get(`/api/content/v1/pages/${pageId}`);
  const page = pageRes.ok ? await pageRes.json() : {};

  const cards = [];
  const byId = {};      // calculation_<guid> -> { name, formula, ds }
  const byTemplate = {}; // templateId -> { name, formula }, for DOMO_BEAST_MODE(n)
  const datasets = new Map();

  for (const c of stack.cards) {
    const r = await fetch('/api/content/v3/cards/kpi/definition', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dynamicText: true, variables: true, urn: String(c.id) }),
    });
    const def = r.ok ? (await r.json()).definition || {} : {};
    const ds = (c.subscriptions || []).map((s) => s.dataSourceName);
    (c.subscriptions || []).forEach((s) => datasets.set(s.dataSourceName, s.dataSourceId));
    for (const f of def.formulas || []) {
      byTemplate[f.templateId] = { name: f.name.trim(), formula: f.formula };
      byId[f.id] = { name: f.name.trim(), formula: f.formula, ds: ds[0] };
    }
    const subs = {};
    for (const s of Object.values(def.subscriptions || {})) {
      subs[s.name] = {
        columns: s.columns, filters: s.filters, dateRangeFilter: s.dateRangeFilter,
        dateGrain: s.dateGrain, groupBy: s.groupBy, orderBy: s.orderBy, limit: s.limit,
      };
    }
    const overrides = (c.metadataOverrides?.components || []).map((x) => {
      const o = { ...x.overrides };
      // Collapsed rows are lists of real names; their content is not configuration.
      if (o.collapsed_filters && o.collapsed_filters !== 'none') o.collapsed_filters = '[collapsed rows]';
      return o;
    });
    cards.push({
      id: c.id, title: c.title, type: c.type, chart: c.metadata?.chartType ?? null, datasets: ds,
      subscriptions: subs,
      slicers: (c.slicers || []).map((s) => ({ column: s.column, operator: s.operator, values: s.values })),
      overrides, columnAliases: JSON.parse(c.metadata?.columnAliases || '{}'),
      description: c.description ?? null,
      dynamicTitle: def.dynamicTitle?.text?.map((t) => t.text).join('') ?? null,
      drillPaths: (c.drillPathURNs || []).length,
      modified: def.modified ?? null,
    });
  }

  // Replace calculation ids with "BM:<name>" everywhere so instances compare by name.
  const usedIds = new Set();
  const named = JSON.parse(JSON.stringify(cards).replace(/calculation_[0-9a-f-]+/g, (id) => {
    usedIds.add(id);
    return byId[id] ? `BM:${byId[id].name}` : id;
  }));
  const resolve = (text, depth = 0) => text.replace(/DOMO_BEAST_MODE\((\d+)\)/g, (m, n) =>
    byTemplate[n] && depth < 5 ? `[${byTemplate[n].name}: ${resolve(byTemplate[n].formula, depth + 1)}]` : m);
  const resolved = {};
  for (const id of usedIds) {
    const f = byId[id];
    if (f) resolved[`${f.ds} :: ${f.name}`] = resolve(f.formula).replace(/\s+/g, ' ').trim();
  }
  // Sorted so two extracts of an unchanged page are byte-identical.
  const formulas = Object.fromEntries(Object.keys(resolved).sort().map((k) => [k, resolved[k]]));

  const schemas = {};
  for (const [name, id] of datasets) {
    const t = await (await get(`/api/query/v1/datasources/${id}/schema/indexed?includeHidden=false`)).text();
    schemas[name] = [...new Set((t.match(/"name":"[^"`]+"/g) || []).map((z) => z.slice(8, -1)))]
      .filter((z) => z !== 'base' && z !== 'mapping');
  }

  const out = {
    instance: location.host, pageId, pageTitle: page.title ?? stack.title,
    extractedAt: new Date().toISOString(), cards: named, formulas, schemas,
    datasetIds: Object.fromEntries(datasets),
  };
  const json = JSON.stringify(out, null, 1);
  if (typeof copy === 'function') { copy(json); console.log(`Copied ${cards.length} cards (${json.length} chars) to the clipboard.`); }
  window.__domoExtract = out;
  return out;
})();
