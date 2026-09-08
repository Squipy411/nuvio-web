import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Select } from "./Select";
import { Dices } from "lucide-react";
import { TitleRoulette } from "../App";
import {
  discoverCatalogs,
  loadDiscoverCatalog,
  type DiscoverCatalog,
} from "../lib/addons";
import type { AddonSearchGroup } from "../lib/addons";
import type { WatchIndex } from "../lib/progress";
import { useProgressiveList } from "../lib/useProgressiveList";
import type { InstalledAddon, Meta } from "../types";
import { MediaRow, PosterCard, type MediaMenuHandler } from "./Media";

const ALL_GENRES = "__all__";

const typeLabel = (value: string) =>
  value === "movie"
    ? "Movies"
    : value === "series"
      ? "Series"
      : value.charAt(0).toUpperCase() + value.slice(1);

/**
 * One line for a search result row: what the catalog calls itself, the type it
 * answers for, and how many it found — "Search • Movies | 5".
 *
 * The addon's name is deliberately absent. Almost every addon calls its search
 * catalog "Search", so a heading of the catalog name over a subheading of the
 * addon, the type and the count said the same two things twice and pushed the
 * posters down a line for it.
 */
const searchGroupHeading = (group: AddonSearchGroup) =>
  `${group.name.trim() || "Search"} • ${typeLabel(group.type)} | ${group.items.length}`;

/**
 * Browses addon catalogs without a search term, matching the desktop client:
 * a type picker, the catalogs serving that type, and the genres that catalog's
 * manifest advertises.
 */
