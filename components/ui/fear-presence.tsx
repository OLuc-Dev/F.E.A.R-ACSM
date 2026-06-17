"use client";

import { Suspense, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { ContactShadows, Environment, Float, Lightformer, Sparkles } from "@react-three/drei";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";

// A code-controlled F.E.A.R. presence: a liquid-chrome head with glowing red
// eyes and a mouth that animates while she speaks. Fully ours, fully reactive —
// it drifts on idle, tracks the cursor, and shifts its energy with the status.

export type PresenceStatus = "online" | "listening" | "thinking" | "speaking" | "error";

function Head({ status }: { status: PresenceStatus }) {
  const group = useRef<THREE.Group>(null);
  const mouth = useRef<THREE.Mesh>(null);
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
      const target = speaking ? 0.08 + Math.abs(Math.sin(t * 13)) * 0.95 : 0.05;
      mouth.current.scale.y += (target - mouth.current.scale.y) * 0.4;
    }
  });

  return (
    <group ref={group}>
      {/* Chrome cranium — a polished metal ovoid */}
      <mesh scale={[1.5, 1.85, 1.6]}>
        <sphereGeometry args={[1, 96, 96]} />
        <meshPhysicalMaterial
          color="#c8ccd4"
          metalness={1}
          roughness={0.28}
          clearcoat={0.8}
          clearcoatRoughness={0.18}
          envMapIntensity={0.9}
        />
      </mesh>

      {/* Recessed dark eye band */}
      <mesh position={[0, 0.28, 1.28]}>
        <boxGeometry args={[1.5, 0.6, 0.18]} />
        <meshStandardMaterial color="#0a0b0f" metalness={0.7} roughness={0.3} />
      </mesh>

      {/* Eyes with a hot inner core */}
      {[-0.4, 0.4].map((x, i) => (
        <group key={x} position={[x, 0.3, 1.44]}>
          <mesh>
            <sphereGeometry args={[0.16, 32, 32]} />
            <meshStandardMaterial
              ref={i === 0 ? leftEye : rightEye}
              color="#ff2a2a"
              emissive="#ff1414"
              emissiveIntensity={2.2}
              toneMapped={false}
            />
          </mesh>
          <mesh position={[0, 0, 0.07]}>
            <sphereGeometry args={[0.07, 24, 24]} />
            <meshStandardMaterial
              color="#fff1f1"
              emissive="#ffd0d0"
              emissiveIntensity={3.2}
              toneMapped={false}
            />
          </mesh>
        </group>
      ))}

      {/* Mouth */}
      <mesh ref={mouth} position={[0, -0.66, 1.34]} scale={[1, 0.05, 1]}>
        <boxGeometry args={[0.85, 0.4, 0.12]} />
        <meshStandardMaterial color="#ff2a2a" emissive="#ff1414" emissiveIntensity={1.6} toneMapped={false} />
      </mesh>
    </group>
  );
}

export function FearPresence({ status = "online" }: { status?: PresenceStatus }) {
  return (
    <Canvas camera={{ position: [0, 0, 6.2], fov: 40 }} dpr={[1, 2]} gl={{ antialias: true }}>
      <color attach="background" args={["#06070a"]} />
      <fog attach="fog" args={["#06070a", 8, 16]} />

      <hemisphereLight args={["#aebfe0", "#15171c", 0.45]} />
      <directionalLight position={[4, 5, 5]} intensity={1.3} />
      <pointLight position={[-4, -1, 3]} intensity={4} color="#3b5bff" />

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
