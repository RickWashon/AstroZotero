# AstroZotero

Astronomy-focused Zotero plugin powered primarily by the NASA Astrophysics Data System (ADS).

AstroZotero extends the original `zot-nasa-ads` workflow for Zotero 7-10 with ADS metadata enrichment, PDF retrieval, and an embedded literature map for exploring citation and semantic relationships without leaving Zotero.

## Astro Map in Zotero

<p align="center">
  <img src="docs/images/astrozotero%20usage.png" alt="AstroZotero Astro Map embedded in Zotero" width="1200">
</p>

<p align="center"><em>Explore citation and literature relationships directly inside Zotero, inspect paper metadata, search the temporary map, and add selected papers to your library.</em></p>

## Version 0.3.4

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

The Astro Map is embedded directly below the Zotero item tree and can be opened from the Zotero toolbar or Tools menu. It always starts closed after Zotero launches, so an empty map is not restored from the previous session.

Available relations:

- Cited by
- References
- Similar
- Reviews
- Useful
- Trending

The default view is **Cited by + References** to reduce expensive ADS discovery queries.

#### Layout and visual semantics

- Distance from the seed primarily represents combined seed affinity, using relation type, local title+abstract similarity, and optional OpenAlex semantic signals.
- Non-seed papers form deterministic local communities, so strongly connected or influential papers can anchor their own literature clusters instead of every paper being arranged only around the seed.
- Community sectors and soft radial constraints preserve a readable seed-distance meaning while allowing local citation/discovery neighborhoods to group naturally.
- Node size follows citation count on a logarithmic scale with an expanded dynamic range, making highly cited papers more visually distinct.
- Filled center = paper already exists in Zotero; hollow center = external paper.
- Multi-relation papers use a segmented outer ring, with one colored arc per relation type.
- Layout diagnostics report seed-distance Spearman `rho`, map-level `N@10` neighborhood preservation, and edge-distance stress.

#### Zoom, labels, and performance-oriented display

- Zoom-dependent LOD shows fewer papers and edges when zoomed out and progressively reveals more when zooming in.
- Node circles and author-year labels stay approximately constant in screen size while the map expands.
- Geometric spacing uses compressed zoom (`zoom^0.60`) instead of linear stretching, reducing large empty gaps at high zoom.
- The underlying layout remains stable during zoom and search rather than being recomputed on every interaction.

#### Map search

Search works on the papers already loaded into the temporary Astro Map and does not make a new ADS request.

- Free text searches title, authors, and year.
- Field search supports `title:`, `author:`, and `year:`.
- Author matching is tolerant of common `First Last` / `Last, First` ordering differences.
- Prefix a query with `^`, or toggle **1st/corr**, to restrict author matching to first author and, when OpenAlex authorship metadata provides it, corresponding author.
- Enter / Shift+Enter cycles through matches, and matched papers remain visible through LOD filtering.

#### Interaction

- Use the currently selected Zotero item as the map seed.
- Open ADS / DOI records.
- Show local papers in Zotero, including papers outside the current collection.
- Add external papers to Zotero.
- Batch-select and batch-import external papers into the collection captured when the map seed is selected.
- Load more seed results without losing the existing graph.

### ADS reliability and OpenAlex fallback

NASA ADS remains the primary source. OpenAlex can be used as a fallback for:

- Cited by
- References
- Similar

ADS-specific `reviews()`, `useful()`, and `trending()` are not replaced with semantically different OpenAlex queries.

For transient ADS network, rate-limit, or server errors, AstroZotero retries ADS before falling back. OpenAlex fallback graphs are explicitly marked incomplete, are not cached as complete seed results, and expose **Retry ADS** rather than incorrectly reporting that no more seed results exist.

### Zotero 10 compatibility

- Supports Zotero 7 through Zotero 10.
- Handles cold starts and restored non-default item-tree views in Zotero 10.
- Installs Astro Map asynchronously so delayed item-tree initialization does not block plugin startup.
- Places **Use selected item** before **Load** in the Astro Map controls.

## Compatibility

- Zotero 7
- Zotero 8
- Zotero 9.0.x
- Zotero 10.0.x

## Setup

1. Install the `.xpi` from the GitHub Releases page.
2. Restart Zotero if requested.
3. Open Zotero Settings -> AstroZotero.
4. Paste a NASA ADS API token and test it.
5. Optional: configure OpenAlex fallback and PDF preferences.

## Credits

AstroZotero is based on the original [`samuelyeewl/zot-nasa-ads`](https://github.com/samuelyeewl/zot-nasa-ads) project by Samuel Yee and remains licensed under the GNU Affero General Public License v3.0.

## License

GNU Affero General Public License v3.0. See `COPYING`.

