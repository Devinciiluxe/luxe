// The 3D neural map — the B3D brain from the reference photo. A real brain
// surface (two hemispheres + lobes + brainstem, reconstructed from the photo)
// sampled into a network of dots + lines. Two renderers share one data set:
// a WebGL (three.js) path for real browsers, and a Canvas-2D projection for
// environments where WebGL is blocked (embedded preview iframes), so the brain
// always shows. A labeled "working_jobs" system node on the frontal lobe flares
// magenta→purple and ripples across the cortex whenever Jarvis is composing a
// reply or mid-conversation.
"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { Lead, Metrics } from "../lib/types";
import { CORTEX_ANCHORS } from "../lib/cortex-anchors";
import { AMBER, CYAN, MAGENTA, money } from "../lib/utils";
import { BrainStatic as CortexStatic } from "./brain-static";

const PURPLE = "#9F7BFF";
const SYS = "working_jobs";

interface BrainSceneProps {
  leads: Lead[];
  activeLeadId: string | null;
  glowLeadId: string | null;
  workActive: boolean;
  /** live metrics drive the floating holo data screens around the brain */
  metrics: Metrics | null;
  /** when a node event fires, a sparkle of light weaves through the brain and bursts on it */
  streamEvent: { leadId: string; key: number } | null;
  onPick: (leadId: string) => void;
}

interface EngineLike {
  syncLeads(leads: Lead[]): void;
  setFocus(id: string | null): void;
  pulse(id: string | null): void;
  setWorkActive(active: boolean): void;
  streamTo(leadId: string): void;
  setMetrics(m: Metrics | null): void;
  dispose(): void;
}

