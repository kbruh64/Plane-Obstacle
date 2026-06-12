// game.js — Three.js engine for COMET 88 plane dodger.
// Runs in the Electron renderer. Pure-math movement + AABB collision, strict
// disposal/pooling for the infinite map and obstacles. No physics libraries.

import * as THREE from 'three';
// The downloaded "DAE" assets are actually glTF (scene.gltf + scene.bin + PBR
// textures), so we load them with GLTFLoader — faster and texture-aware.
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// ----------------------------------------------------------------------------
// Tunables — all gameplay magic numbers live here.
// ----------------------------------------------------------------------------
const CFG = {
  // World scrolls toward -Z. The player sits near z=0; obstacles spawn far -Z.
  laneHalfWidth: 12,        // player X movement clamp (inside the corridor)
  ceiling: 9,               // player Y upper clamp
  floor: 1.0,               // player Y lower clamp
  baseSpeed: 70,            // world units / sec at speedMult = 1
  speedRampPerSec: 0.9,     // speed multiplier gain per second survived
  maxSpeedMult: 4.5,

  // Sci-fi "train" is a flat corridor section: scaled uniformly to this width,
  // then tiled at its natural depth (tunnelSegLength is computed at load).
  tunnelSegLength: 8,       // recomputed from the model's scaled Z depth
  tunnelWidth: 30,          // corridor width (X) the model is scaled to
  segmentsAhead: 60,        // many short corridor tiles -> long visible track
  segmentsBehind: 2,        // keep this many behind camera before recycling

  obstacleSpawnZGap: 44,    // distance between obstacle "rows" along Z
  obstacleSpawnFarZ: -820,  // where new obstacles enter
  obstacleCullZ: 40,        // obstacles past this (behind player) are recycled
  obstaclePoolSize: 40,
  obstacleSize: 5.5,        // target size of a concrete block obstacle

  planeSize: 12,            // target longest-dimension of the plane (bigger!)
  planeResponse: 9,         // how snappily the plane chases the input target
  planeBankAmount: 0.5,     // visual roll when steering

  // Laser
  laserChargeTime: 30,      // seconds to fully charge
  laserRange: 900,          // how far down -Z the beam reaches
  laserRadius: 3.5          // beam hit radius for destroying obstacles
};

// ----------------------------------------------------------------------------
// Renderer / scene / camera
// ----------------------------------------------------------------------------
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = false; // keep it lag-free; we fake lighting cheaply
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0e1a);
// Fog tinted to a cool steel so the tunnel fades into atmosphere, not a hard edge.
scene.fog = new THREE.Fog(0x121a2e, 120, 420); // hides the spawn/recycle boundary

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 1200);
camera.position.set(0, 7.5, 18); // closer chase cam so the plane reads larger
camera.lookAt(0, 6, -40);

// Lights — cheap, no shadow maps. Tuned softer so the light-grey tunnel panels
// don't blow out to pure white while the plane/blocks still read.
scene.add(new THREE.HemisphereLight(0x9fb8e0, 0x0c0f1a, 0.7));
const keyLight = new THREE.DirectionalLight(0xeaf2ff, 1.0);
keyLight.position.set(-30, 60, 60);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0x7fa8e0, 0.5);
fillLight.position.set(40, 20, 40);
scene.add(fillLight);
const rimLight = new THREE.DirectionalLight(0xff3366, 0.6);
rimLight.position.set(20, 10, -60);
scene.add(rimLight);

// Subtle env map for PBR reflections (low intensity so it doesn't over-brighten).
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.02).texture;
scene.environmentIntensity = 0.25;
// Lower exposure to tame the bright white tunnel panels -> moodier sci-fi look.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.72;

// ----------------------------------------------------------------------------
// Reusable scratch objects (avoid per-frame allocations -> avoid GC hitches).
// ----------------------------------------------------------------------------
const _planeBox = new THREE.Box3();
const _obsBox = new THREE.Box3();
const _tmpVec = new THREE.Vector3();

