/**
 * `ai_speech` — text-to-speech (`tts`) and speech-to-text (`stt`).
 *
 * Resolution order per direction:
 *   1. An injected `speech.synthesize` / `speech.transcribe` (fakes in tests).
 *   2. The optional-lazy `openai` package (Audio API), if installed + keyed.
 * When neither is available the tool returns a clear `isError` result with an
 * install hint. TTS returns an `audio` content block; STT returns text.
 * Permission class: `network`.
 */

import type { ContentBlock } from "@nexuscode/shared";
import { errText, okText } from "@nexuscode/tools";
import type { Tool, ToolContext, ToolResult } from "@nexuscode/tools";
import type { AiToolDeps, SynthesizeArgs, SynthesizedAudio, TranscribeArgs } from "./types.js";
import {
  DEFAULT_MAX_OUTPUT_CHARS,
  cap,
  loadMedia,
  optionalImport,
  textBlock,
} from "./support.js";
import { asObject, optEnum, optString, reqString } from "./validate.js";

interface OpenAiAudioModule {
  default?: new (opts?: unknown) => {
    audio: {
      speech: { create: (params: unknown) => Promise<{ arrayBuffer: () => Promise<ArrayBuffer> }> };
      transcriptions: { create: (params: unknown) => Promise<{ text?: string }> };
    };
  };
}

function audioResult(audio: SynthesizedAudio): ToolResult {
  const content: ContentBlock[] = [
    textBlock(`Synthesized ${audio.mime} audio (${audio.data.length} base64 chars).`),
    { type: "audio", mime: audio.mime, data: audio.data },
  ];
  return { ok: true, content };
}

export function createAiSpeechTool(deps: AiToolDeps): Tool {
  const maxChars = deps.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  return {
    name: "ai_speech",
    description:
      "Text-to-speech (mode=tts) or speech-to-text (mode=stt) via an injected speech engine or the optional openai Audio API.",
    permission: "network",
    timeoutMs: deps.timeoutMs ?? 60_000,
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["tts", "stt"], description: "tts synthesizes audio from text; stt transcribes audio." },
        text: { type: "string", description: "Text to synthesize (tts)." },
        voice: { type: "string", description: "Voice id/name for synthesis (tts)." },
        format: { type: "string", description: "Audio output format, e.g. mp3 (tts)." },
        path: { type: "string", description: "Workspace-relative path to an audio file (stt)." },
        data: { type: "string", description: "Inline base64 audio data (stt, alternative to path)." },
        mime: { type: "string", description: "MIME type for inline audio data (stt, required with data)." },
        lang: { type: "string", description: "Language hint for transcription (stt)." },
      },
      additionalProperties: false,
    },
    async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const o = asObject(input);
      const mode = optEnum(o, "mode", ["tts", "stt"] as const) ?? "tts";

      if (mode === "tts") {
        const text = reqString(o, "text");
        const voice = optString(o, "voice");
        const format = optString(o, "format");
        const args: SynthesizeArgs = { text };
        if (voice !== undefined) args.voice = voice;
        if (format !== undefined) args.format = format;

        if (deps.speech?.synthesize) {
          try {
            return audioResult(await deps.speech.synthesize(args, ctx));
          } catch (err) {
            return errText(`ai_speech: synthesis failed: ${(err as Error).message}`);
          }
        }
        const mod = (await optionalImport("openai")) as OpenAiAudioModule | undefined;
        const OpenAI = mod?.default;
        if (OpenAI) {
          try {
            const client = new OpenAI();
            const res = await client.audio.speech.create({
              model: "tts-1",
              input: text,
              voice: voice ?? "alloy",
              ...(format ? { response_format: format } : {}),
            });
            const buf = Buffer.from(await res.arrayBuffer());
            return audioResult({ mime: `audio/${format ?? "mpeg"}`, data: buf.toString("base64") });
          } catch (err) {
            return errText(`ai_speech: openai TTS failed: ${(err as Error).message}`);
          }
        }
        return errText("ai_speech: no TTS backend available (inject speech.synthesize, or npm i openai).");
      }

      // stt
      const media = await loadMedia(o, ctx, "audio");
      const lang = optString(o, "lang");
      const args: TranscribeArgs = { data: media.data, mime: media.mime };
      if (lang !== undefined) args.lang = lang;

      if (deps.speech?.transcribe) {
        try {
          const r = await deps.speech.transcribe(args, ctx);
          return okText(cap(r.text, maxChars));
        } catch (err) {
          return errText(`ai_speech: transcription failed: ${(err as Error).message}`);
        }
      }
      const mod = (await optionalImport("openai")) as OpenAiAudioModule | undefined;
      const OpenAI = mod?.default;
      if (OpenAI) {
        try {
          const client = new OpenAI();
          const file = new File([Buffer.from(media.data, "base64")], "audio", { type: media.mime });
          const res = await client.audio.transcriptions.create({
            model: "whisper-1",
            file,
            ...(lang ? { language: lang } : {}),
          });
          return okText(cap(res.text ?? "", maxChars));
        } catch (err) {
          return errText(`ai_speech: openai STT failed: ${(err as Error).message}`);
        }
      }
      return errText("ai_speech: no STT backend available (inject speech.transcribe, or npm i openai).");
    },
  };
}
