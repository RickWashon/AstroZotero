var ZotNasaAdsPreferences = {
  prefKey: "extensions.zotnasaads.apikey",

  getStatusNode() {
    return document.getElementById("zot-nasa-ads-token-status");
  },

  setStatus(text) {
    const node = this.getStatusNode();
    if (node) node.setAttribute("value", text);
  },

  async testToken() {
    const input = document.getElementById("zot-nasa-ads-token");
    const token = (input?.value || Zotero.Prefs.get(this.prefKey, true) || "").trim();
    if (!token) {
      this.setStatus("No token entered.");
      return;
    }
    this.setStatus("Testing...");
    try {
      const url = "https://api.adsabs.harvard.edu/v1/search/query?q=bibcode%3A2020ApJ...888...99A&fl=bibcode&rows=1";
      const response = await Zotero.HTTP.request("GET", url, {
        headers: { Authorization: "Bearer " + token },
        timeout: 10000,
        errorDelayMax: 0,
        successCodes: false
      });
      if (response.status === 200) {
        Zotero.Prefs.set(this.prefKey, token, true);
        this.setStatus("Token works.");
      } else if (response.status === 401 || response.status === 403) {
        this.setStatus("Token rejected by ADS.");
      } else {
        this.setStatus("ADS returned HTTP " + response.status + ".");
      }
    } catch (error) {
      this.setStatus("Test failed: " + (error?.message || String(error)));
    }
  },

  openTokenPage() {
    Zotero.launchURL("https://ui.adsabs.harvard.edu/user/settings/token");
  }
};
