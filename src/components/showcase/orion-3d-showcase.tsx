"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Sun, Moon, Compass, Maximize2, Minimize2, MapPin,
  Sparkles, Layers, X, Mail,
  Download, Volume2, VolumeX
} from "lucide-react";
import clsx from "clsx";

export type TimeOfDay = "day" | "dusk" | "night";
export type CameraView = "hero" | "bird" | "elevation";
export type ShowcaseTab = "master_plan" | "location" | "amenities" | "towers" | "plans";

interface TowerInfo {
  id: string;
  name: string;
  unitsAvailable: number;
  floors: string;
  bhk: string;
  carpetArea: string;
  facing: string;
  possession: string;
  topPct: number;
  leftPct: number;
  description: string;
}

const TOWERS: TowerInfo[] = [
  {
    id: "tower-a",
    name: "Tower A",
    unitsAvailable: 94,
    floors: "G + 16",
    bhk: "3 BHK Premium",
    carpetArea: "1,485 - 1,720 sq.ft",
    facing: "East & North Facing",
    possession: "Dec 2026",
    topPct: 23,
    leftPct: 24,
    description: "East-facing luxury residences overlooking the central landscaped lawns and morning sunrise.",
  },
  {
    id: "tower-b",
    name: "Tower B",
    unitsAvailable: 100,
    floors: "G + 16",
    bhk: "3 BHK Luxury",
    carpetArea: "1,520 - 1,780 sq.ft",
    facing: "East Facing",
    possession: "Ready Soon",
    topPct: 17,
    leftPct: 39,
    description: "Prime central tower with unobstructed views across the sports arena and expansive open greens.",
  },
  {
    id: "tower-c",
    name: "Tower C",
    unitsAvailable: 89,
    floors: "G + 16",
    bhk: "3 BHK Elite",
    carpetArea: "1,485 - 1,695 sq.ft",
    facing: "West Facing",
    possession: "Dec 2026",
    topPct: 18,
    leftPct: 56,
    description: "Quiet perimeter orientation offering scenic panoramic sunset vistas over the Hyderabad skyline.",
  },
  {
    id: "tower-d",
    name: "Tower D",
    unitsAvailable: 100,
    floors: "G + 16",
    bhk: "3 BHK Premium",
    carpetArea: "1,550 - 1,750 sq.ft",
    facing: "North & East Facing",
    possession: "Mid 2026",
    topPct: 23,
    leftPct: 70,
    description: "Direct elevated access to the outdoor tennis and basketball recreation courts.",
  },
  {
    id: "tower-e",
    name: "Tower E",
    unitsAvailable: 98,
    floors: "G + 16",
    bhk: "3 BHK Luxury",
    carpetArea: "1,485 - 1,720 sq.ft",
    facing: "East Facing",
    possession: "Ready Soon",
    topPct: 36,
    leftPct: 80,
    description: "Immediate proximity to the grand entrance boulevard, jogging trails, and sports pavilions.",
  },
  {
    id: "tower-f",
    name: "Tower F",
    unitsAvailable: 102,
    floors: "G + 16",
    bhk: "3 BHK Grand",
    carpetArea: "1,510 - 1,760 sq.ft",
    facing: "North & West Facing",
    possession: "Ready Soon",
    topPct: 34,
    leftPct: 55,
    description: "Signature central court fronting the clubhouse, infinity pool, and the central amphitheater.",
  },
];

interface AmenityInfo {
  id: string;
  name: string;
  category: string;
  topPct: number;
  leftPct: number;
  description: string;
}

