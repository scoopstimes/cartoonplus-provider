import assert from "node:assert/strict";
import { test } from "node:test";
import type { Info, ProviderContext, Stream } from "../providers/types";
import { createStreamsHandler } from "../api/streams";

const movieInfo: Info = {
  title: "Example Film",
  image: "",
  synopsis: "",
  imdbId: "",
  type: "movie",
  tags: ["2024"],
  linkList: [
    {
      title: "Original",
      directLinks: [{ title: "Movie", link: "playback:movie", type: "movie" }],
    },
  ],
};

const baseRequest = {
  provider: "mockProvider",
  tmdbId: "123",
  title: "Example Film",
  year: 2024,
  mediaType: "movie",
};

function createResponse() {
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    status(statusCode: number) {
      this.statusCode = statusCode;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
}

function invoke(
  providers: Record<string, any>,
  body: unknown,
  options: { timeoutMs?: number; unsupportedProviders?: Record<string, string> } = {},
) {
  const response = createResponse();
  const handler = createStreamsHandler({
    providers,
    providerContext: {} as ProviderContext,
    ...options,
  });
  const request = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  } as Parameters<ReturnType<typeof createStreamsHandler>>[0];
  return handler(
    request,
    response as unknown as Parameters<ReturnType<typeof createStreamsHandler>>[1],
  ).then(() => response);
}

function movieProvider(streams: Stream[] = []) {
  return {
    mockProvider: {
      getSearchPosts: async () => [
        { title: "Example Film (2024)", link: "/film", image: "" },
      ],
      getMeta: async () => movieInfo,
      getStream: async () => streams,
    },
  };
}

test("returns normalized movie streams", async () => {
  const response = await invoke(
    movieProvider([
      {
        server: "Example",
        link: "https://cdn.example/video.m3u8",
        type: "M3U8",
        quality: "1080",
        headers: { Referer: "https://site.example/" },
      },
    ]),
    baseRequest,
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    provider: "mockProvider",
    streams: [
      {
        server: "Example",
        link: "https://cdn.example/video.m3u8",
        type: "m3u8",
        quality: "1080",
        headers: { Referer: "https://site.example/" },
        subtitles: [],
      },
    ],
  });
});

test("resolves the requested series episode", async () => {
  const calls: string[] = [];
  const seriesInfo: Info = {
    ...movieInfo,
    type: "series",
    linkList: [{ title: "Original", episodesLink: "season:1" }],
  };
  const response = await invoke(
    {
      mockProvider: {
        getSearchPosts: async () => [
          { title: "Example Film", link: "/series", image: "" },
        ],
        getMeta: async () => seriesInfo,
        getEpisodes: async ({ url }: { url: string }) => {
          assert.equal(url, "season:1");
          return [
            { title: "S01 E01", link: "episode:1" },
            { title: "S01 E02", link: "episode:2" },
          ];
        },
        getStream: async ({ link }: { link: string }) => {
          calls.push(link);
          return [{ server: "Episode source", link: "https://cdn.example/ep2.mp4", type: "mp4" }];
        },
      },
    },
    { ...baseRequest, mediaType: "series", season: 1, episode: 2 },
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, ["episode:2"]);
  assert.equal((response.body as { streams: unknown[] }).streams.length, 1);
});

test("returns an empty stream list when provider has no sources", async () => {
  const response = await invoke(movieProvider(), baseRequest);
  assert.deepEqual(response.body, { provider: "mockProvider", streams: [] });
});

test("rejects providers outside the static allowlist", async () => {
  const response = await invoke({}, { ...baseRequest, provider: "notAllowed" });
  assert.equal(response.statusCode, 403);
  assert.equal((response.body as any).error.code, "provider_not_allowed");
});

test("rejects malformed input and client-supplied URLs", async () => {
  const response = await invoke(movieProvider(), {
    ...baseRequest,
    title: "",
    url: "https://attacker.example/",
  });
  assert.equal(response.statusCode, 400);
  assert.equal((response.body as any).error.code, "invalid_request");
});

test("returns 501 for a provider requiring browser interaction", async () => {
  const response = await invoke(
    {},
    { ...baseRequest, provider: "primewire" },
    { unsupportedProviders: { primewire: "CAPTCHA browser interaction is unavailable." } },
  );
  assert.equal(response.statusCode, 501);
  assert.equal((response.body as any).error.code, "serverless_unsupported");
});

test("aborts search and returns 504 when provider work times out", async () => {
  let signalAborted = false;
  const providers = {
    mockProvider: {
      getSearchPosts: ({ signal }: { signal: AbortSignal }) =>
        new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => {
            signalAborted = true;
            reject(new Error("aborted"));
          });
        }),
      getMeta: async () => movieInfo,
      getStream: async () => [],
    },
  };

  const response = await invoke(providers, baseRequest, { timeoutMs: 5 });
  assert.equal(response.statusCode, 504);
  assert.equal((response.body as any).error.code, "provider_timeout");
  assert.equal(signalAborted, true);
});