"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Maximize2, Minus, Moon, Pause, Play, Plus, RotateCcw, Sun } from "lucide-react";
import clsx from "clsx";

/**
 * THE INTERACTIVE VILLA.
 *
 * Ported from the 360-villa-os-astra viewer. That project ships two ways in:
 * a React Three Fiber scene, and a standalone page meant to be dropped into
 * /public and framed. Neither one could be used as supplied here.
 *
 *  - The R3F path pins React Three Fiber 8, which supports React 18. This
 *    application is on React 19, where that version does not render.
 *  - The iframe path is blocked twice over by this application's own security
 *    headers: `script-src` carries `strict-dynamic`, so a module script in a
 *    framed document that has no nonce never executes; and the same middleware
 *    sets `X-Frame-Options: DENY` with `frame-ancestors 'none'`, which refuses
 *    the frame before the script question is even reached. Both would have had
 *    to be carved out for a path serving no data and needing no session.
 *
 * So the geometry — which is plain three.js, six classes and one exported
 * function — is kept, and the viewer around it is rewritten as an ordinary
 * client component. three is loaded by `import()` from inside a bundle the
 * middleware has already nonced, which `strict-dynamic` permits by design,
 * and the chrome is this application's own rather than a second design system
 * arriving in a frame.
 */

type Preset = "perspective" | "front" | "right" | "rear" | "left" | "roof";

const PRESETS: Array<{ key: Preset; label: string }> = [
  { key: "front", label: "Front" },
  { key: "right", label: "Right" },
  { key: "rear", label: "Rear" },
  { key: "left", label: "Left" },
  { key: "roof", label: "Roof" },
];

/** What the render loop and the buttons both need to reach. */
interface Rig {
  setPreset: (name: Preset | "in" | "out") => void;
  setNight: (night: boolean) => void;
  setAutoRotate: (on: boolean) => void;
}

