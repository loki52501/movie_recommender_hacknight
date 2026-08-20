/**
 * voice-tools.ts - voice Q&A loop: speak a question, record the answer, transcribe it.
 *
 * ElevenLabs covers both directions of the voice channel (TTS + Scribe STT);
 * ffmpeg handles microphone capture, and playback falls back from ffplay to
 * PowerShell's MediaPlayer when ffplay isn't installed. Audio artifacts land
 * in ./.tmp-voice so the agent can revisit what was said.
 */
import { createTool } from "@mastra/core/tools";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import "dotenv/config";

const VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? "21m00Tcm4TlvDq8ikWAM";
const MIC_DEVICE = process.env.MIC_DEVICE ?? "Microphone Array (Realtek(R) Audio)";
const VOICE_DIR = "./.tmp-voice";

function requireApiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    throw new Error("ELEVENLABS_API_KEY is not set - add it to your .env to use the voice tools.");
  }
  return key;
}

/** Run a command to completion; reject on spawn failure or non-zero exit. */
function run(command: string, args: string[], shell = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", shell });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`))
    );
  });
}

/**
 * Play an mp3 out loud. SoundPlayer can't decode mp3, so the fallback is
 * presentationCore's MediaPlayer; it needs a rough duration to sleep through,
 * estimated here at ~2.5 spoken words per second.
 */
async function playAudio(audioPath: string, spokenText: string): Promise<void> {
  try {
    await run("ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet", audioPath], true);
  } catch {
    const seconds = Math.max(3, Math.ceil(spokenText.split(/\s+/).length / 2.5) + 1);
    const script = [
      "Add-Type -AssemblyName presentationCore",
      "$player = New-Object System.Windows.Media.MediaPlayer",
      `$player.Open([Uri]"${path.resolve(audioPath)}")`,
      "Start-Sleep -Milliseconds 800",
      "$player.Play()",
      `Start-Sleep -Seconds ${seconds}`,
      "$player.Close()",
    ].join("\n");
    await run("powershell", ["-NoProfile", "-Command", script]);
  }
}

export const speakQuestion = createTool({
  id: "speak_question",
  description: "speak a question aloud to the user via ElevenLabs TTS",
  inputSchema: z.object({
    text: z.string().describe("The question to speak aloud"),
  }),
  outputSchema: z.object({
    audioPath: z.string(),
    played: z.boolean(),
  }),
  execute: async (input) => {
    const apiKey = requireApiKey();
    const audioPath = `${VOICE_DIR}/question.mp3`;
    await mkdir(VOICE_DIR, { recursive: true });

    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: input.text, model_id: "eleven_turbo_v2_5" }),
    });
    if (!res.ok) {
      throw new Error(`ElevenLabs TTS failed (${res.status}): ${await res.text()}`);
    }

    await writeFile(audioPath, Buffer.from(await res.arrayBuffer()));

    let played = false;
    try {
      await playAudio(audioPath, input.text);
      played = true;
    } catch {
      played = false;
    }
    return { audioPath, played };
  },
});

export const recordAnswer = createTool({
  id: "record_answer",
  description: "record the user's spoken answer from the microphone",
  inputSchema: z.object({
    seconds: z.number().min(1).max(120).default(20).describe("How long to record"),
  }),
  outputSchema: z.object({
    audioPath: z.string(),
  }),
  execute: async (input) => {
    requireApiKey();
    const audioPath = `${VOICE_DIR}/answer.wav`;
    await mkdir(VOICE_DIR, { recursive: true });

    await run("ffmpeg", [
      "-y",
      "-f",
      "dshow",
      "-i",
      `audio=${MIC_DEVICE}`,
      "-t",
      String(input.seconds),
      "-ar",
      "16000",
      "-ac",
      "1",
      audioPath,
    ]);
    return { audioPath };
  },
});

export const transcribeAnswer = createTool({
  id: "transcribe_answer",
  description: "transcribe a recorded answer using ElevenLabs Scribe",
  inputSchema: z.object({
    audioPath: z.string().describe("Path to the recorded .wav file"),
  }),
  outputSchema: z.object({
    text: z.string(),
  }),
  execute: async (input) => {
    const apiKey = requireApiKey();
    const audio = await readFile(input.audioPath);

    const form = new FormData();
    form.append("file", new Blob([audio], { type: "audio/wav" }), "answer.wav");
    form.append("model_id", "scribe_v1");

    const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: form,
    });
    if (!res.ok) {
      throw new Error(`ElevenLabs speech-to-text failed (${res.status}): ${await res.text()}`);
    }

    const json = (await res.json()) as { text?: string };
    return { text: json.text ?? "" };
  },
});
