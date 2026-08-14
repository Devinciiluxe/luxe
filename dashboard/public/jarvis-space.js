/* <jarvis-space> — holographic 3D node map. Three.js, GPU particle galaxies, filament tubes, orbit camera. */
(function () {
  const V = "0.161.0";
  const CDN = "https://cdn.jsdelivr.net/npm/three@" + V;
  const HUES = { live: "#34E0D0", attention: "#F7B54F", stuck: "#FF6B6B", ai: "#786EFF", value: "#C6A469", idle: "#93A0A6" };
  const HUES2 = { live: "#C6A469", attention: "#C6A469", stuck: "#786EFF", ai: "#34E0D0", value: "#786EFF", idle: "#786EFF" };
  const RM = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const GAL_VERT = `
    attribute float aR; attribute float aA; attribute float aY; attribute float aS; attribute float aM;
    uniform float uTime,uSpin,uRadius,uActive;
    varying float vM;
    void main(){
      float r=aR*uRadius;
      float ang=aA+uTime*uSpin*(1.6/(0.25+aR));
      vec3 p=vec3(cos(ang)*r,aY*uRadius,sin(ang)*r);
      vM=aM;
      vec4 mv=modelViewMatrix*vec4(p,1.0);
      gl_PointSize=aS*(1.0+uActive*0.45)*(150.0/max(1.0,-mv.z));
      gl_Position=projectionMatrix*mv;
    }`;
  const GAL_FRAG = `
    uniform vec3 uHue,uHue2; uniform float uActive;
    varying float vM;
    void main(){
      vec2 c=gl_PointCoord-0.5; float d=length(c);
      float a=smoothstep(0.5,0.0,d); a*=a;
      vec3 col=mix(uHue,uHue2,step(0.72,vM));
      col=mix(col,vec3(1.0),smoothstep(0.88,1.0,vM));
      col+=vec3(1.0)*smoothstep(0.16,0.0,d)*0.55;
      gl_FragColor=vec4(col,a*(0.5+0.5*uActive));
    }`;
  const SHELL_VERT = `
    varying vec3 vN; varying vec3 vW;
    void main(){
      vN=normalize(normalMatrix*normal);
      vec4 w=modelMatrix*vec4(position,1.0); vW=w.xyz;
      gl_Position=projectionMatrix*viewMatrix*w;
    }`;
  const SHELL_FRAG = `
    uniform vec3 uHue; uniform float uActive,uTime;
    varying vec3 vN; varying vec3 vW;
    void main(){
      vec3 V2=normalize(cameraPosition-vW);
      float nd=abs(dot(normalize(vN),V2));
      float x=1.0-nd;
      vec3 rim=vec3(pow(x,2.4),pow(x,3.0),pow(x,3.8));
      vec3 col=uHue*rim.g*1.6 + vec3(uHue.r*rim.r*0.5,uHue.g*rim.g*0.4,uHue.b*rim.b*0.9) + vec3(0.9,0.97,1.0)*pow(x,6.0)*0.7;
      float scan=0.85+0.15*sin(vW.y*3.2-uTime*2.2);
      float a=(pow(x,2.6)*(0.30+0.55*uActive)+0.03)*scan;
      gl_FragColor=vec4(col*scan,a);
    }`;
  const LINK_VERT = `
    attribute float aT; attribute float aTh;
    uniform vec3 uP0,uP1,uP2; uniform float uR;
    varying float vT;
    void main(){
      vT=aT;
      vec3 B=mix(mix(uP0,uP1,aT),mix(uP1,uP2,aT),aT);
      vec3 Tg=normalize(mix(uP1-uP0,uP2-uP1,aT)+vec3(1e-5));
      vec3 up=abs(Tg.y)>0.98?vec3(1.0,0.0,0.0):vec3(0.0,1.0,0.0);
      vec3 N=normalize(cross(Tg,up)); vec3 Bi=cross(Tg,N);
      float taper=0.4+0.6*sin(3.14159*aT);
      vec3 p=B+(cos(aTh)*N+sin(aTh)*Bi)*uR*taper;
      gl_Position=projectionMatrix*viewMatrix*vec4(p,1.0);
    }`;
  const LINK_FRAG = `
    uniform vec3 uHue; uniform float uTime,uBoost,uSeed;
    varying float vT;
    void main(){
      float ends=smoothstep(0.0,0.08,vT)*smoothstep(1.0,0.92,vT);
      float base=0.10+0.22*uBoost;
      float ph=fract(vT-uTime*(0.10+0.22*uBoost)+uSeed);
      float pk=exp(-pow((ph-0.5)/0.045,2.0));
      float ph2=fract(vT-uTime*(0.10+0.22*uBoost)+uSeed+0.5);
      pk+=exp(-pow((ph2-0.5)/0.045,2.0))*0.6;
      vec3 col=uHue*(base+pk*(0.7+1.6*uBoost))+vec3(1.0)*pk*0.25*uBoost;
      gl_FragColor=vec4(col,(base+pk*(0.5+0.5*uBoost))*ends);
    }`;

  function radialTex(THREE, inner, mid) {
    const c = document.createElement("canvas"); c.width = c.height = 128;
    const g = c.getContext("2d");
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, inner); gr.addColorStop(0.35, mid); gr.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c); return t;
  }
  function tickTex(THREE) {
    const c = document.createElement("canvas"); c.width = 1024; c.height = 32;
    const g = c.getContext("2d"); g.strokeStyle = "rgba(255,255,255,.9)"; g.fillStyle = "rgba(255,255,255,.9)";
    let rnd = 7;
    const R = () => (rnd = (rnd * 16807) % 2147483647) / 2147483647;
    for (let x = 0; x < 1024; x += 8) {
      const h = x % 64 === 0 ? 18 : x % 32 === 0 ? 11 : 6;
      g.globalAlpha = x % 64 === 0 ? 0.95 : 0.45;
      g.fillRect(x, 16 - h / 2, x % 64 === 0 ? 2 : 1, h);
      if (R() > 0.86) { g.globalAlpha = 0.8; g.fillRect(x + 3, R() > 0.5 ? 4 : 24, 3, 3); }
    }
    const t = new THREE.CanvasTexture(c); t.wrapS = 1000; t.repeat.x = 1; return t;
  }

  class JarvisSpace extends HTMLElement {
    constructor() {
      super();
      this.nodes = new Map(); this.links = [];
      this.activeId = null; this.hoverId = null;
      this._t = 0; this._quality = 1;
      this.ready = false;
      this._readyCbs = [];
    }
    connectedCallback() {
      if (this._init) return; this._init = true;
      this.style.display = "block"; this.style.overflow = "hidden";
      if (!this.style.position) this.style.position = "relative";
      if (!this.style.width) this.style.width = "100%";
      if (!this.style.height) this.style.height = "100%";
      this.canvas = document.createElement("canvas");
      this.canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;opacity:0;transition:opacity 1.4s ease";
      this.labelLayer = document.createElement("div");
      this.labelLayer.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden;font-family:var(--font-mono,monospace)";
      this.appendChild(this.canvas); this.appendChild(this.labelLayer);
      this._boot();
    }
    onReady(cb) { this.ready ? cb() : this._readyCbs.push(cb); }
    async _boot() {
      try {
        const THREE = await import(CDN + "/+esm");
        this.THREE = THREE;
        let composerParts = null;
        try {
          const [ec, rp, ub] = await Promise.all([
            import(CDN + "/examples/jsm/postprocessing/EffectComposer.js/+esm"),
            import(CDN + "/examples/jsm/postprocessing/RenderPass.js/+esm"),
            import(CDN + "/examples/jsm/postprocessing/UnrealBloomPass.js/+esm"),
          ]);
          composerParts = { EffectComposer: ec.EffectComposer, RenderPass: rp.RenderPass, UnrealBloomPass: ub.UnrealBloomPass };
        } catch (e) { console.warn("bloom unavailable, direct render", e); }
        this._setup(composerParts);
        this.ready = true;
        this._readyCbs.forEach((f) => f()); this._readyCbs = [];
        this.dispatchEvent(new CustomEvent("space-ready"));
        requestAnimationFrame(() => { this.canvas.style.opacity = "1"; });
      } catch (e) { console.error("jarvis-space failed to init", e); }
    }
    _setup(post) {
      const THREE = this.THREE;
      const renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: false });
      renderer.setClearColor(0x040609, 1);
      this.renderer = renderer;
      const scene = new THREE.Scene(); this.scene = scene;
      scene.fog = new THREE.FogExp2(0x04060a, 0.00075);
      const cam = new THREE.PerspectiveCamera(45, 1, 1, 4000); this.camera = cam;
      this.ctrl = { target: new THREE.Vector3(0, 4, 0), radius: 520, theta: 0.6, phi: 1.12, vT: 0, vP: 0, vR: 0, dragging: false, tween: null, idleSpin: true };
      this._applyCam();

      // starfield: 3 parallax layers
      this.starLayers = [];
      for (let L = 0; L < 3; L++) {
        const n = [900, 600, 350][L], rad = [1500, 1100, 800][L];
        const pos = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = rad * (0.55 + 0.45 * Math.random());
          const s = Math.sqrt(1 - u * u);
          pos[i * 3] = r * s * Math.cos(a); pos[i * 3 + 1] = r * u; pos[i * 3 + 2] = r * s * Math.sin(a);
        }
        const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        const m = new THREE.PointsMaterial({ color: 0xdfe9f2, size: [1.9, 1.4, 1.0][L], sizeAttenuation: false, transparent: true, opacity: [0.8, 0.5, 0.32][L], depthWrite: false });
        const pts = new THREE.Points(g, m); scene.add(pts); this.starLayers.push(pts);
      }
      // nebula fog sprites
      const nebCols = [["rgba(52,224,208,.13)", "rgba(52,224,208,.05)"], ["rgba(120,110,255,.12)", "rgba(120,110,255,.04)"], ["rgba(198,164,105,.08)", "rgba(198,164,105,.03)"]];
      this.nebulae = [];
      for (let i = 0; i < 7; i++) {
        const cc = nebCols[i % 3];
        const t = radialTex(THREE, cc[0], cc[1]);
        const m = new THREE.SpriteMaterial({ map: t, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.55 });
        const s = new THREE.Sprite(m);
        const a = i * 0.9 + 0.4, r = 320 + (i % 4) * 130;
        s.position.set(Math.cos(a) * r, -60 + (i * 47) % 160, Math.sin(a) * r);
        const sc = 380 + (i % 3) * 220; s.scale.set(sc, sc, 1);
        s.userData.drift = { a, r, sp: 0.004 + (i % 3) * 0.002 };
        scene.add(s); this.nebulae.push(s);
      }
      // drifting dust
      { const n = 500, pos = new Float32Array(n * 3);
        for (let i = 0; i < n * 3; i++) pos[i] = (Math.random() * 2 - 1) * 260;
        const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        this.dust = new THREE.Points(g, new THREE.PointsMaterial({ color: 0x9adfe0, size: 1.1, sizeAttenuation: true, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending }));
        scene.add(this.dust); }

      this.glowTex = radialTex(THREE, "rgba(255,255,255,.95)", "rgba(255,255,255,.28)");
      this.tickTexture = tickTex(THREE);
      this.tickTexture.wrapS = THREE.RepeatWrapping;
      this.nodeRoot = new THREE.Group(); scene.add(this.nodeRoot);
      this.linkRoot = new THREE.Group(); scene.add(this.linkRoot);

      if (post) {
        try {
          const composer = new post.EffectComposer(renderer);
          composer.addPass(new post.RenderPass(scene, cam));
          this.bloom = new post.UnrealBloomPass(new THREE.Vector2(2, 2), 0.75, 0.55, 0.12);
          composer.addPass(this.bloom);
          this.composer = composer;
        } catch (e) { console.warn("composer failed", e); this.composer = null; }
      }
      this.ray = new THREE.Raycaster(); this.pointer = new THREE.Vector2(-2, -2);
      this._bindInput();
      this.ro = new ResizeObserver(() => this._resize()); this.ro.observe(this);
      this._resize();
      this._clock = performance.now();
      const loop = () => { this._raf = requestAnimationFrame(loop); this._frame(); };
      loop();
    }
    _resize() {
      const w = this.clientWidth || 800, h = this.clientHeight || 600;
      const dpr = Math.min(devicePixelRatio || 1, this._quality > 0.6 ? 1.75 : 1.25);
      this.renderer.setPixelRatio(dpr); this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
      if (this.composer) this.composer.setSize(w * dpr, h * dpr);
    }
    setQuality(q) { this._quality = q === "laptop" ? 0.5 : 1; if (this.bloom) this.bloom.strength = q === "laptop" ? 0.5 : 0.75; if (this.renderer) this._resize(); }

    /* ---------- graph ---------- */
    setData(data) { this.onReady(() => this._build(data)); }
    _build(data) {
      const THREE = this.THREE;
      this.nodeRoot.clear(); this.linkRoot.clear(); this.nodes.clear(); this.links = [];
      this.labelLayer.innerHTML = "";
      const stages = data.nodes.filter((n) => n.parent === "core");
      const layout = new Map();
      data.nodes.forEach((n) => {
        if (!n.parent) layout.set(n.id, new THREE.Vector3(0, 0, 0));
      });
      stages.forEach((n, i) => {
        const a = i * (Math.PI * 2 / stages.length) + 0.45;
        layout.set(n.id, new THREE.Vector3(Math.cos(a) * 80, Math.sin(i * 2.3) * 17, Math.sin(a) * 80));
      });
      data.nodes.forEach((n) => {
        const hue = new THREE.Color(HUES[n.state] || HUES.live);
        const hue2 = new THREE.Color(HUES2[n.state] || HUES2.live);
        const group = new THREE.Group();
        const isMoon = n.parent && n.parent !== "core";
        const base = layout.get(n.id) || new THREE.Vector3();
        group.position.copy(base);
        // galaxy points
        const cnt = Math.round((n.r >= 14 ? 9000 : n.r >= 7 ? 4200 : 1500) * this._quality);
        const aR = new Float32Array(cnt), aA = new Float32Array(cnt), aY = new Float32Array(cnt), aS = new Float32Array(cnt), aM = new Float32Array(cnt);
        const arms = n.r >= 14 ? 4 : 3, twist = 4.2;
        for (let i = 0; i < cnt; i++) {
          const r = Math.pow(Math.random(), 0.6);
          const arm = i % arms;
          const jitter = (Math.random() + Math.random() + Math.random() - 1.5) * (0.55 / (r * 2.2 + 0.4));
          aR[i] = r;
          aA[i] = arm * (Math.PI * 2 / arms) + r * twist + jitter;
          const thick = (1 - r * 0.75) * 0.16;
          aY[i] = (Math.random() * 2 - 1) * thick * (Math.random() < 0.12 ? 2.4 : 1);
          aS[i] = 0.8 + Math.random() * 1.8 + (r < 0.12 ? 1.4 : 0);
          aM[i] = Math.random();
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(cnt * 3), 3));
        g.setAttribute("aR", new THREE.BufferAttribute(aR, 1)); g.setAttribute("aA", new THREE.BufferAttribute(aA, 1));
        g.setAttribute("aY", new THREE.BufferAttribute(aY, 1)); g.setAttribute("aS", new THREE.BufferAttribute(aS, 1));
        g.setAttribute("aM", new THREE.BufferAttribute(aM, 1));
        g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), n.r * 1.4);
        const galMat = new THREE.ShaderMaterial({
          vertexShader: GAL_VERT, fragmentShader: GAL_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
          uniforms: { uTime: { value: 0 }, uSpin: { value: (RM ? 0.05 : 0.22) * (isMoon ? 1.4 : 1) }, uRadius: { value: n.r * 0.94 }, uActive: { value: 0 }, uHue: { value: hue }, uHue2: { value: hue2 } },
        });
        const gal = new THREE.Points(g, galMat);
        gal.rotation.set((Math.random() - 0.5) * 0.7, Math.random() * Math.PI, (Math.random() - 0.5) * 0.7);
        group.add(gal);
        // shell
        const shellMat = new THREE.ShaderMaterial({ vertexShader: SHELL_VERT, fragmentShader: SHELL_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uHue: { value: hue }, uActive: { value: 0 }, uTime: { value: 0 } } });
        group.add(new THREE.Mesh(new THREE.SphereGeometry(n.r, 40, 28), shellMat));
        // core + halo sprites
        const coreS = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: hue, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.5 }));
        coreS.scale.set(n.r * 1.15, n.r * 1.15, 1); group.add(coreS);
        const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: hue, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.12 }));
        halo.scale.set(n.r * 4.6, n.r * 4.6, 1); group.add(halo);
        // gyro rings (band with ticks + thin torus)
        const rings = new THREE.Group();
        if (n.r >= 7) {
          const band = new THREE.Mesh(
            new THREE.CylinderGeometry(n.r * 1.38, n.r * 1.38, n.r * 0.09, 96, 1, true),
            new THREE.MeshBasicMaterial({ map: this.tickTexture, color: hue, transparent: true, opacity: 0.55, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
          band.rotation.set(0.35, 0, -0.2); rings.add(band);
          const tor = new THREE.Mesh(new THREE.TorusGeometry(n.r * 1.62, n.r * 0.012, 8, 120),
            new THREE.MeshBasicMaterial({ color: hue, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false }));
          tor.rotation.set(Math.PI / 2 - 0.5, 0.4, 0); rings.add(tor);
          const tor2 = new THREE.Mesh(new THREE.TorusGeometry(n.r * 1.5, n.r * 0.008, 8, 120),
            new THREE.MeshBasicMaterial({ color: hue2, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false }));
          tor2.rotation.set(Math.PI / 2 + 0.9, -0.5, 0); rings.add(tor2);
          group.add(rings);
        }
        // hit sphere
        const hit = new THREE.Mesh(new THREE.SphereGeometry(n.r * 1.25, 12, 8), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
        hit.userData.nodeId = n.id; group.add(hit);
        this.nodeRoot.add(group);
        // label
        const lab = document.createElement("div");
        lab.style.cssText = "position:absolute;left:0;top:0;text-align:center;transform:translate(-50%,0);pointer-events:auto;cursor:pointer;user-select:none;transition:opacity .3s";
        lab.innerHTML = '<div data-l style="font:500 11px/1.2 var(--font-mono,monospace);letter-spacing:.14em;text-transform:uppercase;color:rgba(232,234,237,.85);text-shadow:0 0 8px rgba(0,0,0,.9)">' + n.label + (n.count != null ? ' <span style="padding:1px 6px;margin-left:4px;border-radius:99px;border:1px solid ' + HUES[n.state] + '66;color:' + HUES[n.state] + ';font-size:9px">' + n.count + "</span>" : "") + "</div>" +
          '<div style="font:400 9px/1.3 var(--font-mono,monospace);letter-spacing:.06em;color:rgba(232,234,237,.4);margin-top:2px">' + (n.sublabel || "") + "</div>";
        lab.addEventListener("click", () => this._select(n.id));
        this.labelLayer.appendChild(lab);
        const rec = { def: n, group: gal.parent, gal: galMat, shell: shellMat, coreS, halo, rings: n.r >= 7 ? rings : null, hit, base, label: lab, act: 0, actT: 0, pulseUntil: 0, phase: Math.random() * 6.28, isMoon, hueCss: HUES[n.state] };
        if (isMoon) {
          // Many siblings (a hot-lead/order parent can have dozens of moons,
          // not the handful this was originally tuned for) need to fan out
          // across concentric shells instead of one crowded ring — a fixed
          // angular step (the old idx*2.4) starts overlapping itself after
          // ~2.6 siblings since 2.4rad has no relation to the sibling count.
          // Each shell holds PER_RING moons evenly spaced around it; shells
          // stack outward at a radius wide enough that leaf spheres (r~5)
          // never overlap radially either.
          const PER_RING = 12;
          const siblings = data.nodes.filter((m) => m.parent === n.parent && m.parent !== "core");
          const idx = siblings.indexOf(n);
          const total = siblings.length;
          const ring = Math.floor(idx / PER_RING);
          const ringCount = Math.min(PER_RING, total - ring * PER_RING);
          const posInRing = idx % PER_RING;
          const angStep = (Math.PI * 2) / Math.max(1, ringCount);
          rec.orbit = {
            r: 0, ring,
            a: posInRing * angStep + ring * 0.9,
            sp: (RM ? 0.01 : 0.07 + (idx % 5) * 0.012) * (ring % 2 === 0 ? 1 : -1),
            tilt: 0.3 + (ring % 3) * 0.22,
          };
        }
        this.nodes.set(n.id, rec);
      });
      // moon orbit radii — each outer shell steps out by roughly a leaf
      // diameter plus margin so shells never intersect.
      this.nodes.forEach((rec) => { if (rec.orbit) { const p = this.nodes.get(rec.def.parent); rec.orbit.r = p.def.r * 2.7 + rec.def.r + 6 + rec.orbit.ring * (rec.def.r * 3.1 + 8); } });
      // links: parent links + extra
      const linkDefs = [];
      data.nodes.forEach((n) => { if (n.parent) linkDefs.push([n.id, n.parent, true]); });
      (data.links || []).forEach(([a, b]) => linkDefs.push([a, b, false]));
      const segs = 42, rad = 6;
      const lg = new this.THREE.BufferGeometry();
      const nV = (segs + 1) * rad, pos = new Float32Array(nV * 3), aT = new Float32Array(nV), aTh = new Float32Array(nV), idxArr = [];
      for (let i = 0; i <= segs; i++) for (let j = 0; j < rad; j++) { const k = i * rad + j; aT[k] = i / segs; aTh[k] = j * (Math.PI * 2 / rad); }
      for (let i = 0; i < segs; i++) for (let j = 0; j < rad; j++) {
        const a = i * rad + j, b = i * rad + ((j + 1) % rad), c = (i + 1) * rad + j, d = (i + 1) * rad + ((j + 1) % rad);
        idxArr.push(a, c, b, b, c, d);
      }
      lg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      lg.setAttribute("aT", new THREE.BufferAttribute(aT, 1)); lg.setAttribute("aTh", new THREE.BufferAttribute(aTh, 1));
      lg.setIndex(idxArr); lg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4000);
      this.linkGeo = lg;
      linkDefs.forEach(([a, b], i) => {
        const A = this.nodes.get(a), B = this.nodes.get(b); if (!A || !B) return;
        const hue = new THREE.Color(A.isMoon || A.def.state !== "idle" ? HUES[A.def.state] : HUES.live);
        const mat = new THREE.ShaderMaterial({ vertexShader: LINK_VERT, fragmentShader: LINK_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
          uniforms: { uP0: { value: new THREE.Vector3() }, uP1: { value: new THREE.Vector3() }, uP2: { value: new THREE.Vector3() }, uR: { value: 0.55 }, uHue: { value: hue }, uTime: { value: 0 }, uBoost: { value: 0 }, uSeed: { value: i * 0.37 } } });
        const mesh = new THREE.Mesh(lg, mat); mesh.frustumCulled = false;
        this.linkRoot.add(mesh);
        this.links.push({ a, b, mat, boost: 0 });
      });
      this._hitMeshes = [...this.nodes.values()].map((r) => r.hit);
    }

    /* ---------- input ---------- */
    _bindInput() {
      const el = this.canvas; const c = this.ctrl;
      let px = 0, py = 0, mode = 0; const touches = new Map(); let pinch0 = 0;
      el.style.touchAction = "none";
      el.addEventListener("pointerdown", (e) => {
        el.setPointerCapture(e.pointerId);
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (touches.size === 2) { const t = [...touches.values()]; pinch0 = Math.hypot(t[0].x - t[1].x, t[0].y - t[1].y); }
        px = e.clientX; py = e.clientY; mode = e.button === 2 || e.shiftKey ? 2 : 1;
        c.dragging = true; c.tween = null; c.idleSpin = false;
        this.dispatchEvent(new CustomEvent("user-interact"));
      });
      el.addEventListener("pointermove", (e) => {
        if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (touches.size === 2) {
          const t = [...touches.values()]; const d = Math.hypot(t[0].x - t[1].x, t[0].y - t[1].y);
          if (pinch0) { c.radius *= pinch0 / d; c.radius = Math.min(700, Math.max(55, c.radius)); }
          pinch0 = d; return;
        }
        if (!c.dragging) { this._updatePointer(e); return; }
        const dx = e.clientX - px, dy = e.clientY - py; px = e.clientX; py = e.clientY;
        if (mode === 1) { c.vT = -dx * 0.0045; c.vP = -dy * 0.0035; c.theta += c.vT; c.phi = Math.min(2.8, Math.max(0.35, c.phi + c.vP)); }
        else { this._pan(dx, dy); }
      });
      const up = (e) => { touches.delete(e.pointerId); if (touches.size < 2) pinch0 = 0; if (touches.size === 0) c.dragging = false; };
      el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
      el.addEventListener("wheel", (e) => { e.preventDefault(); c.tween = null; c.vR = Math.exp(e.deltaY * 0.0012); c.radius = Math.min(700, Math.max(55, c.radius * c.vR)); }, { passive: false });
      el.addEventListener("contextmenu", (e) => e.preventDefault());
      el.addEventListener("click", (e) => { if (Math.abs(e.clientX - px) < 4 && Math.abs(e.clientY - py) < 4) this._pick(e); });
    }
    _updatePointer(e) {
      const r = this.getBoundingClientRect();
      this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    }
    _pan(dx, dy) {
      const c = this.ctrl, cam = this.camera, THREE = this.THREE;
      const f = c.radius * 0.0012;
      const right = new THREE.Vector3().setFromMatrixColumn(cam.matrix, 0);
      const upv = new THREE.Vector3().setFromMatrixColumn(cam.matrix, 1);
      c.target.addScaledVector(right, -dx * f).addScaledVector(upv, dy * f);
    }
    _pick(e) {
      this._updatePointer(e);
      this.ray.setFromCamera(this.pointer, this.camera);
      const hits = this.ray.intersectObjects(this._hitMeshes || [], false);
      if (hits.length) this._select(hits[0].object.userData.nodeId);
      else this.dispatchEvent(new CustomEvent("space-click"));
    }
    _select(id) { this.dispatchEvent(new CustomEvent("node-select", { detail: { id } })); }
    setActive(id) { this.activeId = id; }
    pulseNode(id) { const r = this.nodes.get(id); if (r) r.pulseUntil = this._t + 2.2; }
    focusNode(id, dist) {
      const r = this.nodes.get(id); if (!r) return;
      const c = this.ctrl, w = new this.THREE.Vector3(); r.group.getWorldPosition(w);
      c.tween = { t0: this._t, dur: 1.5, fromT: c.target.clone(), toT: w, fromR: c.radius, toR: dist || Math.min(260, Math.max(95, r.def.r * 11)) };
    }
    resetView() { const c = this.ctrl; c.tween = { t0: this._t, dur: 1.6, fromT: c.target.clone(), toT: new this.THREE.Vector3(0, 4, 0), fromR: c.radius, toR: 300 }; c.idleSpin = true; }
    getScreenPos(id) {
      const r = this.nodes.get(id); if (!r || !this.camera) return null;
      const w = new this.THREE.Vector3(); r.group.getWorldPosition(w);
      const v = w.clone().project(this.camera);
      const W = this.clientWidth, H = this.clientHeight;
      const rp = (r.def.r / (w.distanceTo(this.camera.position))) * (H / 2) / Math.tan((this.camera.fov * Math.PI / 360));
      return { x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H, r: rp, behind: v.z > 1 };
    }
    getCamera() { const c = this.ctrl; return { az: ((c.theta * 180 / Math.PI) % 360 + 360) % 360, el: 90 - c.phi * 180 / Math.PI, dist: c.radius }; }
    getRadar() {
      const out = []; const c = this.ctrl;
      this.nodes.forEach((r, id) => {
        const w = new this.THREE.Vector3(); r.group.getWorldPosition(w);
        const dx = w.x - c.target.x, dz = w.z - c.target.z;
        const ang = Math.atan2(dx, dz) - c.theta;
        const d = Math.min(1, Math.hypot(dx, dz) / 130);
        out.push({ id, ang, d, hue: r.hueCss, active: id === this.activeId });
      });
      return out;
    }

    _applyCam() {
      const c = this.ctrl, cam = this.camera;
      const sp = Math.sin(c.phi), x = c.radius * sp * Math.sin(c.theta), y = c.radius * Math.cos(c.phi), z = c.radius * sp * Math.cos(c.theta);
      cam.position.set(c.target.x + x, c.target.y + y, c.target.z + z);
      cam.lookAt(c.target);
    }
    _frame() {
      const now = performance.now(); const dt = Math.min(0.05, (now - this._clock) / 1000); this._clock = now;
      this._t += dt; const t = this._t; const c = this.ctrl; const THREE = this.THREE;
      // camera physics
      if (c.tween) {
        const k = Math.min(1, (t - c.tween.t0) / c.tween.dur);
        const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        c.target.lerpVectors(c.tween.fromT, c.tween.toT, e);
        c.radius = c.tween.fromR + (c.tween.toR - c.tween.fromR) * e;
        if (k >= 1) c.tween = null;
      } else if (!c.dragging) {
        c.theta += c.vT; c.phi = Math.min(2.8, Math.max(0.35, c.phi + c.vP));
        c.vT *= 0.92; c.vP *= 0.92;
        if (c.idleSpin && !RM) c.theta += dt * 0.012;
      }
      this._applyCam();
      // hover raycast (throttled)
      if (!c.dragging && this._hitMeshes && (this._hoverTick = (this._hoverTick || 0) + 1) % 3 === 0) {
        this.ray.setFromCamera(this.pointer, this.camera);
        const hits = this.ray.intersectObjects(this._hitMeshes, false);
        const id = hits.length ? hits[0].object.userData.nodeId : null;
        if (id !== this.hoverId) { this.hoverId = id; this.canvas.style.cursor = id ? "pointer" : "grab"; this.dispatchEvent(new CustomEvent("node-hover", { detail: { id } })); }
      }
      // nodes
      const W = this.clientWidth, H = this.clientHeight;
      this.nodes.forEach((r, id) => {
        const g = r.group;
        if (r.orbit) {
          const p = this.nodes.get(r.def.parent);
          r.orbit.a += dt * r.orbit.sp;
          const o = r.orbit;
          const lx = Math.cos(o.a) * o.r, lz = Math.sin(o.a) * o.r, ly = Math.sin(o.a) * o.r * Math.sin(o.tilt) * 0.45;
          g.position.set(p.group.position.x + lx, p.group.position.y + ly + Math.sin(t * 0.5 + r.phase) * 0.8, p.group.position.z + lz);
        } else {
          g.position.y = r.base.y + (RM ? 0 : Math.sin(t * 0.45 + r.phase) * 1.6);
        }
        const targetAct = (id === this.activeId ? 1 : 0) + (id === this.hoverId ? 0.7 : 0) + (t < r.pulseUntil ? 0.8 : 0);
        r.act += (Math.min(1, targetAct) - r.act) * Math.min(1, dt * 6);
        r.gal.uniforms.uTime.value = t * (1 + r.act * 1.6);
        r.gal.uniforms.uActive.value = r.act;
        r.shell.uniforms.uActive.value = r.act; r.shell.uniforms.uTime.value = t;
        r.coreS.material.opacity = 0.4 + r.act * 0.5;
        r.halo.material.opacity = 0.08 + r.act * 0.3;
        if (r.rings && !RM) { r.rings.rotation.y = t * 0.25; r.rings.children[1].rotation.z = t * 0.18; r.rings.children[2].rotation.x = Math.PI / 2 + 0.9 + t * 0.1; }
        // label projection
        const w = new THREE.Vector3(); g.getWorldPosition(w); w.y -= r.def.r * 1.5;
        const v = w.project(this.camera);
        if (v.z > 1) { r.label.style.opacity = "0"; }
        else {
          const x = (v.x * 0.5 + 0.5) * W, y = (-v.y * 0.5 + 0.5) * H;
          const dist = g.getWorldPosition(new THREE.Vector3()).distanceTo(this.camera.position);
          const o = Math.max(0, Math.min(1, 1.6 - dist / 420));
          r.label.style.opacity = String(r.isMoon && dist > 300 ? 0 : 0.35 + o * 0.65);
          r.label.style.transform = "translate(-50%,0) translate(" + x.toFixed(1) + "px," + (y + 6).toFixed(1) + "px)";
          const dl = r.label.firstChild;
          dl.style.color = r.act > 0.5 ? r.hueCss : "rgba(232,234,237,.85)";
          dl.style.textShadow = r.act > 0.5 ? "0 0 12px " + r.hueCss : "0 0 8px rgba(0,0,0,.9)";
        }
      });
      // links
      const pa = new THREE.Vector3(), pb = new THREE.Vector3();
      this.links.forEach((L) => {
        const A = this.nodes.get(L.a), B = this.nodes.get(L.b);
        A.group.getWorldPosition(pa); B.group.getWorldPosition(pb);
        const u = L.mat.uniforms;
        // trim to sphere surfaces
        const dir = pb.clone().sub(pa).normalize();
        u.uP0.value.copy(pa).addScaledVector(dir, A.def.r * 1.02);
        u.uP2.value.copy(pb).addScaledVector(dir, -B.def.r * 1.02);
        u.uP1.value.lerpVectors(u.uP0.value, u.uP2.value, 0.5); u.uP1.value.y += pa.distanceTo(pb) * 0.14;
        u.uTime.value = t;
        const tgt = (L.a === this.activeId || L.b === this.activeId) ? 1 : (L.a === this.hoverId || L.b === this.hoverId) ? 0.6 : 0;
        L.boost += (tgt - L.boost) * Math.min(1, dt * 5);
        u.uBoost.value = L.boost;
      });
      // ambience
      this.starLayers.forEach((s, i) => { s.rotation.y = t * 0.0016 * (i + 1); });
      this.nebulae.forEach((s) => { const d = s.userData.drift; d.a += dt * d.sp * (RM ? 0 : 1); s.position.x = Math.cos(d.a) * d.r; s.position.z = Math.sin(d.a) * d.r; });
      if (this.dust) this.dust.rotation.y = t * 0.006;
      if (this.composer) this.composer.render(); else this.renderer.render(this.scene, this.camera);
    }
    disconnectedCallback() { cancelAnimationFrame(this._raf); if (this.ro) this.ro.disconnect(); if (this.renderer) this.renderer.dispose(); }
  }
  if (!customElements.get("jarvis-space")) customElements.define("jarvis-space", JarvisSpace);
})();
