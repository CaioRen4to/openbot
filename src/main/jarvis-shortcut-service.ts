import { join } from "node:path";
import {
  DEFAULT_JARVIS_SHORTCUT_SETTINGS,
  isJarvisShortcutAccelerator,
  type JarvisShortcutSettings,
} from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger, toLogValue } from "@openbot/logging";
import { Effect } from "effect";
import { app, globalShortcut } from "electron";
import { isMissingFileError } from "../backend/file-errors";
import { readPreferenceFile, writePreferenceFile } from "./preference-file";

const logger = createOpenBotLogger("jarvis-shortcut");
const SHORTCUT_FILE_NAME = "jarvis-shortcut.json";

export interface JarvisShortcutService {
  getSettings(): JarvisShortcutSettings;
  setSettings(next: JarvisShortcutSettings): Promise<JarvisShortcutSettings>;
  initialize(): Promise<void>;
  dispose(): void;
}

export function createJarvisShortcutService(options: {
  userDataPath: string;
  onTrigger: () => void;
}): JarvisShortcutService {
  const path = join(options.userDataPath, SHORTCUT_FILE_NAME);
  let current: JarvisShortcutSettings = { ...DEFAULT_JARVIS_SHORTCUT_SETTINGS };
  let registeredAccelerator: string | null = null;
  let initialized = false;

  function unregisterCurrent(): void {
    if (!registeredAccelerator) return;
    try {
      globalShortcut.unregister(registeredAccelerator);
    } catch (error) {
      logger.warn("Unable to unregister J.A.R.V.I.S. shortcut:", toLogValue(error));
    }
    registeredAccelerator = null;
  }

  function applyRegistration(settings: JarvisShortcutSettings): void {
    if (!app.isReady()) return;
    unregisterCurrent();
    if (!settings.enabled || !isJarvisShortcutAccelerator(settings.accelerator)) return;
    try {
      const ok = globalShortcut.register(settings.accelerator, options.onTrigger);
      if (ok) {
        registeredAccelerator = settings.accelerator;
      } else {
        logger.warn("J.A.R.V.I.S. global shortcut could not be registered:", settings.accelerator);
      }
    } catch (error) {
      logger.warn("Failed to register J.A.R.V.I.S. global shortcut:", toLogValue(error));
    }
  }

  async function readFromDisk(): Promise<JarvisShortcutSettings> {
    return Effect.runPromise(
      readPreferenceFile(path, (parsed): JarvisShortcutSettings => {
        if (!isDynamicRecord(parsed)) {
          return { ...DEFAULT_JARVIS_SHORTCUT_SETTINGS };
        }
        return {
          enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_JARVIS_SHORTCUT_SETTINGS.enabled,
          accelerator: isJarvisShortcutAccelerator(parsed.accelerator)
            ? parsed.accelerator.trim()
            : DEFAULT_JARVIS_SHORTCUT_SETTINGS.accelerator,
        };
      }).pipe(
        Effect.catch((failure) => {
          const error = failure.cause;
          if (isMissingFileError(error) || error instanceof SyntaxError) {
            return Effect.succeed({ ...DEFAULT_JARVIS_SHORTCUT_SETTINGS });
          }
          return Effect.fail(failure);
        }),
      ),
    );
  }

  async function initialize(): Promise<void> {
    if (initialized) return;
    initialized = true;
    try {
      current = await readFromDisk();
    } catch (error) {
      logger.warn("Unable to read J.A.R.V.I.S. shortcut preference:", toLogValue(error));
      current = { ...DEFAULT_JARVIS_SHORTCUT_SETTINGS };
    }
    applyRegistration(current);
  }

  return {
    getSettings: () => ({ ...current }),
    setSettings: async (next) => {
      const normalized: JarvisShortcutSettings = {
        enabled: Boolean(next.enabled),
        accelerator: next.accelerator.trim() || DEFAULT_JARVIS_SHORTCUT_SETTINGS.accelerator,
      };
      current = normalized;
      applyRegistration(normalized);
      try {
        await Effect.runPromise(writePreferenceFile(path, { version: 1, ...normalized }));
      } catch (error) {
        logger.warn("Unable to save J.A.R.V.I.S. shortcut preference:", toLogValue(error));
      }
      return { ...current };
    },
    initialize,
    dispose: () => {
      unregisterCurrent();
    },
  };
}
