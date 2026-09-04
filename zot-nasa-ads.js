var ZotNasaAds = {
  id: null,
  version: null,
  rootURI: null,
  prefs: {
    apiKey: "extensions.zotnasaads.apikey",
    skipExistingPDF: "extensions.zotnasaads.skipExistingPDF",
    preferOpenAccess: "extensions.zotnasaads.preferOpenAccess",
    overwriteCoreMetadata: "extensions.zotnasaads.overwriteCoreMetadata"
  },
  ADS_TIMEOUT_MS: 12000,
  menuIDs: [
    "zot-nasa-ads-separator",
    "zot-nasa-ads-enrich-metadata",
    "zot-nasa-ads-download-pdf",
    "zot-nasa-ads-download-published-pdf",
    "zot-nasa-ads-tools-token"
  ],
  popupHandlers: new WeakMap(),
  registeredMenuIDs: [],
  menuManagerRegistered: false,
  itemPaneID: null,
  itemPaneTimer: null,
  paneStates: new WeakMap(),
  paneCache: new Map(),
  paneRefreshCallbacks: new Map(),
  paneSubjects: new Map(),
  PANE_CACHE_MS: 10 * 60 * 1000,

  init({ id, version, rootURI }) {
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;
  },

  log(message) {
    Zotero.debug("AstroZotero: " + message);
  },

  getPref(key) {
    return Zotero.Prefs.get(this.prefs[key], true);
  },

  addToAllWindows() {
    const windows = Zotero.getMainWindows ? Zotero.getMainWindows() : [];
    for (const win of windows) this.addToWindow(win);
  },

  removeFromAllWindows() {
    const windows = Zotero.getMainWindows ? Zotero.getMainWindows() : [];
    for (const win of windows) this.removeFromWindow(win);
  },

  registerMenus() {
    if (this.menuManagerRegistered) return;
    if (!Zotero.MenuManager?.registerMenu) return;

    const regularItems = context => {
      const items = Array.isArray(context?.items) ? context.items : [];
      return items.filter(item => item && (!item.isRegularItem || item.isRegularItem()));
    };
    const menuWindow = event =>
      event?.target?.ownerGlobal ||
      event?.currentTarget?.ownerGlobal ||
      Zotero.getMainWindow?.() ||
      Zotero.getMainWindows?.()?.[0] ||
      null;
    const setLabel = (context, label) => {
      try { context?.menuElem?.setAttribute?.('label', label); } catch (_) {}
    };

    try {
      const itemMenuID = Zotero.MenuManager.registerMenu({
        menuID: 'astrozotero-item-menu',
        pluginID: this.id,
        target: 'main/library/item',
        menus: [
          {
            menuType: 'submenu',
            onShowing: (_event, context) => {
              setLabel(context, 'AstroZotero');
              context.setVisible(regularItems(context).length > 0);
            },
            menus: [
              {
                menuType: 'menuitem',
                onShowing: (_event, context) => {
                  setLabel(context, 'Enrich Metadata from NASA ADS');
                  context.setVisible(regularItems(context).length > 0);
                },
                onCommand: (event, _context) => {
                  const win = menuWindow(event);
                  if (!win) return;
                  this.updateSelectedMetadata(win).catch(error =>
                    this.showToast(win, 'NASA ADS', 'Metadata error: ' + (error?.message || error), true)
                  );
                }
              },
              {
                menuType: 'menuitem',
                onShowing: (_event, context) => {
                  setLabel(context, 'Download Best PDF');
                  context.setVisible(regularItems(context).length > 0);
                },
                onCommand: (event, _context) => {
                  const win = menuWindow(event);
                  if (!win) return;
                  this.downloadSelectedPDFs(win).catch(error =>
                    this.showToast(win, 'NASA ADS', 'PDF error: ' + (error?.message || error), true)
                  );
                }
              },
              {
                menuType: 'menuitem',
                onShowing: (_event, context) => {
                  setLabel(context, 'Download Latest Published PDF');
                  context.setVisible(regularItems(context).length === 1);
                },
                onCommand: (event, _context) => {
                  const win = menuWindow(event);
                  if (!win) return;
                  this.downloadLatestPublishedPDF(win).catch(error =>
                    this.showToast(win, 'NASA ADS', 'Published PDF error: ' + (error?.message || error), true)
                  );
                }
              }
            ]
          }
        ]
      });
      if (itemMenuID) this.registeredMenuIDs.push(itemMenuID);

      const toolsMenuID = Zotero.MenuManager.registerMenu({
        menuID: 'astrozotero-tools-menu',
        pluginID: this.id,
        target: 'main/menubar/tools',
        menus: [
          {
            menuType: 'menuitem',
            onShowing: (_event, context) => setLabel(context, 'AstroZotero: Set NASA ADS API Token...'),
            onCommand: (event, _context) => {
              const win = menuWindow(event);
              if (win) this.promptForApiKey(win);
            }
          }
        ]
      });
      if (toolsMenuID) this.registeredMenuIDs.push(toolsMenuID);
      this.menuManagerRegistered = true;
      this.log('Registered menus with Zotero.MenuManager.');
    } catch (error) {
      this.log('MenuManager registration failed: ' + (error?.stack || error));
      this.unregisterMenus();
    }
  },

  unregisterMenus() {
    if (Zotero.MenuManager?.unregisterMenu) {
      for (const id of this.registeredMenuIDs.splice(0)) {
        try { Zotero.MenuManager.unregisterMenu(id); } catch (_) {}
      }
    } else {
      this.registeredMenuIDs.length = 0;
    }
    this.menuManagerRegistered = false;
  },

  addToWindow(win) {
    const doc = win.document;
    if (!doc) return;
    if (!doc.getElementById('astrozotero-main-stylesheet')) {
      try {
        const link = doc.createElementNS('http://www.w3.org/1999/xhtml', 'link');
        link.id = 'astrozotero-main-stylesheet';
        link.setAttribute('rel', 'stylesheet');
        link.setAttribute('href', 'chrome://astrozotero/content/zoteroPane.css');
        doc.documentElement.appendChild(link);
      } catch (error) {
        this.log('Stylesheet install failed: ' + (error?.stack || error));
      }
    }

    // Zotero 8+ has an official MenuManager API. Do not touch the native
    // item context-menu DOM there; direct popup injection can break the whole
    // menu when Zotero or another plugin rebuilds it.
    if (Zotero.MenuManager?.registerMenu) return;

    // Legacy Zotero 7 fallback only.
    if (doc.getElementById('zot-nasa-ads-enrich-metadata')) return;
    const itemMenu = doc.getElementById('zotero-itemmenu');
    if (itemMenu) {
      const metadataItem = doc.createXULElement('menuitem');
      metadataItem.id = 'zot-nasa-ads-enrich-metadata';
      metadataItem.setAttribute('label', 'NASA ADS: Enrich Metadata');
      metadataItem.addEventListener('command', () => {
        this.updateSelectedMetadata(win).catch(error => this.showToast(win, 'NASA ADS', 'Metadata error: ' + (error?.message || error), true));
      });
      itemMenu.appendChild(metadataItem);

      const pdfItem = doc.createXULElement('menuitem');
      pdfItem.id = 'zot-nasa-ads-download-pdf';
      pdfItem.setAttribute('label', 'NASA ADS: Download Best PDF');
      pdfItem.addEventListener('command', () => {
        this.downloadSelectedPDFs(win).catch(error => this.showToast(win, 'NASA ADS', 'PDF error: ' + (error?.message || error), true));
      });
      itemMenu.appendChild(pdfItem);

      const publishedPdfItem = doc.createXULElement('menuitem');
      publishedPdfItem.id = 'zot-nasa-ads-download-published-pdf';
      publishedPdfItem.setAttribute('label', 'NASA ADS: Download Latest Published PDF');
      publishedPdfItem.addEventListener('command', () => {
        this.downloadLatestPublishedPDF(win).catch(error => this.showToast(win, 'NASA ADS', 'Published PDF error: ' + (error?.message || error), true));
      });
      itemMenu.appendChild(publishedPdfItem);

      const handler = () => {
        try {
          const items = this.getSelectedRegularItems(win);
          metadataItem.hidden = items.length === 0;
          pdfItem.hidden = items.length === 0;
          publishedPdfItem.hidden = items.length !== 1;
        } catch (error) {
          this.log('Legacy item-menu update failed: ' + (error?.stack || error));
        }
      };
      itemMenu.addEventListener('popupshowing', handler);
      this.popupHandlers.set(win, { itemMenu, handler });
    }
  },

  removeFromWindow(win) {
    const doc = win.document;
    const stored = this.popupHandlers.get(win);
    if (stored) {
      try { stored.itemMenu.removeEventListener('popupshowing', stored.handler); } catch (_) {}
      this.popupHandlers.delete(win);
    }
    if (!doc) return;
    for (const id of this.menuIDs) {
      try { doc.getElementById(id)?.remove(); } catch (_) {}
    }
    try { doc.getElementById('astrozotero-main-stylesheet')?.remove(); } catch (_) {}
  },

  getSelectedRegularItems(win) {
    const pane = win.ZoteroPane || Zotero.getActiveZoteroPane?.();
    const items = pane?.getSelectedItems?.() || [];
    return items.filter(item => item && (!item.isRegularItem || item.isRegularItem()));
  },

  getApiKey() {
    return (this.getPref("apiKey") || "").trim();
  },

  promptForApiKey(win) {
    const input = { value: this.getApiKey() };
    const ok = Services.prompt.prompt(
      win,
      "NASA ADS API Token",
      "Paste or replace your NASA ADS API token. You can also edit it later in Zotero Settings > AstroZotero.",
      input,
      null,
      {}
    );
    if (!ok) return false;
    const token = input.value.trim();
    Zotero.Prefs.set(this.prefs.apiKey, token, true);
    this.showToast(win, "NASA ADS", token ? "API token saved." : "API token cleared.");
    return Boolean(token);
  },

  ensureApiKey(win) {
    let token = this.getApiKey();
    if (!token) {
      this.promptForApiKey(win);
      token = this.getApiKey();
    }
    return token;
  },

  closeProgressLater(win, pw, closeMs = 5000) {
    // Zotero's ProgressWindow timer can be cancelled by mouse interaction in some builds.
    // Keep the native close timer, but also schedule a hard close so completed/error
    // notifications never remain pinned indefinitely.
    try { pw.startCloseTimer(closeMs); } catch (_) {}
    try {
      win.setTimeout(() => {
        try { pw.close(); } catch (_) {}
      }, closeMs + 250);
    } catch (_) {}
  },

  showToast(win, headline, text, isError = false, closeMs = 4500) {
    const pw = new Zotero.ProgressWindow({ window: win, closeOnClick: true });
    pw.changeHeadline(headline);
    pw.show();
    const line = new pw.ItemProgress(null, text);
    line.setProgress(100);
    if (isError) line.setText("Error: " + text.replace(/^Error:\s*/i, ""));
    this.closeProgressLater(win, pw, closeMs);
    return pw;
  },

  createProgress(win, headline) {
    // Allow an in-progress notification to be dismissed manually. Closing the
    // notification does not cancel the background ADS/PDF operation.
    const pw = new Zotero.ProgressWindow({ window: win, closeOnClick: true });
    pw.changeHeadline(headline);
    pw.show();
    return pw;
  },

  shortTitle(item) {
    const title = item.getField("title") || "Untitled";
    return title.length > 78 ? title.slice(0, 75) + "..." : title;
  },

  escapeQueryValue(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/\"/g, "\\\"");
  },

  extractBibcode(item) {
    const extra = item.getField("extra") || "";
    const match = extra.match(/^ADS Bibcode:\s*(\S+)\s*$/mi);
    return match ? match[1] : null;
  },

  extractArxivID(item) {
    const candidates = [];
    const archiveID = item.getField("archiveID") || "";
    if (archiveID) candidates.push(archiveID);
    const url = item.getField("url") || "";
    if (url) candidates.push(url);
    const extra = item.getField("extra") || "";
    if (extra) candidates.push(extra);

    const patterns = [
      /arXiv:\s*([0-9]{4}\.[0-9]{4,5}(?:v\d+)?)/i,
      /arxiv\.org\/(?:abs|pdf)\/([0-9]{4}\.[0-9]{4,5}(?:v\d+)?)/i,
      /tex\.eprint:\s*([0-9]{4}\.[0-9]{4,5}(?:v\d+)?)/i,
      /arXiv:\s*([a-z\-]+\/[0-9]{7}(?:v\d+)?)/i,
      /arxiv\.org\/(?:abs|pdf)\/([a-z\-]+\/[0-9]{7}(?:v\d+)?)/i
    ];
    for (const candidate of candidates) {
      for (const pattern of patterns) {
        const match = candidate.match(pattern);
        if (match) return match[1].replace(/\.pdf$/i, "");
      }
    }
    return null;
  },

  arxivFromAdsData(adsData) {
    const identifier = (adsData?.identifier || []).find(id => /^arXiv:/i.test(id));
    return identifier ? identifier.replace(/^arXiv:/i, "").replace(/\.pdf$/i, "") : null;
  },

  async adsRequest(method, url, apiKey) {
    return await Zotero.HTTP.request(method, url, {
      headers: { Authorization: "Bearer " + apiKey },
      timeout: this.ADS_TIMEOUT_MS,
      errorDelayMax: 0,
      successCodes: false
    });
  },

  async adsSearchMany(apiKey, query, fields, rows = 20, sort = null) {
    let url = "https://api.adsabs.harvard.edu/v1/search/query?q=" +
      encodeURIComponent(query) +
      "&fl=" + encodeURIComponent(fields.join(",")) +
      "&rows=" + Math.max(1, Math.min(200, Number(rows) || 20));
    if (sort) url += "&sort=" + encodeURIComponent(sort);
    const response = await this.adsRequest("GET", url, apiKey);
    if (response.status !== 200) {
      if (response.status === 401 || response.status === 403) {
        throw new Error("NASA ADS rejected the API token (HTTP " + response.status + ").");
      }
      if (response.status === 429) {
        throw new Error("NASA ADS rate limit reached (HTTP 429). Please retry later.");
      }
      throw new Error("NASA ADS search failed (HTTP " + response.status + ").");
    }
    const data = JSON.parse(response.responseText);
    return {
      docs: Array.isArray(data?.response?.docs) ? data.response.docs : [],
      numFound: Number(data?.response?.numFound || 0)
    };
  },

  async adsSearch(apiKey, query, fields) {
    const result = await this.adsSearchMany(apiKey, query, fields, 1);
    return result.docs[0] || null;
  },

  async findAdsRecord(item, apiKey, fields, onStatus = null) {
    const bibcode = this.extractBibcode(item);
    if (bibcode) {
      onStatus?.("Querying ADS by Bibcode...");
      const record = await this.adsSearch(apiKey, "bibcode:\"" + this.escapeQueryValue(bibcode) + "\"", fields);
      if (record) return record;
    }

    const doi = (item.getField("DOI") || "").trim();
    if (doi) {
      onStatus?.("Querying ADS by DOI...");
      const record = await this.adsSearch(apiKey, "doi:\"" + this.escapeQueryValue(doi) + "\"", fields);
      if (record) return record;
    }

    const arxiv = this.extractArxivID(item);
    if (arxiv) {
      onStatus?.("Querying ADS by arXiv ID...");
      const record = await this.adsSearch(apiKey, "identifier:\"arXiv:" + this.escapeQueryValue(arxiv) + "\"", fields);
      if (record) return record;
    }

    const title = (item.getField("title") || "").trim();
    if (title) {
      onStatus?.("Querying ADS by title...");
      const creator = item.getCreators?.()?.[0];
      const year = String(item.getField("date") || "").match(/\b(19|20)\d{2}\b/)?.[0];
      let query = "title:\"" + this.escapeQueryValue(title) + "\"";
      if (creator?.lastName) query += " author:\"" + this.escapeQueryValue(creator.lastName) + "\"";
      if (year) query += " year:" + year;
      const record = await this.adsSearch(apiKey, query, fields);
      if (record) return record;
    }

    return null;
  },

  updateExtra(item, adsData) {
    const extra = item.getField("extra") || "";
    const removePrefixes = [
      "ADS Bibcode:", "tex.archivePrefix:", "tex.eprint:", "tex.primaryClass:",
      "tex.adsurl:", "tex.adsnote:"
    ];
    const lines = extra.split(/\r?\n/).filter(line =>
      !removePrefixes.some(prefix => line.trim().startsWith(prefix))
    );

    lines.push("ADS Bibcode: " + adsData.bibcode);
    const arxivID = this.arxivFromAdsData(adsData);
    if (arxivID) {
      lines.push("tex.archivePrefix: arXiv");
      lines.push("tex.eprint: " + arxivID);
      if (adsData.arxiv_class?.[0]) lines.push("tex.primaryClass: " + adsData.arxiv_class[0]);
    }
    lines.push("tex.adsurl: https://ui.adsabs.harvard.edu/abs/" + adsData.bibcode);
    lines.push("tex.adsnote: Provided by the SAO/NASA Astrophysics Data System");
    item.setField("extra", lines.filter(Boolean).join("\n"));
  },

  setFieldIfNeeded(item, field, value, overwrite) {
    if (value === undefined || value === null || value === "") return;
    if (overwrite || !item.getField(field)) item.setField(field, value);
  },

  async updateOneMetadata(item, apiKey, onStatus = null) {
    const fields = [
      "title", "author", "doi", "bibcode", "abstract", "bibstem", "volume",
      "issue", "page", "pub", "issn", "pubdate", "property", "identifier",
      "arxiv_class", "doctype"
    ];
    const adsData = await this.findAdsRecord(item, apiKey, fields, onStatus);
    if (!adsData) throw new Error("No ADS record found");

    const overwriteCore = Boolean(this.getPref("overwriteCoreMetadata"));
    const wasPreprint = item.itemTypeID === Zotero.ItemTypes.getID("preprint");
    const publishedArticle = adsData.doctype === "article";
    if (wasPreprint && publishedArticle) item.setType(Zotero.ItemTypes.getID("journalArticle"));

    onStatus?.("Applying ADS metadata...");

    if (overwriteCore) {
      if (adsData.title?.[0]) item.setField("title", adsData.title[0]);
      if (adsData.author?.length) {
        item.setCreators(adsData.author.map(name => {
          const comma = name.indexOf(",");
          if (comma < 0) return { lastName: name, firstName: "", creatorType: "author" };
          return {
            lastName: name.slice(0, comma).trim(),
            firstName: name.slice(comma + 1).trim(),
            creatorType: "author"
          };
        }));
      }
      if (adsData.abstract) item.setField("abstractNote", adsData.abstract);
    }

    const refreshPublication = overwriteCore || (wasPreprint && publishedArticle);
    this.setFieldIfNeeded(item, "publicationTitle", adsData.pub, refreshPublication);
    this.setFieldIfNeeded(item, "journalAbbreviation", adsData.bibstem?.[0], refreshPublication);
    this.setFieldIfNeeded(item, "volume", adsData.volume, refreshPublication);
    this.setFieldIfNeeded(item, "issue", adsData.issue, refreshPublication);
    this.setFieldIfNeeded(item, "pages", adsData.page?.[0], refreshPublication);

    if (adsData.pubdate) {
      let date = adsData.pubdate.replace(/-00$/, "").replace(/-00-00$/, "");
      this.setFieldIfNeeded(item, "date", date, refreshPublication);
    }
    this.setFieldIfNeeded(item, "ISSN", adsData.issn?.[0], refreshPublication);
    this.setFieldIfNeeded(item, "DOI", adsData.doi?.[0], refreshPublication);
    if (adsData.doi?.[0] && (refreshPublication || !item.getField("url"))) {
      item.setField("url", "https://doi.org/" + adsData.doi[0]);
    }

    this.updateExtra(item, adsData);
    await item.saveTx();
    return adsData;
  },

  async updateSelectedMetadata(win) {
    const apiKey = this.ensureApiKey(win);
    if (!apiKey) return;
    const items = this.getSelectedRegularItems(win);
    if (!items.length) {
      this.showToast(win, "NASA ADS", "Select at least one regular Zotero item.", true);
      return;
    }

    const pw = this.createProgress(win, "NASA ADS: Enrich Metadata");
    let success = 0;
    let failed = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const line = new pw.ItemProgress(null, this.shortTitle(item));
      line.setProgress(5);
      const started = Date.now();
      try {
        await this.updateOneMetadata(item, apiKey, status => {
          line.setText(this.shortTitle(item) + " — " + status);
          line.setProgress(35);
        });
        success++;
        line.setText(this.shortTitle(item) + " — enriched (" + ((Date.now() - started) / 1000).toFixed(1) + " s)");
        line.setProgress(100);
      } catch (error) {
        failed++;
        this.log(error?.stack || String(error));
        line.setText(this.shortTitle(item) + " — failed: " + (error?.message || error));
        line.setProgress(100);
      }
    }

    pw.addDescription("Done: " + success + " succeeded" + (failed ? ", " + failed + " failed" : "") + ".");
    this.closeProgressLater(win, pw, failed ? 10000 : 4500);
  },

  async hasPDFAttachment(item) {
    const ids = item.getAttachments ? item.getAttachments() : [];
    for (const id of ids) {
      const attachment = Zotero.Items.get(id);
      if (attachment && attachment.attachmentContentType === "application/pdf") return true;
    }
    return false;
  },

  getPdfPriority() {
    if (this.getPref("preferOpenAccess")) {
      return ["EPRINT_PDF", "ADS_PDF", "AUTHOR_PDF", "PUB_PDF", "ADS_SCAN"];
    }
    return ["PUB_PDF", "EPRINT_PDF", "AUTHOR_PDF", "ADS_PDF", "ADS_SCAN"];
  },

  async getPdfSources(item, apiKey, onStatus = null) {
    const fields = ["bibcode", "esources", "identifier", "doi", "title"];
    const adsData = await this.findAdsRecord(item, apiKey, fields, onStatus);
    if (!adsData) return null;
    const available = new Set((adsData.esources || []).map(value => String(value).toUpperCase()));
    const sources = this.getPdfPriority().filter(type => available.has(type));
    return { adsData, sources };
  },

  async resolvePdfURL(apiKey, adsData, sourceType, onStatus = null) {
    if (sourceType === "EPRINT_PDF") {
      const arxivID = this.arxivFromAdsData(adsData);
      if (arxivID) {
        onStatus?.("Using direct arXiv PDF URL...");
        return "https://arxiv.org/pdf/" + arxivID + ".pdf";
      }
    }

    onStatus?.("Resolving " + sourceType + " through ADS API...");
    const resolverURL = "https://api.adsabs.harvard.edu/v1/resolver/" +
      encodeURIComponent(adsData.bibcode) + "/" + encodeURIComponent(sourceType);
    const response = await this.adsRequest("GET", resolverURL, apiKey);
    if (response.status === 200) {
      const data = JSON.parse(response.responseText);
      const directURL = data.link || data.service || data?.links?.records?.[0]?.url;
      if (directURL && /^https?:\/\//i.test(directURL)) return directURL;
    }

    // Last resort: public ADS gateway. This is intentionally not the first path because
    // it adds another redirect layer and can be substantially slower.
    return "https://ui.adsabs.harvard.edu/link_gateway/" +
      encodeURIComponent(adsData.bibcode) + "/" + sourceType;
  },

  getGatewayPdfURL(adsData, sourceType) {
    return "https://ui.adsabs.harvard.edu/link_gateway/" +
      encodeURIComponent(adsData.bibcode) + "/" + encodeURIComponent(sourceType);
  },

  async importPdfFromURL(item, url, title = null) {
    const attachment = await Zotero.Attachments.importFromURL({
      libraryID: item.libraryID,
      parentItemID: item.id,
      url,
      contentType: "application/pdf",
      referrer: "https://ui.adsabs.harvard.edu/",
      ...(title ? { title } : {})
    });
    return attachment;
  },

  normalizeURL(url) {
    try {
      const parsed = new URL(String(url || ""));
      parsed.hash = "";
      return parsed.href.replace(/\/$/, "");
    } catch (_) {
      return String(url || "").trim().replace(/\/$/, "");
    }
  },

  async findExistingPdfByURL(item, url) {
    const target = this.normalizeURL(url);
    if (!target) return null;
    const ids = item.getAttachments ? item.getAttachments() : [];
    for (const id of ids) {
      const attachment = Zotero.Items.get(id);
      if (!attachment || attachment.attachmentContentType !== "application/pdf") continue;
      const existingURL = this.normalizeURL(attachment.getField?.("url") || "");
      if (existingURL && existingURL === target) return attachment;
    }
    return null;
  },

  async downloadOnePDF(item, apiKey, onStatus = null) {
    const result = await this.getPdfSources(item, apiKey, onStatus);
    if (!result) throw new Error("No ADS record found");
    if (!result.sources.length) throw new Error("ADS lists no PDF/full-text source");

    const errors = [];
    for (const sourceType of result.sources) {
      try {
        onStatus?.("Preparing " + sourceType + "...");
        const pdfURL = await this.resolvePdfURL(apiKey, result.adsData, sourceType, onStatus);
        onStatus?.("Downloading " + sourceType + "...");
        const attachment = await this.importPdfFromURL(item, pdfURL);
        if (attachment) return { sourceType, bibcode: result.adsData.bibcode, url: pdfURL };
      } catch (error) {
        errors.push(sourceType + ": " + (error?.message || error));
        this.log("PDF source failed for " + result.adsData.bibcode + " via " + sourceType + ": " + (error?.message || error));
      }
    }
    throw new Error("All ADS PDF sources failed" + (errors.length ? " (" + errors.join("; ") + ")" : ""));
  },

  async downloadLatestPublishedPDF(win) {
    const apiKey = this.ensureApiKey(win);
    if (!apiKey) return;
    const items = this.getSelectedRegularItems(win);
    if (items.length !== 1) {
      this.showToast(win, "NASA ADS", "Select exactly one regular Zotero item for the latest published PDF.", true);
      return;
    }
    await this.downloadLatestPublishedPDFForItem(win, items[0], apiKey);
  },

  async downloadLatestPublishedPDFForItem(win, item, apiKey = null) {
    apiKey = apiKey || this.ensureApiKey(win);
    if (!apiKey || !item) return;
    const title = this.shortTitle(item);
    const pw = this.createProgress(win, "NASA ADS: Latest Published PDF");
    const line = new pw.ItemProgress(null, title + " — starting...");
    line.setProgress(5);
    const started = Date.now();

    try {
      const alreadyHasPDF = await this.hasPDFAttachment(item);
      if (alreadyHasPDF) {
        line.setText(title + " — existing PDF found; checking ADS for publisher version...");
        line.setProgress(12);
      }

      const fields = ["bibcode", "esources", "identifier", "doi", "title", "doctype", "pub", "pubdate"];
      const adsData = await this.findAdsRecord(item, apiKey, fields, status => {
        line.setText(title + " — " + status);
        line.setProgress(20);
      });
      if (!adsData) throw new Error("No ADS record found");

      const available = new Set((adsData.esources || []).map(value => String(value).toUpperCase()));
      if (!available.has("PUB_PDF")) {
        if (adsData.doctype === "eprint") {
          throw new Error("ADS has not linked this item to a published journal PDF yet");
        }
        throw new Error("ADS does not list a publisher PDF (PUB_PDF) for this item");
      }

      line.setText(title + " — resolving publisher PDF...");
      line.setProgress(40);
      const pdfURL = await this.resolvePdfURL(apiKey, adsData, "PUB_PDF", status => {
        line.setText(title + " — " + status);
        line.setProgress(45);
      });

      const duplicate = await this.findExistingPdfByURL(item, pdfURL);
      if (duplicate) {
        line.setText(title + " — publisher PDF already attached");
        line.setProgress(100);
        pw.addDescription("No download needed: the resolved publisher PDF URL is already attached.");
        this.closeProgressLater(win, pw, 5000);
        return duplicate;
      }

      line.setText(title + " — downloading publisher PDF...");
      line.setProgress(70);
      let attachment;
      try {
        attachment = await this.importPdfFromURL(item, pdfURL, "Published PDF (NASA ADS)");
      } catch (directError) {
        const gatewayURL = this.getGatewayPdfURL(adsData, "PUB_PDF");
        if (this.normalizeURL(pdfURL) === this.normalizeURL(gatewayURL)) throw directError;
        line.setText(title + " — direct publisher URL blocked; retrying through ADS gateway...");
        line.setProgress(82);
        this.log("Direct PUB_PDF failed for " + adsData.bibcode + ": " + (directError?.message || directError));
        attachment = await this.importPdfFromURL(item, gatewayURL, "Published PDF (NASA ADS)");
      }
      if (!attachment) throw new Error("Zotero did not create a PDF attachment");

      line.setText(title + " — published PDF attached (" + ((Date.now() - started) / 1000).toFixed(1) + " s)");
      line.setProgress(100);
      pw.addDescription(
        alreadyHasPDF
          ? "A new publisher PDF was attached without deleting the existing PDF."
          : "Publisher PDF attached from ADS PUB_PDF."
      );
      this.closeProgressLater(win, pw, 5500);
      return attachment;
    } catch (error) {
      this.log(error?.stack || String(error));
      line.setText(title + " — failed: " + (error?.message || error));
      line.setProgress(100);
      pw.addDescription("This command requests PUB_PDF only; it does not fall back to arXiv or author manuscripts.");
      this.closeProgressLater(win, pw, 10000);
      return null;
    }
  },

  async enrichMetadataForItem(win, item) {
    const apiKey = this.ensureApiKey(win);
    if (!apiKey || !item) return;
    const title = this.shortTitle(item);
    const pw = this.createProgress(win, "NASA ADS: Enrich Metadata");
    const line = new pw.ItemProgress(null, title + " — starting...");
    line.setProgress(10);
    try {
      await this.updateOneMetadata(item, apiKey, status => {
        line.setText(title + " — " + status);
        line.setProgress(/Applying/.test(status) ? 70 : 35);
      });
      line.setText(title + " — metadata enriched");
      line.setProgress(100);
      this.closeProgressLater(win, pw, 4500);
      return true;
    } catch (error) {
      line.setText(title + " — failed: " + (error?.message || error));
      line.setProgress(100);
      this.closeProgressLater(win, pw, 10000);
      return false;
    }
  },

  async downloadBestPDFForItem(win, item) {
    const apiKey = this.ensureApiKey(win);
    if (!apiKey || !item) return;
    const title = this.shortTitle(item);
    const pw = this.createProgress(win, "NASA ADS: Download Best PDF");
    const line = new pw.ItemProgress(null, title + " — starting...");
    line.setProgress(5);
    const started = Date.now();
    try {
      if (this.getPref("skipExistingPDF") !== false && await this.hasPDFAttachment(item)) {
        line.setText(title + " — skipped (PDF already attached)");
        line.setProgress(100);
        this.closeProgressLater(win, pw, 4500);
        return null;
      }
      const result = await this.downloadOnePDF(item, apiKey, status => {
        line.setText(title + " — " + status);
        if (/Querying/.test(status)) line.setProgress(15);
        else if (/Resolving|Preparing|Using direct/.test(status)) line.setProgress(40);
        else if (/Downloading/.test(status)) line.setProgress(70);
      });
      line.setText(title + " — attached via " + result.sourceType + " (" + ((Date.now() - started) / 1000).toFixed(1) + " s)");
      line.setProgress(100);
      this.closeProgressLater(win, pw, 5000);
      return result;
    } catch (error) {
      line.setText(title + " — failed: " + (error?.message || error));
      line.setProgress(100);
      this.closeProgressLater(win, pw, 10000);
      return null;
    }
  },

  scheduleItemPaneRegistration() {
    // Right-side Item Pane removed in AstroZotero test7.5.
  },

  registerItemPane() {
    this.itemPaneID = null;
  },

  unregisterItemPane() {
    this.itemPaneID = null;
    this.itemPaneRefreshCallbacks = new Map();
    this.itemPaneSubjects = new Map();
  },

  refreshItemPanes() {
    for (const refresh of this.paneRefreshCallbacks.values()) {
      try {
        const result = refresh();
        if (result?.catch) result.catch(error => this.log("Item Pane refresh failed: " + error));
      } catch (error) {
        this.log("Item Pane refresh failed: " + error);
      }
    }
  },

  unregisterItemPane() {
    if (this.itemPaneTimer) {
      clearTimeout(this.itemPaneTimer);
      this.itemPaneTimer = null;
    }
    if (typeof this.itemPaneID === "string") {
      try { Zotero.ItemPaneManager?.unregisterSection?.(this.itemPaneID); } catch (_) {}
    }
    this.itemPaneID = null;
    this.paneCache.clear();
    this.paneStates = new WeakMap();
    this.paneRefreshCallbacks.clear();
    this.paneSubjects.clear();
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

  paneKey(item) {
    return String(item?.libraryID || 0) + ":" + String(item?.key || item?.id || "");
  },

  paneEl(doc, tag, attrs = {}, text = null) {
    const node = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "class") node.className = value;
      else if (key === "title") node.title = value;
      else node.setAttribute(key, String(value));
    }
    if (text !== null && text !== undefined) node.textContent = String(text);
    return node;
  },

  clearNode(node) {
    while (node?.firstChild) node.removeChild(node.firstChild);
  },

  ensurePaneStyle(doc) {
    // Styles are installed on the Zotero main document through a chrome://
    // stylesheet, matching Citation Map's implementation.
  },

  getPaneState(body, item) {
    const key = this.paneKey(item);
    let state = this.paneStates.get(body);
    if (!state || state.itemKey !== key) {
      state = {
        itemKey: key,
        tab: "overview",
        generation: 0,
        exploreModes: new Set(["similar", "reviews"]),
        exploreSeed: null
      };
      this.paneStates.set(body, state);
    }
    return state;
  },

  paneCacheEntry(item) {
    const key = this.paneKey(item);
    const now = Date.now();
    let entry = this.paneCache.get(key);
    if (!entry || entry.expires < now) {
      entry = { expires: now + this.PANE_CACHE_MS, overview: null, relations: new Map(), explore: new Map() };
      this.paneCache.set(key, entry);
    }
    return entry;
  },

  clearPaneCache(item) {
    if (item) this.paneCache.delete(this.paneKey(item));
    else this.paneCache.clear();
  },

  normalizeADSRecord(record) {
    if (!record) return null;
    const title = Array.isArray(record.title) ? record.title[0] : record.title;
    const authors = Array.isArray(record.author) ? record.author : [];
    const doi = Array.isArray(record.doi) ? record.doi[0] : record.doi;
    const props = new Set((record.property || []).map(v => String(v).toUpperCase()));
    return {
      ...record,
      title: title || record.bibcode || "Untitled",
      authors,
      doi: doi || null,
      year: record.year || (String(record.pubdate || "").match(/\b(?:19|20)\d{2}\b/)?.[0]) || null,
      citationCount: Number(record.citation_count ?? 0),
      readCount: record.read_count === undefined ? null : Number(record.read_count || 0),
      referenceCount: Array.isArray(record.reference) ? record.reference.length : null,
      refereed: props.has("REFEREED"),
      openAccess: props.has("OPENACCESS") || props.has("EPRINT_OPENACCESS"),
      pdfSources: (record.esources || []).map(v => String(v).toUpperCase())
    };
  },

  async getPaneOverview(item, force = false) {
    const entry = this.paneCacheEntry(item);
    if (force) entry.overview = null;
    if (entry.overview) return entry.overview;
    const apiKey = this.getApiKey();
    if (!apiKey) throw new Error("NASA ADS API token is not configured.");
    const fields = [
      "bibcode", "title", "author", "year", "pub", "pubdate", "abstract", "citation_count",
      "read_count", "reference", "property", "identifier", "doi", "doctype", "esources"
    ];
    const record = await this.findAdsRecord(item, apiKey, fields);
    if (!record) throw new Error("No NASA ADS record found for this Zotero item.");
    entry.overview = this.normalizeADSRecord(record);
    return entry.overview;
  },

  async getPaneRelation(item, kind, force = false) {
    const entry = this.paneCacheEntry(item);
    if (force) entry.relations.delete(kind);
    if (entry.relations.has(kind)) return entry.relations.get(kind);
    const overview = await this.getPaneOverview(item);
    const apiKey = this.getApiKey();
    const operator = kind === "cited" ? "citations" : "references";
    const query = operator + '(bibcode:"' + this.escapeQueryValue(overview.bibcode) + '")';
    const fields = ["bibcode", "title", "author", "year", "pub", "pubdate", "citation_count", "doi", "identifier", "abstract"];
    const result = await this.adsSearchMany(apiKey, query, fields, 20, kind === "cited" ? "date desc" : "citation_count desc");
    const normalized = { numFound: result.numFound, docs: result.docs.map(r => this.normalizeADSRecord(r)).filter(Boolean) };
    entry.relations.set(kind, normalized);
    return normalized;
  },

  async getPaneExplore(item, seed, modes, force = false) {
    const entry = this.paneCacheEntry(item);
    const seedBibcode = seed?.bibcode || (await this.getPaneOverview(item)).bibcode;
    const modeList = [...modes].sort();
    const cacheKey = seedBibcode + "|" + modeList.join(",");
    if (force) entry.explore.delete(cacheKey);
    if (entry.explore.has(cacheKey)) return entry.explore.get(cacheKey);
    const apiKey = this.getApiKey();
    const fields = ["bibcode", "title", "author", "year", "pub", "pubdate", "citation_count", "doi", "identifier", "abstract"];
    const merged = new Map();
    for (const mode of modeList) {
      const query = mode + '(bibcode:"' + this.escapeQueryValue(seedBibcode) + '")';
      const result = await this.adsSearchMany(apiKey, query, fields, 12);
      for (const raw of result.docs) {
        if (!raw?.bibcode || raw.bibcode === seedBibcode) continue;
        const doc = this.normalizeADSRecord(raw);
        const current = merged.get(raw.bibcode) || { ...doc, modes: new Set() };
        current.modes.add(mode);
        merged.set(raw.bibcode, current);
      }
    }
    const docs = [...merged.values()].sort((a, b) =>
      (b.modes.size - a.modes.size) || (b.citationCount - a.citationCount) || (Number(b.year || 0) - Number(a.year || 0))
    );
    const value = { seedBibcode, docs };
    entry.explore.set(cacheKey, value);
    return value;
  },

  formatAuthors(authors, max = 3) {
    if (!authors?.length) return "";
    const names = authors.slice(0, max).map(name => {
      const comma = String(name).indexOf(",");
      return comma > 0 ? String(name).slice(0, comma) : String(name);
    });
    return names.join(", ") + (authors.length > max ? " et al." : "");
  },

  renderItemPane(doc, body, sourceItem, setEnabled = null, setSectionSummary = null, force = false) {
    if (!doc || !body) return;
    this.ensurePaneStyle(doc);
    const item = this.resolvePaneItem(sourceItem);
    setEnabled?.(Boolean(item));
    this.clearNode(body);
    if (!item) return;
    const state = this.getPaneState(body, item);
    const generation = ++state.generation;
    const shell = this.paneEl(doc, "div", { class: "az-pane" });
    const tabs = this.paneEl(doc, "div", { class: "az-tabs" });
    const labels = [
      ["overview", "Overview"],
      ["cited", "Cited by"],
      ["references", "References"],
      ["explore", "Explore"],
      ["pdf", "PDF"]
    ];
    for (const [id, label] of labels) {
      const button = this.paneEl(doc, "button", { type: "button", "aria-selected": state.tab === id ? "true" : "false" }, label);
      button.addEventListener("click", () => {
        state.tab = id;
        this.renderItemPane(doc, body, item, setEnabled, setSectionSummary);
      });
      tabs.appendChild(button);
    }
    const content = this.paneEl(doc, "div", { class: "az-content" });
    shell.append(tabs, content);
    body.appendChild(shell);
    const isCurrent = () => this.paneStates.get(body) === state && state.generation === generation ;
    void this.renderItemPaneTab(doc, content, item, state, isCurrent, setSectionSummary, force);
  },

  async renderItemPaneTab(doc, content, item, state, isCurrent, setSectionSummary, force = false) {
    if (state.tab === "pdf") {
      this.renderPDFTab(doc, content, item, state, setSectionSummary);
      return;
    }
    if (!this.getApiKey()) {
      const note = this.paneEl(doc, "div", { class: "az-empty" }, "NASA ADS API token is not configured.");
      const button = this.paneEl(doc, "button", { class: "az-btn", type: "button" }, "Set API token");
      button.addEventListener("click", () => {
        const win = doc.defaultView;
        if (this.promptForApiKey(win)) this.renderItemPane(doc, content.parentNode?.parentNode || content, item, null, setSectionSummary, true);
      });
      content.append(note, button);
      return;
    }
    const loading = this.paneEl(doc, "div", { class: "az-status" }, "Loading NASA ADS data…");
    content.appendChild(loading);
    try {
      if (state.tab === "overview") {
        const data = await this.getPaneOverview(item, force);
        if (!isCurrent()) return;
        this.clearNode(content);
        this.renderOverviewTab(doc, content, item, data, state, setSectionSummary);
      } else if (state.tab === "cited" || state.tab === "references") {
        const data = await this.getPaneRelation(item, state.tab, force);
        if (!isCurrent()) return;
        this.clearNode(content);
        this.renderRelationTab(doc, content, item, state.tab, data, state, setSectionSummary);
      } else if (state.tab === "explore") {
        const overview = await this.getPaneOverview(item, force);
        if (!isCurrent()) return;
        this.clearNode(content);
        await this.renderExploreTab(doc, content, item, overview, state, isCurrent, setSectionSummary, force);
      }
    } catch (error) {
      if (!isCurrent()) return;
      this.clearNode(content);
      content.appendChild(this.paneEl(doc, "div", { class: "az-error" }, error?.message || String(error)));
    }
  },

  renderOverviewTab(doc, content, item, data, state, setSectionSummary) {
    content.appendChild(this.paneEl(doc, "div", { class: "az-title" }, data.title));
    const meta = [this.formatAuthors(data.authors), data.pub, data.year].filter(Boolean).join(" · ");
    if (meta) content.appendChild(this.paneEl(doc, "div", { class: "az-meta" }, meta));
    const pills = this.paneEl(doc, "div", { class: "az-pills" });
    if (data.refereed) pills.appendChild(this.paneEl(doc, "span", { class: "az-pill" }, "Refereed"));
    if (data.openAccess) pills.appendChild(this.paneEl(doc, "span", { class: "az-pill" }, "Open Access"));
    if (data.pdfSources.includes("PUB_PDF")) pills.appendChild(this.paneEl(doc, "span", { class: "az-pill" }, "Publisher PDF"));
    if (data.pdfSources.includes("EPRINT_PDF")) pills.appendChild(this.paneEl(doc, "span", { class: "az-pill" }, "arXiv PDF"));
    if (pills.childNodes.length) content.appendChild(pills);

    const metrics = this.paneEl(doc, "div", { class: "az-metrics" });
    for (const [value, label] of [
      [data.citationCount, "Citations"],
      [data.referenceCount ?? "—", "References"],
      [data.readCount ?? "—", "ADS reads"]
    ]) {
      const box = this.paneEl(doc, "div", { class: "az-metric" });
      box.append(this.paneEl(doc, "b", {}, value), this.paneEl(doc, "span", {}, label));
      metrics.appendChild(box);
    }
    content.appendChild(metrics);
    setSectionSummary?.(data.citationCount + " citations · " + (data.referenceCount ?? "?") + " refs");

    const details = [
      ["ADS Bibcode", data.bibcode],
      ["DOI", data.doi],
      ["Type", data.doctype]
    ].filter(([, value]) => value);
    for (const [label, value] of details) {
      const row = this.paneEl(doc, "div", { class: "az-meta" });
      row.append(this.paneEl(doc, "b", {}, label + ": "), this.paneEl(doc, "span", {}, value));
      content.appendChild(row);
    }

    const toolbar = this.paneEl(doc, "div", { class: "az-toolbar" });
    const open = this.paneEl(doc, "button", { class: "az-btn", type: "button" }, "Open ADS");
    open.addEventListener("click", () => Zotero.launchURL("https://ui.adsabs.harvard.edu/abs/" + encodeURIComponent(data.bibcode) + "/abstract"));
    const enrich = this.paneEl(doc, "button", { class: "az-btn", type: "button" }, "Enrich metadata");
    enrich.addEventListener("click", async () => {
      enrich.disabled = true;
      await this.enrichMetadataForItem(doc.defaultView, item);
      this.clearPaneCache(item);
      enrich.disabled = false;
    });
    const refresh = this.paneEl(doc, "button", { class: "az-btn", type: "button" }, "Refresh");
    refresh.addEventListener("click", () => {
      this.clearPaneCache(item);
      const body = content.closest?.(".az-pane")?.parentNode;
      if (body) this.renderItemPane(doc, body, item, null, setSectionSummary, true);
    });
    toolbar.append(open, enrich, refresh);
    content.appendChild(toolbar);
  },

  renderPaperCard(doc, paper, options = {}) {
    const card = this.paneEl(doc, "div", { class: "az-card" });
    card.appendChild(this.paneEl(doc, "div", { class: "az-card-title" }, paper.title));
    const meta = [this.formatAuthors(paper.authors), paper.pub, paper.year, paper.citationCount + " citations"].filter(Boolean).join(" · ");
    card.appendChild(this.paneEl(doc, "div", { class: "az-card-meta" }, meta));
    if (paper.modes?.size) {
      const pills = this.paneEl(doc, "div", { class: "az-pills" });
      const labels = { similar: "Similar", reviews: "Review", useful: "Useful", trending: "Trending" };
      for (const mode of paper.modes) pills.appendChild(this.paneEl(doc, "span", { class: "az-pill" }, labels[mode] || mode));
      card.appendChild(pills);
    }
    const actions = this.paneEl(doc, "div", { class: "az-card-actions" });
    const open = this.paneEl(doc, "button", { class: "az-btn", type: "button" }, "Open ADS");
    open.addEventListener("click", () => Zotero.launchURL("https://ui.adsabs.harvard.edu/abs/" + encodeURIComponent(paper.bibcode) + "/abstract"));
    actions.appendChild(open);
    if (paper.doi) {
      const doi = this.paneEl(doc, "button", { class: "az-btn", type: "button" }, "DOI");
      doi.addEventListener("click", () => Zotero.launchURL("https://doi.org/" + paper.doi));
      actions.appendChild(doi);
    }
    if (options.onSeed) {
      const seed = this.paneEl(doc, "button", { class: "az-btn", type: "button" }, "Explore this");
      seed.addEventListener("click", () => options.onSeed(paper));
      actions.appendChild(seed);
    }
    card.appendChild(actions);
    return card;
  },

  renderRelationTab(doc, content, item, kind, data, state, setSectionSummary) {
    const heading = kind === "cited" ? "Newest citing papers" : "Highly cited references";
    content.appendChild(this.paneEl(doc, "div", { class: "az-section-title" }, heading));
    content.appendChild(this.paneEl(doc, "div", { class: "az-status" }, data.numFound + " reported by NASA ADS · showing up to 20"));
    setSectionSummary?.(data.numFound + (kind === "cited" ? " citing" : " refs"));
    const list = this.paneEl(doc, "div", { class: "az-list" });
    if (!data.docs.length) list.appendChild(this.paneEl(doc, "div", { class: "az-empty" }, "No records returned by ADS."));
    for (const paper of data.docs) list.appendChild(this.renderPaperCard(doc, paper));
    content.appendChild(list);
    const refresh = this.paneEl(doc, "button", { class: "az-btn", type: "button", style: "margin-top:8px" }, "Refresh");
    refresh.addEventListener("click", () => {
      this.paneCacheEntry(item).relations.delete(kind);
      const body = content.closest?.(".az-pane")?.parentNode;
      if (body) this.renderItemPane(doc, body, item, null, setSectionSummary, true);
    });
    content.appendChild(refresh);
  },

  async renderExploreTab(doc, content, item, overview, state, isCurrent, setSectionSummary, force = false) {
    const seed = state.exploreSeed || overview;
    content.appendChild(this.paneEl(doc, "div", { class: "az-section-title" }, "ADS literature discovery"));
    content.appendChild(this.paneEl(doc, "div", { class: "az-status" }, "Seed: " + seed.title));
    const checks = this.paneEl(doc, "div", { class: "az-checks" });
    const modeLabels = { similar: "Similar", reviews: "Reviews", useful: "Useful", trending: "Trending" };
    for (const mode of Object.keys(modeLabels)) {
      const label = this.paneEl(doc, "label");
      const input = this.paneEl(doc, "input", { type: "checkbox" });
      input.checked = state.exploreModes.has(mode);
      input.addEventListener("change", () => {
        if (input.checked) state.exploreModes.add(mode); else state.exploreModes.delete(mode);
      });
      label.append(input, this.paneEl(doc, "span", {}, modeLabels[mode]));
      checks.appendChild(label);
    }
    content.appendChild(checks);
    const toolbar = this.paneEl(doc, "div", { class: "az-toolbar" });
    const load = this.paneEl(doc, "button", { class: "az-btn", type: "button" }, "Load selected modes");
    toolbar.appendChild(load);
    if (state.exploreSeed) {
      const reset = this.paneEl(doc, "button", { class: "az-btn", type: "button" }, "Reset to Zotero item");
      reset.addEventListener("click", () => {
        state.exploreSeed = null;
        const body = content.closest?.(".az-pane")?.parentNode;
        if (body) this.renderItemPane(doc, body, item, null, setSectionSummary);
      });
      toolbar.appendChild(reset);
    }
    content.appendChild(toolbar);
    const results = this.paneEl(doc, "div", { class: "az-list" });
    content.appendChild(results);

    const execute = async (hardRefresh = false) => {
      this.clearNode(results);
      if (!state.exploreModes.size) {
        results.appendChild(this.paneEl(doc, "div", { class: "az-empty" }, "Select at least one discovery mode."));
        return;
      }
      load.disabled = true;
      results.appendChild(this.paneEl(doc, "div", { class: "az-status" }, "Querying NASA ADS…"));
      try {
        const data = await this.getPaneExplore(item, seed, state.exploreModes, hardRefresh);
        if (!isCurrent()) return;
        this.clearNode(results);
        setSectionSummary?.(data.docs.length + " discovered");
        if (!data.docs.length) results.appendChild(this.paneEl(doc, "div", { class: "az-empty" }, "No discovery records returned by ADS."));
        for (const paper of data.docs.slice(0, 30)) {
          results.appendChild(this.renderPaperCard(doc, paper, {
            onSeed: next => {
              state.exploreSeed = next;
              const body = content.closest?.(".az-pane")?.parentNode;
              if (body) this.renderItemPane(doc, body, item, null, setSectionSummary);
            }
          }));
        }
      } catch (error) {
        if (isCurrent()) {
          this.clearNode(results);
          results.appendChild(this.paneEl(doc, "div", { class: "az-error" }, error?.message || String(error)));
        }
      } finally {
        load.disabled = false;
      }
    };
    load.addEventListener("click", () => execute(true));
    await execute(force);
  },

  getPDFAttachmentInfo(item) {
    const rows = [];
    for (const id of item.getAttachments?.() || []) {
      const attachment = Zotero.Items.get(id);
      if (!attachment || attachment.attachmentContentType !== "application/pdf") continue;
      const title = attachment.getField?.("title") || "PDF attachment";
      const url = attachment.getField?.("url") || "";
      let type = "PDF";
      if (/Published PDF \(NASA ADS\)/i.test(title)) type = "Published";
      else if (/arxiv/i.test(title + " " + url)) type = "arXiv";
      else if (/adsabs|ui\.adsabs/i.test(url)) type = "ADS";
      rows.push({ attachment, title, url, type });
    }
    return rows;
  },

  renderPDFTab(doc, content, item, state, setSectionSummary) {
    const rows = this.getPDFAttachmentInfo(item);
    content.appendChild(this.paneEl(doc, "div", { class: "az-section-title" }, "PDF & access"));
    content.appendChild(this.paneEl(doc, "div", { class: "az-status" }, rows.length ? rows.length + " PDF attachment(s)" : "No PDF attached"));
    setSectionSummary?.(rows.length + " PDFs");
    if (rows.length) {
      for (const row of rows) {
        const line = this.paneEl(doc, "div", { class: "az-pdf-row" });
        line.append(this.paneEl(doc, "span", { class: "az-pill" }, row.type), this.paneEl(doc, "span", {}, row.title));
        content.appendChild(line);
      }
    }
    const note = this.paneEl(doc, "div", { class: "az-small" }, "Version detection is conservative: unknown PDFs are not deleted or replaced automatically.");
    content.appendChild(note);
    const toolbar = this.paneEl(doc, "div", { class: "az-toolbar" });
    const best = this.paneEl(doc, "button", { class: "az-btn", type: "button" }, "Download best PDF");
    const published = this.paneEl(doc, "button", { class: "az-btn", type: "button" }, "Published PDF");
    const enrich = this.paneEl(doc, "button", { class: "az-btn", type: "button" }, "Enrich metadata");
    const rerender = () => {
      this.clearPaneCache(item);
      const body = content.closest?.(".az-pane")?.parentNode;
      if (body) this.renderItemPane(doc, body, item, null, setSectionSummary, true);
    };
    best.addEventListener("click", async () => { best.disabled = true; await this.downloadBestPDFForItem(doc.defaultView, item); best.disabled = false; rerender(); });
    published.addEventListener("click", async () => { published.disabled = true; await this.downloadLatestPublishedPDFForItem(doc.defaultView, item); published.disabled = false; rerender(); });
    enrich.addEventListener("click", async () => { enrich.disabled = true; await this.enrichMetadataForItem(doc.defaultView, item); enrich.disabled = false; rerender(); });
    toolbar.append(best, published, enrich);
    content.appendChild(toolbar);
    content.appendChild(this.paneEl(doc, "div", { class: "az-status" }, "Institutional sign-in is not included in this test build. Publisher access still follows the existing ADS/publisher session rules."));
  },

  async downloadSelectedPDFs(win) {
    const apiKey = this.ensureApiKey(win);
    if (!apiKey) return;
    const items = this.getSelectedRegularItems(win);
    if (!items.length) {
      this.showToast(win, "NASA ADS", "Select at least one regular Zotero item.", true);
      return;
    }

    const pw = this.createProgress(win, "NASA ADS: Download Best PDF");
    const skipExisting = this.getPref("skipExistingPDF") !== false;
    let success = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const title = this.shortTitle(item);
      const line = new pw.ItemProgress(null, title + " — starting...");
      line.setProgress(5);
      const started = Date.now();

      try {
        if (skipExisting && await this.hasPDFAttachment(item)) {
          skipped++;
          line.setText(title + " — skipped (PDF already attached)");
          line.setProgress(100);
          continue;
        }

        const result = await this.downloadOnePDF(item, apiKey, status => {
          line.setText(title + " — " + status);
          if (/Querying/.test(status)) line.setProgress(15);
          else if (/Resolving|Preparing|Using direct/.test(status)) line.setProgress(40);
          else if (/Downloading/.test(status)) line.setProgress(70);
        });
        success++;
        line.setText(title + " — attached via " + result.sourceType + " (" + ((Date.now() - started) / 1000).toFixed(1) + " s)");
        line.setProgress(100);
      } catch (error) {
        failed++;
        this.log(error?.stack || String(error));
        line.setText(title + " — failed: " + (error?.message || error));
        line.setProgress(100);
      }
    }

    const summary = [success + " attached"];
    if (skipped) summary.push(skipped + " skipped");
    if (failed) summary.push(failed + " failed");
    pw.addDescription("Done: " + summary.join(", ") + ".");
    this.closeProgressLater(win, pw, failed ? 10000 : 5000);
  }
};
