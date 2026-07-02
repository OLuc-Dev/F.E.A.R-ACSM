"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";

// A glass macOS-style dock, adapted for F.E.A.R.: icons are React nodes
// (e.g. lucide-react glyphs) instead of remote images, and the optional GSAP
// bounce path was dropped so the component has no extra dependencies.

export interface DockApp {
  id: string;
  name: string;
  icon: React.ReactNode;
}

interface MacOSDockProps {
  apps: DockApp[];
  onAppClick: (appId: string) => void;
  openApps?: string[];
  className?: string;
}

const MacOSDock: React.FC<MacOSDockProps> = ({ apps, onAppClick, openApps = [], className = "" }) => {
  const [mouseX, setMouseX] = useState<number | null>(null);
  const [currentScales, setCurrentScales] = useState<number[]>(apps.map(() => 1));
  const [currentPositions, setCurrentPositions] = useState<number[]>([]);
  const dockRef = useRef<HTMLDivElement>(null);
  const iconRefs = useRef<(HTMLDivElement | null)[]>([]);
  const animationFrameRef = useRef<number | undefined>(undefined);
  const lastMouseMoveTime = useRef<number>(0);

  const getResponsiveConfig = useCallback(() => {
    if (typeof window === "undefined") {
      return { baseIconSize: 56, maxScale: 1.6, effectWidth: 240 };
    }

    const smallerDimension = Math.min(window.innerWidth, window.innerHeight);

    if (smallerDimension < 480) {
      return {
        baseIconSize: Math.max(40, smallerDimension * 0.08),
        maxScale: 1.4,
        effectWidth: smallerDimension * 0.4,
      };
    } else if (smallerDimension < 768) {
      return {
        baseIconSize: Math.max(44, smallerDimension * 0.06),
        maxScale: 1.5,
        effectWidth: smallerDimension * 0.35,
      };
    } else if (smallerDimension < 1024) {
      return {
        baseIconSize: Math.max(48, smallerDimension * 0.05),
        maxScale: 1.55,
        effectWidth: smallerDimension * 0.3,
      };
    }
    return {
      baseIconSize: Math.max(52, Math.min(64, smallerDimension * 0.045)),
      maxScale: 1.6,
      effectWidth: 280,
    };
  }, []);

  const [config, setConfig] = useState(getResponsiveConfig);
  const { baseIconSize, maxScale, effectWidth } = config;
  const minScale = 1.0;
  const baseSpacing = Math.max(4, baseIconSize * 0.12);

  useEffect(() => {
    const handleResize = () => setConfig(getResponsiveConfig());
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [getResponsiveConfig]);

  const calculateTargetMagnification = useCallback(
    (mousePosition: number | null) => {
      if (mousePosition === null) {
        return apps.map(() => minScale);
      }

      return apps.map((_, index) => {
        const normalIconCenter = index * (baseIconSize + baseSpacing) + baseIconSize / 2;
        const minX = mousePosition - effectWidth / 2;
        const maxX = mousePosition + effectWidth / 2;

        if (normalIconCenter < minX || normalIconCenter > maxX) {
          return minScale;
        }

        const theta = ((normalIconCenter - minX) / effectWidth) * 2 * Math.PI;
        const cappedTheta = Math.min(Math.max(theta, 0), 2 * Math.PI);
        const scaleFactor = (1 - Math.cos(cappedTheta)) / 2;

        return minScale + scaleFactor * (maxScale - minScale);
      });
    },
    [apps, baseIconSize, baseSpacing, effectWidth, maxScale],
  );

  const calculatePositions = useCallback(
    (scales: number[]) => {
      let currentX = 0;
      return scales.map((scale) => {
        const scaledWidth = baseIconSize * scale;
        const centerX = currentX + scaledWidth / 2;
        currentX += scaledWidth + baseSpacing;
        return centerX;
      });
    },
    [baseIconSize, baseSpacing],
  );

  useEffect(() => {
    const initialScales = apps.map(() => minScale);
    setCurrentScales(initialScales);
    setCurrentPositions(calculatePositions(initialScales));
  }, [apps, calculatePositions, config]);

  const animateToTarget = useCallback(() => {
    const targetScales = calculateTargetMagnification(mouseX);
    const targetPositions = calculatePositions(targetScales);
    const lerpFactor = mouseX !== null ? 0.2 : 0.12;

    setCurrentScales((prevScales) =>
      prevScales.map(
        (currentScale, index) => currentScale + (targetScales[index] - currentScale) * lerpFactor,
      ),
    );
    setCurrentPositions((prevPositions) =>
      prevPositions.map(
        (currentPos, index) =>
          currentPos + ((targetPositions[index] ?? currentPos) - currentPos) * lerpFactor,
      ),
    );

    const scalesNeedUpdate = currentScales.some(
      (scale, index) => Math.abs(scale - targetScales[index]) > 0.002,
    );
    const positionsNeedUpdate = currentPositions.some(
      (pos, index) => Math.abs(pos - (targetPositions[index] ?? pos)) > 0.1,
    );

    if (scalesNeedUpdate || positionsNeedUpdate || mouseX !== null) {
      animationFrameRef.current = requestAnimationFrame(animateToTarget);
    }
  }, [mouseX, calculateTargetMagnification, calculatePositions, currentScales, currentPositions]);

  useEffect(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }
    animationFrameRef.current = requestAnimationFrame(animateToTarget);
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [animateToTarget]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const now = performance.now();
      if (now - lastMouseMoveTime.current < 16) {
        return;
      }
      lastMouseMoveTime.current = now;

      if (dockRef.current) {
        const rect = dockRef.current.getBoundingClientRect();
        const padding = Math.max(8, baseIconSize * 0.12);
        setMouseX(e.clientX - rect.left - padding);
      }
    },
    [baseIconSize],
  );

  const handleMouseLeave = useCallback(() => setMouseX(null), []);

  const createBounceAnimation = (element: HTMLElement) => {
    const bounceHeight = Math.max(-8, -baseIconSize * 0.15);
    element.style.transition = "transform 0.2s ease-out";
    element.style.transform = `translateY(${bounceHeight}px)`;
    setTimeout(() => {
      element.style.transform = "translateY(0px)";
    }, 200);
  };

  const handleAppClick = (appId: string, index: number) => {
    const element = iconRefs.current[index];
    if (element) {
      createBounceAnimation(element);
    }
    onAppClick(appId);
  };

  const contentWidth =
    currentPositions.length > 0
      ? Math.max(...currentPositions.map((pos, index) => pos + (baseIconSize * currentScales[index]) / 2))
      : apps.length * (baseIconSize + baseSpacing) - baseSpacing;

  const padding = Math.max(8, baseIconSize * 0.12);

  return (
    <div
      ref={dockRef}
      className={`backdrop-blur-md ${className}`}
      style={{
        width: `${contentWidth + padding * 2}px`,
        background: "rgba(20, 22, 30, 0.55)",
        // macOS-style vibrancy: saturate the backdrop the dock floats over.
        WebkitBackdropFilter: "blur(16px) saturate(170%)",
        backdropFilter: "blur(16px) saturate(170%)",
        borderRadius: `${Math.max(12, baseIconSize * 0.4)}px`,
        border: "1px solid rgba(255, 255, 255, 0.12)",
        boxShadow: `
          0 ${Math.max(4, baseIconSize * 0.1)}px ${Math.max(16, baseIconSize * 0.4)}px rgba(0, 0, 0, 0.45),
          inset 0 1px 0 rgba(255, 255, 255, 0.12),
          inset 0 -1px 0 rgba(0, 0, 0, 0.25)
        `,
        padding: `${padding}px`,
      }}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      <div className="relative" style={{ height: `${baseIconSize}px`, width: "100%" }}>
        {apps.map((app, index) => {
          const scale = currentScales[index] ?? 1;
          const position = currentPositions[index] || 0;
          const scaledSize = baseIconSize * scale;

          return (
            <div
              key={app.id}
              ref={(el) => {
                iconRefs.current[index] = el;
              }}
              className="absolute flex cursor-pointer flex-col items-center justify-end"
              title={app.name}
              aria-label={app.name}
              onClick={() => handleAppClick(app.id, index)}
              style={{
                left: `${position - scaledSize / 2}px`,
                bottom: "0px",
                width: `${scaledSize}px`,
                height: `${scaledSize}px`,
                transformOrigin: "bottom center",
                zIndex: Math.round(scale * 10),
              }}
            >
              <div
                className="flex items-center justify-center rounded-[22%] border border-white/10 bg-white/5"
                style={{
                  width: `${scaledSize}px`,
                  height: `${scaledSize}px`,
                  filter: `drop-shadow(0 ${Math.max(2, baseIconSize * 0.05)}px ${Math.max(4, baseIconSize * 0.1)}px rgba(0,0,0,0.4))`,
                }}
              >
                <div style={{ width: `${scaledSize * 0.5}px`, height: `${scaledSize * 0.5}px` }}>
                  {app.icon}
                </div>
              </div>

              {openApps.includes(app.id) && (
                <div
                  className="absolute"
                  style={{
                    bottom: `${Math.max(-2, -baseIconSize * 0.05)}px`,
                    left: "50%",
                    transform: "translateX(-50%)",
                    width: `${Math.max(3, baseIconSize * 0.06)}px`,
                    height: `${Math.max(3, baseIconSize * 0.06)}px`,
                    borderRadius: "50%",
                    // Active = cyan, matching the console's one status vocabulary.
                    backgroundColor: "rgba(103, 232, 249, 0.9)",
                    boxShadow: "0 0 6px rgba(34, 211, 238, 0.5)",
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default MacOSDock;
