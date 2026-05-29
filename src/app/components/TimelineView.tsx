"use client";

import React, { useState, useMemo } from "react";

interface TrackData {
  uri: string;
  name: string;
  url?: string;
  artists: { name: string; uri?: string; url?: string }[] | string[];
  album?: string;
  album_url?: string;
  album_images?: { url: string; width: number; height: number }[];
  album_release_date?: string;
  duration_ms?: number;
  label?: string;
  popularity?: number;
  explicit?: boolean;
  added_at?: string;
  [key: string]: unknown;
}

interface PlaylistInfo {
  name: string;
  description?: string;
  owner?: string;
  total_tracks: number;
  id?: string;
}

interface TimelineViewProps {
  playlist: PlaylistInfo;
  tracks: TrackData[];
}

type DateMode = "added" | "release";

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
  images?: { url: string; width: number; height: number }[]
): string | null {
  if (!images || images.length === 0) return null;
  const sorted = [...images].sort(
    (a, b) => Math.abs(a.width - 64) - Math.abs(b.width - 64)
  );
  return sorted[0].url;
}

function getDateKey(track: TrackData, mode: DateMode): string {
  const raw = mode === "added" ? track.added_at : track.album_release_date;
  if (!raw) return "Unknown";
  // Normalize to YYYY-MM-DD or YYYY-MM or YYYY
  return raw.slice(0, 10);
}

function formatDateLabel(dateStr: string): string {
  if (dateStr === "Unknown") return "Unknown Date";
  try {
    // Handle partial dates (YYYY or YYYY-MM)
    if (dateStr.length === 4) return dateStr;
    if (dateStr.length === 7) {
      const d = new Date(dateStr + "-01");
      return d.toLocaleDateString("en-US", { year: "numeric", month: "long" });
    }
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return dateStr;
  }
}

interface GroupedTracks {
  date: string;
  label: string;
  tracks: TrackData[];
}

export default function TimelineView({ playlist, tracks }: TimelineViewProps) {
  const [dateMode, setDateMode] = useState<DateMode>("added");
  const [searchQuery, setSearchQuery] = useState("");

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return tracks;
    const q = searchQuery.toLowerCase();
    return tracks.filter(
      (t) =>
        getDisplayText(t.name, "").toLowerCase().includes(q) ||
        getArtistNames(t.artists).toLowerCase().includes(q) ||
        getDisplayText(t.album, "").toLowerCase().includes(q)
    );
  }, [tracks, searchQuery]);

  const groups: GroupedTracks[] = useMemo(() => {
    const map = new Map<string, TrackData[]>();
    for (const track of filtered) {
      const key = getDateKey(track, dateMode);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(track);
    }
    // Sort groups by date descending (newest first), "Unknown" at end
    const entries = Array.from(map.entries()).sort((a, b) => {
      if (a[0] === "Unknown") return 1;
      if (b[0] === "Unknown") return -1;
      return b[0].localeCompare(a[0]);
    });
    return entries.map(([date, tracks]) => ({
      date,
      label: formatDateLabel(date),
      tracks,
    }));
  }, [filtered, dateMode]);

  const totalDuration = tracks.reduce((s, t) => s + (t.duration_ms || 0), 0);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
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

        {/* Controls */}
        <div className="flex items-center gap-4 mt-3">
          {/* Date mode toggle */}
          <div className="flex rounded-lg border border-gray-700 overflow-hidden">
            <button
              onClick={() => setDateMode("added")}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                dateMode === "added"
                  ? "bg-green-600 text-white"
                  : "text-gray-400 hover:text-white hover:bg-gray-800"
              }`}
            >
              Date Added
            </button>
            <button
              onClick={() => setDateMode("release")}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                dateMode === "release"
                  ? "bg-green-600 text-white"
                  : "text-gray-400 hover:text-white hover:bg-gray-800"
              }`}
            >
              Release Date
            </button>
          </div>

          {/* Search */}
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter tracks..."
            className="max-w-sm rounded-lg border border-gray-700 bg-gray-800/50 px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:border-green-500 focus:outline-none"
          />

          <span className="text-xs text-gray-500">
            {groups.length} date{groups.length !== 1 ? "s" : ""} &middot;{" "}
            {filtered.length} track{filtered.length !== 1 ? "s" : ""}
          </span>
        </div>
      </div>

      {/* Timeline content */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {groups.length === 0 ? (
          <div className="flex items-center justify-center h-40 text-gray-500 text-sm">
            {searchQuery ? "No tracks match your filter" : "No tracks loaded"}
          </div>
        ) : (
          <div className="relative">
            {/* Vertical line */}
            <div className="absolute left-[7px] top-2 bottom-2 w-px bg-gray-700" />

            <div className="space-y-6">
              {groups.map((group) => (
                <div key={group.date} className="relative">
                  {/* Date marker */}
                  <div className="flex items-center gap-3 mb-2">
                    <div className="w-[15px] h-[15px] rounded-full bg-green-600 border-2 border-green-400 shrink-0 z-10" />
                    <h3 className="text-sm font-semibold text-green-400">
                      {group.label}
                    </h3>
                    <span className="text-xs text-gray-500">
                      {group.tracks.length} track{group.tracks.length !== 1 ? "s" : ""}
                    </span>
                  </div>

                  {/* Tracks in this date group */}
                  <div className="ml-[30px] space-y-1">
                    {group.tracks.map((track, i) => (
                      <TimelineTrackRow key={track.uri || `${group.date}-${i}`} track={track} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TimelineTrackRow({ track }: { track: TrackData }) {
  const art = getAlbumArt(track.album_images);
  const trackName = getDisplayText(track.name, "Unknown Track");
  const albumName = getDisplayText(track.album, "");
  const albumUrl = getDisplayText(track.album_url, "");
  const trackUrl = getDisplayText(track.url, "");

  return (
    <div className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-gray-800/60 transition-colors group">
      {/* Album art */}
      {art ? (
        <img
          src={art}
          alt=""
          className="w-9 h-9 rounded object-cover shrink-0"
        />
      ) : (
        <div className="w-9 h-9 rounded bg-gray-800 shrink-0 flex items-center justify-center">
          <svg className="w-4 h-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
          </svg>
        </div>
      )}

      {/* Track info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {trackUrl ? (
            <a
              href={trackUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-white truncate hover:text-green-400 transition-colors"
            >
              {trackName}
            </a>
          ) : (
            <span className="text-sm font-medium text-white truncate">
              {trackName}
            </span>
          )}
          {track.explicit && (
            <span className="text-[9px] font-bold text-gray-400 bg-gray-700 rounded px-1 py-0.5 shrink-0">
              E
            </span>
          )}
        </div>
        <div className="text-xs text-gray-400 truncate">
          {getArtistNames(track.artists)}
          {albumName && (
            <>
              <span className="mx-1 text-gray-600">&middot;</span>
              {albumUrl ? (
                <a
                  href={albumUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-green-400 transition-colors"
                >
                  {albumName}
                </a>
              ) : (
                <span>{albumName}</span>
              )}
            </>
          )}
        </div>
      </div>

      {/* Duration */}
      {track.duration_ms && (
        <span className="text-xs text-gray-500 shrink-0">
          {formatDuration(track.duration_ms)}
        </span>
      )}

      {/* Popularity */}
      {track.popularity != null && track.popularity > 0 && (
        <div className="w-8 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          <div className="h-1 rounded-full bg-gray-700 overflow-hidden">
            <div
              className="h-full rounded-full bg-green-500"
              style={{ width: `${track.popularity}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
