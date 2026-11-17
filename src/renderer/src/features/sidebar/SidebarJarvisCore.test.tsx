import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { setWakeWordEnabled } from "../jarvis/jarvis-maestro-store";
import { SidebarJarvisCore } from "./SidebarJarvisCore";

describe("SidebarJarvisCore", () => {
  it("renders orb, status, and wake-word toggle without hardcoded text", () => {
    setWakeWordEnabled(false);

    render(() => (
      <SidebarJarvisCore
        agents={[{ id: "a1", name: "Maestro" }]}
        agentStates={{}}
        hasFailedTurn={false}
        onSelectAgent={vi.fn()}
        onOpenSearch={vi.fn()}
      />
    ));

    expect(screen.getByText("J.A.R.V.I.S. CORE")).toBeInTheDocument();
    expect(screen.getByText("Standby")).toBeInTheDocument();
    const wakeBtn = screen.getByRole("button", { name: 'Turn on wake word listening ("Jarvis")' });
    expect(wakeBtn).toHaveAttribute("aria-pressed", "false");
  });
});
