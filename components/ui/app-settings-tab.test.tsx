// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, getDesktopSettings: vi.fn(), updateDesktopSettings: vi.fn() };
});

import { AppSettingsTab } from "@/components/ui/app-settings-tab";
import { type DesktopSettings, getDesktopSettings, updateDesktopSettings } from "@/lib/api";

const base: DesktopSettings = {
  claps: false,
  claps_available: true,
  claps_listening: false,
  obsidian_vault: "",
  obsidian_watching: false,
  autostart: true,
  autostart_available: true,
};

function serve(current: DesktopSettings) {
  vi.mocked(getDesktopSettings).mockImplementation(async () => current);
  vi.mocked(updateDesktopSettings).mockImplementation(async (update) => ({ ...current, ...update }));
}

async function renderTab() {
  render(<AppSettingsTab />);
  await act(async () => {});
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { pywebview?: unknown }).pywebview;
});

describe("AppSettingsTab", () => {
  it("switches claps on through the backend", async () => {
    serve(base);
    await renderTab();
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: /palmas/i }));
    });
    expect(updateDesktopSettings).toHaveBeenLastCalledWith({ claps: true });
  });

  it("says so when claps are on but the microphone didn't open", async () => {
    serve({ ...base, claps: true, claps_listening: false });
    await renderTab();
    expect(screen.getByText(/microfone não abriu/i)).toBeTruthy();
  });

  it("connects a vault picked in Windows' folder dialog", async () => {
    serve(base);
    (window as unknown as { pywebview: unknown }).pywebview = {
      api: { pick_folder: async () => "C:/Users/lucas/Obsidian" },
    };
    await renderTab();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /escolher a pasta/i }));
    });
    expect(updateDesktopSettings).toHaveBeenLastCalledWith({ obsidian_vault: "C:/Users/lucas/Obsidian" });
  });

  it("falls back to typing the folder outside the app window", async () => {
    serve(base);
    await renderTab();
    fireEvent.change(screen.getByLabelText(/pasta do vault/i), { target: { value: "D:/Notas" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /conectar/i }));
    });
    expect(updateDesktopSettings).toHaveBeenLastCalledWith({ obsidian_vault: "D:/Notas" });
  });

  it("shows the backend's reason when a change is refused", async () => {
    serve(base);
    const { ApiError } = await import("@/lib/api");
    vi.mocked(updateDesktopSettings).mockImplementation(async () => {
      throw new ApiError("Essa pasta não existe.", 422);
    });
    await renderTab();
    fireEvent.change(screen.getByLabelText(/pasta do vault/i), { target: { value: "X:/nada" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /conectar/i }));
    });
    expect(screen.getByText("Essa pasta não existe.")).toBeTruthy();
  });
});
