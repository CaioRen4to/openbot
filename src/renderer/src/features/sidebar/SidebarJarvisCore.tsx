import { Button } from "@openbot/ui";
import { JarvisOrb, type JarvisOrbSatellite, type OrbBaseState } from "@openbot/ui/features/jarvis/JarvisOrb";
import type { SidebarAgentState } from "@openbot/ui/features/sidebar/sidebar-types";
import { useText } from "@openbot/ui/text";
import { createMemo } from "solid-js";
import { resolveOrbStatusWithAudio, useJarvisOrbAudio } from "../jarvis/jarvis-audio-signal";
import { setWakeWordEnabled, wakeWordEnabled } from "../jarvis/jarvis-maestro-store";
import { wakeWordStatus } from "../jarvis/jarvis-wake-word";

export interface SidebarJarvisCoreAgent {
  id: string;
  name: string;
  avatarColor?: string | null | undefined;
}

export interface SidebarJarvisCoreProps {
  agents: readonly SidebarJarvisCoreAgent[];
  agentStates: Record<string, SidebarAgentState | undefined>;
  hasFailedTurn: boolean;
  onSelectAgent: (agentId: string) => void;
  onOpenSearch: () => void;
}

export function SidebarJarvisCore(props: SidebarJarvisCoreProps) {
  const { t } = useText();
  const runningAgents = createMemo<JarvisOrbSatellite[]>(() =>
    props.agents
      .filter((agent) => {
        const state = props.agentStates[agent.id];
        return state?.kind === "working" || (state?.kind === "routine" && state.phase === "running");
      })
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        color: agent.avatarColor ?? undefined,
      })),
  );

  const attentionAgents = createMemo(() =>
    props.agents.filter((agent) => {
      const state = props.agentStates[agent.id];
      return state?.kind === "waiting" || state?.kind === "limited";
    }),
  );

  const audio = useJarvisOrbAudio();

  const baseStatus = createMemo<OrbBaseState>(() => {
    if (props.hasFailedTurn) return "error";
    if (runningAgents().length > 0) return "thinking";
    return "idle";
  });

  const status = createMemo<OrbBaseState>(() => resolveOrbStatusWithAudio(baseStatus(), audio().mode));

  const degraded = createMemo(() => attentionAgents().length > 0);

  const statusLabel = createMemo(() => {
    const audioMode = audio().mode;
    if (audioMode === "listening") {
      return t("island.jarvis.status.listening");
    }
    if (audioMode === "speaking") {
      return t("island.jarvis.status.speaking");
    }
    if (wakeWordEnabled()) {
      const wakeState = wakeWordStatus();
      if (wakeState === "checking") return t("island.jarvis.wake.checking");
      if (wakeState === "paused") return t("island.jarvis.wake.paused");
      if (wakeState === "error") return t("island.jarvis.wake.error");
    }
    const attentionCount = attentionAgents().length;
    if (attentionCount > 0) {
      return t("island.jarvis.waitingCount", { count: attentionCount });
    }
    const activeCount = runningAgents().length;
    if (activeCount > 0) {
      return t("island.jarvis.activeCount", { count: activeCount });
    }
    if (props.hasFailedTurn) {
      return t("island.jarvis.status.error");
    }
    return t("island.jarvis.status.idle");
  });

  function handleActivate(): void {
    const attention = attentionAgents()[0];
    if (attention) {
      props.onSelectAgent(attention.id);
      return;
    }
    const running = runningAgents()[0];
    if (running) {
      props.onSelectAgent(running.id);
      return;
    }
    props.onOpenSearch();
  }

  return (
    <div class="sidebar-jarvis-core">
      <Button
        type="button"
        variant="ghost"
        class="sidebar-jarvis-core-button"
        onClick={handleActivate}
        aria-label={t("island.jarvis.coreLabel", { status: statusLabel() })}
      >
        <div class="sidebar-jarvis-core-orb">
          <JarvisOrb
            status={status()}
            audioLevel={audio().level}
            degraded={degraded()}
            runningAgents={runningAgents()}
            handoffPulse={runningAgents().length > 0}
          />
        </div>
        <div class="sidebar-jarvis-core-meta">
          <span class="sidebar-jarvis-core-title">{t("island.jarvis.coreTitle")}</span>
          <span class="sidebar-jarvis-core-status" data-state={degraded() ? "attention" : status()}>
            {statusLabel()}
          </span>
        </div>
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        class="sidebar-jarvis-core-wake"
        data-active={wakeWordEnabled() ? "true" : "false"}
        aria-pressed={wakeWordEnabled() ? "true" : "false"}
        aria-label={t(wakeWordEnabled() ? "island.jarvis.wake.toggleOn" : "island.jarvis.wake.toggleOff")}
        onClick={() => setWakeWordEnabled(!wakeWordEnabled())}
      >
        <span class="sidebar-jarvis-core-wake-dot" aria-hidden="true" />
        <span>{t(wakeWordEnabled() ? "island.jarvis.wake.badgeOn" : "island.jarvis.wake.badgeOff")}</span>
      </Button>
    </div>
  );
}