export default function BrainScene({ leads, activeLeadId, glowLeadId, workActive, metrics, streamEvent, onPick }: BrainSceneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<EngineLike | null>(null);
  const onPickRef = useRef(onPick);
  const [failed, setFailed] = useState(false);
  onPickRef.current = onPick;

  useEffect(() => {
    if (!hostRef.current) return;
    let engine: EngineLike | null = null;
    try {
      // Full 3D where WebGL exists; otherwise the SVG brain renders as DOM
      // (visible in preview panes and static renders alike — never an empty layer).
      engine = new BrainGL(hostRef.current, (id) => onPickRef.current(id));
    } catch (err) {
      console.error("Neural cortex 3D unavailable, falling back to SVG:", err);
      setFailed(true);
    }
    engineRef.current = engine;
    return () => {
      engine?.dispose();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    engineRef.current?.syncLeads(leads);
  }, [leads]);
  useEffect(() => {
    engineRef.current?.setFocus(activeLeadId);
  }, [activeLeadId]);
  useEffect(() => {
    engineRef.current?.pulse(glowLeadId);
  }, [glowLeadId]);
  useEffect(() => {
    engineRef.current?.setWorkActive(workActive);
  }, [workActive]);

  useEffect(() => {
    if (streamEvent?.leadId) engineRef.current?.streamTo(streamEvent.leadId);
  }, [streamEvent]);

  useEffect(() => {
    engineRef.current?.setMetrics(metrics);
  }, [metrics]);

  if (failed) {
    return <CortexStatic leads={leads} activeLeadId={activeLeadId} workActive={workActive} metrics={metrics} streamEvent={streamEvent} onPick={onPick} />;
  }

  return <div ref={hostRef} className="brain-host" aria-label="Neural cortex — working_jobs lights when Jarvis works on replies and conversations" />;
}

// Shared pure helpers ---------------------------------------------------------
function buildAnchors(): THREE.Vector3[] {
  return CORTEX_ANCHORS.map((a) => new THREE.Vector3(a[0], a[1], a[2]));
}

function cortexEdges(anchors: THREE.Vector3[]): [number, number][] {
  const seen = new Set<string>();
  const out: [number, number][] = [];
  for (let i = 0; i < anchors.length; i++) {
    const nbs = anchors
      .map((a, j) => ({ j, d: anchors[i].distanceToSquared(a) }))
      .filter((x) => x.j !== i)
      .sort((a, b) => a.d - b.d)
      .slice(0, 3);
    for (const { j } of nbs) {
      const key = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push([i, j]);
    }
  }
  return out;
}

function nearestAnchor(target: THREE.Vector3, anchors: THREE.Vector3[]): THREE.Vector3 {
  let best = anchors[0], bestD = Infinity;
  for (const a of anchors) {
    const d = target.distanceToSquared(a);
    if (d < bestD) {
      bestD = d;
      best = a;
    }
  }
  return best;
}

function frontalAnchor(anchors: THREE.Vector3[]): THREE.Vector3 {
  let best = anchors[0], bestS = -Infinity;
  for (const a of anchors) {
    const s = a.z - Math.abs(a.y) * 0.25;
    if (s > bestS) {
      bestS = s;
      best = a;
    }
  }
  return best;
}

function hexToRgb(hex: string): [number, number, number] {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

// WebGL renderer ---------------------------------------------------------------
class BrainGL implements EngineLike {
  private host: HTMLElement;
  private resizeObserver!: ResizeObserver;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private clock = new THREE.Clock();
  private group = new THREE.Group();
  private anchors: THREE.Vector3[];
  private anchorPoints!: THREE.Points;
  private anchorEdges!: THREE.LineSegments;
  private dotTex!: THREE.Texture;
  // hologram plasma layer
  private plasmaShell!: THREE.Mesh;
  private plasmaMat!: THREE.ShaderMaterial;
  private scanRing!: THREE.Mesh;
  private outerGlow!: THREE.Sprite;
  // sparkle stream + burst
  private cortexEdgePairs: [number, number][] = [];
  private stream!: StreamRunner;
  private sparkHead!: THREE.Points;
  private sparkTrail!: THREE.Line;
  private burstPoints!: THREE.Points;
  private burst: { pos: THREE.Vector3; t: number; parts: Float32Array } | null = null;
  private streamBoost = 0;
  // floating holo data screens orbiting the cortex
  private holoPanels: { sprite: THREE.Sprite; tex: THREE.CanvasTexture; baseY: number; kind: string; phase: number }[] = [];
  private metrics: Metrics | null = null;
  // system node (working_jobs)
  private sysPos: THREE.Vector3;
  private halo!: THREE.Sprite;
  private ring!: THREE.Mesh;
  private label!: THREE.Sprite;
  private active = 0;
  private pulsing = 0;
  private triggered = false;
  // leads
  private nodes: { lead: Lead; pos: THREE.Vector3; size0: number; _edges: number[] }[] = [];
  private nodePoints!: THREE.Points;
  private nodeSizes!: Float32Array;
  private nodeColors!: Float32Array;
  private nodeAttr = new Float32Array(0);
  private edges!: THREE.LineSegments;
  private edgeColors!: Float32Array;
  private grid!: THREE.GridHelper;
  private platform!: THREE.Mesh;
  private platformRing!: THREE.Line;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2(-10, -10);
  private focusId: string | null = null;
  private lastGlowId: string | null = null;
  private raf = 0;
  private disposed = false;
  private sweeping = 0;
  private sweepOrigin: THREE.Vector3 | null = null;

  constructor(host: HTMLElement, private onPick: (id: string) => void) {
    this.host = host;
    const w = host.clientWidth || 800;
    const h = host.clientHeight || 600;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    host.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(48, w / h, 0.1, 100);
    this.camera.position.set(2.6, 1.6, 7.4);
    this.camera.lookAt(0, 0.2, 0);

    this.scene.fog = new THREE.FogExp2(0x070a0f, 0.026);
    this.dotTex = makeRadialDot();
    this.anchors = buildAnchors();
    this.cortexEdgePairs = cortexEdges(this.anchors);
    this.sysPos = frontalAnchor(this.anchors).clone().multiplyScalar(1.12);
    this.buildCortex();
    this.buildSystemNode();
    this.buildFloor();
    this.buildPlasma();
    this.buildStreamVisuals();
    this.buildHoloPanels();
    this.stream = new StreamRunner(this.anchors, this.cortexEdgePairs);
    this.stream.onBurst = (p) => this.spawnBurst(p);
    this.group.rotation.x = -0.08;
    this.scene.add(this.group);

    window.addEventListener("resize", this.onResize);
    // window "resize" only fires for actual browser-window resizes — it never
    // fires when a sibling (e.g. NodeInspector) mounts new content and changes
    // *this* element's box size purely via CSS/flow layout, which is exactly
    // what happens on a node click. Without this, the canvas's CSS box
    // shrinks/grows but its internal draw-buffer resolution stays stale,
    // rendering as a squished/cropped scene until an actual window resize
    // happens to catch it up.
    this.resizeObserver = new ResizeObserver(this.onResize);
    this.resizeObserver.observe(host);
    this.renderer.domElement.addEventListener("pointermove", this.onMove);
    this.renderer.domElement.addEventListener("click", this.onClick);
    this.tick();
  }

  private buildCortex() {
    const posArr = new Float32Array(this.anchors.length * 3);
    this.anchors.forEach((a, i) => posArr.set([a.x, a.y, a.z], i * 3));
    const dotGeo = new THREE.BufferGeometry();
    dotGeo.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
    this.anchorPoints = new THREE.Points(
      dotGeo,
      new THREE.PointsMaterial({
        size: 0.06,
        map: this.dotTex,
        color: CYAN,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
      }),
    );
    this.group.add(this.anchorPoints);

    const linePos: number[] = [];
    for (const [i, j] of this.cortexEdgePairs) {
      const a = this.anchors[i], b = this.anchors[j];
      linePos.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(linePos), 3));
    // faint two-tone: cyan + purple edges
    this.anchorEdges = new THREE.LineSegments(
      lineGeo,
      new THREE.LineBasicMaterial({ color: PURPLE, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending }),
    );
    this.group.add(this.anchorEdges);
  }

  private buildSystemNode() {
    const group = new THREE.Group();
    group.position.copy(this.sysPos);
    this.halo = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.dotTex, color: PURPLE, transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    this.halo.scale.setScalar(0.32 * 2.4);
    group.add(this.halo);

    const ringGeo = new THREE.RingGeometry(0.9, 1.0, 64);
    const ringMat = new THREE.MeshBasicMaterial({ color: MAGENTA, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
    this.ring = new THREE.Mesh(ringGeo, ringMat);
    this.ring.scale.setScalar(0.32);
    group.add(this.ring);

    this.label = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: makeLabelTexture("WORKING_JOBS"), transparent: true, opacity: 0.7, depthWrite: false }),
    );
    this.label.scale.set(1.6, 0.32, 1);
    this.label.position.y = 0.5;
    group.add(this.label);

    this.group.add(group);
  }

  private buildFloor() {
    this.grid = new THREE.GridHelper(24, 24, 0x00f2fe, 0x0e2a33);
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.1;
    this.grid.position.y = -2.5;
    this.group.add(this.grid);
    const ringGeo = new THREE.RingGeometry(3.5, 3.62, 96);
    this.platform = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: CYAN, transparent: true, opacity: 0.16, side: THREE.DoubleSide }));
    this.platform.rotation.x = -Math.PI / 2;
    this.platform.position.y = -2.45;
    this.group.add(this.platform);
    const edgeGeo = new THREE.EdgesGeometry(new THREE.CircleGeometry(3.56, 96));
    this.platformRing = new THREE.Line(edgeGeo, new THREE.LineBasicMaterial({ color: CYAN, transparent: true, opacity: 0.5 }));
    this.platformRing.rotation.x = -Math.PI / 2;
    this.platformRing.position.y = -2.4;
    this.group.add(this.platformRing);
  }

  /** Hologram plasma layer: fresnel fbm shell + scanning disc + outer halo. */
  private buildPlasma() {
    // big ambient halo behind the whole cortex
    this.outerGlow = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.dotTex, color: 0x00b4ff, transparent: true, opacity: 0.15, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    this.outerGlow.scale.setScalar(10);
    this.outerGlow.position.y = 0.2;
    this.group.add(this.outerGlow);

    // plasma shell — a glowing fresnel envelope that shimmers around the brain
    const shellGeo = new THREE.SphereGeometry(2.42, 64, 48);
    this.plasmaMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uColorA: { value: new THREE.Color(0x00f2fe) },
        uColorB: { value: new THREE.Color(0x2a4bff) },
      },
      vertexShader: PLASMA_VERT,
      fragmentShader: PLASMA_FRAG,
    });
    this.plasmaShell = new THREE.Mesh(shellGeo, this.plasmaMat);
    this.group.add(this.plasmaShell);

    // horizontal hologram scan disc sweeping up and down through the brain
    const scanGeo = new THREE.RingGeometry(2.5, 2.7, 96);
    const scanMat = new THREE.MeshBasicMaterial({ color: 0x00f2fe, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
    this.scanRing = new THREE.Mesh(scanGeo, scanMat);
    this.scanRing.rotation.x = -Math.PI / 2;
    this.group.add(this.scanRing);
  }

  /** Sparkle-stream + burst visuals (created once, driven each frame). */
  private buildStreamVisuals() {
    const MAX = 20;
    this.sparkTrail = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending }),
    );
    const tg = this.sparkTrail.geometry as THREE.BufferGeometry;
    tg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX * 3), 3));
    tg.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MAX * 3), 3));
    this.sparkTrail.frustumCulled = false;
    this.group.add(this.sparkTrail);

    this.sparkHead = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({ size: 0.32, map: this.dotTex, color: 0xffd76a, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true }),
    );
    (this.sparkHead.geometry as THREE.BufferGeometry).setAttribute("position", new THREE.BufferAttribute(new Float32Array(3), 3));
    this.sparkHead.frustumCulled = false;
    this.group.add(this.sparkHead);

    this.burstPoints = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({ size: 0.14, map: this.dotTex, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true }),
    );
    const bg = this.burstPoints.geometry as THREE.BufferGeometry;
    bg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(90 * 3), 3));
    bg.setAttribute("color", new THREE.BufferAttribute(new Float32Array(90 * 3), 3));
    this.burstPoints.frustumCulled = false;
    this.group.add(this.burstPoints);
  }

  streamTo(leadId: string) {
    const node = this.nodes.find((n) => n.lead.id === leadId);
    if (node) this.stream.streamTo(node.pos);
  }

  private spawnBurst(pos: THREE.Vector3) {
    const parts = new Float32Array(90 * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < 90; i++) {
      v.randomDirection().multiplyScalar(1.4 + Math.random() * 5);
      parts.set([v.x, v.y, v.z], i * 3);
    }
    this.burst = { pos: pos.clone(), t: 0, parts };
  }

  /** Floating translucent data screens around the brain (like the holo-deck). */
  private buildHoloPanels() {
    const kinds = ["ACTIVE NODES", "PIPELINE", "REPLY RATE", "PENDING", "WON", "NO-SHOWS"];
    // front-facing angles get high/low y so no panel sits between camera and the brain
    const ys = [2.7, -2.4, 2.5, 0.9, -2.4, 2.7];
    for (let i = 0; i < kinds.length; i++) {
      const canvas = holoCanvas(kinds[i], null);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.92 }),
      );
      const ang = (i / kinds.length) * Math.PI * 2 + 0.55;
      sprite.position.set(Math.cos(ang) * 4.6, ys[i], Math.sin(ang) * 4.6);
      sprite.scale.set(1.7, 1.06, 1);
      this.group.add(sprite);
      this.holoPanels.push({ sprite, tex, baseY: ys[i], kind: kinds[i], phase: i * 1.7 });
    }
  }

  setMetrics(m: Metrics | null) {
    this.metrics = m;
    for (const p of this.holoPanels) {
      p.tex.image = holoCanvas(p.kind, m);
      p.tex.needsUpdate = true;
    }
  }

  syncLeads(leads: Lead[]) {
    const target = new THREE.Vector3();
    this.nodes = leads.map((lead) => {
      const [nx, ny, nz] = lead.n;
      target.set(nx * 2.0, ny * 1.6, nz * 1.9);
      const pos = nearestAnchor(target, this.anchors).clone();
      pos.x += ((lead.id.charCodeAt(0) % 5) - 2) * 0.03;
      pos.y += ((lead.id.charCodeAt(1) % 3) - 1) * 0.03;
      return { lead, pos, size0: 0.17 + lead.score / 450, _edges: [] as number[] };
    });
    this.rebuildLeadGeometry();
  }

  private rebuildLeadGeometry() {
    const n = this.nodes.length;
    const positions = new Float32Array(n * 3);
    this.nodeSizes = new Float32Array(n);
    this.nodeColors = new Float32Array(n * 3);
    this.nodes.forEach((node, i) => {
      positions.set([node.pos.x, node.pos.y, node.pos.z], i * 3);
      this.nodeSizes[i] = node.size0;
      this.nodeColors.set(hexToRgb(CYAN), i * 3);
    });
    this.nodes.forEach((node, i) => {
      node._edges = this.nodes
        .map((x, j) => ({ j, d: node.pos.distanceToSquared(x.pos) }))
        .filter((x) => x.j !== i)
        .sort((a, b) => a.d - b.d)
        .slice(0, 3)
        .map((x) => x.j);
    });
    this.nodeAttr = positions;
    if (this.nodePoints) {
      this.nodePoints.geometry.dispose();
      (this.nodePoints.material as THREE.Material).dispose();
      this.group.remove(this.nodePoints);
    }
    const nodeGeo = new THREE.BufferGeometry();
    nodeGeo.setAttribute("position", new THREE.BufferAttribute(this.nodeAttr, 3));
    nodeGeo.setAttribute("aColor", new THREE.BufferAttribute(this.nodeColors, 3));
    nodeGeo.setAttribute("aSize", new THREE.BufferAttribute(this.nodeSizes, 1));
    const nodeMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 } },
      vertexShader: `attribute vec3 aColor; attribute float aSize;
        varying vec3 vColor; varying float vRim; uniform float uTime;
        void main(){ vColor=aColor; vec4 mv=modelViewMatrix*vec4(position,1.0);
          gl_Position=projectionMatrix*mv; gl_PointSize=aSize*(420.0/-mv.z);
          vRim=0.5+0.5*sin(uTime*1.4+position.x*2.0+position.y*1.7);}`,
      fragmentShader: `varying vec3 vColor; varying float vRim;
        void main(){ vec2 uv=gl_PointCoord-0.5; float d=length(uv);
          float core=smoothstep(0.28,0.48,d); float glow=smoothstep(0.5,0.1,d)*0.65;
          float a=(1.0-core)+glow; if(a<0.02) discard;
          gl_FragColor=vec4(vColor, a*(0.55+0.45*vRim));}`,
    });
    this.nodePoints = new THREE.Points(nodeGeo, nodeMat);
    this.group.add(this.nodePoints);

    if (this.edges) {
      this.edges.geometry.dispose();
      (this.edges.material as THREE.Material).dispose();
      this.group.remove(this.edges);
    }
    const seen = new Set<string>(); const edgePos: number[] = [];
    this.nodes.forEach((node, i) => {
      node._edges.forEach((j) => {
        const key = i < j ? `${i}-${j}` : `${j}-${i}`;
        if (seen.has(key)) return;
        seen.add(key);
        const a = node.pos, b = this.nodes[j].pos;
        edgePos.push(a.x, a.y, a.z, b.x, b.y, b.z);
      });
    });
    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(edgePos), 3));
    this.edgeColors = new Float32Array(edgePos.length);
    const tint = hexToRgb(PURPLE).map((c) => c * 0.55) as [number, number, number];
    for (let k = 0; k < edgePos.length; k += 6) {
      this.edgeColors.set(tint, k);
      this.edgeColors.set(tint, k + 3);
    }
    edgeGeo.setAttribute("color", new THREE.BufferAttribute(this.edgeColors, 3));
    this.edges = new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending }));
    this.group.add(this.edges);
  }

  setFocus(id: string | null) {
    this.focusId = id;
    if (!this.nodeAttr.length) return;
    this.nodes.forEach((node, i) => {
      const active = node.lead.id === id;
      const col = active ? hexToRgb(MAGENTA) : node.lead.stage === "no_show" ? hexToRgb(AMBER) : hexToRgb(CYAN);
      this.nodeColors.set(col, i * 3);
      this.nodeSizes[i] = node.size0 * (active ? 1.6 : 1);
    });
    this.nodePoints.geometry.attributes.aColor.needsUpdate = true;
    this.nodePoints.geometry.attributes.aSize.needsUpdate = true;
  }

  pulse(id: string | null) {
    if (!id || id === this.lastGlowId) return;
    this.lastGlowId = id;
    const node = this.nodes.find((x) => x.lead.id === id);
    if (node) {
      this.sweepOrigin = node.pos.clone();
      this.sweeping = 0.001;
    }
  }

  setWorkActive(active: boolean) {
    if (active && !this.triggered) {
      this.triggered = true;
      this.pulsing = 0.001;
      this.sweepOrigin = this.sysPos.clone();
      this.sweeping = 0.001; // light the working_jobs lobe + ripple the brain
    } else if (!active) {
      this.triggered = false;
    }
  }

  private onResize = () => {
    const w = this.host.clientWidth || 800, h = this.host.clientHeight || 600;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };
  private onMove = (e: PointerEvent) => {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    this.pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    this.renderer.domElement.style.cursor = this.hitLead() ? "pointer" : "default";
  };
  private onClick = () => {
    const id = this.hitLead();
    if (id) this.onPick(id);
  };
  private hitLead(): string | null {
    if (!this.nodePoints) return null;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    this.raycaster.params.Points.threshold = 0.35;
    const hits = this.raycaster.intersectObject(this.nodePoints, false);
    const idx = hits[0]?.index;
    return idx != null ? this.nodes[idx]?.lead.id ?? null : null;
  }

  private tick = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.tick);
    const dt = Math.min(0.05, this.clock.getDelta());
    const t = this.clock.getElapsedTime();

    this.group.rotation.y = t * 0.07;
    this.platformRing.rotation.z = t * 0.15;
    // nodePoints only exists once syncLeads() has run at least once (a
    // separate effect, reacting to the `leads` prop) — the very first tick()
    // fires synchronously from the constructor, before that effect runs.
    if (this.nodePoints) {
      (this.nodePoints.material as THREE.ShaderMaterial).uniforms.uTime.value = t;
    }

    // plasma layer animation
    this.plasmaMat.uniforms.uTime.value = t;
    (this.outerGlow.material as THREE.SpriteMaterial).opacity = 0.11 + 0.06 * Math.sin(t * 0.8);
    this.outerGlow.scale.setScalar(10 + Math.sin(t * 0.5) * 0.6);
    const scanY = Math.sin(t * 0.5) * 1.7;
    this.scanRing.position.y = scanY;
    (this.scanRing.material as THREE.MeshBasicMaterial).opacity = 0.16 + 0.14 * (0.5 + 0.5 * Math.sin(t * 0.5));
    (this.plasmaShell.material as THREE.ShaderMaterial).uniforms.uTime.value = t;

    // floating holo screens bob + drift around the cortex
    for (let i = 0; i < this.holoPanels.length; i++) {
      const p = this.holoPanels[i];
      p.sprite.position.y = p.baseY + Math.sin(t * 0.6 + p.phase) * 0.14;
      (p.sprite.material as THREE.SpriteMaterial).opacity = 0.85 + 0.12 * Math.sin(t * 0.9 + p.phase);
    }

    // sparkle stream weaving through the cortex + burst on the target
    this.stream.advance(dt);
    const S = this.stream;
    const glowTarget = S.active || this.burst ? 1 : 0;
    this.streamBoost += (glowTarget - this.streamBoost) * Math.min(1, dt * 4);
    (this.outerGlow.material as THREE.SpriteMaterial).opacity = (0.11 + 0.06 * Math.sin(t * 0.8)) + 0.4 * this.streamBoost;
    this.outerGlow.scale.setScalar((10 + Math.sin(t * 0.5) * 0.6) * (1 + 0.5 * this.streamBoost));
    // spark trail
    const MAX = 20;
    const tg = this.sparkTrail.geometry as THREE.BufferGeometry;
    const tp = tg.attributes.position as THREE.BufferAttribute;
    const tc = tg.attributes.color as THREE.BufferAttribute;
    const tr = S.trail;
    for (let k = 0; k < MAX; k++) {
      if (k < tr.length) {
        const p = tr[k];
        tp.setXYZ(k, p.x, p.y, p.z);
        const a = (k + 1) / tr.length;
        tc.setXYZ(k, 1, a * 0.3, 0.85);
      } else {
        tp.setXYZ(k, 0, -999, 0);
      }
    }
    tp.needsUpdate = true;
    tc.needsUpdate = true;
    (this.sparkTrail.material as THREE.LineBasicMaterial).opacity = S.hasHead ? Math.min(1, tr.length / 6) * 0.85 : 0;
    // spark head
    const hg = this.sparkHead.geometry as THREE.BufferGeometry;
    const hp = hg.attributes.position as THREE.BufferAttribute;
    if (S.hasHead) {
      hp.setXYZ(0, S.head.x, S.head.y, S.head.z);
      (this.sparkHead.material as THREE.PointsMaterial).opacity = 1;
    } else {
      hp.setXYZ(0, 0, -999, 0);
      (this.sparkHead.material as THREE.PointsMaterial).opacity = 0;
    }
    hp.needsUpdate = true;
    // burst — an omnidirectional pixie-dust explosion on the target node
    if (this.burst) {
      this.burst.t += dt / 0.8;
      const b = this.burst;
      const bg2 = this.burstPoints.geometry as THREE.BufferGeometry;
      const bp = bg2.attributes.position as THREE.BufferAttribute;
      const bc = bg2.attributes.color as THREE.BufferAttribute;
      const alpha = Math.max(0, 1 - b.t);
      for (let i = 0; i < 90; i++) {
        const dx = b.parts[i * 3], dy = b.parts[i * 3 + 1], dz = b.parts[i * 3 + 2];
        const s = b.t * 1.6;
        const jx = Math.sin(b.t * 7 + i) * 0.15 * s;
        bp.setXYZ(i, b.pos.x + dx * s + jx, b.pos.y + dy * s + jx, b.pos.z + dz * s + jx);
        bc.setXYZ(i, 1, alpha * 0.3, 0.55);
      }
      bp.needsUpdate = true;
      bc.needsUpdate = true;
      (this.burstPoints.material as THREE.PointsMaterial).opacity = alpha;
      (this.burstPoints.material as THREE.PointsMaterial).size = 0.14 + alpha * 0.16;
      if (b.t >= 1) this.burst = null;
    } else {
      (this.burstPoints.material as THREE.PointsMaterial).opacity = 0;
    }

    // working_jobs system node animation
    const target = this.triggered ? 1 : 0;
    this.active += (target - this.active) * Math.min(1, dt * 3.2);
    const c = new THREE.Color(PURPLE).lerp(new THREE.Color(MAGENTA), this.active);
    (this.halo.material as THREE.SpriteMaterial).color.set(c);
    (this.halo.material as THREE.SpriteMaterial).opacity = 0.4 + 0.6 * this.active;
    this.halo.scale.setScalar(0.32 * 2.4 * (1 + 0.5 * this.active + 0.35 * Math.sin(t * 6) * this.active));
    (this.label.material as THREE.SpriteMaterial).opacity = 0.35 + 0.65 * this.active;
    if (this.pulsing > 0 && this.pulsing < 1) this.pulsing = Math.min(1, this.pulsing + dt * 1.05);
    this.ring.scale.setScalar(0.32 * (0.6 + this.pulsing * 3.4));
    (this.ring.material as THREE.MeshBasicMaterial).opacity = (1 - this.pulsing) * 0.7 * (0.3 + this.active);
    this.ring.lookAt(this.camera.position);
    if (this.pulsing >= 1) this.pulsing = 0;

    // crimson ripple across the brain when a node or job flares
    if (this.sweeping > 0 && this.sweepOrigin) {
      this.sweeping = Math.min(1.1, this.sweeping + dt * 0.45);
      const radius = this.sweeping * 5.4;
      this.nodes.forEach((node, i) => {
        const d = node.pos.distanceTo(this.sweepOrigin!);
        const boost = Math.max(0, 1 - Math.abs(d - radius) * 1.8);
        const base = this.focusId === node.lead.id ? MAGENTA : node.lead.stage === "no_show" ? AMBER : CYAN;
        const b = hexToRgb(base), wv = hexToRgb(MAGENTA);
        this.nodeColors.set([b[0] * (1 - boost) + wv[0] * boost, b[1] * (1 - boost) + wv[1] * boost, b[2] * (1 - boost) + wv[2] * boost], i * 3);
        this.nodeSizes[i] = node.size0 * (1 + boost * 1.5);
      });
      this.nodePoints.geometry.attributes.aColor.needsUpdate = true;
      this.nodePoints.geometry.attributes.aSize.needsUpdate = true;
      if (this.sweeping >= 1.1) {
        this.sweeping = 0;
        this.sweepOrigin = null;
        this.setFocus(this.focusId);
      }
    }

    this.renderer.render(this.scene, this.camera);
  };

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.onResize);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener("pointermove", this.onMove);
    this.renderer.domElement.removeEventListener("click", this.onClick);
    this.host.removeChild(this.renderer.domElement);
    this.dotTex.dispose();
    this.scene.traverse((o) => {
      const g = o as THREE.Mesh;
      if (g.geometry) g.geometry.dispose();
      const m = (g as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else m?.dispose();
    });
    this.renderer.dispose();
  }
}

