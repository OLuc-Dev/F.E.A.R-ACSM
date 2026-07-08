// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AssistantMessage } from "@/components/ui/messages";

afterEach(cleanup);

// Interaction side of the consulted-memories chip (the render side lives in
// messages.render.test.tsx): a real, keyboard-reachable button that opens the
// memory inspector.
describe("AssistantMessage consulted chip (interaction)", () => {
  it("is a labelled button that fires the click handler", () => {
    const onClick = vi.fn();
    render(<AssistantMessage content="resposta" consultedCount={2} onConsultedClick={onClick} />);

    const chip = screen.getByRole("button", {
      name: /2 memórias consultadas nesta resposta — ver na memória/i,
    });
    fireEvent.click(chip);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders no button at all when nothing was consulted", () => {
    render(<AssistantMessage content="resposta" consultedCount={0} onConsultedClick={vi.fn()} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
