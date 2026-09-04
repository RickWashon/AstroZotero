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
    // Zotero 9 builds the virtualized item tree and its toolbar asynchronously.
    // Wait for both elements instead of using the obsolete
    // #zotero-tb-advanced-search anchor used by older Style builds.
    while (tries < 200) {
      mainNode = doc.getElementById("item-tree-main-default");
      toolbar = doc.getElementById("zotero-items-toolbar");
      if (mainNode && toolbar) break;
      await Zotero.Promise.delay(100);
      tries++;
    }
    if (!mainNode || !toolbar) {
      this.log("Library item tree/toolbar not available after waiting; embedded map not installed.");
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
      targetContext: null
    };
    this.states.set(win, state);

    this.createContainer(state, mainNode);
    this.createToolbarButton(state, toolbar);
    this.installToolsFallback(win, state);

    if (this.pref("mapEnabled", false)) {
      state.container.style.display = "flex";
      await this.loadFromCurrentSelection(state, false);
    }
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

    const reload = this.makeButton(doc, "Load", async () => this.loadMap(state, true));
    const useSelection = this.makeButton(doc, "Use selected item", async () => this.loadFromCurrentSelection(state, true));
    const resetView = this.makeButton(doc, "Reset view", () => {
      state.zoom = 1; state.panX = 0; state.panY = 0; this.applyViewTransform(state);
    });
    const selectNew = this.makeButton(doc, "Select all new", () => this.selectAllNew(state));
    const addSelected = this.makeButton(doc, "Add selected (0)", async () => this.batchAddSelected(state));
    addSelected.disabled = true;
    state.batchSelectButton = selectNew;
    state.batchAddButton = addSelected;
    header.append(reload, useSelection, resetView, selectNew, addSelected);

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
      this.setPref("mapEnabled", false);
      return;
    }
    state.container.style.display = "flex";
    this.setPref("mapEnabled", true);
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
          const result = await this.plugin.adsSearchMany(apiKey,
            'bibcode:"' + this.plugin.escapeQueryValue(state.seedRecord.bibcode) + '"',
            this.adsFields(), 1);
          seed = result.docs[0] || state.seedRecord;
        } else if (state.seedItem) {
          seed = await this.plugin.findAdsRecord(state.seedItem, apiKey, this.adsFields());
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
      if (!force && state.cache.has(cacheKey)) {
        const cached = state.cache.get(cacheKey);
        state.graphData = cached;
        state.batchSelection.clear();
        if (state.batchSelectButton) state.batchSelectButton.textContent = "Select all new";
        this.updateBatchControls(state);
        this.renderGraph(state, cached);
        this.setStatus(state, cached.nodes.length + " papers · cached", false);
        return;
      }

      const merged = new Map();
      const seedNode = this.nodeFromRecord(seed, true);
      merged.set(this.recordIdentityKey(seed), seedNode);
      const modeList = [...state.selectedModes];
      const perMode = modeList.length >= 5 ? 12 : 18;
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
            const result = await this.plugin.adsSearchMany(apiKey, query, this.adsFields(), perMode, sort);
            papers = result.docs.map(raw => this.normalizeRecord(raw));
          } catch (error) {
            if (!this.pref("openAlexFallback", true) || !this.shouldFallbackFromADS(error)) throw error;
            this.log("ADS " + mode + " failed, trying OpenAlex: " + (error?.message || error));
            if (!openAlexSeed) {
              try { openAlexSeed = await this.resolveOpenAlexSeed(state, seed); }
              catch (oaError) { this.log("OpenAlex seed fallback failed: " + (oaError?.message || oaError)); }
            }
            if (openAlexSeed && this.openAlexSupportsMode(mode)) {
              this.setStatus(state, "OpenAlex fallback: " + this.modeLabel(mode) + "…", false);
              papers = await this.openAlexModeResults(openAlexSeed, mode, perMode);
              usedOpenAlex = true;
            } else {
              fallbackNotes.push(this.modeLabel(mode) + " unavailable without ADS");
              continue;
            }
          }
        } else {
          openAlexSeed = seed;
          if (this.openAlexSupportsMode(mode)) {
            papers = await this.openAlexModeResults(openAlexSeed, mode, perMode);
            usedOpenAlex = true;
          } else {
            fallbackNotes.push(this.modeLabel(mode) + " unavailable without ADS");
            continue;
          }
        }

        for (const paper of papers) {
          if (!paper?.bibcode) continue;
          if (this.recordIdentityKey(paper) === this.recordIdentityKey(seed)) continue;
          this.mergePaper(merged, paper, mode);
        }
        if (usedOpenAlex) fallbackNotes.push(this.modeLabel(mode) + " via OpenAlex");
      }

      if (generation !== state.loadGeneration) return;
      const nodes = [...merged.values()];
      await this.attachLocalItems(state, nodes);
      const graph = { seedBibcode: seed.bibcode, nodes, edges: this.buildEdges(nodes, seed.bibcode) };
      state.cache.set(cacheKey, graph);
      state.graphData = graph;
      state.batchSelection.clear();
      if (state.batchSelectButton) state.batchSelectButton.textContent = "Select all new";
      this.updateBatchControls(state);
      this.renderGraph(state, graph);
      const suffix = fallbackNotes.length ? " · " + [...new Set(fallbackNotes)].join("; ") : "";
      this.setStatus(state, nodes.length + " papers · " + graph.edges.length + " links" + suffix, false);
    } catch (error) {
      this.log(error?.stack || String(error));
      this.setStatus(state, error?.message || String(error), true);
      this.clearSVG(state);
    }
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
    return {
      bibcode: "OA:" + wid,
      openAlexID: wid,
      source: "openalex",
      title: raw?.display_name || raw?.title || wid,
      authors: (raw?.authorships || []).map(a => a?.author?.display_name).filter(Boolean),
      year: raw?.publication_year || "",
      pub: raw?.primary_location?.source?.display_name || "",
      doi: String(raw?.doi || raw?.ids?.doi || "").replace(/^https?:\/\/doi\.org\//i, "") || null,
      identifiers,
      abstract: this.reconstructOpenAlexAbstract(raw?.abstract_inverted_index),
      citationCount: Number(raw?.cited_by_count || 0),
      references: (raw?.referenced_works || []).map(id => "OA:" + this.openAlexID(id)).filter(id => !id.endsWith("null")),
      property: raw?.open_access?.is_oa ? ["OPENACCESS"] : [],
      relatedOpenAlex: (raw?.related_works || []).map(id => this.openAlexID(id)).filter(Boolean)
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

  recordIdentityKey(record) {
    if (record?.doi) return "doi:" + String(record.doi).trim().toLowerCase();
    const arxiv = this.nodeArxivID(record);
    if (arxiv) return "arxiv:" + String(arxiv).toLowerCase();
    return "title:" + this.normalizeTitle(record?.title) + "|" + String(record?.year || "");
  },

  mergePaper(merged, paper, mode) {
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
    }
    node.modes.add(mode);
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
    return {
      bibcode: raw.bibcode,
      title: title || raw.bibcode || "Untitled",
      authors: Array.isArray(raw.author) ? raw.author : [],
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
      relatedOpenAlex: []
    };
  },

  nodeFromRecord(record, seed) {
    return {
      id: record.bibcode,
      bibcode: record.bibcode,
      title: record.title,
      authors: record.authors,
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
      modes: new Set(seed ? ["seed"] : []),
      seed: Boolean(seed),
      localItemID: null,
      x: 550,
      y: 270,
      vx: 0,
      vy: 0
    };
  },

  displayLabel(node) {
    const first = node.authors?.[0] || "";
    let surname = first.includes(",") ? first.split(",")[0].trim() : first.trim().split(/\s+/).slice(-1)[0];
    if (!surname) surname = (node.title || "Paper").split(/\s+/).slice(0, 2).join(" ");
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
        for (const mode of node.modes) if (mode !== "seed") add(seedBibcode, node.bibcode, "discovery", mode);
      }
      for (const ref of node.references || []) if (ids.has(ref)) add(node.bibcode, ref, "citation", null);
    }
    return [...edgeMap.values()];
  },

  layoutGraph(graph) {
    const W = 1100, H = 540, cx = W / 2, cy = H / 2;
    const nodes = graph.nodes;
    const nodeMap = new Map(nodes.map(n => [n.bibcode, n]));
    const sectors = { cited: -1.2, references: 1.95, similar: -0.15, reviews: 0.65, useful: 2.75, trending: -2.55, seed: 0 };
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.seed) { n.x = cx; n.y = cy; n.vx = n.vy = 0; continue; }
      const mode = [...n.modes][0] || "similar";
      const base = sectors[mode] ?? (i * 2.399);
      const jitter = this.hash01(n.bibcode) * 0.9 - 0.45;
      const radius = 135 + 160 * this.hash01(n.bibcode + "r");
      n.x = cx + Math.cos(base + jitter) * radius;
      n.y = cy + Math.sin(base + jitter) * radius * 0.78;
      n.vx = 0; n.vy = 0;
    }

    const edges = graph.edges.map(e => ({ ...e, a: nodeMap.get(e.source), b: nodeMap.get(e.target) })).filter(e => e.a && e.b);
    for (let iter = 0; iter < 180; iter++) {
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          let dx = b.x - a.x, dy = b.y - a.y;
          let d2 = dx * dx + dy * dy + 0.5;
          const d = Math.sqrt(d2);
          const force = Math.min(2.4, 1250 / d2);
          dx /= d; dy /= d;
          if (!a.seed) { a.vx -= dx * force; a.vy -= dy * force; }
          if (!b.seed) { b.vx += dx * force; b.vy += dy * force; }
        }
      }
      for (const e of edges) {
        const a = e.a, b = e.b;
        let dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        const target = e.kind === "citation" ? 92 : 165;
        const strength = e.kind === "citation" ? 0.012 : 0.0045;
        const f = (d - target) * strength;
        dx /= d; dy /= d;
        if (!a.seed) { a.vx += dx * f; a.vy += dy * f; }
        if (!b.seed) { b.vx -= dx * f; b.vy -= dy * f; }
      }
      for (const n of nodes) {
        if (n.seed) continue;
        n.vx += (cx - n.x) * 0.0009;
        n.vy += (cy - n.y) * 0.0012;
        n.vx *= 0.84; n.vy *= 0.84;
        n.x += n.vx; n.y += n.vy;
        n.x = Math.max(35, Math.min(W - 35, n.x));
        n.y = Math.max(35, Math.min(H - 35, n.y));
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
    return Math.max(4, Math.min(10, 4 + Math.log10((node.citationCount || 0) + 1) * 1.9));
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
        "stroke-opacity": citation ? "0.34" : "0.18"
      });
      if (citation) line.setAttribute("marker-end", "url(#az-arrow)");
      edgeLayer.appendChild(line);
    }

    const ranked = [...graph.nodes].sort((a, b) => (b.citationCount || 0) - (a.citationCount || 0));
    const labelIDs = new Set(ranked.slice(0, Math.min(18, ranked.length)).map(n => n.bibcode));
    for (const n of graph.nodes) if (n.seed || n.localItemID) labelIDs.add(n.bibcode);

    for (const node of graph.nodes) {
      const g = this.svgEl(doc, "g", { transform: "translate(" + node.x.toFixed(1) + "," + node.y.toFixed(1) + ")", tabindex: "0" });
      g.style.cursor = "pointer";
      const color = this.nodeColor(node);
      const circle = this.svgEl(doc, "circle", {
        r: this.nodeRadius(node).toFixed(1),
        fill: node.seed || node.localItemID ? color : "Canvas",
        "fill-opacity": node.seed ? "1" : (node.localItemID ? "0.9" : "1"),
        stroke: node.seed ? "#111" : color,
        "stroke-width": node.seed ? "3.2" : (node.localItemID ? "1.6" : "2.3")
      });
      g.appendChild(circle);

      // A paper can belong to more than one ADS relation. Keep the main circle
      // for the primary relation and show additional relation colours as tiny
      // satellites around it, without reusing colour for Zotero membership.
      const extraModes = [...(node.modes || [])].filter(mode => mode !== "seed" && mode !== this.primaryMode(node));
      const baseR = this.nodeRadius(node) + 3.2;
      extraModes.forEach((mode, index) => {
        const angle = -Math.PI / 2 + index * (Math.PI * 2 / Math.max(1, extraModes.length));
        g.appendChild(this.svgEl(doc, "circle", {
          cx: (Math.cos(angle) * baseR).toFixed(1),
          cy: (Math.sin(angle) * baseR).toFixed(1),
          r: "1.9",
          fill: this.modeColor(mode),
          stroke: "Canvas",
          "stroke-width": "0.7"
        }));
      });
      const title = this.svgEl(doc, "title");
      title.textContent = node.title + "\n" + this.displayLabel(node) + " · " + node.citationCount + " citations" + (node.localItemID ? " · In Zotero" : " · Not in Zotero");
      g.appendChild(title);
      if (labelIDs.has(node.bibcode)) {
        const label = this.svgEl(doc, "text", {
          x: (this.nodeRadius(node) + 5).toFixed(1), y: "4",
          "font-size": node.seed ? "14" : "11.5",
          "font-family": "system-ui, sans-serif",
          fill: "CanvasText",
          "paint-order": "stroke",
          stroke: "Canvas",
          "stroke-width": "3",
          "stroke-linejoin": "round"
        });
        label.textContent = this.displayLabel(node);
        g.appendChild(label);
      }
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
    this.applyViewTransform(state);
  },

  selectNode(state, node) {
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
      const graphX = (px - state.panX) / oldZoom;
      const graphY = (py - state.panY) / oldZoom;
      state.zoom = newZoom;
      state.panX = px - graphX * newZoom;
      state.panY = py - graphY * newZoom;
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
      if (event.target === svg) state.details.style.display = "none";
    });
  },

  applyViewTransform(state) {
    if (!state.viewport) return;
    state.viewport.setAttribute("transform", "translate(" + state.panX.toFixed(1) + " " + state.panY.toFixed(1) + ") scale(" + state.zoom.toFixed(3) + ")");
  }
};
