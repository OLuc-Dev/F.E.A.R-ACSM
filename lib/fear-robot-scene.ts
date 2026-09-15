import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { createRobotMotion, type RobotPointer } from "./fear-robot-motion";

// Renderer, camera, lighting and teardown for the full-body presence. The
// lighting follows the same signal language as the head presence: amber is
// F.E.A.R.'s own energy, cyan is the interaction channel, and the plinth stays
// near-black so the glow reads as emanating rather than lit from outside.

// [colour, power, position] — the studio panels that become the environment map,
// so the chrome picks up warm streaks with one cool edge instead of flat grey.
const STUDIO_PANELS = [
  ["#ffe6bf", 3.2, [3, 3, 4]],
  ["#67e8f9", 3, [-3, 2, -2]],
  ["#ffdca8", 2.5, [0, 5, 0]],
  ["#ffcaa0", 0.7, [-2, 1, 4]],
] as const;

// Key from the warm side, cyan rim from behind, soft warm top fill.
const KEY_LIGHTS = [
  ["#ff9636", 2.6, [3, 4, 4]],
  ["#67e8f9", 4.5, [-3, 2, -3]],
  ["#ffdca8", 3, [-1, 5, 2]],
] as const;

interface SceneOptions {
  modelUrl: string;
  animate: boolean;
  interactive: boolean;
  onReady: () => void;
  onError: (error: unknown) => void;
}

export function createRobotScene(container: HTMLDivElement, options: SceneOptions) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 50);
  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    powerPreference: "low-power",
  });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.shadowMap.enabled = false;
  renderer.domElement.style.display = "block";
  renderer.domElement.setAttribute("aria-hidden", "true");
  container.appendChild(renderer.domElement);

  const studio = new THREE.Scene();
  studio.background = new THREE.Color("#050506");
  for (const [color, power, position] of STUDIO_PANELS) {
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(3, 4),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(color).multiplyScalar(power),
        side: THREE.DoubleSide,
      }),
    );
    panel.position.set(position[0], position[1], position[2]);
    panel.lookAt(0, 0.8, 0);
    studio.add(panel);
  }
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(studio, 0.06);
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.65;
  pmrem.dispose();
  disposeModel(studio);

  for (const [color, intensity, position] of KEY_LIGHTS) {
    const light = new THREE.DirectionalLight(color, intensity);
    light.position.set(position[0], position[1], position[2]);
    scene.add(light);
  }

  let disposed = false;
  let visible = true;
  let model: THREE.Object3D | undefined;
  let motion: ReturnType<typeof createRobotMotion> | undefined;
  let time = 0;
  let last = performance.now();
  const pointer: RobotPointer = { x: 0, y: 0, active: false };
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const abort = new AbortController();

  function resize() {
    if (disposed) return;
    const width = Math.max(container.clientWidth, 1);
    const height = Math.max(container.clientHeight, 1);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    const distance =
      Math.max(1.6 / (2 * Math.tan(Math.PI / 12)), 1.24 / (2 * Math.tan(Math.PI / 12) * camera.aspect)) *
      1.14;
    const target = new THREE.Vector3(0, 0.8, 0);
    camera.position.copy(target).add(new THREE.Vector3(0.16, 0.035, 1).normalize().multiplyScalar(distance));
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
  }
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);
  resize();

  const intersection = new IntersectionObserver((entries) => {
    visible = entries[0]?.isIntersecting ?? true;
    last = performance.now();
  });
  intersection.observe(container);

  function move(event: PointerEvent) {
    if (!options.interactive || event.pointerType === "touch") return;
    const rect = container.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1;
    pointer.y = ((event.clientY - rect.top) / Math.max(rect.height, 1)) * 2 - 1;
    pointer.active = true;
  }
  function leave() {
    pointer.active = false;
  }
  container.addEventListener("pointermove", move, { passive: true });
  container.addEventListener("pointerleave", leave);

  fetch(options.modelUrl, { signal: abort.signal })
    .then((response) => {
      if (!response.ok) throw new Error(`GLB: HTTP ${response.status}`);
      return response.arrayBuffer();
    })
    .then((buffer) => new GLTFLoader().parseAsync(buffer, ""))
    .then((gltf) => {
      if (disposed) {
        disposeModel(gltf.scene);
        return;
      }
      model = gltf.scene;
      scene.add(model);
      // ACES tone mapping desaturates a hot crimson emissive toward orange, so
      // the eyes come out amber and lost against the accents. Opting them out of
      // it is what keeps the red mind reading sharp — the head presence does the
      // same with toneMapped={false}.
      model.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          if (material.name === "FEAR_EYES_EMISSIVE") material.toneMapped = false;
        }
      });
      // Two faint point lights so the core and the hover ring spill their own
      // colour onto the surrounding chrome. The motion controller pulses them.
      const coreLight = new THREE.PointLight("#ffb347", 0.08, 0.55, 2);
      coreLight.name = "FEAR_CORE_LIGHT";
      coreLight.position.z = 0.085;
      model.getObjectByName("FEAR_CORE")?.add(coreLight);
      const hoverLight = new THREE.PointLight("#67e8f9", 0.08, 0.5, 2);
      hoverLight.name = "FEAR_HOVER_LIGHT";
      model.getObjectByName("FEAR_CYAN_PARTS_hover_ring")?.add(hoverLight);
      motion = createRobotMotion(model);
      last = performance.now();
      resize();
      options.onReady();
    })
    .catch((error) => {
      if (!disposed) options.onError(error);
    });

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const delta = Math.min((now - last) / 1000, 0.05);
    last = now;
    if (disposed || !visible || document.hidden || !motion) return;
    const frozen = !options.animate || reduced.matches;
    if (!frozen) time += delta;
    motion.update(time, delta, pointer, frozen);
    renderer.render(scene, camera);
  });

  return {
    greet() {
      if (options.animate && !reduced.matches) motion?.greet(time);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      abort.abort();
      renderer.setAnimationLoop(null);
      resizeObserver.disconnect();
      intersection.disconnect();
      container.removeEventListener("pointermove", move);
      container.removeEventListener("pointerleave", leave);
      if (model) disposeModel(model);
      environment.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

function disposeModel(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      geometries.add(o.geometry);
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => materials.add(m));
    }
  });
  geometries.forEach((g) => g.dispose());
  materials.forEach((m) => m.dispose());
}
