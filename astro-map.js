var AstroZoteroMap = {
  states: new WeakMap(),
  plugin: null,
  HTML_NS: "http://www.w3.org/1999/xhtml",
  SVG_NS: "http://www.w3.org/2000/svg",
  itemPaneID: null,
  paneCache: new Map(),
  paneRefreshCallbacks: new WeakMap(),
  paneSubjects: new WeakMap(),

  log(message) {
    try { Zotero.debug("AstroZotero Map: " + message); } catch (_) {}
  },

  pref(name, fallback) {
    try {
      const value = Zotero.Prefs.get("extensions.zotnasaads." + name, true);
      return value === undefined || value === null ? fallback : value;
    } catch (_) { return fallback; }
  },

  setPref(name, value) {
    try { Zotero.Prefs.set("extensions.zotnasaads." + name, value, true); } catch (_) {}
  },

  el(doc, tag, attrs, text) {
    const node = doc.createElementNS(this.HTML_NS, tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (key === "class") node.className = value;
      else if (key === "style") node.setAttribute("style", value);
      else node.setAttribute(key, String(value));
    }
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  },

  svgEl(doc, tag, attrs) {
    const node = doc.createElementNS(this.SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, String(value));
    return node;
  },

  async addToAllWindows(plugin) {
    this.plugin = plugin || this.plugin;
    for (const win of Zotero.getMainWindows()) await this.addToWindow(win, plugin);
  },

  removeFromAllWindows() {
    for (const win of Zotero.getMainWindows()) this.removeFromWindow(win);
  },

  async addToWindow(win, plugin) {
    if (!win || !win.document) return;
    this.plugin = plugin || this.plugin;
    if (this.states.has(win)) return;

    const doc = win.document;
    let tries = 0;
    let mainNode = null;
    let toolbar = null;
    // Zotero 9/10 builds the virtualized item tree and toolbar asynchronously.
    // Zotero 10 can restore a non-default item-tree view whose id is not
    // item-tree-main-default (for example item-tree-main-recentlyRead).
    // Match any main item-tree view and allow a longer cold-start window.
    while (tries < 600) {
      mainNode = doc.getElementById("item-tree-main-default") ||
        doc.querySelector('[id^="item-tree-main"]');
      toolbar = doc.getElementById("zotero-items-toolbar");
      if (mainNode && toolbar) break;
      await Zotero.Promise.delay(100);
      tries++;
    }
    if (!mainNode || !toolbar) {
      this.log("Library item tree/toolbar not available after cold-start wait; embedded map not installed. " +
        "tree=" + (mainNode?.id || "none") + ", toolbar=" + Boolean(toolbar));
      this.installToolsFallback(win);
      return;
    }

    doc.getElementById("astrozotero-map-container")?.remove();
    doc.getElementById("astrozotero-map-toggle")?.remove();

    const state = {
      win,
      doc,
      container: null,
      stage: null,
      svg: null,
      details: null,
      legend: null,
      status: null,
      seedLine: null,
      controls: {},
      selectedModes: new Set(["cited", "references"]),
      seedRecord: null,
      seedItem: null,
      graphData: null,
      cache: new Map(),
      loadGeneration: 0,
      zoom: 1,
      panX: 0,
      panY: 0,
      batchSelection: new Set(),
      batchAddButton: null,
      batchSelectButton: null,
      loadMoreButton: null,
      seedProgress: new Map(),
      expansionProgress: new Map(),
      currentCacheKey: null,
      targetContext: null,
      semanticIndex: new Map(),
      semanticSource: "local",
      nodeElements: new Map(),
      edgeElements: [],
      lodVisibleIDs: new Set(),
      selectedBibcode: null,
      searchInput: null,
      searchResult: null,
      searchQuery: "",
      searchMatches: new Set(),
      searchCursor: -1,
      searchLeadOnly: false,
      searchLeadButton: null,
      qualityEl: null,
      qualityMetrics: null
    };
    this.states.set(win, state);

    this.createContainer(state, mainNode);
    this.createToolbarButton(state, toolbar);
    this.installToolsFallback(win, state);

    // Astro Map is intentionally session-only. Always start closed after a
    // Zotero restart instead of restoring a stale open/blank map from prefs.
    state.container.style.display = "none";
  },

  removeFromWindow(win) {
    const state = this.states.get(win);
    if (!state) return;
    try { state.doc.getElementById("astrozotero-map-toggle")?.remove(); } catch (_) {}
    try { state.doc.getElementById("astrozotero-tools-toggle-map")?.remove(); } catch (_) {}
    try { state.container?.remove(); } catch (_) {}
    this.states.delete(win);
  },

  createToolbarButton(state, toolbar) {
    const doc = state.doc;
    doc.getElementById("astrozotero-map-toggle")?.remove();

    // Create a native Zotero toolbarbutton instead of cloning the old
    // #zotero-tb-advanced-search control (removed in Zotero 9).
    const button = doc.createXULElement
      ? doc.createXULElement("toolbarbutton")
      : doc.createElement("toolbarbutton");
    button.id = "astrozotero-map-toggle";
    button.classList.add("zotero-tb-button");
    button.setAttribute("tabindex", "-1");
    button.setAttribute("tooltiptext", "Astro Map");
    button.setAttribute("aria-label", "Astro Map");
    button.style.listStyleImage = "url(chrome://astrozotero/content/icons/astro-map.svg)";
    button.style.minWidth = "28px";
    button.style.width = "28px";
    button.addEventListener("command", () => {
      Promise.resolve(this.toggle(state)).catch(error =>
        this.log(error?.stack || String(error))
      );
    });

    // Put Astro Map immediately before the search controls. These IDs are
    // present in Zotero 9; if neither exists, append to the item toolbar.
    const insertionPoint =
      toolbar.querySelector('spacer[flex="1"]') ||
      doc.getElementById("zotero-tb-search-spinner") ||
      doc.getElementById("zotero-tb-search") ||
      null;
    toolbar.insertBefore(button, insertionPoint);
    state.toolbarButton = button;
    this.log("Astro Map toolbar button installed.");
  },

  installToolsFallback(win, state) {
    const doc = win?.document;
    if (!doc) return;
    doc.getElementById("astrozotero-tools-toggle-map")?.remove();
    const toolsMenu = doc.getElementById("menu_ToolsPopup");
    if (!toolsMenu) return;
    const item = doc.createXULElement("menuitem");
    item.id = "astrozotero-tools-toggle-map";
    item.setAttribute("label", "AstroZotero: Toggle Astro Map");
    item.addEventListener("command", () => {
      const current = state || this.states.get(win);
      if (!current) {
        this.addToWindow(win, this.plugin).catch(error =>
          this.log(error?.stack || String(error))
        );
        return;
      }
      Promise.resolve(this.toggle(current)).catch(error =>
        this.log(error?.stack || String(error))
      );
    });
    toolsMenu.appendChild(item);
  },

  createContainer(state, mainNode) {
    const doc = state.doc;
    const height = Math.max(240, Number(this.pref("mapHeight", 420)) || 420);
    const container = this.el(doc, "div", {
      id: "astrozotero-map-container",
      style: [
        "width:100%",
        "height:" + height + "px",
        "min-height:220px",
        "display:none",
        "flex-direction:column",
        "position:relative",
        "box-sizing:border-box",
        "border-top:1px solid color-mix(in srgb, CanvasText 18%, transparent)",
        "background:Canvas",
        "color:CanvasText",
        "overflow:hidden"
      ].join(";")
    });

    const resizer = this.el(doc, "div", {
      style: "height:5px;min-height:5px;cursor:ns-resize;background:transparent;position:relative;z-index:5"
    });
    resizer.addEventListener("mousedown", event => this.beginResize(state, event));
    container.appendChild(resizer);

    const header = this.el(doc, "div", {
      style: "display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:4px 10px 7px;border-bottom:1px solid color-mix(in srgb,CanvasText 12%,transparent);font:12px system-ui,sans-serif;min-height:34px;box-sizing:border-box"
    });
    const title = this.el(doc, "strong", { style: "font-size:13px;margin-right:2px" }, "Astro Map");
    header.appendChild(title);

    const modeDefs = [
      ["cited", "Cited by"],
      ["references", "References"],
      ["similar", "Similar"],
      ["reviews", "Reviews"],
      ["useful", "Useful"],
      ["trending", "Trending"]
    ];
    for (const [id, labelText] of modeDefs) {
      const label = this.el(doc, "label", { style: "display:flex;align-items:center;gap:4px;white-space:nowrap;cursor:pointer" });
      const input = this.el(doc, "input", { type: "checkbox" });
      input.checked = state.selectedModes.has(id);
      input.addEventListener("change", () => {
        if (input.checked) state.selectedModes.add(id); else state.selectedModes.delete(id);
      });
      const colorDot = this.el(doc, "span", {
        title: labelText,
        style: "display:inline-block;width:9px;height:9px;border-radius:50%;background:" + this.modeColor(id) + ";box-shadow:0 0 0 1px color-mix(in srgb,CanvasText 18%,transparent)"
      });
      label.append(input, colorDot, this.el(doc, "span", {}, labelText));
      header.appendChild(label);
      state.controls[id] = input;
    }

    const useSelection = this.makeButton(doc, "Use selected item", async () => this.loadFromCurrentSelection(state, true));
    const reload = this.makeButton(doc, "Load", async () => this.loadMap(state, true));
    const loadMore = this.makeButton(doc, "Load more", async () => this.loadMore(state));
    loadMore.disabled = true;
    state.loadMoreButton = loadMore;

    const searchWrap = this.el(doc, "span", {
      style: "display:inline-flex;align-items:center;gap:4px;min-width:190px"
    });
    const searchInput = this.el(doc, "input", {
      type: "search",
      placeholder: "Search map: title / author / year",
      title: 'Search loaded map. Spaces are supported. Prefix ^ for first/corresponding author only, e.g. ^Hong Guo. Field examples: author:Guo Hong, year:2019, title:galaxy halo',
      style: "width:210px;max-width:25vw;font:12px system-ui,sans-serif;padding:4px 7px;border-radius:6px;border:1px solid color-mix(in srgb,CanvasText 20%,transparent);background:Field;color:FieldText"
    });
    const leadOnly = this.makeButton(doc, "1st/corr", () => {
      state.searchLeadOnly = !state.searchLeadOnly;
      leadOnly.setAttribute("aria-pressed", state.searchLeadOnly ? "true" : "false");
      leadOnly.style.fontWeight = state.searchLeadOnly ? "700" : "400";
      leadOnly.style.outline = state.searchLeadOnly ? "2px solid color-mix(in srgb,#2f80ed 55%,transparent)" : "none";
      this.updateMapSearch(state, false);
    });
    leadOnly.setAttribute("aria-pressed", "false");
    leadOnly.setAttribute("title", "Toggle first/corresponding-author filtering. You can also prefix a query with ^, e.g. ^Hong Guo.");
    leadOnly.style.padding = "4px 6px";
    const searchResult = this.el(doc, "span", {
      style: "min-width:54px;color:GrayText;font-size:11px;white-space:nowrap"
    }, "");
    searchInput.addEventListener("input", () => this.updateMapSearch(state, false));
    // Keep Zotero/global keyboard handlers from consuming spaces or other
    // characters while the user is typing in the embedded map search box.
    searchInput.addEventListener("keydown", event => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        this.focusSearchResult(state, event.shiftKey ? -1 : 1);
      } else if (event.key === "Escape") {
        event.preventDefault();
        searchInput.value = "";
        this.updateMapSearch(state, false);
      }
    });
    searchInput.addEventListener("keypress", event => event.stopPropagation());
    searchInput.addEventListener("keyup", event => event.stopPropagation());
    searchWrap.append(searchInput, leadOnly, searchResult);
    state.searchInput = searchInput;
    state.searchLeadButton = leadOnly;
    state.searchResult = searchResult;

    const resetView = this.makeButton(doc, "Reset view", () => {
      state.zoom = 1; state.panX = 0; state.panY = 0; this.applyViewTransform(state);
    });
    const selectNew = this.makeButton(doc, "Select all new", () => this.selectAllNew(state));
    const addSelected = this.makeButton(doc, "Add selected (0)", async () => this.batchAddSelected(state));
    addSelected.disabled = true;
    state.batchSelectButton = selectNew;
    state.batchAddButton = addSelected;
    header.append(useSelection, reload, loadMore, searchWrap, resetView, selectNew, addSelected);

    const seedLine = this.el(doc, "span", { style: "margin-left:auto;color:GrayText;max-width:34%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, "Select one paper, then click Load");
    header.appendChild(seedLine);
    state.seedLine = seedLine;

    const stage = this.el(doc, "div", { style: "flex:1;min-height:0;position:relative;overflow:hidden;background:Canvas" });
    const svg = this.svgEl(doc, "svg", { width: "100%", height: "100%", viewBox: "0 0 1100 540", preserveAspectRatio: "xMidYMid meet" });
    svg.style.display = "block";
    svg.style.width = "100%";
    svg.style.height = "100%";
    svg.style.cursor = "grab";
    stage.appendChild(svg);

    const status = this.el(doc, "div", {
      style: "position:absolute;left:10px;top:8px;padding:4px 7px;border-radius:6px;background:color-mix(in srgb,Canvas 86%,transparent);color:GrayText;font:12px system-ui,sans-serif;pointer-events:none"
    }, "Ready");
    stage.appendChild(status);

    const quality = this.el(doc, "div", {
      title: "Layout diagnostics for the current map: seed ρ compares seed-affinity rank with 2D distance rank; map N@10 measures neighborhood preservation; stress is global edge-distance error (lower is better). Selecting another node does not change these unless the seed/layout changes.",
      style: "position:absolute;right:10px;bottom:8px;padding:4px 7px;border-radius:6px;background:color-mix(in srgb,Canvas 90%,transparent);color:GrayText;font:11px system-ui,sans-serif;pointer-events:none;z-index:3;white-space:nowrap"
    }, "Visible 0/0 · quality pending");
    stage.appendChild(quality);

    const legend = this.el(doc, "div", {
      style: "position:absolute;left:10px;bottom:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;max-width:70%;padding:4px 7px;border-radius:6px;background:color-mix(in srgb,Canvas 90%,transparent);font:11px system-ui,sans-serif;color:GrayText;pointer-events:none;z-index:3"
    });
    stage.appendChild(legend);

    const details = this.el(doc, "div", {
      style: "display:none;position:absolute;right:10px;top:10px;width:min(330px,38%);max-height:calc(100% - 20px);overflow:auto;padding:10px;border:1px solid color-mix(in srgb,CanvasText 18%,transparent);border-radius:8px;background:color-mix(in srgb,Canvas 96%,transparent);box-shadow:0 3px 14px rgba(0,0,0,.13);font:12px system-ui,sans-serif;z-index:4"
    });
    stage.appendChild(details);

    container.append(header, stage);
    mainNode.appendChild(container);
    state.container = container;
    state.stage = stage;
    state.svg = svg;
    state.status = status;
    state.legend = legend;
    state.details = details;
    state.qualityEl = quality;

    this.installPanZoom(state);
  },

  makeButton(doc, text, handler) {
    const button = this.el(doc, "button", {
      type: "button",
      style: "font:12px system-ui,sans-serif;padding:4px 8px;border-radius:6px;border:1px solid color-mix(in srgb,CanvasText 20%,transparent);background:ButtonFace;color:ButtonText;cursor:pointer"
    }, text);
    button.addEventListener("click", event => {
      event.preventDefault();
      Promise.resolve(handler()).catch(error => this.log(error?.stack || String(error)));
    });
    return button;
  },

  beginResize(state, event) {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = state.container.getBoundingClientRect().height;
    const win = state.win;
    const move = e => {
      const next = Math.max(220, Math.min(win.innerHeight * 0.76, startHeight - (e.clientY - startY)));
      state.container.style.height = Math.round(next) + "px";
    };
    const up = () => {
      win.removeEventListener("mousemove", move, true);
      win.removeEventListener("mouseup", up, true);
      this.setPref("mapHeight", Math.round(state.container.getBoundingClientRect().height));
    };
    win.addEventListener("mousemove", move, true);
    win.addEventListener("mouseup", up, true);
  },

  async toggle(state) {
    const showing = state.container.style.display !== "none";
    if (showing) {
      state.container.style.display = "none";
      return;
    }
    state.container.style.display = "flex";
    if (!state.graphData) await this.loadFromCurrentSelection(state, false);
  },

  async loadFromCurrentSelection(state, force) {
    const items = this.plugin.getSelectedRegularItems(state.win);
    if (!items.length) {
      state.seedItem = null; state.seedRecord = null;
      this.setStatus(state, "Select one regular Zotero item first.", true);
      this.clearSVG(state);
      state.seedLine.textContent = "No seed selected";
      return;
    }
    state.seedItem = items[0];
    state.seedRecord = null;
    // Freeze the library/collection target at the moment the seed is chosen.
    // This makes batch imports deterministic even if Zotero later changes the
    // visible collection/search while the embedded map stays open.
    state.targetContext = this.selectedLibraryContext(state);
    await this.loadMap(state, force);
  },

  setStatus(state, text, error) {
    state.status.textContent = text;
    state.status.style.color = error ? "#b42318" : "GrayText";
  },

  async loadMap(state, force) {
    const generation = ++state.loadGeneration;
    const apiKey = this.plugin.ensureApiKey(state.win);
    if (!apiKey) return;
    if (!state.selectedModes.size) {
      this.setStatus(state, "Select at least one relationship type.", true);
      return;
    }

    try {
      this.setStatus(state, "Resolving seed in NASA ADS…", false);
      let seed;
      let adsSeedError = null;
      try {
        if (state.seedRecord?.bibcode && !String(state.seedRecord.bibcode).startsWith("OA:")) {
          const result = await this.adsWithRetry(state, "seed lookup", () => this.plugin.adsSearchMany(apiKey,
            'bibcode:"' + this.plugin.escapeQueryValue(state.seedRecord.bibcode) + '"',
            this.adsFields(), 1));
          seed = result.docs[0] || state.seedRecord;
        } else if (state.seedItem) {
          seed = await this.adsWithRetry(state, "seed lookup", () =>
            this.plugin.findAdsRecord(state.seedItem, apiKey, this.adsFields()));
        }
      } catch (error) {
        adsSeedError = error;
        this.log("ADS seed lookup failed: " + (error?.message || error));
        if (!this.shouldFallbackFromADS(error)) throw error;
      }

      let openAlexSeed = null;
      if (!seed?.bibcode && this.pref("openAlexFallback", true)) {
        this.setStatus(state, "NASA ADS unavailable; resolving seed with OpenAlex…", false);
        openAlexSeed = await this.resolveOpenAlexSeed(state, state.seedRecord || state.seedItem);
        if (openAlexSeed) seed = openAlexSeed;
      }
      if (!seed?.bibcode) {
        throw adsSeedError || new Error("No ADS/OpenAlex record found for the selected seed paper.");
      }

      seed = String(seed.bibcode).startsWith("OA:") ? seed : this.normalizeRecord(seed);
      state.seedRecord = seed;
      state.seedLine.textContent = "Seed: " + this.displayLabel(seed);

      const cacheKey = this.recordIdentityKey(seed) + "|" + [...state.selectedModes].sort().join(",");
      state.currentCacheKey = cacheKey;
      if (!force && state.cache.has(cacheKey)) {
        const cached = state.cache.get(cacheKey);
        state.graphData = cached;
        state.seedProgress = new Map(Object.entries(cached.seedProgress || {}));
        state.expansionProgress = new Map(Object.entries(cached.expansionProgress || {}));
        state.semanticIndex = new Map(Object.entries(cached.semanticIndex || {}));
        state.semanticSource = cached.semanticSource || "local";
        state.batchSelection.clear();
        if (state.batchSelectButton) state.batchSelectButton.textContent = "Select all new";
        this.updateBatchControls(state);
        this.updateLoadMoreControl(state);
        this.renderGraph(state, cached);
        this.setStatus(state, cached.nodes.length + " papers · cached", false);
        return;
      }

      state.seedProgress = new Map();
      state.expansionProgress = new Map();
      const merged = new Map();
      const seedNode = this.nodeFromRecord(seed, true);
      merged.set(this.recordIdentityKey(seed), seedNode);
      const modeList = [...state.selectedModes];
      // Initial discovery is deliberately broad enough to make the map useful
      // while still keeping the first render responsive. Further pages can be
      // loaded cumulatively with the Load more control.
      const perMode = 50;
      const fallbackNotes = [];

      for (let i = 0; i < modeList.length; i++) {
        if (generation !== state.loadGeneration) return;
        const mode = modeList[i];
        this.setStatus(state, "NASA ADS: " + this.modeLabel(mode) + " (" + (i + 1) + "/" + modeList.length + ")…", false);
        let papers = [];
        let usedOpenAlex = false;
        if (!String(seed.bibcode).startsWith("OA:")) {
          try {
            const query = this.operator(mode) + '(bibcode:"' + this.plugin.escapeQueryValue(seed.bibcode) + '")';
            const sort = mode === "cited" ? "date desc" : (mode === "references" ? "citation_count desc" : null);
            const result = await this.adsWithRetry(state, this.modeLabel(mode), () =>
              this.plugin.adsSearchMany(apiKey, query, this.adsFields(), perMode, sort, 0));
            papers = result.docs.map(raw => this.normalizeRecord(raw));
            state.seedProgress.set(mode, {
              nextStart: result.docs.length,
              requestedRows: perMode,
              lastCount: result.docs.length,
              total: result.numFound,
              source: "ads"
            });
          } catch (error) {
            if (!this.pref("openAlexFallback", true) || !this.shouldFallbackFromADS(error)) throw error;
            const adsErrorText = this.adsErrorSummary(error);
            this.log("ADS " + mode + " failed after retries, trying OpenAlex: " + adsErrorText);
            if (!openAlexSeed) {
              try { openAlexSeed = await this.resolveOpenAlexSeed(state, seed); }
              catch (oaError) { this.log("OpenAlex seed fallback failed: " + (oaError?.message || oaError)); }
            }
            if (openAlexSeed && this.openAlexSupportsMode(mode)) {
              this.setStatus(state, this.modeLabel(mode) + ": ADS failed (" + adsErrorText + ") → OpenAlex fallback…", false);
              papers = await this.openAlexModeResults(openAlexSeed, mode, perMode);
              state.seedProgress.set(mode, {
                nextStart: papers.length, requestedRows: papers.length, lastCount: papers.length,
                total: papers.length, source: "openalex", incomplete: true, adsError: adsErrorText
              });
              usedOpenAlex = true;
              fallbackNotes.push(this.modeLabel(mode) + ": ADS failed (" + adsErrorText + ") → OpenAlex fallback (" + papers.length + " papers; incomplete)");
            } else {
              fallbackNotes.push(this.modeLabel(mode) + ": ADS failed (" + adsErrorText + "); unavailable without ADS");
              continue;
            }
          }
        } else {
          openAlexSeed = seed;
          if (this.openAlexSupportsMode(mode)) {
            papers = await this.openAlexModeResults(openAlexSeed, mode, perMode);
            state.seedProgress.set(mode, { nextStart: papers.length, requestedRows: papers.length, lastCount: papers.length, total: papers.length, source: "openalex" });
            usedOpenAlex = true;
          } else {
            fallbackNotes.push(this.modeLabel(mode) + " unavailable without ADS");
            continue;
          }
        }

        for (const paper of papers) {
          if (!paper?.bibcode) continue;
          if (this.recordIdentityKey(paper) === this.recordIdentityKey(seed)) continue;
          this.mergePaper(merged, paper, mode, seed.bibcode);
        }
        if (usedOpenAlex && String(seed.bibcode).startsWith("OA:")) fallbackNotes.push(this.modeLabel(mode) + " via OpenAlex");
      }

      if (generation !== state.loadGeneration) return;
      const nodes = [...merged.values()];
      await this.attachLocalItems(state, nodes);
      const semanticInfo = await this.applySemanticWeights(seed, nodes, { fetchOpenAlex: true });
      if (generation !== state.loadGeneration) return;
      state.semanticIndex = semanticInfo.index;
      state.semanticSource = semanticInfo.source;
      const graph = {
        seedBibcode: seed.bibcode,
        nodes,
        edges: this.buildEdges(nodes, seed.bibcode),
        seedProgress: Object.fromEntries(state.seedProgress),
        expansionProgress: Object.fromEntries(state.expansionProgress),
        semanticIndex: Object.fromEntries(state.semanticIndex),
        semanticSource: state.semanticSource
      };
      graph.incompleteFallback = [...state.seedProgress.values()].some(p => p?.source === "openalex" && p?.incomplete);
      if (!graph.incompleteFallback) state.cache.set(cacheKey, graph);
      else state.cache.delete(cacheKey);
      state.graphData = graph;
      state.batchSelection.clear();
      if (state.batchSelectButton) state.batchSelectButton.textContent = "Select all new";
      this.updateBatchControls(state);
      this.updateLoadMoreControl(state);
      this.renderGraph(state, graph);
      const fallbackSuffix = fallbackNotes.length ? " · " + [...new Set(fallbackNotes)].join("; ") : "";
      const semanticSuffix = state.semanticSource === "openalex+local" ? " · semantic-weighted" : " · locally weighted";
      this.setStatus(state, nodes.length + " papers · " + graph.edges.length + " links" + semanticSuffix + fallbackSuffix, false);
    } catch (error) {
      this.log(error?.stack || String(error));
      this.setStatus(state, error?.message || String(error), true);
      this.clearSVG(state);
    }
  },

  graphLimit() {
    return 500;
  },

  updateLoadMoreControl(state) {
    const button = state.loadMoreButton;
    if (!button) return;
    const graph = state.graphData;
    if (!graph?.nodes?.length) {
      button.disabled = true;
      button.textContent = "Load more";
      return;
    }
    if (graph.nodes.length >= this.graphLimit()) {
      button.disabled = true;
      button.textContent = "Limit 500";
      return;
    }
    const hasIncompleteFallback = [...(state.selectedModes || [])].some(mode => {
      const p = state.seedProgress?.get?.(mode);
      return p?.source === "openalex" && p?.incomplete;
    });
    if (hasIncompleteFallback) {
      button.disabled = false;
      button.textContent = "Retry ADS";
      return;
    }
    let hasMore = false;
    for (const mode of state.selectedModes || []) {
      const p = state.seedProgress?.get?.(mode);
      // Do not trust numFound alone for ADS function queries. Some second-order
      // operators can report a result window that is the same size as rows.
      // If the last request filled its requested window, probe a wider prefix.
      if (!p) { hasMore = true; break; }
      if (p.source !== "ads") continue;
      const requested = Number(p.requestedRows || p.nextStart || 0);
      const lastCount = Number(p.lastCount || 0);
      const total = Number(p.total || 0);
      if (requested < this.graphLimit() && (lastCount >= requested || Number(p.nextStart || 0) < total)) {
        hasMore = true;
        break;
      }
    }
    button.disabled = !hasMore;
    button.textContent = hasMore ? "Load more (+50/mode)" : "No more seed results";
  },

  async loadMore(state) {
    if (!state.graphData?.nodes?.length || !state.seedRecord?.bibcode) {
      this.setStatus(state, "Load a map first.", true);
      return;
    }
    if (state.graphData.nodes.length >= this.graphLimit()) {
      this.setStatus(state, "Graph limit reached (500 papers).", false);
      this.updateLoadMoreControl(state);
      return;
    }
    const hasIncompleteFallback = [...(state.selectedModes || [])].some(mode => {
      const p = state.seedProgress?.get?.(mode);
      return p?.source === "openalex" && p?.incomplete;
    });
    if (hasIncompleteFallback) {
      this.setStatus(state, "Retrying NASA ADS for the incomplete OpenAlex fallback…", false);
      await this.loadMap(state, true);
      return;
    }
    if (String(state.seedRecord.bibcode).startsWith("OA:")) {
      this.setStatus(state, "Load more currently uses NASA ADS for the seed; expand a node for OpenAlex-backed graphs.", false);
      return;
    }

    const apiKey = this.plugin.ensureApiKey(state.win);
    if (!apiKey) return;
    const generation = ++state.loadGeneration;
    const merged = new Map(state.graphData.nodes.map(node => [this.recordIdentityKey(node), node]));
    const beforeKeys = new Set(merged.keys());
    const modeList = [...state.selectedModes];
    let fetched = 0;
    let attempted = 0;

    try {
      for (let i = 0; i < modeList.length; i++) {
        if (generation !== state.loadGeneration) return;
        if (merged.size >= this.graphLimit()) break;
        const mode = modeList[i];
        const old = state.seedProgress.get(mode);
        if (old?.source === "openalex") continue;

        // ADS second-order operators are ranking functions. start-based paging
        // can be unhelpful when the function itself materializes only the
        // requested window. Ask for a wider prefix (50 -> 100 -> 150 ...),
        // then merge only records that are new to the current graph.
        const previousRequested = Number(old?.requestedRows || old?.nextStart || 0);
        const targetRows = Math.min(this.graphLimit(), Math.max(50, previousRequested + 50));
        if (old && Number(old.lastCount || 0) < previousRequested && Number(old.nextStart || 0) >= Number(old.total || 0)) continue;
        if (targetRows <= previousRequested) continue;

        attempted++;
        this.setStatus(state, "NASA ADS: widening " + this.modeLabel(mode) + " to top " + targetRows + "…", false);
        const query = this.operator(mode) + '(bibcode:"' + this.plugin.escapeQueryValue(state.seedRecord.bibcode) + '")';
        const sort = mode === "cited" ? "date desc" : (mode === "references" ? "citation_count desc" : null);
        const result = await this.adsWithRetry(state, this.modeLabel(mode), () =>
          this.plugin.adsSearchMany(apiKey, query, this.adsFields(), targetRows, sort, 0));
        const papers = result.docs.map(raw => this.normalizeRecord(raw));
        state.seedProgress.set(mode, {
          nextStart: result.docs.length,
          requestedRows: targetRows,
          lastCount: result.docs.length,
          total: Math.max(Number(old?.total || 0), Number(result.numFound || 0)),
          source: "ads"
        });
        fetched += result.docs.length;
        for (const paper of papers) {
          if (!paper?.bibcode) continue;
          const key = this.recordIdentityKey(paper);
          if (merged.size >= this.graphLimit() && !merged.has(key)) continue;
          if (key === this.recordIdentityKey(state.seedRecord)) continue;
          this.mergePaper(merged, paper, mode, state.seedRecord.bibcode);
        }
      }

      if (generation !== state.loadGeneration) return;
      const nodes = [...merged.values()];
      const newNodes = nodes.filter(node => !beforeKeys.has(this.recordIdentityKey(node)));
      if (newNodes.length) await this.attachLocalItems(state, newNodes);
      const semanticInfo = await this.applySemanticWeights(state.seedRecord, nodes, { semanticIndex: state.semanticIndex, fetchOpenAlex: false });
      state.semanticIndex = semanticInfo.index;
      state.semanticSource = semanticInfo.source;
      const graph = {
        seedBibcode: state.graphData.seedBibcode,
        nodes,
        edges: this.buildEdges(nodes, state.graphData.seedBibcode),
        seedProgress: Object.fromEntries(state.seedProgress),
        expansionProgress: Object.fromEntries(state.expansionProgress),
        semanticIndex: Object.fromEntries(state.semanticIndex),
        semanticSource: state.semanticSource
      };
      graph.incompleteFallback = [...state.seedProgress.values()].some(p => p?.source === "openalex" && p?.incomplete);
      state.graphData = graph;
      if (state.currentCacheKey && !graph.incompleteFallback) state.cache.set(state.currentCacheKey, graph);
      else if (state.currentCacheKey) state.cache.delete(state.currentCacheKey);
      this.updateBatchControls(state);
      this.updateLoadMoreControl(state);
      this.renderGraph(state, graph);
      const added = newNodes.length;
      if (!attempted) {
        this.setStatus(state, "No seed relation has another ADS window to probe. Expand a node to continue the graph.", false);
      } else if (!added) {
        this.setStatus(state, nodes.length + " papers · no additional unique seed papers returned; expand a node to continue.", false);
      } else {
        this.setStatus(state, nodes.length + " papers · " + graph.edges.length + " links · +" + added + " new (" + fetched + " records examined)", false);
      }
    } catch (error) {
      this.log(error?.stack || String(error));
      this.setStatus(state, error?.message || String(error), true);
    }
  },

  async expandNode(state, node) {
    if (!state.graphData?.nodes?.length || !node?.bibcode || node.seed) return;
    const apiKey = this.plugin.ensureApiKey(state.win);
    if (!apiKey) return;
    if (state.graphData.nodes.length >= this.graphLimit()) {
      this.setStatus(state, "Graph limit reached (500 papers).", false);
      return;
    }

    const generation = ++state.loadGeneration;
    const merged = new Map(state.graphData.nodes.map(n => [this.recordIdentityKey(n), n]));
    const beforeKeys = new Set(merged.keys());
    const modeList = [...state.selectedModes];
    let fetched = 0;

    try {
      for (let i = 0; i < modeList.length; i++) {
        if (generation !== state.loadGeneration) return;
        if (merged.size >= this.graphLimit()) break;
        const mode = modeList[i];
        const progressKey = node.bibcode + "|" + mode;
        const old = state.expansionProgress.get(progressKey);
        const start = Number(old?.nextStart || 0);
        const knownTotal = Number(old?.total || 0);
        if (old && start >= knownTotal) continue;
        const rows = Math.min(25, this.graphLimit() - merged.size);
        if (rows <= 0) break;
        let papers = [];

        this.setStatus(state, "Expanding " + this.displayLabel(node) + ": " + this.modeLabel(mode) + "…", false);
        if (node.source === "openalex" || String(node.bibcode).startsWith("OA:")) {
          // OpenAlex expansion is intentionally one page per relation here;
          // ADS-backed nodes support true repeated pagination below.
          if (old) continue;
          papers = await this.openAlexModeResults(node, mode, rows);
          state.expansionProgress.set(progressKey, { nextStart: papers.length, total: papers.length, source: "openalex" });
        } else {
          const query = this.operator(mode) + '(bibcode:"' + this.plugin.escapeQueryValue(node.bibcode) + '")';
          const sort = mode === "cited" ? "date desc" : (mode === "references" ? "citation_count desc" : null);
          const result = await this.adsWithRetry(state, "expand " + this.modeLabel(mode), () =>
            this.plugin.adsSearchMany(apiKey, query, this.adsFields(), rows, sort, start));
          papers = result.docs.map(raw => this.normalizeRecord(raw));
          state.expansionProgress.set(progressKey, {
            nextStart: start + result.docs.length,
            total: result.numFound,
            source: "ads"
          });
          fetched += result.docs.length;
        }

        for (const paper of papers) {
          if (!paper?.bibcode) continue;
          const key = this.recordIdentityKey(paper);
          if (merged.size >= this.graphLimit() && !merged.has(key)) continue;
          this.mergePaper(merged, paper, mode, node.bibcode);
        }
      }

      if (generation !== state.loadGeneration) return;
      const nodes = [...merged.values()];
      const newNodes = nodes.filter(n => !beforeKeys.has(this.recordIdentityKey(n)));
      if (newNodes.length) await this.attachLocalItems(state, newNodes);
      const semanticInfo = await this.applySemanticWeights(state.seedRecord, nodes, { semanticIndex: state.semanticIndex, fetchOpenAlex: false });
      state.semanticIndex = semanticInfo.index;
      state.semanticSource = semanticInfo.source;
      const graph = {
        seedBibcode: state.graphData.seedBibcode,
        nodes,
        edges: this.buildEdges(nodes, state.graphData.seedBibcode),
        seedProgress: Object.fromEntries(state.seedProgress),
        expansionProgress: Object.fromEntries(state.expansionProgress),
        semanticIndex: Object.fromEntries(state.semanticIndex),
        semanticSource: state.semanticSource
      };
      graph.incompleteFallback = [...state.seedProgress.values()].some(p => p?.source === "openalex" && p?.incomplete);
      state.graphData = graph;
      if (state.currentCacheKey && !graph.incompleteFallback) state.cache.set(state.currentCacheKey, graph);
      else if (state.currentCacheKey) state.cache.delete(state.currentCacheKey);
      this.updateBatchControls(state);
      this.updateLoadMoreControl(state);
      this.renderGraph(state, graph);
      this.setStatus(state, nodes.length + " papers · " + graph.edges.length + " links · expanded " + this.displayLabel(node) + " (" + newNodes.length + " new)", false);
    } catch (error) {
      this.log(error?.stack || String(error));
      this.setStatus(state, error?.message || String(error), true);
    }
  },

  adsErrorSummary(error) {
    const message = String(error?.message || error || "Unknown ADS error").replace(/\s+/g, " ").trim();
    if (/429/.test(message)) return "HTTP 429 rate limit";
    const http = message.match(/HTTP\s*(5\d\d)/i);
    if (http) return "HTTP " + http[1];
    if (/timed?\s*out|timeout/i.test(message)) return "timeout";
    if (/NS_ERROR/i.test(message)) return message.slice(0, 120);
    if (/network|connection/i.test(message)) return message.slice(0, 120);
    return message.slice(0, 120);
  },

  async adsWithRetry(state, label, operation) {
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        const retryable = this.shouldFallbackFromADS(error);
        if (!retryable || attempt >= 3) throw error;
        const summary = this.adsErrorSummary(error);
        this.log("ADS " + label + " attempt " + attempt + "/3 failed: " + summary);
        if (state) {
          this.setStatus(state, "NASA ADS " + label + " failed (" + summary + "); retrying " + attempt + "/2…", false);
        }
        await Zotero.Promise.delay(attempt === 1 ? 900 : 1800);
      }
    }
    throw lastError || new Error("NASA ADS request failed.");
  },

  shouldFallbackFromADS(error) {
    const message = String(error?.message || error || "");
    if (/401|403|rejected the API token/i.test(message)) return false;
    return /timed?\s*out|timeout|429|HTTP\s*5\d\d|NS_ERROR|network|connection/i.test(message);
  },

  openAlexSupportsMode(mode) {
    return mode === "cited" || mode === "references" || mode === "similar";
  },

  openAlexApiKey() {
    return String(this.pref("openAlexApiKey", "") || "").trim();
  },

  async openAlexRequest(url) {
    const apiKey = this.openAlexApiKey();
    const sep = url.includes("?") ? "&" : "?";
    if (apiKey) url += sep + "api_key=" + encodeURIComponent(apiKey);
    const response = await Zotero.HTTP.request("GET", url, {
      timeout: 10000,
      errorDelayMax: 0,
      successCodes: false
    });
    if (response.status !== 200) throw new Error("OpenAlex request failed (HTTP " + response.status + ").");
    return JSON.parse(response.responseText);
  },

  openAlexID(value) {
    const match = String(value || "").match(/(?:openalex\.org\/)?(W\d+)$/i);
    return match ? match[1].toUpperCase() : null;
  },

  reconstructOpenAlexAbstract(index) {
    if (!index || typeof index !== "object") return "";
    const words = [];
    for (const [word, positions] of Object.entries(index)) {
      for (const pos of positions || []) words[Number(pos)] = word;
    }
    return words.filter(Boolean).join(" ");
  },

  normalizeOpenAlexWork(raw) {
    const wid = this.openAlexID(raw?.id);
    if (!wid) return null;
    let arxiv = raw?.ids?.arxiv || null;
    if (!arxiv) {
      for (const loc of raw?.locations || []) {
        const url = String(loc?.landing_page_url || loc?.pdf_url || "");
        const match = url.match(/arxiv\.org\/(?:abs|pdf)\/([^?#/]+(?:\/[^?#/]+)?)/i);
        if (match) { arxiv = "https://arxiv.org/abs/" + match[1].replace(/\.pdf$/i, ""); break; }
      }
    }
    const identifiers = [];
    if (arxiv) {
      const match = String(arxiv).match(/(?:arxiv\.org\/abs\/|arXiv:)?(.+)$/i);
      if (match) identifiers.push("arXiv:" + match[1].replace(/v\d+$/i, ""));
    }
    const authorships = Array.isArray(raw?.authorships) ? raw.authorships : [];
    const authors = authorships.map(a => a?.author?.display_name).filter(Boolean);
    const firstAuthor = authorships.find(a => a?.author_position === "first")?.author?.display_name || authors[0] || "";
    const correspondingAuthors = authorships.filter(a => a?.is_corresponding).map(a => a?.author?.display_name).filter(Boolean);
    return {
      bibcode: "OA:" + wid,
      openAlexID: wid,
      source: "openalex",
      title: raw?.display_name || raw?.title || wid,
      authors,
      firstAuthor,
      correspondingAuthors,
      year: raw?.publication_year || "",
      pub: raw?.primary_location?.source?.display_name || "",
      doi: String(raw?.doi || raw?.ids?.doi || "").replace(/^https?:\/\/doi\.org\//i, "") || null,
      identifiers,
      abstract: this.reconstructOpenAlexAbstract(raw?.abstract_inverted_index),
      citationCount: Number(raw?.cited_by_count || 0),
      references: (raw?.referenced_works || []).map(id => "OA:" + this.openAlexID(id)).filter(id => !id.endsWith("null")),
      property: raw?.open_access?.is_oa ? ["OPENACCESS"] : [],
      relatedOpenAlex: (raw?.related_works || []).map(id => this.openAlexID(id)).filter(Boolean),
      semanticTerms: [
        ...(raw?.topics || []).map(topic => topic?.display_name),
        ...(raw?.keywords || []).map(keyword => keyword?.display_name)
      ].filter(Boolean).join(" ")
    };
  },

  async resolveOpenAlexSeed(state, source) {
    let doi = null, title = null;
    if (source?.getField) {
      doi = String(source.getField("DOI") || "").trim();
      title = String(source.getField("title") || "").trim();
    } else {
      doi = String(source?.doi || "").trim();
      title = String(source?.title || "").trim();
      if (source?.openAlexID) {
        const raw = await this.openAlexRequest("https://api.openalex.org/works/" + source.openAlexID);
        return this.normalizeOpenAlexWork(raw);
      }
    }
    let data;
    if (doi) {
      data = await this.openAlexRequest("https://api.openalex.org/works?filter=doi:" + encodeURIComponent("https://doi.org/" + doi) + "&per_page=1");
    } else if (title) {
      data = await this.openAlexRequest("https://api.openalex.org/works?search=" + encodeURIComponent(title) + "&per_page=5");
    } else {
      return null;
    }
    const results = Array.isArray(data?.results) ? data.results : [];
    if (!results.length) return null;
    if (title) {
      const wanted = this.normalizeTitle(title);
      const exact = results.find(w => this.normalizeTitle(w?.display_name || w?.title) === wanted);
      return this.normalizeOpenAlexWork(exact || results[0]);
    }
    return this.normalizeOpenAlexWork(results[0]);
  },

  async openAlexBatch(ids, perMode) {
    const clean = (ids || []).map(id => this.openAlexID(id)).filter(Boolean).slice(0, Math.min(100, perMode));
    if (!clean.length) return [];
    const data = await this.openAlexRequest("https://api.openalex.org/works?filter=openalex:" + clean.join("|") + "&per_page=" + clean.length);
    return (data?.results || []).map(raw => this.normalizeOpenAlexWork(raw)).filter(Boolean);
  },

  async openAlexModeResults(seed, mode, perMode) {
    const wid = seed?.openAlexID || this.openAlexID(String(seed?.bibcode || "").replace(/^OA:/, ""));
    if (!wid) return [];
    if (mode === "cited") {
      const data = await this.openAlexRequest("https://api.openalex.org/works?filter=cites:" + wid + "&sort=-publication_date&per_page=" + perMode);
      return (data?.results || []).map(raw => this.normalizeOpenAlexWork(raw)).filter(Boolean);
    }
    if (mode === "references") return await this.openAlexBatch(seed.references || [], perMode);
    if (mode === "similar") return await this.openAlexBatch(seed.relatedOpenAlex || [], perMode);
    return [];
  },

  semanticQueryText(seed) {
    const title = String(seed?.title || "").trim();
    const abstract = String(seed?.abstract || "").replace(/\s+/g, " ").trim();
    let text = [title, abstract].filter(Boolean).join(". ").trim();
    if (!text) return "";
    text = text.slice(0, 2000);
    // Keep the encoded URL below common ~4 KB request-line limits while still
    // giving OpenAlex much more context than a title-only query.
    while (text.length > 700 && encodeURIComponent(text).length > 3200) {
      text = text.slice(0, Math.floor(text.length * 0.86));
    }
    return text;
  },

  async openAlexSemanticSearch(seed, limit = 50) {
    const query = this.semanticQueryText(seed);
    if (query.length < 8) return [];
    const cap = Math.max(1, Math.min(50, Number(limit) || 50));
    const now = Date.now();
    const wait = Math.max(0, 1050 - (now - Number(this._lastOpenAlexSemanticAt || 0)));
    if (wait) await Zotero.Promise.delay(wait);
    const data = await this.openAlexRequest(
      "https://api.openalex.org/works?search.semantic=" + encodeURIComponent(query) + "&per_page=" + cap
    );
    this._lastOpenAlexSemanticAt = Date.now();
    return Array.isArray(data?.results) ? data.results : [];
  },

  recordMatchKeys(record) {
    const keys = [];
    const doi = String(record?.doi || "").trim().toLowerCase();
    if (doi) keys.push("doi:" + doi);
    const arxiv = this.nodeArxivID(record);
    if (arxiv) keys.push("arxiv:" + String(arxiv).replace(/v\d+$/i, "").toLowerCase());
    const title = this.normalizeTitle(record?.title);
    if (title) {
      keys.push("title:" + title + "|" + String(record?.year || ""));
      keys.push("title:" + title);
    }
    return [...new Set(keys)];
  },

  semanticIndexFromOpenAlex(rawResults) {
    const index = new Map();
    const rows = (rawResults || []).map((raw, rank) => ({ raw, rank, score: Number(raw?.relevance_score) })).filter(entry => entry.raw);
    if (!rows.length) return index;
    const finiteScores = rows.map(entry => entry.score).filter(Number.isFinite);
    const minScore = finiteScores.length ? Math.min(...finiteScores) : 0;
    const maxScore = finiteScores.length ? Math.max(...finiteScores) : 0;
    const denom = Math.max(1, rows.length - 1);
    for (const entry of rows) {
      const rankScore = 1 - entry.rank / denom;
      const scoreNorm = Number.isFinite(entry.score) && maxScore > minScore
        ? (entry.score - minScore) / (maxScore - minScore)
        : rankScore;
      const normalized = Math.max(0, Math.min(1, 0.7 * scoreNorm + 0.3 * rankScore));
      const work = this.normalizeOpenAlexWork(entry.raw);
      if (!work) continue;
      for (const key of this.recordMatchKeys(work)) {
        index.set(key, Math.max(Number(index.get(key) || 0), normalized));
      }
    }
    return index;
  },

  enrichNodesFromOpenAlex(nodes, rawResults) {
    const lookup = new Map();
    for (const raw of rawResults || []) {
      const work = this.normalizeOpenAlexWork(raw);
      if (!work) continue;
      for (const key of this.recordMatchKeys(work)) if (!lookup.has(key)) lookup.set(key, work);
    }
    for (const node of nodes || []) {
      let work = null;
      for (const key of this.recordMatchKeys(node)) {
        if (lookup.has(key)) { work = lookup.get(key); break; }
      }
      if (!work) continue;
      if ((!node.abstract || node.abstract.length < 40) && work.abstract) node.abstract = work.abstract;
      if (!node.openAlexID && work.openAlexID) node.openAlexID = work.openAlexID;
      if (work.semanticTerms) node.semanticTerms = work.semanticTerms;
      if (!node.firstAuthor && work.firstAuthor) node.firstAuthor = work.firstAuthor;
      if (work.correspondingAuthors?.length) node.correspondingAuthors = [...new Set([...(node.correspondingAuthors || []), ...work.correspondingAuthors])];
    }
  },

  scientificTokens(record) {
    const title = String(record?.title || "");
    const abstract = String(record?.abstract || "");
    const semanticTerms = String(record?.semanticTerms || "");
    const text = (title + " " + title + " " + abstract + " " + semanticTerms + " " + semanticTerms).toLocaleLowerCase();
    const stop = new Set([
      "the","and","for","that","with","from","this","are","was","were","has","have","had","into","using","use","used","our","their","they","these","those","than","then","which","while","where","when","what","who","why","how","can","may","might","will","would","could","should","between","within","through","over","under","about","after","before","also","such","both","each","more","most","less","many","much","some","any","all","not","but","its","his","her","them","we","you","your","a","an","of","to","in","on","at","by","as","is","it","be","or"
    ]);
    return (text.match(/[\p{L}\p{N}][\p{L}\p{N}_+.-]{1,}/gu) || [])
      .map(token => token.replace(/^[._+-]+|[._+-]+$/g, ""))
      .filter(token => token.length > 2 && !stop.has(token) && !/^\d+$/.test(token))
      .slice(0, 900);
  },

  computeTextSimilarities(seed, nodes) {
    const docs = [];
    const seedKey = this.recordIdentityKey(seed);
    const records = [seed, ...(nodes || []).filter(node => this.recordIdentityKey(node) !== seedKey)];
    for (const record of records) {
      const counts = new Map();
      for (const token of this.scientificTokens(record)) counts.set(token, (counts.get(token) || 0) + 1);
      docs.push({ record, counts });
    }
    const df = new Map();
    for (const doc of docs) for (const term of doc.counts.keys()) df.set(term, (df.get(term) || 0) + 1);
    const nDocs = Math.max(1, docs.length);
    const vectors = new Map();
    for (const doc of docs) {
      const vec = new Map();
      let norm2 = 0;
      for (const [term, count] of doc.counts) {
        const tf = 1 + Math.log(Math.max(1, count));
        const idf = Math.log((nDocs + 1) / ((df.get(term) || 0) + 1)) + 1;
        const value = tf * idf;
        vec.set(term, value);
        norm2 += value * value;
      }
      vectors.set(this.recordIdentityKey(doc.record), { vec, norm: Math.sqrt(norm2) || 1 });
    }
    const seedVector = vectors.get(seedKey) || { vec: new Map(), norm: 1 };
    for (const node of nodes || []) {
      if (node.seed || this.recordIdentityKey(node) === seedKey) {
        node.textSimilarity = 1;
        continue;
      }
      const current = vectors.get(this.recordIdentityKey(node));
      if (!current) { node.textSimilarity = 0; continue; }
      let dot = 0;
      const [small, large] = seedVector.vec.size <= current.vec.size ? [seedVector.vec, current.vec] : [current.vec, seedVector.vec];
      for (const [term, value] of small) dot += value * (large.get(term) || 0);
      node.textSimilarity = Math.max(0, Math.min(1, dot / (seedVector.norm * current.norm || 1)));
    }
  },

  relationWeightForMode(mode) {
    return ({ similar: 1.0, reviews: 0.9, cited: 0.75, references: 0.75, useful: 0.65, trending: 0.5 })[mode] || 0.6;
  },

  nodeRelationWeight(node) {
    if (node?.seed) return 1;
    const modes = [...(node?.modes || [])].filter(mode => mode !== "seed");
    if (!modes.length) return 0.55;
    const base = Math.max(...modes.map(mode => this.relationWeightForMode(mode)));
    return Math.max(0, Math.min(1, base * (1 + 0.12 * Math.max(0, modes.length - 1))));
  },

  semanticScoreForNode(node, index) {
    let best = 0;
    for (const key of this.recordMatchKeys(node)) best = Math.max(best, Number(index?.get?.(key) || 0));
    return Math.max(0, Math.min(1, best));
  },

  async applySemanticWeights(seed, nodes, options = {}) {
    let index = options.semanticIndex instanceof Map ? new Map(options.semanticIndex) : new Map();
    let source = index.size ? "openalex+local" : "local";
    if (options.fetchOpenAlex && this.pref("openAlexFallback", true)) {
      try {
        const results = await this.openAlexSemanticSearch(seed, 50);
        const fetchedIndex = this.semanticIndexFromOpenAlex(results);
        if (fetchedIndex.size) {
          index = fetchedIndex;
          source = "openalex+local";
          this.enrichNodesFromOpenAlex(nodes, results);
        }
      } catch (error) {
        this.log("OpenAlex semantic weighting unavailable; using local text weighting: " + (error?.message || error));
      }
    }
    this.computeTextSimilarities(seed, nodes);
    for (const node of nodes || []) {
      if (node.seed) {
        node.relationWeight = 1;
        node.semanticScore = 1;
        node.layoutAffinity = 1;
        continue;
      }
      const relation = this.nodeRelationWeight(node);
      const text = Number(node.textSimilarity || 0);
      const semantic = this.semanticScoreForNode(node, index);
      const affinity = semantic > 0
        ? 0.45 * relation + 0.30 * text + 0.25 * semantic
        : 0.58 * relation + 0.42 * text;
      node.relationWeight = relation;
      node.semanticScore = semantic;
      node.layoutAffinity = Math.max(0, Math.min(1, affinity));
    }
    return { index, source };
  },

  recordIdentityKey(record) {
    if (record?.doi) return "doi:" + String(record.doi).trim().toLowerCase();
    const arxiv = this.nodeArxivID(record);
    if (arxiv) return "arxiv:" + String(arxiv).toLowerCase();
    return "title:" + this.normalizeTitle(record?.title) + "|" + String(record?.year || "");
  },

  mergePaper(merged, paper, mode, parentBibcode = null) {
    const key = this.recordIdentityKey(paper);
    let node = merged.get(key);
    if (!node) {
      node = this.nodeFromRecord(paper, false);
      merged.set(key, node);
    } else {
      if ((!node.abstract || node.abstract.length < 20) && paper.abstract) node.abstract = paper.abstract;
      if (!node.doi && paper.doi) node.doi = paper.doi;
      node.citationCount = Math.max(Number(node.citationCount || 0), Number(paper.citationCount || 0));
      if (paper.references?.length) node.references = [...new Set([...(node.references || []), ...paper.references])];
      if (!node.openAlexID && paper.openAlexID) node.openAlexID = paper.openAlexID;
      if (!node.semanticTerms && paper.semanticTerms) node.semanticTerms = paper.semanticTerms;
      if (!node.firstAuthor && paper.firstAuthor) node.firstAuthor = paper.firstAuthor;
      if (paper.correspondingAuthors?.length) node.correspondingAuthors = [...new Set([...(node.correspondingAuthors || []), ...paper.correspondingAuthors])];
    }
    node.modes.add(mode);
    if (!(node.discoveredFrom instanceof Set)) node.discoveredFrom = new Set(node.discoveredFrom || []);
    if (parentBibcode && parentBibcode !== node.bibcode) node.discoveredFrom.add(parentBibcode);
    return node;
  },

  adsFields() {
    return ["bibcode", "title", "author", "year", "pub", "pubdate", "citation_count", "doi", "identifier", "abstract", "reference", "property"];
  },

  operator(mode) {
    if (mode === "cited") return "citations";
    return mode;
  },

  modeLabel(mode) {
    return ({ cited: "Cited by", references: "References", similar: "Similar", reviews: "Reviews", useful: "Useful", trending: "Trending" })[mode] || mode;
  },

  normalizeRecord(raw) {
    const title = Array.isArray(raw.title) ? raw.title[0] : raw.title;
    const doi = Array.isArray(raw.doi) ? raw.doi[0] : raw.doi;
    const authors = Array.isArray(raw.author) ? raw.author : [];
    return {
      bibcode: raw.bibcode,
      title: title || raw.bibcode || "Untitled",
      authors,
      firstAuthor: authors[0] || "",
      correspondingAuthors: [],
      year: raw.year || String(raw.pubdate || "").match(/\b(?:19|20)\d{2}\b/)?.[0] || "",
      pub: raw.pub || "",
      doi: doi || null,
      identifiers: Array.isArray(raw.identifier) ? raw.identifier : [],
      abstract: raw.abstract || "",
      citationCount: Number(raw.citation_count || 0),
      references: Array.isArray(raw.reference) ? raw.reference : [],
      property: Array.isArray(raw.property) ? raw.property : [],
      source: "ads",
      openAlexID: null,
      relatedOpenAlex: [],
      semanticTerms: ""
    };
  },

  nodeFromRecord(record, seed) {
    return {
      id: record.bibcode,
      bibcode: record.bibcode,
      title: record.title,
      authors: record.authors,
      firstAuthor: record.firstAuthor || record.authors?.[0] || "",
      correspondingAuthors: Array.isArray(record.correspondingAuthors) ? record.correspondingAuthors : [],
      year: record.year,
      pub: record.pub,
      doi: record.doi,
      identifiers: record.identifiers,
      abstract: record.abstract,
      citationCount: record.citationCount,
      references: record.references,
      property: record.property,
      source: record.source || "ads",
      openAlexID: record.openAlexID || null,
      relatedOpenAlex: record.relatedOpenAlex || [],
      semanticTerms: record.semanticTerms || "",
      modes: new Set(seed ? ["seed"] : []),
      discoveredFrom: new Set(),
      seed: Boolean(seed),
      localItemID: null,
      relationWeight: seed ? 1 : 0,
      textSimilarity: seed ? 1 : 0,
      semanticScore: seed ? 1 : 0,
      layoutAffinity: seed ? 1 : 0,
      x: 550,
      y: 270,
      vx: 0,
      vy: 0
    };
  },

  displayLabel(node) {
    const first = String(node.authors?.[0] || "").trim().replace(/\s+/g, " ");
    let surname = "";
    if (first.includes(",")) {
      surname = first.split(",")[0].trim();
    } else if (first) {
      const words = first.split(" ").filter(Boolean);
      const collectiveIndex = words.findIndex(word => /^(collaboration|consortium|team|survey|project)$/i.test(word));
      if (collectiveIndex >= 0) {
        surname = words.slice(Math.max(0, collectiveIndex - 2), collectiveIndex + 1).join(" ");
      } else {
        const particles = new Set([
          "da", "dal", "de", "del", "della", "den", "der", "di", "dos", "du",
          "la", "le", "van", "von", "zu", "zum", "zur"
        ]);
        let start = Math.max(0, words.length - 1);
        while (start > 0 && particles.has(words[start - 1].toLocaleLowerCase())) start--;
        surname = words.slice(start).join(" ");
      }
    }
    if (!surname) surname = (node.title || "Paper").split(/\s+/).slice(0, 2).join(" ");
    if (surname.length > 32) surname = surname.slice(0, 30).trimEnd() + "…";
    return surname + (node.year ? " (" + node.year + ")" : "");
  },

  normalizeTitle(title) {
    return String(title || "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  },

  async attachLocalItems(state, nodes) {
    const pane = state.win?.ZoteroPane || Zotero.getActiveZoteroPane?.();

    // Match against every normal Zotero library (user + groups), not only the
    // current collection or the seed library. Prefer the current/seed library
    // when the same scholarly work exists in more than one library.
    let preferredLibraryID = state.seedItem?.libraryID || null;
    if (!preferredLibraryID) {
      try {
        const values = this.paneValues(pane, "getSelectedLibraryIDs", "getSelectedLibraryID");
        preferredLibraryID = Number(values[0] || 0) || null;
      } catch (_) {}
    }
    if (!preferredLibraryID) preferredLibraryID = Zotero.Libraries.userLibraryID;

    let libraries = [];
    try {
      libraries = (Zotero.Libraries.getAll?.() || []).filter(lib =>
        lib && lib.libraryType !== "feed" && lib.libraryType !== "publications"
      );
    } catch (_) {}
    libraries.sort((a, b) => {
      const ap = Number(a.libraryID) === Number(preferredLibraryID) ? 0 : 1;
      const bp = Number(b.libraryID) === Number(preferredLibraryID) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      const au = Number(a.libraryID) === Number(Zotero.Libraries.userLibraryID) ? 0 : 1;
      const bu = Number(b.libraryID) === Number(Zotero.Libraries.userLibraryID) ? 0 : 1;
      return au - bu;
    });

    const byDOI = new Map(), byBib = new Map(), byArxiv = new Map(), byTitle = new Map();
    const addIndex = (map, key, item) => {
      if (!key || map.has(key)) return;
      map.set(key, {
        id: Number(item.id),
        libraryID: Number(item.libraryID),
        collectionIDs: (() => { try { return item.getCollections?.() || []; } catch (_) { return []; } })()
      });
    };

    for (const library of libraries) {
      let items = [];
      try {
        items = await Zotero.Items.getAll(Number(library.libraryID), true);
      } catch (error) {
        this.log("Whole-library matching failed for library " + library.libraryID + ": " + (error?.message || error));
        continue;
      }
      for (const item of items) {
        if (!item || (item.isRegularItem && !item.isRegularItem())) continue;
        const doi = String(item.getField?.("DOI") || "").trim().toLowerCase();
        addIndex(byDOI, doi, item);
        const bib = this.plugin.extractBibcode(item);
        addIndex(byBib, bib ? String(bib).toUpperCase() : "", item);
        const ax = this.plugin.extractArxivID(item);
        addIndex(byArxiv, ax ? String(ax).replace(/v\d+$/i, "").toLowerCase() : "", item);
        const title = this.normalizeTitle(item.getField?.("title"));
        addIndex(byTitle, title, item);
      }
    }

    for (const node of nodes) {
      let match = byBib.get(String(node.bibcode || "").toUpperCase()) || null;
      if (!match && node.doi) match = byDOI.get(String(node.doi).toLowerCase()) || null;
      if (!match) {
        for (const ident of node.identifiers || []) {
          const m = String(ident).match(/^arXiv:(.+)$/i);
          if (m) {
            match = byArxiv.get(m[1].replace(/v\d+$/i, "").toLowerCase()) || null;
            if (match) break;
          }
        }
      }
      if (!match) match = byTitle.get(this.normalizeTitle(node.title)) || null;
      node.localItemID = match?.id || null;
      node.localLibraryID = match?.libraryID || null;
      node.localCollectionIDs = match?.collectionIDs || [];
    }
  },

  buildEdges(nodes, seedBibcode) {
    const ids = new Set(nodes.map(n => n.bibcode));
    const edgeMap = new Map();
    const add = (source, target, kind, mode) => {
      if (!source || !target || source === target) return;
      const key = source + "→" + target + "|" + kind;
      if (!edgeMap.has(key)) edgeMap.set(key, { source, target, kind, mode: mode || null });
    };
    for (const node of nodes) {
      if (node.bibcode !== seedBibcode) {
        const parents = node.discoveredFrom instanceof Set ? [...node.discoveredFrom] : (node.discoveredFrom || []);
        const mode = [...(node.modes || [])].find(value => value !== "seed") || null;
        if (parents.length) {
          for (const parent of parents) if (ids.has(parent)) add(parent, node.bibcode, "discovery", mode);
        } else {
          // Backward-compatible fallback for graphs cached before progressive
          // expansion metadata existed.
          add(seedBibcode, node.bibcode, "discovery", mode);
        }
      }
      for (const ref of node.references || []) if (ids.has(ref)) add(node.bibcode, ref, "citation", null);
    }
    return [...edgeMap.values()];
  },

  layoutGraph(graph) {
    const W = 1100, H = 540, cx = W / 2, cy = H / 2;
    const yScale = 0.78;
    const nodes = [...graph.nodes].sort((a, b) => {
      if (a.seed !== b.seed) return a.seed ? -1 : 1;
      return String(a.bibcode || "").localeCompare(String(b.bibcode || ""));
    });
    const nonSeed = nodes.filter(node => !node.seed);
    const nodeMap = new Map(nodes.map(n => [n.bibcode, n]));

    // Discovery depth is a secondary radial term only. The primary radial
    // signal remains combined seed affinity, but unlike test5 the target is
    // a soft band rather than an almost fixed radius.
    const depth = new Map([[graph.seedBibcode, 0]]);
    const discoveryEdges = (graph.edges || []).filter(edge => edge.kind === "discovery");
    for (let pass = 0; pass < 4; pass++) {
      let changed = false;
      for (const edge of discoveryEdges) {
        if (!depth.has(edge.source)) continue;
        const next = Math.min(3, Number(depth.get(edge.source)) + 1);
        if (!depth.has(edge.target) || next < depth.get(edge.target)) {
          depth.set(edge.target, next);
          changed = true;
        }
      }
      if (!changed) break;
    }

    const desiredRadius = node => {
      if (node.seed) return 0;
      const affinity = Math.max(0, Math.min(1, Number(node.layoutAffinity || 0)));
      const level = Math.max(1, Number(depth.get(node.bibcode) || 1));
      const rMin = 50;
      const rMax = 330;
      const gamma = 1.10;
      const depthPenalty = Math.min(20, Math.max(0, level - 1) * 10);
      return Math.min(rMax, rMin + Math.pow(1 - affinity, gamma) * (rMax - rMin) + depthPenalty);
    };

    // Build a non-seed weighted literature network. Citation edges are the
    // strongest community signal; discovery/similar/review edges contribute
    // according to their relation type. Seed edges are intentionally omitted
    // so they cannot collapse all papers into one angular direction.
    const adjacency = new Map(nonSeed.map(n => [n.bibcode, new Map()]));
    const addAdj = (a, b, weight) => {
      if (!adjacency.has(a) || !adjacency.has(b) || a === b) return;
      const w = Math.max(0, Math.min(1.4, Number(weight) || 0));
      if (w <= 0) return;
      const ma = adjacency.get(a), mb = adjacency.get(b);
      ma.set(b, Math.max(ma.get(b) || 0, w));
      mb.set(a, Math.max(mb.get(a) || 0, w));
    };
    for (const edge of graph.edges || []) {
      const a = nodeMap.get(edge.source), b = nodeMap.get(edge.target);
      if (!a || !b || a.seed || b.seed) continue;
      const w = edge.kind === "citation"
        ? 1.0
        : (0.46 + 0.48 * this.relationWeightForMode(edge.mode));
      addAdj(a.bibcode, b.bibcode, w);
    }

    const weightedDegree = new Map();
    for (const node of nonSeed) {
      let sum = 0;
      for (const value of adjacency.get(node.bibcode)?.values() || []) sum += value;
      weightedDegree.set(node.bibcode, sum);
    }
    const maxDegree = Math.max(1, ...weightedDegree.values());

    const weightedJaccard = (idA, idB) => {
      const a = adjacency.get(idA) || new Map();
      const b = adjacency.get(idB) || new Map();
      const keys = new Set([...a.keys(), ...b.keys()]);
      let minSum = 0, maxSum = 0;
      for (const key of keys) {
        const av = Number(a.get(key) || 0), bv = Number(b.get(key) || 0);
        minSum += Math.min(av, bv);
        maxSum += Math.max(av, bv);
      }
      return maxSum > 0 ? minSum / maxSum : 0;
    };

    // Select several diverse high-connectivity anchors. This deliberately
    // avoids one giant community in dense citation graphs: an anchor candidate
    // is penalized when its neighborhood strongly overlaps an existing anchor.
    const n = nonSeed.length;
    const communityCount = n <= 12 ? Math.max(1, Math.min(2, n))
      : n <= 36 ? 3
      : Math.max(4, Math.min(7, Math.round(Math.sqrt(n) / 2.35)));
    const anchorScore = node => {
      const degreeScore = Number(weightedDegree.get(node.bibcode) || 0) / maxDegree;
      const citationTie = Math.log1p(Number(node.citationCount || 0));
      return degreeScore + Math.min(0.12, citationTie / 120);
    };
    const anchors = [];
    const candidates = [...nonSeed].sort((a, b) => {
      const d = anchorScore(b) - anchorScore(a);
      return Math.abs(d) > 1e-9 ? d : String(a.bibcode).localeCompare(String(b.bibcode));
    });
    if (candidates.length) anchors.push(candidates[0]);
    while (anchors.length < Math.min(communityCount, candidates.length)) {
      let best = null, bestScore = -Infinity;
      for (const node of candidates) {
        if (anchors.includes(node)) continue;
        let overlap = 0;
        for (const anchor of anchors) overlap = Math.max(overlap, weightedJaccard(node.bibcode, anchor.bibcode));
        const direct = Math.max(0, ...anchors.map(anchor => Number(adjacency.get(node.bibcode)?.get(anchor.bibcode) || 0)));
        const diversity = Math.max(0.12, 1 - 0.72 * overlap - 0.18 * Math.min(1, direct));
        const score = anchorScore(node) * diversity + this.hash01("anchor|" + node.bibcode) * 1e-4;
        if (score > bestScore) { best = node; bestScore = score; }
      }
      if (!best) break;
      anchors.push(best);
    }

    // Assign every paper to the anchor it is most strongly connected to.
    // Direct relation dominates, neighborhood overlap is secondary, and a
    // small same-relation bonus helps ambiguous papers choose a coherent group.
    const assignment = new Map();
    for (let i = 0; i < anchors.length; i++) assignment.set(anchors[i].bibcode, i);
    for (const node of nonSeed) {
      if (assignment.has(node.bibcode)) continue;
      let bestIndex = 0, bestScore = -Infinity;
      for (let i = 0; i < anchors.length; i++) {
        const anchor = anchors[i];
        const direct = Number(adjacency.get(node.bibcode)?.get(anchor.bibcode) || 0);
        const overlap = weightedJaccard(node.bibcode, anchor.bibcode);
        const sameMode = this.primaryMode(node) === this.primaryMode(anchor) ? 1 : 0;
        const score = 1.50 * direct + 0.92 * overlap + 0.09 * sameMode
          + this.hash01(node.bibcode + "|" + anchor.bibcode) * 1e-4;
        if (score > bestScore) { bestScore = score; bestIndex = i; }
      }
      // Isolated nodes are distributed deterministically instead of all
      // defaulting to community zero.
      if (bestScore < 0.03 && anchors.length > 1) {
        bestIndex = Math.floor(this.hash01("community|" + graph.seedBibcode + "|" + node.bibcode) * anchors.length) % anchors.length;
      }
      assignment.set(node.bibcode, bestIndex);
    }

    const clusters = anchors.map((anchor, index) => ({ index, anchor, nodes: [] }));
    for (const node of nonSeed) {
      const index = Math.max(0, Math.min(clusters.length - 1, Number(assignment.get(node.bibcode) || 0)));
      clusters[index]?.nodes.push(node);
    }
    // Guard against unusual tiny/disconnected graphs.
    if (!clusters.length && nonSeed.length) clusters.push({ index: 0, anchor: nonSeed[0], nodes: [...nonSeed] });

    // Allocate deterministic angular sectors around the full circle. Larger
    // communities get somewhat more room, but sqrt(size) prevents one large
    // group from monopolizing the map.
    const gap = clusters.length > 1 ? 0.14 : 0;
    const totalWeight = clusters.reduce((sum, c) => sum + Math.sqrt(Math.max(1, c.nodes.length)), 0) || 1;
    const available = Math.max(Math.PI, Math.PI * 2 - gap * clusters.length);
    const rotation = (this.hash01("rotation|" + String(graph.seedBibcode || "seed")) - 0.5) * 0.8;
    let cursor = -Math.PI + rotation;
    for (const cluster of clusters) {
      const width = available * Math.sqrt(Math.max(1, cluster.nodes.length)) / totalWeight;
      cluster.start = cursor;
      cluster.end = cursor + width;
      cluster.center = cursor + width / 2;
      cluster.halfWidth = Math.max(0.18, width / 2);
      cursor += width + gap;
    }

    for (const node of nodes) {
      if (node.seed) {
        node.x = cx; node.y = cy; node.vx = node.vy = 0; node.targetRadius = 0;
        node.communityID = -1;
        continue;
      }
      const ci = Math.max(0, Math.min(clusters.length - 1, Number(assignment.get(node.bibcode) || 0)));
      const cluster = clusters[ci] || clusters[0];
      const radius = desiredRadius(node);
      const hash = this.hash01("angle|" + graph.seedBibcode + "|" + node.bibcode);
      const spread = cluster ? Math.min(cluster.halfWidth * 0.78, 0.95) : Math.PI;
      const offset = (hash * 2 - 1) * spread;
      const angle = (cluster?.center || 0) + offset;
      node.targetRadius = radius;
      node.communityID = ci;
      node.communityAnchor = cluster?.anchor?.bibcode || null;
      node.communityAngleTarget = angle;
      node.communityCenter = cluster?.center || 0;
      node.communityHalfWidth = cluster?.halfWidth || Math.PI;
      node.x = cx + Math.cos(angle) * radius;
      node.y = cy + Math.sin(angle) * radius * yScale;
      node.vx = 0; node.vy = 0;
    }

    const edges = (graph.edges || [])
      .map(e => ({ ...e, a: nodeMap.get(e.source), b: nodeMap.get(e.target) }))
      .filter(e => e.a && e.b)
      .sort((a, b) => (String(a.source) + "|" + String(a.target) + "|" + String(a.kind))
        .localeCompare(String(b.source) + "|" + String(b.target) + "|" + String(b.kind)));

    const normalizeAngle = angle => {
      while (angle > Math.PI) angle -= Math.PI * 2;
      while (angle < -Math.PI) angle += Math.PI * 2;
      return angle;
    };

    // Soft radial relevance + community sectors + local force layout.
    // Radial distance remains interpretable on average, but papers are free to
    // move enough to preserve meaningful local neighborhoods inside each sector.
    for (let iter = 0; iter < 240; iter++) {
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          let dx = b.x - a.x, dy = b.y - a.y;
          const d2 = dx * dx + dy * dy + 1.0;
          const d = Math.sqrt(d2);
          const sameCommunity = !a.seed && !b.seed && a.communityID === b.communityID;
          const repulsion = sameCommunity ? 1280 : 1640;
          const force = Math.min(2.6, repulsion / d2);
          dx /= d; dy /= d;
          if (!a.seed) { a.vx -= dx * force; a.vy -= dy * force; }
          if (!b.seed) { b.vx += dx * force; b.vy += dy * force; }
        }
      }

      for (const e of edges) {
        const a = e.a, b = e.b;
        if (a.seed || b.seed) continue;
        let dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.max(1, Math.hypot(dx, dy));
        dx /= d; dy /= d;
        const sameCommunity = a.communityID === b.communityID;
        const relation = e.kind === "citation" ? 0.92 : this.relationWeightForMode(e.mode);
        const target = e.kind === "citation" ? (72 - 18 * relation) : (116 - 28 * relation);
        const baseStrength = e.kind === "citation" ? 0.0095 : 0.0060;
        // Cross-community edges remain visible but are too weak to collapse
        // the sector structure back into one dense arc.
        const strength = baseStrength * (sameCommunity ? 1 : 0.16);
        const f = (d - target) * strength;
        a.vx += dx * f; a.vy += dy * f;
        b.vx -= dx * f; b.vy -= dy * f;
      }

      for (const node of nonSeed) {
        const desired = Number(node.targetRadius || desiredRadius(node));
        let rx = node.x - cx;
        let ry = (node.y - cy) / yScale;
        let radius = Math.max(1, Math.hypot(rx, ry));
        const angle = Math.atan2(ry, rx);
        const ux = rx / radius;
        const uyScreen = (ry / radius) * yScale;

        // Soft radial spring: enough to preserve seed-distance meaning, but it
        // no longer suppresses most radial motion as test5 did.
        const radialVelocity = node.vx * ux + node.vy * uyScreen;
        node.vx -= ux * radialVelocity * 0.28;
        node.vy -= uyScreen * radialVelocity * 0.28;
        const radialCorrection = (desired - radius) * 0.022;
        node.vx += ux * radialCorrection;
        node.vy += uyScreen * radialCorrection;

        // Community-sector attraction acts mostly tangentially. Each node has
        // a deterministic angular target inside its sector, which prevents all
        // members from collapsing on the sector center while still allowing
        // local citation springs to form sub-groups around important anchors.
        const delta = normalizeAngle(Number(node.communityAngleTarget || 0) - angle);
        const tx = -Math.sin(angle);
        const ty = Math.cos(angle) * yScale;
        const angularStrength = node.bibcode === node.communityAnchor ? 0.034 : 0.015;
        const tangent = Math.max(-1.0, Math.min(1.0, delta)) * radius * angularStrength;
        node.vx += tx * tangent;
        node.vy += ty * tangent;

        node.vx *= 0.835; node.vy *= 0.835;
        node.x += node.vx; node.y += node.vy;

        // Broad radial band only: allow roughly ±26% (at least 36 px) around
        // the seed-affinity target. The hard nearest-distance floor is 25 px,
        // so strongly related papers can sit closer to the seed without changing
        // the target-radius mapping itself.
        rx = node.x - cx;
        ry = (node.y - cy) / yScale;
        radius = Math.max(1, Math.hypot(rx, ry));
        const band = Math.max(36, desired * 0.26);
        const minRadius = Math.max(25, desired - band);
        const maxRadius = Math.min(366, desired + band);
        if (radius < minRadius || radius > maxRadius) {
          const clipped = Math.max(minRadius, Math.min(maxRadius, radius));
          node.x = cx + (rx / radius) * clipped;
          node.y = cy + (ry / radius) * clipped * yScale;
        }
        node.x = Math.max(22, Math.min(W - 22, node.x));
        node.y = Math.max(22, Math.min(H - 22, node.y));
      }
    }
  },

  hash01(text) {
    let h = 2166136261;
    for (let i = 0; i < String(text).length; i++) {
      h ^= String(text).charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 4294967295;
  },

  nodeRadius(node) {
    if (node.seed) return 11;
    return Math.max(3.8, Math.min(13.5, 3.5 + Math.log10((node.citationCount || 0) + 1) * 2.4));
  },

  modeColor(mode) {
    return ({
      cited: "#e67e57",
      references: "#7d8597",
      similar: "#4f83cc",
      reviews: "#9b6fd6",
      useful: "#d3a33a",
      trending: "#d66b91",
      seed: "#4c6fff"
    })[mode] || "#7d8597";
  },

  primaryMode(node) {
    if (node.seed) return "seed";
    const priority = ["cited", "references", "similar", "reviews", "useful", "trending"];
    for (const mode of priority) if (node.modes?.has?.(mode)) return mode;
    return [...(node.modes || [])][0] || "similar";
  },

  nodeColor(node) {
    return this.modeColor(this.primaryMode(node));
  },

  updateLegend(state) {
    const box = state.legend;
    if (!box) return;
    box.replaceChildren();
    const doc = state.doc;
    const addSymbol = (filled, text) => {
      const wrap = this.el(doc, "span", { style: "display:inline-flex;align-items:center;gap:3px;white-space:nowrap" });
      const dot = this.el(doc, "span", {
        style: [
          "display:inline-block", "width:9px", "height:9px", "border-radius:50%",
          "border:1.6px solid CanvasText", filled ? "background:CanvasText" : "background:Canvas"
        ].join(";")
      });
      wrap.append(dot, this.el(doc, "span", {}, text));
      box.appendChild(wrap);
    };
    addSymbol(true, "in Zotero");
    addSymbol(false, "not in Zotero");
    for (const mode of ["cited", "references", "similar", "reviews", "useful", "trending"]) {
      if (!state.selectedModes.has(mode)) continue;
      const wrap = this.el(doc, "span", { style: "display:inline-flex;align-items:center;gap:3px;white-space:nowrap" });
      const dot = this.el(doc, "span", { style: "display:inline-block;width:9px;height:9px;border-radius:50%;background:" + this.modeColor(mode) });
      wrap.append(dot, this.el(doc, "span", {}, this.modeLabel(mode)));
      box.appendChild(wrap);
    }
  },

  normalizeSearchText(value) {
    return String(value || "").toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  },

  parseMapSearchQuery(raw) {
    const tokens = [];
    const text = String(raw || "").trim();
    if (!text) return tokens;

    // A field value may contain spaces up to the next explicit field, so
    // `author:Guo Hong year:2019` works without requiring quotation marks.
    const fieldRe = /(title|author|year):/gi;
    const fields = [...text.matchAll(fieldRe)];
    const addFreeText = part => {
      const re = /"([^"]+)"|(\S+)/g;
      let m;
      while ((m = re.exec(part))) {
        const value = this.normalizeSearchText(m[1] || m[2] || "");
        if (value) tokens.push({ field: null, value });
      }
    };

    if (!fields.length) {
      addFreeText(text);
      return tokens;
    }

    const prefix = text.slice(0, fields[0].index).trim();
    if (prefix) addFreeText(prefix);
    for (let i = 0; i < fields.length; i++) {
      const match = fields[i];
      const field = String(match[1] || "").toLowerCase();
      const from = match.index + match[0].length;
      const to = i + 1 < fields.length ? fields[i + 1].index : text.length;
      let rawValue = text.slice(from, to).trim();
      if (rawValue.startsWith('"') && rawValue.endsWith('"') && rawValue.length >= 2) {
        rawValue = rawValue.slice(1, -1);
      }
      const value = this.normalizeSearchText(rawValue);
      if (value) tokens.push({ field, value });
    }
    return tokens;
  },

  searchTextHasAllWords(text, query) {
    const haystack = this.normalizeSearchText(text);
    const words = this.normalizeSearchText(query).split(/\s+/).filter(Boolean);
    return Boolean(words.length) && words.every(word => haystack.includes(word));
  },

  leadAuthorSearchText(node) {
    const first = node?.firstAuthor || node?.authors?.[0] || "";
    const corresponding = Array.isArray(node?.correspondingAuthors) ? node.correspondingAuthors : [];
    return this.normalizeSearchText([first, ...corresponding].filter(Boolean).join(" "));
  },

  nodeMatchesSearch(node, tokens, leadOnly = false) {
    if (!tokens?.length) return true;
    const title = this.normalizeSearchText(node?.title || "");
    const author = this.normalizeSearchText((node?.authors || []).join(" "));
    const leadAuthor = this.leadAuthorSearchText(node);
    const year = this.normalizeSearchText(node?.year || "");
    const all = (title + " " + author + " " + year).trim();
    return tokens.every(token => {
      if (token.field === "title") return title.includes(token.value);
      if (token.field === "year") return year.includes(token.value);
      if (token.field === "author") return this.searchTextHasAllWords(leadOnly ? leadAuthor : author, token.value);
      if (leadOnly) return this.searchTextHasAllWords(leadAuthor, token.value);
      return all.includes(token.value);
    });
  },

  updateMapSearch(state, focusFirst = false) {
    const graph = state.graphData;
    let raw = String(state.searchInput?.value || "").trim();
    const caretLeadOnly = raw.startsWith("^");
    if (caretLeadOnly) raw = raw.slice(1).trim();
    const leadOnly = Boolean(state.searchLeadOnly || caretLeadOnly);
    state.searchQuery = (caretLeadOnly ? "^" : "") + raw;
    state.searchCursor = -1;
    if (!graph?.nodes?.length || !raw) {
      state.searchMatches = new Set();
      if (state.searchResult) state.searchResult.textContent = "";
      this.applyViewTransform(state);
      return;
    }
    const tokens = this.parseMapSearchQuery(raw);
    const matches = graph.nodes.filter(node => this.nodeMatchesSearch(node, tokens, leadOnly));
    state.searchMatches = new Set(matches.map(node => node.bibcode));
    if (state.searchResult) state.searchResult.textContent = matches.length + "/" + graph.nodes.length + (leadOnly ? " · 1st/corr" : "");
    this.applyViewTransform(state);
    if (focusFirst && matches.length) this.focusSearchResult(state, 1);
  },

  focusSearchResult(state, direction = 1) {
    const graph = state.graphData;
    if (!graph?.nodes?.length || !state.searchMatches?.size) return;
    const matches = graph.nodes.filter(node => state.searchMatches.has(node.bibcode))
      .sort((a, b) => this.nodeLODScore(b, graph) - this.nodeLODScore(a, graph));
    if (!matches.length) return;
    const step = direction < 0 ? -1 : 1;
    state.searchCursor = (state.searchCursor + step + matches.length) % matches.length;
    const node = matches[state.searchCursor];
    state.selectedBibcode = node.bibcode;
    const visualScale = this.visualZoomScale(state.zoom);
    state.panX = 550 - node.x * visualScale;
    state.panY = 270 - node.y * visualScale;
    this.applyViewTransform(state);
    this.showDetails(state, node);
    if (state.searchResult) state.searchResult.textContent = (state.searchCursor + 1) + "/" + matches.length;
  },

  nodeLODScore(node, graph) {
    if (node?.seed) return 1e9;
    if (!Number.isFinite(graph?._lodMaxCitations)) {
      graph._lodMaxCitations = Math.max(1, ...(graph?.nodes || []).map(n => Number(n.citationCount || 0)));
    }
    const maxCitations = graph._lodMaxCitations;
    const citation = Math.log10(Number(node?.citationCount || 0) + 1) / Math.log10(maxCitations + 1);
    const affinity = Math.max(0, Math.min(1, Number(node?.layoutAffinity || 0)));
    const relation = Math.max(0, Math.min(1, Number(node?.relationWeight || 0)));
    const modeCount = Math.max(1, [...(node?.modes || [])].filter(mode => mode !== "seed").length);
    const multi = Math.min(1, Math.max(0, modeCount - 1) / 3);
    const local = node?.localItemID ? 1 : 0;
    const parents = node?.discoveredFrom instanceof Set ? [...node.discoveredFrom] : (node?.discoveredFrom || []);
    const direct = parents.includes(graph?.seedBibcode) ? 1 : 0;
    return 0.42 * affinity + 0.16 * relation + 0.18 * citation + 0.10 * multi + 0.08 * local + 0.06 * direct;
  },

  lodBudget(zoom, total) {
    if (total <= 1) return total;
    const minBudget = Math.min(total, Math.max(24, Math.round(Math.sqrt(total) * 2.2)));
    if (zoom >= 2.25) return total;
    const t = Math.max(0, Math.min(1, (Number(zoom || 1) - 0.35) / (2.25 - 0.35)));
    return Math.min(total, Math.max(minBudget, Math.round(minBudget + (total - minBudget) * Math.pow(t, 1.35))));
  },

  lodVisibleIDs(state) {
    const graph = state.graphData;
    if (!graph?.nodes?.length) return new Set();
    const total = graph.nodes.length;
    const budget = this.lodBudget(state.zoom, total);
    const selected = new Set();
    const force = bibcode => { if (bibcode) selected.add(bibcode); };
    const seed = graph.nodes.find(node => node.seed);
    force(seed?.bibcode);
    force(state.selectedBibcode);
    for (const bibcode of state.batchSelection || []) force(bibcode);
    for (const bibcode of state.searchMatches || []) force(bibcode);

    // Ensure every active relation can keep at least a few representatives at low zoom.
    const activeModes = ["cited", "references", "similar", "reviews", "useful", "trending"]
      .filter(mode => state.selectedModes.has(mode));
    for (const mode of activeModes) {
      const candidates = graph.nodes.filter(node => !node.seed && node.modes?.has?.(mode))
        .sort((a, b) => this.nodeLODScore(b, graph) - this.nodeLODScore(a, graph));
      for (const node of candidates.slice(0, state.zoom < 0.8 ? 2 : 3)) force(node.bibcode);
    }

    const sorted = graph.nodes.filter(node => !selected.has(node.bibcode))
      .sort((a, b) => this.nodeLODScore(b, graph) - this.nodeLODScore(a, graph));
    for (const node of sorted) {
      if (selected.size >= budget) break;
      selected.add(node.bibcode);
    }
    return selected;
  },

  updateLODVisibility(state) {
    if (!state.graphData?.nodes?.length || !state.nodeElements?.size) return;
    const visible = this.lodVisibleIDs(state);
    state.lodVisibleIDs = visible;
    const searching = Boolean(String(state.searchQuery || "").trim());
    for (const [bibcode, entry] of state.nodeElements) {
      const show = visible.has(bibcode);
      entry.group.style.display = show ? "" : "none";
      if (!show) continue;
      const matched = !searching || state.searchMatches.has(bibcode) || entry.node.seed;
      entry.group.style.opacity = matched ? "1" : "0.12";
      if (entry.searchRing) entry.searchRing.style.display = searching && state.searchMatches.has(bibcode) ? "" : "none";
    }
    for (const entry of state.edgeElements || []) {
      const show = visible.has(entry.edge.source) && visible.has(entry.edge.target);
      entry.line.style.display = show ? "" : "none";
      if (!show) continue;
      if (searching) {
        const aMatch = state.searchMatches.has(entry.edge.source);
        const bMatch = state.searchMatches.has(entry.edge.target);
        entry.line.style.opacity = (aMatch || bMatch) ? "0.85" : "0.10";
      } else {
        entry.line.style.opacity = "1";
      }
    }
    this.renderQualityText(state);
  },

  relationModes(node) {
    const order = ["cited", "references", "similar", "reviews", "useful", "trending"];
    const modes = [...(node?.modes || [])].filter(mode => mode !== "seed");
    return order.filter(mode => modes.includes(mode)).concat(modes.filter(mode => !order.includes(mode)).sort());
  },

  ringArcPath(radius, startAngle, endAngle) {
    const polar = angle => ({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
    const a = polar(startAngle), b = polar(endAngle);
    const large = endAngle - startAngle > Math.PI ? 1 : 0;
    return "M " + a.x.toFixed(3) + " " + a.y.toFixed(3) +
      " A " + radius.toFixed(3) + " " + radius.toFixed(3) + " 0 " + large + " 1 " + b.x.toFixed(3) + " " + b.y.toFixed(3);
  },

  edgeLayoutWeight(edge, a, b) {
    const relation = edge.kind === "citation" ? 0.78 : this.relationWeightForMode(edge.mode);
    const semantic = a?.seed ? Number(b?.layoutAffinity || 0) : b?.seed ? Number(a?.layoutAffinity || 0)
      : (Number(a?.layoutAffinity || 0) + Number(b?.layoutAffinity || 0)) / 2;
    return Math.max(0, Math.min(1, 0.62 * relation + 0.38 * semantic));
  },

  edgeTargetDistance(edge, a, b) {
    const weight = this.edgeLayoutWeight(edge, a, b);
    return edge.kind === "citation" ? (108 - 24 * weight) : (205 - 92 * weight);
  },

  averageRanks(values) {
    const indexed = values.map((value, index) => ({ value: Number(value), index }))
      .sort((a, b) => a.value - b.value);
    const ranks = new Array(values.length).fill(0);
    let i = 0;
    while (i < indexed.length) {
      let j = i + 1;
      while (j < indexed.length && Math.abs(indexed[j].value - indexed[i].value) < 1e-12) j++;
      const rank = (i + 1 + j) / 2;
      for (let k = i; k < j; k++) ranks[indexed[k].index] = rank;
      i = j;
    }
    return ranks;
  },

  pearson(a, b) {
    if (!a?.length || a.length !== b?.length || a.length < 2) return 0;
    const ma = a.reduce((x, y) => x + y, 0) / a.length;
    const mb = b.reduce((x, y) => x + y, 0) / b.length;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) {
      const xa = a[i] - ma, xb = b[i] - mb;
      num += xa * xb; da += xa * xa; db += xb * xb;
    }
    return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
  },

  computeMapQuality(graph) {
    const nodes = graph?.nodes || [];
    const seed = nodes.find(node => node.seed);
    if (!seed || nodes.length < 3) return { rho: 0, neighborhood: 0, stress: 0 };
    const nonSeed = nodes.filter(node => !node.seed);
    const affinity = nonSeed.map(node => Number(node.layoutAffinity || 0));
    const invDistance = nonSeed.map(node => -Math.hypot(node.x - seed.x, node.y - seed.y));
    const rho = this.pearson(this.averageRanks(affinity), this.averageRanks(invDistance));

    const nodeMap = new Map(nodes.map(node => [node.bibcode, node]));
    const pairScores = new Map();
    const pairKey = (a, b) => String(a) < String(b) ? String(a) + "|" + String(b) : String(b) + "|" + String(a);
    for (const edge of graph.edges || []) {
      const a = nodeMap.get(edge.source), b = nodeMap.get(edge.target);
      if (!a || !b) continue;
      const key = pairKey(edge.source, edge.target);
      pairScores.set(key, Math.max(pairScores.get(key) || 0, this.edgeLayoutWeight(edge, a, b)));
    }
    for (const node of nonSeed) pairScores.set(pairKey(seed.bibcode, node.bibcode), Math.max(pairScores.get(pairKey(seed.bibcode, node.bibcode)) || 0, Number(node.layoutAffinity || 0)));

    let neighborhoodSum = 0, neighborhoodCount = 0;
    for (const node of nodes) {
      const targets = nodes.filter(other => other !== node)
        .map(other => ({ other, score: pairScores.get(pairKey(node.bibcode, other.bibcode)) || 0 }))
        .filter(entry => entry.score > 0.05)
        .sort((a, b) => b.score - a.score);
      if (targets.length < 3) continue;
      const k = Math.min(10, targets.length);
      const expected = new Set(targets.slice(0, k).map(entry => entry.other.bibcode));
      const spatial = nodes.filter(other => other !== node)
        .map(other => ({ other, d: Math.hypot(other.x - node.x, other.y - node.y) }))
        .sort((a, b) => a.d - b.d).slice(0, k);
      const overlap = spatial.filter(entry => expected.has(entry.other.bibcode)).length / k;
      neighborhoodSum += overlap; neighborhoodCount++;
    }
    const neighborhood = neighborhoodCount ? neighborhoodSum / neighborhoodCount : 0;

    let num = 0, den = 0;
    for (const edge of graph.edges || []) {
      const a = nodeMap.get(edge.source), b = nodeMap.get(edge.target);
      if (!a || !b) continue;
      const target = this.edgeTargetDistance(edge, a, b);
      const actual = Math.hypot(b.x - a.x, b.y - a.y);
      const error = actual - target;
      num += error * error;
      den += target * target;
    }
    const stress = den > 0 ? Math.sqrt(num / den) : 0;
    return { rho, neighborhood, stress };
  },

  renderQualityText(state) {
    if (!state.qualityEl || !state.graphData) return;
    const total = state.graphData.nodes?.length || 0;
    const visible = state.lodVisibleIDs?.size || total;
    const q = state.qualityMetrics;
    if (!q) {
      state.qualityEl.textContent = "Visible " + visible + "/" + total + " · quality pending";
      return;
    }
    const rho = Number.isFinite(q.rho) ? q.rho.toFixed(2) : "n/a";
    const n10 = Number.isFinite(q.neighborhood) ? Math.round(q.neighborhood * 100) + "%" : "n/a";
    const stress = Number.isFinite(q.stress) ? q.stress.toFixed(2) : "n/a";
    state.qualityEl.textContent = "Visible " + visible + "/" + total + " · seed ρ " + rho + " · map N@10 " + n10 + " · stress " + stress;
  },

  labelPriority(node) {
    if (node.seed) return 1e9;
    const citations = Math.max(0, Number(node.citationCount || 0));
    const modeCount = Math.max(1, node.modes?.size || 1);
    return Math.log10(citations + 1) * 24 + (node.localItemID ? 18 : 0) + Math.max(0, modeCount - 1) * 7;
  },

  labelBudgetForZoom(zoom, visibleCount, modeCount) {
    let base;
    if (zoom < 0.55) base = 10;
    else if (zoom < 0.8) base = 16;
    else if (zoom < 1.05) base = 26;
    else if (zoom < 1.35) base = 36;
    else if (zoom < 1.7) base = 50;
    else if (zoom < 2.1) base = 70;
    else if (zoom < 2.55) base = 100;
    else base = visibleCount;

    let perMode;
    if (zoom < 0.65) perMode = 1;
    else if (zoom < 0.9) perMode = 2;
    else if (zoom < 1.15) perMode = 4;
    else if (zoom < 1.45) perMode = 6;
    else if (zoom < 1.8) perMode = 9;
    else perMode = 12;

    return {
      budget: Math.min(visibleCount, Math.max(base, modeCount * perMode)),
      perMode
    };
  },

  visualZoomScale(zoom) {
    const z = Math.max(0.01, Number(zoom || 1));
    // Deliberately compress geometric zoom so node-to-node distances do not
    // stretch linearly. LOD still uses the raw zoom value, so zooming in
    // reveals more papers while the map remains spatially compact.
    return Math.pow(z, 0.60);
  },

  nodeScreenPosition(state, node) {
    const visualScale = this.visualZoomScale(state.zoom);
    return {
      x: state.panX + node.x * visualScale,
      y: state.panY + node.y * visualScale
    };
  },

  labelRect(state, node) {
    const pos = this.nodeScreenPosition(state, node);
    const text = this.displayLabel(node);
    const fontSize = node.seed ? 14.5 : 12.2;
    const width = Math.min(250, Math.max(34, text.length * fontSize * 0.56 + 4));
    const left = pos.x + this.nodeRadius(node) + 5;
    return {
      left,
      right: left + width,
      top: pos.y - fontSize * 0.78,
      bottom: pos.y + fontSize * 0.38
    };
  },

  labelsOverlap(a, b) {
    const pad = 2.5;
    return !(a.right + pad < b.left || b.right + pad < a.left || a.bottom + pad < b.top || b.bottom + pad < a.top);
  },

  visibleLabelIDs(state) {
    const graph = state.graphData;
    if (!graph?.nodes?.length) return new Set();
    const zoom = Math.max(0.01, Number(state.zoom || 1));
    const activeModes = ["cited", "references", "similar", "reviews", "useful", "trending"]
      .filter(mode => state.selectedModes.has(mode));

    const visibleNodes = graph.nodes.filter(node => {
      if (state.lodVisibleIDs?.size && !state.lodVisibleIDs.has(node.bibcode)) return false;
      if (node.seed) return true;
      const p = this.nodeScreenPosition(state, node);
      return p.x > -90 && p.x < 1190 && p.y > -55 && p.y < 595;
    });
    if (!visibleNodes.length) return new Set();

    // When deeply zoomed in, show every label in the current viewport.
    if (zoom >= 2.55) return new Set(visibleNodes.map(node => node.bibcode));

    const { budget, perMode } = this.labelBudgetForZoom(zoom, visibleNodes.length, activeModes.length);
    const selected = new Set();
    const rects = [];
    const sorted = nodes => [...nodes].sort((a, b) => this.labelPriority(b) - this.labelPriority(a));

    const addNode = (node, force = false) => {
      if (!node || selected.has(node.bibcode) || selected.size >= budget) return false;
      const rect = this.labelRect(state, node);
      if (!force && rects.some(existing => this.labelsOverlap(rect, existing))) return false;
      selected.add(node.bibcode);
      rects.push(rect);
      return true;
    };

    const seed = visibleNodes.find(node => node.seed);
    if (seed) addNode(seed, true);
    const selectedNode = visibleNodes.find(node => node.bibcode === state.selectedBibcode);
    if (selectedNode) addNode(selectedNode, true);
    const searchNodes = visibleNodes.filter(node => state.searchMatches?.has?.(node.bibcode))
      .sort((a, b) => this.labelPriority(b) - this.labelPriority(a));
    for (const node of searchNodes.slice(0, 25)) addNode(node, true);

    // Give every enabled relation type a fair share before filling by citation
    // importance. Round-robin prevents References from monopolising labels.
    const modeCandidates = new Map();
    const modeIndex = new Map();
    for (const mode of activeModes) {
      modeCandidates.set(mode, sorted(visibleNodes.filter(node => !node.seed && node.modes?.has?.(mode))));
      modeIndex.set(mode, 0);
    }
    for (let round = 0; round < perMode && selected.size < budget; round++) {
      for (const mode of activeModes) {
        if (selected.size >= budget) break;
        const candidates = modeCandidates.get(mode) || [];
        let index = modeIndex.get(mode) || 0;
        let added = false;
        while (index < candidates.length) {
          const candidate = candidates[index++];
          if (selected.has(candidate.bibcode)) continue;
          if (addNode(candidate, false)) { added = true; break; }
        }
        modeIndex.set(mode, index);
        // At least one visible label per active category, even in a dense cluster.
        if (round === 0 && !added && candidates.length) {
          const fallback = candidates.find(candidate => !selected.has(candidate.bibcode));
          if (fallback) addNode(fallback, true);
        }
      }
    }

    // Fill remaining room using a global importance score, with Zotero/local
    // and multi-relation papers receiving a modest priority boost.
    for (const node of sorted(visibleNodes)) {
      if (selected.size >= budget) break;
      addNode(node, false);
    }
    return selected;
  },

  updateLabelVisibility(state) {
    if (!state.labelElements?.size) return;
    const zoom = Math.max(0.01, Number(state.zoom || 1));
    const visibleIDs = this.visibleLabelIDs(state);
    for (const [bibcode, entry] of state.labelElements) {
      const { label, node } = entry;
      const show = visibleIDs.has(bibcode);
      label.style.display = show ? "" : "none";
      if (!show) continue;

      // Node groups are already counter-scaled by 1/zoom, so keep label
      // geometry constant inside the group. Dividing the font by zoom here
      // would counter-scale it twice and make labels tiny at high zoom.
      const baseFont = node.seed ? 14.5 : 12.2;
      label.setAttribute("x", (this.nodeRadius(node) + 5).toFixed(2));
      label.setAttribute("y", "4");
      label.setAttribute("font-size", baseFont.toFixed(1));
      label.setAttribute("stroke-width", "3");
    }
  },

  renderGraph(state, graph) {
    this.clearSVG(state);
    this.updateLegend(state);
    this.layoutGraph(graph);
    const doc = state.doc, svg = state.svg;
    const defs = this.svgEl(doc, "defs");
    const marker = this.svgEl(doc, "marker", { id: "az-arrow", markerWidth: 7, markerHeight: 7, refX: 6, refY: 3.5, orient: "auto", markerUnits: "strokeWidth" });
    marker.appendChild(this.svgEl(doc, "path", { d: "M0,0 L7,3.5 L0,7 z", fill: "currentColor" }));
    defs.appendChild(marker);
    svg.appendChild(defs);

    const viewport = this.svgEl(doc, "g", { id: "astrozotero-map-viewport" });
    state.viewport = viewport;
    const edgeLayer = this.svgEl(doc, "g", { "pointer-events": "none" });
    const nodeLayer = this.svgEl(doc, "g");
    viewport.append(edgeLayer, nodeLayer);
    svg.appendChild(viewport);

    const nodeMap = new Map(graph.nodes.map(n => [n.bibcode, n]));
    for (const edge of graph.edges) {
      const a = nodeMap.get(edge.source), b = nodeMap.get(edge.target);
      if (!a || !b) continue;
      const citation = edge.kind === "citation";
      const line = this.svgEl(doc, "line", {
        x1: a.x.toFixed(1), y1: a.y.toFixed(1), x2: b.x.toFixed(1), y2: b.y.toFixed(1),
        stroke: citation ? "#6f86a8" : "#a7b5c7",
        "stroke-width": citation ? "1.15" : "0.65",
        "stroke-opacity": citation ? "0.34" : "0.18",
        "vector-effect": "non-scaling-stroke"
      });
      if (citation) line.setAttribute("marker-end", "url(#az-arrow)");
      edgeLayer.appendChild(line);
      state.edgeElements.push({ line, edge, a, b });
    }

    state.labelElements = new Map();
    state.nodeElements = new Map();

    for (const node of graph.nodes) {
      const g = this.svgEl(doc, "g", { transform: "translate(" + node.x.toFixed(1) + "," + node.y.toFixed(1) + ")", tabindex: "0" });
      g.style.cursor = "pointer";
      const color = this.nodeColor(node);
      const circle = this.svgEl(doc, "circle", {
        r: this.nodeRadius(node).toFixed(1),
        fill: node.seed || node.localItemID ? color : "Canvas",
        "fill-opacity": node.seed ? "1" : (node.localItemID ? "0.82" : "1"),
        stroke: node.seed ? "#111" : "none",
        "stroke-width": node.seed ? "3.2" : "0"
      });
      g.appendChild(circle);

      // Relationship type is encoded by an equal-proportion segmented ring.
      // The centre remains available for Zotero membership (filled vs hollow).
      if (!node.seed) {
        const modes = this.relationModes(node);
        const ringR = this.nodeRadius(node) + 2.3;
        if (modes.length <= 1) {
          const mode = modes[0] || this.primaryMode(node);
          g.appendChild(this.svgEl(doc, "circle", {
            r: ringR.toFixed(1), fill: "none", stroke: this.modeColor(mode),
            "stroke-width": "3.0", "stroke-linecap": "round"
          }));
        } else {
          const span = Math.PI * 2 / modes.length;
          const gap = Math.min(0.045, span * 0.08);
          modes.forEach((mode, index) => {
            const start = -Math.PI / 2 + index * span + gap;
            const end = -Math.PI / 2 + (index + 1) * span - gap;
            g.appendChild(this.svgEl(doc, "path", {
              d: this.ringArcPath(ringR, start, end), fill: "none",
              stroke: this.modeColor(mode), "stroke-width": "3.0", "stroke-linecap": "round"
            }));
          });
        }
      }
      const searchRing = this.svgEl(doc, "circle", {
        r: (this.nodeRadius(node) + 5.8).toFixed(1), fill: "none",
        stroke: "#f4b400", "stroke-width": "2.2", "stroke-dasharray": "3 2"
      });
      searchRing.style.display = "none";
      g.appendChild(searchRing);
      const title = this.svgEl(doc, "title");
      title.textContent = node.title + "\n" + this.displayLabel(node) + " · " + node.citationCount + " citations" + (node.localItemID ? " · In Zotero" : " · Not in Zotero");
      g.appendChild(title);
      const label = this.svgEl(doc, "text", {
        x: (this.nodeRadius(node) + 5).toFixed(1), y: "4",
        "font-size": node.seed ? "14.5" : "12.2",
        "font-family": "system-ui, sans-serif",
        fill: "CanvasText",
        "paint-order": "stroke",
        stroke: "Canvas",
        "stroke-width": "3",
        "stroke-linejoin": "round",
        "pointer-events": "none"
      });
      label.textContent = this.displayLabel(node);
      label.style.display = "none";
      g.appendChild(label);
      state.labelElements.set(node.bibcode, { label, node });
      state.nodeElements.set(node.bibcode, { group: g, node, searchRing });
      if (state.batchSelection.has(node.bibcode)) {
        g.insertBefore(this.svgEl(doc, "circle", {
          r: (this.nodeRadius(node) + 4.2).toFixed(1), fill: "none",
          stroke: "#2f80ed", "stroke-width": "2", "stroke-dasharray": "3 2"
        }), g.firstChild);
      }
      g.addEventListener("click", event => {
        event.stopPropagation();
        if ((event.ctrlKey || event.metaKey) && !node.seed && !node.localItemID) {
          this.toggleBatchNode(state, node);
          return;
        }
        this.selectNode(state, node);
      });
      g.addEventListener("dblclick", event => {
        event.stopPropagation();
        state.seedRecord = node;
        state.seedItem = null;
        this.loadMap(state, false).catch(error => this.setStatus(state, error?.message || String(error), true));
      });
      nodeLayer.appendChild(g);
    }
    state.qualityMetrics = this.computeMapQuality(graph);
    if (String(state.searchInput?.value || "").trim()) this.updateMapSearch(state, false);
    else this.applyViewTransform(state);
  },

  selectNode(state, node) {
    state.selectedBibcode = node?.bibcode || null;
    this.applyViewTransform(state);
    this.showDetails(state, node);
    if (node.localItemID) {
      this.revealItemInZotero(state.win, node.localItemID, node.localLibraryID, node.localCollectionIDs)
        .catch(error => this.log("Selecting Zotero item failed: " + error));
    }
  },

  showDetails(state, node) {
    const doc = state.doc, box = state.details;
    box.replaceChildren();
    box.style.display = "block";
    const close = this.makeButton(doc, "×", () => { box.style.display = "none"; });
    close.style.cssText += ";float:right;padding:0 6px;font-size:16px";
    box.appendChild(close);
    box.appendChild(this.el(doc, "div", { style: "font-weight:700;font-size:13px;line-height:1.3;margin-right:28px" }, node.title));
    box.appendChild(this.el(doc, "div", { style: "color:GrayText;margin-top:5px;line-height:1.4" }, [this.formatAuthors(node.authors), node.pub, node.year, node.citationCount + " citations"].filter(Boolean).join(" · ")));
    const badges = this.el(doc, "div", { style: "display:flex;gap:4px;flex-wrap:wrap;margin:7px 0" });
    if (node.seed) badges.appendChild(this.badge(doc, "Seed", this.modeColor("seed")));
    badges.appendChild(this.badge(doc, node.localItemID ? "In Zotero" : "Not in Zotero", null, Boolean(node.localItemID)));
    for (const mode of node.modes || []) {
      if (mode !== "seed") badges.appendChild(this.badge(doc, this.modeLabel(mode), this.modeColor(mode)));
    }
    box.appendChild(badges);
    if (!node.seed) {
      const pct = value => Math.round(Math.max(0, Math.min(1, Number(value || 0))) * 100) + "%";
      const semanticText = node.semanticScore > 0 ? pct(node.semanticScore) : "n/a";
      box.appendChild(this.el(doc, "div", { style: "color:GrayText;font-size:11px;line-height:1.45;margin:5px 0 7px" },
        "Map weight · relation " + pct(node.relationWeight) +
        " · local text " + pct(node.textSimilarity) +
        " · OpenAlex semantic " + semanticText +
        " · combined " + pct(node.layoutAffinity)));
    }
    if (node.abstract) box.appendChild(this.el(doc, "div", { style: "line-height:1.45;max-height:120px;overflow:auto;margin:6px 0" }, node.abstract));
    const actions = this.el(doc, "div", { style: "display:flex;gap:5px;flex-wrap:wrap;margin-top:8px" });
    if (node.source === "openalex" || String(node.bibcode).startsWith("OA:")) {
      const wid = node.openAlexID || String(node.bibcode).replace(/^OA:/, "");
      actions.appendChild(this.makeButton(doc, "Open OpenAlex", () => Zotero.launchURL("https://openalex.org/" + wid)));
    } else {
      actions.appendChild(this.makeButton(doc, "Open ADS", () => Zotero.launchURL("https://ui.adsabs.harvard.edu/abs/" + encodeURIComponent(node.bibcode) + "/abstract")));
    }
    if (node.doi) actions.appendChild(this.makeButton(doc, "Open DOI", () => Zotero.launchURL("https://doi.org/" + node.doi)));
    if (node.localItemID) {
      actions.appendChild(this.makeButton(doc, "Show in Zotero", () => {
        this.revealItemInZotero(state.win, node.localItemID, node.localLibraryID, node.localCollectionIDs);
      }));
    } else {
      actions.appendChild(this.makeButton(doc, "Add to Zotero", async () => {
        await this.addNodeToZotero(state, node);
      }));
      actions.appendChild(this.makeButton(doc, state.batchSelection.has(node.bibcode) ? "Unselect batch" : "Select for batch", () => {
        this.toggleBatchNode(state, node);
      }));
    }
    if (!node.seed) {
      const expandedBefore = [...(state.expansionProgress?.keys?.() || [])].some(key => key.startsWith(node.bibcode + "|"));
      actions.appendChild(this.makeButton(doc, expandedBefore ? "Expand more" : "Expand", async () => {
        await this.expandNode(state, node);
      }));
    }
    actions.appendChild(this.makeButton(doc, "Set as seed", async () => {
      state.seedRecord = node; state.seedItem = null; await this.loadMap(state, false);
    }));
    box.appendChild(actions);
  },

  badge(doc, text, color = null, filled = true) {
    let style;
    if (color) {
      const background = filled ? "color-mix(in srgb," + color + " 18%,Canvas)" : "Canvas";
      style = "font-size:11px;padding:2px 6px;border-radius:999px;border:1px solid " + color + ";color:CanvasText;background:" + background;
    } else {
      const background = filled ? "color-mix(in srgb,CanvasText 12%,Canvas)" : "Canvas";
      style = "font-size:11px;padding:2px 6px;border-radius:999px;border:1px solid color-mix(in srgb,CanvasText 25%,transparent);color:CanvasText;background:" + background;
    }
    return this.el(doc, "span", { style }, text);
  },

  nodeArxivID(node) {
    for (const raw of node.identifiers || []) {
      const match = String(raw).match(/^arXiv:(.+)$/i);
      if (match) return match[1].replace(/v\d+$/i, "");
    }
    return null;
  },

  asList(value) {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value : [value];
  },

  paneValues(pane, pluralName, singularName) {
    if (!pane) return [];
    try {
      if (typeof pane[pluralName] === "function") return this.asList(pane[pluralName]());
    } catch (_) {}
    try {
      if (typeof pane[singularName] === "function") return this.asList(pane[singularName]());
    } catch (_) {}
    return [];
  },

  collectionIDFromCandidate(candidate) {
    if (!candidate || typeof candidate !== "object") return null;
    try {
      if (typeof candidate.isCollection === "function" && !candidate.isCollection()) return null;
    } catch (_) {}
    const ref = candidate.ref || candidate.collection || candidate;
    const value = Number(ref?.collectionID ?? ref?.id ?? candidate.collectionID ?? candidate.id ?? 0);
    return Number.isFinite(value) && value > 0 ? value : null;
  },

  selectedCollectionIDsFromPane(pane) {
    let candidates = this.paneValues(pane, "getSelectedCollections", "getSelectedCollection");
    if (!candidates.length) candidates = this.paneValues(pane, "getCollectionTreeRows", "getCollectionTreeRow");
    return [...new Set(candidates.map(candidate => this.collectionIDFromCandidate(candidate)).filter(Boolean))];
  },

  selectedLibraryContext(state, useFrozen = false) {
    if (useFrozen && state.targetContext?.libraryID) {
      return {
        pane: state.win.ZoteroPane || Zotero.getActiveZoteroPane?.(),
        libraryID: Number(state.targetContext.libraryID),
        collectionIDs: [...(state.targetContext.collectionIDs || [])]
      };
    }
    const pane = state.win.ZoteroPane || Zotero.getActiveZoteroPane?.();
    let libraryID = null;
    const libraryValues = this.paneValues(pane, "getSelectedLibraryIDs", "getSelectedLibraryID");
    if (libraryValues.length) libraryID = Number(libraryValues[0]) || null;
    if (!libraryID) {
      const rows = this.paneValues(pane, "getCollectionTreeRows", "getCollectionTreeRow");
      for (const row of rows) {
        const ref = row?.ref || row;
        const value = Number(row?.libraryID ?? ref?.libraryID ?? 0);
        if (value > 0) { libraryID = value; break; }
      }
    }
    if (!libraryID && state.seedItem?.libraryID) libraryID = Number(state.seedItem.libraryID);
    if (!libraryID) libraryID = Zotero.Libraries.userLibraryID;
    const collectionIDs = this.selectedCollectionIDsFromPane(pane)
      .filter(id => {
        try { return Number(Zotero.Collections.get(id)?.libraryID || 0) === Number(libraryID); } catch (_) { return false; }
      });
    return { pane, libraryID, collectionIDs };
  },

  async revealItemInZotero(win, itemID, libraryID = null, preferredCollectionIDs = []) {
    const pane = win?.ZoteroPane || Zotero.getActiveZoteroPane?.();
    const item = Zotero.Items.get(Number(itemID));
    if (!pane || !item) return false;
    libraryID = Number(libraryID || item.libraryID || 0);

    // Zotero's own high-level selector is used throughout Zotero to reveal an
    // item from related-item links and progress dialogs. It can change the
    // collection/library view as needed, unlike itemsView.selectItem(), which
    // only works reliably when the item is already visible in the current list.
    try {
      if (typeof pane.selectItem === "function") {
        await pane.selectItem(Number(item.id));
        return true;
      }
    } catch (_) {}

    // If it lives in a collection, try a known containing collection first.
    const candidates = [...new Set([
      ...(preferredCollectionIDs || []),
      ...(() => { try { return item.getCollections?.() || []; } catch (_) { return []; } })()
    ].map(Number).filter(id => id > 0))];
    for (const collectionID of candidates) {
      try {
        const collection = Zotero.Collections.get(collectionID);
        if (!collection || Number(collection.libraryID) !== libraryID) continue;
        if (typeof pane.collectionsView?.selectCollection === "function") {
          await pane.collectionsView.selectCollection(collectionID);
        } else if (typeof pane.collectionsView?.selectItem === "function") {
          await pane.collectionsView.selectItem(collectionID);
        } else {
          continue;
        }
        await Zotero.Promise.delay(30);
        const selected = await pane.itemsView?.selectItem?.(Number(item.id));
        if (selected !== false) return true;
      } catch (_) {}
    }

    // Guaranteed fallback: switch to the item's library root, then select it.
    try {
      await pane.collectionsView?.selectLibrary?.(libraryID);
      await Zotero.Promise.delay(50);
      await pane.itemsView?.selectItem?.(Number(item.id));
      return true;
    } catch (error) {
      this.log("Reveal item in Zotero failed: " + (error?.message || error));
      return false;
    }
  },

  async addNodeToZotero(state, node) {
    if (node.localItemID) return node.localItemID;
    const { pane, libraryID, collectionIDs } = this.selectedLibraryContext(state);
    const progress = this.plugin.createProgress(state.win, "AstroZotero: Add to Zotero");
    const line = new progress.ItemProgress(null, "Importing " + this.displayLabel(node) + "…");
    line.setProgress(25);
    let imported = [];
    try {
      const arxiv = this.nodeArxivID(node);
      const identifier = node.doi ? { DOI: node.doi } : (arxiv ? { arXiv: arxiv } : null);
      if (identifier) {
        try {
          const translate = new Zotero.Translate.Search();
          translate.setIdentifier(identifier);
          const translators = await translate.getTranslators();
          if (translators?.length) {
            translate.setTranslator(translators);
            imported = await translate.translate({
              libraryID,
              collections: collectionIDs.length ? collectionIDs : false,
              // Keep graph exploration fast. AstroZotero's PDF commands handle
              // publisher/arXiv/ADS PDF retrieval explicitly afterwards.
              saveAttachments: false
            });
          }
        } catch (error) {
          this.log("Identifier import failed; falling back to ADS metadata: " + (error?.message || error));
        }
      }

      let item = imported?.[0] || null;
      if (!item) item = await this.createItemFromNode(state, node);

      // Ensure astronomy identifiers are kept even when Zotero imported the item
      // through DOI/arXiv rather than ADS itself.
      if (node.source !== "openalex") {
        try {
          this.plugin.updateExtra(item, {
            bibcode: node.bibcode,
            identifier: node.identifiers || [],
            arxiv_class: []
          });
          await item.saveTx();
        } catch (_) {}
      }

      node.localItemID = item.id;
      node.localLibraryID = item.libraryID;
      try { node.localCollectionIDs = item.getCollections?.() || []; } catch (_) { node.localCollectionIDs = []; }
      line.setText("Added to Zotero");
      line.setProgress(85);

      // A deliberate single-paper Add should normally leave the user with a
      // readable paper, not only metadata. Batch imports stay metadata-only.
      if (this.pref("downloadPDFOnSingleAdd", true)) {
        line.setText("Added to Zotero · downloading Best PDF…");
        try {
          await this.plugin.downloadBestPDFForItem(state.win, item);
        } catch (pdfError) {
          this.log("Best PDF after Add to Zotero failed: " + (pdfError?.message || pdfError));
        }
      }

      line.setText("Added to Zotero" + (this.pref("downloadPDFOnSingleAdd", true) ? " · PDF step finished" : ""));
      line.setProgress(100);
      this.plugin.closeProgressLater(state.win, progress, 4500);
      if (state.graphData) this.renderGraph(state, state.graphData);
      if (state.details) this.showDetails(state, node);
      try { await this.revealItemInZotero(state.win, item.id, item.libraryID, item.getCollections?.() || []); } catch (_) {}
      return item.id;
    } catch (error) {
      line.setText("Add failed: " + (error?.message || error));
      line.setProgress(100);
      this.plugin.closeProgressLater(state.win, progress, 8000);
      throw error;
    }
  },

  updateBatchControls(state) {
    const count = state.batchSelection.size;
    if (state.batchAddButton) {
      state.batchAddButton.textContent = "Add selected (" + count + ")";
      state.batchAddButton.disabled = count === 0;
    }
  },

  toggleBatchNode(state, node) {
    if (!node || node.seed || node.localItemID) return;
    if (state.batchSelection.has(node.bibcode)) state.batchSelection.delete(node.bibcode);
    else state.batchSelection.add(node.bibcode);
    this.updateBatchControls(state);
    if (state.graphData) this.renderGraph(state, state.graphData);
    this.showDetails(state, node);
  },

  selectAllNew(state) {
    if (!state.graphData) return;
    const external = state.graphData.nodes.filter(node => !node.seed && !node.localItemID);
    const allSelected = external.length > 0 && external.every(node => state.batchSelection.has(node.bibcode));
    state.batchSelection.clear();
    if (!allSelected) for (const node of external) state.batchSelection.add(node.bibcode);
    if (state.batchSelectButton) state.batchSelectButton.textContent = allSelected ? "Select all new" : "Clear selection";
    this.updateBatchControls(state);
    this.renderGraph(state, state.graphData);
  },

  async createItemFromNode(state, node, targetContext = null) {
    if (node.localItemID) return Zotero.Items.get(node.localItemID);
    const { libraryID, collectionIDs } = targetContext || this.selectedLibraryContext(state);
    const item = new Zotero.Item("journalArticle");
    item.libraryID = libraryID;
    item.setField("title", node.title || node.bibcode || "Untitled work");
    if (node.year) item.setField("date", String(node.year));
    if (node.pub) item.setField("publicationTitle", node.pub);
    if (node.abstract) item.setField("abstractNote", node.abstract);
    if (node.doi) item.setField("DOI", node.doi);
    if (node.source === "openalex") {
      const wid = node.openAlexID || String(node.bibcode).replace(/^OA:/, "");
      item.setField("url", "https://openalex.org/" + wid);
    } else {
      item.setField("url", "https://ui.adsabs.harvard.edu/abs/" + node.bibcode + "/abstract");
    }
    (node.authors || []).forEach((creator, index) => {
      const raw = String(creator || "").trim();
      if (!raw) return;
      const parts = raw.split(",");
      if (parts.length >= 2) {
        item.setCreator(index, { creatorType: "author", lastName: parts[0].trim(), firstName: parts.slice(1).join(",").trim() });
      } else {
        const words = raw.split(/\s+/);
        item.setCreator(index, { creatorType: "author", firstName: words.slice(0, -1).join(" "), lastName: words.slice(-1)[0] || raw });
      }
    });
    let extraLines = [];
    if (node.source === "openalex") {
      const wid = node.openAlexID || String(node.bibcode).replace(/^OA:/, "");
      extraLines.push("OpenAlex ID: " + wid);
      const arxiv = this.nodeArxivID(node);
      if (arxiv) {
        extraLines.push("tex.archivePrefix: arXiv");
        extraLines.push("tex.eprint: " + arxiv);
      }
      item.setField("extra", extraLines.join("\n"));
    }
    if (collectionIDs.length && typeof item.setCollections === "function") {
      try { item.setCollections(collectionIDs); } catch (_) {}
    }
    await item.saveTx({ skipSelect: true });
    if (node.source !== "openalex") {
      try {
        this.plugin.updateExtra(item, { bibcode: node.bibcode, identifier: node.identifiers || [], arxiv_class: [] });
        await item.saveTx();
      } catch (_) {}
    }
    for (const collectionID of collectionIDs) {
      const collection = Zotero.Collections.get(collectionID);
      if (collection && !collection.hasItem?.(item.id)) {
        collection.addItem(item.id);
        await collection.saveTx?.();
      }
    }
    node.localItemID = item.id;
    node.localLibraryID = item.libraryID;
    try { node.localCollectionIDs = item.getCollections?.() || [...collectionIDs]; } catch (_) { node.localCollectionIDs = [...collectionIDs]; }
    return item;
  },

  async ensureItemCollections(item, collectionIDs) {
    if (!item || !collectionIDs?.length || typeof item.setCollections !== "function") return;
    const valid = [];
    for (const id of collectionIDs) {
      try {
        const collection = Zotero.Collections.get(Number(id));
        if (collection && Number(collection.libraryID) === Number(item.libraryID)) valid.push(Number(id));
      } catch (_) {}
    }
    if (!valid.length) return;
    let existing = [];
    try { existing = item.getCollections?.() || []; } catch (_) {}
    const merged = [...new Set([...existing.map(Number), ...valid])].filter(id => id > 0);
    item.setCollections(merged);
    await item.saveTx({ skipSelect: true });
  },

  async downloadBatchPDF(state, item, node, apiKey, line, index, total) {
    const fresh = await Zotero.Items.getAsync(Number(item.id));
    if (!fresh) throw new Error("Imported Zotero item is not available yet");
    const run = async (attempt) => {
      // ADS resolver/search calls can be bursty after a batch import. Pace the
      // requests and give the freshly saved Zotero item time to settle.
      if (attempt > 1) await Zotero.Promise.delay(1600);
      else await Zotero.Promise.delay(700);
      return await this.plugin.downloadOnePDF(fresh, apiKey, status => {
        line.setText("Adding " + index + "/" + total + ": " + this.displayLabel(node) + " · " + status);
      });
    };
    try {
      const result = await run(1);
      if (!result) throw new Error("Best PDF returned no attachment");
      return result;
    } catch (firstError) {
      this.log("Batch PDF first attempt failed for " + node.bibcode + ": " + (firstError?.message || firstError));
      const result = await run(2);
      if (!result) throw firstError;
      return result;
    }
  },

  async batchAddSelected(state) {
    if (!state.graphData || !state.batchSelection.size) return;
    const nodes = state.graphData.nodes.filter(node => state.batchSelection.has(node.bibcode) && !node.localItemID && !node.seed);
    if (!nodes.length) return;
    const { libraryID, collectionIDs } = this.selectedLibraryContext(state, true);
    const targetContext = { libraryID, collectionIDs: [...collectionIDs] };
    const downloadPDF = this.pref("downloadPDFOnBatchAdd", true);
    const apiKey = downloadPDF ? this.plugin.ensureApiKey(state.win) : null;
    const progress = this.plugin.createProgress(state.win, "AstroZotero: Batch add to Zotero");
    const targetText = collectionIDs.length ? " · current collection" : " · library root";
    const line = new progress.ItemProgress(null, "Preparing " + nodes.length + " papers" + targetText + "…");
    let added = 0, failed = 0, pdfOK = 0, pdfFailed = 0;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      line.setText("Adding " + (i + 1) + "/" + nodes.length + ": " + this.displayLabel(node));
      line.setProgress(Math.round((i / Math.max(1, nodes.length)) * 100));
      try {
        const item = await this.createItemFromNode(state, node, targetContext);
        added++;
        // Re-assert membership on the item itself. This is more reliable than
        // mutating Collection objects and ensures the imported work lands in
        // the collection that was active when the map seed was chosen.
        await this.ensureItemCollections(item, collectionIDs);
        try { node.localCollectionIDs = item.getCollections?.() || [...collectionIDs]; } catch (_) { node.localCollectionIDs = [...collectionIDs]; }

        if (downloadPDF && apiKey) {
          line.setText("Adding " + (i + 1) + "/" + nodes.length + ": " + this.displayLabel(node) + " · downloading PDF…");
          try {
            await this.downloadBatchPDF(state, item, node, apiKey, line, i + 1, nodes.length);
            pdfOK++;
          } catch (pdfError) {
            pdfFailed++;
            this.log("Batch PDF failed for " + node.bibcode + ": " + (pdfError?.message || pdfError));
          }
        }
      } catch (error) {
        failed++;
        this.log("Batch add failed for " + node.bibcode + ": " + (error?.message || error));
      }
    }
    state.batchSelection.clear();
    if (state.batchSelectButton) state.batchSelectButton.textContent = "Select all new";
    this.updateBatchControls(state);
    let summary = "Added " + added + " papers";
    if (collectionIDs.length) summary += " to current collection";
    if (downloadPDF && apiKey) summary += "; PDFs " + pdfOK + " ok" + (pdfFailed ? ", " + pdfFailed + " failed" : "");
    else if (downloadPDF && !apiKey) summary += "; PDFs skipped (ADS token unavailable)";
    if (failed) summary += "; " + failed + " import failed";
    line.setText(summary);
    line.setProgress(100);
    this.plugin.closeProgressLater(state.win, progress, (failed || pdfFailed) ? 9000 : 5000);
    this.renderGraph(state, state.graphData);
  },



  resolvePaneItem(item) {
    if (!item) return null;
    if (!item.isRegularItem || item.isRegularItem()) return item;
    try {
      const parentID = item.parentItemID || item.getSource?.();
      if (parentID) {
        const parent = Zotero.Items.get(parentID);
        if (parent && (!parent.isRegularItem || parent.isRegularItem())) return parent;
      }
    } catch (_) {}
    return null;
  },

  paneCacheKey(item, mode) {
    return String(item?.libraryID || 0) + ":" + String(item?.key || item?.id || "") + ":" + mode;
  },

  registerItemPane(plugin) {
    // Intentionally disabled. AstroZotero test7.5 removes the right-side
    // Item Pane entirely and uses only the embedded Astro Map.
    this.plugin = plugin || this.plugin;
    this.itemPaneID = null;
  },

  renderPaneForItem(doc, body, item, setEnabled = null, setSectionSummary = null) {
    const subject = this.resolvePaneItem(item);
    try { setEnabled?.(Boolean(subject)); } catch (_) {}
    if (!body) return;
    if (!subject) {
      body.replaceChildren();
      try { setSectionSummary?.(""); } catch (_) {}
      return;
    }
    this.paneSubjects.set(body, { libraryID: Number(subject.libraryID), itemKey: String(subject.key || subject.id) });
    this.safeRenderItemPane({ doc, body, item: subject, setSectionSummary });
  },

  unregisterItemPane() {
    if (typeof this.itemPaneID === "string") {
      try { Zotero.ItemPaneManager?.unregisterSection?.(this.itemPaneID); } catch (_) {}
    }
    this.itemPaneID = null;
    this.paneCache.clear();
    this.paneRefreshCallbacks = new WeakMap();
    this.paneSubjects = new WeakMap();
  },

  safeRenderItemPane(props) {
    const { doc, body, item, setSectionSummary } = props || {};
    if (!body) return;
    try {
      this.renderItemPane({ doc: doc || body.ownerDocument, body, item, setSectionSummary });
    } catch (error) {
      this.log("Literature Item Pane render failed: " + (error?.stack || error));
      try {
        body.replaceChildren();
        const ownerDoc = doc || body.ownerDocument;
        const root = this.el(ownerDoc, "div", { class: "az-pane", "data-az-ready": "true" });
        root.appendChild(this.el(ownerDoc, "div", { class: "az-error" }, "AstroZotero panel error: " + (error?.message || String(error))));
        const retry = this.makeButton(ownerDoc, "Retry", () => this.safeRenderItemPane(props));
        root.appendChild(retry);
        body.appendChild(root);
      } catch (_) {}
    }
  },

  renderItemPane({ doc, body, item, setSectionSummary }) {
    const subject = this.resolvePaneItem(item);
    body.replaceChildren();
    if (!subject) return;
    const itemKey = this.paneCacheKey(subject, "subject");
    const root = this.el(doc, "div", { class: "az-pane", "data-az-ready": "true", "data-item-key": itemKey });
    root.appendChild(this.el(doc, "div", { class: "az-status" }, "No network request is made until you click Cited by, References, or Similar."));
    const tabs = this.el(doc, "div", { class: "az-tabs" });
    const content = this.el(doc, "div", { class: "az-list" });
    const modes = [
      ["cited", "Cited by", "Newest papers citing this work"],
      ["references", "References", "References cited by this work"],
      ["similar", "Similar", "Related literature from ADS/OpenAlex"]
    ];
    for (const [mode, label, hint] of modes) {
      const button = this.el(doc, "button", { type: "button", title: hint }, label);
      button.addEventListener("click", async () => {
        for (const other of tabs.querySelectorAll("button")) other.setAttribute("aria-selected", other === button ? "true" : "false");
        await this.loadItemPaneMode(doc, content, subject, mode, setSectionSummary, false);
      });
      tabs.appendChild(button);
    }
    root.append(tabs, content);
    body.appendChild(root);
    setSectionSummary?.("On demand");
  },

  async loadItemPaneMode(doc, content, item, mode, setSectionSummary, force = false) {
    content.replaceChildren();
    const key = this.paneCacheKey(item, mode);
    if (!force && this.paneCache.has(key)) {
      await this.renderItemPaneList(doc, content, item, mode, this.paneCache.get(key), setSectionSummary, true);
      return;
    }
    content.appendChild(this.el(doc, "div", { class: "az-status" }, "Loading " + this.modeLabel(mode) + "…"));
    try {
      const data = await this.queryPaneMode(item, mode);
      this.paneCache.set(key, data);
      await this.renderItemPaneList(doc, content, item, mode, data, setSectionSummary, false);
    } catch (error) {
      content.replaceChildren(this.el(doc, "div", { class: "az-error" }, error?.message || String(error)));
    }
  },

  async queryPaneMode(item, mode) {
    const apiKey = this.plugin?.getApiKey?.() || "";
    let seed = null;
    let adsError = null;
    if (apiKey) {
      try {
        seed = await this.plugin.findAdsRecord(item, apiKey, this.adsFields());
      } catch (error) {
        adsError = error;
        if (!this.shouldFallbackFromADS(error) || !this.pref("openAlexFallback", true)) throw error;
      }
    }
    if (seed?.bibcode) {
      try {
        const query = this.operator(mode) + '(bibcode:"' + this.plugin.escapeQueryValue(seed.bibcode) + '")';
        const sort = mode === "cited" ? "date desc" : (mode === "references" ? "citation_count desc" : null);
        const result = await this.plugin.adsSearchMany(apiKey, query, this.adsFields(), 30, sort);
        return { source: "NASA ADS", reported: result.numFound, docs: result.docs.map(raw => this.normalizeRecord(raw)) };
      } catch (error) {
        adsError = error;
        if (!this.shouldFallbackFromADS(error) || !this.pref("openAlexFallback", true)) throw error;
      }
    }
    if (!this.pref("openAlexFallback", true)) throw adsError || new Error("NASA ADS did not return this paper.");
    const oaSeed = await this.resolveOpenAlexSeed(null, seed || item);
    if (!oaSeed) throw adsError || new Error("No NASA ADS/OpenAlex record found for this paper.");
    if (!this.openAlexSupportsMode(mode)) throw adsError || new Error(this.modeLabel(mode) + " is unavailable without NASA ADS.");
    const docs = await this.openAlexModeResults(oaSeed, mode, 30);
    return { source: "OpenAlex fallback", reported: docs.length, docs };
  },

  async renderItemPaneList(doc, content, item, mode, data, setSectionSummary, cached) {
    content.replaceChildren();
    const header = this.el(doc, "div", { class: "az-status" },
      (data.reported ?? data.docs.length) + " found · " + data.source + (cached ? " · cached" : "") + " · showing up to 30");
    content.appendChild(header);
    setSectionSummary?.((data.reported ?? data.docs.length) + " " + this.modeLabel(mode));
    if (!data.docs.length) {
      content.appendChild(this.el(doc, "div", { class: "az-empty" }, "No records returned."));
      return;
    }
    const fakeState = { win: Zotero.getMainWindow?.() || Zotero.getMainWindows?.()?.[0], seedItem: item };
    const nodes = data.docs.map(record => this.nodeFromRecord(record, false));
    try { await this.attachLocalItems(fakeState, nodes); } catch (_) {}
    for (const node of nodes.slice(0, 30)) {
      const card = this.el(doc, "div", { class: "az-card" });
      card.appendChild(this.el(doc, "div", { class: "az-card-title" }, node.title));
      const meta = [this.formatAuthors(node.authors), node.pub, node.year, node.citationCount + " citations"].filter(Boolean).join(" · ");
      card.appendChild(this.el(doc, "div", { class: "az-card-meta" }, meta));
      const actions = this.el(doc, "div", { class: "az-card-actions" });
      if (node.localItemID) {
        const show = this.makeButton(doc, "Show in Zotero", () => {
          const win = Zotero.getMainWindow?.() || Zotero.getMainWindows?.()?.[0];
          this.revealItemInZotero(win, node.localItemID, node.localLibraryID, node.localCollectionIDs);
        });
        actions.appendChild(show);
      } else {
        const add = this.makeButton(doc, "Add to Zotero", async () => {
          add.disabled = true;
          const win = Zotero.getMainWindow?.() || Zotero.getMainWindows?.()?.[0];
          const fakeState = { win, doc, seedItem: item, graphData: null, details: null, batchSelection: new Set() };
          try {
            await this.addNodeToZotero(fakeState, node);
            add.textContent = "Added";
          } finally {
            if (!node.localItemID) add.disabled = false;
          }
        });
        actions.appendChild(add);
      }
      if (node.source === "openalex") {
        const wid = node.openAlexID || String(node.bibcode || "").replace(/^OA:/, "");
        actions.appendChild(this.makeButton(doc, "Open OpenAlex", () => Zotero.launchURL("https://openalex.org/" + wid)));
      } else {
        actions.appendChild(this.makeButton(doc, "Open ADS", () => Zotero.launchURL("https://ui.adsabs.harvard.edu/abs/" + encodeURIComponent(node.bibcode) + "/abstract")));
      }
      card.appendChild(actions);
      content.appendChild(card);
    }
    const refresh = this.makeButton(doc, "Refresh", async () => {
      this.paneCache.delete(this.paneCacheKey(item, mode));
      await this.loadItemPaneMode(doc, content, item, mode, setSectionSummary, true);
    });
    refresh.style.marginTop = "6px";
    content.appendChild(refresh);
  },

  formatAuthors(authors) {
    if (!authors?.length) return "";
    if (authors.length <= 3) return authors.join(", ");
    return authors.slice(0, 3).join(", ") + " et al.";
  },

  clearSVG(state) {
    const svg = state.svg;
    while (svg?.firstChild) svg.removeChild(svg.firstChild);
    state.viewport = null;
    state.labelElements = new Map();
    state.nodeElements = new Map();
    state.edgeElements = [];
    state.lodVisibleIDs = new Set();
    state.qualityMetrics = null;
    if (state.details) state.details.style.display = "none";
  },

  installPanZoom(state) {
    const svg = state.svg;
    let dragging = false, lastX = 0, lastY = 0;
    svg.addEventListener("wheel", event => {
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.12 : 0.89;
      const oldZoom = state.zoom;
      const newZoom = Math.max(0.35, Math.min(3.2, oldZoom * factor));
      if (Math.abs(newZoom - oldZoom) < 1e-6) return;
      let px = 550, py = 270;
      try {
        const point = svg.createSVGPoint();
        point.x = event.clientX; point.y = event.clientY;
        const local = point.matrixTransform(svg.getScreenCTM().inverse());
        px = local.x; py = local.y;
      } catch (_) {}
      const oldVisualScale = this.visualZoomScale(oldZoom);
      const newVisualScale = this.visualZoomScale(newZoom);
      const graphX = (px - state.panX) / oldVisualScale;
      const graphY = (py - state.panY) / oldVisualScale;
      state.zoom = newZoom;
      state.panX = px - graphX * newVisualScale;
      state.panY = py - graphY * newVisualScale;
      this.applyViewTransform(state);
    }, { passive: false });
    svg.addEventListener("mousedown", event => {
      if (event.button !== 0 || event.target.closest?.("g[tabindex]")) return;
      dragging = true; lastX = event.clientX; lastY = event.clientY; svg.style.cursor = "grabbing";
    });
    state.win.addEventListener("mousemove", event => {
      if (!dragging) return;
      const rect = svg.getBoundingClientRect();
      const sx = 1100 / Math.max(1, rect.width), sy = 540 / Math.max(1, rect.height);
      state.panX += (event.clientX - lastX) * sx;
      state.panY += (event.clientY - lastY) * sy;
      lastX = event.clientX; lastY = event.clientY;
      this.applyViewTransform(state);
    });
    state.win.addEventListener("mouseup", () => { dragging = false; svg.style.cursor = "grab"; });
    svg.addEventListener("click", event => {
      if (event.target === svg) {
        state.details.style.display = "none";
        state.selectedBibcode = null;
        this.applyViewTransform(state);
      }
    });
  },

  updateNodeScreenScale(state) {
    const visualScale = this.visualZoomScale(state.zoom);
    // Keep node glyphs and labels approximately constant in screen space.
    // Position spacing uses compressed geometric zoom, while LOD continues
    // to use the raw zoom value to reveal more papers.
    const localScale = 1 / visualScale;
    for (const entry of state.nodeElements?.values?.() || []) {
      const node = entry.node;
      entry.group.setAttribute(
        "transform",
        "translate(" + node.x.toFixed(1) + "," + node.y.toFixed(1) + ") scale(" + localScale.toFixed(4) + ")"
      );
    }
  },

  applyViewTransform(state) {
    if (!state.viewport) return;
    const visualScale = this.visualZoomScale(state.zoom);
    state.viewport.setAttribute("transform", "translate(" + state.panX.toFixed(1) + " " + state.panY.toFixed(1) + ") scale(" + visualScale.toFixed(3) + ")");
    this.updateNodeScreenScale(state);
    this.updateLODVisibility(state);
    this.updateLabelVisibility(state);
  }
};
