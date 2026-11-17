import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { ComputerUseSetup } from "./ComputerUseSetup";
import * as computerUsePortModule from "./computer-use-port";

describe("ComputerUseSetup", () => {
  it("shows ready state on Windows/Linux and lets user enable Computer Use for all agents", async () => {
    const mockPort: computerUsePortModule.ComputerUsePort = {
      computerUse: {
        getState: async () => ({ status: "ready", permissions: [], message: null }),
        openPermissionPane: async () => ({ status: "ready", permissions: [], message: null }),
        closePermissionHelp: async () => {},
        getPermissionApp: async () => ({ name: "OpenBot", iconDataUrl: null, packaged: false }),
        startPermissionAppDrag: async () => {},
        revealPermissionApp: async () => {},
        onHighlightPlacement: () => () => {},
      },
      remoteDesktop: {
        checkSetup: vi.fn(),
      },
    };
    const portSpy = vi.spyOn(computerUsePortModule, "computerUsePort").mockReturnValue(mockPort);

    const onSetAgentComputerUse = vi.fn(async () => {});
    const onEnableAllComputerUse = vi.fn(async () => {});

    try {
      render(() => (
        <ComputerUseSetup
          variant="settings"
          agents={[
            { id: "a1", name: "JARVIS", computerUse: true },
            { id: "a2", name: "Publicador", computerUse: false },
          ]}
          onSetAgentComputerUse={onSetAgentComputerUse}
          onEnableAllComputerUse={onEnableAllComputerUse}
        />
      ));

      await waitFor(() => expect(screen.getByText("Computer Use is ready")).toBeInTheDocument());
      expect(screen.getByText("1 of 2 agents enabled")).toBeInTheDocument();

      const enableAll = screen.getByRole("button", { name: "Enable for all agents" });
      fireEvent.click(enableAll);
      await waitFor(() => expect(onEnableAllComputerUse).toHaveBeenCalledTimes(1));
    } finally {
      portSpy.mockRestore();
    }
  });
});
