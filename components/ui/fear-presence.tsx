"use client";

import { Suspense, useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import {
  Center,
  ContactShadows,
  Environment,
  Float,
  Lightformer,
  Sparkles,
  useGLTF,
} from "@react-three/drei";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";

// The F.E.A.R. presence now renders a sculpted head model (glTF). It auto-fits
// and centers, then stays reactive: it drifts on idle, tracks the cursor, breathes,
// and nods/quickens while speaking. Fully client-side (loaded via dynamic import).

export type PresenceStatus = "online" | "listening" | "thinking" | "speaking" | "error";

const MODEL_URL = "/models/fear-head.glb";

function HeadModel({ status }: { status: PresenceStatus }) {
  const group = useRef<THREE.Group>(null);
  const { scene } = useGLTF(MODEL_URL);

  // Clone so the cached scene can't end up parented in two places, then measure
  // it to derive a fit scale that works regardless of the model's export units.
  const model = useMemo(() => scene.clone(true), [scene]);
  const fit = useMemo(() => {
    const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    return 3.4 / maxDim;
  }, [model]);

  const speaking = status === "speaking";
  const thinking = status === "thinking";

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    const k = Math.min(1, delta * 3.2);
    if (!group.current) return;

    // Idle drift + cursor parallax; a faster nod while speaking, a slow tilt while thinking.
    const nod = speaking ? Math.sin(t * 9) * 0.05 : thinking ? Math.sin(t * 1.4) * 0.04 : 0;
    const targetY = Math.sin(t * 0.5) * 0.16 + state.pointer.x * 0.6;
    const targetX = Math.sin(t * 0.35) * 0.05 - state.pointer.y * 0.3 + nod;
    group.current.rotation.y += (targetY - group.current.rotation.y) * k;
    group.current.rotation.x += (targetX - group.current.rotation.x) * k;

    const breath = speaking ? 0.02 : 0.012;
    const speed = speaking ? 2.2 : 1.4;
    group.current.scale.setScalar(1 + Math.sin(t * speed) * breath);
  });

  return (
    <group ref={group}>
      <group scale={fit}>
        <Center>
          <primitive object={model} />
        </Center>
      </group>
    </group>
  );
}

useGLTF.preload(MODEL_URL);

export function FearPresence({ status = "online" }: { status?: PresenceStatus }) {
  return (
    <Canvas camera={{ position: [0, 0, 6.2], fov: 40 }} dpr={[1, 2]} gl={{ antialias: true }}>
      <color attach="background" args={["#06070a"]} />
      <fog attach="fog" args={["#06070a", 8, 16]} />

      <hemisphereLight args={["#aebfe0", "#15171c", 0.6]} />
      <directionalLight position={[4, 5, 5]} intensity={1.5} />
      <pointLight position={[-4, -1, 3]} intensity={3.5} color="#3b5bff" />
      {/* Soft cool fill from the front so the face stays readable */}
      <pointLight position={[0, 0.6, 4.5]} intensity={1.8} color="#cdd6ff" />

      <Suspense fallback={null}>
        {/* Procedural environment so metal/skin has soft streaks to reflect */}
        <Environment resolution={256}>
          <Lightformer form="rect" intensity={1.6} position={[0, 3, 2]} scale={[5, 1.4, 1]} color="#dfe6ff" />
          <Lightformer
            form="rect"
            intensity={1.2}
            position={[-4, 1, 1]}
            rotation={[0, Math.PI / 4, 0]}
            scale={[2.5, 4, 1]}
            color="#7aa2ff"
          />
          <Lightformer
            form="rect"
            intensity={1.0}
            position={[4, -1, 1]}
            rotation={[0, -Math.PI / 4, 0]}
            scale={[2.5, 4, 1]}
            color="#ff5a5a"
          />
        </Environment>

        <Float speed={1.2} rotationIntensity={0} floatIntensity={0.5}>
          <HeadModel status={status} />
        </Float>

        <Sparkles count={42} scale={9} size={2.2} speed={0.3} color="#9ab4ff" opacity={0.5} />
        <ContactShadows
          position={[0, -2.4, 0]}
          opacity={0.6}
          scale={12}
          blur={2.8}
          far={4.5}
          color="#000000"
        />
      </Suspense>

      <EffectComposer>
        <Bloom intensity={0.6} luminanceThreshold={0.7} luminanceSmoothing={0.2} mipmapBlur />
        <Vignette offset={0.3} darkness={0.7} />
      </EffectComposer>
    </Canvas>
  );
}
