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

// The F.E.A.R. presence: a sculpted head (glTF) suspended inside a glowing amber
// energy core — rotating filigree, a soft halo, and drifting embers — for a
// showcase-worthy look. It auto-fits and centers, then stays reactive: it drifts
// on idle, tracks the cursor, breathes, and quickens while speaking. Fully
// client-side (loaded via dynamic import).

export type PresenceStatus = "online" | "listening" | "thinking" | "speaking" | "error";

const MODEL_URL = "/models/fear-head.glb";

// Glowing-eye placement as fractions of the head's half-extents (tuned visually),
// so it follows the sockets regardless of the model's scale.
const EYE = { fx: 0.34, fy: -0.08, fz: 0.95, r: 0.08 } as const;

// The energy core that surrounds the head: a soft additive halo, two counter-
// rotating wireframe shells (the "filigree"), and warm embers. Purely ambient —
// it reads hotter while F.E.A.R. speaks or errors.
// How long (seconds) a "new memory" surge takes to bloom and settle back.
const PULSE_SECONDS = 3.2;

function EnergyCore({ status, pulse = 0 }: { status: PresenceStatus; pulse?: number }) {
  const shell = useRef<THREE.Group>(null);
  const innerShell = useRef<THREE.Mesh>(null);
  // The surge shell: normally invisible, it flares through the filigree whenever
  // a new memory arrives, then fades to nothing over PULSE_SECONDS.
  const surge = useRef<THREE.Group>(null);
  const surgeMat = useRef<THREE.MeshBasicMaterial>(null);
  const pulseStart = useRef(-1000);
  const lastPulse = useRef(0);
  const hot = status === "speaking" || status === "error";

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    if (shell.current) {
      shell.current.rotation.y += delta * (hot ? 0.34 : 0.18);
      shell.current.rotation.x = Math.sin(t * 0.2) * 0.15;
    }
    if (innerShell.current) innerShell.current.rotation.y -= delta * (hot ? 0.5 : 0.3);

    // A new memory bumped the counter — start the surge from now.
    if (pulse !== lastPulse.current) {
      lastPulse.current = pulse;
      pulseStart.current = t;
    }
    const since = t - pulseStart.current;
    const p = since >= 0 && since < PULSE_SECONDS ? 1 - since / PULSE_SECONDS : 0;
    const eased = p * p; // ease-out: quick bloom, gentle settle
    if (surgeMat.current) surgeMat.current.opacity = eased * 0.42;
    // The light ripples outward through the web as it fades, then rests.
    if (surge.current) surge.current.scale.setScalar(p > 0 ? 1 + (1 - p) * 0.14 : 1);
  });

  return (
    <group>
      {/* Soft volumetric halo glowing from behind the head */}
      <mesh>
        <sphereGeometry args={[3.3, 64, 64]} />
        <meshBasicMaterial
          color="#ff8a1e"
          side={THREE.BackSide}
          transparent
          opacity={0.05}
          depthWrite={false}
          toneMapped={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* Outer + inner wireframe shells: the swirling energy filigree */}
      <group ref={shell}>
        <mesh>
          <icosahedronGeometry args={[2.55, 2]} />
          <meshBasicMaterial
            color="#ffb347"
            wireframe
            transparent
            opacity={hot ? 0.2 : 0.13}
            depthWrite={false}
            toneMapped={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
      </group>
      <mesh ref={innerShell}>
        <icosahedronGeometry args={[2.15, 1]} />
        <meshBasicMaterial
          color="#ffd27a"
          wireframe
          transparent
          opacity={0.09}
          depthWrite={false}
          toneMapped={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* Surge shell: a bright flare through the filigree on each new memory */}
      <group ref={surge}>
        <mesh>
          <icosahedronGeometry args={[2.35, 2]} />
          <meshBasicMaterial
            ref={surgeMat}
            color="#ffe2a6"
            wireframe
            transparent
            opacity={0}
            depthWrite={false}
            toneMapped={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
      </group>

      {/* Embers: a few quiet motes — restrained, not a particle storm. */}
      <Sparkles count={34} scale={[7, 7, 7]} size={1.1} speed={0.2} color="#ffc98f" opacity={0.28} />
      <Sparkles count={10} scale={[9, 9, 9]} size={2.3} speed={0.12} color="#ff9d47" opacity={0.24} />
    </group>
  );
}

function HeadModel({ status }: { status: PresenceStatus }) {
  const group = useRef<THREE.Group>(null);
  const leftEye = useRef<THREE.MeshStandardMaterial>(null);
  const rightEye = useRef<THREE.MeshStandardMaterial>(null);
  const leftGlow = useRef<THREE.PointLight>(null);
  const rightGlow = useRef<THREE.PointLight>(null);
  const { scene } = useGLTF(MODEL_URL);

  // Clone (the cached scene can't be parented twice) and re-skin every mesh in
  // dark chrome so the sculpt reads as Ultron-style metal, not its base texture.
  // The warm environment gives that steel a molten, gold-lit sheen.
  const model = useMemo(() => {
    const cloned = scene.clone(true);
    const metal = new THREE.MeshPhysicalMaterial({
      color: "#7c818b",
      metalness: 1,
      roughness: 0.42,
      clearcoat: 0.5,
      clearcoatRoughness: 0.3,
      envMapIntensity: 1.2,
    });
    cloned.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) mesh.material = metal;
    });
    return cloned;
  }, [scene]);

  // Fit scale from the bounding box (export units don't matter) plus the fitted
  // half-extents, used to anchor the eyes proportionally.
  const { fit, half } = useMemo(() => {
    const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const scale = 3.4 / maxDim;
    return { fit: scale, half: [(size.x * scale) / 2, (size.y * scale) / 2, (size.z * scale) / 2] };
  }, [model]);

  const speaking = status === "speaking";
  const thinking = status === "thinking";
  const error = status === "error";

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

    // Eyes hold a steady, cold glow at rest (barely breathing); they only get
    // active for speaking/error, and brood slowly while thinking.
    const base = error ? 4.4 : speaking ? 3.2 : thinking ? 1.6 : 2.1;
    const sway = speaking
      ? Math.sin(t * 9) * 0.6
      : thinking
        ? Math.sin(t * 1.4) * 0.5
        : Math.sin(t * 1.6) * 0.18;
    // An occasional cold, instant "blink" — a brief dip every few seconds.
    const blink = t % 6 < 0.1 ? 0.12 : 1;
    const pulse = (base + sway) * blink;
    if (leftEye.current) leftEye.current.emissiveIntensity = pulse;
    if (rightEye.current) rightEye.current.emissiveIntensity = pulse;
    // The eyes spill a faint red light onto the surrounding metal.
    const glow = (0.5 + Math.max(0, sway) * 0.15) * blink;
    if (leftGlow.current) leftGlow.current.intensity = glow;
    if (rightGlow.current) rightGlow.current.intensity = glow;
  });

  return (
    <group ref={group}>
      <group scale={fit}>
        <Center>
          <primitive object={model} />
        </Center>
      </group>

      {/* Deep-set, cold eyes: a dark recess framing a thin crimson LED slit. The
          red mind reads sharp against the surrounding amber. */}
      {[-1, 1].map((s) => (
        <group key={s} position={[s * half[0] * EYE.fx, half[1] * EYE.fy, half[2] * EYE.fz]}>
          <mesh position={[0, 0, -0.05]} scale={[2.2, 1.05, 1]}>
            <sphereGeometry args={[EYE.r, 20, 20]} />
            <meshStandardMaterial color="#050507" metalness={0.4} roughness={0.7} />
          </mesh>
          <mesh scale={[1.95, 0.5, 1]}>
            <sphereGeometry args={[EYE.r, 24, 24]} />
            <meshStandardMaterial
              ref={s < 0 ? leftEye : rightEye}
              color="#ff2a16"
              emissive="#ff1408"
              emissiveIntensity={2.1}
              toneMapped={false}
            />
          </mesh>
          <pointLight
            ref={s < 0 ? leftGlow : rightGlow}
            position={[0, 0, 0.12]}
            color="#ff2412"
            intensity={0.5}
            distance={1.5}
            decay={2}
          />
        </group>
      ))}
    </group>
  );
}

