"use client";

import { Suspense, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { ContactShadows, Environment, Float, Lightformer, RoundedBox, Sparkles } from "@react-three/drei";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";

// A code-controlled F.E.A.R. presence: a graphite robotic face with a defined
// brow, nose, cheekbones and jaw, glowing red eyes and an Ultron-style grille
// mouth that animates while she speaks. Fully ours, fully reactive — it drifts
// on idle, tracks the cursor, and shifts its energy with the status.

export type PresenceStatus = "online" | "listening" | "thinking" | "speaking" | "error";

// Material presets: dark graphite shell, brighter steel ridges that catch the
// light and read as raised features, and a near-black socket recess.
const GRAPHITE = {
  color: "#5e636c",
  metalness: 1,
  roughness: 0.32,
  clearcoat: 1,
  clearcoatRoughness: 0.16,
  envMapIntensity: 1.35,
} as const;
const STEEL = {
  color: "#aab0b8",
  metalness: 1,
  roughness: 0.22,
  clearcoat: 1,
  clearcoatRoughness: 0.12,
  envMapIntensity: 1.2,
} as const;

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
      const target = speaking ? 0.28 + Math.abs(Math.sin(t * 13)) * 0.95 : 0.18;
      mouth.current.scale.y += (target - mouth.current.scale.y) * 0.4;
    }
    if (mouthGlow.current) {
      const target = speaking ? 2.6 + Math.abs(Math.sin(t * 16)) * 1.6 : 0.9;
      mouthGlow.current.emissiveIntensity += (target - mouthGlow.current.emissiveIntensity) * k;
    }
  });

  return (
    <group ref={group}>
      {/* Graphite cranium — a polished metal ovoid */}
      <mesh scale={[1.42, 1.8, 1.5]}>
        <sphereGeometry args={[1, 96, 96]} />
        <meshPhysicalMaterial {...GRAPHITE} />
      </mesh>

      {/* Brow ridge — two angled halves meeting low at center (a faint scowl) */}
      {[-1, 1].map((s) => (
        <RoundedBox
          key={`brow-${s}`}
          args={[0.74, 0.17, 0.34]}
          radius={0.07}
          smoothness={4}
          position={[s * 0.4, 0.6, 1.4]}
          rotation={[0.34, s * -0.12, s * 0.16]}
        >
          <meshPhysicalMaterial {...STEEL} />
        </RoundedBox>
      ))}

      {/* Nose bridge + tip */}
      <RoundedBox args={[0.15, 0.66, 0.2]} radius={0.06} smoothness={4} position={[0, 0.16, 1.6]}>
        <meshPhysicalMaterial {...STEEL} />
      </RoundedBox>
      <RoundedBox args={[0.22, 0.18, 0.2]} radius={0.07} smoothness={4} position={[0, -0.2, 1.62]}>
        <meshPhysicalMaterial {...STEEL} />
      </RoundedBox>

      {/* Cheekbones — short angled struts that define the mid-face */}
      {[-1, 1].map((s) => (
        <RoundedBox
          key={`cheek-${s}`}
          args={[0.16, 0.48, 0.22]}
          radius={0.07}
          smoothness={4}
          position={[s * 0.6, -0.16, 1.36]}
          rotation={[0, s * -0.2, s * 0.62]}
        >
          <meshPhysicalMaterial {...STEEL} />
        </RoundedBox>
      ))}

      {/* Eyes set into dark sockets */}
      {[-0.42, 0.42].map((x, i) => (
        <group key={x} position={[x, 0.26, 1.46]}>
          <mesh position={[0, 0, -0.12]}>
            <sphereGeometry args={[0.22, 28, 28]} />
            <meshStandardMaterial color="#050507" metalness={0.5} roughness={0.55} />
          </mesh>
          <mesh>
            <sphereGeometry args={[0.14, 32, 32]} />
            <meshStandardMaterial
              ref={i === 0 ? leftEye : rightEye}
              color="#ff2a2a"
              emissive="#ff1414"
              emissiveIntensity={2.2}
              toneMapped={false}
            />
          </mesh>
          <mesh position={[0, 0, 0.07]}>
            <sphereGeometry args={[0.06, 24, 24]} />
            <meshStandardMaterial
              color="#fff1f1"
              emissive="#ffd0d0"
              emissiveIntensity={3.2}
              toneMapped={false}
            />
          </mesh>
        </group>
      ))}

      {/* Defined jaw / chin */}
      <RoundedBox
        args={[0.92, 0.5, 0.66]}
        radius={0.16}
        smoothness={4}
        position={[0, -1.04, 1.02]}
        rotation={[-0.26, 0, 0]}
      >
        <meshPhysicalMaterial {...GRAPHITE} />
      </RoundedBox>

      {/* Mouth — a red-lit recess behind dark vertical grille bars (Ultron) */}
      <group ref={mouth} position={[0, -0.62, 1.42]} scale={[1, 0.06, 1]}>
        <mesh position={[0, 0, -0.04]}>
          <planeGeometry args={[0.8, 0.42]} />
          <meshStandardMaterial
            ref={mouthGlow}
            color="#ff2a2a"
            emissive="#ff1414"
            emissiveIntensity={1.3}
            toneMapped={false}
          />
        </mesh>
        {[-0.3, -0.15, 0, 0.15, 0.3].map((x) => (
          <mesh key={x} position={[x, 0, 0.04]}>
            <boxGeometry args={[0.06, 0.46, 0.1]} />
            <meshStandardMaterial color="#1a1c20" metalness={0.9} roughness={0.4} />
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
