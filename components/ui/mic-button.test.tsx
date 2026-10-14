// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MicButton } from "@/components/ui/mic-button";
import type { VoiceInput } from "@/lib/use-voice-input";

function fakeVoice(): VoiceInput {
  return {
    state: "idle",
    levelRef: { current: 0 },
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    hold: vi.fn(),
    cancel: vi.fn(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("MicButton from the keyboard", () => {
  it("a tap listens until you stop talking", () => {
    const voice = fakeVoice();
    render(<MicButton voice={voice} />);
    const button = screen.getByRole("button");
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.keyUp(button, { key: "Enter" });
    vi.advanceTimersByTime(1000);
    expect(voice.start).toHaveBeenCalledWith("auto");
    expect(voice.hold).not.toHaveBeenCalled(); // still ends on its own when you stop talking
    expect(voice.stop).not.toHaveBeenCalled();
  });

  it("holding the key is hold-to-talk, and its repeats are one press", () => {
    const voice = fakeVoice();
    render(<MicButton voice={voice} />);
    const button = screen.getByRole("button");
    fireEvent.keyDown(button, { key: " " });
    vi.advanceTimersByTime(500);
    fireEvent.keyDown(button, { key: " ", repeat: true });
    fireEvent.keyDown(button, { key: " ", repeat: true });
    expect(voice.start).toHaveBeenCalledTimes(1);
    expect(voice.hold).toHaveBeenCalledTimes(1);
    fireEvent.keyUp(button, { key: " " });
    expect(voice.stop).toHaveBeenCalledTimes(1); // letting go sends it
  });
});
