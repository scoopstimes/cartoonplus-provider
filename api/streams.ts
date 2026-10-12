import axios from "axios";
import * as cheerio from "cheerio";
import { z } from "zod";
import { getEpisodes } from "../providers/movieBoxWeb/episodes";
import { getMeta } from "../providers/movieBoxWeb/meta";
import { getSearchPosts } from "../providers/movieBoxWeb/posts";
import { getStream } from "../providers/movieBoxWeb/stream";
import { headers } from "../providers/headers";
import type {
  EpisodeLink,
  Info,
  Post,
  ProviderContext,
  Stream,
} from "../providers/types";

const MAX_SEARCH_RESULTS = 30;
const MAX_MATCH_CANDIDATES = 8;
const MAX_PLAYBACK_LINKS = 8;
const MAX_STREAMS = 20;
const REQUEST_TIMEOUT_MS = 25_000;

type VercelRequest = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
};

type VercelResponse = {
  setHeader: (name: string, value: string) => unknown;
  status: (statusCode: number) => VercelResponse;
  json: (body: unknown) => unknown;
};

const requestSchema = z
  .object({
    provider: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
    tmdbId: z.string().trim().regex(/^\d{1,20}$/).optional(),
    imdbId: z.string().trim().regex(/^tt\d{7,10}$/).optional(),
    title: z.string().trim().min(1).max(200),
    year: z.number().int().min(1888).max(2100).optional(),
    mediaType: z.enum(["movie", "series"]),
    season: z.number().int().min(1).max(100).optional(),
    episode: z.number().int().min(1).max(1000).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mediaType === "series" && value.season === undefined) {
      context.addIssue({
        code: "custom",
        path: ["season"],
        message: "season is required for series",
      });
    }
    if (value.mediaType === "series" && value.episode === undefined) {
      context.addIssue({
        code: "custom",
        path: ["episode"],
        message: "episode is required for series",
      });
    }
    if (value.mediaType === "movie" && (value.season || value.episode)) {
      context.addIssue({
        code: "custom",
        path: ["mediaType"],
        message: "season and episode are only valid for series",
      });
    }
  });

type StreamRequest = z.infer<typeof requestSchema>;

type ProviderAdapter = {
  getSearchPosts: (options: {
    searchQuery: string;
    page: number;
    providerValue: string;
    signal: AbortSignal;
    providerContext: ProviderContext;
  }) => Promise<Post[]>;
  getMeta: (options: {
    link: string;
    providerContext: ProviderContext;
  }) => Promise<Info>;
  getEpisodes?: (options: {
    url: string;
    providerContext: ProviderContext;
  }) => Promise<EpisodeLink[]>;
  getStream: (options: {
    link: string;
    type: string;
    signal: AbortSignal;
    providerContext: ProviderContext;
  }) => Promise<Stream[]>;
};

type ApiError = Error & {
  status: number;
  code: string;
  details?: unknown;
};

type HandlerOptions = {
  providers: Record<string, ProviderAdapter>;
  providerContext: ProviderContext;
  unsupportedProviders?: Record<string, string>;
  timeoutMs?: number;
  maxSearchResults?: number;
  maxMatchCandidates?: number;
  maxPlaybackLinks?: number;
  maxStreams?: number;
};

function apiError(
  status: number,
  code: string,
  message: string,
  details?: unknown,
): ApiError {
  return Object.assign(new Error(message), { status, code, details });
}

function sendError(
  response: VercelResponse,
  error: ApiError,
): void {
  response.status(error.status).json({
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  });
}

function parseBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch {
    throw apiError(400, "invalid_json", "Request body must be valid JSON.");
  }
}

function normalizeTitle(value: string): string {
  return value
    .replace(/\s*[([]?(?:18|19|20|21)\d{2}[)\]]?\s*$/, "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findYear(info: Info): number | undefined {
  for (const tag of info.tags || []) {
    const match = tag.match(/\b((?:18|19|20|21)\d{2})\b/);
    if (match) return Number(match[1]);
  }
  const titleYear = info.title.match(/\b((?:18|19|20|21)\d{2})\b/);
  return titleYear ? Number(titleYear[1]) : undefined;
}

function matchesInfo(request: StreamRequest, info: Info): boolean {
  if (info.type !== request.mediaType) return false;

  const comparableIds: boolean[] = [];
  if (request.tmdbId && info.tmdbId) {
    comparableIds.push(request.tmdbId === info.tmdbId);
  }
  if (request.imdbId && info.imdbId) {
    comparableIds.push(request.imdbId === info.imdbId);
  }
  if (comparableIds.length > 0) {
    return comparableIds.every(Boolean);
  }

  if (normalizeTitle(info.title || "") !== normalizeTitle(request.title)) {
    return false;
  }
  return request.year === undefined || findYear(info) === request.year;
}

function extractEpisodeNumbers(title: string):
  | { season: number; episode: number }
  | undefined {
  const match = title.match(
    /\bS(?:eason)?\s*0*(\d+)\D{0,16}E(?:pisode|p)?\s*0*(\d+)\b/i,
  );
  if (!match) return undefined;
  return { season: Number(match[1]), episode: Number(match[2]) };
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 8192) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 20)
      .filter(
        ([key, item]) =>
          /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) &&
          (typeof item === "string" || typeof item === "number") &&
          !/[\r\n]/.test(String(item)) &&
          String(item).length <= 4096,
      )
      .map(([key, item]) => [key, String(item)]),
  );
}

