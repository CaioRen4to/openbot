import { DEFAULT_JARVIS_SHORTCUT_SETTINGS, type JarvisShortcutSettings } from "@openbot/contracts/ipc";
import { createSignal } from "solid-js";

const MAESTRO_AGENT_STORAGE_KEY = "openbot.jarvis.maestroAgentId";
const WAKE_WORD_STORAGE_KEY = "openbot.jarvis.wakeWordEnabled";

function readStorageString(key: string): string | null {
  try {
    const value = window.localStorage.getItem(key);
    return value && value.trim().length > 0 ? value.trim() : null;
  } catch {
    return null;
  }
}

function readStorageBoolean(key: string, fallback: boolean): boolean {
  try {
    const value = window.localStorage.getItem(key);
    if (value === "true") return true;
    if (value === "false") return false;
    return fallback;
  } catch {
    return fallback;
  }
}

function writeStorageValue(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage denial in restricted browser contexts.
  }
}

const [maestroAgentId, setMaestroAgentIdSignal] = createSignal<string | null>(
  readStorageString(MAESTRO_AGENT_STORAGE_KEY),
);

const [wakeWordEnabled, setWakeWordEnabledSignal] = createSignal<boolean>(
  readStorageBoolean(WAKE_WORD_STORAGE_KEY, false),
);

const [maestroShortcut, setMaestroShortcutSignal] = createSignal<JarvisShortcutSettings>({
  ...DEFAULT_JARVIS_SHORTCUT_SETTINGS,
});

export type JarvisVoiceCommandMode = "toggle-conversation" | "start-conversation" | "send-prompt";

export interface JarvisVoiceCommandRequest {
  id: number;
  agentId: string;
  mode: JarvisVoiceCommandMode;
  promptText?: string | undefined;
}

const [jarvisVoiceRequest, setJarvisVoiceRequest] = createSignal<JarvisVoiceCommandRequest | null>(null);
let nextRequestId = 0;

export { jarvisVoiceRequest, maestroAgentId, maestroShortcut, wakeWordEnabled };

export function setMaestroAgentId(agentId: string | null): void {
  const normalized = agentId && agentId.trim().length > 0 ? agentId.trim() : null;
  setMaestroAgentIdSignal(normalized);
  writeStorageValue(MAESTRO_AGENT_STORAGE_KEY, normalized);
}

export function setWakeWordEnabled(enabled: boolean): void {
  setWakeWordEnabledSignal(enabled);
  writeStorageValue(WAKE_WORD_STORAGE_KEY, enabled ? "true" : "false");
}

export function setMaestroShortcutState(settings: JarvisShortcutSettings): void {
  setMaestroShortcutSignal({
    enabled: settings.enabled,
    accelerator: settings.accelerator,
  });
}

export function requestJarvisVoiceCommand(input: Omit<JarvisVoiceCommandRequest, "id">): void {
  nextRequestId += 1;
  setJarvisVoiceRequest({ ...input, id: nextRequestId });
}

export function clearJarvisVoiceCommand(id: number): void {
  setJarvisVoiceRequest((current) => (current?.id === id ? null : current));
}

export interface MaestroCandidateAgent {
  id: string;
  name: string;
}

/**
 * Resolves the Maestro agent using saved preference, name heuristic ("Maestro" / "Jarvis"),
 * current active agent, or first available agent.
 */
export function resolveMaestroAgent<T extends MaestroCandidateAgent>(
  agents: readonly T[],
  activeAgentId?: string | null,
): T | null {
  if (agents.length === 0) return null;
  const savedId = maestroAgentId();
  if (savedId) {
    const saved = agents.find((agent) => agent.id === savedId);
    if (saved) return saved;
  }
  const named = agents.find((agent) => /\b(maestro|jarvis)\b/i.test(agent.name));
  if (named) return named;
  if (activeAgentId) {
    const active = agents.find((agent) => agent.id === activeAgentId);
    if (active) return active;
  }
  return agents[0] ?? null;
}