const AMENITIES: AmenityInfo[] = [
  {
    id: "amenity-clubhouse",
    name: "25,000 sq.ft Luxury Clubhouse",
    category: "Wellness & Lifestyle",
    topPct: 65,
    leftPct: 30,
    description: "Double-height atrium, rooftop infinity pool, indoor badminton, gym, banquet hall & squash.",
  },
  {
    id: "amenity-park",
    name: "Central Grand Lawn & Jogging Track",
    category: "Landscape & Nature",
    topPct: 63,
    leftPct: 54,
    description: "Lush botanical gardens, reflexology path, pergolas, gazebos and 1.2km continuous jogging trail.",
  },
  {
    id: "amenity-sports",
    name: "Sports Complex (Tennis & Basketball)",
    category: "Active Sports",
    topPct: 70,
    leftPct: 83,
    description: "Regulation acrylic courts with floodlighting, spectator benches, and multi-game markings.",
  },
  {
    id: "amenity-kids",
    name: "Children's Adventure Play Area",
    category: "Family & Play",
    topPct: 66,
    leftPct: 41,
    description: "Rubberized safety flooring, sensory play stations, slides, and shaded parent seating lounges.",
  },
  {
    id: "amenity-entrance",
    name: "Grand Boulevard & Security Portal",
    category: "Security & Arrival",
    topPct: 77,
    leftPct: 57,
    description: "Multi-lane entrance plaza, 24/7 RFID boom barrier security, and landscaped water features.",
  },
];

