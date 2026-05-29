function getEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing environment variable: ${key}`);
  return val;
}

const getClientId = () => getEnv("SPOTIFY_CLIENT_ID");
const getClientSecret = () => getEnv("SPOTIFY_CLIENT_SECRET");
const getRedirectUri = () => getEnv("SPOTIFY_REDIRECT_URI");

const SPOTIFY_AUTH_URL = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_API = "https://api.spotify.com/v1";

const SCOPES = [
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-public",
  "playlist-modify-private",
].join(" ");

export function getAuthUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: getClientId(),
    scope: SCOPES,
    redirect_uri: getRedirectUri(),
    state,
  });
  return `${SPOTIFY_AUTH_URL}?${params.toString()}`;
}

export async function exchangeCode(code: string) {
  const res = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization:
        "Basic " +
        Buffer.from(`${getClientId()}:${getClientSecret()}`).toString("base64"),
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: getRedirectUri(),
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);
  return res.json();
}

export async function refreshAccessToken(refreshToken: string, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(SPOTIFY_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization:
          "Basic " +
          Buffer.from(`${getClientId()}:${getClientSecret()}`).toString("base64"),
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });
    if (res.ok) return res.json();

    if ([429, 502, 503].includes(res.status) && attempt < retries) {
      const retryAfter = res.headers.get("Retry-After");
      const wait = retryAfter ? Number(retryAfter) * 1000 : 1000 * 2 ** attempt;
      console.warn(`Token refresh returned ${res.status}, retrying in ${wait}ms...`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }

    throw new Error(`Token refresh failed: ${res.status}`);
  }
  throw new Error(`Token refresh failed after ${retries} retries`);
}

async function spotifyGet(url: string, accessToken: string, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.ok) return res.json();

    // Retry on transient Spotify errors
    if ([429, 502, 503].includes(res.status) && attempt < retries) {
      const retryAfter = res.headers.get("Retry-After");
      const wait = retryAfter ? Number(retryAfter) * 1000 : 1000 * 2 ** attempt;
      console.warn(`Spotify GET ${url} returned ${res.status}, retrying in ${wait}ms...`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }

    const body = await res.text();
    throw new Error(`Spotify GET ${url} failed (${res.status}): ${body}`);
  }
  throw new Error(`Spotify GET ${url} failed after ${retries} retries`);
}

async function spotifyPost(url: string, accessToken: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Spotify POST ${url} failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function spotifyPut(url: string, accessToken: string, body: unknown) {
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Spotify PUT ${url} failed (${res.status}): ${text}`);
  }
  // PUT may return 200 or 201 with no body
  const contentType = res.headers.get("content-type");
  if (contentType?.includes("application/json")) return res.json();
  return null;
}

export interface ArtistInfo {
  name: string;
  uri: string;
  url: string;
}

export interface PlaylistTrack {
  uri: string;
  name: string;
  url: string;
  artists: ArtistInfo[];
  album: string;
  album_uri: string;
  album_url: string;
  album_type: string;
  album_release_date: string;
  album_total_tracks: number;
  album_images: { url: string; width: number; height: number }[];
  label: string;
  disc_number: number;
  track_number: number;
  duration_ms: number;
  explicit: boolean;
  popularity: number;
  preview_url: string;
  isrc: string;
  added_at: string;
  added_by: string;
  is_local: boolean;
}

export interface PlaylistData {
  id: string;
  name: string;
  description: string;
  public: boolean;
  collaborative: boolean;
  owner: string;
  snapshot_id: string;
  total_tracks: number;
  tracks: PlaylistTrack[];
}

