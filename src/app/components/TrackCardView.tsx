"use client";

import React, { useState, useRef, useCallback, useEffect } from "react";

interface TrackData {
  uri: string;
  name: string;
  url?: string;
  artists: { name: string; uri?: string; url?: string }[] | string[];
  album?: string;
  album_url?: string;
  album_images?: { url: string; width: number; height: number }[];
  duration_ms?: number;
  label?: string;
  popularity?: number;
  explicit?: boolean;
  track_number?: number;
  album_release_date?: string;
  [key: string]: unknown;
}

interface PlaylistInfo {
  name: string;
  description?: string;
  owner?: string;
  total_tracks: number;
  id?: string;
}

interface TrackChange {
  index: number;
  name: string;
  status: "modified" | "removed" | "unchanged" | "error";
  detail: string;
}

interface TrackCardViewProps {
  playlist: PlaylistInfo;
  tracks: TrackData[];
  trackChanges?: TrackChange[];
  llmProgress?: { current: number; total: number } | null;
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function getArtistNames(artists: TrackData["artists"]): string {
  if (!artists || artists.length === 0) return "Unknown Artist";
  return artists
    .map((a) => (typeof a === "string" ? a : a.name))
    .join(", ");
}

function getDisplayText(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (value == null) return fallback;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const maybeName = (value as Record<string, unknown>).name;
    if (typeof maybeName === "string") return maybeName;
  }
  return fallback || String(value);
}

function getAlbumArt(
  images?: { url: string; width: number; height: number }[],
  size: "sm" | "md" = "md"
): string | null {
  if (!images || images.length === 0) return null;
  const target = size === "sm" ? 64 : 300;
  const sorted = [...images].sort(
    (a, b) => Math.abs(a.width - target) - Math.abs(b.width - target)
  );
  return sorted[0].url;
}

// --- JSON syntax highlighting ---

function SyntaxHighlightedJson({ data }: { data: unknown }) {
  const json = JSON.stringify(data, null, 2);
  const parts: { text: string; cls: string }[] = [];
  // Regex tokenizer for JSON values
  const re = /("(?:[^"\\]|\\.)*")\s*:|"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\btrue\b|\bfalse\b|\bnull\b/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(json)) !== null) {
    if (m.index > last) {
      parts.push({ text: json.slice(last, m.index), cls: "text-gray-500" });
    }
    const token = m[0];
    if (m[1]) {
      // key
      parts.push({ text: m[1], cls: "text-purple-400" });
      parts.push({ text: token.slice(m[1].length), cls: "text-gray-500" });
    } else if (token.startsWith('"')) {
      parts.push({ text: token, cls: "text-green-400" });
    } else if (token === "true" || token === "false") {
      parts.push({ text: token, cls: "text-yellow-400" });
    } else if (token === "null") {
      parts.push({ text: token, cls: "text-red-400" });
    } else {
      parts.push({ text: token, cls: "text-blue-400" });
    }
    last = m.index + token.length;
  }
  if (last < json.length) {
    parts.push({ text: json.slice(last), cls: "text-gray-500" });
  }
  return (
    <>
      {parts.map((p, i) => (
        <span key={i} className={p.cls}>{p.text}</span>
      ))}
    </>
  );
}

// --- MusicBrainz hover popup ---

interface MbRecording {
  id: string;
  title: string;
  score: number;
  length?: number;
  "first-release-date"?: string;
  isrcs?: string[];
  tags?: { name: string; count: number }[];
  "artist-credit"?: { name: string; artist: { id: string; name: string; disambiguation?: string; type?: string } }[];
  releases?: { id: string; title: string; date?: string; country?: string; "release-group"?: { "primary-type"?: string } }[];
  _labels?: { name: string; id: string; type?: string; catalogNumber?: string; labelCode?: number; country?: string; area?: string; lifeSpan?: { begin?: string; end?: string; ended?: boolean } }[];
}

interface MbResult {
  recordings: MbRecording[];
  count: number;
}