function normalizeSubtitles(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (track) =>
        track &&
        typeof track === "object" &&
        isHttpUrl((track as { uri?: unknown }).uri),
    )
    .slice(0, 20)
    .map((track) => {
      const subtitle = track as {
        title?: unknown;
        language?: unknown;
        type?: unknown;
        uri: string;
      };
      return {
        title: typeof subtitle.title === "string" ? subtitle.title : "Subtitle",
        language:
          typeof subtitle.language === "string" ? subtitle.language : "und",
        type: typeof subtitle.type === "string" ? subtitle.type : "",
        uri: subtitle.uri,
      };
    });
}

function normalizeStreams(streams: Stream[], maxStreams: number) {
  return streams
    .filter(
      (stream) =>
        stream &&
        typeof stream.server === "string" &&
        stream.server.trim() &&
        typeof stream.type === "string" &&
        stream.type.trim() &&
        isHttpUrl(stream.link),
    )
    .slice(0, maxStreams)
    .map((stream) => ({
      server: stream.server.trim().slice(0, 120),
      link: stream.link,
      type: stream.type.trim().toLowerCase().slice(0, 32),
      quality: typeof stream.quality === "string" ? stream.quality : "",
      headers: normalizeHeaders(stream.headers),
      subtitles: normalizeSubtitles(stream.subtitles),
    }));
}

async function findMatchedInfo(
  request: StreamRequest,
  providerName: string,
  provider: ProviderAdapter,
  providerContext: ProviderContext,
  signal: AbortSignal,
  maxSearchResults: number,
  maxMatchCandidates: number,
): Promise<Info> {
  const posts = await provider.getSearchPosts({
    searchQuery: request.title,
    page: 1,
    providerValue: providerName,
    signal,
    providerContext,
  });
  if (!Array.isArray(posts)) {
    throw apiError(502, "invalid_provider_response", "Provider search returned an invalid response.");
  }
  if (posts.length > maxSearchResults) {
    throw apiError(
      422,
      "too_many_search_results",
      "Provider returned too many results to resolve safely.",
    );
  }

  const candidates = posts.filter(
    (post) =>
      post &&
      typeof post.title === "string" &&
      normalizeTitle(post.title) === normalizeTitle(request.title),
  );
  if (candidates.length === 0) {
    throw apiError(404, "title_not_found", "No exact title match was found.");
  }
  if (candidates.length > maxMatchCandidates) {
    throw apiError(
      409,
      "ambiguous_title",
      "Too many exact title matches were returned to resolve safely.",
    );
  }

  const matches: Info[] = [];
  let failedDetails = 0;
  for (const candidate of candidates) {
    try {
      const info = await provider.getMeta({
        link: candidate.link,
        providerContext,
      });
      if (matchesInfo(request, info)) matches.push(info);
    } catch {
      failedDetails += 1;
    }
  }

  if (failedDetails > 0) {
    throw apiError(
      502,
      "candidate_verification_failed",
      "Could not verify every exact title match, so no result was selected.",
    );
  }
  if (matches.length > 1) {
    throw apiError(
      409,
      "ambiguous_title",
      "More than one provider result matches this title and year.",
      matches.map((info) => ({ title: info.title, year: findYear(info) })),
    );
  }
  if (matches.length === 0) {
    throw apiError(
      404,
      "title_not_found",
      "No provider result matched the requested title, year, and media type.",
    );
  }
  return matches[0];
}

async function getPlaybackLinks(
  request: StreamRequest,
  info: Info,
  provider: ProviderAdapter,
  providerContext: ProviderContext,
  maxPlaybackLinks: number,
): Promise<Array<{ link: string; type: string }>> {
  const linkList = info.linkList || [];
  const links: Array<{ link: string; type: string }> = [];

  if (request.mediaType === "movie") {
    for (const group of linkList) {
      for (const directLink of group.directLinks || []) {
        if (directLink.type && directLink.type !== "movie") continue;
        links.push({ link: directLink.link, type: "movie" });
      }
    }
  } else {
    if (!provider.getEpisodes) {
      throw apiError(
        422,
        "episodes_unsupported",
        "This provider does not expose an episode resolver.",
      );
    }

    for (const group of linkList) {
      if (group.episodesLink) {
        const episodes = await provider.getEpisodes({
          url: group.episodesLink,
          providerContext,
        });
        if (!Array.isArray(episodes)) {
          throw apiError(
            502,
            "invalid_provider_response",
            "Provider episode lookup returned an invalid response.",
          );
        }
        for (const episode of episodes) {
          const numbers = extractEpisodeNumbers(episode.title);
          if (
            numbers?.season === request.season &&
            numbers.episode === request.episode
          ) {
            links.push({ link: episode.link, type: "series" });
          }
        }
      }
      for (const directLink of group.directLinks || []) {
        const numbers = extractEpisodeNumbers(directLink.title);
        if (
          numbers?.season === request.season &&
          numbers.episode === request.episode
        ) {
          links.push({ link: directLink.link, type: "series" });
        }
      }
    }
  }

  if (links.length > maxPlaybackLinks) {
    throw apiError(
      422,
      "too_many_playback_links",
      "Provider returned too many playback variants to resolve safely.",
    );
  }
  return links;
}

