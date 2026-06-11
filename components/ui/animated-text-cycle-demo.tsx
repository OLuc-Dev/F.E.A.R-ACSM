"use client";

import AnimatedTextCycle from "@/components/ui/animated-text-cycle";

export function AnimatedTextCycleDemo() {
  return (
    <div className="max-w-[760px] p-4">
      <h1 className="text-left text-4xl font-light leading-tight text-muted-foreground md:text-6xl">
        F.E.A.R. turns your{" "}
        <AnimatedTextCycle
          words={[
            "voice",
            "memory",
            "desktop",
            "Spotify",
            "Obsidian",
            "gestures",
            "workflow",
            "presence",
          ]}
          interval={3000}
          className="font-semibold text-foreground"
        />{" "}
        into a quiet command system.
      </h1>
    </div>
  );
}
