"use client";

import { MotionConfig } from "framer-motion";
import { ReactNode } from "react";

// App-wide motion policy. `reducedMotion="user"` makes every Framer Motion
// animation honour the OS "reduce motion" setting — the CSS media query only
// stops CSS animations, not Framer's JS-driven ones (message entrances, chip
// stagger, panel transitions, the hero pulse).
export function Providers({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