// Canvas-2D fallback renderer --------------------------------------------------
// Same brain data projected to 2D with a manual rotate + perspective, so the
// cortex renders even where WebGL is unavailable. Supports orbiting (slow spin),
// lead highlighting, clicking, and the working_jobs pulse.
class BrainCanvas implements EngineLike {
  private host: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private anchors: THREE.Vector3[];
  private sysPos: THREE.Vector3;
  private edges: [number, number][];
  private nodes: { lead: Lead; pos: THREE.Vector3 }[] = [];
  private focusId: string | null = null;
  private active = 0;
  private pulsing = 0;
  private triggered = false;
  private sweeping = 0;
  private sweepOrigin: THREE.Vector3 | null = null;
  private raf = 0;
  private disposed = false;
  private onPick: (id: string) => void;
  private stream!: StreamRunner;
  private burst: { pos: THREE.Vector3; t: number; parts: Float32Array } | null = null;
  private metrics: Metrics | null = null;

  constructor(host: HTMLElement, onPick: (id: string) => void) {
    this.host = host;
    this.onPick = onPick;
    this.canvas = document.createElement("canvas");
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.canvas.style.display = "block";
    host.appendChild(this.canvas);
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d unavailable");
    this.ctx = ctx;
    this.anchors = buildAnchors();
    this.sysPos = frontalAnchor(this.anchors).clone().multiplyScalar(1.12);
    this.edges = cortexEdges(this.anchors);
    this.stream = new StreamRunner(this.anchors, this.edges);
    this.stream.onBurst = (p) => this.spawnBurst(p);
    this.onResize();
    window.addEventListener("resize", this.onResize);
    this.canvas.addEventListener("pointermove", this.onMove);
    this.canvas.addEventListener("click", this.onClick);
    this.tick();
  }

