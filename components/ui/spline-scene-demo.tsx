'use client';

import { Card } from '@/components/ui/card';
import { SplineScene } from '@/components/ui/splite';
import { Spotlight } from '@/components/ui/spotlight';

export function SplineSceneBasic() {
  return (
    <Card className="relative h-[500px] w-full overflow-hidden bg-black/[0.96]">
      <Spotlight className="-top-40 left-0 md:-top-20 md:left-60" fill="white" />

      <div className="flex h-full flex-col md:flex-row">
        <div className="relative z-10 flex flex-1 flex-col justify-center p-8">
          <p className="mb-3 text-sm uppercase tracking-[0.35em] text-cyan-300/70">
            F.E.A.R. interface
          </p>
          <h1 className="bg-gradient-to-b from-neutral-50 to-neutral-400 bg-clip-text text-4xl font-bold text-transparent md:text-5xl">
            Interactive 3D
          </h1>
          <p className="mt-4 max-w-lg text-neutral-300">
            A visual presence layer for F.E.A.R. with 3D scenes, voice states,
            memory signals, and a quiet desktop command console.
          </p>
        </div>

        <div className="relative min-h-[260px] flex-1">
          <SplineScene
            scene="https://prod.spline.design/kZDDjO5HuC9GJUM2/scene.splinecode"
            className="h-full w-full"
          />
        </div>
      </div>
    </Card>
  );
}