export function Orion3dShowcase() {
  const [timeOfDay, setTimeOfDay] = useState<TimeOfDay>("day");
  const [cameraView, setCameraView] = useState<CameraView>("hero");
  const [activeTab, setActiveTab] = useState<ShowcaseTab>("master_plan");
  const [selectedTower, setSelectedTower] = useState<TowerInfo | null>(null);
  const [selectedAmenity, setSelectedAmenity] = useState<AmenityInfo | null>(null);
  const [showBrochureModal, setShowBrochureModal] = useState(false);
  const [showPlanModal, setShowPlanModal] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [muted, setMuted] = useState(true);

  // 3D Tilt & Parallax Physics
  const containerRef = useRef<HTMLDivElement>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0, rx: 0, ry: 0 });

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width - 0.5; // -0.5 to 0.5
    const ny = (e.clientY - rect.top) / rect.height - 0.5; // -0.5 to 0.5

    // Smooth rotational response (max 6 degrees tilt)
    setMousePos({
      x: nx * 30,
      y: ny * 20,
      rx: -ny * 7,
      ry: nx * 9,
    });
  }, []);

  const handleMouseLeave = useCallback(() => {
    setMousePos({ x: 0, y: 0, rx: 0, ry: 0 });
  }, []);

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
    }
  };

  useEffect(() => {
    const handleFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener("fullscreenchange", handleFsChange);
    return () => document.removeEventListener("fullscreenchange", handleFsChange);
  }, []);

  // Compute camera transforms for views
  const getCameraTransform = () => {
    let scale = 1;
    let panX = 0;
    let panY = 0;

    if (cameraView === "bird") {
      scale = 1.08;
      panY = -2;
    } else if (cameraView === "elevation") {
      scale = 1.25;
      panY = 10;
      panX = -2;
    }

    const rx = mousePos.rx;
    const ry = mousePos.ry;
    const tx = mousePos.x * 0.4 + panX;
    const ty = mousePos.y * 0.4 + panY;

    return `perspective(1200px) rotateX(${rx}deg) rotateY(${ry}deg) translate3d(${tx}px, ${ty}px, 0) scale3d(${scale}, ${scale}, 1)`;
  };

  // Compass needle rotation angle
  const compassAngle = mousePos.ry * 2.5;

  return (
    <div
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      className={clsx(
        "relative select-none overflow-hidden rounded-3xl border border-ink-800/80 bg-ink-950 font-sans shadow-2xl transition-all duration-500",
        isFullscreen ? "fixed inset-0 z-50 h-screen w-screen rounded-none" : "h-[740px] w-full"
      )}
    >
      {/* 3D Viewport Canvas Container */}
      <div
        className="relative h-full w-full overflow-hidden transition-transform duration-300 ease-out"
        style={{
          transform: getCameraTransform(),
          transformStyle: "preserve-3d",
        }}
      >
        {/* DAY LAYER */}
        <div
          className={clsx(
            "absolute inset-0 h-full w-full bg-cover bg-center transition-opacity duration-1000 ease-in-out",
            timeOfDay === "day" ? "opacity-100 z-10" : "opacity-0 z-0"
          )}
          style={{ backgroundImage: "url('/showcase/day.jpg')" }}
        />

        {/* DUSK LAYER */}
        <div
          className={clsx(
            "absolute inset-0 h-full w-full bg-cover bg-center transition-opacity duration-1000 ease-in-out",
            timeOfDay === "dusk" ? "opacity-100 z-10" : "opacity-0 z-0"
          )}
          style={{ backgroundImage: "url('/showcase/dusk.jpg')" }}
        />

        {/* NIGHT LAYER */}
        <div
          className={clsx(
            "absolute inset-0 h-full w-full bg-cover bg-center transition-opacity duration-1000 ease-in-out",
            timeOfDay === "night" ? "opacity-100 z-10" : "opacity-0 z-0"
          )}
          style={{ backgroundImage: "url('/showcase/night.jpg')" }}
        />

        {/* Realistic 3D Specular Sun/Moon Sheen */}
        <div
          className="pointer-events-none absolute inset-0 z-20 transition-opacity duration-500"
          style={{
            background: `radial-gradient(circle at ${50 + mousePos.ry * 3}% ${40 + mousePos.rx * 2}%, rgba(255,255,255,${
              timeOfDay === "day" ? 0.08 : timeOfDay === "dusk" ? 0.04 : 0.02
            }) 0%, transparent 60%)`,
          }}
        />

        {/* Depth Vignette */}
        <div className="pointer-events-none absolute inset-0 z-20 bg-gradient-to-t from-black/60 via-transparent to-black/30" />

        {/* 3D INTERACTIVE TOWER PINS */}
        {(activeTab === "master_plan" || activeTab === "towers") &&
          TOWERS.map((tower) => {
            const isSelected = selectedTower?.id === tower.id;
            return (
              <div
                key={tower.id}
                onClick={() => setSelectedTower(isSelected ? null : tower)}
                style={{
                  top: `${tower.topPct}%`,
                  left: `${tower.leftPct}%`,
                  transform: `translate3d(-50%, -100%, 40px) ${isSelected ? "scale(1.1)" : "scale(1)"}`,
                }}
                className="absolute z-30 cursor-pointer transition-all duration-200"
              >
                {/* Pin Header Capsule */}
                <div
                  className={clsx(
                    "group flex flex-col items-center rounded-xl border backdrop-blur-md px-3 py-1.5 shadow-2xl transition-all duration-300",
                    isSelected
                      ? "border-amber-400 bg-black/90 ring-4 ring-amber-400/30 scale-105"
                      : "border-white/20 bg-black/75 hover:border-amber-400/60 hover:bg-black/90 hover:scale-105"
                  )}
                >
                  <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-white">
                    <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
                    <span>{tower.name}</span>
                  </div>
                  <span className="text-[9.5px] font-medium text-amber-200/90">
                    {tower.unitsAvailable} Available · {tower.floors}
                  </span>
                </div>

                {/* Stalk & Ground Dot */}
                <div className="mx-auto h-5 w-[1.5px] bg-gradient-to-b from-amber-400/80 to-transparent" />
                <div className="mx-auto -mt-1 h-2.5 w-2.5 rounded-full border-2 border-white bg-amber-400 shadow-lg shadow-amber-400/50 animate-ping" />
              </div>
            );
          })}

        {/* 3D INTERACTIVE AMENITY PINS */}
        {activeTab === "amenities" &&
          AMENITIES.map((amenity) => {
            const isSelected = selectedAmenity?.id === amenity.id;
            return (
              <div
                key={amenity.id}
                onClick={() => setSelectedAmenity(isSelected ? null : amenity)}
                style={{
                  top: `${amenity.topPct}%`,
                  left: `${amenity.leftPct}%`,
                  transform: `translate3d(-50%, -100%, 40px) ${isSelected ? "scale(1.1)" : "scale(1)"}`,
                }}
                className="absolute z-30 cursor-pointer transition-all duration-200"
              >
                <div
                  className={clsx(
                    "flex items-center gap-1.5 rounded-xl border backdrop-blur-md px-3 py-1.5 shadow-2xl transition-all duration-300",
                    isSelected
                      ? "border-emerald-400 bg-black/90 ring-4 ring-emerald-400/30 scale-105"
                      : "border-white/25 bg-black/80 hover:border-emerald-400/70 hover:scale-105"
                  )}
                >
                  <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                  <span className="text-[11px] font-bold text-white">{amenity.name}</span>
                </div>
                <div className="mx-auto h-4 w-[1.5px] bg-gradient-to-b from-emerald-400 to-transparent" />
                <div className="mx-auto -mt-1 h-2.5 w-2.5 rounded-full border-2 border-white bg-emerald-400 shadow-lg shadow-emerald-400/50" />
              </div>
            );
          })}
      </div>

      {/* TOP LUXURY HEADER OVERLAY */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-40 flex items-center justify-between p-6">
        <div className="pointer-events-auto flex items-center gap-3">
          <div className="rounded-2xl border border-white/15 bg-black/60 px-4 py-2 backdrop-blur-xl shadow-xl">
            <div className="flex items-center gap-2">
              <span className="text-base font-black tracking-widest text-white">RAMKY ONE</span>
              <span className="rounded bg-gradient-to-r from-amber-400 to-orange-500 px-1.5 py-0.5 text-xs font-black text-black">
                ORION
              </span>
            </div>
            <p className="text-[10px] font-medium tracking-wider text-mist-400 uppercase">
              FOR A BRIGHTER LIFE · UPPAL - POCHARAM
            </p>
          </div>
        </div>

        {/* Header Right Quick Actions */}
        <div className="pointer-events-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowPlanModal(true)}
            className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-black/60 px-3.5 py-1.5 text-xs font-semibold text-white backdrop-blur-xl transition hover:border-amber-400 hover:bg-black/80"
          >
            <Layers size={13} className="text-amber-400" />
            Floor Plans
          </button>
          <button
            type="button"
            onClick={() => setShowBrochureModal(true)}
            className="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-1.5 text-xs font-bold text-black shadow-lg shadow-orange-500/25 transition hover:brightness-110 active:scale-95"
          >
            <Download size={13} />
            Download Brochure
          </button>
        </div>
      </div>

      {/* LEFT FLOATING CONTROLS (Compass & Send Brochure) */}
      <div className="pointer-events-none absolute left-6 top-24 z-40 flex flex-col gap-3">
        {/* 3D Interactive Gyro Compass */}
        <div
          title="Dynamic 3D Orientation Compass"
          className="pointer-events-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-white/15 bg-black/60 backdrop-blur-xl shadow-xl transition hover:border-amber-400/50"
        >
          <div
            className="relative flex h-8 w-8 items-center justify-center transition-transform duration-100 ease-out"
            style={{ transform: `rotate(${compassAngle}deg)` }}
          >
            <Compass size={28} className="text-mist-400" />
            <span className="absolute -top-1 font-mono text-[9px] font-bold text-amber-400">N</span>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setShowBrochureModal(true)}
          className="pointer-events-auto flex items-center gap-2 rounded-xl border border-white/15 bg-black/60 px-3 py-2 text-xs font-semibold text-white backdrop-blur-xl shadow-xl transition hover:border-amber-400 hover:bg-black/80"
        >
          <Mail size={13} className="text-amber-400" />
          <span>Send Brochure</span>
        </button>
      </div>

      {/* RIGHT FLOATING CONTROLS (Lighting Switcher & Camera Views) */}
      <div className="pointer-events-none absolute right-6 top-24 z-40 flex flex-col gap-2">
        {/* Time of Day Switcher */}
        <div className="pointer-events-auto flex flex-col gap-1 rounded-2xl border border-white/15 bg-black/70 p-1.5 backdrop-blur-xl shadow-2xl">
          <button
            type="button"
            onClick={() => setTimeOfDay("day")}
            title="Golden Hour Daylight"
            className={clsx(
              "flex flex-col items-center justify-center rounded-xl p-2.5 text-[10px] font-bold transition-all",
              timeOfDay === "day"
                ? "bg-amber-400 text-black shadow-lg shadow-amber-400/30"
                : "text-mist-400 hover:bg-white/10 hover:text-white"
            )}
          >
            <Sun size={16} />
            <span className="mt-1">DAY</span>
          </button>

          <button
            type="button"
            onClick={() => setTimeOfDay("dusk")}
            title="Sunset Twilight with Glowing Pool & Windows"
            className={clsx(
              "flex flex-col items-center justify-center rounded-xl p-2.5 text-[10px] font-bold transition-all",
              timeOfDay === "dusk"
                ? "bg-gradient-to-b from-orange-500 to-pink-500 text-white shadow-lg shadow-orange-500/30"
                : "text-mist-400 hover:bg-white/10 hover:text-white"
            )}
          >
            <Sparkles size={16} />
            <span className="mt-1">DUSK</span>
          </button>

          <button
            type="button"
            onClick={() => setTimeOfDay("night")}
            title="Architectural Night Lighting"
            className={clsx(
              "flex flex-col items-center justify-center rounded-xl p-2.5 text-[10px] font-bold transition-all",
              timeOfDay === "night"
                ? "bg-indigo-600 text-white shadow-lg shadow-indigo-600/40"
                : "text-mist-400 hover:bg-white/10 hover:text-white"
            )}
          >
            <Moon size={16} />
            <span className="mt-1">NIGHT</span>
          </button>
        </div>

        {/* Camera Views Preset Switcher */}
        <div className="pointer-events-auto flex flex-col gap-1 rounded-2xl border border-white/15 bg-black/70 p-1.5 backdrop-blur-xl shadow-2xl">
          <button
            type="button"
            onClick={() => setCameraView("hero")}
            title="Hero Drone Perspective"
            className={clsx(
              "rounded-xl px-2.5 py-2 text-[9.5px] font-bold transition-all",
              cameraView === "hero" ? "bg-white/20 text-white" : "text-mist-400 hover:text-white"
            )}
          >
            HERO SHOT
          </button>

          <button
            type="button"
            onClick={() => setCameraView("bird")}
            title="High Aerial Bird's Eye Overview"
            className={clsx(
              "rounded-xl px-2.5 py-2 text-[9.5px] font-bold transition-all",
              cameraView === "bird" ? "bg-white/20 text-white" : "text-mist-400 hover:text-white"
            )}
          >
            BIRD EYE
          </button>

          <button
            type="button"
            onClick={() => setCameraView("elevation")}
            title="Street Level Boulevard Elevation"
            className={clsx(
              "rounded-xl px-2.5 py-2 text-[9.5px] font-bold transition-all",
              cameraView === "elevation" ? "bg-white/20 text-white" : "text-mist-400 hover:text-white"
            )}
          >
            ELEVATION
          </button>
        </div>

        {/* Viewport Control Buttons */}
        <div className="pointer-events-auto flex flex-col gap-1 rounded-2xl border border-white/15 bg-black/70 p-1.5 backdrop-blur-xl shadow-2xl">
          <button
            type="button"
            onClick={toggleFullscreen}
            title={isFullscreen ? "Exit Fullscreen" : "Enter Fullscreen"}
            className="flex items-center justify-center rounded-xl p-2.5 text-mist-400 transition hover:bg-white/10 hover:text-white"
          >
            {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
          <button
            type="button"
            onClick={() => setMuted(!muted)}
            title={muted ? "Unmute Ambient Sound" : "Mute Sound"}
            className="flex items-center justify-center rounded-xl p-2.5 text-mist-400 transition hover:bg-white/10 hover:text-white"
          >
            {muted ? <VolumeX size={16} /> : <Volume2 size={16} className="text-amber-400" />}
          </button>
        </div>
      </div>

      {/* SELECTED TOWER POPUP MODAL */}
      {selectedTower && (
        <div className="absolute left-6 bottom-24 z-40 max-w-sm rounded-2xl border border-amber-400/40 bg-black/85 p-5 backdrop-blur-2xl shadow-2xl text-white">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-black tracking-tight text-white">{selectedTower.name}</h3>
                <span className="rounded-full bg-amber-400/20 px-2 py-0.5 text-[10px] font-bold text-amber-300 border border-amber-400/30">
                  {selectedTower.floors}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-amber-300 font-semibold">{selectedTower.bhk}</p>
            </div>
            <button
              type="button"
              onClick={() => setSelectedTower(null)}
              className="rounded-lg p-1 text-mist-400 hover:bg-white/10 hover:text-white"
            >
              <X size={16} />
            </button>
          </div>

          <p className="mt-3 text-[12px] leading-relaxed text-mist-300">{selectedTower.description}</p>

          <div className="mt-4 grid grid-cols-2 gap-2 border-y border-white/10 py-3 text-[11px]">
            <div>
              <span className="text-[9.5px] uppercase tracking-wider text-mist-400">Available</span>
              <p className="font-bold text-white">{selectedTower.unitsAvailable} Units</p>
            </div>
            <div>
              <span className="text-[9.5px] uppercase tracking-wider text-mist-400">Carpet Area</span>
              <p className="font-bold text-white">{selectedTower.carpetArea}</p>
            </div>
            <div>
              <span className="text-[9.5px] uppercase tracking-wider text-mist-400">Facing</span>
              <p className="font-bold text-white">{selectedTower.facing}</p>
            </div>
            <div>
              <span className="text-[9.5px] uppercase tracking-wider text-mist-400">Possession</span>
              <p className="font-bold text-white">{selectedTower.possession}</p>
            </div>
          </div>

          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => setShowPlanModal(true)}
              className="flex-1 rounded-xl border border-white/20 bg-white/10 py-2 text-center text-xs font-bold text-white transition hover:bg-white/20"
            >
              View Plan
            </button>
            <button
              type="button"
              onClick={() => setShowBrochureModal(true)}
              className="flex-1 rounded-xl bg-amber-400 py-2 text-center text-xs font-bold text-black transition hover:bg-amber-300 shadow-md shadow-amber-400/20"
            >
              Enquire Unit
            </button>
          </div>
        </div>
      )}

      {/* SELECTED AMENITY POPUP MODAL */}
      {selectedAmenity && (
        <div className="absolute left-6 bottom-24 z-40 max-w-sm rounded-2xl border border-emerald-400/40 bg-black/85 p-5 backdrop-blur-2xl shadow-2xl text-white">
          <div className="flex items-start justify-between gap-3">
            <div>
              <span className="text-[10px] font-bold tracking-wider text-emerald-400 uppercase">
                {selectedAmenity.category}
              </span>
              <h3 className="text-base font-black text-white">{selectedAmenity.name}</h3>
            </div>
            <button
              type="button"
              onClick={() => setSelectedAmenity(null)}
              className="rounded-lg p-1 text-mist-400 hover:bg-white/10 hover:text-white"
            >
              <X size={16} />
            </button>
          </div>

          <p className="mt-3 text-[12px] leading-relaxed text-mist-300">{selectedAmenity.description}</p>

          <div className="mt-4">
            <button
              type="button"
              onClick={() => setShowBrochureModal(true)}
              className="w-full rounded-xl bg-emerald-500 py-2 text-center text-xs font-bold text-black transition hover:bg-emerald-400"
            >
              Schedule Site Visit
            </button>
          </div>
        </div>
      )}

      {/* BOTTOM FLOATING NAVIGATION BAR */}
      <div className="pointer-events-none absolute inset-x-0 bottom-4 z-40 flex items-center justify-between px-6">
        {/* Left Location Indicator */}
        <div className="pointer-events-auto hidden md:flex items-center gap-2 rounded-full border border-white/15 bg-black/60 px-4 py-2 backdrop-blur-xl shadow-xl text-xs text-mist-300">
          <MapPin size={13} className="text-amber-400" />
          <span className="font-semibold text-white">Uppal - Pocharam</span>
          <span className="text-mist-500">·</span>
          <span>Hyderabad</span>
        </div>

        {/* Center Mode Navigation Pills */}
        <div className="pointer-events-auto mx-auto flex items-center gap-1 rounded-full border border-white/15 bg-black/75 p-1.5 backdrop-blur-2xl shadow-2xl">
          <button
            type="button"
            onClick={() => {
              setActiveTab("master_plan");
              setSelectedTower(null);
              setSelectedAmenity(null);
            }}
            className={clsx(
              "rounded-full px-4 py-1.5 text-xs font-bold transition-all",
              activeTab === "master_plan"
                ? "bg-white text-black shadow-md"
                : "text-mist-300 hover:bg-white/10 hover:text-white"
            )}
          >
            MASTER PLAN
          </button>

          <button
            type="button"
            onClick={() => {
              setActiveTab("towers");
              setSelectedAmenity(null);
            }}
            className={clsx(
              "rounded-full px-4 py-1.5 text-xs font-bold transition-all",
              activeTab === "towers"
                ? "bg-amber-400 text-black shadow-md shadow-amber-400/30"
                : "text-mist-300 hover:bg-white/10 hover:text-white"
            )}
          >
            TOWERS
          </button>

          <button
            type="button"
            onClick={() => {
              setActiveTab("amenities");
              setSelectedTower(null);
            }}
            className={clsx(
              "rounded-full px-4 py-1.5 text-xs font-bold transition-all",
              activeTab === "amenities"
                ? "bg-emerald-400 text-black shadow-md shadow-emerald-400/30"
                : "text-mist-300 hover:bg-white/10 hover:text-white"
            )}
          >
            AMENITIES
          </button>

          <button
            type="button"
            onClick={() => setShowPlanModal(true)}
            className="rounded-full px-4 py-1.5 text-xs font-bold text-mist-300 transition hover:bg-white/10 hover:text-white"
          >
            PLANS
          </button>
        </div>

        {/* Right Developer Signature */}
        <div className="pointer-events-auto hidden md:flex items-center gap-2 rounded-full border border-white/15 bg-black/60 px-4 py-2 backdrop-blur-xl shadow-xl text-xs">
          <span className="text-mist-400">A PROJECT BY</span>
          <span className="font-bold text-white tracking-wider">RAMKY</span>
        </div>
      </div>

      {/* FLOOR PLANS MODAL */}
      {showPlanModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-md">
          <div className="w-full max-w-2xl rounded-3xl border border-white/20 bg-ink-950 p-6 shadow-2xl text-white">
            <div className="flex items-center justify-between border-b border-white/10 pb-4">
              <div>
                <h3 className="text-lg font-black text-white">Ramky One Orion · 3 BHK Master Layout</h3>
                <p className="text-xs text-mist-400">Architectural Floor Plans & Unit Layouts</p>
              </div>
              <button
                type="button"
                onClick={() => setShowPlanModal(false)}
                className="rounded-full p-1.5 text-mist-400 hover:bg-white/10 hover:text-white"
              >
                <X size={18} />
              </button>
            </div>

            <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="rounded-2xl border border-amber-400/30 bg-ink-900/60 p-4">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-amber-300 text-sm">3 BHK · Type A</span>
                  <span className="rounded bg-amber-400/20 px-2 py-0.5 text-[10px] font-bold text-amber-300">
                    East Facing
                  </span>
                </div>
                <p className="mt-1 text-2xl font-black text-white">1,485 <span className="text-xs font-normal text-mist-400">sq.ft</span></p>
                <ul className="mt-3 space-y-1.5 text-xs text-mist-300">
                  <li className="flex items-center gap-2">✓ Living & Dining: 11&apos;0&quot; x 22&apos;6&quot;</li>
                  <li className="flex items-center gap-2">✓ Master Bedroom: 11&apos;0&quot; x 14&apos;0&quot;</li>
                  <li className="flex items-center gap-2">✓ Sitout Balcony: 5&apos;0&quot; Wide</li>
                  <li className="flex items-center gap-2">✓ 100% Vastu Compliant</li>
                </ul>
              </div>

              <div className="rounded-2xl border border-white/15 bg-ink-900/60 p-4">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-orange-300 text-sm">3 BHK · Type B</span>
                  <span className="rounded bg-orange-400/20 px-2 py-0.5 text-[10px] font-bold text-orange-300">
                    West Facing
                  </span>
                </div>
                <p className="mt-1 text-2xl font-black text-white">1,720 <span className="text-xs font-normal text-mist-400">sq.ft</span></p>
                <ul className="mt-3 space-y-1.5 text-xs text-mist-300">
                  <li className="flex items-center gap-2">✓ Grand Living: 12&apos;0&quot; x 24&apos;0&quot;</li>
                  <li className="flex items-center gap-2">✓ Master Suite with Walk-in Dresser</li>
                  <li className="flex items-center gap-2">✓ Double Balconies</li>
                  <li className="flex items-center gap-2">✓ Cross-ventilation design</li>
                </ul>
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => {
                  setShowPlanModal(false);
                  setShowBrochureModal(true);
                }}
                className="rounded-xl bg-amber-400 px-5 py-2.5 text-xs font-bold text-black transition hover:bg-amber-300"
              >
                Download Complete Architectural Drawings
              </button>
            </div>
          </div>
        </div>
      )}

      {/* BROCHURE DOWNLOAD & ENQUIRY MODAL */}
      {showBrochureModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4 backdrop-blur-md">
          <div className="w-full max-w-md rounded-3xl border border-white/20 bg-ink-950 p-6 shadow-2xl text-white">
            <div className="flex items-center justify-between border-b border-white/10 pb-4">
              <div>
                <h3 className="text-base font-bold text-white">Ramky One Orion Brochure</h3>
                <p className="text-xs text-mist-400">Instant PDF Delivery & Floor Plans</p>
              </div>
              <button
                type="button"
                onClick={() => setShowBrochureModal(false)}
                className="rounded-full p-1.5 text-mist-400 hover:bg-white/10 hover:text-white"
              >
                <X size={18} />
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                alert("Thank you! The official Ramky One Orion brochure has been sent.");
                setShowBrochureModal(false);
              }}
              className="mt-4 space-y-3.5"
            >
              <div>
                <label className="text-[11px] font-semibold text-mist-300">Full Name</label>
                <input
                  type="text"
                  required
                  placeholder="Enter your name"
                  defaultValue="Praneeth Ramaswamy"
                  className="mt-1 w-full rounded-xl border border-ink-700 bg-ink-900 px-3.5 py-2 text-xs text-white placeholder-mist-500 focus:border-amber-400 focus:outline-none"
                />
              </div>

              <div>
                <label className="text-[11px] font-semibold text-mist-300">Phone Number (for WhatsApp PDF)</label>
                <input
                  type="tel"
                  required
                  placeholder="+91 98765 43210"
                  defaultValue="+91 98765 43210"
                  className="mt-1 w-full rounded-xl border border-ink-700 bg-ink-900 px-3.5 py-2 text-xs text-white placeholder-mist-500 focus:border-amber-400 focus:outline-none"
                />
              </div>

              <div>
                <label className="text-[11px] font-semibold text-mist-300">Email Address</label>
                <input
                  type="email"
                  required
                  placeholder="name@example.com"
                  defaultValue="praneeth@kiwik.one"
                  className="mt-1 w-full rounded-xl border border-ink-700 bg-ink-900 px-3.5 py-2 text-xs text-white placeholder-mist-500 focus:border-amber-400 focus:outline-none"
                />
              </div>

              <div className="pt-2">
                <button
                  type="submit"
                  className="w-full rounded-xl bg-gradient-to-r from-amber-400 to-orange-500 py-3 text-center text-xs font-bold text-black shadow-lg shadow-orange-500/20 transition hover:brightness-110"
                >
                  Download Brochure & Price Sheet
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
