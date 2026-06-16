"use client";

import { Suspense, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { ContactShadows, Float, RoundedBox, Sparkles } from "@react-three/drei";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";

// A code-controlled F.E.A.R. presence: a graphite head with glowing red eyes
// and a mouth that animates while she speaks. Fully ours, fully reactive.

function Head({ speaking }: { speaking: boolean }) {
  const group = useRef<THREE.Group>(null);
  const mouth = useRef<THREE.Mesh>(null);
  const leftEye = useRef<THREE.MeshStandardMaterial>(null);
  const rightEye = useRef<THREE.MeshStandardMaterial>(null);

  useFrame((state) => {
    const t = state.clock.elapsedTime;

    if (group.current) {
      group.current.rotation.y = Math.sin(t * 0.5) * 0.26;
      group.current.rotation.x = Math.sin(t * 0.35) * 0.07;
      const breathe = 1 + Math.sin(t * 1.4) * 0.012;
      group.current.scale.setScalar(breathe);
    }

    const base = speaking ? 3.2 : 2.0;
    const pulse = base + Math.sin(t * 3) * 0.5;
    if (leftEye.current) leftEye.current.emissiveIntensity = pulse;
    if (rightEye.current) rightEye.current.emissiveIntensity = pulse;

    if (mouth.current) {
      const target = speaking ? 0.08 + Math.abs(Math.sin(t * 13)) * 0.95 : 0.05;
      mouth.current.scale.y += (target - mouth.current.scale.y) * 0.4;
    }
  });

  return (
    <group ref={group}>
      {/* Head shell — graphite with a clearcoat sheen */}
      <RoundedBox args={[2.2, 2.6, 2]} radius={0.4} smoothness={8}>
        <meshPhysicalMaterial
          color="#15171c"
          metalness={0.9}
          roughness={0.34}
          clearcoat={0.7}
          clearcoatRoughness={0.28}
        />
      </RoundedBox>

      {/* Recessed glossy face plate */}
      <RoundedBox args={[1.78, 1.62, 0.22]} radius={0.24} position={[0, 0.04, 1.0]}>
        <meshPhysicalMaterial color="#080910" metalness={0.6} roughness={0.25} clearcoat={1} clearcoatRoughness={0.15} />
      </RoundedBox>

      {/* Brow accent line */}
      <mesh position={[0, 0.72, 1.08]}>
        <boxGeometry args={[1.5, 0.05, 0.08]} />
        <meshStandardMaterial color="#3a4256" metalness={0.8} roughness={0.4} />
      </mesh>

      {/* Eyes */}
      {[-0.44, 0.44].map((x, i) => (
        <group key={x} position={[x, 0.4, 1.13]}>
          <mesh>
            <sphereGeometry args={[0.19, 32, 32]} />
            <meshStandardMaterial
              ref={i === 0 ? leftEye : rightEye}
              color="#ff2a2a"
              emissive="#ff1414"
              emissiveIntensity={2}
              toneMapped={false}
            />
          </mesh>
          {/* bright inner core */}
          <mesh position={[0, 0, 0.08]}>
            <sphereGeometry args={[0.08, 24, 24]} />
            <meshStandardMaterial color="#fff1f1" emissive="#ffd0d0" emissiveIntensity={3} toneMapped={false} />
          </mesh>
        </group>
      ))}

      {/* Mouth */}
      <mesh ref={mouth} position={[0, -0.52, 1.13]} scale={[1, 0.05, 1]}>
        <boxGeometry args={[0.95, 0.4, 0.12]} />
        <meshStandardMaterial color="#ff2a2a" emissive="#ff1414" emissiveIntensity={1.6} toneMapped={false} />
      </mesh>
    </group>
  );
}

export function FearPresence({ speaking = false }: { speaking?: boolean }) {
  return (
    <Canvas camera={{ position: [0, 0, 6], fov: 40 }} dpr={[1, 2]} gl={{ antialias: true }}>
      <color attach="background" args={["#06070a"]} />
      <fog attach="fog" args={["#06070a", 7.5, 15]} />

      <ambientLight intensity={0.55} />
      <directionalLight position={[4, 5, 5]} intensity={2.4} />
      <pointLight position={[-4, -1, 3]} intensity={11} color="#3b5bff" />
      <pointLight position={[3, -2, 2]} intensity={6} color="#ff3030" />

      <Suspense fallback={null}>
        <Float speed={1.4} rotationIntensity={0.25} floatIntensity={0.7}>
          <Head speaking={speaking} />
        </Float>
        <Sparkles count={42} scale={9} size={2.2} speed={0.3} color="#7aa2ff" opacity={0.5} />
        <ContactShadows position={[0, -2.05, 0]} opacity={0.55} scale={11} blur={2.8} far={4.2} color="#000000" />
      </Suspense>

      <EffectComposer>
        <Bloom intensity={1.1} luminanceThreshold={0.2} luminanceSmoothing={0.32} mipmapBlur />
        <Vignette offset={0.28} darkness={0.72} />
      </EffectComposer>
    </Canvas>
  );
}
