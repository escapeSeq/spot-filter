"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Editor from "@monaco-editor/react";
import TrackCardView from "./components/TrackCardView";
import TimelineView from "./components/TimelineView";
import { extractLlmContentFromNdjsonStream, parseLlmJsonOutput } from "@/lib/llmJson";

interface TokenState {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

export default function Home() {
  const [tokens, setTokens] = useState<TokenState | null>(null);
  const [playlistUrl, setPlaylistUrl] = useState("");
  const [jsonValue, setJsonValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [detailed, setDetailed] = useState(false);
  const editorRef = useRef<unknown>(null);
  const [prompt, setPrompt] = useState("add an attribute \"country\" and set the value to the country of origin");
  const [llmLoading, setLlmLoading] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [showPrompt, setShowPrompt] = useState(false);
  const [llmProgress, setLlmProgress] = useState<{ current: number; total: number } | null>(null);
  const [llmTokenInfo, setLlmTokenInfo] = useState<string | null>(null);
  const abortRef = useRef(false);
  const decorationsRef = useRef<string[]>([]);
  const monacoRef = useRef<any>(null);
  const [trackChanges, setTrackChanges] = useState<
    { index: number; name: string; status: "modified" | "removed" | "unchanged" | "error"; detail: string }[]
  >([]);
  const [userPlaylists, setUserPlaylists] = useState<
    { id: string; name: string; description: string; owner: string; total_tracks: number; image_url: string; url: string }[]
  >([]);
  const [playlistSearch, setPlaylistSearch] = useState("");
  const [playlistsLoading, setPlaylistsLoading] = useState(false);
  const [showPlaylists, setShowPlaylists] = useState(false);
  const [viewMode, setViewMode] = useState<"cards" | "json" | "timeline">("cards");
  const [playlistData, setPlaylistData] = useState<Record<string, unknown> | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createName, setCreateName] = useState("");
  const [pendingCreateData, setPendingCreateData] = useState<Record<string, unknown> | null>(null);

  // Extract tokens from URL params after OAuth callback
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const at = params.get("access_token");
    const rt = params.get("refresh_token");
    const expiresIn = params.get("expires_in");

    if (at) {
      const tokenState: TokenState = {
        access_token: at,
        refresh_token: rt ?? "",
        expires_at: Date.now() + (Number(expiresIn) || 3600) * 1000,
      };
      setTokens(tokenState);
      sessionStorage.setItem("spot_tokens", JSON.stringify(tokenState));
      // Clean URL
      window.history.replaceState({}, "", "/");
    } else {
      const stored = sessionStorage.getItem("spot_tokens");
      if (stored) {
        setTokens(JSON.parse(stored));
      }
    }
  }, []);

  const getAccessToken = useCallback(async (): Promise<string> => {
    if (!tokens) throw new Error("Not authenticated");
    if (Date.now() < tokens.expires_at - 60_000) return tokens.access_token;

    // Refresh
    const res = await fetch("/api/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: tokens.refresh_token }),
    });
    if (!res.ok) throw new Error("Failed to refresh token");
    const data = await res.json();
    const newTokens: TokenState = {
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? tokens.refresh_token,
      expires_at: Date.now() + (data.expires_in || 3600) * 1000,
    };
    setTokens(newTokens);
    sessionStorage.setItem("spot_tokens", JSON.stringify(newTokens));
    return newTokens.access_token;
  }, [tokens]);

  function extractPlaylistId(input: string): string | null {
    // Handle Spotify URLs, URIs, or plain IDs
    const urlMatch = input.match(
      /open\.spotify\.com\/playlist\/([a-zA-Z0-9]+)/
    );
    if (urlMatch) return urlMatch[1];
    const uriMatch = input.match(/spotify:playlist:([a-zA-Z0-9]+)/);
    if (uriMatch) return uriMatch[1];
    if (/^[a-zA-Z0-9]{22}$/.test(input.trim())) return input.trim();
    return null;
  }

  function getDisplayTrackName(rawName: unknown, fallback: string): string {
    if (typeof rawName === "string" && rawName.trim()) return rawName;
    if (rawName && typeof rawName === "object") {
      const maybeName = (rawName as Record<string, unknown>).name;
      if (typeof maybeName === "string" && maybeName.trim()) return maybeName;
    }
    if (typeof rawName === "number" || typeof rawName === "boolean") {
      return String(rawName);
    }
    return fallback;
  }

  function getPrimaryArtistName(rawArtists: unknown): string {
    if (!Array.isArray(rawArtists) || rawArtists.length === 0) return "";
    const first = rawArtists[0];
    if (typeof first === "string") return first;
    if (first && typeof first === "object") {
      const maybeName = (first as Record<string, unknown>).name;
      return typeof maybeName === "string" ? maybeName : "";
    }
    return "";
  }

  const fetchPlaylist = useCallback(async () => {
    setError(null);
    setStatus(null);
    setCreatedUrl(null);
    setTrackChanges([]);
    setLlmProgress(null);

    const playlistId = extractPlaylistId(playlistUrl);
    if (!playlistId) {
      setError("Invalid playlist URL, URI, or ID");
      return;
    }

    setLoading(true);
    setStatus("Fetching playlist...");
    try {
      const at = await getAccessToken();
      const res = await fetch(`/api/playlist?id=${playlistId}`, {
        headers: { Authorization: `Bearer ${at}` },
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setPlaylistData(data);
      const output = detailed ? data : {
        ...data,
        tracks: data.tracks.map((t: Record<string, unknown>) => ({
          uri: t.uri,
          name: t.name,
          artists: Array.isArray(t.artists)
            ? t.artists.map((a: Record<string, unknown>) => (typeof a === "string" ? a : String(a.name ?? "Unknown")))
            : t.artists,
          label: t.label,
          added_at: t.added_at,
          album_release_date: t.album_release_date,
        })),
      };
      setJsonValue(JSON.stringify(output, null, 2));
      setStatus(`Loaded "${data.name}" – ${data.total_tracks} tracks`);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [playlistUrl, getAccessToken, detailed]);

  const loadPlaylists = useCallback(async () => {
    if (playlistsLoading) return;
    setPlaylistsLoading(true);
    setError(null);
    try {
      const at = await getAccessToken();
      const res = await fetch("/api/playlists", {
        headers: { Authorization: `Bearer ${at}` },
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setUserPlaylists(data.playlists ?? []);
      setShowPlaylists(true);
    } catch (err) {
      setError(String(err));
    } finally {
      setPlaylistsLoading(false);
    }
  }, [getAccessToken, playlistsLoading]);

  const fetchUserPlaylists = useCallback(() => {
    if (userPlaylists.length > 0) {
      setShowPlaylists((v) => !v);
    } else {
      loadPlaylists();
    }
  }, [userPlaylists.length, loadPlaylists]);

  // Auto-load playlists on login
  useEffect(() => {
    if (tokens && userPlaylists.length === 0) {
      loadPlaylists();
    }
  }, [tokens]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectPlaylist = useCallback((id: string) => {
    setPlaylistUrl(`spotify:playlist:${id}`);
    setShowPlaylists(false);
    // Auto-fetch after setting URL
    setTimeout(() => {
      const btn = document.getElementById("fetch-playlist-btn");
      if (btn) btn.click();
    }, 0);
  }, []);

  const openCreateModal = useCallback(() => {
    setError(null);
    setStatus(null);
    setCreatedUrl(null);

    let parsed;
    try {
      parsed = JSON.parse(jsonValue);
    } catch {
      setError("Invalid JSON in editor");
      return;
    }

    if (!Array.isArray(parsed.tracks) || parsed.tracks.length === 0) {
      setError('JSON must include a non-empty "tracks" array');
      return;
    }

    setPendingCreateData(parsed);
    setCreateName(parsed.name || "New Playlist");
    setShowCreateModal(true);
  }, [jsonValue]);

  const confirmCreatePlaylist = useCallback(async () => {
    if (!pendingCreateData || !createName.trim()) return;
    setShowCreateModal(false);

    const parsed: Record<string, unknown> = { ...pendingCreateData, name: createName.trim() };
    setPendingCreateData(null);

    setLoading(true);
    setStatus("Creating playlist...");
    try {
      const at = await getAccessToken();
      const res = await fetch("/api/playlist/create", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${at}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(parsed),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const result = await res.json();
      setCreatedUrl(result.url);
      setStatus(`Playlist "${parsed.name}" created! ${(parsed.tracks as unknown[]).length} tracks added.`);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [pendingCreateData, createName, getAccessToken]);

  const copyJson = useCallback(() => {
    navigator.clipboard.writeText(jsonValue);
    setStatus("Copied to clipboard!");
    setTimeout(() => setStatus(null), 2000);
  }, [jsonValue]);

  const pasteJson = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      setJsonValue(text);
      setStatus("Pasted from clipboard");
      setTimeout(() => setStatus(null), 2000);
    } catch {
      setError("Clipboard read failed – paste manually into the editor");
    }
  }, []);

  // Fetch available Ollama models when prompt bar is opened
  useEffect(() => {
    if (!showPrompt || models.length > 0) return;
    fetch("/api/llm")
      .then((r) => r.json())
      .then((data) => {
        if (data.models?.length) {
          setModels(data.models);
          setSelectedModel(data.models[0]);
        }
      })
      .catch(() => {});
  }, [showPrompt, models.length]);

  // Helper: read a streaming LLM response and call onToken for each chunk, returns final event data
  const readLlmStream = useCallback(async (
    res: Response,
    onToken: (tokens: number, partial: string) => void,
  ): Promise<{
    result?: string;
    error?: string;
    raw?: string;
    llmContent?: string;
    sanitized?: string;
    eval_count?: number;
    eval_duration?: number;
    prompt_eval_count?: number;
    prompt_eval_duration?: number;
    total_duration?: number;
  }> => {
    // If response is not streaming (e.g. error JSON), fall back to json parse
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const text = await res.text();
      try {
        const data = JSON.parse(text);
        return { ...(data as Record<string, unknown>), raw: text } as any;
      } catch {
        return { error: text || `HTTP ${res.status}`, raw: text };
      }
    }
    const body = res.body;
    if (!body) {
      const text = await res.text();
      try {
        const parsed = JSON.parse(text);
        return { ...(parsed as Record<string, unknown>), raw: text } as any;
      } catch {
        return { error: text || "Empty response", raw: text };
      }
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let rawStream = "";
    let finalEvent: Record<string, unknown> = {};
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      rawStream += chunk;
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.tokens != null) {
            onToken(evt.tokens as number, evt.token as string);
          }
          if (evt.done) {
            finalEvent = evt;
          }
        } catch { /* skip */ }
      }
    }
    // Process remaining buffer
    if (buffer.trim()) {
      try {
        const evt = JSON.parse(buffer);
        if (evt.done) finalEvent = evt;
      } catch { /* ignore */ }
    }
    const llmContent =
      typeof finalEvent.raw === "string"
        ? finalEvent.raw
        : typeof finalEvent.result === "string"
        ? finalEvent.result
        : undefined;
    return {
      ...(finalEvent as Record<string, unknown>),
      llmContent,
      raw: rawStream.trim(),
    } as any;
  }, []);

  /** Resolve LLM output to parsed JSON when possible (even if server set error after comment-stripping failed server-side). */
  const resolveLlmTrackResult = useCallback(
    (
      data: { result?: string; error?: string; raw?: string; llmContent?: string; sanitized?: string },
      baseTrack?: Record<string, unknown>
    ) => {
      if (data.result === "null") return { ok: true as const, removed: true as const };
      if (typeof data.result === "string" && data.result.trim()) {
        const parsed = parseLlmJsonOutput(data.result, true, baseTrack);
        if (parsed.ok && "removed" in parsed && parsed.removed) return { ok: true, removed: true };
        if (parsed.ok && "value" in parsed) return { ok: true, value: parsed.value };
      }
      const source =
        data.llmContent ||
        (typeof data.raw === "string" ? extractLlmContentFromNdjsonStream(data.raw) || data.raw : "") ||
        "";
      if (!source.trim()) return { ok: false as const, reason: data.error || "No LLM output" };
      const parsed = parseLlmJsonOutput(source, true, baseTrack);
      if (parsed.ok && "removed" in parsed && parsed.removed) return { ok: true, removed: true };
      if (parsed.ok && "value" in parsed) return { ok: true, value: parsed.value };
      const parseError = !parsed.ok ? parsed.error : "Invalid JSON";
      const sanitized = !parsed.ok ? parsed.sanitized : undefined;
      return {
        ok: false as const,
        reason: data.error || parseError,
        llmContent: source,
        sanitized,
      };
    },
    []
  );

  const getFailedResponseDetail = useCallback((
    res: Response,
    data: { error?: string; raw?: string; [key: string]: unknown }
  ): string => {
    const parts = [`HTTP ${res.status}`];
    if (data.error) parts.push(`error: ${data.error}`);
    if (data.raw && data.raw.trim()) {
      parts.push(`raw response:\n${data.raw}`);
    } else {
      const payload = { ...data };
      delete payload.raw;
      if (Object.keys(payload).length > 0) {
        parts.push(`response:\n${JSON.stringify(payload, null, 2)}`);
      }
    }
    return parts.join("\n\n");
  }, []);

  const getInvalidJsonDetail = useCallback((data: {
    result?: string;
    raw?: string;
    llmContent?: string;
    sanitized?: string;
    error?: string;
    [key: string]: unknown;
  }): string => {
    const parts: string[] = [];
    if (data.error) parts.push(String(data.error));
    else parts.push("LLM did not return valid JSON.");
    const llmText = data.llmContent || data.raw;
    if (typeof data.result === "string" && data.result.trim()) {
      parts.push(`parsed result field:\n${data.result}`);
    }
    if (typeof llmText === "string" && llmText.trim()) {
      parts.push(`llm output:\n${llmText}`);
    }
    if (typeof data.sanitized === "string" && data.sanitized.trim()) {
      parts.push(`after sanitization:\n${data.sanitized}`);
    }
    return parts.join("\n\n");
  }, []);

  // Format Ollama timing stats into a readable string
  const formatOllamaStats = useCallback((data: Record<string, unknown>): string => {
    const parts: string[] = [];
    if (data.eval_count && data.eval_duration) {
      const tokPerSec = ((data.eval_count as number) / ((data.eval_duration as number) / 1e9)).toFixed(1);
      parts.push(`${data.eval_count} tokens @ ${tokPerSec} tok/s`);
    }
    if (data.prompt_eval_count) {
      parts.push(`prompt: ${data.prompt_eval_count} tokens`);
    }
    if (data.total_duration) {
      parts.push(`total: ${((data.total_duration as number) / 1e9).toFixed(1)}s`);
    }
    return parts.length ? parts.join(" · ") : "";
  }, []);

  const runPrompt = useCallback(async () => {
    if (!prompt.trim() || !jsonValue.trim()) return;
    setError(null);
    setStatus(null);
    setLlmLoading(true);
    setLlmTokenInfo(null);

    try {
      // Parse the playlist JSON and extract tracks
      let playlist;
      try {
        playlist = JSON.parse(jsonValue);
      } catch {
        setError("Editor does not contain valid JSON");
        setLlmLoading(false);
        return;
      }

      const tracks: unknown[] = Array.isArray(playlist)
        ? playlist
        : Array.isArray(playlist.tracks)
        ? playlist.tracks
        : null;

      if (!tracks) {
        setError('JSON must contain a "tracks" array (or be an array itself)');
        setLlmLoading(false);
        return;
      }

      const total = tracks.length;
      const resultTracks: unknown[] = [];
      let errors = 0;
      abortRef.current = false;
      setLlmProgress({ current: 0, total });
      setTrackChanges([]);
      const localChanges: { index: number; name: string; status: "modified" | "removed" | "unchanged" | "error"; detail: string }[] = [];

      // Helper: rebuild JSON snapshot and apply decorations
      const updateEditorSnapshot = (processedUpTo: number) => {
        const remaining = tracks.slice(processedUpTo + 1);
        const snapshot = [...resultTracks, ...remaining];
        let snapOutput;
        if (Array.isArray(playlist)) {
          snapOutput = snapshot;
        } else {
          snapOutput = { ...playlist, tracks: snapshot, total_tracks: snapshot.length };
        }
        const snapJson = JSON.stringify(snapOutput, null, 2);

        // Always update React state so card view reflects changes immediately
        setJsonValue(snapJson);

        // Also push to editor model + decorations if mounted
        try {
          const editor = editorRef.current as any;
          const monacoNs = monacoRef.current;
          if (editor && monacoNs && editor.getModel()) {
            const model = editor.getModel();
            model.setValue(snapJson);

            // Build decoration ranges
            const allLines = snapJson.split('\n');
            const newDecs: { range: any; options: any }[] = [];
            let depth = 0;
            let tIdx = 0;
            let tStart = -1;
            const baseDepth = Array.isArray(playlist) ? 0 : 1;

            for (let ln = 0; ln < allLines.length && tIdx < localChanges.length; ln++) {
              for (const ch of allLines[ln]) {
                if (ch === '{') {
                  if (depth === baseDepth) tStart = ln;
                  depth++;
                } else if (ch === '}') {
                  depth--;
                  if (depth === baseDepth && tStart >= 0) {
                    const change = localChanges[tIdx];
                    if (change) {
                      const cls = change.status === 'modified' ? 'track-modified'
                        : change.status === 'removed' ? 'track-removed'
                        : change.status === 'error' ? 'track-error'
                        : 'track-unchanged';
                      newDecs.push({
                        range: new monacoNs.Range(tStart + 1, 1, ln + 1, allLines[ln].length + 1),
                        options: { isWholeLine: true, className: cls },
                      });
                    }
                    tIdx++;
                    tStart = -1;
                  }
                }
              }
            }
            decorationsRef.current = editor.deltaDecorations(decorationsRef.current, newDecs);
          }
        } catch { /* editor may be unmounted in cards view — safe to ignore */ }
      };

      for (let i = 0; i < total; i++) {
        if (abortRef.current) {
          for (let j = i; j < total; j++) resultTracks.push(tracks[j]);
          break;
        }

        const track = tracks[i] as Record<string, unknown>;
        const trackName = getDisplayTrackName(track.name, `Track ${i + 1}`);
        const trackJson = JSON.stringify(track, null, 2);
        let changeEntry: typeof localChanges[0] | null = null;

        setStatus(`Processing track ${i + 1} / ${total}: ${trackName}`);
        setLlmTokenInfo("Fetching MusicBrainz...");

        // Fetch MusicBrainz context for this track
        let mbData: unknown = null;
        try {
          const artistName = getPrimaryArtistName(track.artists);
          const mbRes = await fetch(`/api/musicbrainz?track=${encodeURIComponent(trackName)}&artist=${encodeURIComponent(artistName)}`);
          if (mbRes.ok) {
            mbData = await mbRes.json();
          }
        } catch { /* MusicBrainz fetch non-critical */ }

        setLlmTokenInfo("Waiting for Ollama...");

        try {
          const res = await fetch("/api/llm", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              prompt: prompt.trim(),
              json: trackJson,
              model: selectedModel || undefined,
              singleTrack: true,
              musicbrainz: mbData,
            }),
          });

          const data = await readLlmStream(res, (tokenCount) => {
            setLlmTokenInfo(`Generating... ${tokenCount} tokens`);
          });

          // Show final stats briefly
          const stats = formatOllamaStats(data as Record<string, unknown>);
          if (stats) setLlmTokenInfo(stats);

          if (!res.ok) {
            errors++;
            resultTracks.push(track);
            changeEntry = {
              index: i,
              name: trackName,
              status: "error",
              detail: getFailedResponseDetail(res, data as Record<string, unknown> as { error?: string; raw?: string }),
            };
          } else {
            const resolved = resolveLlmTrackResult(data, track);
            if (resolved.ok && resolved.removed) {
              changeEntry = { index: i, name: trackName, status: "removed", detail: "Removed by LLM" };
            } else if (resolved.ok && resolved.value) {
              const modified = resolved.value as Record<string, unknown>;
              const diffs: string[] = [];
              const allKeys = new Set([...Object.keys(track), ...Object.keys(modified)]);
              allKeys.forEach((k) => {
                const oldVal = JSON.stringify(track[k]);
                const newVal = JSON.stringify(modified[k]);
                if (oldVal !== newVal) {
                  if (oldVal === undefined) diffs.push(`+${k}: ${newVal}`);
                  else if (newVal === undefined) diffs.push(`-${k}`);
                  else diffs.push(`${k}: ${oldVal} → ${newVal}`);
                }
              });
              resultTracks.push(modified);
              changeEntry = diffs.length === 0
                ? { index: i, name: trackName, status: "unchanged", detail: "No changes" }
                : { index: i, name: trackName, status: "modified", detail: diffs.join(" | ") };
            } else {
              resultTracks.push(track);
              errors++;
              changeEntry = {
                index: i,
                name: trackName,
                status: "error",
                detail: getInvalidJsonDetail({
                  result: typeof data.result === "string" ? data.result : undefined,
                  raw: resolved.llmContent || data.llmContent || data.raw,
                  sanitized: resolved.sanitized || data.sanitized,
                  error: resolved.reason,
                }),
              };
            }
          }
        } catch (err) {
          resultTracks.push(track);
          errors++;
          changeEntry = { index: i, name: trackName, status: "error", detail: String(err) };
        }

        if (changeEntry) {
          localChanges.push(changeEntry);
          setTrackChanges([...localChanges]);
        }

        setLlmProgress({ current: i + 1, total });
        updateEditorSnapshot(i);
      }

      // Final update
      let output;
      if (Array.isArray(playlist)) {
        output = resultTracks;
      } else {
        output = { ...playlist, tracks: resultTracks, total_tracks: resultTracks.length };
      }
      setJsonValue(JSON.stringify(output, null, 2));

      const stopped = abortRef.current;
      const removed = total - resultTracks.length;
      const parts = [stopped ? "Stopped" : "Done"];
      parts.push(`${resultTracks.length} tracks kept`);
      if (removed > 0) parts.push(`${removed} removed`);
      if (errors > 0) parts.push(`${errors} errors (originals kept)`);
      setStatus(parts.join(" — "));
    } catch (err) {
      setError(String(err));
    } finally {
      setLlmLoading(false);
      setLlmProgress(null);
      setLlmTokenInfo(null);
    }
  }, [prompt, jsonValue, selectedModel, readLlmStream, formatOllamaStats, getFailedResponseDetail, getInvalidJsonDetail, resolveLlmTrackResult]);

  const retryErrors = useCallback(async () => {
    if (!prompt.trim() || !jsonValue.trim()) return;
    const errorIndices = trackChanges
      .filter((c) => c.status === "error")
      .map((c) => c.index);
    if (errorIndices.length === 0) return;

    setLlmLoading(true);
    setError(null);
    setStatus(null);
    abortRef.current = false;

    try {
      let playlist;
      try { playlist = JSON.parse(jsonValue); } catch { setError("Invalid JSON"); setLlmLoading(false); return; }

      const tracks: unknown[] = Array.isArray(playlist) ? playlist : playlist.tracks;
      if (!tracks) { setError("No tracks array"); setLlmLoading(false); return; }

      const total = errorIndices.length;
      setLlmProgress({ current: 0, total });
      let fixed = 0;
      let stillErrored = 0;

      const updatedChanges = [...trackChanges];

      for (let step = 0; step < total; step++) {
        if (abortRef.current) break;
        const idx = errorIndices[step];
        const track = tracks[idx] as Record<string, unknown>;
        const trackName = getDisplayTrackName(track.name, `Track ${idx + 1}`);
        const trackJson = JSON.stringify(track, null, 2);

        setStatus(`Retrying track ${step + 1} / ${total} (index ${idx + 1})...`);

        try {
          const res = await fetch("/api/llm", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: prompt.trim(), json: trackJson, model: selectedModel || undefined, singleTrack: true }),
          });
          const data = await readLlmStream(res, () => {});
          if (!res.ok) {
            stillErrored++;
            const changeIdx = updatedChanges.findIndex((c) => c.index === idx);
            if (changeIdx >= 0) {
              updatedChanges[changeIdx] = {
                index: idx,
                name: trackName,
                status: "error",
                detail: getFailedResponseDetail(res, data as { error?: string; raw?: string }),
              };
            }
          } else {
            const resolved = resolveLlmTrackResult(data, track);
            if (resolved.ok && resolved.removed) {
              tracks[idx] = null as any;
              const changeIdx = updatedChanges.findIndex((c) => c.index === idx);
              if (changeIdx >= 0) updatedChanges[changeIdx] = { index: idx, name: trackName, status: "removed", detail: "Removed by LLM" };
              fixed++;
            } else if (resolved.ok && resolved.value) {
              const modified = resolved.value as Record<string, unknown>;
              const diffs: string[] = [];
              const allKeys = new Set([...Object.keys(track), ...Object.keys(modified)]);
              allKeys.forEach((k) => {
                const oldVal = JSON.stringify((track as any)[k]);
                const newVal = JSON.stringify(modified[k]);
                if (oldVal !== newVal) {
                  if (oldVal === undefined) diffs.push(`+${k}: ${newVal}`);
                  else if (newVal === undefined) diffs.push(`-${k}`);
                  else diffs.push(`${k}: ${oldVal} → ${newVal}`);
                }
              });
              tracks[idx] = modified;
              const changeIdx = updatedChanges.findIndex((c) => c.index === idx);
              if (changeIdx >= 0) updatedChanges[changeIdx] = diffs.length === 0
                ? { index: idx, name: trackName, status: "unchanged", detail: "No changes" }
                : { index: idx, name: trackName, status: "modified", detail: diffs.join(" | ") };
              fixed++;
            } else {
              stillErrored++;
              const changeIdx = updatedChanges.findIndex((c) => c.index === idx);
              if (changeIdx >= 0) {
                updatedChanges[changeIdx] = {
                  index: idx,
                  name: trackName,
                  status: "error",
                  detail: getInvalidJsonDetail({
                    result: typeof data.result === "string" ? data.result : undefined,
                    raw: resolved.llmContent || data.llmContent || data.raw,
                    sanitized: resolved.sanitized || data.sanitized,
                    error: resolved.reason,
                  }),
                };
              }
            }
          }
        } catch (err) {
          stillErrored++;
          const changeIdx = updatedChanges.findIndex((c) => c.index === idx);
          if (changeIdx >= 0) updatedChanges[changeIdx] = { index: idx, name: trackName, status: "error", detail: String(err) };
        }

        setTrackChanges([...updatedChanges]);
        setLlmProgress({ current: step + 1, total });
      }

      // Rebuild JSON with updated tracks (filter nulls for removed)
      const finalTracks = tracks.filter((t) => t !== null);
      let output;
      if (Array.isArray(playlist)) {
        output = finalTracks;
      } else {
        output = { ...playlist, tracks: finalTracks, total_tracks: finalTracks.length };
      }
      setJsonValue(JSON.stringify(output, null, 2));

      const parts = ["Retry done"];
      if (fixed > 0) parts.push(`${fixed} fixed`);
      if (stillErrored > 0) parts.push(`${stillErrored} still errored`);
      setStatus(parts.join(" — "));
    } catch (err) {
      setError(String(err));
    } finally {
      setLlmLoading(false);
      setLlmProgress(null);
    }
  }, [prompt, jsonValue, selectedModel, trackChanges, readLlmStream, getFailedResponseDetail, getInvalidJsonDetail, resolveLlmTrackResult]);

  const logout = useCallback(() => {
    setTokens(null);
    sessionStorage.removeItem("spot_tokens");
    setJsonValue("");
    setPlaylistUrl("");
    setStatus(null);
    setError(null);
    setCreatedUrl(null);
  }, []);

  // Not authenticated
  if (!tokens) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center space-y-6">
          <h1 className="text-4xl font-bold text-green-400">Spot Filter</h1>
          <p className="text-gray-400 max-w-md">
            Retrieve a Spotify playlist as JSON, edit it, then create a new
            playlist from the modified data.
          </p>
          <a
            href="/api/auth/login"
            className="inline-block rounded-full bg-green-500 px-8 py-3 font-semibold text-black hover:bg-green-400 transition-colors"
          >
            Login with Spotify
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-gray-800 px-6 py-3">
        <h1 className="text-xl font-bold text-green-400">Spot Filter</h1>
        <button
          onClick={logout}
          className="text-sm text-gray-400 hover:text-white transition-colors"
        >
          Logout
        </button>
      </header>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-gray-800 px-6 py-3">
        {/* Playlist selector dropdown */}
        <div className="relative min-w-[280px]">
          <button
            onClick={fetchUserPlaylists}
            disabled={playlistsLoading}
            className="w-full flex items-center justify-between gap-2 rounded-lg border border-gray-700 bg-gray-900 px-4 py-2 text-sm text-white hover:border-green-500 transition-colors"
          >
            <span className="truncate">
              {playlistsLoading
                ? "Loading playlists..."
                : userPlaylists.find((p) => playlistUrl.includes(p.id))?.name
                  ?? "Select playlist..."}
            </span>
            <svg className={`w-4 h-4 shrink-0 transition-transform ${showPlaylists ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {showPlaylists && userPlaylists.length > 0 && (
            <div className="absolute z-50 left-0 right-0 top-full mt-1 rounded-lg border border-gray-700 bg-gray-900 shadow-2xl flex flex-col max-h-80">
              <div className="p-2 border-b border-gray-800">
                <input
                  type="text"
                  value={playlistSearch}
                  onChange={(e) => setPlaylistSearch(e.target.value)}
                  placeholder="Search playlists..."
                  autoFocus
                  className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:border-green-500 focus:outline-none"
                />
              </div>
              <div className="overflow-y-auto flex-1">
                {userPlaylists
                  .filter((p) =>
                    p.name.toLowerCase().includes(playlistSearch.toLowerCase()) ||
                    p.owner.toLowerCase().includes(playlistSearch.toLowerCase())
                  )
                  .map((p) => (
                    <button
                      key={p.id}
                      onClick={() => selectPlaylist(p.id)}
                      className={`w-full text-left px-3 py-2 flex items-center gap-2.5 hover:bg-gray-800 transition-colors ${
                        playlistUrl.includes(p.id) ? "bg-green-900/30 border-l-2 border-green-500" : ""
                      }`}
                    >
                      {p.image_url ? (
                        <img src={p.image_url} alt="" className="w-8 h-8 rounded object-cover shrink-0" />
                      ) : (
                        <div className="w-8 h-8 rounded bg-gray-800 shrink-0" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-white truncate">{p.name}</div>
                        <div className="text-xs text-gray-500 truncate">
                          {p.owner} &middot; {p.total_tracks} tracks
                        </div>
                      </div>
                    </button>
                  ))}
              </div>
              <div className="px-3 py-1.5 border-t border-gray-800 text-xs text-gray-500 text-right">
                {userPlaylists.filter((p) =>
                  p.name.toLowerCase().includes(playlistSearch.toLowerCase()) ||
                  p.owner.toLowerCase().includes(playlistSearch.toLowerCase())
                ).length} of {userPlaylists.length}
              </div>
            </div>
          )}
        </div>
        <button
          id="fetch-playlist-btn"
          onClick={fetchPlaylist}
          disabled={loading || !playlistUrl}
          className="rounded-lg bg-green-600 px-5 py-2 text-sm font-medium text-white hover:bg-green-500 disabled:opacity-40 transition-colors"
        >
          {loading ? "Loading..." : "Fetch"}
        </button>
        <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={detailed}
            onChange={(e) => setDetailed(e.target.checked)}
            className="accent-green-500"
          />
          Detailed
        </label>
        <div className="h-6 w-px bg-gray-700" />
        {/* View mode toggle */}
        <div className="flex rounded-lg border border-gray-700 overflow-hidden">
          <button
            onClick={() => setViewMode("cards")}
            className={`px-3 py-2 text-sm font-medium transition-colors ${
              viewMode === "cards"
                ? "bg-green-600 text-white"
                : "text-gray-400 hover:text-white hover:bg-gray-800"
            }`}
          >
            <svg className="w-4 h-4 inline-block mr-1 -mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
            </svg>
            Cards
          </button>
          <button
            onClick={() => setViewMode("timeline")}
            className={`px-3 py-2 text-sm font-medium transition-colors ${
              viewMode === "timeline"
                ? "bg-green-600 text-white"
                : "text-gray-400 hover:text-white hover:bg-gray-800"
            }`}
          >
            <svg className="w-4 h-4 inline-block mr-1 -mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Timeline
          </button>
          <button
            onClick={() => setViewMode("json")}
            className={`px-3 py-2 text-sm font-medium transition-colors ${
              viewMode === "json"
                ? "bg-green-600 text-white"
                : "text-gray-400 hover:text-white hover:bg-gray-800"
            }`}
          >
            <svg className="w-4 h-4 inline-block mr-1 -mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
            </svg>
            JSON
          </button>
        </div>
        <div className="h-6 w-px bg-gray-700" />
        <button
          onClick={copyJson}
          disabled={!jsonValue}
          className="rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-300 hover:border-gray-500 hover:text-white disabled:opacity-40 transition-colors"
        >
          Copy JSON
        </button>
        <button
          onClick={pasteJson}
          className="rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-300 hover:border-gray-500 hover:text-white transition-colors"
        >
          Paste JSON
        </button>
        <div className="h-6 w-px bg-gray-700" />
        <button
          onClick={openCreateModal}
          disabled={loading || !jsonValue}
          className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-40 transition-colors"
        >
          Create Playlist
        </button>
        <div className="h-6 w-px bg-gray-700" />
        <button
          onClick={() => setShowPrompt((v) => !v)}
          className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
            showPrompt
              ? "bg-purple-600 text-white hover:bg-purple-500"
              : "border border-gray-700 text-gray-300 hover:border-gray-500 hover:text-white"
          }`}
        >
          {showPrompt ? "Hide LLM" : "LLM Prompt"}
        </button>
      </div>

      {/* LLM Prompt bar */}
      {showPrompt && (
        <div className="flex items-center gap-3 border-b border-gray-800 px-6 py-3 bg-gray-900/50">
          {models.length > 0 && (
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white focus:border-purple-500 focus:outline-none"
            >
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          )}
          <input
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. Remove all tracks by artists with less than 2 songs"
            className="flex-1 rounded-lg border border-gray-700 bg-gray-900 px-4 py-2 text-sm text-white placeholder-gray-500 focus:border-purple-500 focus:outline-none"
            onKeyDown={(e) => e.key === "Enter" && !llmLoading && runPrompt()}
          />
          <button
            onClick={runPrompt}
            disabled={llmLoading || !prompt.trim() || !jsonValue.trim()}
            className="rounded-lg bg-purple-600 px-5 py-2 text-sm font-medium text-white hover:bg-purple-500 disabled:opacity-40 transition-colors"
          >
            {llmLoading ? "Running..." : "Run Prompt"}
          </button>
          {llmLoading && (
            <button
              onClick={() => { abortRef.current = true; }}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 transition-colors"
            >
              Stop
            </button>
          )}
          {llmProgress && (
            <div className="flex items-center gap-3 min-w-[220px]">
              <div className="flex-1 h-2 rounded-full bg-gray-700 overflow-hidden">
                <div
                  className="h-full rounded-full bg-purple-500 transition-all duration-300"
                  style={{ width: `${Math.round((llmProgress.current / llmProgress.total) * 100)}%` }}
                />
              </div>
              <span className="text-xs text-gray-300 whitespace-nowrap">
                {llmProgress.current}/{llmProgress.total} ({Math.round((llmProgress.current / llmProgress.total) * 100)}%)
              </span>
            </div>
          )}
          {llmTokenInfo && (
            <span className="text-xs text-purple-300 whitespace-nowrap animate-pulse">
              {llmTokenInfo}
            </span>
          )}
        </div>
      )}

      {/* Status bar */}
      {(status || error || createdUrl) && (
        <div className="border-b border-gray-800 px-6 py-2 text-sm">
          {error && <span className="text-red-400">{error}</span>}
          {status && !error && (
            <span className="text-green-400">{status}</span>
          )}
          {createdUrl && (
            <a
              href={createdUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-3 text-blue-400 underline hover:text-blue-300"
            >
              Open in Spotify
            </a>
          )}
        </div>
      )}

      {/* Main content: Cards view, Timeline view, or Editor + Change log */}
      <div className="flex-1 min-h-0 flex">
        {viewMode === "cards" || viewMode === "timeline" ? (
          <div className="flex-1 min-w-0">
            {(() => {
              // Derive card data from the live JSON editor value so edits/LLM changes are reflected
              let livePlaylist: Record<string, unknown> | null = null;
              let liveTracks: any[] = [];
              try {
                const parsed = JSON.parse(jsonValue);
                if (Array.isArray(parsed)) {
                  liveTracks = parsed;
                  livePlaylist = playlistData || { name: "Playlist", total_tracks: parsed.length };
                } else if (parsed && typeof parsed === "object") {
                  livePlaylist = parsed;
                  liveTracks = Array.isArray(parsed.tracks) ? parsed.tracks : [];
                }
              } catch { /* invalid JSON – fall back to playlistData */ }

              if (!livePlaylist && playlistData) {
                livePlaylist = playlistData;
                liveTracks = (playlistData.tracks as any[]) || [];
              }

              const playlistInfo = {
                  name: (livePlaylist?.name as string) || "Playlist",
                  description: (livePlaylist?.description as string) || "",
                  owner: (livePlaylist?.owner as string) || "",
                  total_tracks: liveTracks.length,
                  id: (livePlaylist?.id as string) || "",
                };

              return livePlaylist ? (
                viewMode === "timeline" ? (
                  <TimelineView
                    playlist={playlistInfo}
                    tracks={liveTracks}
                  />
                ) : (
                  <TrackCardView
                    playlist={playlistInfo}
                    tracks={liveTracks}
                    trackChanges={trackChanges}
                    llmProgress={llmProgress}
                  />
                )
            ) : (
              <div className="flex items-center justify-center h-full text-gray-500">
                <div className="text-center space-y-2">
                  <svg className="w-12 h-12 mx-auto text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
                  </svg>
                  <p className="text-sm">Select a playlist to view tracks</p>
                </div>
              </div>
            );
            })()}
          </div>
        ) : (
          <>
            {/* JSON Editor */}
            <div className={trackChanges.length > 0 && showPrompt ? "flex-1 min-w-0" : "flex-1"}>
              <Editor
                height="100%"
                defaultLanguage="json"
                theme="vs-dark"
                value={jsonValue}
                onChange={(val) => setJsonValue(val ?? "")}
                onMount={(editor, monaco) => {
                  editorRef.current = editor;
                  monacoRef.current = monaco;
                  // Define decoration styles for LLM track changes
                  const styles = [
                    { token: 'track-modified', background: '#22c55e26', borderLeft: '3px solid #22c55e' },
                    { token: 'track-removed', background: '#ef444426', borderLeft: '3px solid #ef4444' },
                    { token: 'track-error', background: '#f59e0b26', borderLeft: '3px solid #f59e0b' },
                    { token: 'track-unchanged', background: 'transparent', borderLeft: '3px solid #6b7280' },
                  ];
                  styles.forEach(({ token, background, borderLeft }) => {
                    const styleEl = document.createElement('style');
                    styleEl.textContent = `.${token} { background: ${background}; border-left: ${borderLeft}; }`;
                    document.head.appendChild(styleEl);
                  });
                }}
                options={{
                  minimap: { enabled: false },
                  fontSize: 13,
                  wordWrap: "on",
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  tabSize: 2,
                }}
              />
            </div>
          </>
        )}

        {/* Track change log — right column */}
        {trackChanges.length > 0 && showPrompt && viewMode === "json" && (
          <div className="w-96 shrink-0 border-l border-gray-800 overflow-y-auto bg-gray-950/60 text-xs font-mono">
            <div className="sticky top-0 bg-gray-900 border-b border-gray-800 px-3 py-2 flex items-center justify-between">
              <span className="text-gray-400 font-semibold text-[11px] uppercase tracking-wider">
                LLM Changes ({trackChanges.length})
              </span>
              {trackChanges.some((c) => c.status === "error") && !llmLoading && (
                <button
                  onClick={retryErrors}
                  className="rounded bg-yellow-600 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-yellow-500 transition-colors"
                >
                  Retry {trackChanges.filter((c) => c.status === "error").length} errors
                </button>
              )}
            </div>
            <div className="px-3 py-2 space-y-2">
              {trackChanges.map((c, i) => (
                <div key={i} className={`flex flex-col gap-0.5 rounded px-2 py-1 ${c.status === "error" ? "bg-red-950/40" : ""}`}>
                  <div className="flex items-start gap-2">
                    <span className="text-gray-500 w-6 text-right shrink-0">{c.index + 1}.</span>
                    <span
                      className={`w-16 shrink-0 font-semibold ${
                        c.status === "modified"
                          ? "text-green-400"
                          : c.status === "removed"
                          ? "text-red-400"
                          : c.status === "error"
                          ? "text-yellow-400"
                          : "text-gray-500"
                      }`}
                    >
                      {c.status}
                    </span>
                    <span className="text-gray-300 truncate flex-1">
                      {getDisplayTrackName((c as { name: unknown }).name, `Track ${c.index + 1}`)}
                    </span>
                  </div>
                  {c.detail && (
                    <div className={`ml-[5.5rem] break-all whitespace-pre-wrap leading-relaxed ${c.status === "error" ? "text-red-400" : "text-gray-400"}`}>
                      {typeof c.detail === "string" ? c.detail : JSON.stringify(c.detail)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Create Playlist Modal */}
      {showCreateModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setShowCreateModal(false)}
        >
          <div
            className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-md p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-white mb-4">Create New Playlist</h3>
            <label className="block text-sm text-gray-400 mb-1">Playlist name</label>
            <input
              type="text"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createName.trim() && confirmCreatePlaylist()}
              autoFocus
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-2.5 text-white placeholder-gray-500 focus:border-green-500 focus:outline-none"
              placeholder="My Playlist"
            />
            {pendingCreateData && (
              <p className="mt-2 text-xs text-gray-500">
                {(pendingCreateData.tracks as unknown[])?.length ?? 0} tracks will be added
              </p>
            )}
            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setShowCreateModal(false)}
                className="rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-300 hover:border-gray-500 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmCreatePlaylist}
                disabled={!createName.trim()}
                className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-40 transition-colors"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