// ----------------------------------------------------------------------------
// Shared materials (created once, reused everywhere -> fewer draw-state changes)
// ----------------------------------------------------------------------------
const MAT = {
  floor:  new THREE.MeshStandardMaterial({ color: 0x0c1230, metalness: 0.2, roughness: 0.8 }),
  wall:   new THREE.MeshStandardMaterial({ color: 0x10162e, metalness: 0.35, roughness: 0.55, side: THREE.DoubleSide }),
  ceiling: new THREE.MeshStandardMaterial({ color: 0x080b16, metalness: 0.3, roughness: 0.7, side: THREE.DoubleSide }),
  neon:   new THREE.MeshBasicMaterial({ color: 0x29e0ff }),
  neonB:  new THREE.MeshBasicMaterial({ color: 0xff2e6e }),
  obstacle: new THREE.MeshStandardMaterial({ color: 0x33406b, metalness: 0.6, roughness: 0.35, emissive: 0x06204a, emissiveIntensity: 0.6 }),
  plane:  new THREE.MeshStandardMaterial({ color: 0xdfe9ff, metalness: 0.5, roughness: 0.4 }),
  planeAccent: new THREE.MeshStandardMaterial({ color: 0xff5a3c, metalness: 0.4, roughness: 0.5, emissive: 0x551400, emissiveIntensity: 0.5 })
};

const TUNNEL = { wallHeight: 16, halfWidth: 15 }; // enclosure dims (set at load)

// ============================================================================
//  TUNNEL MAP — the sci-fi "train" model is a flat corridor FLOOR section. Each
//  map segment = a clone of that floor model + procedurally-built side walls and
//  a dark ceiling, so the player flies through an enclosed neon tunnel. Segments
//  tile down -Z and recycle by repositioning (no alloc/dispose during play).
// ============================================================================
class TunnelFactory {
  // proto: the prepared floor model (spans CFG.tunnelSegLength along Z).
  static build(proto) {
    const g = new THREE.Group();
    const L = CFG.tunnelSegLength;
    const W = TUNNEL.halfWidth;
    const H = TUNNEL.wallHeight;

    // Floor: the real sci-fi model.
    g.add(proto.clone(true));

    // Side walls (planes facing inward), with neon trim strips.
    const wallGeo = new THREE.PlaneGeometry(L, H);
    const wl = new THREE.Mesh(wallGeo, MAT.wall);
    wl.rotation.y = Math.PI / 2; wl.position.set(-W, H / 2, -L / 2 + L / 2);
    const wr = new THREE.Mesh(wallGeo, MAT.wall);
    wr.rotation.y = -Math.PI / 2; wr.position.set(W, H / 2, 0);
    wl.position.z = 0;

    // Ceiling (dark, closes the tunnel).
    const ceilGeo = new THREE.PlaneGeometry(W * 2, L);
    const ceil = new THREE.Mesh(ceilGeo, MAT.ceiling);
    ceil.rotation.x = Math.PI / 2; ceil.position.y = H;

    // Neon trim strips running the length of each wall (alternating color).
    const stripGeo = new THREE.BoxGeometry(0.5, 0.5, L);
    const sl = new THREE.Mesh(stripGeo, MAT.neon); sl.position.set(-W + 0.4, 2.5, 0);
    const sr = new THREE.Mesh(stripGeo, MAT.neonB); sr.position.set(W - 0.4, 2.5, 0);
    const sl2 = new THREE.Mesh(stripGeo, MAT.neonB); sl2.position.set(-W + 0.4, H - 1, 0);
    const sr2 = new THREE.Mesh(stripGeo, MAT.neon); sr2.position.set(W - 0.4, H - 1, 0);

    g.add(wl, wr, ceil, sl, sr, sl2, sr2);
    g.userData.disposables = [wallGeo, ceilGeo, stripGeo];
    return g;
  }

  static dispose(seg) {
    if (seg.userData.disposables) for (const geo of seg.userData.disposables) geo.dispose();
  }
}

