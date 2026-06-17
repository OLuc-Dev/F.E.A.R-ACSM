import type { Transition } from "framer-motion";

// Shared spring presets so motion feels consistent across the console.
export const springSnappy: Transition = { type: "spring", stiffness: 420, damping: 34, mass: 0.7 };
export const springSoft: Transition = { type: "spring", stiffness: 260, damping: 28 };

// Quick crossfade for swapping views (welcome ↔ thread, settings tabs).
export const fade: Transition = { duration: 0.18, ease: "easeOut" };