// Simple in-memory cache keyed by "track|||artist"
const mbCache = new Map<string, MbResult | "loading" | "error">();

function MusicBrainzPopup({
  track,
  anchorRect,
}: {
  track: TrackData;
  anchorRect: DOMRect | null;
}) {
  const artistStr = getArtistNames(track.artists);
  const cacheKey = `${track.name}|||${artistStr}`;
  const [data, setData] = useState<MbResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const cached = mbCache.get(cacheKey);
    if (cached && cached !== "loading" && cached !== "error") {
      setData(cached);
      setLoading(false);
      return;
    }
    if (cached === "error") {
      setError("Failed to load");
      setLoading(false);
      return;
    }

    mbCache.set(cacheKey, "loading");
    const params = new URLSearchParams({ track: track.name });
    if (artistStr && artistStr !== "Unknown Artist") params.set("artist", artistStr);

    fetch(`/api/musicbrainz?${params}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json: MbResult) => {
        mbCache.set(cacheKey, json);
        setData(json);
        setLoading(false);
      })
      .catch((err) => {
        mbCache.set(cacheKey, "error");
        setError(String(err));
        setLoading(false);
      });
  }, [cacheKey, track.name, artistStr]);

  // Position the popup near the card
  const style: React.CSSProperties = {
    position: "fixed",
    zIndex: 60,
    maxWidth: 420,
    minWidth: 320,
  };
  if (anchorRect) {
    const midY = anchorRect.top + anchorRect.height / 2;
    const spaceRight = window.innerWidth - anchorRect.right;
    if (spaceRight > 340) {
      style.left = anchorRect.right + 8;
    } else {
      style.right = window.innerWidth - anchorRect.left + 8;
    }
    // Clamp vertically
    style.top = Math.max(8, Math.min(midY - 120, window.innerHeight - 400));
  }

  const rec = data?.recordings?.[0];

  return (
    <div style={style} className="rounded-xl border border-purple-700/60 bg-gray-950/95 shadow-2xl backdrop-blur-md text-sm overflow-hidden">
      {/* MusicBrainz Header */}
      <div className="px-4 py-2.5 border-b border-gray-800 bg-purple-900/20">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-purple-400 shrink-0" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
          </svg>
          <span className="font-semibold text-purple-300 text-xs uppercase tracking-wider">MusicBrainz</span>
        </div>
      </div>

      <div className="px-4 py-3 max-h-[340px] overflow-y-auto space-y-2">
        {loading && (
          <div className="flex items-center gap-2 py-4 justify-center text-gray-400">
            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span className="text-xs">Querying MusicBrainz...</span>
          </div>
        )}

        {error && <div className="text-xs text-red-400 py-2">{error}</div>}

        {!loading && !error && !rec && (
          <div className="text-xs text-gray-500 py-2">No results found on MusicBrainz</div>
        )}

        {rec && (
          <>
            {/* Title + score */}
            <div>
              <a
                href={`https://musicbrainz.org/recording/${rec.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-white font-semibold hover:text-purple-300 transition-colors"
              >
                {rec.title}
              </a>
              <span className="ml-2 text-[10px] text-gray-500">score {rec.score}%</span>
            </div>

            {/* Artists */}
            {rec["artist-credit"] && rec["artist-credit"].length > 0 && (
              <div className="text-xs text-gray-400">
                <span className="text-gray-600 mr-1">Artists:</span>
                {rec["artist-credit"].map((ac, i) => (
                  <span key={ac.artist.id}>
                    {i > 0 && ", "}
                    <a
                      href={`https://musicbrainz.org/artist/${ac.artist.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-purple-400 hover:text-purple-300"
                    >
                      {ac.name}
                    </a>
                    {ac.artist.disambiguation && (
                      <span className="text-gray-600"> ({ac.artist.disambiguation})</span>
                    )}
                  </span>
                ))}
              </div>
            )}

            {/* Length + first release */}
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-400">
              {rec.length && (
                <span>
                  <span className="text-gray-600">Length:</span> {formatDuration(rec.length)}
                </span>
              )}
              {rec["first-release-date"] && (
                <span>
                  <span className="text-gray-600">First release:</span> {rec["first-release-date"]}
                </span>
              )}
            </div>

            {/* ISRCs */}
            {rec.isrcs && rec.isrcs.length > 0 && (
              <div className="text-xs text-gray-400">
                <span className="text-gray-600">ISRC:</span>{" "}
                {rec.isrcs.slice(0, 3).join(", ")}
                {rec.isrcs.length > 3 && <span className="text-gray-600"> +{rec.isrcs.length - 3} more</span>}
              </div>
            )}

            {/* Tags */}
            {rec.tags && rec.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {rec.tags
                  .sort((a, b) => b.count - a.count)
                  .slice(0, 8)
                  .map((tag) => (
                    <span
                      key={tag.name}
                      className="px-1.5 py-0.5 rounded bg-purple-900/40 text-purple-300 text-[10px] border border-purple-800/40"
                    >
                      {tag.name}
                    </span>
                  ))}
              </div>
            )}

            {/* Releases */}
            {rec.releases && rec.releases.length > 0 && (
              <div className="mt-1">
                <span className="text-[10px] text-gray-600 uppercase tracking-wider">Releases</span>
                <div className="mt-1 space-y-1">
                  {rec.releases.slice(0, 4).map((rel) => (
                    <a
                      key={rel.id}
                      href={`https://musicbrainz.org/release/${rel.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block text-xs text-gray-400 hover:text-purple-300 truncate"
                    >
                      {rel.title}
                      {rel.date && <span className="text-gray-600"> ({rel.date})</span>}
                      {rel.country && <span className="text-gray-600"> [{rel.country}]</span>}
                      {rel["release-group"]?.["primary-type"] && (
                        <span className="text-gray-600"> &middot; {rel["release-group"]["primary-type"]}</span>
                      )}
                    </a>
                  ))}
                  {rec.releases.length > 4 && (
                    <span className="text-[10px] text-gray-600">+{rec.releases.length - 4} more releases</span>
                  )}
                </div>
              </div>
            )}

            {/* Label info */}
            {rec._labels && rec._labels.length > 0 && (
              <div className="mt-1 pt-1 border-t border-gray-800">
                <span className="text-[10px] text-gray-600 uppercase tracking-wider">Labels</span>
                <div className="mt-1 space-y-1.5">
                  {rec._labels.map((lbl, i) => (
                    <div key={lbl.id} className="text-xs">
                      <div className="flex items-baseline gap-1.5">
                        <a
                          href={`https://musicbrainz.org/label/${lbl.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium text-gray-300 hover:text-purple-300 transition-colors"
                        >
                          {lbl.name}
                        </a>
                        {lbl.type && (
                          <span className="text-[10px] text-gray-600">({lbl.type})</span>
                        )}
                        {lbl.catalogNumber && (
                          <span className="text-[10px] text-gray-600">#{lbl.catalogNumber}</span>
                        )}
                      </div>
                      {i === 0 && lbl.country && (
                        <div className="text-gray-400 mt-0.5">
                          <span className="text-gray-600">Country:</span>{" "}
                          {lbl.area || lbl.country}
                          {lbl.area && lbl.country && lbl.area !== lbl.country && (
                            <span className="text-gray-600"> [{lbl.country}]</span>
                          )}
                        </div>
                      )}
                      {i === 0 && lbl.lifeSpan?.begin && (
                        <div className="text-gray-400 mt-0.5">
                          <span className="text-gray-600">Founded:</span> {lbl.lifeSpan.begin}
                          {lbl.lifeSpan.ended && lbl.lifeSpan.end && (
                            <span> — {lbl.lifeSpan.end}</span>
                          )}
                        </div>
                      )}
                      {lbl.labelCode && (
                        <div className="text-gray-500 text-[10px]">LC-{String(lbl.labelCode).padStart(5, "0")}</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Other results count */}
            {data && data.count > 1 && (
              <div className="text-[10px] text-gray-600 pt-1 border-t border-gray-800">
                Showing best match of {data.count} results
              </div>
            )}
          </>
        )}
      </div>

      {/* Track JSON section */}
      <div className="border-t border-gray-800">
        <div className="px-4 py-2 flex items-center gap-2 bg-gray-900/60">
          <svg className="w-3.5 h-3.5 text-green-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
          </svg>
          <span className="font-semibold text-green-300 text-xs uppercase tracking-wider">Track JSON</span>
        </div>
        <pre className="px-4 py-2 max-h-[200px] overflow-auto text-[10px] font-mono leading-relaxed bg-gray-950/80 border-t border-gray-800">
          <SyntaxHighlightedJson data={track} />
        </pre>
      </div>
    </div>
  );
}

// --- MusicBrainz artist hover popup ---

interface MbArtist {
  id: string;
  name: string;
  score: number;
  type?: string;
  disambiguation?: string;
  country?: string;
  "life-span"?: { begin?: string; end?: string; ended?: boolean };
  "begin-area"?: { name: string };
  area?: { name: string };
  tags?: { name: string; count: number }[];
  "gender"?: string;
  ipis?: string[];
  isnis?: string[];
}

interface MbArtistResult {
  artists: MbArtist[];
  count: number;
}

const mbArtistCache = new Map<string, MbArtistResult | "loading" | "error">();

function ArtistMbPopup({
  artistName,
  anchorRect,
}: {
  artistName: string;
  anchorRect: DOMRect | null;
}) {
  const cacheKey = `artist:${artistName}`;
  const [data, setData] = useState<MbArtistResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const cached = mbArtistCache.get(cacheKey);
    if (cached && cached !== "loading" && cached !== "error") {
      setData(cached);
      setLoading(false);
      return;
    }
    if (cached === "error") {
      setError("Failed to load");
      setLoading(false);
      return;
    }

    mbArtistCache.set(cacheKey, "loading");
    const params = new URLSearchParams({ type: "artist", name: artistName });

    fetch(`/api/musicbrainz?${params}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json: MbArtistResult) => {
        mbArtistCache.set(cacheKey, json);
        setData(json);
        setLoading(false);
      })
      .catch((err) => {
        mbArtistCache.set(cacheKey, "error");
        setError(String(err));
        setLoading(false);
      });
  }, [cacheKey, artistName]);

  const style: React.CSSProperties = {
    position: "fixed",
    zIndex: 70,
    maxWidth: 400,
    minWidth: 300,
  };
  if (anchorRect) {
    const spaceRight = window.innerWidth - anchorRect.right;
    if (spaceRight > 320) {
      style.left = anchorRect.right + 8;
    } else {
      style.right = window.innerWidth - anchorRect.left + 8;
    }
    style.top = Math.max(8, Math.min(anchorRect.top - 40, window.innerHeight - 360));
  }

  const art = data?.artists?.[0];

  return (
    <div style={style} className="rounded-xl border border-blue-700/60 bg-gray-950/95 shadow-2xl backdrop-blur-md text-sm overflow-hidden">
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-gray-800 bg-blue-900/20">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-blue-400 shrink-0" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
          </svg>
          <span className="font-semibold text-blue-300 text-xs uppercase tracking-wider">MusicBrainz Artist</span>
        </div>
      </div>

      <div className="px-4 py-3 max-h-[320px] overflow-y-auto space-y-2">
        {loading && (
          <div className="flex items-center gap-2 py-4 justify-center text-gray-400">
            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span className="text-xs">Querying MusicBrainz...</span>
          </div>
        )}

        {error && <div className="text-xs text-red-400 py-2">{error}</div>}

        {!loading && !error && !art && (
          <div className="text-xs text-gray-500 py-2">No artist found on MusicBrainz</div>
        )}

        {art && (
          <>
            {/* Name + score */}
            <div>
              <a
                href={`https://musicbrainz.org/artist/${art.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-white font-semibold hover:text-blue-300 transition-colors"
              >
                {art.name}
              </a>
              <span className="ml-2 text-[10px] text-gray-500">score {art.score}%</span>
              {art.disambiguation && (
                <span className="ml-1 text-[10px] text-gray-500">({art.disambiguation})</span>
              )}
            </div>

            {/* Type + Gender + Country */}
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-400">
              {art.type && (
                <span><span className="text-gray-600">Type:</span> {art.type}</span>
              )}
              {art.gender && (
                <span><span className="text-gray-600">Gender:</span> {art.gender}</span>
              )}
              {art.country && (
                <span><span className="text-gray-600">Country:</span> {art.country}</span>
              )}
            </div>

            {/* Area */}
            {art.area && (
              <div className="text-xs text-gray-400">
                <span className="text-gray-600">Area:</span> {art.area.name}
              </div>
            )}
            {art["begin-area"] && art["begin-area"].name !== art.area?.name && (
              <div className="text-xs text-gray-400">
                <span className="text-gray-600">Origin:</span> {art["begin-area"].name}
              </div>
            )}

            {/* Life span */}
            {art["life-span"] && (art["life-span"].begin || art["life-span"].end) && (
              <div className="text-xs text-gray-400">
                <span className="text-gray-600">Active:</span>{" "}
                {art["life-span"].begin || "?"}
                {" — "}
                {art["life-span"].ended ? (art["life-span"].end || "?") : "present"}
              </div>
            )}

            {/* IPI / ISNI */}
            {art.ipis && art.ipis.length > 0 && (
              <div className="text-xs text-gray-400">
                <span className="text-gray-600">IPI:</span> {art.ipis.slice(0, 2).join(", ")}
              </div>
            )}
            {art.isnis && art.isnis.length > 0 && (
              <div className="text-xs text-gray-400">
                <span className="text-gray-600">ISNI:</span> {art.isnis.slice(0, 2).join(", ")}
              </div>
            )}

            {/* Tags */}
            {art.tags && art.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {art.tags
                  .sort((a, b) => b.count - a.count)
                  .slice(0, 10)
                  .map((tag) => (
                    <span
                      key={tag.name}
                      className="px-1.5 py-0.5 rounded bg-blue-900/40 text-blue-300 text-[10px] border border-blue-800/40"
                    >
                      {tag.name}
                    </span>
                  ))}
              </div>
            )}

            {data && data.count > 1 && (
              <div className="text-[10px] text-gray-600 pt-1 border-t border-gray-800">
                Showing best match of {data.count} results
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function HoverableArtistName({ name }: { name: string }) {
  const [showPopup, setShowPopup] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const spanRef = useRef<HTMLSpanElement>(null);

  const onEnter = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    timerRef.current = setTimeout(() => {
      if (spanRef.current) setRect(spanRef.current.getBoundingClientRect());
      setShowPopup(true);
    }, 400);
  }, []);

  const onLeave = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (timerRef.current) clearTimeout(timerRef.current);
    setShowPopup(false);
  }, []);

  return (
    <span
      ref={spanRef}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      className="hover:text-blue-400 cursor-default transition-colors"
    >
      {name}
      {showPopup && <ArtistMbPopup artistName={name} anchorRect={rect} />}
    </span>
  );
}

function TrackCard({
  track,
  index,
  onShowJson,
  llmStatus,
  changeDetail,
}: {
  track: TrackData;
  index: number;
  onShowJson: (track: TrackData) => void;
  llmStatus?: "modified" | "removed" | "unchanged" | "error" | "processing" | "pending";
  changeDetail?: string;
}) {
  const art = getAlbumArt(track.album_images, "md");
  const trackName = getDisplayText(track.name, "Unknown Track");
  const albumName = getDisplayText(track.album, "");
  const albumYear = getDisplayText(track.album_release_date, "").slice(0, 4);
  const spotifyUrl =
    track.url || `https://open.spotify.com/track/${track.uri?.split(":").pop()}`;

  // MusicBrainz hover state
  const [showMb, setShowMb] = useState(false);
  const [cardRect, setCardRect] = useState<DOMRect | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [showErrorDetail, setShowErrorDetail] = useState(false);
  const fullErrorDetail = changeDetail ?? "Unknown error";

  const handleMouseEnter = useCallback(() => {
    hoverTimerRef.current = setTimeout(() => {
      if (cardRef.current) setCardRect(cardRef.current.getBoundingClientRect());
      setShowMb(true);
    }, 500);
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    setShowMb(false);
  }, []);

  return (
    <div
      ref={cardRef}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className={`group relative flex gap-3 rounded-xl p-3 transition-all duration-200 ${
        llmStatus === "modified" ? "bg-green-950/40 border border-green-500/50 hover:bg-green-950/60 hover:border-green-400/60" :
        llmStatus === "removed" ? "bg-red-950/40 border border-red-500/50 hover:bg-red-950/60 hover:border-red-400/60 opacity-60" :
        llmStatus === "error" ? "bg-amber-950/30 border border-amber-500/50 hover:bg-amber-950/50 hover:border-amber-400/60" :
        llmStatus === "unchanged" ? "bg-gray-900/40 border border-gray-500/40 hover:bg-gray-800/50 hover:border-gray-400/50" :
        llmStatus === "processing" ? "bg-purple-950/40 border border-purple-500/60 hover:bg-purple-950/60 hover:border-purple-400/70 animate-pulse" :
        llmStatus === "pending" ? "bg-gray-900/40 border border-gray-700/40 opacity-50" :
        "bg-gray-900/70 border border-gray-800 hover:bg-gray-800/80 hover:border-gray-700"
      }`}
    >
      {showMb && <MusicBrainzPopup track={track} anchorRect={cardRect} />}
      {/* Track number + LLM status badge */}
      <div className="absolute top-2 left-2 flex items-center gap-1">
        <span className="text-[10px] font-mono text-gray-600 leading-none">{index + 1}</span>
        {llmStatus === "modified" && <span className="text-[8px] font-bold text-green-400 uppercase">mod</span>}
        {llmStatus === "removed" && <span className="text-[8px] font-bold text-red-400 uppercase">del</span>}
        {llmStatus === "error" && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setShowErrorDetail(true);
            }}
            className="text-[8px] font-bold text-amber-400 uppercase hover:text-amber-300 underline decoration-dotted"
            title="Click to view full error"
          >
            err
          </button>
        )}
        {llmStatus === "unchanged" && <span className="text-[8px] font-bold text-gray-400 uppercase">ok</span>}
        {llmStatus === "processing" && <span className="text-[8px] font-bold text-purple-400 uppercase animate-pulse">...</span>}
      </div>

      {/* Album art */}
      <div className="shrink-0 mt-1">
        {art ? (
          <img
            src={art}
            alt={albumName || trackName}
            className="w-16 h-16 rounded-lg object-cover shadow-md"
            loading="lazy"
          />
        ) : (
          <div className="w-16 h-16 rounded-lg bg-gray-800 flex items-center justify-center">
            <svg
              className="w-6 h-6 text-gray-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"
              />
            </svg>
          </div>
        )}
      </div>

      {/* Track info */}
      <div className="flex-1 min-w-0 flex flex-col justify-center gap-0.5">
        <a
          href={spotifyUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-semibold text-white truncate hover:text-green-400 transition-colors leading-tight"
          title={trackName}
        >
          {trackName}
          {track.explicit && (
            <span className="ml-1.5 inline-block px-1 py-0.5 text-[9px] font-bold bg-gray-700 text-gray-400 rounded leading-none align-middle">
              E
            </span>
          )}
        </a>
        <span className="text-xs text-gray-400 truncate" title={getArtistNames(track.artists)}>
          {track.artists && track.artists.length > 0
            ? track.artists.map((a, i) => {
                const name = typeof a === "string" ? a : a.name;
                return (
                  <React.Fragment key={name + i}>
                    {i > 0 && ", "}
                    <HoverableArtistName name={name} />
                  </React.Fragment>
                );
              })
            : "Unknown Artist"}
        </span>
        {albumName && (
          <span className="text-xs text-gray-500 truncate" title={albumName}>
            {albumName}
            {albumYear && (
              <span className="text-gray-600">
                {" "}
                &middot; {albumYear}
              </span>
            )}
          </span>
        )}
      </div>

      {/* Metadata changes */}
      {changeDetail && llmStatus === "modified" && (
        <div className="absolute bottom-1 left-20 right-2 overflow-hidden">
          <div className="flex flex-wrap gap-1">
            {changeDetail.split(" | ").map((diff, i) => (
              <span key={i} className="text-[9px] font-mono px-1 py-0.5 rounded bg-green-900/60 text-green-300 truncate max-w-[180px]" title={diff}>
                {diff}
              </span>
            ))}
          </div>
        </div>
      )}
      {changeDetail && llmStatus === "removed" && (
        <div className="absolute bottom-1 left-20 right-2 overflow-hidden">
          <span className="text-[9px] font-mono px-1 py-0.5 rounded bg-red-900/60 text-red-300">
            {changeDetail}
          </span>
        </div>
      )}
      {changeDetail && llmStatus === "error" && (
        <div className="absolute bottom-1 left-20 right-2 overflow-hidden">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setShowErrorDetail(true);
            }}
            className="text-[9px] font-mono px-1 py-0.5 rounded bg-amber-900/60 text-amber-300 truncate block w-full text-left hover:bg-amber-800/60"
            title="Click to view full error"
          >
            {changeDetail}
          </button>
        </div>
      )}

      {showErrorDetail && llmStatus === "error" && (
        <div
          className="fixed inset-0 z-[80] bg-black/60 flex items-center justify-center p-4"
          onClick={(e) => {
            e.stopPropagation();
            setShowErrorDetail(false);
          }}
        >
          <div
            className="w-full max-w-2xl rounded-xl border border-amber-700/60 bg-gray-950 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
              <h4 className="text-sm font-semibold text-amber-300">Track Error</h4>
              <button
                type="button"
                onClick={() => setShowErrorDetail(false)}
                className="text-xs text-gray-400 hover:text-white"
              >
                Close
              </button>
            </div>
            <div className="px-4 py-3">
              <div className="text-xs text-gray-400 mb-2">{trackName}</div>
              <pre className="text-xs text-amber-200 whitespace-pre-wrap break-words leading-relaxed max-h-[55vh] overflow-y-auto">
                {fullErrorDetail}
              </pre>
            </div>
          </div>
        </div>
      )}

      {/* Right side: duration + actions */}
      <div className="shrink-0 flex flex-col items-end justify-between py-0.5">
        {track.duration_ms ? (
          <span className="text-xs text-gray-500 font-mono tabular-nums">
            {formatDuration(track.duration_ms)}
          </span>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {track.popularity !== undefined && track.popularity > 0 && (
            <span
              className="text-[10px] text-gray-500"
              title={`Popularity: ${track.popularity}`}
            >
              {track.popularity}
            </span>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onShowJson(track);
            }}
            className="p-1 rounded hover:bg-gray-700 text-gray-500 hover:text-gray-300 transition-colors"
            title="Show JSON"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"
              />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

export default function TrackCardView({ playlist, tracks, trackChanges, llmProgress }: TrackCardViewProps) {
  const [jsonModal, setJsonModal] = useState<TrackData | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const totalDuration = tracks.reduce((s, t) => s + (t.duration_ms || 0), 0);

  const filtered = searchQuery.trim()
    ? tracks.filter((t) => {
        const q = searchQuery.toLowerCase();
        const name = getDisplayText(t.name, "").toLowerCase();
        const album = getDisplayText(t.album, "").toLowerCase();
        const label = getDisplayText(t.label, "").toLowerCase();
        return (
          name.includes(q) ||
          getArtistNames(t.artists).toLowerCase().includes(q) ||
          album.includes(q) ||
          label.includes(q)
        );
      })
    : tracks;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Playlist header */}
      <div className="shrink-0 px-6 py-4 border-b border-gray-800 bg-gradient-to-r from-gray-900 to-gray-950">
        <h2 className="text-2xl font-bold text-white">{playlist.name}</h2>
        <div className="flex items-center gap-3 mt-1 text-sm text-gray-400">
          {playlist.owner && <span>by {playlist.owner}</span>}
          <span>&middot;</span>
          <span>{playlist.total_tracks} tracks</span>
          {totalDuration > 0 && (
            <>
              <span>&middot;</span>
              <span>{formatDuration(totalDuration)}</span>
            </>
          )}
        </div>
        {playlist.description && (
          <p className="mt-1 text-xs text-gray-500 max-w-xl">{playlist.description}</p>
        )}

        {/* Search within tracks */}
        <div className="mt-3 max-w-sm">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter tracks..."
            className="w-full rounded-lg border border-gray-700 bg-gray-800/50 px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:border-green-500 focus:outline-none"
          />
        </div>
      </div>

      {/* Track grid */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-40 text-gray-500 text-sm">
            {searchQuery ? "No tracks match your filter" : "No tracks loaded"}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {filtered.map((track, i) => (
              <TrackCard
                key={track.uri || i}
                track={track}
                index={searchQuery ? i : tracks.indexOf(track)}
                onShowJson={setJsonModal}
                llmStatus={
                  trackChanges && trackChanges.length > 0
                    ? (() => {
                        const realIdx = searchQuery ? tracks.indexOf(track) : i;
                        const change = trackChanges.find((c) => c.index === realIdx);
                        if (change) return change.status;
                        if (llmProgress && realIdx === llmProgress.current) return "processing" as const;
                        if (llmProgress && realIdx > llmProgress.current) return "pending" as const;
                        return undefined;
                      })()
                    : llmProgress
                    ? (() => {
                        const realIdx = searchQuery ? tracks.indexOf(track) : i;
                        if (realIdx === llmProgress.current) return "processing" as const;
                        if (realIdx > llmProgress.current) return "pending" as const;
                        return undefined;
                      })()
                    : undefined
                }
                changeDetail={
                  trackChanges && trackChanges.length > 0
                    ? (() => {
                        const realIdx = searchQuery ? tracks.indexOf(track) : i;
                        const change = trackChanges.find((c) => c.index === realIdx);
                        return change?.detail;
                      })()
                    : undefined
                }
              />
            ))}
          </div>
        )}
        {searchQuery && filtered.length > 0 && filtered.length < tracks.length && (
          <div className="text-center text-xs text-gray-500 mt-4">
            Showing {filtered.length} of {tracks.length} tracks
          </div>
        )}
      </div>

      {/* JSON modal */}
      {jsonModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setJsonModal(null)}
        >
          <div
            className="relative bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
              <h3 className="text-sm font-semibold text-white truncate">
                {getDisplayText(jsonModal.name, "Track")}
              </h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(
                      JSON.stringify(jsonModal, null, 2)
                    );
                  }}
                  className="text-xs text-gray-400 hover:text-white transition-colors px-2 py-1 rounded hover:bg-gray-800"
                >
                  Copy
                </button>
                <button
                  onClick={() => setJsonModal(null)}
                  className="text-gray-400 hover:text-white transition-colors"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </div>
            </div>
            <pre className="flex-1 overflow-auto p-4 text-xs text-gray-300 font-mono leading-relaxed">
              {JSON.stringify(jsonModal, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
