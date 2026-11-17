import { createRoot, flush } from "solid-js";
import { describe, expect, it } from "vitest";
import { resolveOrbStatusWithAudio, setJarvisMicAudio, useJarvisOrbAudio } from "./jarvis-audio-signal";
import { resolveMaestroAgent, setMaestroAgentId } from "./jarvis-maestro-store";
import { parseWakeWordTranscript } from "./jarvis-wake-word";

describe("jarvis-audio-signal", () => {
  it("prioritizes active mic dictation/conversation over idle and clears cleanly", () => {
    const { audio, dispose } = createRoot((disposeRoot) => ({
      audio: useJarvisOrbAudio(),
      dispose: disposeRoot,
    }));

    setJarvisMicAudio("dictation", false);
    setJarvisMicAudio("conversation", false);
    setJarvisMicAudio("wake", false);
    flush();

    expect(audio().mode).toBe("idle");
    expect(resolveOrbStatusWithAudio("thinking", audio().mode)).toBe("thinking");

    setJarvisMicAudio("dictation", true, 0.72);
    flush();
    expect(audio().mode).toBe("listening");
    expect(audio().level).toBeCloseTo(0.72, 2);
    expect(resolveOrbStatusWithAudio("idle", audio().mode)).toBe("listening");

    // Clearing another source must not clobber active dictation
    setJarvisMicAudio("wake", false);
    flush();
    expect(audio().mode).toBe("listening");

    setJarvisMicAudio("dictation", false);
    flush();
    expect(audio().mode).toBe("idle");
    dispose();
  });
});

describe("resolveMaestroAgent", () => {
  it("picks explicit preference, then name heuristic, then active, then first agent", () => {
    const agents = [
      { id: "a1", name: "Backend API" },
      { id: "a2", name: "Jarvis Orquestrador" },
      { id: "a3", name: "QA Auditor" },
    ];

    setMaestroAgentId(null);
    flush();
    expect(resolveMaestroAgent(agents, "a3")?.id).toBe("a2");

    setMaestroAgentId("a3");
    flush();
    expect(resolveMaestroAgent(agents, "a1")?.id).toBe("a3");

    // Deleted saved id falls back cleanly
    setMaestroAgentId("missing");
    flush();
    expect(
      resolveMaestroAgent(
        [
          { id: "a1", name: "Backend" },
          { id: "a3", name: "QA" },
        ],
        "a3",
      )?.id,
    ).toBe("a3");

    setMaestroAgentId(null);
    flush();
  });
});

describe("parseWakeWordTranscript", () => {
  it("detects Jarvis wake phrases and extracts trailing commands", () => {
    expect(parseWakeWordTranscript("Ei Jarvis")).toEqual({ matched: true, command: "" });
    expect(parseWakeWordTranscript("Ok, Jarvis, verifica o servidor")).toEqual({
      matched: true,
      command: "verifica o servidor",
    });
    expect(parseWakeWordTranscript("J.A.R.V.I.S. abre o navegador")).toEqual({
      matched: true,
      command: "abre o navegador",
    });
    expect(parseWakeWordTranscript("Bom dia pessoal")).toEqual({ matched: false, command: "" });
  });
});