export function Villa360({ className }: { className?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const rigRef = useRef<Rig | null>(null);

  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [night, setNight] = useState(false);
  const [spinning, setSpinning] = useState(false);
  const [active, setActive] = useState<Preset>("perspective");
  const [heading, setHeading] = useState(0);
  const [full, setFull] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let teardown: (() => void) | undefined;

    (async () => {
      try {
        // Loaded on demand, and only here: three is ~600KB, and most people
        // opening the showcase never switch to the 3D tab at all.
        const [THREE, { OrbitControls }, { createVilla }] = await Promise.all([
          import("three"),
          import("three/examples/jsm/controls/OrbitControls.js"),
          import("@/lib/showcase/villa-360-model"),
        ]);
        if (cancelled) return;

        const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6));
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.15;
        renderer.domElement.style.display = "block";
        renderer.domElement.style.width = "100%";
        renderer.domElement.style.height = "100%";
        host.append(renderer.domElement);

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(43, 1, 0.1, 160);
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.target.set(0, 4.2, 0);
        controls.enableDamping = true;
        controls.dampingFactor = 0.075;
        controls.rotateSpeed = 0.65;
        controls.zoomSpeed = 0.7;
        controls.panSpeed = 0.55;
        controls.minDistance = 12;
        controls.maxDistance = 48;
        controls.minPolarAngle = 0.02;
        controls.maxPolarAngle = Math.PI / 2 - 0.025;
        controls.autoRotateSpeed = 0.65;

        const ambient = new THREE.AmbientLight("#ffffff", 1.1);
        const hemisphere = new THREE.HemisphereLight("#e8f4ff", "#99937d", 1.6);
        const sun = new THREE.DirectionalLight("#fff4df", 2.5);
        sun.position.set(-12, 20, 14);
        sun.castShadow = true;
        sun.shadow.mapSize.set(2048, 2048);
        Object.assign(sun.shadow.camera, { left: -17, right: 17, top: 17, bottom: -17 });
        sun.shadow.normalBias = 0.04;
        const porch = new THREE.PointLight("#ffd49b", 0, 12);
        porch.position.set(-1.6, 5, 5.1);
        scene.add(ambient, hemisphere, sun, porch);

        const ground = new THREE.Mesh(
          new THREE.PlaneGeometry(180, 180),
          new THREE.MeshStandardMaterial({ color: "#e2e5e6", roughness: 1 }),
        );
        ground.rotation.x = -Math.PI / 2;
        ground.position.y = -0.25;
        ground.receiveShadow = true;
        scene.add(ground);

        let model = createVilla(false);
        scene.add(model);

        let isNight = false;
        let destination: InstanceType<typeof THREE.Vector3> | null = null;
        let targetDestination: InstanceType<typeof THREE.Vector3> | null = null;
        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

        function applyLight() {
          const background = new THREE.Color(isNight ? "#8995a7" : "#e6e9eb");
          scene.background = background;
          scene.fog = new THREE.Fog(background, 48, 100);
          ambient.intensity = isNight ? 0.65 : 1.1;
          hemisphere.intensity = isNight ? 0.8 : 1.6;
          sun.intensity = isNight ? 0.6 : 2.5;
          porch.intensity = isNight ? 32 : 0;
          (ground.material as InstanceType<typeof THREE.MeshStandardMaterial>).color.set(
            isNight ? "#a4abb4" : "#e2e5e6",
          );
        }
        applyLight();

        /** Materials differ between the two schemes, so the model is rebuilt. */
        function swapModel(to: boolean) {
          isNight = to;
          model.traverse((obj) => {
            const mesh = obj as InstanceType<typeof THREE.Mesh>;
            if (!mesh.isMesh) return;
            mesh.geometry.dispose();
            const material = mesh.material;
            if (Array.isArray(material)) material.forEach((m) => m.dispose());
            else material.dispose();
          });
          scene.remove(model);
          model = createVilla(to);
          scene.add(model);
          applyLight();
        }

        // Narrowing does not survive into this hoisted declaration, and the
        // element is captured for the life of the effect anyway.
        const stage: HTMLDivElement = host;
        function setPreset(name: Preset | "in" | "out") {
          const radius = stage.clientWidth < 680 ? 34 : 26;
          const views: Record<Preset, [number, number, number]> = {
            perspective: [radius * 0.65, 13, radius * 0.8],
            front: [0, 7, radius],
            right: [radius, 7, 0],
            rear: [0, 7, -radius],
            left: [-radius, 7, 0],
            roof: [0, 31, 0.5],
          };
          if (name === "in" || name === "out") {
            destination = camera.position
              .clone()
              .sub(controls.target)
              .multiplyScalar(name === "in" ? 0.8 : 1.25)
              .clampLength(12, 48)
              .add(controls.target);
            targetDestination = controls.target.clone();
          } else {
            destination = new THREE.Vector3(...views[name]);
            targetDestination = new THREE.Vector3(0, 4.2, 0);
          }
          if (reduceMotion) {
            camera.position.copy(destination);
            if (targetDestination) controls.target.copy(targetDestination);
            destination = null;
            controls.update();
          }
        }

        // A drag is the person taking over: stop the orbit and drop any
        // in-flight camera move, or the two fight for the same matrix.
        const onStart = () => {
          destination = null;
          controls.autoRotate = false;
          setSpinning(false);
        };
        controls.addEventListener("start", onStart);

        const resize = new ResizeObserver(() => {
          const w = host.clientWidth, h = host.clientHeight;
          if (!w || !h) return;
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          renderer.setSize(w, h, false);
        });
        resize.observe(host);

        setPreset("perspective");
        if (destination) {
          camera.position.copy(destination);
          if (targetDestination) controls.target.copy(targetDestination);
          destination = null;
          controls.update();
        }

        const clock = new THREE.Clock();
        let onScreen = true;
        const seen = new IntersectionObserver(([entry]) => { onScreen = entry?.isIntersecting ?? true; });
        seen.observe(host);

        let lastHeading = -1;
        renderer.setAnimationLoop(() => {
          const delta = Math.min(clock.getDelta(), 0.1);
          if (document.hidden || !onScreen) return;
          if (destination) {
            camera.position.lerp(destination, 1 - Math.exp(-delta * 5));
            if (targetDestination) controls.target.lerp(targetDestination, 1 - Math.exp(-delta * 5));
            if (camera.position.distanceTo(destination) < 0.025) destination = null;
          }
          controls.update();
          const angle = (Math.round(THREE.MathUtils.radToDeg(controls.getAzimuthalAngle())) + 360) % 360;
          // Only cross the React boundary when the needle actually moves a
          // degree — a setState every frame would re-render sixty times a
          // second for a three-character readout.
          if (angle !== lastHeading) { lastHeading = angle; setHeading(angle); }
          renderer.render(scene, camera);
        });

        const onLost = (e: Event) => {
          e.preventDefault();
          setStatus("failed");
        };
        renderer.domElement.addEventListener("webglcontextlost", onLost);

        rigRef.current = {
          setPreset,
          setNight: swapModel,
          setAutoRotate: (on) => { controls.autoRotate = on; if (on) destination = null; },
        };
        setStatus("ready");

        teardown = () => {
          renderer.setAnimationLoop(null);
          renderer.domElement.removeEventListener("webglcontextlost", onLost);
          controls.removeEventListener("start", onStart);
          resize.disconnect();
          seen.disconnect();
          controls.dispose();
          scene.traverse((obj) => {
            const mesh = obj as InstanceType<typeof THREE.Mesh>;
            if (!mesh.isMesh) return;
            mesh.geometry.dispose();
            const material = mesh.material;
            if (Array.isArray(material)) material.forEach((m) => m.dispose());
            else material.dispose();
          });
          renderer.dispose();
          renderer.domElement.remove();
          rigRef.current = null;
        };
      } catch {
        if (!cancelled) setStatus("failed");
      }
    })();

    return () => { cancelled = true; teardown?.(); };
  }, []);

  useEffect(() => {
    const onChange = () => setFull(document.fullscreenElement === stageRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  function preset(name: Preset) {
    setActive(name);
    setSpinning(false);
    rigRef.current?.setAutoRotate(false);
    rigRef.current?.setPreset(name);
  }

  const btn =
    "inline-flex items-center justify-center gap-1.5 rounded-full border border-ink-700 bg-ink-900/80 px-3 py-1.5 " +
    "text-[11px] font-medium text-mist-200 backdrop-blur transition-colors hover:border-ink-600 hover:text-mist-100";

  return (
    <div
      ref={stageRef}
      className={clsx("relative overflow-hidden rounded-2xl border border-ink-700/60 bg-[#e6e9eb]", className)}
    >
      <div
        ref={hostRef}
        tabIndex={0}
        role="application"
        aria-label="Interactive 3D villa. Drag to rotate, scroll to zoom."
        className="absolute inset-0 touch-none outline-none"
      />

      {status === "loading" && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 bg-ink-950 text-[12px] text-mist-400">
          <Loader2 size={14} className="animate-spin" /> Building the model…
        </div>
      )}

      {status === "failed" && (
        <div className="absolute inset-0 flex items-center justify-center px-8 text-center text-[12px] leading-relaxed text-mist-400">
          The 3D view could not start in this browser. Switch to Gallery for the project renders.
        </div>
      )}

      {status === "ready" && (
        <>
          <div className="pointer-events-none absolute left-3 top-3 rounded-md border border-black/10 bg-white/70 px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#455956]">
            3D concept model
          </div>

          <div className="pointer-events-none absolute right-3 top-3 flex items-center gap-2 rounded-md border border-black/10 bg-white/70 px-2.5 py-1.5 text-[#455956]">
            <span className="text-[13px] leading-none" style={{ transform: `rotate(${-heading}deg)` }} aria-hidden>
              ↑
            </span>
            <span className="tnum text-[10px] font-semibold">{String(heading).padStart(3, "0")}°</span>
          </div>

          <div className="absolute bottom-3 left-1/2 flex max-w-[94%] -translate-x-1/2 flex-wrap items-center justify-center gap-1.5">
            <button
              type="button"
              aria-pressed={spinning}
              onClick={() => {
                const on = !spinning;
                setSpinning(on);
                if (on) setActive("perspective");
                rigRef.current?.setAutoRotate(on);
              }}
              className={clsx(btn, spinning && "!border-brand-500/60 !text-mist-100")}
            >
              {spinning ? <Pause size={12} /> : <Play size={12} />}
              {spinning ? "Pause" : "Auto-rotate"}
            </button>

            {PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                aria-pressed={active === p.key && !spinning}
                onClick={() => preset(p.key)}
                className={clsx(btn, active === p.key && !spinning && "!border-brand-500/60 !text-mist-100")}
              >
                {p.label}
              </button>
            ))}

            <button
              type="button"
              aria-pressed={night}
              onClick={() => { const to = !night; setNight(to); rigRef.current?.setNight(to); }}
              className={clsx(btn, night && "!border-brand-500/60 !text-mist-100")}
            >
              {night ? <Sun size={12} /> : <Moon size={12} />}
              {night ? "Daylight" : "Evening"}
            </button>
          </div>

          <div className="absolute right-3 top-14 flex flex-col gap-1.5">
            <button type="button" aria-label="Zoom in" onClick={() => rigRef.current?.setPreset("in")} className={clsx(btn, "!px-2")}>
              <Plus size={13} />
            </button>
            <button type="button" aria-label="Zoom out" onClick={() => rigRef.current?.setPreset("out")} className={clsx(btn, "!px-2")}>
              <Minus size={13} />
            </button>
            <button type="button" aria-label="Reset the view" onClick={() => preset("perspective")} className={clsx(btn, "!px-2")}>
              <RotateCcw size={13} />
            </button>
            <button
              type="button"
              aria-label={full ? "Exit fullscreen" : "Fullscreen"}
              onClick={() => {
                if (document.fullscreenElement) void document.exitFullscreen();
                else void stageRef.current?.requestFullscreen?.();
              }}
              className={clsx(btn, "!px-2")}
            >
              <Maximize2 size={13} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