// ============================================================================
//  GAME
// ============================================================================
class Game {
  constructor() {
    this.state = 'loading'; // loading | start | playing | dead
    this.score = 0;
    this.best = Number(localStorage.getItem('comet88_best') || 0);
    this.speedMult = 1;
    this.worldZ = 0; // accumulated forward travel (segments tile off this)

    this.segments = [];
    this.obstaclePool = [];
    this.activeObstacles = [];

    this.input = { left: false, right: false, up: false, down: false };
    this.target = new THREE.Vector3(0, 6, 0);  // where the plane wants to be

    this.player = null;
    this.tunnelProto = null;   // sci-fi train tunnel, cloned per map segment
    this.blockProto = null;    // concrete blocks, cloned onto obstacles

    // Laser
    this.laserCharge = 0;      // 0..1 (1 = ready)
    this.laser = null;         // beam mesh
    this.laserFlash = 0;       // seconds remaining of visible beam

    this.clock = new THREE.Clock(false);
    this._raf = null;

    this.dom = {
      score: document.getElementById('score'),
      speed: document.getElementById('speed'),
      loading: document.getElementById('loading'),
      loadtext: document.getElementById('loadtext'),
      start: document.getElementById('start'),
      gameover: document.getElementById('gameover'),
      finalScore: document.getElementById('finalScore'),
      bestText: document.getElementById('bestText'),
      laserFill: document.getElementById('laserFill'),
      laserLabel: document.getElementById('laserLabel')
    };
  }

  async init() {
    // Assets must load first: the map is built from the tunnel model.
    await this.loadAssets();
    this.buildInitialMap();
    this.buildObstaclePool();
    this.buildLaser();
    this.bindEvents();
    this.toStart();
    this.loop(); // render loop runs in every state (menus get a live 3D backdrop)
  }

  // ---- Asset loading (glTF) with procedural fallbacks ----------------------
  async loadAssets() {
    const loader = new GLTFLoader();

    this.dom.loadtext.textContent = 'Loading COMET 88…';
    this.player = await this.loadGLTF(loader, './assets/comet88/scene.gltf')
      .then(model => this.preparePlane(model))
      .catch((err) => { console.warn('Plane load failed, using fallback:', err); return this.buildFallbackPlane(); });
    this.player.position.copy(this.target);
    scene.add(this.player);

    this.dom.loadtext.textContent = 'Loading sci-fi tunnel…';
    this.tunnelProto = await this.loadGLTF(loader, './assets/scifi_train/scene.gltf')
      .then(model => this.prepareTunnel(model))
      .catch((err) => { console.warn('Tunnel load failed, using fallback:', err); return this.buildFallbackTunnel(); });

    this.dom.loadtext.textContent = 'Loading concrete blocks…';
    this.blockProto = await this.loadGLTF(loader, './assets/concrete_blocks/scene.gltf')
      .then(model => this.prepareBlock(model))
      .catch((err) => { console.warn('Blocks load failed, using fallback:', err); return this.buildFallbackBlock(); });
  }

  loadGLTF(loader, url) {
    return new Promise((resolve, reject) => {
      loader.load(url, (gltf) => resolve(gltf.scene), undefined, reject);
    });
  }

  // Normalize a loaded glTF scene to a target size, centered, oriented forward.
  // Two-layer wrap keeps transforms independent and correct under scaling:
  //   wrap (scale + facing) -> inner (recenters raw model to origin) -> obj
  static normalize(obj, targetSize, faceForward) {
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const s = targetSize / maxDim;

    // Inner group: shift the raw model so its bbox center sits at the origin.
    const inner = new THREE.Group();
    inner.position.copy(center).multiplyScalar(-1);
    inner.add(obj);

    // Outer wrap: apply uniform scale + facing. Scaling here scales an already
    // centered child, so the model stays centered regardless of scale factor.
    const wrap = new THREE.Group();
    wrap.scale.setScalar(s);
    if (faceForward) wrap.rotation.y = Math.PI; // point nose toward -Z if needed
    wrap.add(inner);
    return wrap;
  }

  // Fit an object into a target bounding box (per-axis scale, capped by the
  // tightest axis so proportions are preserved but no dimension exceeds target).
  static fitToBox(obj, tx, ty, tz) {
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const s = Math.min(tx / (size.x || 1), ty / (size.y || 1), tz / (size.z || 1));

    const inner = new THREE.Group();
    inner.position.copy(center).multiplyScalar(-1);
    inner.add(obj);
    const wrap = new THREE.Group();
    wrap.scale.setScalar(s);
    wrap.add(inner);
    return wrap;
  }

