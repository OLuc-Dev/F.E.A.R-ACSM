import { MathUtils, Mesh, MeshStandardMaterial, Object3D, PointLight } from "three";

// Idle movement for the full-body presence: independent head/torso/arm drift,
// cursor tracking, irregular blinks, a pulsing core and a wave on demand. The
// model ships with no baked animation, so every pose is computed here.

export interface RobotPointer {
  x: number;
  y: number;
  active: boolean;
}

export function createRobotMotion(root: Object3D) {
  const get = (name: string) => root.getObjectByName(name);
  const body = get("FEAR_BODY") ?? get("FEAR_ROBOT") ?? root;
  const head = get("FEAR_HEAD");
  const torso = get("FEAR_TORSO");
  const eyes = get("FEAR_EYES");
  const ring = get("FEAR_CORE_RING");
  const arms = [get("FEAR_ARM_L"), get("FEAR_ARM_R")];
  const forearms = [get("FEAR_FOREARM_L"), get("FEAR_FOREARM_R")];
  const cubes = [1, 2, 3].map((i) => get(`FEAR_DATA_CUBE_${i}`));
  const moving = [body, head, torso, eyes, ring, ...arms, ...forearms, ...cubes].filter((o): o is Object3D =>
    Boolean(o),
  );
  const rest = new Map(
    moving.map((o) => [
      o,
      { position: o.position.clone(), rotation: o.rotation.clone(), scale: o.scale.clone() },
    ]),
  );
  const materials = new Set<MeshStandardMaterial>();
  root.traverse((o) => {
    if (
      o instanceof Mesh &&
      o.material instanceof MeshStandardMaterial &&
      o.material.name === "FEAR_CORE_EMISSIVE"
    ) {
      materials.add(o.material);
    }
  });

  let yaw = 0;
  let pitch = 0;
  let nextBlink = 4.6;
  let blinkStart = -10;
  let greetingStart = -10;

  function reset() {
    for (const [o, state] of rest) {
      o.position.copy(state.position);
      o.rotation.copy(state.rotation);
      o.scale.copy(state.scale);
    }
    for (const material of materials) material.emissiveIntensity = 1.6;
    yaw = 0;
    pitch = 0;
  }

  return {
    reset,
    greet(time: number) {
      greetingStart = time;
    },
    update(time: number, delta: number, pointer: RobotPointer, reduced = false) {
      if (reduced) {
        reset();
        return;
      }
      const dt = MathUtils.clamp(delta, 0, 0.05);
      const px = pointer.active ? MathUtils.clamp(pointer.x, -1, 1) : 0;
      const py = pointer.active ? MathUtils.clamp(pointer.y, -1, 1) : 0;
      const targetYaw = pointer.active ? px * 0.35 : Math.sin(time * 0.45) * 0.085;
      const targetPitch = pointer.active ? py * 0.16 : Math.sin(time * 0.64 + 0.7) * 0.025;
      yaw = MathUtils.damp(yaw, targetYaw, 7, dt);
      pitch = MathUtils.damp(pitch, targetPitch, 7, dt);

      if (head) {
        head.rotation.y = rest.get(head)!.rotation.y + yaw;
        head.rotation.x = rest.get(head)!.rotation.x + pitch;
      }
      body.position.y = rest.get(body)!.position.y + Math.sin(time * 1.1) * 0.009;
      body.rotation.y = rest.get(body)!.rotation.y + yaw * 0.2;
      body.rotation.z = rest.get(body)!.rotation.z + Math.sin(time * 0.7) * 0.007 - px * 0.011;
      if (torso) {
        torso.scale.y = rest.get(torso)!.scale.y * (1 + Math.sin((time * Math.PI * 2) / 4.8) * 0.008);
      }
      arms.forEach((arm, i) => {
        if (!arm) return;
        arm.rotation.x = rest.get(arm)!.rotation.x + Math.sin(time * 1.05 + i * 1.3) * 0.03;
        arm.rotation.z = rest.get(arm)!.rotation.z + Math.sin(time * 0.73 + i) * 0.013;
      });
      forearms.forEach((arm, i) => {
        if (arm) {
          arm.rotation.x = rest.get(arm)!.rotation.x + Math.sin(time * 0.95 + i + 0.6) * 0.038;
        }
      });

      const greetT = (time - greetingStart) / 2.5;
      if (greetT >= 0 && greetT <= 1) {
        const amount = Math.sin(Math.PI * greetT) ** 2;
        if (arms[0]) arms[0].rotation.z += amount * 1.05;
        if (forearms[0]) forearms[0].rotation.x -= amount * 0.95;
        if (head) head.rotation.z = rest.get(head)!.rotation.z - amount * 0.075;
      } else if (head) {
        head.rotation.z = rest.get(head)!.rotation.z;
      }

      const pulse = (1 + Math.sin((time * Math.PI * 2) / 2.9)) / 2;
      for (const material of materials) material.emissiveIntensity = 1.35 + pulse * 0.45;
      if (ring) ring.rotation.z = rest.get(ring)!.rotation.z + time * 0.23;
      cubes.forEach((cube, i) => {
        if (!cube) return;
        const state = rest.get(cube)!;
        cube.position.y = state.position.y + Math.sin(time * 0.9 + i * 1.2) * 0.012;
        cube.position.x = state.position.x + Math.sin(time * 0.4 + i) * 0.008;
        cube.rotation.y = state.rotation.y + time * 0.1;
      });

      if (time >= nextBlink) {
        blinkStart = time;
        // Deterministic irregular interval: 4–7 s, reproducible in previews.
        nextBlink = time + 4 + ((((Math.sin(time * 12.9898) * 43758.5453) % 1) + 1) % 1) * 3;
      }
      const blink = time - blinkStart;
      if (eyes) {
        eyes.scale.y =
          rest.get(eyes)!.scale.y *
          (blink >= 0 && blink < 0.18 ? 1 - 0.88 * Math.sin((blink / 0.18) * Math.PI) : 1);
      }
      for (const name of ["FEAR_CORE_LIGHT", "FEAR_HOVER_LIGHT"]) {
        const light = get(name);
        if (light instanceof PointLight) light.intensity = 0.065 + pulse * 0.025;
      }
    },
  };
}
