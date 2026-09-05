# AstroZotero

Astronomy-focused Zotero plugin powered primarily by the NASA Astrophysics Data System (ADS).

AstroZotero extends the original `zot-nasa-ads` idea into an astronomy literature workflow for Zotero 7-9, with ADS metadata enrichment, PDF retrieval, and an embedded literature map.

## Version 0.3.1

### NASA ADS metadata

- Store and update ADS Bibcode / ADS URL and astronomy identifiers.
- Match Zotero items through DOI, arXiv identifiers, and ADS metadata.
- Optional safe metadata enrichment without aggressively overwriting core Zotero metadata.

### PDF retrieval

- `Download Best PDF` with ADS publisher / arXiv / author / ADS fallbacks.
- `Download Latest Published PDF` for the publisher version only.
- Optional preference for open-access sources.
- Skip existing PDFs when desired.
- Single-paper imports can automatically download the Best PDF.
- Batch imports can sequentially download Best PDFs with retry and real success/failure accounting.

### Astro Map

The Astro Map is embedded directly below the Zotero item tree and is opened from the Zotero toolbar or Tools menu.

Available relations:

- Cited by
- References
- Similar
- Reviews
- Useful
- Trending

The default view is **Cited by + References** to reduce expensive ADS discovery queries.

Visual semantics:

- Node color = relationship type.
- Filled node = paper already exists in Zotero.
- Hollow node = external paper.
- Multi-relation papers can show secondary relation markers.

Interaction:

- Zoom around the mouse pointer and pan the map.
- Dynamic author-year labels expand with zoom and are balanced across active relation types instead of being limited to a fixed global top-N.
- Use the currently selected Zotero item as the map seed.
- Open ADS / DOI records.
- Show local papers in Zotero, including papers outside the current collection.
- Add external papers to Zotero.
- Batch-select and batch-import external papers into the collection captured when the map seed is selected.

### Fallback data source

NASA ADS is the primary source. OpenAlex can be used as a fallback for:

- Cited by
- References
- Similar

ADS-specific `reviews()`, `useful()`, and `trending()` are not replaced with semantically different OpenAlex queries.

## Compatibility

- Zotero 7
- Zotero 8
- Zotero 9.0.x (primary tested target: Zotero 9.0.6)

## Setup

1. Install the `.xpi` from the GitHub Releases page.
2. Restart Zotero if requested.
3. Open Zotero Settings -> NASA ADS.
4. Paste a NASA ADS API token and test it.
5. Optional: configure OpenAlex fallback and PDF preferences.

## Credits

AstroZotero is based on the original [`samuelyeewl/zot-nasa-ads`](https://github.com/samuelyeewl/zot-nasa-ads) project by Samuel Yee and remains licensed under the GNU Affero General Public License v3.0.

## License

GNU Affero General Public License v3.0. See `COPYING`.
