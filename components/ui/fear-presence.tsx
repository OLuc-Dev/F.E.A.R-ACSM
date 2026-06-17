"use client";

import { Suspense, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { ContactShadows, Environment, Float, Lightformer, RoundedBox, Sparkles } from "@react-three/drei";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";

// A code-controlled F.E.A.R. presence inspired by Ultron: a bright brushed-steel
// face defined by geometry — a scowling brow, deep-set almond eyes, a real nose,
// cheek panels, a jaw, and a segmented metal mouth that parts while she speaks.
// Fully ours, fully reactive — drifts on idle, tracks the cursor, shifts with status.

export type PresenceStatus = "online" | "listening" | "thinking" | "speaking" | "error";

// One bright steel for the whole face (Ultron is monochrome metal; the features
// read through form + light, not colour), plus a near-black recess for sockets,
// seams and the mouth cavity.
const STEEL = {
  color: "#c3c7cf",
  metalness: 1,
  roughness: 0.36,
  clearcoat: 0.6,
  clearcoatRoughness: 0.28,
  envMapIntensity: 1.25,
} as const;
const DARK = { color: "#08090c", metalness: 0.5, roughness: 0.6 } as const;

function Head({ status }: { status: PresenceStatus }) {
  const group = useRef<THREE.Group>(null);
  const mouth = useRef<THREE.Group>(null);
  const mouthGlow = useRef<THREE.MeshStandardMaterial>(null);
  const leftEye = useRef<THREE.MeshStandardMaterial>(null);
  const rightEye = useRef<THREE.MeshStandardMaterial>(null);

  const speaking = status === "speaking";
  const thinking = status === "thinking";
  const error = status === "error";

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    // Frame-rate-independent smoothing factor.
    const k = Math.min(1, delta * 3.2);

    if (group.current) {
      // Idle drift blended with a subtle parallax toward the pointer, so the
      // head feels aware of where you are without being a puppet.
      const targetY = Math.sin(t * 0.5) * 0.16 + state.pointer.x * 0.5;
      const targetX = Math.sin(t * 0.35) * 0.05 - state.pointer.y * 0.28;
      group.current.rotation.y += (targetY - group.current.rotation.y) * k;
      group.current.rotation.x += (targetX - group.current.rotation.x) * k;
      // Breathing — quicker and deeper while speaking.
      const breath = speaking ? 0.02 : 0.012;
      const speed = speaking ? 2.2 : 1.4;
      group.current.scale.setScalar(1 + Math.sin(t * speed) * breath);
    }

    const base = error ? 4.2 : speaking ? 3.2 : thinking ? 1.5 : 2.0;
    // Thinking broods on a slow wave; otherwise a steady pulse.
    const wobble = thinking ? Math.sin(t * 1.6) * 0.7 : Math.sin(t * 3) * 0.5;
    const pulse = base + wobble;
    if (leftEye.current) leftEye.current.emissiveIntensity = pulse;
    if (rightEye.current) rightEye.current.emissiveIntensity = pulse;

    if (mouth.current) {
      const target = speaking ? 0.45 + Math.abs(Math.sin(t * 13)) * 0.9 : 0.3;
      mouth.current.scale.y += (target - mouth.current.scale.y) * 0.4;
    }
    if (mouthGlow.current) {
      const target = speaking ? 2.4 + Math.abs(Math.sin(t * 16)) * 1.6 : 0.7;
      mouthGlow.current.emissiveIntensity += (target - mouthGlow.current.emissiveIntensity) * k;
    }
  });

  return (
    <group ref={group}>
      {/* Cranium */}
      <mesh scale={[1.32, 1.62, 1.46]}>
        <sphereGeometry args={[1, 96, 96]} />
        <meshPhysicalMaterial {...STEEL} />
      </mesh>

      {/* Jaw / chin — a narrower bulge at the lower front */}
      <mesh position={[0, -0.86, 0.26]} scale={[1.04, 0.82, 1.04]}>
        <sphereGeometry args={[1, 64, 64]} />
        <meshPhysicalMaterial {...STEEL} />
      </mesh>

      {/* Brow ridge — two halves dipping to the centre for an angry scowl */}
      {[-1, 1].map((s) => (
        <RoundedBox
          key={`brow-${s}`}
          args={[0.76, 0.19, 0.34]}
          radius={0.08}
          smoothness={4}
          position={[s * 0.35, 0.55, 1.36]}
          rotation={[0.32, s * -0.08, s * 0.32]}
        >
          <meshPhysicalMaterial {...STEEL} />
        </RoundedBox>
      ))}

      {/* Nose — bridge + tip, clearly protruding */}
      <RoundedBox args={[0.17, 0.62, 0.26]} radius={0.07} smoothness={4} position={[0, 0.14, 1.52]}>
        <meshPhysicalMaterial {...STEEL} />
      </RoundedBox>
      <mesh position={[0, -0.18, 1.56]} scale={[1.2, 0.85, 1]}>
        <sphereGeometry args={[0.17, 28, 28]} />
        <meshPhysicalMaterial {...STEEL} />
      </mesh>

      {/* Cheek panels — flat planes that flow into the jaw */}
      {[-1, 1].map((s) => (
        <RoundedBox
          key={`cheek-${s}`}
          args={[0.5, 0.64, 0.16]}
          radius={0.12}
          smoothness={4}
          position={[s * 0.72, -0.22, 1.02]}
          rotation={[0.06, s * -0.62, s * 0.12]}
        >
          <meshPhysicalMaterial {...STEEL} />
        </RoundedBox>
      ))}

      {/* Deep-set almond eyes */}
      {[-0.41, 0.41].map((x, i) => (
        <group key={x} position={[x, 0.34, 1.32]} rotation={[0, 0, x < 0 ? 0.2 : -0.2]}>
          <mesh position={[0, 0, -0.12]} scale={[1.6, 0.95, 1]}>
            <sphereGeometry args={[0.2, 28, 28]} />
            <meshStandardMaterial {...DARK} />
          </mesh>
          <mesh scale={[1.55, 0.72, 1]}>
            <sphereGeometry args={[0.15, 32, 32]} />
            <meshStandardMaterial
              ref={i === 0 ? leftEye : rightEye}
              color="#ff3a1e"
              emissive="#ff2810"
              emissiveIntensity={2.4}
              toneMapped={false}
            />
          </mesh>
        </group>
      ))}

      {/* Segmented metal mouth — silver teeth over a dark, faintly-red cavity */}
      <group ref={mouth} position={[0, -0.5, 1.36]} scale={[1, 0.3, 1]}>
        <mesh position={[0, 0, -0.06]}>
          <planeGeometry args={[0.86, 0.5]} />
          <meshStandardMaterial
            ref={mouthGlow}
            color="#ff2a14"
            emissive="#ff1c0a"
            emissiveIntensity={0.7}
            toneMapped={false}
          />
        </mesh>
        {[-0.36, -0.24, -0.12, 0, 0.12, 0.24, 0.36].map((x) => (
          <mesh key={x} position={[x, 0, 0.02]}>
            <boxGeometry args={[0.07, 0.5, 0.12]} />
            <meshPhysicalMaterial {...STEEL} />
          </mesh>
        ))}
      </group>
    </group>
  );
}

