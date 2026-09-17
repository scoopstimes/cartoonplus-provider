const urlsEndpoint =
  "https://raw.githubusercontent.com/d0x-dev/airflix-providers/refs/heads/main/urls.json";
const cacheTtl = 60 * 60 * 1000;

type ProviderUrls = Record<string, { url: string }>;

type BaseUrlCache = {
  data?: ProviderUrls;
  expiresAt: number;
  request?: Promise<ProviderUrls>;
};

type ProviderState = {
  __airflixProviderBaseUrlCache__?: BaseUrlCache;
  __valoraFilmProviderBaseUrlCache__?: BaseUrlCache;
};

declare const providerGlobal: ProviderState | undefined;

function getCache(): BaseUrlCache {
  const state =
    typeof providerGlobal !== "undefined" && providerGlobal
      ? providerGlobal
      : (globalThis as typeof globalThis & ProviderState);

  state.__valoraFilmProviderBaseUrlCache__ ??=
    state.__airflixProviderBaseUrlCache__ ?? { expiresAt: 0 };
  state.__airflixProviderBaseUrlCache__ ??=
    state.__valoraFilmProviderBaseUrlCache__;
  return state.__valoraFilmProviderBaseUrlCache__;
}

async function fetchProviderUrls(): Promise<ProviderUrls> {
  const cache = getCache();

  if (cache.data && Date.now() < cache.expiresAt) {
    return cache.data;
  }

  if (cache.request) {
    return cache.request;
  }

  const request = fetch(urlsEndpoint)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`URL configuration request failed: ${response.status}`);
      }

      const data = (await response.json()) as ProviderUrls;
      console.log("Fetched provider URL configuration");
      cache.data = data;
      cache.expiresAt = Date.now() + cacheTtl;
      return data;
    })
    .catch((error) => {
      if (cache.data) {
        console.warn("Using stale provider URL configuration", error);
        return cache.data;
      }

      throw error;
    })
    .finally(() => {
      cache.request = undefined;
    });

  Object.defineProperty(cache, "request", {
    configurable: true,
    enumerable: false,
    value: request,
    writable: true,
  });
  return request;
}

export const getBaseUrl = async (providerValue: string) => {
  try {
    const providerUrls = await fetchProviderUrls();
    if (providerValue === "valorafilm") {
      return (
        providerUrls["valorafilm"]?.url ??
        providerUrls["airflix"]?.url ??
        "https://vegamovies.catering"
      );
    }
    return providerUrls[providerValue]?.url ?? "";
  } catch (error) {
    console.error(`Error fetching baseUrl: ${providerValue}`, error);
    if (providerValue === "valorafilm" || providerValue === "airflix") {
      return "https://vegamovies.catering";
    }
    throw error;
  }
};
