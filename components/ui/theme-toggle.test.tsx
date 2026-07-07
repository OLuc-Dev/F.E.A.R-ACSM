// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ThemeToggle } from "@/components/ui/theme-toggle";

beforeEach(() => {
  document.documentElement.className = "";
  localStorage.clear();
});
afterEach(cleanup);

describe("ThemeToggle", () => {
  it("has an accessible label and reflects the dark theme by default", () => {
    render(<ThemeToggle />);
    // No .light class → dark → the button offers to switch TO light.
    expect(screen.getByRole("button").getAttribute("aria-label")).toMatch(/tema claro/i);
  });

  it("reflects the light theme when <html> carries .light", () => {
    document.documentElement.classList.add("light");
    render(<ThemeToggle />);
    expect(screen.getByRole("button").getAttribute("aria-label")).toMatch(/tema escuro/i);
  });

  it("toggles the class and persists the choice on click", () => {
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole("button"));
    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("fear-theme")).toBe("light");
    // Label now offers to go back to dark.
    expect(screen.getByRole("button").getAttribute("aria-label")).toMatch(/tema escuro/i);
  });

  it("toggles back to dark and persists it", () => {
    document.documentElement.classList.add("light");
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole("button"));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.classList.contains("light")).toBe(false);
    expect(localStorage.getItem("fear-theme")).toBe("dark");
  });
});