export function FearPresence({ status = "online" }: { status?: PresenceStatus }) {
  return (
    <Canvas camera={{ position: [0, 0, 6.2], fov: 40 }} dpr={[1, 2]} gl={{ antialias: true }}>
      <color attach="background" args={["#06070a"]} />
      <fog attach="fog" args={["#06070a", 8, 16]} />

      <hemisphereLight args={["#aebfe0", "#15171c", 0.55]} />
      <directionalLight position={[4, 5, 5]} intensity={1.4} />
      <pointLight position={[-4, -1, 3]} intensity={4} color="#3b5bff" />
      {/* Soft cool fill from the front so the face features stay readable */}
      <pointLight position={[0, 0.6, 4.5]} intensity={1.6} color="#cdd6ff" />

      <Suspense fallback={null}>
        {/* Procedural environment so the chrome has soft streaks to reflect */}
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

        <Float speed={1.3} rotationIntensity={0.22} floatIntensity={0.6}>
          <Head status={status} />
        </Float>

        <Sparkles count={42} scale={9} size={2.2} speed={0.3} color="#9ab4ff" opacity={0.5} />
        <ContactShadows
          position={[0, -2.2, 0]}
          opacity={0.6}
          scale={12}
          blur={2.8}
          far={4.5}
          color="#000000"
        />
      </Suspense>

      <EffectComposer>
        {/* High threshold so only the emissive eyes/mouth bloom, not the chrome */}
        <Bloom intensity={0.7} luminanceThreshold={0.6} luminanceSmoothing={0.2} mipmapBlur />
        <Vignette offset={0.3} darkness={0.7} />
      </EffectComposer>
    </Canvas>
  );
}
