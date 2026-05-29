import { NextRequest, NextResponse } from "next/server";
import { parseLlmJsonOutput } from "@/lib/llmJson";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // seconds – allow time for Ollama model loading

const OLLAMA_URL =
  process.env.OLLAMA_URL || "http://host.docker.internal:11434";

export async function POST(req: NextRequest) {
  try {
    const { prompt, json, model, singleTrack, musicbrainz } = await req.json();

    if (!prompt || !json) {
      return NextResponse.json(
        { error: "prompt and json are required" },
        { status: 400 }
      );
    }

    const selectedModel = model || "llama3.2";

    let baseTrack: Record<string, unknown> | undefined;
    if (singleTrack) {
      try {
        baseTrack = JSON.parse(json) as Record<string, unknown>;
      } catch {
        /* client should send valid track JSON */
      }
    }

    const systemPrompt = singleTrack
      ? `You are a JSON track editor. The user will give you a single JSON object representing one Spotify track and a natural-language instruction. You may also receive MusicBrainz metadata as additional context about the track (genre tags, release info, labels, etc.). Use this context to make better decisions. Apply the instruction to the track and return the COMPLETE modified track JSON object with every field included. Never use "..." or ellipsis to skip fields. Never use // comments. If the instruction means this track should be removed/excluded, return exactly the word null. No explanation, no markdown fences, no extra text. The output must be valid JSON (or null).`
      : `You are a JSON playlist editor. The user will give you a JSON object representing a Spotify playlist and a natural-language instruction. Apply the instruction to the JSON and return ONLY the modified JSON — no explanation, no markdown fences, no extra text. The output must be valid JSON.`;

    let userMessage: string;
    if (singleTrack) {
      let msg = `Here is the track JSON:\n\n${json}`;
      if (musicbrainz) {
        msg += `\n\nMusicBrainz metadata for this track:\n\n${typeof musicbrainz === 'string' ? musicbrainz : JSON.stringify(musicbrainz, null, 2)}`;
      }
      msg += `\n\nInstruction: ${prompt}`;
      userMessage = msg;
    } else {
      userMessage = `Here is the playlist JSON:\n\n${json}\n\nInstruction: ${prompt}`;
    }

    const requestBody = JSON.stringify({
      model: selectedModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      stream: true,
      keep_alive: "10m",
      options: {
        temperature: 0.1,
        num_ctx: 32768,
      },
    });

    let res: Response | null = null;
    const maxAttempts = 2;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const timeoutMs = 10 * 60 * 1000; // 10 minutes
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        res = await fetch(`${OLLAMA_URL}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: requestBody,
        });
        clearTimeout(timeout);
        break; // success — exit retry loop
      } catch (fetchErr: any) {
        clearTimeout(timeout);
        const isAbort = fetchErr?.name === "AbortError";
        const isConnRefused = String(fetchErr).includes("ECONNREFUSED");
        if ((isAbort || isConnRefused) && attempt < maxAttempts - 1) {
          console.warn(`Ollama attempt ${attempt + 1} failed (${isAbort ? "timeout" : "connection refused"}), retrying...`);
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        const errMsg = isAbort
          ? `Ollama timed out after ${timeoutMs / 1000}s (model may be loading). Try again.`
          : `Cannot reach Ollama: ${fetchErr}`;
        return NextResponse.json({ error: errMsg }, { status: 504 });
      }
    }

    if (!res) {
      return NextResponse.json({ error: "Ollama request failed after retries" }, { status: 504 });
    }

    if (!res.ok) {
      const text = await res.text();
      console.error("Ollama error:", res.status, text);
      return NextResponse.json(
        { error: `Ollama returned ${res.status}: ${text}` },
        { status: 502 }
      );
    }

    // Stream Ollama's response to the client as newline-delimited JSON events
    const ollamaBody = res.body;
    if (!ollamaBody) {
      return NextResponse.json({ error: "No response body from Ollama" }, { status: 502 });
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let fullContent = "";
    let tokenCount = 0;

    const stream = new ReadableStream({
      async start(controller) {
        const reader = ollamaBody.getReader();
        let buffer = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const chunk = JSON.parse(line);
                const token = chunk.message?.content || "";
                if (token) {
                  fullContent += token;
                  tokenCount++;
                }
                // Send progress event to client
                const event: Record<string, unknown> = { token, tokens: tokenCount, done: chunk.done || false };
                if (chunk.done) {
                  // Include timing stats from Ollama
                  if (chunk.total_duration) event.total_duration = chunk.total_duration;
                  if (chunk.eval_count) event.eval_count = chunk.eval_count;
                  if (chunk.eval_duration) event.eval_duration = chunk.eval_duration;
                  if (chunk.prompt_eval_count) event.prompt_eval_count = chunk.prompt_eval_count;
                  if (chunk.prompt_eval_duration) event.prompt_eval_duration = chunk.prompt_eval_duration;

                  const parsed = parseLlmJsonOutput(fullContent, singleTrack, baseTrack);
                  if (parsed.ok && "removed" in parsed && parsed.removed) {
                    event.result = "null";
                  } else if (parsed.ok && "normalized" in parsed) {
                    event.result = parsed.normalized;
                  } else if (!parsed.ok) {
                    event.error = `LLM did not return valid JSON: ${parsed.error}`;
                    event.raw = fullContent;
                    event.sanitized = parsed.sanitized;
                  }
                }
                controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
              } catch { /* skip unparseable lines */ }
            }
          }
          // Process any remaining buffer
          if (buffer.trim()) {
            try {
              const chunk = JSON.parse(buffer);
              const token = chunk.message?.content || "";
              if (token) {
                fullContent += token;
                tokenCount++;
              }
              const event: Record<string, unknown> = { token, tokens: tokenCount, done: chunk.done || false };
              if (chunk.done) {
                if (chunk.total_duration) event.total_duration = chunk.total_duration;
                if (chunk.eval_count) event.eval_count = chunk.eval_count;
                if (chunk.eval_duration) event.eval_duration = chunk.eval_duration;

                const parsed = parseLlmJsonOutput(fullContent, singleTrack, baseTrack);
                if (parsed.ok && "removed" in parsed && parsed.removed) {
                  event.result = "null";
                } else if (parsed.ok && "normalized" in parsed) {
                  event.result = parsed.normalized;
                } else if (!parsed.ok) {
                  event.error = `LLM did not return valid JSON: ${parsed.error}`;
                  event.raw = fullContent;
                  event.sanitized = parsed.sanitized;
                }
              }
              controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
            } catch { /* ignore */ }
          }
        } catch (err) {
          controller.enqueue(encoder.encode(JSON.stringify({ error: String(err), done: true }) + "\n"));
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Transfer-Encoding": "chunked",
        "Cache-Control": "no-cache",
      },
    });
  } catch (err) {
    console.error("LLM route error:", err);
    return NextResponse.json(
      { error: String(err) },
      { status: 500 }
    );
  }
}

export async function GET() {
  // List available Ollama models
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!res.ok) {
      return NextResponse.json(
        { error: `Ollama returned ${res.status}` },
        { status: 502 }
      );
    }
    const data = await res.json();
    const models = (data.models ?? []).map(
      (m: { name: string }) => m.name
    );
    return NextResponse.json({ models });
  } catch (err) {
    return NextResponse.json(
      { error: `Cannot reach Ollama at ${OLLAMA_URL}: ${err}` },
      { status: 502 }
    );
  }
}