  private onResize = () => {
    const w = this.host.clientWidth || 800, h = this.host.clientHeight || 500;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  syncLeads(leads: Lead[]) {
    const target = new THREE.Vector3();
    this.nodes = leads.map((lead) => {
      const [nx, ny, nz] = lead.n;
      target.set(nx * 2.0, ny * 1.6, nz * 1.9);
      const pos = nearestAnchor(target, this.anchors).clone();
      pos.x += ((lead.id.charCodeAt(0) % 5) - 2) * 0.03;
      pos.y += ((lead.id.charCodeAt(1) % 3) - 1) * 0.03;
      return { lead, pos };
    });
  }
  setFocus(id: string | null) {
    this.focusId = id;
  }
  pulse(id: string | null) {
    if (!id) return;
    const node = this.nodes.find((x) => x.lead.id === id);
    if (node) {
      this.sweepOrigin = node.pos.clone();
      this.sweeping = 0.001;
    }
  }
  setWorkActive(active: boolean) {
    if (active && !this.triggered) {
      this.triggered = true;
      this.pulsing = 0.001;
      this.sweepOrigin = this.sysPos.clone();
      this.sweeping = 0.001;
    } else if (!active) {
      this.triggered = false;
    }
  }

  streamTo(leadId: string) {
    const node = this.nodes.find((n) => n.lead.id === leadId);
    if (node) this.stream.streamTo(node.pos);
  }

  setMetrics(m: Metrics | null) {
    this.metrics = m;
  }

  private spawnBurst(pos: THREE.Vector3) {
    const parts = new Float32Array(64 * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < 64; i++) {
      v.randomDirection().multiplyScalar(1.2 + Math.random() * 4.5);
      parts.set([v.x, v.y, v.z], i * 3);
    }
    this.burst = { pos: pos.clone(), t: 0, parts };
  }

  private onMove = (e: PointerEvent) => {
    const r = this.canvas.getBoundingClientRect();
    const hit = this.pick(e.clientX - r.left, e.clientY - r.top);
    this.canvas.style.cursor = hit ? "pointer" : "default";
  };
  private onClick = (e: PointerEvent) => {
    const r = this.canvas.getBoundingClientRect();
    const id = this.pick(e.clientX - r.left, e.clientY - r.top);
    if (id) this.onPick(id);
  };
  private pick(mx: number, my: number): string | null {
    const t = this.time;
    return this.nodes.find((n) => {
      const p = this.project(n.pos, t);
      return Math.hypot(p.sx - mx, p.sy - my) < 10;
    })?.lead.id ?? null;
  }

  private time = 0;
  private project(v: THREE.Vector3, t: number) {
    const ry = t * 0.07;
    const cosY = Math.cos(ry), sinY = Math.sin(ry);
    let x = v.x * cosY + v.z * sinY;
    const z = -v.x * sinY + v.z * cosY;
    let y = v.y;
    const rx = -0.08;
    const y2 = y * Math.cos(rx) - z * Math.sin(rx);
    const z2 = y * Math.sin(rx) + z * Math.cos(rx);
    y = y2 - 0.4;
    const w = this.canvas.width / (window.devicePixelRatio || 1) || 800;
    const h = this.canvas.height / (window.devicePixelRatio || 1) || 500;
    const cx = w / 2, cy = h / 2;
    const f = 5.2, depth = 7.4 + z2;
    const s = f / depth;
    return { sx: cx + x * s * 120, sy: cy - y * s * 120, s };
  }

  private tick = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.tick);
    const t = (this.time += 0.016);
    const dt = 0.016;
    const w = this.canvas.width / (window.devicePixelRatio || 1) || 800;
    const h = this.canvas.height / (window.devicePixelRatio || 1) || 500;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);

    // gravity + vignette
    const fog = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.75);
    fog.addColorStop(0, "rgba(7,10,15,0)");
    fog.addColorStop(1, "rgba(2,4,8,0.7)");
    ctx.fillStyle = fog;
    ctx.fillRect(0, 0, w, h);

    // hologram plasma layer
    const o = this.project(new THREE.Vector3(0, 0.2, 0), t);
    const R = Math.max(60, 2.2 * o.s * 120);
    const pg = ctx.createRadialGradient(o.sx, o.sy, R * 0.2, o.sx, o.sy, R * 1.5);
    pg.addColorStop(0, `rgba(0,242,254,${0.10 + 0.05 * Math.sin(t * 0.8)})`);
    pg.addColorStop(0.5, "rgba(42,75,255,0.08)");
    pg.addColorStop(1, "rgba(42,75,255,0)");
    ctx.fillStyle = pg;
    ctx.fillRect(0, 0, w, h);
    // glowing fresnel rim around the brain
    ctx.save();
    ctx.strokeStyle = `rgba(0,242,254,${0.32 + 0.16 * Math.sin(t * 1.3)})`;
    ctx.lineWidth = 2;
    ctx.shadowColor = "rgba(0,242,254,0.9)";
    ctx.shadowBlur = 26;
    ctx.beginPath();
    ctx.arc(o.sx, o.sy, R * 1.06, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    // hologram scan rings drifting around the brain
    for (let k = 0; k < 2; k++) {
      const ph = t * (0.22 + k * 0.13);
      ctx.strokeStyle = `rgba(0,242,254,${0.16 + 0.09 * Math.sin(ph * 2)})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(o.sx, o.sy + Math.sin(ph) * R * 0.55, R * 1.3, R * 0.5, ph * 0.4, 0, Math.PI * 2);
      ctx.stroke();
    }

    // sparkle stream through the cortex + burst
    this.stream.advance(dt);
    const S = this.stream;
    if (S.hasHead) {
      for (let k = 0; k + 1 < S.trail.length; k++) {
        const a = this.project(S.trail[k], t), b = this.project(S.trail[k + 1], t);
        ctx.strokeStyle = `rgba(255,183,120,${0.04 + 0.12 * (k / S.trail.length)})`;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(a.sx, a.sy);
        ctx.lineTo(b.sx, b.sy);
        ctx.stroke();
      }
      const hp = this.project(S.head, t);
      ctx.save();
      ctx.shadowColor = "rgba(255,215,106,0.9)";
      ctx.shadowBlur = 20;
      ctx.fillStyle = "#ffd76a";
      ctx.beginPath();
      ctx.arc(hp.sx, hp.sy, 4.2 * hp.s, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    if (this.burst) {
      this.burst.t += dt / 0.8;
      const b = this.burst;
      const alpha = Math.max(0, 1 - b.t);
      for (let i = 0; i < b.parts.length; i += 3) {
        const s2 = b.t * 2.4;
        const px = b.pos.x + b.parts[i] * s2 + Math.sin(b.t * 7 + i) * 0.15 * s2;
        const py = b.pos.y + b.parts[i + 1] * s2;
        const pz = b.pos.z + b.parts[i + 2] * s2;
        const q = this.project(new THREE.Vector3(px, py, pz), t);
        ctx.fillStyle = `rgba(255,110,220,${alpha * 0.55})`;
        ctx.beginPath();
        ctx.arc(q.sx, q.sy, (1.6 + alpha * 2) * q.s, 0, Math.PI * 2);
        ctx.fill();
      }
      if (b.t >= 1) this.burst = null;
    }

    // floating holo mini-screens sit BEHIND the cortex so the brain stays the hero
    if (this.metrics) {
      const placements = [
        { kind: "ACTIVE NODES", ox: -1.55, oy: -0.95 },
        { kind: "PIPELINE", ox: 1.6, oy: -0.7 },
        { kind: "REPLY RATE", ox: -1.5, oy: 0.75 },
        { kind: "PENDING", ox: 1.55, oy: 0.6 },
      ];
      for (const pl of placements) {
        const px = o.sx + pl.ox * R * 0.95;
        const py = o.sy + pl.oy * R * 0.95;
        drawMiniPanel(ctx, px, py, holoStats(pl.kind, this.metrics));
      }
    }

    // edges (network skin)
    ctx.lineWidth = 1;
    for (const [i, j] of this.edges) {
      const a = this.project(this.anchors[i], t);
      const b = this.project(this.anchors[j], t);
      const alpha = Math.min(a.s, b.s) * 0.05;
      if (alpha <= 0.003) continue;
      ctx.strokeStyle = `rgba(159,123,255,${alpha})`;
      ctx.beginPath();
      ctx.moveTo(a.sx, a.sy);
      ctx.lineTo(b.sx, b.sy);
      ctx.stroke();
    }
    // anchor dots
    for (const a of this.anchors) {
      const p = this.project(a, t);
      const r = Math.max(0.6, 2.1 * p.s);
      ctx.fillStyle = `rgba(0,242,254,${0.35 * p.s})`;
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // leads
    for (const n of this.nodes) {
      const p = this.project(n.pos, t);
      const isFocus = n.lead.id === this.focusId;
      const col = isFocus ? MAGENTA : n.lead.stage === "no_show" ? AMBER : CYAN;
      const r = (isFocus ? 5 : 3.4) * p.s;
      ctx.fillStyle = col;
      ctx.globalAlpha = 0.85 * p.s;
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // working_jobs system node
    this.active += ((this.triggered ? 1 : 0) - this.active) * Math.min(1, dt * 3.2);
    if (this.pulsing > 0 && this.pulsing < 1) this.pulsing = Math.min(1, this.pulsing + dt * 1.05);
    else if (this.pulsing >= 1) this.pulsing = 0;
    const sp = this.project(this.sysPos, t);
    // pulse ring
    if (this.pulsing > 0) {
      const rr = (8 + this.pulsing * 46) * sp.s;
      ctx.strokeStyle = `rgba(255,0,127,${(1 - this.pulsing) * (0.3 + this.active)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sp.sx, sp.sy, rr, 0, Math.PI * 2);
      ctx.stroke();
    }
    const glowR = (10 + Math.sin(t * 6) * (2 + 3 * this.active)) * sp.s;
    const nodeCol = this.lerpC(PURPLE, MAGENTA, this.active);
    ctx.fillStyle = nodeCol;
    ctx.globalAlpha = 0.7 + 0.3 * this.active;
    ctx.beginPath();
    ctx.arc(sp.sx, sp.sy, glowR, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    // label
    ctx.font = "700 11px 'SF Mono', ui-monospace, Menlo, monospace";
    const lab = "WORKING_JOBS";
    const lw = ctx.measureText(lab).width + 18;
    const lx = sp.sx - lw / 2, ly = sp.sy - glowR - 22;
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = "rgba(4,14,20,0.85)";
    ctx.beginPath();
    ctx.roundRect(lx, ly, lw, 18, 9);
    ctx.fill();
    ctx.strokeStyle = this.lerpC(PURPLE, MAGENTA, this.active);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = this.lerpC(PURPLE, MAGENTA, this.active);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(lab, sp.sx, ly + 9);
    ctx.globalAlpha = 1;
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";

    // wave sweep
    if (this.sweeping > 0 && this.sweepOrigin) {
      this.sweeping = Math.min(1.1, this.sweeping + dt * 0.45);
      const radius = this.sweeping * 5.4;
      for (const n of this.nodes) {
        const d = n.pos.distanceTo(this.sweepOrigin!);
        const boost = Math.max(0, 1 - Math.abs(d - radius) * 1.8);
        if (boost <= 0) continue;
        const p = this.project(n.pos, t);
        ctx.fillStyle = MAGENTA;
        ctx.globalAlpha = Math.min(1, boost * 0.9);
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, (this.focusId === n.lead.id ? 6 : 4) * p.s, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (this.sweeping >= 1.1) {
        this.sweeping = 0;
        this.sweepOrigin = null;
      }
    }
  };

  private lerpC(aHex: string, bHex: string, t: number): string {
    const a = hexToRgb(aHex), b = hexToRgb(bHex);
    const r = (a[0] + (b[0] - a[0]) * t), g = (a[1] + (b[1] - a[1]) * t), bl = (a[2] + (b[2] - a[2]) * t);
    const to = (x: number) => Math.round(Math.min(255, Math.max(0, x * 255)));
    return `rgb(${to(r)},${to(g)},${to(bl)})`;
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.onResize);
    this.canvas.removeEventListener("pointermove", this.onMove);
    this.canvas.removeEventListener("click", this.onClick);
    this.host.removeChild(this.canvas);
  }
}

// textures ------------------------------------------------------------
interface StreamPoint {
  points: THREE.Vector3[];
  lens: number[];
  total: number;
  t: number;
}

// ------- holo data screens (shared drawing for GL sprites + Canvas fallback) -------
function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function corner(g: CanvasRenderingContext2D, x: number, y: number, s: number) {
  g.beginPath();
  g.moveTo(x, y + s);
  g.lineTo(x, y);
  g.lineTo(x + s, y);
  g.stroke();
}

function holoStats(kind: string, m: Metrics | null): { title: string; label: string; color: string; bars: number[] } {
  const wave = (seed: number, i: number) => 0.35 + 0.4 * (0.5 + 0.5 * Math.sin(seed + i * 1.9 + Math.sin(i * 0.7) * 2));
  const mk = (v: number, seed: number) => Array.from({ length: 8 }, (_, i) => Math.min(1, v * 1.15 * wave(seed, i)));
  switch (kind) {
    case "ACTIVE NODES":
      return { title: kind, label: String(m?.activeNodes ?? 0), color: CYAN, bars: mk((m?.activeNodes ?? 0) / 24, 3.1) };
    case "PIPELINE":
      return { title: kind, label: m ? money(m.pipelineCents) : "$0", color: PURPLE, bars: mk((m?.pipelineCents ?? 0) / 1_200_000, 5.7) };
    case "REPLY RATE":
      return { title: kind, label: m ? Math.round((m.replyRate ?? 0) * 100) + "%" : "—", color: CYAN, bars: mk(m?.replyRate ?? 0, 8.2) };
    case "PENDING":
      return { title: kind, label: String(m?.pendingReplies ?? 0), color: "#FF9F43", bars: mk((m?.pendingReplies ?? 0) / 12, 4.4) };
    case "WON":
      return { title: kind, label: String(m?.won ?? 0), color: "#5EEAD4", bars: mk((m?.won ?? 0) / 10, 2.2) };
    default:
      return { title: kind, label: String(m?.noShows ?? 0), color: AMBER, bars: mk((m?.noShows ?? 0) / 8, 6.6) };
  }
}

function holoCanvas(kind: string, m: Metrics | null): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 160;
  const g = c.getContext("2d")!;
  roundRect(g, 4, 4, 248, 152, 10);
  g.fillStyle = "rgba(5,14,22,0.30)";
  g.fill();
  g.strokeStyle = "rgba(0,242,254,0.4)";
  g.lineWidth = 1.5;
  g.stroke();
  g.strokeStyle = "rgba(0,242,254,0.85)";
  g.lineWidth = 2;
  corner(g, 4, 4, 14);
  corner(g, 252, 4, 14);
  corner(g, 4, 156, 14);
  corner(g, 252, 156, 14);
  const st = holoStats(kind, m);
  g.font = "700 12px 'SF Mono', ui-monospace, Menlo, monospace";
  g.fillStyle = "rgba(159,123,255,0.95)";
  g.textAlign = "left";
  g.fillText(st.title, 14, 24);
  g.font = "600 28px 'SF Mono', ui-monospace, Menlo, monospace";
  g.fillStyle = st.color;
  g.fillText(st.label, 14, 58);
  const n = st.bars.length;
  const bw = (248 - 28) / n;
  const baseY = 132;
  for (let i = 0; i < n; i++) {
    const bh = Math.max(4, st.bars[i] * 54);
    g.fillStyle = st.color;
    g.globalAlpha = 0.22 + 0.6 * st.bars[i];
    g.fillRect(14 + i * bw, baseY - bh, bw - 8, bh);
  }
  g.globalAlpha = 1;
  g.strokeStyle = "rgba(0,242,254,0.22)";
  g.beginPath();
  g.moveTo(14, baseY);
  g.lineTo(250, baseY);
  g.stroke();
  return c;
}

