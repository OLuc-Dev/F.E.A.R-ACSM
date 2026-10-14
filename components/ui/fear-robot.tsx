"use client";

import { type RefObject, useEffect, useRef, useState } from "react";
import Image from "next/image";
import type { RobotStatus } from "@/lib/fear-robot-motion";
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
  status?: RobotStatus;
  /** Bump to send a "new memory" surge through the core. */
  pulse?: number;
  /** Bump to make the robot wave (it waves back when it sees you wave). */
  greetSignal?: number;
  /** A hand to look at (0–1 view coordinates), read every frame; null: the cursor. */
  gaze?: RefObject<{ x: number; y: number } | null>;
}

interface RobotHandle {
  dispose: () => void;
  greet: () => void;
  setStatus: (status: RobotStatus) => void;
  surge: () => void;
}

export function FearRobot({
  modelUrl = "/models/fear-robot.glb",
  posterUrl = "/models/fear-robot-preview.png",
  className,
  animate = true,
  interactive = true,
  showGreeting = false,
  status = "online",
  pulse = 0,
  greetSignal = 0,
  gaze,
}: FearRobotProps) {
  const container = useRef<HTMLDivElement>(null);
  const scene = useRef<RobotHandle | null>(null);
  // Read at scene creation so a status that changed while three.js was still
  // loading isn't lost, without making status a reason to rebuild the scene.
  const statusRef = useRef(status);
  statusRef.current = status;
  const gazeRef = useRef(gaze);
  gazeRef.current = gaze;
  const [load, setLoad] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let cancelled = false;
    setLoad("loading");
    import("@/lib/fear-robot-scene")
      .then(({ createRobotScene }) => {
        if (cancelled) return;
        scene.current = createRobotScene(element, {
          modelUrl,
          animate,
          interactive,
          status: statusRef.current,
          gaze: () => gazeRef.current?.current ?? null,
          onReady: () => {
            if (!cancelled) setLoad("ready");
          },
          onError: () => {
            if (!cancelled) setLoad("error");
          },
        });
      })
      .catch(() => {
        if (!cancelled) setLoad("error");
      });
    return () => {
      cancelled = true;
      scene.current?.dispose();
      scene.current = null;
    };
  }, [modelUrl, animate, interactive]);

  useEffect(() => {
    scene.current?.setStatus(status);
  }, [status]);

  const lastPulse = useRef(pulse);
  useEffect(() => {
    if (pulse === lastPulse.current) return;
    lastPulse.current = pulse;
    scene.current?.surge();
  }, [pulse]);

  const lastGreet = useRef(greetSignal);
  useEffect(() => {
    if (greetSignal === lastGreet.current) return;
    lastGreet.current = greetSignal;
    scene.current?.greet();
  }, [greetSignal]);

  return (
    <div className={cn("relative h-[500px] w-full overflow-hidden", className)}>
      <div
        ref={container}
        className="absolute inset-0"
        role="img"
        aria-label="F.E.A.R. em 3D, com movimentos suaves e olhar que acompanha o cursor."
      />
      {load !== "ready" ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Image src={posterUrl} alt="F.E.A.R." fill sizes="100vw" className="object-contain" />
          {load === "loading" ? (
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
      {showGreeting && load === "ready" && animate ? (
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