export async function getPlaylist(
  playlistId: string,
  accessToken: string
): Promise<PlaylistData> {
  const playlist = await spotifyGet(
    `${SPOTIFY_API}/playlists/${playlistId}`,
    accessToken
  );

  // Resolve the paging object for tracks.
  // Spotify returns tracks under "tracks" (paging obj) or "items" (paging obj).
  // Either way the paging object has { items: [...], next, ... }.
  let pagingObj = playlist.tracks ?? playlist.items ?? playlist;
  // If pagingObj is itself a paging object (has .items array), use it.
  // If pagingObj is already an array, wrap it.
  if (Array.isArray(pagingObj)) {
    pagingObj = { items: pagingObj, next: null };
  } else if (pagingObj && typeof pagingObj === "object" && !Array.isArray(pagingObj.items)) {
    // pagingObj exists but has no items array — log and default
    console.error("Unexpected pagingObj shape:", JSON.stringify(Object.keys(pagingObj)));
    pagingObj = { items: [], next: null };
  }

  const tracks: PlaylistTrack[] = [];

  function pushTrack(item: Record<string, unknown>) {
    // Spotify uses "track" or "item" depending on API version
    const t = (item.track as Record<string, unknown>)
      ?? (item.item as Record<string, unknown>)
      ?? item;
    if (!t || !t.uri) return;
    const album = t.album as Record<string, unknown> | undefined;
    const extUrls = (t.external_urls as Record<string, string>) ?? {};
    const albumExtUrls = (album?.external_urls as Record<string, string>) ?? {};
    const extIds = (t.external_ids as Record<string, string>) ?? {};
    tracks.push({
      uri: t.uri as string,
      name: (t.name as string) ?? "",
      url: extUrls.spotify ?? "",
      artists: Array.isArray(t.artists)
        ? t.artists.map((a: { name: string; uri?: string; external_urls?: { spotify?: string } }) => ({
            name: a.name,
            uri: a.uri ?? "",
            url: a.external_urls?.spotify ?? "",
          }))
        : [],
      album: (album?.name as string) ?? "",
      album_uri: (album?.uri as string) ?? "",
      album_url: albumExtUrls.spotify ?? "",
      album_type: (album?.album_type as string) ?? "",
      album_release_date: (album?.release_date as string) ?? "",
      album_total_tracks: (album?.total_tracks as number) ?? 0,
      album_images: Array.isArray(album?.images) ? album.images : [],
      label: (album?.label as string) ?? "",
      disc_number: (t.disc_number as number) ?? 0,
      track_number: (t.track_number as number) ?? 0,
      duration_ms: (t.duration_ms as number) ?? 0,
      explicit: (t.explicit as boolean) ?? false,
      popularity: (t.popularity as number) ?? 0,
      preview_url: (t.preview_url as string) ?? "",
      isrc: extIds.isrc ?? "",
      added_at: (item.added_at as string) ?? "",
      added_by: (item.added_by as { id?: string })?.id ?? "",
      is_local: (item.is_local as boolean) ?? false,
    });
  }

  for (const item of pagingObj.items) {
    pushTrack(item as Record<string, unknown>);
  }

  let next: string | null = pagingObj.next ?? null;

  while (next) {
    const page = await spotifyGet(next, accessToken);
    for (const item of (page.items ?? [])) {
      pushTrack(item as Record<string, unknown>);
    }
    next = page.next ?? null;
  }

  return {
    id: playlist.id,
    name: playlist.name,
    description: playlist.description ?? "",
    public: playlist.public,
    collaborative: playlist.collaborative,
    owner: playlist.owner.id,
    snapshot_id: playlist.snapshot_id,
    total_tracks: tracks.length,
    tracks,
  };
}

export async function getCurrentUserId(accessToken: string): Promise<string> {
  const me = await spotifyGet(`${SPOTIFY_API}/me`, accessToken);
  return me.id;
}

export interface PlaylistSummary {
  id: string;
  name: string;
  description: string;
  owner: string;
  total_tracks: number;
  image_url: string;
  url: string;
}

export async function getUserPlaylists(accessToken: string): Promise<PlaylistSummary[]> {
  const playlists: PlaylistSummary[] = [];
  let url: string | null = `${SPOTIFY_API}/me/playlists?limit=50`;

  while (url) {
    const data = await spotifyGet(url, accessToken);
    for (const item of data.items ?? []) {
      playlists.push({
        id: item.id,
        name: item.name ?? "",
        description: item.description ?? "",
        owner: item.owner?.display_name ?? item.owner?.id ?? "",
        total_tracks: item.tracks?.total ?? 0,
        image_url: item.images?.[0]?.url ?? "",
        url: item.external_urls?.spotify ?? "",
      });
    }
    url = data.next ?? null;
  }

  return playlists;
}

export async function createPlaylist(
  accessToken: string,
  data: {
    name: string;
    description: string;
    public: boolean;
    collaborative: boolean;
    trackUris: string[];
  }
): Promise<{ id: string; url: string }> {
  const playlist = await spotifyPost(
    `${SPOTIFY_API}/me/playlists`,
    accessToken,
    {
      name: data.name,
      description: data.description,
      public: data.public,
      collaborative: data.collaborative,
    }
  );

  // Add tracks in batches of 100 (Spotify limit)
  const uris = data.trackUris.filter((u) => !u.startsWith("spotify:local:"));
  for (let i = 0; i < uris.length; i += 100) {
    const batch = uris.slice(i, i + 100);
    await spotifyPost(
      `${SPOTIFY_API}/playlists/${playlist.id}/items`,
      accessToken,
      { uris: batch }
    );
  }

  return {
    id: playlist.id,
    url: playlist.external_urls?.spotify ?? `https://open.spotify.com/playlist/${playlist.id}`,
  };
}
