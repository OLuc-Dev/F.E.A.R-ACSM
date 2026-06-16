"use client";

import { Suspense, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Float, RoundedBox } from "@react-three/drei";
import * as THREE from "three";

// A code-controlled F.E.A.R. presence: a graphite head with emissive red eyes
// and a mouth that animates while she speaks. Fully ours, fully reactive — no
// external 3D scene to depend on.

function Head({ speaking }: { speaking: boolean }) {
  const group = useRef<THREE.Group>(null);
  const mouth = useRef<THREE.Mesh>(null);
  const leftEye = useRef<THREE.MeshStandardMaterial>(null);
  const rightEye = useRef<THREE.MeshStandardMaterial>(null);

  useFrame((state) => {
    const t = state.clock.elapsedTime;

    if (group.current) {
      group.current.rotation.y = Math.sin(t * 0.5) * 0.28;
      group.current.rotation.x = Math.sin(t * 0.35) * 0.08;
    }

    // Eyes breathe; brighter and steadier while speaking.
    const base = speaking ? 2.2 : 1.4;
    const pulse = base + Math.sin(t * 3) * 0.35;
    if (leftEye.current) leftEye.current.emissiveIntensity = pulse;
    if (rightEye.current) rightEye.current.emissiveIntensity = pulse;

    // Mouth: a thin line at rest, opening/closing while speaking.
    if (mouth.current) {
      const target = speaking ? 0.08 + Math.abs(Math.sin(t * 13)) * 0.9 : 0.05;
      mouth.current.scale.y += (target - mouth.current.scale.y) * 0.4;
    }
  });

  return (
    <group ref={group}>
      <RoundedBox args={[2.2, 2.6, 2]} radius={0.36} smoothness={6}>
        <meshStandardMaterial color="#191b20" metalness={0.85} roughness={0.32} />
      </RoundedBox>

      {/* Recessed face plate */}
      <RoundedBox args={[1.74, 1.5, 0.2]} radius={0.2} position={[0, 0.05, 1.0]}>
        <meshStandardMaterial color="#0c0d10" metalness={0.5} roughness={0.45} />
      </RoundedBox>

      {/* Eyes */}
      <mesh position={[-0.42, 0.42, 1.12]}>
        <sphereGeometry args={[0.17, 24, 24]} />
        <meshStandardMaterial
          ref={leftEye}
          color="#ff2a2a"
          emissive="#ff1414"
          emissiveIntensity={1.6}
          toneMapped={false}
        />
      </mesh>
      <mesh position={[0.42, 0.42, 1.12]}>
        <sphereGeometry args={[0.17, 24, 24]} />
        <meshStandardMaterial
          ref={rightEye}
          color="#ff2a2a"
          emissive="#ff1414"
          emissiveIntensity={1.6}
          toneMapped={false}
        />
      </mesh>

      {/* Mouth */}
      <mesh ref={mouth} position={[0, -0.5, 1.12]} scale={[1, 0.05, 1]}>
        <boxGeometry args={[0.95, 0.42, 0.12]} />
        <meshStandardMaterial color="#ff2a2a" emissive="#ff1414" emissiveIntensity={1.3} toneMapped={false} />
      </mesh>
    </group>
  );
}

export function FearPresence({ speaking = false }: { speaking?: boolean }) {
  return (
    <Canvas camera={{ position: [0, 0, 6], fov: 42 }} dpr={[1, 2]}>
      <color attach="background" args={["#070809"]} />
      <ambientLight intensity={1.1} />
      <directionalLight position={[3, 4, 5]} intensity={2.6} />
      <pointLight position={[-4, -1, 3]} intensity={8} color="#6678ff" />
      <Suspense fallback={null}>
        <Float speed={1.6} rotationIntensity={0.25} floatIntensity={0.6}>
          <Head speaking={speaking} />
        </Float>
      </Suspense>
    </Canvas>
  );
}