  preparePlane(model) {
    // The Comet 88 glTF bundles two huge decorative "energy aura" spheres
    // (darksphere / thundersphere) that engulf the actual plane and blow up
    // the bounding box to a 38-unit cube. Strip them so the real plane scales
    // correctly and is clearly visible.
    const toRemove = [];
    model.traverse(o => {
      if (o.isMesh && /sphere/i.test(o.name)) toRemove.push(o);
    });
    for (const o of toRemove) {
      o.parent.remove(o);
      o.geometry.dispose();
    }
    const p = Game.normalize(model, CFG.planeSize, true);
    p.userData.fallback = false;
    return p;
  }
  // The sci-fi "train" model is a wide, flat corridor SECTION (~10 wide X,
  // ~1.6 tall Y, ~2 deep Z). It is NOT a hollow tube to stretch — doing so turns
  // its panels into giant slabs. Instead we scale it UNIFORMLY (preserving the
  // real geometry) so it spans the tunnel width, then tile copies along Z at the
  // model's own natural depth. CFG.tunnelSegLength is derived from that depth.
  prepareTunnel(model) {
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    // Uniform scale to reach the desired corridor width on X.
    const s = CFG.tunnelWidth / (size.x || 1);

    // Recenter on X/Z; rest the floor near y=0.
    const inner = new THREE.Group();
    inner.position.set(-center.x, -box.min.y, -center.z);
    inner.add(model);

    const wrap = new THREE.Group();
    wrap.scale.setScalar(s);
    wrap.add(inner);
    wrap.userData.fallback = false;

    // The natural tiling length is the model's scaled depth (Z). Store it so the
    // map tiles seamlessly with no stretching and no gaps.
    CFG.tunnelSegLength = size.z * s;
    // Enclosure: walls sit just outside the scaled floor's half-width.
    TUNNEL.halfWidth = (size.x * s) / 2 + 0.5;
    TUNNEL.wallHeight = 16;
    // Keep the player lane safely inside the walls.
    CFG.laneHalfWidth = TUNNEL.halfWidth - 3;
    CFG.ceiling = TUNNEL.wallHeight - 3;
    return wrap;
  }

  // The "concrete blocks" model is a PILE of ~10 separate blocks (~100+ units
  // overall). Using the whole pile as one obstacle made a floor-to-ceiling
  // monolith you couldn't dodge. Instead we extract the individual block
  // sub-groups (named AM115_045_NN_01) and keep them as separate prototypes,
  // each normalized to a small dodgeable size. obstacleProtos[] is chosen from
  // at random per spawn for variety.
  prepareBlock(model) {
    const blocks = [];
    // Top-level blocks are the children matching the AMxxx_NN_01 group naming.
    model.traverse(o => {
      if (/^AM\d+_\d+_\d+_\d+$/.test(o.name) && o.children.length && !o.userData._picked) {
        // Only take the outermost block groups (not nested material nodes).
        const isTopBlock = !o.parent || !/^AM\d+_\d+_\d+_\d+$/.test(o.parent.name);
        if (isTopBlock) { o.userData._picked = true; blocks.push(o); }
      }
    });

    this.obstacleProtos = [];
    const picks = blocks.length ? blocks : [model];
    for (const b of picks) {
      const holder = new THREE.Group();
      holder.add(b.clone(true));

      // Tame the material: these blocks ship very dark + glossy, which read as a
      // wet black slab under the env map. Force a matte concrete look.
      holder.traverse(o => {
        if (o.isMesh && o.material) {
          const m = Array.isArray(o.material) ? o.material : [o.material];
          for (const mm of m) {
            mm.metalness = 0.0;
            mm.roughness = 1.0;
            mm.envMapIntensity = 0.15;
            if (mm.color && mm.color.r < 0.25 && mm.color.g < 0.25 && mm.color.b < 0.25) {
              mm.color.setHex(0x8d8a85); // lift near-black concrete to grey
            }
          }
        }
      });

      // Fit into a compact, dodgeable box (per-axis), so the native tall-wall
      // proportions don't produce floor-to-ceiling slabs.
      const proto = Game.fitToBox(holder, CFG.obstacleSize, CFG.obstacleSize, CFG.obstacleSize);
      proto.userData.fallback = false;
      this.obstacleProtos.push(proto);
    }
    return this.obstacleProtos[0];
  }

