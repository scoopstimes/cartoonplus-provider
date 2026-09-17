# Vega App Provider - AI Agent Instructions

You are an AI coding assistant helping a developer build a "Provider" (extension) for the Vega App.
A Provider is a scraping module that extracts catalog, metadata, streaming, and episode information from a specific movie/TV show streaming website.

Follow these strict rules and conventions when creating or modifying a provider:

## 1. Directory Structure
Each provider MUST be placed in its own folder under `providers/` (e.g., `providers/myProvider/`).
A complete provider consists of up to 5 files:
- `catalog.ts` (Required)
- `meta.ts` (Required)
- `posts.ts` (Required)
- `stream.ts` (Required)
- `episodes.ts` (Optional - only needed if episodes must be fetched dynamically)

## 2. API Signatures & Types
ALWAYS import types from `../types`. Do NOT define your own types for the core returns.

### `catalog.ts`
Export two arrays: `catalog` and optionally `genres`.
```ts
export const catalog = [
  { title: "Popular Movies", filter: "/category/popular-movies" },
];
```

### `posts.ts`
Export `getPosts` and `getSearchPosts`.
```ts
import { Post, ProviderContext } from "../types";

export const getPosts = async function ({ filter, page, providerValue, signal, providerContext }): Promise<Post[]> {
  const { axios, cheerio } = providerContext;
  // Use `filter` and `page` to scrape a list of posts
  // Return array of `{ title, link, image }`
}

export const getSearchPosts = async function ({ searchQuery, page, providerValue, signal, providerContext }): Promise<Post[]> {
  // Use `searchQuery` and `page` to scrape search results
}
```

### `meta.ts`
Export `getMeta`.
```ts
import { Info, ProviderContext } from "../types";

export const getMeta = async function ({ link, providerContext }): Promise<Info> {
  const { axios, cheerio } = providerContext;
  // Scrape the movie/show page
  // `type` must be "movie" or "series"
  // `imdbId` should be extracted if possible (for Cinemeta enrichment)
  // `linkList` defines the available media (see LinkList rules below).
  return { title, synopsis, image, imdbId, type, linkList };
}
```

### `stream.ts`
Export `getStream`.
```ts
import { Stream, ProviderContext } from "../types";

export const getStream = async function ({ link, type, signal, providerContext }): Promise<Stream[]> {
  const { axios, cheerio, commonHeaders } = providerContext;
  // Scrape and resolve the final video files (e.g., .m3u8, .mp4)
  // Return array of `{ server, link, type, quality }`
}
```

### `episodes.ts` (Optional)
Export `getEpisodes`.
```ts
import { EpisodeLink, ProviderContext } from "../types";

export const getEpisodes = async function ({ url, providerContext }): Promise<EpisodeLink[]> {
  // Used for fetching episode lists dynamically for a selected season
  // Return array of `{ title, link }`
}
```

## 3. LinkList Rules (`meta.ts`)
The `linkList` array in `meta.ts` tells the Vega app what media is available.
- For **Movies**: 
  ```ts
  linkList: [
    { title: "Movie", quality: "1080p", directLinks: [{ title: "Movie", link: streamLink, type: "movie" }] }
  ]
  ```
- For **Series (Static)**: If you can scrape all episodes on the main page, populate `directLinks`.
  ```ts
  linkList: [
    { 
      title: "Season 1", 
      directLinks: [
        { title: "Episode 1", link: ep1Link, type: "series" },
        { title: "Episode 2", link: ep2Link, type: "series" }
      ] 
    }
  ]
  ```
- For **Series (Dynamic)**: If each season requires an extra HTTP request, OMIT `directLinks` entirely and provide an `episodesLink`. The Vega app will call `episodes.ts` using the `episodesLink` to load the episodes.
  ```ts
  linkList: [
    { title: "Season 1", episodesLink: season1Link },
    { title: "Season 2", episodesLink: season2Link }
  ]
  ```

## 4. Dependencies and Error Handling
- Use `axios` and `cheerio` provided in `providerContext`. Do NOT use `fetch` or import cheerio globally, because the context objects are injected with special caching/interceptor logic by the Vega app.
- Use `commonHeaders` from `providerContext` when making axios requests to avoid blocking.
- When an extractor fails, you can use `throwProviderError(providerName, functionName, err)` to throw standard errors.

## 5. Bundling
After modifying or creating a provider, it MUST be built using:
`npm run build`
This generates the CommonJS outputs into the `dist/` folder, which the Vega app consumes.