async function resolveStreams(
  request: StreamRequest,
  provider: ProviderAdapter,
  providerContext: ProviderContext,
  signal: AbortSignal,
  options: Required<
    Pick<
      HandlerOptions,
      "maxSearchResults" | "maxMatchCandidates" | "maxPlaybackLinks" | "maxStreams"
    >
  >,
): Promise<ReturnType<typeof normalizeStreams>> {
  const info = await findMatchedInfo(
    request,
    request.provider,
    provider,
    providerContext,
    signal,
    options.maxSearchResults,
    options.maxMatchCandidates,
  );
  const playbackLinks = await getPlaybackLinks(
    request,
    info,
    provider,
    providerContext,
    options.maxPlaybackLinks,
  );

  const streams: Stream[] = [];
  let failedStreams = 0;
  for (const playback of playbackLinks) {
    try {
      const result = await provider.getStream({
        link: playback.link,
        type: playback.type,
        signal,
        providerContext,
      });
      if (!Array.isArray(result)) {
        throw apiError(
          502,
          "invalid_provider_response",
          "Provider stream lookup returned an invalid response.",
        );
      }
      streams.push(...result);
    } catch (error) {
      if ((error as ApiError).code === "provider_timeout") throw error;
      failedStreams += 1;
    }
  }
  if (failedStreams > 0 && streams.length === 0) {
    throw apiError(502, "provider_error", "Provider could not resolve stream sources.");
  }
  return normalizeStreams(streams, options.maxStreams);
}

export function createStreamsHandler({
  providers,
  providerContext,
  unsupportedProviders = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
  maxSearchResults = MAX_SEARCH_RESULTS,
  maxMatchCandidates = MAX_MATCH_CANDIDATES,
  maxPlaybackLinks = MAX_PLAYBACK_LINKS,
  maxStreams = MAX_STREAMS,
}: HandlerOptions) {
  return async function streamsHandler(
    request: VercelRequest,
    response: VercelResponse,
  ): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      sendError(
        response,
        apiError(405, "method_not_allowed", "Only POST is supported."),
      );
      return;
    }

    const contentTypeHeader = request.headers["content-type"];
    const contentType = Array.isArray(contentTypeHeader)
      ? contentTypeHeader.join(",")
      : contentTypeHeader;
    if (contentType && !contentType.toLowerCase().includes("application/json")) {
      sendError(
        response,
        apiError(415, "unsupported_media_type", "Content-Type must be application/json."),
      );
      return;
    }

    let body: unknown;
    try {
      body = parseBody(request.body);
    } catch (error) {
      sendError(response, error as ApiError);
      return;
    }
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      sendError(
        response,
        apiError(
          400,
          "invalid_request",
          "Request fields are missing or invalid.",
          parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        ),
      );
      return;
    }

    const input = parsed.data;
    const unsupportedReason = unsupportedProviders[input.provider];
    if (unsupportedReason) {
      sendError(
        response,
        apiError(501, "serverless_unsupported", unsupportedReason),
      );
      return;
    }
    const provider = providers[input.provider];
    if (!provider) {
      sendError(
        response,
        apiError(403, "provider_not_allowed", "This provider is not enabled for the API."),
      );
      return;
    }

    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const work = resolveStreams(input, provider, providerContext, controller.signal, {
      maxSearchResults,
      maxMatchCandidates,
      maxPlaybackLinks,
      maxStreams,
    });
    try {
      const streams = await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(apiError(504, "provider_timeout", "Provider request timed out."));
          }, timeoutMs);
        }),
      ]);
      response.status(200).json({ provider: input.provider, streams });
    } catch (error) {
      const knownError = error as ApiError;
      if (knownError.status && knownError.code) {
        sendError(response, knownError);
      } else {
        sendError(
          response,
          apiError(502, "provider_error", "Provider request failed."),
        );
      }
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
}

const serverlessProviderContext: ProviderContext = {
  axios,
  Aes: null,
  commonHeaders: headers,
  cheerio,
  openWebView: async () => {
    throw new Error("Browser interaction is unavailable in serverless functions.");
  },
};

const handler = createStreamsHandler({
  providers: {
    movieBoxWeb: { getSearchPosts, getMeta, getEpisodes, getStream },
  },
  providerContext: serverlessProviderContext,
  unsupportedProviders: {
    primewire:
      "PrimeWire may require CAPTCHA solving through openWebView, which is not supported in serverless functions.",
  },
});

export const config = { maxDuration: 30 };
export default handler;