  // ---- Procedural fallbacks (used if DAE files are absent) -----------------
  buildFallbackPlane() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.ConeGeometry(1.1, 6, 14), MAT.plane);
    body.rotation.x = -Math.PI / 2; // nose toward -Z
    const wing = new THREE.Mesh(new THREE.BoxGeometry(8, 0.3, 1.6), MAT.planeAccent);
    wing.position.z = 0.5;
    const tail = new THREE.Mesh(new THREE.BoxGeometry(3, 0.3, 1), MAT.planeAccent);
    tail.position.set(0, 0, 2.4);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.6, 1.4), MAT.planeAccent);
    fin.position.set(0, 0.8, 2.4);
    g.add(body, wing, tail, fin);
    g.userData.fallback = true;
    return g;
  }

  // Fallback tunnel: a simple framed box corridor spanning one segment.
  buildFallbackTunnel() {
    CFG.tunnelSegLength = 40; // fallback tiles at a fixed length
    const g = new THREE.Group();
    const W = CFG.tunnelWidth, H = 14, L = CFG.tunnelSegLength;
    const floorGeo = new THREE.PlaneGeometry(W, L, 4, 8); floorGeo.rotateX(-Math.PI/2);
    const floor = new THREE.Mesh(floorGeo, MAT.floor);
    const ceil = new THREE.Mesh(floorGeo, MAT.wall); ceil.position.y = H; ceil.rotation.x = Math.PI;
    const wallGeo = new THREE.PlaneGeometry(L, H, 8, 4);
    const wl = new THREE.Mesh(wallGeo, MAT.wall); wl.rotation.y = Math.PI/2; wl.position.set(-W/2, H/2, 0);
    const wr = new THREE.Mesh(wallGeo, MAT.wall); wr.rotation.y = -Math.PI/2; wr.position.set(W/2, H/2, 0);
    const stripGeo = new THREE.BoxGeometry(0.4, 0.4, L);
    const sl = new THREE.Mesh(stripGeo, MAT.neon); sl.position.set(-W/2+0.6, 3, 0);
    const sr = new THREE.Mesh(stripGeo, MAT.neonB); sr.position.set(W/2-0.6, 3, 0);
    g.add(floor, ceil, wl, wr, sl, sr);
    g.position.y = 0;
    g.userData.fallback = true;
    return g;
  }

  // Fallback concrete block: a chunky grey box cluster.
  buildFallbackBlock() {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x9a9690, roughness: 0.95, metalness: 0.05 });
    const a = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4), mat);
    const b = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 3), mat); b.position.set(2.5, -0.5, 1);
    const c = new THREE.Mesh(new THREE.BoxGeometry(2.5, 5, 2.5), mat); c.position.set(-2, 0.5, -1);
    g.add(a, b, c);
    g.userData.fallback = true;
    return g;
  }

  // ---- Map: tile the tunnel infinitely, recycle ---------------------------
  buildInitialMap() {
    for (let i = 0; i < CFG.segmentsAhead; i++) {
      const seg = TunnelFactory.build(this.tunnelProto);
      seg.position.z = -i * CFG.tunnelSegLength;
      scene.add(seg);
      this.segments.push(seg);
    }
  }

  // Advance the world: move segments toward +Z; recycle ones behind the camera.
  updateMap(dz) {
    const L = CFG.tunnelSegLength;
    let minZ = Infinity;
    for (const seg of this.segments) {
      seg.position.z += dz;
      if (seg.position.z < minZ) minZ = seg.position.z;
    }
    // Recycle any segment that passed behind the camera to the front of chain
    // (reposition only -> no alloc, no dispose, zero GC churn).
    const recycleZ = camera.position.z + CFG.segmentsBehind * L;
    for (const seg of this.segments) {
      if (seg.position.z - L > recycleZ) {
        minZ -= L;
        seg.position.z = minZ;
      }
    }
  }

  // Hard teardown — disposes cloned tunnel geometry (no leaks).
  destroyMap() {
    for (const seg of this.segments) {
      scene.remove(seg);
      seg.traverse(o => { if (o.isMesh && o.geometry) o.geometry.dispose(); });
    }
    this.segments.length = 0;
  }

  // ---- Obstacles: strict object pool --------------------------------------
  buildObstaclePool() {
    // Pool holds invisible placeholder Groups; the block mesh is attached lazily.
    for (let i = 0; i < CFG.obstaclePoolSize; i++) {
      const o = new THREE.Group();
      o.visible = false;
      o.userData.active = false;
      o.userData.hasMesh = false;
      scene.add(o);
      this.obstaclePool.push(o);
    }
  }

  acquireObstacle() {
    for (const o of this.obstaclePool) {
      if (!o.userData.active) return o;
    }
    return null; // pool exhausted -> skip spawn (keeps frame budget bounded)
  }

  // Attach a clone of a random concrete-block prototype the first time used.
  ensureObstacleMesh(o) {
    if (o.userData.hasMesh) return;
    const protos = (this.obstacleProtos && this.obstacleProtos.length)
      ? this.obstacleProtos : (this.blockProto ? [this.blockProto] : null);
    if (!protos) return;
    o.add(protos[Math.floor(Math.random() * protos.length)].clone(true));
    o.userData.hasMesh = true;
  }

  spawnObstacleRow(z) {
    // Up to 3 blocks per row across the tunnel width, always leaving a gap.
    const span = CFG.laneHalfWidth;
    const slots = [-span * 0.66, 0, span * 0.66];
    const openIndex = Math.floor(Math.random() * slots.length);
    for (let i = 0; i < slots.length; i++) {
      if (i === openIndex) continue;
      if (Math.random() < 0.4) continue; // sparsity
      const o = this.acquireObstacle();
      if (!o) break;
      this.ensureObstacleMesh(o);
      o.userData.active = true;
      o.visible = true;
      // Airborne spawning: ~45% of blocks aim at the player's current altitude
      // (they come AT you), the rest scatter across the full flyable height.
      let y;
      if (Math.random() < 0.45 && this.player) {
        y = this.player.position.y + (Math.random() * 2 - 1);
      } else {
        y = CFG.floor + 2 + Math.random() * (CFG.ceiling - CFG.floor - 2);
      }
      y = THREE.MathUtils.clamp(y, CFG.floor + 2, CFG.ceiling);
      o.position.set(slots[i] + (Math.random() * 4 - 2), y, z);
      o.rotation.set(Math.random() * 0.5, Math.random() * Math.PI, Math.random() * 0.5);
      o.userData.spin = (Math.random() - 0.5) * 0.6;
      o.userData.baseY = y;
      o.userData.bobPhase = Math.random() * Math.PI * 2;
      this.activeObstacles.push(o);
    }
  }

  releaseObstacle(o) {
    o.userData.active = false;
    o.visible = false;
    o.position.z = 9999; // park it far away
  }

  updateObstacles(dz, dt) {
    // Spawn cadence based on traveled distance.
    this._spawnAccum = (this._spawnAccum || 0) + dz;
    if (this._spawnAccum >= CFG.obstacleSpawnZGap) {
      this._spawnAccum = 0;
      this.spawnObstacleRow(CFG.obstacleSpawnFarZ);
    }

    const t = performance.now() * 0.001;
    for (let i = this.activeObstacles.length - 1; i >= 0; i--) {
      const o = this.activeObstacles[i];
      // Blocks close in slightly faster than the world scroll, so they fly AT
      // you rather than drifting with the scenery.
      o.position.z += dz * 1.18;
      o.rotation.y += o.userData.spin * dt;
      // Gentle float/bob so they read as airborne, not parked on the floor.
      o.position.y = o.userData.baseY + Math.sin(t * 1.4 + o.userData.bobPhase) * 0.7;
      if (o.position.z > CFG.obstacleCullZ) {
        this.releaseObstacle(o);
        this.activeObstacles.splice(i, 1);
      }
    }
  }

  // ---- Laser --------------------------------------------------------------
  // A forward beam mesh parented to the plane; charges over laserChargeTime,
  // fired with Space, destroys every obstacle in a cylinder ahead of the plane.
  buildLaser() {
    const geo = new THREE.CylinderGeometry(CFG.laserRadius * 0.5, CFG.laserRadius * 0.25, CFG.laserRange, 12, 1, true);
    geo.rotateX(-Math.PI / 2);            // align cylinder along -Z
    geo.translate(0, 0, -CFG.laserRange / 2); // start at plane, extend forward
    const mat = new THREE.MeshBasicMaterial({
      color: 0x66faff, transparent: true, opacity: 0.0,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
    });
    this.laser = new THREE.Mesh(geo, mat);
    this.laser.renderOrder = 999;
    scene.add(this.laser);
  }

  fireLaser() {
    if (this.state !== 'playing' || this.laserCharge < 1) return;
    this.laserCharge = 0;
    this.laserFlash = 0.18; // seconds the beam stays visible

    // Destroy every active obstacle within the beam radius (X/Y) ahead of plane.
    const px = this.player.position.x, py = this.player.position.y;
    for (let i = this.activeObstacles.length - 1; i >= 0; i--) {
      const o = this.activeObstacles[i];
      if (o.position.z > 5) continue; // only what's ahead
      const dx = o.position.x - px, dy = o.position.y - py;
      if (dx * dx + dy * dy <= (CFG.laserRadius + 3) * (CFG.laserRadius + 3)) {
        this.releaseObstacle(o);
        this.activeObstacles.splice(i, 1);
        this.score += 5; // small reward for vaporizing a block
      }
    }
  }

  updateLaser(dt) {
    // Charge toward ready.
    if (this.laserCharge < 1) {
      this.laserCharge = Math.min(1, this.laserCharge + dt / CFG.laserChargeTime);
    }
    // Position the beam at the plane, pointing forward.
    this.laser.position.copy(this.player.position);
    // Fade the visible flash.
    if (this.laserFlash > 0) {
      this.laserFlash -= dt;
      this.laser.material.opacity = Math.max(0, this.laserFlash / 0.18) * 0.8;
    } else {
      this.laser.material.opacity = 0;
    }

    // Update HUD charge meter.
    const pct = Math.floor(this.laserCharge * 100);
    if (this.dom.laserFill) this.dom.laserFill.style.width = pct + '%';
    if (this.dom.laserLabel) {
      this.dom.laserLabel.textContent = this.laserCharge >= 1 ? 'LASER READY — SPACE' : 'LASER ' + pct + '%';
      this.dom.laserLabel.classList.toggle('ready', this.laserCharge >= 1);
    }
  }

  // ---- Player movement (pure vector math, framerate-independent) -----------
  updatePlayer(dt) {
    // Build target from keyboard input.
    const speed = 26 * dt;
    if (this.input.left)  this.target.x -= speed;
    if (this.input.right) this.target.x += speed;
    if (this.input.up)    this.target.y += speed;
    if (this.input.down)  this.target.y -= speed;
    // Clamp target to the playfield.
    this.target.x = THREE.MathUtils.clamp(this.target.x, -CFG.laneHalfWidth, CFG.laneHalfWidth);
    this.target.y = THREE.MathUtils.clamp(this.target.y, CFG.floor, CFG.ceiling);

    // Smooth critically-damped-ish chase toward target.
    const k = 1 - Math.exp(-CFG.planeResponse * dt);
    const prevX = this.player.position.x;
    this.player.position.x += (this.target.x - this.player.position.x) * k;
    this.player.position.y += (this.target.y - this.player.position.y) * k;
    this.player.position.z = 0;

    // Bank/pitch the model based on velocity for juice.
    const vx = this.player.position.x - prevX;
    this.player.rotation.z = THREE.MathUtils.lerp(this.player.rotation.z, -vx * CFG.planeBankAmount * 6, 0.2);
    this.player.rotation.x = THREE.MathUtils.lerp(this.player.rotation.x, (this.target.y - this.player.position.y) * -0.05, 0.2);

    // Camera gently follows the plane on X for a chase feel.
    camera.position.x += (this.player.position.x * 0.35 - camera.position.x) * (1 - Math.exp(-4 * dt));
    camera.lookAt(this.player.position.x * 0.3, this.player.position.y, -40);
  }

  // ---- AABB collision via THREE.Box3 --------------------------------------
  checkCollisions() {
    if (this.invincible) return; // dev screenshot mode
    _planeBox.setFromObject(this.player);
    // Shrink the plane box a touch so clipping a wingtip feels fair.
    _planeBox.expandByScalar(-0.6);

    for (const o of this.activeObstacles) {
      // Only test obstacles near the player plane in Z (cheap broad-phase).
      if (o.position.z < -12 || o.position.z > 12) continue;
      _obsBox.setFromObject(o);
      if (_planeBox.intersectsBox(_obsBox)) {
        this.gameOver();
        return;
      }
    }
  }

  // ---- State transitions ---------------------------------------------------
  toStart() {
    this.state = 'start';
    this.dom.loading.classList.add('hidden');
    this.dom.gameover.classList.add('hidden');
    this.dom.start.classList.remove('hidden');
  }

  startRun() {
    if (this.state === 'playing') return;
    // Reset run state.
    this.score = 0;
    this.speedMult = 1;
    this._spawnAccum = 0;
    this.laserCharge = 0;
    this.laserFlash = 0;
    this.target.set(0, 6, 0);
    if (this.player) this.player.position.set(0, 6, 0);

    // Clear any leftover obstacles.
    for (const o of this.activeObstacles) this.releaseObstacle(o);
    this.activeObstacles.length = 0;

    this.dom.start.classList.add('hidden');
    this.dom.gameover.classList.add('hidden');
    this.clock.start();
    this.state = 'playing';
  }

  gameOver() {
    this.state = 'dead';
    this.clock.stop();
    const final = Math.floor(this.score);
    if (final > this.best) {
      this.best = final;
      localStorage.setItem('comet88_best', String(this.best));
    }
    this.dom.finalScore.textContent = final;
    this.dom.bestText.textContent = 'Best: ' + this.best;
    this.dom.gameover.classList.remove('hidden');
  }

  // ---- Main loop -----------------------------------------------------------
  loop() {
    this._raf = requestAnimationFrame(() => this.loop());
    const dt = Math.min(this.clock ? this.clock.getDelta() : 0.016, 0.05); // clamp big spikes

    if (this.state === 'playing') {
      // Ramp speed over time.
      this.speedMult = Math.min(CFG.maxSpeedMult, this.speedMult + CFG.speedRampPerSec * dt * 0.12);
      const dz = CFG.baseSpeed * this.speedMult * dt; // forward travel this frame

      this.updateMap(dz);
      this.updateObstacles(dz, dt);
      this.updatePlayer(dt);
      this.updateLaser(dt);
      this.checkCollisions();

      this.score += dt * 10 * this.speedMult;
      this.dom.score.textContent = Math.floor(this.score);
      this.dom.speed.textContent = this.speedMult.toFixed(1) + 'x';
    } else if (this.player) {
      // Idle hover animation on menus.
      const t = performance.now() * 0.001;
      this.player.position.y = 6 + Math.sin(t * 1.5) * 0.4;
      this.player.rotation.z = Math.sin(t) * 0.08;
      camera.lookAt(0, 6, -40);
    }

    renderer.render(scene, camera);
  }

  // ---- Input ---------------------------------------------------------------
  bindEvents() {
    window.addEventListener('resize', () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    });

    const keymap = {
      ArrowLeft: 'left', KeyA: 'left',
      ArrowRight: 'right', KeyD: 'right',
      ArrowUp: 'up', KeyW: 'up',
      ArrowDown: 'down', KeyS: 'down'
    };

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (keymap[e.code]) { this.input[keymap[e.code]] = true; e.preventDefault(); }
      if (e.code === 'Space') {
        // In game -> fire laser. On a menu -> start / restart the run.
        if (this.state === 'playing') this.fireLaser();
        else this.handleAdvance();
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (keymap[e.code]) { this.input[keymap[e.code]] = false; e.preventDefault(); }
    });

    // Mouse only starts/restarts from menus — it does not steer the plane.
    window.addEventListener('mousedown', () => this.handleAdvance());
  }

  // Click/Space advances from menus into a run.
  handleAdvance() {
    if (this.state === 'start' || this.state === 'dead') this.startRun();
  }
}

// ----------------------------------------------------------------------------
// Boot
// ----------------------------------------------------------------------------
const game = new Game();
game.init();

// Dev-only: when ?shot is in the URL, auto-start a run (invincible) for capture.
if (location.search.includes('shot')) {
  game.invincible = true;
  const tryStart = () => { if (game.state === 'start') game.startRun(); else setTimeout(tryStart, 200); };
  setTimeout(tryStart, 1500);
}
