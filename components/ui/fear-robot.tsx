"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { cn } from "@/lib/utils";

// The full-body presence: a humanoid shell in F.E.A.R.'s chrome and amber, with
// a crimson visor that tracks the cursor. The three.js scene is pulled in on
// demand so the WebGL bundle stays off the initial load, and a static poster
// covers the gap (and any GPU failure) instead of a blank frame.

export interface FearRobotProps {
  modelUrl?: string;
  posterUrl?: string;
  className?: string;
  animate?: boolean;
  interactive?: boolean;
  showGreeting?: boolean;
}

export function FearRobot({
  modelUrl = "/models/fear-robot.glb",
  posterUrl = "/models/fear-robot-preview.png",
  className,
  animate = true,
  interactive = true,
  showGreeting = false,
}: FearRobotProps) {
  const container = useRef<HTMLDivElement>(null);
  const scene = useRef<{ dispose: () => void; greet: () => void } | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let cancelled = false;
    setStatus("loading");
    import("@/lib/fear-robot-scene")
      .then(({ createRobotScene }) => {
        if (cancelled) return;
        scene.current = createRobotScene(element, {
          modelUrl,
          animate,
          interactive,
          onReady: () => {
            if (!cancelled) setStatus("ready");
          },
          onError: () => {
            if (!cancelled) setStatus("error");
          },
        });
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
      scene.current?.dispose();
      scene.current = null;
    };
  }, [modelUrl, animate, interactive]);

  return (
    <div className={cn("relative h-[500px] w-full overflow-hidden", className)}>
      <div
        ref={container}
        className="absolute inset-0"
        role="img"
        aria-label="F.E.A.R. em 3D, com movimentos suaves e olhar que acompanha o cursor."
      />
      {status !== "ready" ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Image src={posterUrl} alt="F.E.A.R." fill sizes="100vw" className="object-contain" />
          {status === "loading" ? (
            // Cyan, not amber: loading is the "working" signal, and amber is
            // reserved for F.E.A.R.'s own energy.
            <span
              className="absolute bottom-5 size-5 animate-spin rounded-full border-2 border-overlay/20 border-t-brand motion-reduce:animate-none"
              role="status"
              aria-label="Carregando modelo 3D"
            />
          ) : null}
        </div>
      ) : null}
      {showGreeting && status === "ready" && animate ? (
        <button
          type="button"
          onClick={() => scene.current?.greet()}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-overlay/20 bg-overlay/5 px-4 py-2 text-sm text-foreground backdrop-blur focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand"
        >
          Acenar
        </button>
      ) : null}
    </div>
  );
}
