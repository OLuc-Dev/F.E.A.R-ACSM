"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

type Theme = "light" | "dark";

// Header toggle for the light/dark themes. The no-flash script in the layout
// resolves the initial theme (saved choice → system preference → dark fallback)
// and sets the class on <html> before paint; this only reads it back and flips
// it, persisting the manual choice. Dark stays the canonical fallback.
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    setTheme(document.documentElement.classList.contains("light") ? "light" : "dark");
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(next);
    try {
      localStorage.setItem("fear-theme", next);
    } catch {
      // Private mode / storage disabled — the choice just won't persist.
    }
    setTheme(next);
  }

  const goingLight = theme === "dark";
  return (
    <button
      onClick={toggle}
      aria-label={goingLight ? "Mudar para o tema claro" : "Mudar para o tema escuro"}
      title={goingLight ? "Tema claro" : "Tema escuro"}
      className="tap grid size-9 place-items-center rounded-full border border-overlay/[0.08] bg-overlay/[0.03] text-muted-foreground transition hover:border-overlay/15 hover:text-foreground"
    >
      {goingLight ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}
