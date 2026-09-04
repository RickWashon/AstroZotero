var ZotNasaAds;
var AstroZoteroMap;
var chromeHandle;

function log(message) {
  Zotero.debug("AstroZotero: " + message);
}

async function startup({ id, version, rootURI }) {
  await Promise.all([Zotero.initializationPromise, Zotero.unlockPromise]);

  var aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  var manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "astrozotero", rootURI]
  ]);

  await Zotero.PreferencePanes.register({
    pluginID: id,
    id: "zot-nasa-ads-preferences",
    label: "AstroZotero",
    src: rootURI + "preferences.xhtml",
    scripts: [rootURI + "preferences.js"]
  });

  Services.scriptloader.loadSubScript(rootURI + "zot-nasa-ads.js");
  ZotNasaAds.init({ id, version, rootURI });
  Services.scriptloader.loadSubScript(rootURI + "astro-map.js");

  // test4 intentionally does NOT register an ItemPane section. Zotero 9.0.x
  // has been unreliable for this plugin, while Style's library-embedded graph
  // pattern is proven stable in the same Zotero UI.
  await Zotero.uiReadyPromise;
  ZotNasaAds.registerMenus();
  for (const win of Zotero.getMainWindows()) {
    try { win.MozXULElement?.insertFTLIfNeeded?.("astrozotero-mainWindow.ftl"); } catch (_) {}
    ZotNasaAds.addToWindow(win);
    await AstroZoteroMap.addToWindow(win, ZotNasaAds);
  }
  log("Started " + version);
}

async function onMainWindowLoad({ window }) {
  if (!ZotNasaAds) return;
  try { window.MozXULElement?.insertFTLIfNeeded?.("astrozotero-mainWindow.ftl"); } catch (_) {}
  ZotNasaAds.addToWindow(window);
  if (AstroZoteroMap) await AstroZoteroMap.addToWindow(window, ZotNasaAds);
}

function onMainWindowUnload({ window }) {
  if (AstroZoteroMap) AstroZoteroMap.removeFromWindow(window);
  if (ZotNasaAds) ZotNasaAds.removeFromWindow(window);
}

function shutdown() {
  if (AstroZoteroMap) { AstroZoteroMap.unregisterItemPane(); AstroZoteroMap.removeFromAllWindows(); }
  if (ZotNasaAds) {
    // Clean up a legacy 0.6.0-test1/2/3 pane if an update happens without a
    // full Zotero restart.
    try { ZotNasaAds.unregisterItemPane(); } catch (_) {}
    try { ZotNasaAds.unregisterMenus(); } catch (_) {}
    ZotNasaAds.removeFromAllWindows();
  }
  AstroZoteroMap = undefined;
  ZotNasaAds = undefined;
  if (chromeHandle) {
    try { chromeHandle.destruct(); } catch (_) {}
    chromeHandle = null;
  }
  log("Shut down");
}

function install() {}
function uninstall() {}