useGLTF.preload(MODEL_URL);

export function FearPresence({ status = "online", pulse = 0 }: { status?: PresenceStatus; pulse?: number }) {
  return (
    <Canvas camera={{ position: [0, 0, 6.2], fov: 40 }} dpr={[1, 2]} gl={{ antialias: true, alpha: true }}>
      {/* No opaque background: the canvas is transparent so the deck and the
          amber floor-glow show through, and the core reads as emanating into the
          column instead of sitting in a black box. Fog still adds warm depth to
          the geometry itself. */}
      <fog attach="fog" args={["#080502", 8, 17]} />

      <hemisphereLight args={["#ffd9a0", "#180d05", 0.55]} />
      <directionalLight position={[4, 5, 5]} intensity={1.6} color="#ffdca8" />
      {/* Warm key from the lower left — the core's own light (dialed back so the
          amber reads as a controlled glow, not a gamer neon). */}
      <pointLight position={[-4, -1, 3]} intensity={2.6} color="#ff9636" />
      {/* Soft warm fill from the front so the face stays readable */}
      <pointLight position={[0, 0.6, 4.5]} intensity={1.7} color="#ffcaa0" />
      {/* Amber rim from behind so the head separates from the dark backdrop */}
      <directionalLight position={[-3, 4, -5]} intensity={1.3} color="#ffb35c" />

      <Suspense fallback={null}>
        {/* Procedural environment so the steel picks up warm, gold-lit streaks */}
        <Environment resolution={256}>
          <Lightformer form="rect" intensity={1.1} position={[0, 3, 2]} scale={[4, 1.2, 1]} color="#ffe6bf" />
          <Lightformer
            form="rect"
            intensity={1.3}
            position={[-4, 1, 1]}
            rotation={[0, Math.PI / 4, 0]}
            scale={[2.5, 4, 1]}
            color="#ffab54"
          />
          <Lightformer
            form="rect"
            intensity={0.9}
            position={[4, -1, 1]}
            rotation={[0, -Math.PI / 4, 0]}
            scale={[2.5, 4, 1]}
            color="#ff7a3c"
          />
        </Environment>

        <EnergyCore status={status} pulse={pulse} />

        <Float speed={1.2} rotationIntensity={0} floatIntensity={0.5}>
          <HeadModel status={status} />
        </Float>

        <ContactShadows
          position={[0, -2.4, 0]}
          opacity={0.55}
          scale={12}
          blur={2.8}
          far={4.5}
          color="#000000"
        />
      </Suspense>

      <EffectComposer>
        {/* Restrained bloom: a higher threshold + lower intensity means only the
            true highlights (eyes, surge) glow — metal reads calm, not neon. */}
        <Bloom intensity={0.62} luminanceThreshold={0.72} luminanceSmoothing={0.3} mipmapBlur />
        <Vignette offset={0.35} darkness={0.5} />
      </EffectComposer>
    </Canvas>
  );
}