function drawMiniPanel(ctx: CanvasRenderingContext2D, x: number, y: number, st: { title: string; label: string; color: string; bars: number[] }) {
  ctx.save();
  roundRect(ctx, x - 78, y - 36, 156, 72, 9);
  ctx.fillStyle = "rgba(5,14,22,0.32)";
  ctx.fill();
  ctx.strokeStyle = "rgba(0,242,254,0.4)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.font = "700 9px 'SF Mono', ui-monospace, Menlo, monospace";
  ctx.fillStyle = "rgba(159,123,255,0.95)";
  ctx.textAlign = "left";
  ctx.fillText(st.title, x - 72, y - 22);
  ctx.font = "600 18px 'SF Mono', ui-monospace, Menlo, monospace";
  ctx.fillStyle = st.color;
  ctx.fillText(st.label, x - 72, y - 4);
  const n = st.bars.length;
  const bw = 136 / n;
  for (let i = 0; i < n; i++) {
    const bh = Math.max(3, st.bars[i] * 30);
    ctx.fillStyle = st.color;
    ctx.globalAlpha = 0.2 + 0.6 * st.bars[i];
    ctx.fillRect(x - 72 + i * bw, y + 14 - bh, bw - 6, bh);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

// Ultimate fallback: the cortex as pure SVG — renders everywhere (no WebGL,
// no canvas, even static previews). Network brain + working_jobs pulse + holo
// mini panels, so the brain is always visible no matter the environment.
function BrainStatic({ leads, activeLeadId, workActive, metrics }: { leads: Lead[]; activeLeadId: string | null; workActive: boolean; metrics: Metrics | null }) {
  const anchors = useMemo(() => buildAnchors(), []);
  const edges = useMemo(() => cortexEdges(anchors), [anchors]);
  const sys = useMemo(() => frontalAnchor(anchors).clone().multiplyScalar(1.12), [anchors]);

  const proj = (v: THREE.Vector3) => {
    const RY = 0.62, RX = -0.1;
    const x1 = v.x * Math.cos(RY) + v.z * Math.sin(RY);
    const z1 = -v.x * Math.sin(RY) + v.z * Math.cos(RY);
    const y2 = v.y * Math.cos(RX) - z1 * Math.sin(RX);
    const z2 = v.y * Math.sin(RX) + z1 * Math.cos(RX);
    const f = 3.2, s = f / (f + z2 + 0.6);
    return { x: 200 + x1 * s * 145, y: 205 - y2 * s * 145 };
  };

  const leadPts = leads.map((l) => {
    const target = new THREE.Vector3(l.n[0] * 2, l.n[1] * 1.6, l.n[2] * 1.9);
    const pos = nearestAnchor(target, anchors).clone();
    pos.x += ((l.id.charCodeAt(0) % 5) - 2) * 0.03;
    return { l, p: proj(pos) };
  });

  const sysP = proj(sys);
  const panels = ["ACTIVE NODES", "PIPELINE", "REPLY RATE"].map((k) => ({ k, ...holoStats(k, metrics) }));

  return (
    <div className="brain-host flex items-center justify-center" aria-label="Neural cortex (static mode)">
      <svg viewBox="0 0 400 400" className="h-full max-h-[520px] w-auto" style={{ filter: "drop-shadow(0 0 16px rgba(0,242,254,0.3))" }}>
        <defs>
          <radialGradient id="cortexGlowS" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(0,242,254,0.14)" />
            <stop offset="100%" stopColor="rgba(0,242,254,0)" />
          </radialGradient>
        </defs>
        <circle cx="200" cy="205" r="190" fill="url(#cortexGlowS)" />
        {/* network skin */}
        {edges.map(([i, j], k) => {
          const a = proj(anchors[i]), b = proj(anchors[j]);
          return <line key={k} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="rgba(0,242,254,0.16)" strokeWidth="0.7" />;
        })}
        {/* cortex dots */}
        {anchors.map((a, i) => {
          const p = proj(a);
          return <circle key={i} cx={p.x} cy={p.y} r={1.5} fill="rgba(0,242,254,0.8)" />;
        })}
        {/* leads */}
        {leadPts.map(({ l, p }) => (
          <circle key={l.id} cx={p.x} cy={p.y} r={l.id === activeLeadId ? 5 : 3.2} fill={l.id === activeLeadId ? MAGENTA : l.stage === "no_show" ? AMBER : CYAN} />
        ))}
        {/* working_jobs node */}
        {workActive ? (
          <circle cx={sysP.x} cy={sysP.y} r="9" fill="none" stroke={MAGENTA} strokeWidth="1.6">
            <animate attributeName="r" values="9;30" dur="1.1s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.9;0" dur="1.1s" repeatCount="indefinite" />
          </circle>
        ) : null}
        <circle cx={sysP.x} cy={sysP.y} r={workActive ? 9 : 7} fill={workActive ? MAGENTA : PURPLE} />
        <text x={sysP.x} y={sysP.y - 15} textAnchor="middle" fontSize="10" fontWeight="700" fontFamily="'SF Mono', ui-monospace, monospace" fill={workActive ? MAGENTA : PURPLE}>
          WORKING_JOBS
        </text>
        {/* holo mini panels */}
        {panels.map((pn, i) => {
          const x = i === 0 ? 12 : i === 1 ? 400 - 146 : 12;
          const y = i === 0 ? 12 : i === 1 ? 12 : 400 - 82;
          return (
            <g key={pn.k}>
              <rect x={x} y={y} width="134" height="70" rx="7" fill="rgba(5,14,22,0.5)" stroke="rgba(0,242,254,0.4)" strokeWidth="1" />
              <text x={x + 10} y={y + 15} fontSize="8" fontWeight="700" fontFamily="'SF Mono', ui-monospace, monospace" fill="rgba(159,123,255,0.95)">{pn.k}</text>
              <text x={x + 10} y={y + 34} fontSize="17" fontWeight="600" fontFamily="'SF Mono', ui-monospace, monospace" fill={pn.color}>{pn.label}</text>
              {pn.bars.slice(0, 6).map((b, bi) => (
                <rect key={bi} x={x + 10 + bi * 20} y={y + 60 - Math.max(4, b * 24)} width="15" height={Math.max(4, b * 24)} rx="1.5" fill={pn.color} opacity={0.25 + 0.6 * b} />
              ))}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// A glowing spark that weaves through the brain's node web and ends on a target.
class StreamRunner {
  head = new THREE.Vector3();
  hasHead = false;
  trail: THREE.Vector3[] = [];
  private queue: StreamPoint[] = [];
  private current: StreamPoint | null = null;
  private adj: number[][];
  private anchors: THREE.Vector3[];
  onBurst: ((pos: THREE.Vector3) => void) | null = null;

  constructor(anchors: THREE.Vector3[], edges: [number, number][]) {
    this.anchors = anchors;
    this.adj = Array.from({ length: anchors.length }, () => [] as number[]);
    for (const [i, j] of edges) {
      this.adj[i].push(j);
      this.adj[j].push(i);
    }
  }

  get active(): boolean {
    return !!this.current;
  }

  streamTo(targetPos: THREE.Vector3) {
    let tgt = 0, bd = Infinity;
    for (let i = 0; i < this.anchors.length; i++) {
      const d = this.anchors[i].distanceToSquared(targetPos);
      if (d < bd) {
        bd = d;
        tgt = i;
      }
    }
    let org = 0, bg = -Infinity;
    for (let i = 0; i < this.anchors.length; i++) {
      const d = this.anchors[i].distanceToSquared(this.anchors[tgt]);
      if (d > bg) {
        bg = d;
        org = i;
      }
    }
    const idxPath = this.bfs(org, tgt) || [tgt];
    const points = idxPath.map((i) => this.anchors[i].clone());
    points.push(targetPos.clone());
    const lens = [0];
    for (let i = 1; i < points.length; i++) lens.push(lens[i - 1] + points[i].distanceTo(points[i - 1]));
    this.queue.push({ points, lens, total: lens[lens.length - 1], t: 0 });
  }

  private bfs(from: number, to: number): number[] | null {
    if (from === to) return [from];
    const prev = new Array<number>(this.anchors.length).fill(-1);
    const q: number[] = [from];
    prev[from] = from;
    let found = false;
    while (q.length) {
      const cur = q.shift()!;
      if (cur === to) {
        found = true;
        break;
      }
      for (const nb of this.adj[cur]) {
        if (prev[nb] === -1) {
          prev[nb] = cur;
          q.push(nb);
        }
      }
    }
    if (!found) return null;
    const path = [to];
    let c = to;
    while (c !== from) {
      c = prev[c];
      path.push(c);
    }
    return path.reverse();
  }

  private pointAt(T: number): THREE.Vector3 {
    const s = this.current!;
    const target = T * s.total;
    let lo = 0, hi = s.lens.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (s.lens[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    const i = Math.max(0, lo - 1);
    const seg = s.lens[i + 1] - s.lens[i];
    const f = seg > 0 ? Math.min(1, Math.max(0, (target - s.lens[i]) / seg)) : 0;
    return s.points[i].clone().lerp(s.points[i + 1], f);
  }

  advance(dt: number) {
    if (!this.current && this.queue.length) {
      this.current = this.queue.shift()!;
      this.trail.length = 0;
    }
    if (!this.current) {
      this.hasHead = false;
      return;
    }
    const s = this.current;
    s.t += dt / 0.9;
    const head = this.pointAt(Math.min(1, s.t));
    this.head.copy(head);
    this.hasHead = true;
    this.trail.push(head.clone());
    if (this.trail.length > 16) this.trail.shift();
    if (s.t >= 1) {
      this.onBurst?.(head);
      this.current = null;
    }
  }
}

const PLASMA_VERT = `
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  varying vec3 vViewDir;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vViewDir = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const PLASMA_FRAG = `
  uniform float uTime;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  varying vec3 vViewDir;
  float hash(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123); }
  float noise(vec3 p){
    vec3 i = floor(p); vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i+vec3(0.0,0.0,0.0)), hash(i+vec3(1.0,0.0,0.0)), f.x),
                   mix(hash(i+vec3(0.0,1.0,0.0)), hash(i+vec3(1.0,1.0,0.0)), f.x), f.y),
               mix(mix(hash(i+vec3(0.0,0.0,1.0)), hash(i+vec3(1.0,0.0,1.0)), f.x),
                   mix(hash(i+vec3(0.0,1.0,1.0)), hash(i+vec3(1.0,1.0,1.0)), f.x), f.y), f.z);
  }
  float fbm(vec3 p){
    float v = 0.0; float a = 0.5;
    for(int i = 0; i < 4; i++){ v += a * noise(p); p *= 2.03; a *= 0.5; }
    return v;
  }
  void main(){
    vec3 n = normalize(vNormal);
    float fres = pow(1.0 - abs(dot(n, vViewDir)), 2.5);
    float plasma = fbm(vWorldPos * 1.4 + vec3(0.0, uTime * 0.32, uTime * 0.18));
    float alpha = (0.10 + 0.4 * fres) * (0.5 + 0.5 * plasma);
    vec3 col = mix(uColorB, uColorA, 0.35 + 0.65 * fres + 0.35 * plasma);
    gl_FragColor = vec4(col, alpha);
  }
`;

function makeRadialDot(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 31);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.35, "rgba(255,255,255,0.8)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function makeLabelTexture(text: string): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 96;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, 512, 96);
  ctx.font = "700 34px 'SF Mono', ui-monospace, Menlo, monospace";
  const tw = ctx.measureText(text).width;
  const w = Math.min(500, tw + 56);
  const cx = (512 - w) / 2, y0 = 14, hh = 62;
  ctx.beginPath();
  ctx.moveTo(cx + hh / 2, y0);
  ctx.arcTo(cx + w, y0, cx + w, y0 + hh, hh / 2);
  ctx.arcTo(cx + w, y0 + hh, cx, y0 + hh, hh / 2);
  ctx.arcTo(cx, y0 + hh, cx, y0, hh / 2);
  ctx.arcTo(cx, y0, cx + w, y0, hh / 2);
  ctx.closePath();
  ctx.fillStyle = "rgba(4,14,20,0.9)";
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,1)";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 256, y0 + hh / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}