export function Discover({
  addons,
  index,
  query,
  results,
  resultGroups,
  searchPending,
  onOpen,
  onMenu,
}: {
  addons: InstalledAddon[];
  index: WatchIndex;
  query: string;
  results: Meta[];
  resultGroups: AddonSearchGroup[];
  searchPending: boolean;
  onOpen(item: Meta): void;
  onMenu?: MediaMenuHandler;
}) {
  const catalogs = useMemo(() => discoverCatalogs(addons), [addons]);
  const [type, setType] = useState<string | null>(null);
  const [catalogKey, setCatalogKey] = useState<string | null>(null);
  const [genre, setGenre] = useState(ALL_GENRES);
  const [items, setItems] = useState<Meta[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [error, setError] = useState("");
  const [rolling, setRolling] = useState(false);
  const sentinel = useRef<HTMLDivElement | null>(null);

  /** The catalogs that actually returned something; the rest are not shown. */
  const foundGroups = useMemo(
    () => resultGroups.filter((group) => group.items.length > 0),
    [resultGroups],
  );

  const types = useMemo(
    // Set preserves first-seen order, which is addon priority then manifest
    // order. Sorting here would disagree with the addon configuration.
    () => [...new Set(catalogs.map((item) => item.contentType))],
    [catalogs],
  );
  const activeType = type ?? types[0] ?? null;
  const typeCatalogs = useMemo(
    () => catalogs.filter((item) => item.contentType === activeType),
    [catalogs, activeType],
  );
  const catalog: DiscoverCatalog | undefined =
    typeCatalogs.find((item) => item.key === catalogKey) ?? typeCatalogs[0];

  // A required genre falls back to the first option, an optional one to "all".
  const effectiveGenre = useMemo(() => {
    if (!catalog || catalog.genreOptions.length === 0) return undefined;
    if (genre !== ALL_GENRES && catalog.genreOptions.includes(genre))
      return genre;
    return catalog.genreRequired ? catalog.genreOptions[0] : undefined;
  }, [catalog, genre]);

  const load = useCallback(async () => {
    if (!catalog) return;
    setLoading(true);
    setError("");
    setExhausted(false);
    setItems([]);
    try {
      const first = await loadDiscoverCatalog(catalog, effectiveGenre);
      setItems(first);
      // A catalog whose manifest never advertises `skip` has exactly one page.
      if (!catalog.supportsPagination || first.length === 0) setExhausted(true);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not load catalog",
      );
      setExhausted(true);
    } finally {
      setLoading(false);
    }
  }, [catalog, effectiveGenre]);

  useEffect(() => {
    load();
  }, [load]);

  const more = useCallback(async () => {
    if (!catalog || loading || loadingMore || exhausted || items.length === 0)
      return;
    setLoadingMore(true);
    try {
      const next = await loadDiscoverCatalog(
        catalog,
        effectiveGenre,
        items.length,
      );
      const known = new Set(items.map((item) => `${item.type}:${item.id}`));
      const additions = next.filter(
        (item) => !known.has(`${item.type}:${item.id}`),
      );
      // Addons that ignore `skip` repeat the first page forever, so a page
      // that adds nothing new ends the run rather than looping.
      if (additions.length === 0) setExhausted(true);
      else setItems((current) => [...current, ...additions]);
    } catch {
      setExhausted(true);
    } finally {
      setLoadingMore(false);
    }
  }, [catalog, effectiveGenre, exhausted, items, loading, loadingMore]);

  useEffect(() => {
    const node = sentinel.current;
    if (!node || exhausted || searchingRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) more();
      },
      { rootMargin: "600px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [more, exhausted]);

  const searching = query.trim().length > 0;
  // Read inside the observer effect, which must not re-subscribe per render.
  const searchingRef = useRef(searching);
  searchingRef.current = searching;
  const shown = searching ? results : items;
  const { visible } = useProgressiveList(shown, {
    resetKey: searching ? query : `${catalog?.key}:${effectiveGenre ?? ""}`,
  });

  // Defined once and rendered twice: on the page, and inside the picker,
  // where changing the catalog you are rolling from should not mean closing
  // it and starting again.
  const filters = (
    <>
            <label>
              <span>Type</span>
              <Select
                value={activeType ?? ""}
                onChange={(event) => {
                  setType(event.target.value);
                  setCatalogKey(null);
                  setGenre(ALL_GENRES);
                }}
              >
                {types.map((option) => (
                  <option key={option} value={option}>
                    {typeLabel(option)}
                  </option>
                ))}
              </Select>
            </label>
            <label>
              <span>Catalog</span>
              <Select
                value={catalog?.key ?? ""}
                onChange={(event) => {
                  setCatalogKey(event.target.value);
                  setGenre(ALL_GENRES);
                }}
              >
                {typeCatalogs.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.catalogName}
                  </option>
                ))}
              </Select>
            </label>
            <label>
              <span>Genre</span>
              <Select
                value={effectiveGenre ?? ALL_GENRES}
                disabled={!catalog || catalog.genreOptions.length === 0}
                onChange={(event) => setGenre(event.target.value)}
              >
                {catalog && !catalog.genreRequired && (
                  <option value={ALL_GENRES}>All genres</option>
                )}
                {catalog?.genreOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
                {catalog?.genreOptions.length === 0 && (
                  <option value={ALL_GENRES}>Not supported</option>
                )}
              </Select>
            </label>
    </>
  );

  return (
    <section className="grid-page">
      <span className="eyebrow">NUVIO WEB</span>
      <h1>{searching ? `Results for “${query}”` : "Discover"}</h1>
      {/* Nothing to count is said once, in the empty state below, rather than
          as a "0 titles across 0 catalogs" line above it. */}
      {(!searching || searchPending || foundGroups.length > 0) && (
        <p>
          {searching
            ? searchPending
              ? "Searching installed addons…"
              : `${results.length} titles across ${foundGroups.length} ${foundGroups.length === 1 ? "catalog" : "catalogs"}`
            : `${catalog?.addonName ?? "No addon"} · browse installed catalogs`}
        </p>
      )}

      {rolling && (
        <TitleRoulette
          items={items}
          index={index}
          addons={addons}
          showScope={false}
          controls={filters}
          heading={
            effectiveGenre
              ? `Something from ${effectiveGenre}`
              : `Something from ${catalog?.catalogName ?? "this catalog"}`
          }
          onClose={() => setRolling(false)}
          onOpen={(item) => {
            setRolling(false);
            onOpen(item);
          }}
        />
      )}

      {!searching && (
        <div className="discover-filters">
          {filters}
          {/* Rolls whatever the controls beside it have narrowed things to. A
              handful of titles makes the reel repeat itself visibly, which is
              worse than not offering it. */}
          {items.length >= 8 && (
            <button
              type="button"
              className="library-random-button discover-random-button"
              onClick={() => setRolling(true)}
            >
              <Dices aria-hidden="true" />
              Random pick
            </button>
          )}
        </div>
      )}

      {!searching && error && <div className="notice error">{error}</div>}

      {searching && searchPending ? (
        <div className="grid-loading" role="status">
          <i className="mini-spinner" />
          <span>Searching addon catalogs…</span>
        </div>
      ) : searching ? (
        /* A catalog that found nothing is not worth a row saying so: most
           searches ask every installed addon and only a couple answer, and the
           rest were reading as failures stacked down the page. When none of
           them answer, that is the one thing worth saying. */
        foundGroups.length === 0 ? (
          <div className="empty-state search-empty-state">
            <strong>No results for “{query}”</strong>
          </div>
        ) : (
          <div className="search-result-groups">
            {foundGroups.map((group) => (
              <MediaRow
                key={group.key}
                section={{
                  key: group.key,
                  name: searchGroupHeading(group),
                  type: group.type,
                  manifestUrl: "",
                  addonName: group.addonName,
                  catalogId: group.key,
                  items: group.items,
                }}
                index={index}
                onOpen={onOpen}
                onMenu={onMenu}
              />
            ))}
          </div>
        )
      ) : loading ? (
        /* The grid was rendered empty while a catalog loaded, so the page just
           went black until results arrived. */
        <div className="grid-loading" role="status">
          <i className="mini-spinner" />
          <span>Loading {catalog?.catalogName ?? "catalog"}…</span>
        </div>
      ) : shown.length === 0 && !error ? (
        <div className="empty-state">
          <strong>Nothing returned</strong>
          <span>
            This catalog produced no titles for that filter.
          </span>
        </div>
      ) : (
        <div className="poster-grid">
          {visible.map((item) => (
            <PosterCard
              key={`${item.type}:${item.id}`}
              item={item}
              index={index}
              onOpen={onOpen}
              onMenu={onMenu}
            />
          ))}
        </div>
      )}
      {!exhausted && !searching && (
        <div ref={sentinel} className="grid-sentinel" />
      )}
      {loadingMore && (
        <div className="grid-more" role="status">
          <i className="mini-spinner" />
          Loading more…
        </div>
      )}
    </section>
  );
}
