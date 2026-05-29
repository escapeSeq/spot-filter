import { NextRequest, NextResponse } from "next/server";

const MB_BASE = "https://musicbrainz.org/ws/2";
const USER_AGENT = "SpotFilter/1.0 (https://github.com/spot-filter)";
const MB_TIMEOUT_MS = 12000;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

async function mbFetch(path: string, signal?: AbortSignal): Promise<Response> {
  return fetch(`${MB_BASE}${path}`, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
    signal,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mbFetchWithRetry(path: string, attempts = 3): Promise<Response> {
  let lastResponse: Response | null = null;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MB_TIMEOUT_MS);
    try {
      const res = await mbFetch(path, controller.signal);
      clearTimeout(timeout);
      lastResponse = res;
      if (res.ok || !RETRYABLE_STATUS.has(res.status) || attempt === attempts) {
        return res;
      }
    } catch (err) {
      clearTimeout(timeout);
      lastError = err;
      if (attempt === attempts) throw err;
    }
    await sleep(300 * attempt);
  }

  if (lastResponse) return lastResponse;
  throw lastError instanceof Error ? lastError : new Error("MusicBrainz request failed");
}

function emptyResponseFor(type: string, warning: string) {
  if (type === "artist") {
    return { artists: [], count: 0, warning };
  }
  if (type === "label") {
    return { labels: [], count: 0, warning };
  }
  return { recordings: [], count: 0, warning };
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type") || "recording";

  try {
    let url: string;

    if (type === "artist") {
      const name = searchParams.get("name");
      if (!name) {
        return NextResponse.json({ error: "Missing name parameter" }, { status: 400 });
      }
      const query = `artist:"${name}"`;
      url = `/artist/?query=${encodeURIComponent(query)}&fmt=json&limit=5&inc=tags+ratings`;
    } else if (type === "label") {
      const name = searchParams.get("name");
      if (!name) {
        return NextResponse.json({ error: "Missing name parameter" }, { status: 400 });
      }
      const query = `label:"${name}"`;
      url = `/label/?query=${encodeURIComponent(query)}&fmt=json&limit=3`;
    } else {
      // recording search (default)
      const track = searchParams.get("track");
      const artist = searchParams.get("artist");
      if (!track) {
        return NextResponse.json({ error: "Missing track parameter" }, { status: 400 });
      }
      const parts: string[] = [`recording:"${track}"`];
      if (artist) parts.push(`artist:"${artist}"`);
      const query = parts.join(" AND ");
      url = `/recording/?query=${encodeURIComponent(query)}&fmt=json&limit=5&inc=releases+artist-credits+isrcs+tags+ratings`;
    }

    const res = await mbFetchWithRetry(url);

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        emptyResponseFor(type, `MusicBrainz returned ${res.status}: ${text}`),
        { status: 200 }
      );
    }

    const data = await res.json();

    // Enrich recording results with label info from first release
    if (type === "recording" && data.recordings?.length > 0) {
      const firstRec = data.recordings[0];
      const firstRelease = firstRec.releases?.[0];
      if (firstRelease?.id) {
        try {
          const relRes = await mbFetch(`/release/${firstRelease.id}?inc=labels&fmt=json`);
          if (relRes.ok) {
            const relData = await relRes.json();
            const labelInfos: { label?: { id: string; name: string; type?: string; "label-code"?: number }; "catalog-number"?: string }[] =
              relData["label-info"] || [];

            const labels = labelInfos
              .filter((li) => li.label?.id)
              .slice(0, 5)
              .map((li) => ({
                name: li.label!.name,
                id: li.label!.id,
                type: li.label!.type,
                catalogNumber: li["catalog-number"],
                labelCode: li.label!["label-code"],
              }));

            // Fetch country details for first label
            if (labels.length > 0) {
              try {
                const lblRes = await mbFetch(`/label/${labels[0].id}?fmt=json`);
                if (lblRes.ok) {
                  const lblData = await lblRes.json();
                  (labels[0] as Record<string, unknown>).country = lblData.country;
                  (labels[0] as Record<string, unknown>).area = lblData.area?.name;
                  (labels[0] as Record<string, unknown>).lifeSpan = lblData["life-span"];
                }
              } catch { /* label detail non-critical */ }
            }

            firstRec._labels = labels;
          }
        } catch { /* label enrichment non-critical */ }
      }
    }

    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      emptyResponseFor(type, `MusicBrainz request failed: ${String(err)}`),
      { status: 200 }
    );
  }
}
