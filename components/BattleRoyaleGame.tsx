'use client';

import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import {
  powerAt,
  shotDamage,
  blastShare,
  calculateXpProgression,
  calculateShieldRegen,
  calculateStructureDamage,
  calculateVoxelImpulse,
  isCoverBlocked,
  segmentIntersectsBox,
  LEVEL_COST,
  MAX_LEVEL,
} from '@/lib/game-math';

export default function BattleRoyaleGame() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Fast check for headless / test environment
    const isHeadless =
      typeof navigator !== 'undefined' &&
      (navigator.webdriver || /HeadlessChrome/i.test(navigator.userAgent));

    const $ = (id: string) => document.getElementById(id);
    const overlay = $('overlay');
    const btn = $('btn');
    const menuEl = $('menu');
    const playBtn = $('play');
    const ammoEl = $('ammo');
    const statusEl = $('status');
    const downsEl = $('downs');
    const hitmark = $('hitmark');
    const stickBase = $('stick');
    const stickKnob = $('knob');
    const aimBtn = $('aim');
    const slotEls = [$('slot0'), $('slot1')];
    const slotNameEls = [$('slotName0'), $('slotName1')];
    const weaponEl = $('weapon');
    const magEl = $('mag');
    const reserveEl = $('reserve');
    const scopeEl = $('scope');
    const fireModeAutoEl = $('fireModeAuto');
    const fireModeManualEl = $('fireModeManual');
    let fireMode: 'auto' | 'manual' = 'auto';

    function setFireMode(mode: 'auto' | 'manual') {
      fireMode = mode;
      fireModeAutoEl?.classList.toggle('active', mode === 'auto');
      fireModeManualEl?.classList.toggle('active', mode === 'manual');
      if (mode === 'manual') {
        showMessage('Manual: Fire with AIM button (even without enemy)', 2.0);
      } else {
        showMessage('Auto: Weapon fires when enemy in front', 2.0);
      }
    }

    fireModeAutoEl?.addEventListener('click', (e) => {
      e.stopPropagation();
      setFireMode('auto');
    });
    fireModeManualEl?.addEventListener('click', (e) => {
      e.stopPropagation();
      setFireMode('manual');
    });
    const sliderEl = $('slider');
    const sliderKnobEl = $('sliderKnob');
    const pickBtn = $('pick');
    const pickNameEl = $('pickName');
    const shieldRow = $('shieldRow');
    const shieldFill = $('shieldFill');
    const lifeFill = $('lifeFill');
    const shieldNumEl = $('shieldNum');
    const lifeNumEl = $('lifeNum');
    const pipEls = Array.from(document.querySelectorAll('.pips i'));
    const shieldFx = $('shieldFx');
    const hurtFx = $('hurtFx');
    const downedEl = $('downed');
    const downedTimerEl = $('downedTimer');
    const creditsEl = $('credits');

    // Touch device detection
    const touchDevice =
      typeof navigator !== 'undefined' &&
      (navigator.maxTouchPoints > 0 || window.matchMedia('(pointer: coarse)').matches);
    document.body.classList.toggle('touch', touchDevice);

    // ----------------------------------------------------
    // Renderer, scene, camera
    // ----------------------------------------------------
    const FIELD = 3;
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: !isHeadless,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(isHeadless ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = !isHeadless;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x9cc7e8);
    scene.fog = new THREE.Fog(0x9cc7e8, 60 * FIELD, 220 * FIELD);

    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 400 * FIELD);
    camera.rotation.order = 'YXZ';
    scene.add(camera);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x3f5a34, 2.0));
    const sun = new THREE.DirectionalLight(0xffffff, 3.0);
    const SUN_OFFSET = new THREE.Vector3(40, 60, 25);
    sun.position.copy(SUN_OFFSET);
    if (!isHeadless) {
      sun.castShadow = true;
      sun.shadow.mapSize.set(1024, 1024);
      sun.shadow.bias = -0.0004;
      Object.assign(sun.shadow.camera, { left: -70, right: 70, top: 70, bottom: -70, far: 200 });
      sun.shadow.camera.updateProjectionMatrix();
    }
    scene.add(sun);

    function followSun() {
      sun.target.position.set(camera.position.x, groundAt(camera.position.x, camera.position.z), camera.position.z);
      sun.target.updateMatrixWorld();
      sun.position.set(camera.position.x + SUN_OFFSET.x, SUN_OFFSET.y, camera.position.z + SUN_OFFSET.z);
    }

    // ----------------------------------------------------
    // Training Range Pool
    // ----------------------------------------------------
    const WATER_Y = -0.25;
    const POOL = { x0: -44, x1: -26, z0: -14, z1: -2, floor: -2.4, ramp: 7 };
    const POOL_END = POOL.x1 + POOL.ramp;

    function poolFloorAt(x: number, z: number) {
      const { x0, x1, z0, z1, floor, ramp } = POOL;
      if (z < z0 || z > z1) return 0;
      if (x >= x0 && x <= x1) return floor;
      if (x > x1 && x < x1 + ramp) return floor * (1 - (x - x1) / ramp);
      return 0;
    }

    function nearPool(x: number, z: number, pad = 0) {
      return x >= POOL.x0 - pad && x <= POOL_END + pad && z >= POOL.z0 - pad && z <= POOL.z1 + pad;
    }

    function groundWithPool() {
      const H = 200 * FIELD;
      const s = new THREE.Shape();
      s.moveTo(-H, -H);
      s.lineTo(H, -H);
      s.lineTo(H, H);
      s.lineTo(-H, H);
      s.closePath();
      const hole = new THREE.Path();
      const { x0, z0, z1 } = POOL;
      hole.moveTo(x0, -z0);
      hole.lineTo(POOL_END, -z0);
      hole.lineTo(POOL_END, -z1);
      hole.lineTo(x0, -z1);
      hole.closePath();
      s.holes.push(hole);
      return new THREE.ShapeGeometry(s);
    }

    function buildPool() {
      const { x0, x1, z0, z1, floor } = POOL;
      const pos: number[] = [];
      const idx: number[] = [];
      const quad = (a: number[], b: number[], c: number[], d: number[]) => {
        const k = pos.length / 3;
        pos.push(...a, ...b, ...c, ...d);
        idx.push(k, k + 1, k + 2, k, k + 2, k + 3);
      };
      const tri = (a: number[], b: number[], c: number[]) => {
        const k = pos.length / 3;
        pos.push(...a, ...b, ...c);
        idx.push(k, k + 1, k + 2);
      };
      quad([x0, floor, z0], [x1, floor, z0], [x1, floor, z1], [x0, floor, z1]);
      quad([x0, floor, z0], [x0, floor, z1], [x0, 0, z1], [x0, 0, z0]);
      quad([x0, floor, z0], [x1, floor, z0], [x1, 0, z0], [x0, 0, z0]);
      quad([x0, floor, z1], [x1, floor, z1], [x1, 0, z1], [x0, 0, z1]);
      quad([x1, floor, z0], [POOL_END, 0, z0], [POOL_END, 0, z1], [x1, floor, z1]);
      tri([x1, floor, z0], [POOL_END, 0, z0], [x1, 0, z0]);
      tri([x1, floor, z1], [x1, 0, z1], [POOL_END, 0, z1]);

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const basin = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x9cc3cf, side: THREE.DoubleSide }));
      basin.receiveShadow = true;

      const water = new THREE.Mesh(
        new THREE.PlaneGeometry(POOL_END - x0, z1 - z0),
        new THREE.MeshLambertMaterial({ color: 0x1d6e9c, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide })
      );
      water.rotation.x = -Math.PI / 2;
      water.position.set((x0 + POOL_END) / 2, WATER_Y, (z0 + z1) / 2);

      const group = new THREE.Group();
      group.add(basin, water);
      return group;
    }

    const ground = new THREE.Mesh(groundWithPool(), new THREE.MeshLambertMaterial({ color: 0x6f9a57 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    const grid = new THREE.GridHelper(400 * FIELD, 80 * FIELD, 0x3b5a2f, 0x3b5a2f);
    grid.position.y = 0.05;
    if (grid.material instanceof THREE.Material) {
      grid.material.transparent = true;
      grid.material.opacity = 0.2;
    }
    scene.add(grid);

    const world = new THREE.Group();
    scene.add(world);
    world.add(buildPool());

    // ----------------------------------------------------
    // Terrain: Harbor Mode
    // ----------------------------------------------------
    let terrainOn = false;
    let terrainSeed = 1;
    let HARBOR_SPAWN = { x: 0, z: 0 }; // harbor: beach spawn beside the quay (set by planHarbor)
    const PORT_SEARCH = { x: 0, z: 0 }; // where the coast scan starts (map centre)
    const RANGE_SPAWN = { x: 0, z: 14 };
    let spawn = RANGE_SPAWN;

    function hash2(i: number, j: number, s: number) {
      let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(s, 1442695041);
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    }

    function gradNoise(x: number, z: number, s: number) {
      const ix = Math.floor(x);
      const iz = Math.floor(z);
      const fx = x - ix;
      const fz = z - iz;
      const grad = (i: number, j: number, dx: number, dz: number) => {
        const a = hash2(i, j, s) * Math.PI * 2;
        return Math.cos(a) * dx + Math.sin(a) * dz;
      };
      const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
      const v = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
      const a = grad(ix, iz, fx, fz);
      const b = grad(ix + 1, iz, fx - 1, fz);
      const c = grad(ix, iz + 1, fx, fz - 1);
      const d = grad(ix + 1, iz + 1, fx - 1, fz - 1);
      const lo = a + (b - a) * u;
      const hi = c + (d - c) * u;
      return lo + (hi - lo) * v;
    }

    function fbm(x: number, z: number, s: number) {
      return fbmOct(x, z, s, 4);
    }

    function fbmOct(x: number, z: number, s: number, oct: number) {
      let sum = 0;
      let amp = 1;
      let norm = 0;
      let fq = 1;
      for (let o = 0; o < oct; o++) {
        sum += amp * gradNoise(x * fq, z * fq, s + o * 31);
        norm += amp;
        amp *= 0.5;
        fq *= 2.03;
      }
      return sum / norm;
    }

    // ----------------------------------------------------
    // Biomes. Two slow noise fields partition the map into
    // five biomes: bf ("biome field") decides the big land
    // bands — ridged mountain ranges where it bulges, lake
    // basins where it dips — and mf (moisture) splits the
    // remaining land: wet lowlands become jungle, moderate
    // bands become forest, dry bands stay open grassland.
    // The five weights always sum to 1 so height, tile
    // coloring and vegetation placement all agree.
    // ----------------------------------------------------
    interface BiomeW {
      mw: number; // mountain
      lw: number; // lake
      jw: number; // jungle
      fw: number; // forest
      gw: number; // grassland
    }
    const BIO_SPAN = 430;
    const MOIST_SPAN = 310;
    function biomeWeights(x: number, z: number, out: BiomeW) {
      const bf = fbmOct(x / BIO_SPAN, z / BIO_SPAN, terrainSeed + 900, 3);
      const mf = fbmOct(x / MOIST_SPAN, z / MOIST_SPAN, terrainSeed + 1300, 2);
      // fbm stays within roughly +/-0.4, so the windows sit inside that
      // range: mountains own ~14% of the map, lake basins ~10%.
      const mw = THREE.MathUtils.smoothstep(bf, 0.12, 0.26);
      const lw = THREE.MathUtils.smoothstep(-bf, 0.12, 0.24);
      const rest = Math.max(0, 1 - mw - lw);
      const wet = THREE.MathUtils.smoothstep(mf, 0.1, 0.3); // jungle
      const forested = THREE.MathUtils.smoothstep(mf, -0.06, 0.14); // forest
      out.mw = mw;
      out.lw = lw;
      out.jw = rest * wet;
      out.fw = rest * (1 - wet) * forested;
      out.gw = rest * (1 - wet) * (1 - forested);
    }
    const BW: BiomeW = { mw: 0, lw: 0, jw: 0, fw: 0, gw: 0 }; // terrainHeight scratch
    const CW: BiomeW = { mw: 0, lw: 0, jw: 0, fw: 0, gw: 0 }; // tile color scratch
    const VW: BiomeW = { mw: 0, lw: 0, jw: 0, fw: 0, gw: 0 }; // vegetation scratch

    const TERRAIN_HEIGHT = 30;
    const TERRAIN_SPAN = 130;
    const TERRAIN_LIFT = 11;
    const TILE = 125;
    const TILE_CELLS = 25;
    const TILE_STEP = TILE / TILE_CELLS;
    const LOAD_R = 780;
    const TILE_BUILDS = 3;
    const TERRAIN_MARGIN = 7 * TILE;
    const HARBOR_HALF = 2000;
    const SEA_SPAN = 420;
    const SEA_WARP = 420;
    const SEA_DEPTH = 14;
    const SEA_C = HARBOR_HALF * (2 - Math.SQRT2);
    const BEACH_Y = WATER_Y + 0.7;

    // ----------------------------------------------------
    // Procedural POI generator — terrain flattening zones.
    // Each POI registers a pad: inside r-10 the terrain is
    // pinned to the POI's base height (sampled from the raw
    // FBM before the zone exists), then eases back to the
    // natural landscape within +22 m. Structures always sit
    // flush with the ground because both the streamed tiles
    // and groundAt() consult the same list.
    // ----------------------------------------------------
    interface PoiZone {
      x: number;
      z: number;
      r: number;
      baseY: number;
    }
    const flatZones: PoiZone[] = [];

    // ----------------------------------------------------
    // Transition routes: a seeded road network that stitches every
    // POI (and the port gate) together with dust trails, mud tracks
    // and gravel roads. Rendered as terrain-vertex colour overrides
    // (never underwater), painted onto the tactical-map canvas, and
    // kept clear of vegetation so they read as real corridors.
    // ----------------------------------------------------
    interface PathSeg {
      pts: number[]; // flat x,z polyline, resampled every ~8 m
      w: number;
      kind: number; // 0 dust · 1 mud · 2 gravel road
    }
    const paths: PathSeg[] = [];
    const PATH_CELL = 48;
    const pathGrid = new Map<string, number[]>(); // cell -> sample indices
    const pathSamples: number[] = []; // flat x,z of every ~8 m sample
    const pathMeta: Array<{ w: number; kind: number }> = [];
    const PATH_COLORS = [new THREE.Color(0xc2ab7a), new THREE.Color(0x6e5e43), new THREE.Color(0x9c9384)];
    const PATH_KIND_CSS = ['#cdb98a', '#7d6c4d', '#aaa393'];

    function registerPathSample(x: number, z: number, w: number, kind: number) {
      pathSamples.push(x, z);
      pathMeta.push({ w, kind });
      const key = Math.floor(x / PATH_CELL) + ',' + Math.floor(z / PATH_CELL);
      let arr = pathGrid.get(key);
      if (!arr) {
        arr = [];
        pathGrid.set(key, arr);
      }
      arr.push(pathMeta.length - 1);
    }

    // Nearest-route lookup for tile painting + vegetation exclusion.
    // Samples sit every ~8 m, so point distance is a good proxy for
    // distance-to-centreline at road widths of 4-7 m.
    function nearPath(x: number, z: number): { d: number; w: number; kind: number } | null {
      if (!pathGrid.size) return null;
      const cx = Math.floor(x / PATH_CELL);
      const cz = Math.floor(z / PATH_CELL);
      let best = -1;
      let bestD = Infinity;
      for (let gz = cz - 1; gz <= cz + 1; gz++) {
        for (let gx = cx - 1; gx <= cx + 1; gx++) {
          const arr = pathGrid.get(gx + ',' + gz);
          if (!arr) continue;
          for (const idx of arr) {
            const dx = pathSamples[idx * 2] - x;
            const dz = pathSamples[idx * 2 + 1] - z;
            const d = dx * dx + dz * dz;
            if (d < bestD) {
              bestD = d;
              best = idx;
            }
          }
        }
      }
      if (best < 0) return null;
      return { d: Math.sqrt(bestD), w: pathMeta[best].w, kind: pathMeta[best].kind };
    }

    function seaDist(x: number, z: number) {
      const base = (x + z - SEA_C) / Math.SQRT2;
      if (base < -(SEA_WARP + 200) || base > SEA_WARP + 300) return base;
      return base + SEA_WARP * fbm(x / SEA_SPAN, z / SEA_SPAN, terrainSeed + 500);
    }

    const MOUNT_LIFT = 26; // pedestal the ridges stand on
    const MOUNT_PEAK = 62; // crest height above the pedestal
    const LAKE_DEPTH = 6.2; // lake beds sink this far below WATER_Y

    function terrainHeight(x: number, z: number) {
      const keep = THREE.MathUtils.smoothstep(Math.hypot(x - HARBOR_SPAWN.x, z - HARBOR_SPAWN.z), 8, 60);
      biomeWeights(x, z, BW);
      // Base rolling land — rougher than before, plus a fine detail
      // octave so the ground reads craggy up close.
      let raw =
        TERRAIN_LIFT +
        TERRAIN_HEIGHT * fbm(x / TERRAIN_SPAN, z / TERRAIN_SPAN, terrainSeed) +
        1.9 * gradNoise(x / 27, z / 27, terrainSeed + 55);
      raw *= 1 - 0.32 * BW.jw; // jungle basins settle into flat lowland
      if (BW.mw > 0.002) {
        // Ridged ranges: crests follow the noise's zero-crossings,
        // squared so the peaks stand out sharply from the valleys.
        const ridge = Math.max(0, 1 - 1.45 * Math.abs(fbm(x / 92, z / 92, terrainSeed + 77)));
        raw += BW.mw * (MOUNT_LIFT + MOUNT_PEAK * ridge * ridge);
      }
      let land = keep * Math.max(0.3, raw);
      const lwe = BW.lw * keep; // lakes never swallow the spawn pad
      if (lwe > 0.002) land += (WATER_Y - LAKE_DEPTH * (1 + 0.5 * BW.jw) - land) * lwe;
      const d = seaDist(x, z);
      const inland = THREE.MathUtils.smoothstep(-d, 10, 110);
      const shore = land * inland + BEACH_Y * (1 - inland);
      const bed = WATER_Y - SEA_DEPTH * THREE.MathUtils.smoothstep(d, 0, 200);
      let h = shore + (bed - shore) * THREE.MathUtils.smoothstep(d, -10, 10);
      // Flatten pads LAST so terminal aprons can override the shore/sea
      // blending — the raised port deck stands proud of the beach, and
      // inland POI pads keep their exact same result (inland == 1 there).
      for (const f of flatZones) {
        const fd = Math.hypot(x - f.x, z - f.z);
        if (fd < f.r + 24) {
          const t = 1 - THREE.MathUtils.smoothstep(fd, f.r - 10, f.r + 22);
          h += (f.baseY - h) * t;
        }
      }
      return h;
    }

    function groundAt(x: number, z: number) {
      return terrainOn ? meshHeight(x, z) : poolFloorAt(x, z);
    }

    function meshHeight(x: number, z: number) {
      const cx = Math.floor(x / TILE_STEP) * TILE_STEP;
      const cz = Math.floor(z / TILE_STEP) * TILE_STEP;
      const u = (x - cx) / TILE_STEP;
      const v = (z - cz) / TILE_STEP;
      const h10 = terrainHeight(cx + TILE_STEP, cz);
      const h01 = terrainHeight(cx, cz + TILE_STEP);
      const h11 = terrainHeight(cx + TILE_STEP, cz + TILE_STEP);
      const h00 = terrainHeight(cx, cz);
      if (u + v <= 1) return h00 + u * (h10 - h00) + v * (h01 - h00);
      const c1 = h11 - h01;
      const c2 = h11 - h10;
      const c0 = h10 - c1;
      return c0 + c1 * u + c2 * v;
    }

    function surfaceCut(ray: THREE.Ray, maxDist: number) {
      const o = ray.origin;
      const d = ray.direction;
      if (o.y <= WATER_Y || d.y >= 0) return Infinity;
      const t = (WATER_Y - o.y) / d.y;
      if (t > maxDist) return Infinity;
      const p = ray.at(t, new THREE.Vector3());
      return groundAt(p.x, p.z) < WATER_Y ? t : Infinity;
    }

    function groundCut(ray: THREE.Ray, maxDist: number) {
      const o = ray.origin;
      const d = ray.direction;
      const under = (t: number) => o.y + d.y * t <= groundAt(o.x + d.x * t, o.z + d.z * t);
      if (under(0)) return 0;
      let lo = 0;
      for (let t = 1; t < maxDist + 1; t++) {
        const hi = Math.min(t, maxDist);
        if (under(hi)) {
          let a = lo;
          let b = hi;
          for (let k = 0; k < 14; k++) {
            const m = (a + b) / 2;
            if (under(m)) b = m;
            else a = m;
          }
          return b;
        }
        lo = hi;
        if (hi >= maxDist) break;
      }
      return Infinity;
    }

    function shotCut(ray: THREE.Ray, maxDist: number) {
      return Math.min(terrainOn ? groundCut(ray, maxDist) : Infinity, surfaceCut(ray, maxDist));
    }

    const terrainMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    // Biome palette for the terrain tiles — mixed per-vertex by the
    // biome weights, then overridden by rock/snow/sand rules.
    const TILE_GRASS = new THREE.Color(0x7fa050);
    const TILE_FOREST = new THREE.Color(0x47743a);
    const TILE_JUNGLE = new THREE.Color(0x2f7d3a);
    const TILE_ROCK = new THREE.Color(0x8d8a80);
    const TILE_LAKEBED = new THREE.Color(0xc9b47e);
    const TILE_SNOW = new THREE.Color(0xeef3f6);
    const TILE_SAND = new THREE.Color(0xd8c48f);
    const TILE_DEEP = new THREE.Color(0x2f5d70);
    const tiles = new Map<string, { mesh: THREE.Mesh; cx: number; cz: number; veg?: THREE.Mesh | null; vegSolids?: SolidBox[]; vegTreeVox?: VoxelBox[] }>();

    const seaMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2 * (HARBOR_HALF + TERRAIN_MARGIN), 2 * (HARBOR_HALF + TERRAIN_MARGIN)),
      new THREE.MeshLambertMaterial({ color: 0x2f79a8, transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide })
    );
    seaMesh.rotation.x = -Math.PI / 2;
    seaMesh.position.y = WATER_Y;
    seaMesh.visible = false;
    scene.add(seaMesh);

    function buildTile(tx: number, tz: number) {
      const n = TILE_CELLS + 1;
      const m = n + 2;
      const x0 = tx * TILE;
      const z0 = tz * TILE;
      const H = new Float32Array(m * m);
      for (let j = 0; j < m; j++) {
        for (let i = 0; i < m; i++) {
          H[j * m + i] = terrainHeight(x0 + (i - 1) * TILE_STEP, z0 + (j - 1) * TILE_STEP);
        }
      }
      const pos = new Float32Array(n * n * 3);
      const nor = new Float32Array(n * n * 3);
      const col = new Float32Array(n * n * 3);
      const c = new THREE.Color();
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const k = j * n + i;
          const q = (j + 1) * m + (i + 1);
          const h = H[q];
          const dx = (H[q + 1] - H[q - 1]) / (2 * TILE_STEP);
          const dz = (H[q + m] - H[q - m]) / (2 * TILE_STEP);
          const len = Math.hypot(dx, 1, dz);
          pos.set([x0 + i * TILE_STEP, h, z0 + j * TILE_STEP], k * 3);
          nor.set([-dx / len, 1 / len, -dz / len], k * 3);
          const vx = x0 + i * TILE_STEP;
          const vz = z0 + j * TILE_STEP;
          biomeWeights(vx, vz, CW);
          // Convex biome mix (the five weights sum to 1)
          let cr = CW.gw * TILE_GRASS.r + CW.fw * TILE_FOREST.r + CW.jw * TILE_JUNGLE.r + CW.mw * TILE_ROCK.r + CW.lw * TILE_LAKEBED.r;
          let cg = CW.gw * TILE_GRASS.g + CW.fw * TILE_FOREST.g + CW.jw * TILE_JUNGLE.g + CW.mw * TILE_ROCK.g + CW.lw * TILE_LAKEBED.g;
          let cb = CW.gw * TILE_GRASS.b + CW.fw * TILE_FOREST.b + CW.jw * TILE_JUNGLE.b + CW.mw * TILE_ROCK.b + CW.lw * TILE_LAKEBED.b;
          // Stony above the treeline and on steep faces (cliffs stay rock
          // even inside forest / jungle)
          const stony = Math.max(
            THREE.MathUtils.smoothstep(h, 30, 52),
            THREE.MathUtils.smoothstep(Math.hypot(dx, dz), 1.05, 1.8)
          );
          cr += (TILE_ROCK.r - cr) * stony;
          cg += (TILE_ROCK.g - cg) * stony;
          cb += (TILE_ROCK.b - cb) * stony;
          // Snowcaps on the high peaks
          const snow = THREE.MathUtils.smoothstep(h, 60, 72);
          cr += (TILE_SNOW.r - cr) * snow;
          cg += (TILE_SNOW.g - cg) * snow;
          cb += (TILE_SNOW.b - cb) * snow;
          c.setRGB(cr, cg, cb);
          const coast = 1 - THREE.MathUtils.smoothstep(Math.abs(seaDist(vx, vz)), 12, 60);
          c.lerp(TILE_SAND, coast);
          // Sandy ring around lake shorelines, just above the waterline
          const lshore = CW.lw * THREE.MathUtils.smoothstep(h - WATER_Y, 0.35, 1.7);
          if (lshore > 0.01) c.lerp(TILE_SAND, Math.min(0.85, lshore));
          // Transition routes: dust / mud / gravel painted where the
          // road network passes — after every biome rule so paths stay
          // legible on sand and rock alike, but never underwater.
          if (h > WATER_Y + 0.2 && pathGrid.size) {
            const np = nearPath(vx, vz);
            if (np) {
              const road = 1 - THREE.MathUtils.smoothstep(np.d, np.w / 2 - 0.5, np.w / 2 + 5.5);
              if (road > 0.02) c.lerp(PATH_COLORS[np.kind], road * 0.94);
            }
          }
          c.lerp(TILE_DEEP, THREE.MathUtils.clamp((WATER_Y - h) / 3, 0, 1));
          col.set([c.r, c.g, c.b], k * 3);
        }
      }
      const index: number[] = [];
      for (let j = 0; j < TILE_CELLS; j++) {
        for (let i = 0; i < TILE_CELLS; i++) {
          const a = j * n + i;
          const b = a + 1;
          const d = a + n;
          const e = d + 1;
          index.push(a, d, b, b, d, e);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geo.setIndex(index);
      const mesh = new THREE.Mesh(geo, terrainMat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      return mesh;
    }

    function addTile(tx: number, tz: number) {
      const mesh = buildTile(tx, tz);
      scene.add(mesh);
      // Tile-local vegetation: one merged, vertex-colored mesh plus the
      // trunk/boulder collision boxes, seeded per tile so a revisited
      // tile regrows the exact same stand. Woody plants are voxelized
      // trees — destructible, and they drop wood when chewed apart.
      const veg = terrainOn ? buildVegTile(tx, tz) : null;
      if (veg?.mesh) scene.add(veg.mesh);
      tiles.set(tx + ',' + tz, {
        mesh,
        cx: (tx + 0.5) * TILE,
        cz: (tz + 0.5) * TILE,
        veg: veg?.mesh ?? null,
        vegSolids: veg?.solidRefs ?? [],
        vegTreeVox: veg?.treeVox ?? [],
      });
    }

    function disposeTile(t: { mesh: THREE.Mesh; veg?: THREE.Mesh | null; vegSolids?: SolidBox[]; vegTreeVox?: VoxelBox[] }) {
      scene.remove(t.mesh);
      t.mesh.geometry.dispose();
      if (t.veg) {
        scene.remove(t.veg);
        t.veg.geometry.dispose();
      }
      for (const s of t.vegSolids ?? []) {
        let i = solids.indexOf(s);
        if (i >= 0) solids.splice(i, 1);
        i = vegSolids.indexOf(s);
        if (i >= 0) vegSolids.splice(i, 1);
      }
      // Voxelized trees stream out with their tile: pull the voxel
      // boxes, placeholders, chunky instanced meshes and any rebuilt
      // column solids out of the global registries.
      for (const v of t.vegTreeVox ?? []) {
        if (v.inst) {
          v.group.remove(v.inst);
          const si = shootable.indexOf(v.inst);
          if (si >= 0) shootable.splice(si, 1);
          v.inst.geometry.dispose();
          (v.inst.material as THREE.Material).dispose();
          v.inst.dispose();
          v.inst = null;
        }
        v.mesh.parent?.remove(v.mesh);
        const ms = shootable.indexOf(v.mesh);
        if (ms >= 0) shootable.splice(ms, 1);
        (v.mesh as THREE.Mesh).geometry.dispose();
        for (const r of v.solidRefs) {
          const i = solids.indexOf(r);
          if (i >= 0) solids.splice(i, 1);
        }
        v.solidRefs.length = 0;
        if (v.barGroup) {
          disposeBar(v.barGroup);
          v.barGroup = null;
          v.barFill = null;
          v.barTimer = 0;
        }
        const vi = voxBoxes.indexOf(v);
        if (vi >= 0) voxBoxes.splice(vi, 1);
        v.gone = true;
      }
    }

    function streamTerrain(all = false) {
      if (!terrainOn) return;
      const px = camera.position.x;
      const pz = camera.position.z;
      const reach = Math.ceil(LOAD_R / TILE);
      const edgeHalf = mapHalf + TERRAIN_MARGIN;
      const cx = Math.floor(px / TILE);
      const cz = Math.floor(pz / TILE);
      const want: Array<{ tx: number; tz: number; d: number }> = [];

      for (let tz = cz - reach; tz <= cz + reach; tz++) {
        for (let tx = cx - reach; tx <= cx + reach; tx++) {
          const d = Math.hypot((tx + 0.5) * TILE - px, (tz + 0.5) * TILE - pz);
          if (d > LOAD_R || tiles.has(tx + ',' + tz)) continue;
          if (tx * TILE >= edgeHalf || (tx + 1) * TILE <= -edgeHalf || tz * TILE >= edgeHalf || (tz + 1) * TILE <= -edgeHalf) continue;
          want.push({ tx, tz, d });
        }
      }
      want.sort((a, b) => a.d - b.d);
      const count = all ? want.length : Math.min(TILE_BUILDS, want.length);
      for (let i = 0; i < count; i++) addTile(want[i].tx, want[i].tz);
      for (const [key, t] of tiles) {
        if (Math.hypot(t.cx - px, t.cz - pz) > LOAD_R + TILE) {
          disposeTile(t);
          tiles.delete(key);
        }
      }
    }

    // ----------------------------------------------------
    // Procedural vegetation placer (Harbor mode).
    // Every streamed terrain tile scatters biome-appropriate
    // plants, merged into ONE vertex-colored mesh per tile:
    // pine stands in the forest, kapoks + palms + ferns in the
    // jungle, acacias + dry tufts in the grassland, boulders +
    // spruces + snowline rocks in the mountains, reeds + dead
    // trees around the lakes. Tree trunks and big boulders
    // register real AABB collision — they block movement, soak
    // bullets (with a wood thunk) and intercept grenade blasts,
    // so forests play like forests: hard to shoot through, good
    // to hide in. Bushes, ferns, tufts and reeds are pure
    // scenery. Placement is seeded per tile, so a revisited
    // tile regrows the exact same stand.
    // ----------------------------------------------------
    interface VegDef {
      pos: Float32Array;
      nor: Float32Array;
      col: Float32Array;
    }
    let vegLib: Record<string, VegDef> | null = null;
    const vegSolids: SolidBox[] = [];
    const vegMat = new THREE.MeshLambertMaterial({ vertexColors: true });

    // ----------------------------------------------------
    // VOXELIZED TREES. Woody plants are chunky BOX-built shapes
    // (trunk box + stacked canopy boxes) that stamp into the tile's
    // merged mesh like every other plant, but each tree also
    // registers a destructible voxel lattice spanning its crown
    // (invisible box placeholder — the raycast target). The first
    // bullet or blast swaps the merged stamp for the chunky voxel
    // reveal (per-voxel brown / green palette) and every voxel
    // knocked loose grants wood for building.
    // ----------------------------------------------------
    interface TreePart {
      x: number;
      y: number;
      z: number;
      w: number;
      h: number;
      d: number;
      c: number;
      rx?: number;
      ry?: number;
    }
    interface TreeShape {
      parts: TreePart[]; // trunk FIRST — palette tests in order
      trunkR: number; // movement collision half-width at s=1
      trunkTop: number; // collision top (metres of trunk) at s=1
      vox: number; // lattice cell size
      ex: number; // crown half-extent x/z at s=1 (grid override)
      top: number; // crown top at s=1 (above the stamp base)
    }
    const TREE_WOOD = 2; // wood per destroyed tree voxel
    let treeVoxMat: THREE.MeshLambertMaterial | null = null;
    const TREE_SHAPES: Record<string, TreeShape> = {
      pine: {
        parts: [
          { x: 0, y: 1.1, z: 0, w: 0.36, h: 2.2, d: 0.36, c: 0x6b4a2f },
          { x: 0, y: 2.15, z: 0, w: 2.0, h: 1.0, d: 2.0, c: 0x2f6b35 },
          { x: 0, y: 3.1, z: 0, w: 1.4, h: 0.9, d: 1.4, c: 0x35743c },
          { x: 0, y: 3.95, z: 0, w: 0.85, h: 0.8, d: 0.85, c: 0x3d7d43 },
        ],
        trunkR: 0.34, trunkTop: 1.9, vox: 0.62, ex: 1.0, top: 4.35,
      },
      spruce: {
        parts: [
          { x: 0, y: 0.8, z: 0, w: 0.3, h: 1.6, d: 0.3, c: 0x5d4030 },
          { x: 0, y: 1.85, z: 0, w: 1.7, h: 0.85, d: 1.7, c: 0x2a5f3a },
          { x: 0, y: 2.7, z: 0, w: 1.15, h: 0.8, d: 1.15, c: 0x2f6a40 },
          { x: 0, y: 3.5, z: 0, w: 0.7, h: 0.75, d: 0.7, c: 0x356f45 },
          { x: 0, y: 4.15, z: 0, w: 0.35, h: 0.6, d: 0.35, c: 0x3b744a },
        ],
        trunkR: 0.3, trunkTop: 1.7, vox: 0.62, ex: 0.85, top: 4.45,
      },
      broadleaf: {
        parts: [
          { x: 0, y: 1.15, z: 0, w: 0.4, h: 2.3, d: 0.4, c: 0x7a5638 },
          { x: 0, y: 3.2, z: 0, w: 2.6, h: 1.7, d: 2.6, c: 0x4f8a3d },
          { x: 1.1, y: 2.6, z: 0.4, w: 1.2, h: 1.0, d: 1.2, c: 0x457f38 },
          { x: -1.0, y: 2.75, z: -0.7, w: 1.1, h: 0.9, d: 1.1, c: 0x558f41 },
        ],
        trunkR: 0.42, trunkTop: 2.1, vox: 0.62, ex: 1.35, top: 4.05,
      },
      kapok: {
        parts: [
          { x: 0, y: 2.15, z: 0, w: 0.55, h: 4.3, d: 0.55, c: 0x8a6242 },
          { x: 0, y: 4.9, z: 0, w: 3.4, h: 1.5, d: 3.4, c: 0x2f7d33 },
          { x: 1.6, y: 4.4, z: 0.8, w: 1.6, h: 1.1, d: 1.6, c: 0x357f38 },
          { x: -1.5, y: 4.5, z: -1.0, w: 1.5, h: 1.0, d: 1.5, c: 0x2a7230 },
        ],
        trunkR: 0.5, trunkTop: 3.4, vox: 0.7, ex: 1.8, top: 5.65,
      },
      palm: {
        parts: [
          { x: 0.28, y: 2.2, z: 0.12, w: 0.34, h: 4.4, d: 0.34, c: 0x8a6a45, rx: 0.12 },
          { x: 1.05, y: 4.42, z: 0.12, w: 1.7, h: 0.12, d: 0.6, c: 0x3f8f3f, ry: 0.55 },
          { x: -0.85, y: 4.42, z: 0.55, w: 1.7, h: 0.12, d: 0.6, c: 0x35833a, ry: 2.15 },
          { x: -0.5, y: 4.3, z: -0.9, w: 1.7, h: 0.12, d: 0.6, c: 0x3f8f3f, ry: 3.75 },
          { x: 0.45, y: 4.52, z: -0.8, w: 1.4, h: 0.12, d: 0.55, c: 0x35833a, ry: 5.2 },
          { x: 0.2, y: 4.5, z: 0.9, w: 1.2, h: 0.12, d: 0.5, c: 0x3f8f3f, ry: 1.3 },
          { x: 0.35, y: 4.15, z: 0.4, w: 0.24, h: 0.24, d: 0.24, c: 0x5d4a2f },
          { x: -0.05, y: 4.1, z: 0.75, w: 0.22, h: 0.22, d: 0.22, c: 0x6b5433 },
        ],
        trunkR: 0.38, trunkTop: 2.6, vox: 0.66, ex: 1.35, top: 4.6,
      },
      acacia: {
        parts: [
          { x: 0.1, y: 1.0, z: 0, w: 0.34, h: 2.0, d: 0.34, c: 0x7a5a3a, rx: 0.12 },
          { x: 0.3, y: 2.85, z: 0, w: 3.4, h: 0.8, d: 3.4, c: 0x7d8f4a },
          { x: 0.3, y: 2.3, z: 0, w: 2.0, h: 0.55, d: 2.0, c: 0x74873f },
        ],
        trunkR: 0.36, trunkTop: 1.9, vox: 0.62, ex: 1.75, top: 3.3,
      },
      deadtree: {
        parts: [
          { x: 0, y: 1.3, z: 0, w: 0.3, h: 2.6, d: 0.3, c: 0x8a7a66, rx: 0.06 },
          { x: 0.55, y: 2.35, z: 0.15, w: 1.3, h: 0.14, d: 0.14, c: 0x8a7a66, ry: 0.2 },
          { x: -0.45, y: 2.15, z: 0.2, w: 1.1, h: 0.13, d: 0.13, c: 0x84745f, ry: -0.5 },
          { x: 0.1, y: 2.6, z: -0.3, w: 0.9, h: 0.12, d: 0.12, c: 0x84745f, ry: 1.2 },
          { x: 0.05, y: 2.95, z: 0, w: 0.18, h: 0.9, d: 0.18, c: 0x8a7a66 },
        ],
        trunkR: 0.3, trunkTop: 2.2, vox: 0.62, ex: 0.85, top: 3.4,
      },
    };

    interface StampRec {
      def: VegDef;
      x: number;
      y: number;
      z: number;
      yaw: number;
      s: number;
      tint: number;
      vox: VoxelBox | null; // set when this stamp is a destructible tree
      skip?: boolean; // tree voxelized — stamp leaves the merged mesh
    }
    interface VegTileRec {
      mesh: THREE.Mesh | null;
      stamps: StampRec[];
    }

    // A tree took its first hit: drop its stamp from the tile's merged
    // mesh so the chunky voxel reveal is the only visual left.
    function removeTreeStamp(v: VoxelBox) {
      const rec = v.vegTile;
      if (!rec || !rec.mesh) return;
      let dirty = false;
      for (const st of rec.stamps) {
        if (st.vox === v && !st.skip) {
          st.skip = true;
          dirty = true;
        }
      }
      if (!dirty) return;
      const P: number[] = [];
      const N: number[] = [];
      const C: number[] = [];
      for (const st of rec.stamps) {
        if (st.skip) continue;
        stampVeg(st.def, st.x, st.y, st.z, st.yaw, st.s, st.tint, P, N, C);
      }
      rec.mesh.geometry.dispose();
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P), 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(N), 3));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(C), 3));
      rec.mesh.geometry = geo;
    }

    function vegMat4(x: number, y: number, z: number, rx = 0, ry = 0, sx = 1, sy = 1, sz = 1) {
      return new THREE.Matrix4().compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, 0)),
        new THREE.Vector3(sx, sy, sz)
      );
    }

    // Merge primitive parts (already transformed, each with a flat
    // color) into one baked definition the stamping loop copies from.
    function vegMerge(parts: Array<{ geo: THREE.BufferGeometry; mat: THREE.Matrix4; color: number }>): VegDef {
      let count = 0;
      const prepped = parts.map((p) => {
        const g = p.geo.index ? p.geo.toNonIndexed() : p.geo;
        count += (g.getAttribute('position') as THREE.BufferAttribute).count;
        return { g, mat: p.mat, color: p.color };
      });
      const pos = new Float32Array(count * 3);
      const nor = new Float32Array(count * 3);
      const col = new Float32Array(count * 3);
      const v = new THREE.Vector3();
      const nm = new THREE.Matrix3();
      const c = new THREE.Color();
      let o = 0;
      for (const p of prepped) {
        const pa = p.g.getAttribute('position') as THREE.BufferAttribute;
        const na = p.g.getAttribute('normal') as THREE.BufferAttribute;
        nm.getNormalMatrix(p.mat);
        c.setHex(p.color);
        for (let i = 0; i < pa.count; i++, o++) {
          v.fromBufferAttribute(pa, i).applyMatrix4(p.mat);
          pos[o * 3] = v.x;
          pos[o * 3 + 1] = v.y;
          pos[o * 3 + 2] = v.z;
          v.fromBufferAttribute(na, i).applyMatrix3(nm).normalize();
          nor[o * 3] = v.x;
          nor[o * 3 + 1] = v.y;
          nor[o * 3 + 2] = v.z;
          col[o * 3] = c.r;
          col[o * 3 + 1] = c.g;
          col[o * 3 + 2] = c.b;
        }
      }
      for (let i = 0; i < parts.length; i++) {
        parts[i].geo.dispose();
        if (prepped[i].g !== parts[i].geo) prepped[i].g.dispose();
      }
      return { pos, nor, col };
    }

    function buildVegLib() {
      if (vegLib) return;
      const lib: Record<string, VegDef> = {};
      const P = (
        geo: THREE.BufferGeometry,
        x: number,
        y: number,
        z: number,
        color: number,
        rx = 0,
        ry = 0,
        sx = 1,
        sy = 1,
        sz = 1
      ) => ({ geo, mat: vegMat4(x, y, z, rx, ry, sx, sy, sz), color });

      // Woody plants are VOXEL TREES: chunky box-built silhouettes
      // generated from TREE_SHAPES (see the voxelized-trees block
      // above). The same shape data drives the per-voxel brown/green
      // palette, so the merged stamp and the damaged-chunky reveal
      // match part for part.
      for (const [name, shape] of Object.entries(TREE_SHAPES)) {
        lib[name] = vegMerge(
          shape.parts.map((p) => P(new THREE.BoxGeometry(p.w, p.h, p.d), p.x, p.y, p.z, p.c, p.rx ?? 0, p.ry ?? 0))
        );
      }
      if (!treeVoxMat) {
        treeVoxMat = new THREE.MeshLambertMaterial({ color: 0x6b4a2f });
        voxHpMap.set(treeVoxMat, 26); // a couple of bullets per chunk
      }
      // Bushes: lush jungle/forest vs dry savanna
      const bushShape = (a: number, b: number, c: number) =>
        vegMerge([
          P(new THREE.SphereGeometry(0.62, 6, 4), 0, 0.55, 0, a, 0, 0, 1.15, 0.9, 1.15),
          P(new THREE.SphereGeometry(0.45, 5, 4), 0.45, 0.75, 0.2, b),
          P(new THREE.SphereGeometry(0.4, 5, 4), -0.4, 0.7, -0.15, c),
        ]);
      lib.bush = bushShape(0x51804a, 0x4a7a42, 0x578549);
      lib.bushDry = bushShape(0x9a8f4e, 0x8f8446, 0xa3955a);
      // Jungle fern: small fronds fanning out of the ground
      {
        const parts: Array<{ geo: THREE.BufferGeometry; mat: THREE.Matrix4; color: number }> = [];
        for (let k = 0; k < 5; k++) {
          const a = (k / 5) * Math.PI * 2;
          const fr = new THREE.ConeGeometry(0.26, 1.35, 4);
          fr.translate(0, 0.675, 0);
          fr.rotateZ(-1.15); // mostly horizontal, slight droop
          fr.rotateY(a);
          parts.push({ geo: fr, mat: vegMat4(0, 0.12, 0), color: k % 2 ? 0x3f8f3f : 0x357f38 });
        }
        lib.fern = vegMerge(parts);
      }
      // Grass tuft: thin yellow-green spikes
      lib.tuft = vegMerge([
        P(new THREE.ConeGeometry(0.055, 0.6, 4), 0, 0.3, 0, 0x93a352, 0.06),
        P(new THREE.ConeGeometry(0.05, 0.75, 4), 0.09, 0.37, 0.05, 0x8d9c4c, -0.12, 0.4),
        P(new THREE.ConeGeometry(0.05, 0.55, 4), -0.1, 0.28, -0.06, 0x9aa857, 0.1, 0.9),
        P(new THREE.ConeGeometry(0.045, 0.66, 4), 0.04, 0.33, -0.1, 0x88994a, -0.08, 1.7),
        P(new THREE.ConeGeometry(0.05, 0.5, 4), -0.05, 0.25, 0.08, 0x9fae5b, 0.14, 2.4),
      ]);
      // Reed cluster: tall stalks + seed heads, feet in the water
      lib.reed = vegMerge([
        P(new THREE.CylinderGeometry(0.028, 0.04, 1.8, 4), 0, 0.9, 0, 0x7f9a4f, 0.05),
        P(new THREE.CylinderGeometry(0.028, 0.04, 1.6, 4), 0.08, 0.8, 0.05, 0x86a155, -0.08, 0.5),
        P(new THREE.CylinderGeometry(0.028, 0.04, 2.0, 4), -0.07, 1.0, -0.04, 0x79934a, 0.06, 1.2),
        P(new THREE.CylinderGeometry(0.026, 0.038, 1.5, 4), 0.03, 0.75, -0.08, 0x8ba75c, -0.1, 1.9),
        P(new THREE.ConeGeometry(0.07, 0.32, 4), 0, 2.0, 0, 0x6b5a35),
        P(new THREE.ConeGeometry(0.06, 0.3, 4), -0.07, 2.14, -0.04, 0x71623a),
      ]);
      // Rocks: scree boulder and mountain block
      lib.rock = vegMerge([
        P(new THREE.DodecahedronGeometry(0.8, 0), 0, 0.35, 0, 0x8d8a80, 0, 0.3, 1.3, 0.85, 1.05),
        P(new THREE.DodecahedronGeometry(0.45, 0), 0.8, 0.2, 0.4, 0x99968c, 0, 1.1, 1.2, 0.8),
      ]);
      lib.rockBig = vegMerge([
        P(new THREE.DodecahedronGeometry(1.7, 0), 0, 0.6, 0, 0x87857c, 0, 0.2, 1.35, 1.0, 1.15),
        P(new THREE.DodecahedronGeometry(1.0, 0), 1.6, 0.4, -0.9, 0x918e85, 0, 0.8, 1.2, 0.9, 1.1),
        P(new THREE.DodecahedronGeometry(0.7, 0), -1.5, 0.25, 1.0, 0x807d75),
      ]);
      vegLib = lib;
    }

    function stampVeg(
      def: VegDef,
      x: number,
      y: number,
      z: number,
      yaw: number,
      s: number,
      tint: number,
      P: number[],
      N: number[],
      C: number[]
    ) {
      const cs = Math.cos(yaw);
      const sn = Math.sin(yaw);
      const p = def.pos;
      const n = def.nor;
      const cl = def.col;
      for (let i = 0; i < p.length; i += 3) {
        const px = p[i] * s;
        const py = p[i + 1] * s;
        const pz = p[i + 2] * s;
        P.push(px * cs - pz * sn + x, py + y, px * sn + pz * cs + z);
        const nx = n[i];
        const nz = n[i + 2];
        N.push(nx * cs - nz * sn, n[i + 1], nx * sn + nz * cs);
        C.push(cl[i] * tint, cl[i + 1] * tint, cl[i + 2] * tint);
      }
    }

    const VEG_MAX_INST = 66; // instance cap per tile
    const VEG_MAX_VERTS = 22000; // vertex budget per tile

    function buildVegTile(tx: number, tz: number): { mesh: THREE.Mesh | null; solidRefs: SolidBox[]; stamps: StampRec[]; treeVox: VoxelBox[] } {
      const solidRefs: SolidBox[] = [];
      const stamps: StampRec[] = [];
      const treeVox: VoxelBox[] = [];
      const tileRec: VegTileRec = { mesh: null, stamps };
      if (!vegLib) buildVegLib();
      const lib = vegLib!;
      const tvm = treeVoxMat!;
      const x0 = tx * TILE;
      const z0 = tz * TILE;
      const rnd = mulberry32((terrainSeed ^ (tx * 73856093) ^ (tz * 19349663)) >>> 0);
      const P: number[] = [];
      const N: number[] = [];
      const C: number[] = [];
      let inst = 0;
      let verts = 0;
      for (let a = 0; a < 150 && inst < VEG_MAX_INST && verts < VEG_MAX_VERTS; a++) {
        const vx = x0 + rnd() * TILE;
        const vz = z0 + rnd() * TILE;
        // Keep the spawn pad, the port complex, the beach and every
        // POI pad clear — plants grow everywhere else.
        if (Math.hypot(vx - HARBOR_SPAWN.x, vz - HARBOR_SPAWN.z) < 40) continue;
        if (harborAnchor && Math.hypot(vx - harborAnchor.x, vz - harborAnchor.z) < portClearR) continue;
        if (seaDist(vx, vz) > -14) continue;
        let pad = false;
        for (const f of flatZones) {
          if (Math.hypot(vx - f.x, vz - f.z) < f.r + 8) {
            pad = true;
            break;
          }
        }
        if (pad) continue;
        // War decorations own their clearings too — no tank growing a
        // pine through its turret.
        for (const w of warZones) {
          if (Math.hypot(vx - w.x, vz - w.z) < w.r + 2) {
            pad = true;
            break;
          }
        }
        if (pad) continue;
        // Roads stay clear — no trees or boulders mid-track, so the
        // transition routes read as walked corridors, not noise
        const npv = nearPath(vx, vz);
        if (npv && npv.d < npv.w / 2 + 1.5) continue;
        const h = terrainHeight(vx, vz);
        biomeWeights(vx, vz, VW);
        const pick = rnd();
        let def: VegDef | null = null;
        let s = 1;
        let trunkR = 0; // > 0 registers a destructible voxel tree
        let trunkTop = 0;
        let treeName: string | null = null;
        let boulder = false;
        if (VW.mw >= 0.04 && VW.mw >= VW.lw && VW.mw >= VW.jw && VW.mw >= VW.fw && VW.mw >= VW.gw) {
          // Mountain: boulders all the way up, spruces only below the
          // treeline on gentler ground.
          if (h < WATER_Y + 0.32) continue;
          if (h > 54) {
            if (pick < 0.5) {
              def = lib.rockBig;
              boulder = true;
            } else if (pick < 0.8) def = lib.rock;
            else continue;
            s = 0.7 + rnd() * 0.7;
          } else {
            const sl = Math.max(Math.abs(terrainHeight(vx + 3, vz) - h), Math.abs(terrainHeight(vx, vz + 3) - h)) / 3;
            if (sl < 1.5) {
              if (pick < 0.4) {
                def = lib.spruce;
                trunkR = 0.3;
                trunkTop = 1.7;
                treeName = 'spruce';
              } else if (pick < 0.62) def = lib.rock;
              else if (pick < 0.74) {
                def = lib.rockBig;
                boulder = true;
              } else if (pick < 0.88) def = lib.bush;
              else def = lib.tuft;
              s = 0.85 + rnd() * 0.5;
            } else if (pick < 0.55) def = lib.rock;
            else if (pick < 0.8) {
              def = lib.rockBig;
              boulder = true;
              s = 0.8 + rnd() * 0.6;
            } else continue;
          }
        } else if (VW.lw >= 0.04 && VW.lw >= VW.jw && VW.lw >= VW.fw && VW.lw >= VW.gw) {
          // Lake: reeds hug the waterline, deadwood + bushes on the bank.
          if (h < WATER_Y - 0.1) continue; // open water
          if (h < WATER_Y + 0.5) {
            if (pick < 0.85) def = lib.reed;
            else continue;
            s = 0.8 + rnd() * 0.6;
          } else {
            if (pick < 0.3) {
              def = lib.deadtree;
              trunkR = 0.3;
              trunkTop = 2.2;
              treeName = 'deadtree';
            } else if (pick < 0.62) def = lib.bush;
            else if (pick < 0.9) def = lib.tuft;
            else continue;
            s = 0.9 + rnd() * 0.4;
          }
        } else if (VW.jw >= 0.02 && VW.jw >= VW.fw && VW.jw >= VW.gw) {
          // Jungle: wall-to-wall green.
          if (h < WATER_Y + 0.32) continue;
          if (pick < 0.24) {
            def = lib.kapok;
            trunkR = 0.5;
            trunkTop = 3.4;
            treeName = 'kapok';
          } else if (pick < 0.5) {
            def = lib.palm;
            trunkR = 0.38;
            trunkTop = 2.6;
            treeName = 'palm';
          } else if (pick < 0.74) def = lib.fern;
          else if (pick < 0.92) def = lib.bush;
          else def = lib.tuft;
          s = 0.9 + rnd() * 0.5;
        } else if (VW.fw >= 0.02 && VW.fw >= VW.gw) {
          // Forest: pine stands with broadleaf breaks.
          if (h < WATER_Y + 0.32) continue;
          if (pick < 0.56) {
            def = lib.pine;
            trunkR = 0.34;
            trunkTop = 1.9;
            treeName = 'pine';
          } else if (pick < 0.76) {
            def = lib.broadleaf;
            trunkR = 0.42;
            trunkTop = 2.1;
            treeName = 'broadleaf';
          } else if (pick < 0.92) def = lib.bush;
          else def = lib.tuft;
          s = 0.85 + rnd() * 0.55;
        } else {
          // Grassland: open tuftland with lone acacias.
          if (h < WATER_Y + 0.32) continue;
          if (pick < 0.4) def = lib.tuft;
          else if (pick < 0.58) def = lib.bushDry;
          else if (pick < 0.68) {
            def = lib.acacia;
            trunkR = 0.36;
            trunkTop = 1.9;
            treeName = 'acacia';
          } else if (pick < 0.74) def = lib.rock;
          else continue;
          s = 0.9 + rnd() * 0.5;
        }
        if (!def) continue;
        const yaw = rnd() * Math.PI * 2;
        const tint = 0.86 + rnd() * 0.26;
        const rec: StampRec = { def, x: vx, y: h - 0.06, z: vz, yaw, s, tint, vox: null };
        stamps.push(rec);
        stampVeg(def, vx, h - 0.06, vz, yaw, s, tint, P, N, C);
        verts += def.pos.length / 3;
        inst++;
        if (trunkR && treeName) {
          // VOXELIZED TREE: trunk-only movement collision (forests
          // stay walkable), but a destructible lattice spanning the
          // whole crown. Bullets and blasts chew chunks out of it —
          // every voxel knocked loose grants wood. The invisible box
          // placeholder is the raycast target; on the first hit the
          // merged stamp above is swapped for the chunky voxels.
          const shape = TREE_SHAPES[treeName];
          const base = h - 0.06;
          const sb: SolidBox = {
            x: vx,
            z: vz,
            hx: Math.max(0.32, trunkR * s * 1.12),
            hz: Math.max(0.32, trunkR * s * 1.12),
            bottom: h - 1.2,
            top: h + trunkTop * s,
            group: scene,
          };
          solids.push(sb);
          solidRefs.push(sb);
          const gx = Math.max(0.45, shape.ex * s);
          const gz = Math.max(0.45, shape.ex * s);
          const gTop = base + shape.top * s;
          const gBot = h - 0.9;
          const ph = new THREE.Mesh(new THREE.BoxGeometry(gx * 2, gTop - gBot, gz * 2), tvm);
          ph.position.set(vx, (gTop + gBot) / 2, vz);
          ph.visible = false;
          scene.add(ph);
          shootable.push(ph);
          registerDestructible(sb, ph, tvm, shape.vox, {
            grid: { hx: gx, hz: gz, top: gTop, bottom: gBot },
            pal: buildTreePal(shape, vx, base, vz, yaw, s, gx, gz, gTop, gBot, shape.vox),
            gain: TREE_WOOD,
            vegTile: tileRec,
          });
          const tv = ph.userData.vox as VoxelBox;
          rec.vox = tv;
          treeVox.push(tv);
        }
        if (boulder) {
          const sb: SolidBox = { x: vx, z: vz, hx: 1.75 * s, hz: 1.5 * s, bottom: h - 1.5, top: h + 1.15 * s };
          solids.push(sb);
          vegSolids.push(sb);
          solidRefs.push(sb);
        }
      }
      if (!inst) return { mesh: null, solidRefs, stamps, treeVox };
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P), 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(N), 3));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(C), 3));
      const mesh = new THREE.Mesh(geo, vegMat);
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      tileRec.mesh = mesh;
      return { mesh, solidRefs, stamps, treeVox };
    }

    // Per-voxel colour palette for a voxelized tree: rotate each voxel
    // centre into the tree's local space and test it against the shape
    // parts in order (trunk first) — brown trunk column, green crown.
    function buildTreePal(
      shape: TreeShape,
      tx: number,
      ty: number,
      tz: number,
      yaw: number,
      s: number,
      ghx: number,
      ghz: number,
      gTop: number,
      gBot: number,
      vs: number
    ): Float32Array {
      const nx = Math.max(1, Math.min(VOX_MAX_DIM, Math.round((ghx * 2) / vs)));
      const ny = Math.max(1, Math.min(VOX_MAX_DIM, Math.round((gTop - gBot) / vs)));
      const nz = Math.max(1, Math.min(VOX_MAX_DIM, Math.round((ghz * 2) / vs)));
      const sx = (ghx * 2) / nx;
      const sy = (gTop - gBot) / ny;
      const sz = (ghz * 2) / nz;
      const x0 = tx - ghx;
      const y0 = gBot;
      const z0 = tz - ghz;
      const pal = new Float32Array(nx * ny * nz * 3);
      const cs = Math.cos(yaw);
      const sn = Math.sin(yaw);
      const tc = new THREE.Color();
      const trunkC = new THREE.Color(shape.parts[0].c);
      for (let k = 0; k < nz; k++) {
        for (let j = 0; j < ny; j++) {
          for (let i = 0; i < nx; i++) {
            const idx = i + nx * (j + ny * k);
            const wx = x0 + (i + 0.5) * sx;
            const wy = y0 + (j + 0.5) * sy;
            const wz = z0 + (k + 0.5) * sz;
            const dx = wx - tx;
            const dz = wz - tz;
            const lx = (cs * dx + sn * dz) / s;
            const lz = (-sn * dx + cs * dz) / s;
            const ly = (wy - ty) / s;
            tc.copy(trunkC);
            for (const part of shape.parts) {
              if (
                Math.abs(lx - part.x) <= part.w / 2 + 0.02 &&
                Math.abs(lz - part.z) <= part.d / 2 + 0.02 &&
                ly >= part.y - part.h / 2 - 0.02 &&
                ly <= part.y + part.h / 2 + 0.02
              ) {
                tc.setHex(part.c);
                break;
              }
            }
            pal[idx * 3] = tc.r;
            pal[idx * 3 + 1] = tc.g;
            pal[idx * 3 + 2] = tc.b;
          }
        }
      }
      return pal;
    }

    // Vegetation blocks bullets: nearest boulder along a shot segment
    // soaks the round (rock thunk). Voxelized TREES are no longer in
    // here — they are destructible shootables now, so bullets CHIP
    // them for wood instead of soaking. Boulders still block grenade
    // LOS via `solids`, so rocky cover is real cover.
    function vegCut(o: THREE.Vector3, dir: THREE.Vector3, maxDist: number): number {
      let best = Infinity;
      const ex = o.x + dir.x * maxDist;
      const ey = o.y + dir.y * maxDist;
      const ez = o.z + dir.z * maxDist;
      const end = { x: ex, y: ey, z: ez };
      const reachSq = (maxDist + 4) * (maxDist + 4);
      for (const b of vegSolids) {
        const dx = b.x - o.x;
        const dz = b.z - o.z;
        if (dx * dx + dz * dz > reachSq) continue;
        const t = segmentIntersectsBox(o, end, b);
        if (t !== null) {
          const d = t * maxDist;
          if (d < best) best = d;
        }
      }
      return best;
    }

    // ----------------------------------------------------
    // World Solids, Shootables, Dummies
    // ----------------------------------------------------
    const ARENA = 95 * FIELD;
    let mapHalf = ARENA;
    const SPREAD = 180 * FIELD;
    interface SolidBox {
      x: number;
      z: number;
      hx: number;
      hz: number;
      top: number;
      bottom?: number;
      group?: THREE.Object3D;
      // Player-built ramp steps carry this so the look-straight-up
      // build gesture knows the player is standing on a staircase.
      stair?: boolean;
    }
    const solids: SolidBox[] = [];
    const shootable: THREE.Object3D[] = [];

    // ----------------------------------------------------
    // Voxel Destruction — Fortnite-style structural damage
    // Every wall / crate / slab is secretly a grid of voxel
    // chunks. Blasts and bullets chew chunks away; collision
    // is rebuilt from the survivors, so cover wears out.
    // ----------------------------------------------------
    const VOX_SIZE = 0.55;
    const VOX_MAX_DIM = 96;
    const voxHpMap = new WeakMap<THREE.Material, number>();
    const voxBoxes: VoxelBox[] = [];

    // ----------------------------------------------------
    // Wood economy — voxelized trees are the harvest, wooden build
    // pieces spend it. Enforced in terrain modes (Harbor) only:
    // the Test Range stays a free-build sandbox with no trees.
    // ----------------------------------------------------
    let woodRes = 60;
    const PIECE_COST: Record<string, number> = { wall: 10, door: 12, floor: 10, ramp: 10, ladder: 15 };

    function refreshWood() {
      const el = $('woodCount');
      if (el) el.textContent = String(Math.floor(woodRes));
      const plate = $('woodPlate');
      if (plate) plate.hidden = !terrainOn;
    }

    function grantWood(n: number, at?: THREE.Vector3) {
      woodRes += n;
      if (at && damagePopups.length < 22) showDamagePopup('+' + n + ' wood', at, '#e0a860');
      refreshWood();
    }
    const voxFlashGeo = new THREE.SphereGeometry(1, 12, 8);
    const voxTmpM = new THREE.Matrix4();
    const voxTmpC = new THREE.Color();
    const voxTmpP = new THREE.Vector3();
    const voxTmpQ = new THREE.Quaternion();
    const voxTmpS = new THREE.Vector3();

    interface VoxelBox {
      mesh: THREE.Mesh;
      group: THREE.Object3D;
      color: THREE.Color;
      nx: number;
      ny: number;
      nz: number;
      sx: number;
      sy: number;
      sz: number;
      x0: number;
      y0: number;
      z0: number;
      hp: Float32Array;
      alive: Uint8Array;
      order: Int32Array;
      slotOf: Int32Array;
      aliveCount: number;
      total: number;
      inst: THREE.InstancedMesh | null;
      solidRefs: SolidBox[];
      deadSinceBuild: number;
      gone: boolean;
      // Fortnite-style structural integrity (same kind as BR-web):
      // every structure tracks a total HP pool, shows a health bar and
      // collapses once it has been gutted past the point of no return.
      voxHp: number;
      poolHp: number;
      dmgTaken: number;
      barGroup: THREE.Group | null;
      barFill: THREE.Mesh | null;
      barTimer: number;
      collapsed: boolean;
      // Voxelized trees: per-voxel base colours (brown trunk, green
      // canopy) so the chunky reveal reads as a tree, wood granted per
      // destroyed voxel, and the owning veg tile so the merged-mesh
      // stamp can be swapped out the moment the tree voxelizes.
      pal: Float32Array | null;
      gain: number;
      vegTile: VegTileRec | null;
    }

    function registerDestructible(
      b: SolidBox,
      mesh: THREE.Mesh,
      mat: THREE.Material,
      customVoxSize?: number,
      opts?: { grid?: { hx: number; hz: number; top: number; bottom: number }; pal?: Float32Array | null; gain?: number; vegTile?: VegTileRec | null }
    ) {
      // `grid` overrides the voxel lattice extents without touching the
      // collision solid — voxelized trees span trunk + canopy while
      // movement collision stays a slim trunk.
      const g = opts?.grid;
      const ghx = g ? g.hx : b.hx;
      const ghz = g ? g.hz : b.hz;
      const gTop = g ? g.top : b.top;
      const bottom = g ? g.bottom : b.bottom ?? 0;
      const vs = customVoxSize ?? VOX_SIZE;
      const nx = Math.max(1, Math.min(VOX_MAX_DIM, Math.round((ghx * 2) / vs)));
      const ny = Math.max(1, Math.min(VOX_MAX_DIM, Math.round((gTop - bottom) / vs)));
      const nz = Math.max(1, Math.min(VOX_MAX_DIM, Math.round((ghz * 2) / vs)));
      const total = nx * ny * nz;
      const voxHp = voxHpMap.get(mat) ?? 100;
      const order = new Int32Array(total);
      const slotOf = new Int32Array(total);
      for (let i = 0; i < total; i++) {
        order[i] = i;
        slotOf[i] = i;
      }
      const v: VoxelBox = {
        mesh,
        group: b.group ?? world,
        color: (mat as THREE.MeshLambertMaterial).color.clone(),
        nx,
        ny,
        nz,
        sx: (ghx * 2) / nx,
        sy: (gTop - bottom) / ny,
        sz: (ghz * 2) / nz,
        x0: b.x - ghx,
        y0: bottom,
        z0: b.z - ghz,
        hp: new Float32Array(total).fill(voxHp),
        alive: new Uint8Array(total).fill(1),
        order,
        slotOf,
        aliveCount: total,
        total,
        inst: null,
        solidRefs: [b],
        deadSinceBuild: 0,
        gone: false,
        voxHp,
        poolHp: total * voxHp,
        dmgTaken: 0,
        barGroup: null,
        barFill: null,
        barTimer: 0,
        collapsed: false,
        pal: opts?.pal ?? null,
        gain: opts?.gain ?? 0,
        vegTile: opts?.vegTile ?? null,
      };
      mesh.userData.vox = v;
      voxBoxes.push(v);
    }

    function voxCenter(v: VoxelBox, idx: number, out: THREE.Vector3) {
      const i = idx % v.nx;
      const t = (idx / v.nx) | 0;
      const j = t % v.ny;
      const k = (t / v.ny) | 0;
      out.set(v.x0 + (i + 0.5) * v.sx, v.y0 + (j + 0.5) * v.sy, v.z0 + (k + 0.5) * v.sz);
      return out;
    }

    // First structural hit swaps the plain box for a chunky voxel InstancedMesh
    function ensureInstanced(v: VoxelBox) {
      if (v.inst || v.gone) return;
      const inst = new THREE.InstancedMesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshLambertMaterial({ color: 0xffffff }),
        v.total
      );
      inst.frustumCulled = false;
      inst.castShadow = true;
      inst.receiveShadow = true;
      inst.userData.vox = v;
      voxTmpQ.identity();
      voxTmpS.set(v.sx * 1.0, v.sy * 1.0, v.sz * 1.0);
      for (let s = 0; s < v.aliveCount; s++) {
        const idx = v.order[s];
        voxCenter(v, idx, voxTmpP);
        voxTmpM.compose(voxTmpP, voxTmpQ, voxTmpS);
        inst.setMatrixAt(s, voxTmpM);
        // Voxelized trees carry a per-voxel palette (brown trunk vs
        // green canopy) so the chunky reveal still reads as a tree.
        if (v.pal) voxTmpC.setRGB(v.pal[idx * 3], v.pal[idx * 3 + 1], v.pal[idx * 3 + 2]).multiplyScalar(0.86 + Math.random() * 0.28);
        else voxTmpC.copy(v.color).multiplyScalar(0.86 + Math.random() * 0.28);
        inst.setColorAt(s, voxTmpC);
      }
      inst.count = v.aliveCount;
      inst.instanceMatrix.needsUpdate = true;
      v.group.add(inst);
      shootable.push(inst);
      v.mesh.visible = false;
      const si = shootable.indexOf(v.mesh);
      if (si >= 0) shootable.splice(si, 1);
      v.inst = inst;
      rebuildSolids(v);
      // First hit on a voxelized TREE: swap its merged-mesh stamp for
      // the chunky voxel reveal so the two visuals never overlap.
      if (v.vegTile) removeTreeStamp(v);
    }

    function killVoxel(v: VoxelBox, slot: number, chips: number) {
      const inst = v.inst;
      if (!inst || v.gone) return;
      const idx = v.order[slot];
      v.alive[idx] = 0;
      v.hp[idx] = 0;
      v.slotOf[idx] = -1;
      const last = v.aliveCount - 1;
      if (slot !== last) {
        const moved = v.order[last];
        v.order[slot] = moved;
        v.slotOf[moved] = slot;
        inst.getMatrixAt(last, voxTmpM);
        inst.setMatrixAt(slot, voxTmpM);
        inst.getColorAt(last, voxTmpC);
        inst.setColorAt(slot, voxTmpC);
      }
      v.aliveCount = last;
      inst.count = last;
      inst.instanceMatrix.needsUpdate = true;
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      v.deadSinceBuild++;
      voxCenter(v, idx, voxTmpP);
      spawnDebris(voxTmpP.x, voxTmpP.y, voxTmpP.z, v.color, chips);
      // Harvest: voxelized trees drop wood for building with every
      // chunk knocked loose (bullets chip, blasts carve, collapses pay
      // out the whole remaining crown).
      if (v.gain) grantWood(v.gain, voxTmpP);
      if (v.aliveCount === 0) {
        v.gone = true;
        v.group.remove(inst);
        const si = shootable.indexOf(inst);
        if (si >= 0) shootable.splice(si, 1);
        inst.geometry.dispose();
        (inst.material as THREE.Material).dispose();
        inst.dispose();
        v.inst = null;
        for (const r of v.solidRefs) {
          const i = solids.indexOf(r);
          if (i >= 0) solids.splice(i, 1);
        }
        v.solidRefs.length = 0;
        if (v.barGroup) {
          disposeBar(v.barGroup);
          v.barGroup = null;
          v.barFill = null;
          v.barTimer = 0;
        }
        // Fully carved out on its own (no collapse involved): same
        // demolition fanfare as the BR-web version.
        if (!v.collapsed) {
          v.collapsed = true;
          playSfx('shatter');
          const anchor = voxBarAnchor(v, voxTmpP).clone();
          anchor.y += 0.5;
          showDamagePopup('💥 DESTROYED', anchor, '#ef4444', true);
          const ring = new THREE.Mesh(
            shockGeo,
            new THREE.MeshBasicMaterial({ color: 0x9ca3af, transparent: true, opacity: 0.5, depthWrite: false })
          );
          ring.position.set(anchor.x, groundAt(anchor.x, anchor.z) + 0.1, anchor.z);
          scene.add(ring);
          effects.push({ kind: 'shock', mesh: ring, t: 0, life: 0.35, radius: Math.max(v.nx * v.sx, v.nz * v.sz) * 1.5 });
        }
      }
    }

    // Re-derive movement / grenade collision from surviving voxels: every vertical
    // run of chunks in a column becomes one box; identical columns merge along x
    function rebuildSolids(v: VoxelBox) {
      v.deadSinceBuild = 0;
      for (const r of v.solidRefs) {
        const i = solids.indexOf(r);
        if (i >= 0) solids.splice(i, 1);
      }
      v.solidRefs.length = 0;
      if (v.gone || v.aliveCount === 0) return;
      const { nx, ny, nz, sx, sy, sz, x0, y0, z0 } = v;
      const spansAt = (i: number, k: number) => {
        const out: number[] = [];
        let j0 = -1;
        for (let j = 0; j < ny; j++) {
          if (v.alive[i + nx * (j + ny * k)]) {
            if (j0 < 0) j0 = j;
          } else if (j0 >= 0) {
            out.push(j0 * 256 + (j - 1));
            j0 = -1;
          }
        }
        if (j0 >= 0) out.push(j0 * 256 + (ny - 1));
        return out;
      };
      for (let k = 0; k < nz; k++) {
        let runI = 0;
        let runSpans: number[] | null = null;
        for (let i = 0; i <= nx; i++) {
          const spans = i < nx ? spansAt(i, k) : null;
          const prev: number[] | null = runSpans;
          const same = !!(spans && prev && spans.length === prev.length && spans.every((s, q) => s === prev[q]));
          if (!same) {
            if (runSpans) {
              for (const s of runSpans) {
                const j0 = (s / 256) | 0;
                const j1 = s % 256;
                v.solidRefs.push({
                  x: x0 + (runI + (i - runI) / 2) * sx,
                  z: z0 + (k + 0.5) * sz,
                  hx: ((i - runI) * sx) / 2,
                  hz: sz / 2,
                  top: y0 + (j1 + 1) * sy,
                  bottom: y0 + j0 * sy,
                  group: v.group,
                });
              }
            }
            runI = i;
            runSpans = spans;
          }
        }
      }
      for (const r of v.solidRefs) solids.push(r);
    }

    // Bullets chip the voxel they strike
    function chipVoxelAtPoint(v: VoxelBox, p: THREE.Vector3, dmg: number) {
      if (v.gone || v.aliveCount === 0) return;
      ensureInstanced(v);
      const i = Math.min(v.nx - 1, Math.max(0, Math.floor((p.x - v.x0) / v.sx)));
      const j = Math.min(v.ny - 1, Math.max(0, Math.floor((p.y - v.y0) / v.sy)));
      const k = Math.min(v.nz - 1, Math.max(0, Math.floor((p.z - v.z0) / v.sz)));
      const idx = i + v.nx * (j + v.ny * k);
      if (!v.alive[idx]) return;
      v.hp[idx] -= dmg;
      // Fortnite-style feedback: damage number, health bar, hit SFX
      noteVoxDamage(v, dmg, p);
      if (v.hp[idx] <= 0) {
        const slot = v.slotOf[idx];
        if (slot >= 0) killVoxel(v, slot, 2);
        if (v.deadSinceBuild >= Math.max(2, v.total >> 5)) rebuildSolids(v);
      }
    }

    // A blast eats voxel chunks out of every structure within reach
    function carveBlast(x: number, y: number, z: number, radius: number, dmg: number) {
      const r = Math.min(radius * 0.4, 3.6);
      const r2 = r * r;
      for (const v of voxBoxes) {
        if (v.gone) continue;
        const x1 = v.x0 + v.nx * v.sx;
        const y1 = v.y0 + v.ny * v.sy;
        const z1 = v.z0 + v.nz * v.sz;
        const dx = Math.max(v.x0 - x, 0, x - x1);
        const dy = Math.max(v.y0 - y, 0, y - y1);
        const dz = Math.max(v.z0 - z, 0, z - z1);
        if (dx * dx + dy * dy + dz * dz > r2) continue;
        ensureInstanced(v);
        let changed = false;
        let acc = 0;
        for (let s = 0; s < v.aliveCount; s++) {
          const idx = v.order[s];
          voxCenter(v, idx, voxTmpP);
          const dxc = voxTmpP.x - x;
          const dyc = voxTmpP.y - y;
          const dzc = voxTmpP.z - z;
          const d2 = dxc * dxc + dyc * dyc + dzc * dzc;
          if (d2 >= r2) continue;
          const d = Math.sqrt(d2);
          const hit = dmg * (1 - d / r);
          v.hp[idx] -= hit;
          acc += hit;
          if (v.hp[idx] <= 0) {
            killVoxel(v, s, d < r * 0.35 ? 3 : d < r * 0.7 ? 2 : 1);
            s--;
            changed = true;
          }
        }
        if (changed) rebuildSolids(v);
        // Total demolition damage pops once per structure (same as BR-web)
        if (acc > 0) noteVoxDamage(v, acc);
      }
    }

    // Line-of-sight test: any solid box between the blast and its target eats the damage,
    // so taking cover behind a wall really protects you (until the wall is blown apart)
    function blastClear(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
      const dx = x1 - x0;
      const dy = y1 - y0;
      const dz = z1 - z0;
      for (const b of solids) {
        const bot = b.bottom ?? 0;
        let tmin = 0;
        let tmax = 1;
        const slab = (lo: number, hi: number, o: number, d: number) => {
          if (Math.abs(d) < 1e-9) return o >= lo && o <= hi;
          let tA = (lo - o) / d;
          let tB = (hi - o) / d;
          if (tA > tB) {
            const tt = tA;
            tA = tB;
            tB = tt;
          }
          if (tA > tmin) tmin = tA;
          if (tB < tmax) tmax = tB;
          return tmin <= tmax;
        };
        if (!slab(b.x - b.hx, b.x + b.hx, x0, dx)) continue;
        if (!slab(b.z - b.hz, b.z + b.hz, z0, dz)) continue;
        if (!slab(bot, b.top, y0, dy)) continue;
        return false; // a structure stands between blast and target
      }
      return true;
    }

    // Fire zones respect cover too: deep inside the flames you always burn,
    // at the rim a wall between you and the fire shields you
    function fireClear(ex: number, ez: number, dd: number, deepR: number, tx: number, ty: number, tz: number) {
      if (dd <= deepR) return true;
      const ux = (tx - ex) / dd;
      const uz = (tz - ez) / dd;
      const px = ex + ux * deepR;
      const pz = ez + uz * deepR;
      return blastClear(px, groundAt(px, pz) + 0.45, pz, tx, ty, tz);
    }

    interface DebrisPiece {
      mesh: THREE.Mesh;
      vx: number;
      vy: number;
      vz: number;
      rx: number;
      ry: number;
      t: number;
      life: number;
      s: number;
      on: boolean;
    }
    const debrisGeo = new THREE.BoxGeometry(1, 1, 1);
    const debrisPool: DebrisPiece[] = [];
    const DEBRIS_MAX = 130;

    function spawnDebris(
      x: number,
      y: number,
      z: number,
      color: THREE.Color,
      n: number,
      scale = 1,
      vel?: { vx: number; vy: number; vz: number }
    ) {
      for (let q = 0; q < n; q++) {
        let p = debrisPool.find((d) => !d.on);
        if (!p) {
          if (debrisPool.length >= DEBRIS_MAX) return;
          p = {
            mesh: new THREE.Mesh(debrisGeo, new THREE.MeshLambertMaterial({ color: 0xffffff })),
            vx: 0,
            vy: 0,
            vz: 0,
            rx: 0,
            ry: 0,
            t: 0,
            life: 1,
            s: 0.25,
            on: false,
          };
          world.add(p.mesh);
          debrisPool.push(p);
        }
        p.on = true;
        p.t = 0;
        p.life = 0.9 + Math.random() * 0.7;
        p.s = (0.18 + Math.random() * 0.2) * scale;
        p.mesh.visible = true;
        p.mesh.position.set(x, y, z);
        p.mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
        p.mesh.scale.setScalar(p.s);
        (p.mesh.material as THREE.MeshLambertMaterial).color.copy(color).multiplyScalar(0.7 + Math.random() * 0.55);
        if (vel) {
          p.vx = vel.vx;
          p.vy = vel.vy;
          p.vz = vel.vz;
        } else {
          const a = Math.random() * Math.PI * 2;
          const sp = 1.5 + Math.random() * 4;
          p.vx = Math.cos(a) * sp;
          p.vz = Math.sin(a) * sp;
          p.vy = 2.5 + Math.random() * 5;
        }
        p.rx = (Math.random() - 0.5) * 16;
        p.ry = (Math.random() - 0.5) * 16;
      }
    }

    function updateDebris(dt: number) {
      for (const p of debrisPool) {
        if (!p.on) continue;
        p.t += dt;
        if (p.t >= p.life) {
          p.on = false;
          p.mesh.visible = false;
          continue;
        }
        p.vy -= 22 * dt;
        p.mesh.position.x += p.vx * dt;
        p.mesh.position.y += p.vy * dt;
        p.mesh.position.z += p.vz * dt;
        const g = groundAt(p.mesh.position.x, p.mesh.position.z) + p.s * 0.5;
        if (p.mesh.position.y < g) {
          p.mesh.position.y = g;
          if (p.vy < 0) p.vy = -p.vy * 0.35;
          p.vx *= 0.6;
          p.vz *= 0.6;
          p.rx *= 0.5;
          p.ry *= 0.5;
        }
        p.mesh.rotation.x += p.rx * dt;
        p.mesh.rotation.y += p.ry * dt;
        p.mesh.scale.setScalar(p.s * Math.min(1, (p.life - p.t) / (p.life * 0.35)));
      }
    }

    function resetVox() {
      resetBuildables();
      // Player-built voxel pieces (walls / floors / ramps / door panels)
      // live in the scene rather than the world group, so clear their
      // meshes — and the staircase-stacking registry — here too.
      stairPieces.length = 0;
      stairRamps.length = 0;
      for (const m of playerBuiltVox) {
        m.parent?.remove(m);
        m.geometry.dispose();
      }
      playerBuiltVox.length = 0;
      for (const v of voxBoxes) {
        if (v.inst) {
          v.group.remove(v.inst);
          const si = shootable.indexOf(v.inst);
          if (si >= 0) shootable.splice(si, 1);
          v.inst.geometry.dispose();
          (v.inst.material as THREE.Material).dispose();
          v.inst.dispose();
          v.inst = null;
        }
        for (const r of v.solidRefs) {
          const i = solids.indexOf(r);
          if (i >= 0) solids.splice(i, 1);
        }
        v.solidRefs.length = 0;
        v.gone = true;
        if (v.barGroup) {
          disposeBar(v.barGroup);
          v.barGroup = null;
          v.barFill = null;
          v.barTimer = 0;
        }
      }
      voxBoxes.length = 0;
      for (const p of debrisPool) {
        p.on = false;
        p.mesh.visible = false;
      }
    }

    // ----------------------------------------------------
    // Fortnite-Style Destruction Feedback (ported from BR-web)
    // Procedural Web Audio SFX, floating damage numbers,
    // structure health bars and structural collapse — layered
    // on top of the voxel system so carved-out structures
    // still show their remaining integrity before failing.
    // ----------------------------------------------------

    // Procedural Web Audio Synthesizer (Zero External Dependencies)
    let audioCtx: AudioContext | null = null;
    function getAudio(): AudioContext | null {
      if (!audioCtx && typeof window !== 'undefined') {
        const AudioCtor = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioCtor) audioCtx = new AudioCtor();
      }
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
      return audioCtx;
    }

    function playSfx(kind: 'shatter' | 'cover_block' | 'wood_hit' | 'build') {
      const ctx = getAudio();
      if (!ctx) return;
      const t = ctx.currentTime;
      if (kind === 'cover_block') {
        // Heavy shielded wall thud: wall intercepts grenade blast
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(150, t);
        osc.frequency.exponentialRampToValueAtTime(45, t + 0.24);
        gain.gain.setValueAtTime(0.4, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.25);

        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(320, t);
        osc2.frequency.exponentialRampToValueAtTime(160, t + 0.32);
        gain2.gain.setValueAtTime(0.25, t);
        gain2.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.start(t);
        osc2.stop(t + 0.33);
      } else if (kind === 'shatter') {
        // Deep crumbling voxel demolition crash
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(130, t);
        osc.frequency.exponentialRampToValueAtTime(28, t + 0.4);
        gain.gain.setValueAtTime(0.4, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.42);

        // Noise buffer for scattering debris chunks
        try {
          const bufSize = Math.floor(ctx.sampleRate * 0.35);
          const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
          const data = buf.getChannelData(0);
          for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
          const noise = ctx.createBufferSource();
          noise.buffer = buf;
          const filt = ctx.createBiquadFilter();
          filt.type = 'bandpass';
          filt.frequency.setValueAtTime(900, t);
          filt.frequency.exponentialRampToValueAtTime(180, t + 0.35);
          const nGain = ctx.createGain();
          nGain.gain.setValueAtTime(0.3, t);
          nGain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
          noise.connect(filt);
          filt.connect(nGain);
          nGain.connect(ctx.destination);
          noise.start(t);
        } catch {
          // Fallback if audio buffer fails
        }
      } else if (kind === 'wood_hit') {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(380, t);
        osc.frequency.exponentialRampToValueAtTime(90, t + 0.08);
        gain.gain.setValueAtTime(0.2, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.09);
      } else if (kind === 'build') {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(180, t);
        osc.frequency.exponentialRampToValueAtTime(360, t + 0.12);
        gain.gain.setValueAtTime(0.25, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.13);
      }
    }

    // Floating 3D Damage Numbers (Fortnite Style)
    interface DamagePopup {
      sprite: THREE.Sprite;
      texture: THREE.CanvasTexture;
      mat: THREE.SpriteMaterial;
      t: number;
      life: number;
      vy: number;
    }
    const damagePopups: DamagePopup[] = [];

    function showDamagePopup(text: string, pos: THREE.Vector3, color = '#facc15', isBig = false) {
      if (typeof document === 'undefined') return;
      if (damagePopups.length > 60) return; // soft cap for sustained fire
      const cvs = document.createElement('canvas');
      cvs.width = 256;
      cvs.height = 128;
      const c = cvs.getContext('2d');
      if (!c) return;
      c.clearRect(0, 0, 256, 128);
      c.font = isBig ? 'bold 50px "Barlow Condensed", Arial, sans-serif' : 'bold 40px "Barlow Condensed", Arial, sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.shadowColor = 'rgba(0,0,0,0.85)';
      c.shadowBlur = 6;
      c.shadowOffsetX = 2;
      c.shadowOffsetY = 2;
      c.fillStyle = color;
      c.fillText(text, 128, 64);
      const texture = new THREE.CanvasTexture(cvs);
      texture.minFilter = THREE.LinearFilter;
      const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
      const sprite = new THREE.Sprite(mat);
      const scale = isBig ? 1.6 : 1.2;
      sprite.scale.set(scale * 2, scale, 1);
      sprite.position.copy(pos);
      sprite.position.y += 0.6 + Math.random() * 0.3;
      sprite.position.x += (Math.random() - 0.5) * 0.4;
      sprite.position.z += (Math.random() - 0.5) * 0.4;
      scene.add(sprite);
      damagePopups.push({ sprite, texture, mat, t: 0, life: 1.1, vy: 1.6 });
    }

    function disposeDamagePopup(p: DamagePopup) {
      p.sprite.parent?.remove(p.sprite);
      p.mat.dispose();
      p.texture.dispose();
    }

    // World-space structure health bar shared by voxel boxes and built walls
    function makeHealthBar(): { group: THREE.Group; fill: THREE.Mesh } {
      const g = new THREE.Group();
      const bgGeo = new THREE.PlaneGeometry(1.6, 0.16);
      const bgMat = new THREE.MeshBasicMaterial({ color: 0x090d14, side: THREE.DoubleSide });
      const bg = new THREE.Mesh(bgGeo, bgMat);
      g.add(bg);
      const fillGeo = new THREE.PlaneGeometry(1.56, 0.12);
      const fillMat = new THREE.MeshBasicMaterial({ color: 0x22c55e, side: THREE.DoubleSide });
      const fill = new THREE.Mesh(fillGeo, fillMat);
      fill.position.z = 0.01;
      g.add(fill);
      return { group: g, fill };
    }

    function setBarFill(fill: THREE.Mesh, pct: number) {
      const p = Math.max(0, Math.min(1, pct));
      fill.scale.x = p;
      fill.position.x = -(1 - p) * 0.78;
      const col = p > 0.5 ? 0x22c55e : p > 0.25 ? 0xf59e0b : 0xef4444;
      (fill.material as THREE.MeshBasicMaterial).color.setHex(col);
    }

    function disposeBar(g: THREE.Group | null) {
      if (!g) return;
      g.parent?.remove(g);
      g.traverse((o: any) => {
        o.geometry?.dispose?.();
        o.material?.dispose?.();
      });
    }

    // VoxelBox aggregate integrity: health bar + collapse
    function voxBarAnchor(v: VoxelBox, out: THREE.Vector3) {
      out.set(v.x0 + (v.nx * v.sx) / 2, v.y0 + v.ny * v.sy, v.z0 + (v.nz * v.sz) / 2);
      return out;
    }

    function voxShowBar(v: VoxelBox) {
      if (!v.barGroup) {
        const { group, fill } = makeHealthBar();
        voxBarAnchor(v, voxTmpP);
        group.position.set(voxTmpP.x, voxTmpP.y + 0.35, voxTmpP.z);
        scene.add(group);
        v.barGroup = group;
        v.barFill = fill;
      }
      v.barTimer = 3.0;
      if (v.barFill) setBarFill(v.barFill, 1 - v.dmgTaken / v.poolHp);
    }

    /**
     * Register structural damage against a voxel structure: pops a damage
     * number, shows the health bar and collapses the structure once its
     * integrity pool has been gutted past the point of no return.
     */
    function noteVoxDamage(v: VoxelBox, amount: number, pos?: THREE.Vector3) {
      if (v.gone || amount <= 0) return;
      v.dmgTaken = Math.min(v.poolHp, v.dmgTaken + amount);
      const frac = 1 - v.dmgTaken / v.poolHp;
      const shown = Math.round(amount);
      if (shown > 0) {
        const anchor = pos ?? voxBarAnchor(v, voxTmpP);
        const isCrit = shown >= 120;
        showDamagePopup(`${shown}`, anchor, isCrit ? '#f59e0b' : '#fde047', isCrit);
      }
      voxShowBar(v);
      playSfx('wood_hit');
      if (frac <= 0.25 && !v.collapsed) collapseVoxBox(v);
    }

    // Fortnite-style structural collapse: a mostly-destroyed structure
    // loses cohesion and the surviving chunks rain down as debris.
    function collapseVoxBox(v: VoxelBox) {
      if (v.gone || v.collapsed) return;
      v.collapsed = true;
      playSfx('shatter');
      const anchor = voxBarAnchor(v, voxTmpP).clone();
      anchor.y += 0.5;
      showDamagePopup('💥 DESTROYED', anchor, '#ef4444', true);
      const ring = new THREE.Mesh(
        shockGeo,
        new THREE.MeshBasicMaterial({ color: 0x9ca3af, transparent: true, opacity: 0.5, depthWrite: false })
      );
      ring.position.set(anchor.x, groundAt(anchor.x, anchor.z) + 0.1, anchor.z);
      scene.add(ring);
      effects.push({ kind: 'shock', mesh: ring, t: 0, life: 0.35, radius: Math.max(v.nx * v.sx, v.nz * v.sz) * 1.5 });
      ensureInstanced(v);
      let guard = v.aliveCount + 1;
      while (v.aliveCount > 0 && guard-- > 0) {
        killVoxel(v, v.aliveCount - 1, Math.random() < 0.12 ? 2 : 1);
      }
    }

    // ----------------------------------------------------
    // Player-Built Fortnite Walls (whole-object destructibles,
    // same kind as the BR-web repo: 250 HP, health bar, damage
    // numbers, shatters into voxel debris chunks)
    // ----------------------------------------------------
    interface BuiltWall {
      id: string;
      mesh: THREE.Object3D;
      solid: SolidBox;
      hp: number;
      maxHp: number;
      kind: 'crate' | 'wood' | 'building' | 'brick' | 'metal';
      color: number | THREE.Color;
      bounds: { x: number; y: number; z: number; w: number; h: number; d: number };
      barGroup?: THREE.Group;
      barFill?: THREE.Mesh;
      barTimer?: number;
    }

    const wallDests = new Map<THREE.Object3D, BuiltWall>();
    const solidToWall = new Map<SolidBox, BuiltWall>();

    function registerWallDest(dest: BuiltWall) {
      wallDests.set(dest.mesh, dest);
      solidToWall.set(dest.solid, dest);
      dest.mesh.userData.wallDest = dest;
      // Also register children if group
      dest.mesh.traverse((child) => {
        child.userData.wallDest = dest;
      });
    }

    function showWallBar(dest: BuiltWall) {
      if (!dest.barGroup) {
        const { group, fill } = makeHealthBar();
        group.position.set(dest.bounds.x, dest.bounds.y + dest.bounds.h / 2 + 0.35, dest.bounds.z);
        scene.add(group);
        dest.barGroup = group;
        dest.barFill = fill;
      }
      dest.barTimer = 3.0;
      if (dest.barFill) setBarFill(dest.barFill, dest.hp / dest.maxHp);
    }

    function damageWall(
      dest: BuiltWall,
      amount: number,
      hitPoint?: THREE.Vector3,
      blastOrigin?: { x: number; y: number; z: number }
    ) {
      if (dest.hp <= 0 || amount <= 0) return;
      dest.hp = Math.max(0, dest.hp - amount);
      const pos = hitPoint
        ? hitPoint.clone()
        : new THREE.Vector3(dest.bounds.x, dest.bounds.y, dest.bounds.z);

      // Popup damage text
      const isCrit = amount >= 120;
      showDamagePopup(`${Math.round(amount)}`, pos, isCrit ? '#f59e0b' : '#fde047', isCrit);
      showWallBar(dest);

      // Small voxel chips flying off the impact
      const chipCount = Math.min(6, Math.max(2, Math.round(amount / 30)));
      spawnDebris(pos.x, pos.y, pos.z, new THREE.Color(dest.color as number), chipCount);

      playSfx('wood_hit');

      if (dest.hp <= 0) {
        destroyWall(dest, blastOrigin ?? { x: pos.x, y: pos.y, z: pos.z });
      }
    }

    function damageWallBySolid(
      solidBox: SolidBox,
      amount: number,
      blastOrigin?: { x: number; y: number; z: number }
    ) {
      const dest = solidToWall.get(solidBox);
      if (dest) damageWall(dest, amount, undefined, blastOrigin);
    }

    function destroyWall(dest: BuiltWall, blastOrigin?: { x: number; y: number; z: number }) {
      playSfx('shatter');
      const origin = blastOrigin ?? { x: dest.bounds.x, y: dest.bounds.y, z: dest.bounds.z };
      showDamagePopup('💥 DESTROYED', new THREE.Vector3(dest.bounds.x, dest.bounds.y + 0.5, dest.bounds.z), '#ef4444', true);

      // 1. Remove solid from collision immediately so player and projectiles can pass through
      const sIdx = solids.indexOf(dest.solid);
      if (sIdx !== -1) solids.splice(sIdx, 1);
      solidToWall.delete(dest.solid);

      // 2. Remove mesh from shootables and its parent (world or scene)
      dest.mesh.traverse((obj) => {
        const shIdx = shootable.indexOf(obj);
        if (shIdx !== -1) shootable.splice(shIdx, 1);
      });
      dest.mesh.parent?.remove(dest.mesh);
      wallDests.delete(dest.mesh);

      // Clean up health bar
      if (dest.barGroup) {
        disposeBar(dest.barGroup);
        dest.barGroup = undefined;
        dest.barFill = undefined;
      }

      // 3. Generate physical 3D voxel debris chunks
      const b = dest.bounds;
      const countX = Math.max(2, Math.min(4, Math.round(b.w / 0.7)));
      const countY = Math.max(2, Math.min(4, Math.round(b.h / 0.7)));
      const countZ = Math.max(1, Math.min(3, Math.round(b.d / 0.7)));
      const sizeX = b.w / countX;
      const sizeY = b.h / countY;
      const sizeZ = b.d / countZ;
      const chunkScale = Math.min(3.5, Math.max(1, Math.max(sizeX, sizeY, sizeZ) / 0.28));

      for (let ix = 0; ix < countX; ix++) {
        for (let iy = 0; iy < countY; iy++) {
          for (let iz = 0; iz < countZ; iz++) {
            const vx0 = b.x - b.w / 2 + (ix + 0.5) * sizeX + (Math.random() - 0.5) * 0.05;
            const vy0 = b.y - b.h / 2 + (iy + 0.5) * sizeY + (Math.random() - 0.5) * 0.05;
            const vz0 = b.z - b.d / 2 + (iz + 0.5) * sizeZ + (Math.random() - 0.5) * 0.05;
            const impulse = calculateVoxelImpulse({ x: vx0, y: vy0, z: vz0 }, origin, 8.5 + Math.random() * 5.0, 3.6);
            spawnDebris(vx0, vy0, vz0, new THREE.Color(dest.color as number), 1, chunkScale, {
              vx: impulse.x,
              vy: impulse.y,
              vz: impulse.z,
            });
          }
        }
      }

      // Debris shockwave ring on ground
      const ring = new THREE.Mesh(
        shockGeo,
        new THREE.MeshBasicMaterial({ color: 0x9ca3af, transparent: true, opacity: 0.5, depthWrite: false })
      );
      ring.position.set(b.x, groundAt(b.x, b.z) + 0.1, b.z);
      scene.add(ring);
      effects.push({ kind: 'shock', mesh: ring, t: 0, life: 0.35, radius: Math.max(b.w, b.d) * 1.5 });
    }

    // Fortnite Wooden Wall Construction — fully VOXEL now: the wall is
    // nine solid wood boxes (2 posts, sill, header, mid-beam, 4 planks),
    // each registered into the voxel grid, so bullets chip chunks out
    // of it and grenades carve holes straight through your cover. The
    // whole-object wallDests path is retired for player walls. Walls
    // snap to the nearest cardinal so every panel's voxel lattice
    // matches its visual exactly (grid-style building).
    function buildFortniteWall(x: number, y: number, z: number, angleY: number) {
      const ca = Math.cos(angleY);
      const sa = Math.sin(angleY);
      const latX = ca; // wall runs along this lateral axis
      const latZ = -sa;
      const o = { silent: true, vox: 0.32 };
      // corner posts
      for (const side of [-1, 1]) {
        addVoxSolid(x + latX * 1.48 * side, y, y + 2.6, z + latZ * 1.48 * side, 0.24, 0.24, bmBuildBeam, angleY, o);
      }
      // sill + header + mid-beam (replaces the old diagonal brace —
      // chunky voxel walls are stack-built, not braced)
      addVoxSolid(x, y, y + 0.18, z, 3.2, 0.24, bmBuildBeam, angleY, o);
      addVoxSolid(x, y + 2.38, y + 2.6, z, 3.2, 0.24, bmBuildBeam, angleY, o);
      addVoxSolid(x, y + 1.21, y + 1.36, z, 3.2, 0.16, bmBuildBeam, angleY, o);
      // 4 horizontal wood planks
      for (let p = 0; p < 4; p++) {
        const y0 = y + 0.22 + p * 0.52;
        const jx = p % 2 === 0 ? 0.02 : -0.02;
        addVoxSolid(x + jx * latX, y0, y0 + 0.46, z + jx * latZ, 2.76, 0.14, bmBuildWood, angleY, o);
      }
      playSfx('build');
    }

    // Build Mode State & Hologram Blueprint Preview
    let buildMode = false;
    const blueprintMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.45,
      wireframe: true,
      depthWrite: false,
    });
    const previewMesh = new THREE.Mesh(new THREE.BoxGeometry(3.2, 2.6, 0.35), blueprintMat);
    previewMesh.visible = false;
    scene.add(previewMesh);

    function toggleBuildWall(forceState?: boolean) {
      if (!running() || playerDown) return;
      buildMode = forceState !== undefined ? forceState : !buildMode;
      previewMesh.visible = buildMode;
      const buildBtnEl = $('buildWallBtn');
      if (buildBtnEl) buildBtnEl.classList.toggle('active', buildMode);
      const touchBuildEl = $('touchBuildBtn');
      if (touchBuildEl) touchBuildEl.classList.toggle('active', buildMode);

      if (buildMode) {
        // When putting up a wall, the character CANNOT have a weapon in their hand
        if (current) {
          current.gun.visible = false;
          current.flare.visible = false;
        }
        if (aimBtn) {
          aimBtn.textContent = 'BUILD';
          aimBtn.classList.add('build-active');
        }
        const p = BUILD_PIECES[buildPieceIdx];
        showMessage(
          p.kind === 'auto'
            ? '🎯 Auto build: look up = ladder · look straight up ON a staircase = another staircase on top · look forward = wall · look down on the ground = ramp · look down from a ramp / structure = platform. [LEFT CLICK / TAP AIM] place' +
                (terrainOn ? ' · 🪵 ' + (PIECE_COST[resolvedBuildKind()] ?? 10) + ' wood' : '')
            : p.icon + ' ' + p.label + ': [LEFT CLICK / TAP AIM] place (' + p.hp + ' HP voxel)' +
                (terrainOn ? ' · 🪵 ' + (PIECE_COST[p.kind] ?? 10) + ' wood' : '') + ' · [Wheel / T / double-tap WALL] cycle piece · [V / RIGHT CLICK] cancel',
          p.kind === 'auto' ? 5 : 3.2
        );
        setPreviewGeometry(resolvedBuildKind());
        updateBuildHud();
        playSfx('build');
      } else {
        setStatus('');
        if (aimBtn) {
          aimBtn.textContent = 'AIM';
          aimBtn.classList.remove('build-active');
        }
        if (current) {
          current.gun.visible = !scopeEl?.classList.contains('on');
        }
      }
    }

    // ----------------------------------------------------
    // Fortnite Build Pieces — Wall, Door Wall, Floor, Ramp, Ladder.
    // V cycles build mode, mouse wheel or T cycles the piece.
    // Wall / Door are whole-object built walls; Floor / Ramp / Ladder
    // are voxel-chippable planks so grenades can blow holes in them.
    // ----------------------------------------------------
    const BUILD_PIECES = [
      { kind: 'auto', icon: '🎯', label: 'Auto Piece', hp: 250 },
      { kind: 'wall', icon: '🧱', label: 'Wall Cover', hp: 250 },
      { kind: 'door', icon: '🚪', label: 'Door Wall', hp: 250 },
      { kind: 'floor', icon: '🟫', label: 'Floor', hp: 300 },
      { kind: 'ramp', icon: '📐', label: 'Ramp', hp: 300 },
      { kind: 'ladder', icon: '🪜', label: 'Ladder', hp: 300 },
    ];
    let buildPieceIdx = 0;
    const PIECE_PREVIEW: Record<string, [number, number, number]> = {
      wall: [3.2, 2.6, 0.35],
      door: [3.2, 2.6, 0.35],
      floor: [3, 0.3, 3],
      ramp: [3, 1.05, 2.7],
      ladder: [0.9, 3.4, 1.2],
    };

    // Aim-directed building (mobile-first): the default Auto piece reads your
    // pitch and footing so ONE button covers every structure mid-fight —
    //   look straight up ON a staircase -> another staircase stacks on top
    //   look up                     -> Ladder (bolt one onto any wall)
    //   look forward               -> Wall
    //   look down, on the ground   -> Ramp (run up it)
    //   look down, elevated / air  -> Floor platform (on a ramp, container,
    //                                 roof, or mid-air to bridge a gap)
    const STAIR_STACK_PITCH = 1.25; // ~72° up — the straight-up zone (pitch clamps at 1.5)

    // One built staircase: its step boxes + voxel lattices (so a gutted
    // stair stops counting) and where the NEXT one continues from.
    interface RampRec {
      boxes: SolidBox[];
      voxes: VoxelBox[];
      angleY: number;
      endX: number;
      endZ: number;
      topEnd: number;
    }
    const stairRamps: RampRec[] = [];

    // Standing on a built staircase step? Returns the ramp record (its
    // end + top continue the next staircase seamlessly) or null.
    function onStaircase(): RampRec | null {
      const feetY = camera.position.y - eyeH;
      for (const rec of stairRamps) {
        for (let i = 0; i < rec.boxes.length; i++) {
          const v = rec.voxes[i];
          if (!v || v.gone) continue;
          const b = rec.boxes[i];
          if (Math.abs(feetY - b.top) > 0.55) continue;
          if (Math.abs(camera.position.x - b.x) > b.hx + 0.5) continue;
          if (Math.abs(camera.position.z - b.z) > b.hz + 0.5) continue;
          return rec;
        }
      }
      return null;
    }

    function resolvedBuildKind() {
      const cur = BUILD_PIECES[buildPieceIdx].kind;
      if (cur !== 'auto') return cur;
      if (pitch > STAIR_STACK_PITCH && onStaircase()) return 'ramp'; // stack another staircase
      if (pitch > 0.5) return 'ladder';
      if (pitch > -0.45) return 'wall';
      const feetY = camera.position.y - eyeH;
      const elevated = !grounded || feetY - groundAt(camera.position.x, camera.position.z) > 0.6;
      return elevated ? 'floor' : 'ramp';
    }

    function pieceFor(kind: string) {
      return BUILD_PIECES.find((p) => p.kind === kind) || BUILD_PIECES[1];
    }

    let lastPreviewKind = '';
    // Swap the hologram geometry when the resolved piece changes; returns
    // true on a swap so callers can refresh the HUD chip too.
    function setPreviewGeometry(kind: string) {
      if (kind === lastPreviewKind) return false;
      lastPreviewKind = kind;
      const g = PIECE_PREVIEW[kind];
      previewMesh.geometry.dispose();
      previewMesh.geometry = new THREE.BoxGeometry(g[0], g[1], g[2]);
      return true;
    }

    function updateBuildHud() {
      const auto = BUILD_PIECES[buildPieceIdx].kind === 'auto';
      const p = auto ? pieceFor(resolvedBuildKind()) : BUILD_PIECES[buildPieceIdx];
      const nameEl = $('buildWallName');
      if (nameEl) nameEl.textContent = (auto ? '🎯 ' : '') + p.icon + ' ' + p.label;
      const stateEl = $('buildWallState');
      if (stateEl)
        stateEl.textContent = auto
          ? 'Voxel ' + p.hp + ' HP' + (terrainOn ? ' · 🪵' + (PIECE_COST[resolvedBuildKind()] ?? 10) : '') + ' · up = ladder · straight-up on stairs = stack · forward = wall · down = ramp / floor'
          : 'Voxel ' + p.hp + ' HP' + (terrainOn ? ' · 🪵' + (PIECE_COST[p.kind] ?? 10) : '') + ' · wheel / T cycles piece';
      const tIcon = $('buildPieceIcon');
      if (tIcon) tIcon.textContent = p.icon;
      const tLabel = $('buildPieceLabel');
      if (tLabel) tLabel.textContent = p.label.split(' ')[0];
    }

    function cycleBuildPiece(dir = 1) {
      buildPieceIdx = (buildPieceIdx + dir + BUILD_PIECES.length) % BUILD_PIECES.length;
      const p = BUILD_PIECES[buildPieceIdx];
      if (p.kind === 'auto') {
        setPreviewGeometry(resolvedBuildKind());
        updateBuildHud();
        if (buildMode)
          showMessage('🎯 Auto piece: your aim decides — up = ladder, straight-up on a staircase = stack another, forward = wall, down on the ground = ramp, down from a ramp / structure = platform', 2.4);
        return;
      }
      setPreviewGeometry(p.kind);
      updateBuildHud();
      if (buildMode) showMessage(p.icon + ' ' + p.label + ' selected (' + p.hp + ' HP) — aim & click to place', 1.8);
    }

    // Player-built voxel piece (floor / ramp / door panel / wall plank):
    // a plain solid box mesh with its own AABB, registered into the
    // voxel grid so bullets chip it and blasts carve chunks out of it.
    // `opts.tag = 'stair'` marks ramp steps so the look-straight-up
    // stacking gesture can find them; `opts.silent` batches the build
    // SFX for multi-piece builds; `opts.vox` picks a chunkier lattice.
    const playerBuiltVox: THREE.Mesh[] = [];
    const stairPieces: Array<{ sb: SolidBox; vox: VoxelBox }> = [];
    function addVoxSolid(
      x: number,
      y0: number,
      y1: number,
      z: number,
      w: number,
      d: number,
      mat: THREE.Material,
      angleY = 0,
      opts?: { silent?: boolean; vox?: number; tag?: 'stair' }
    ) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, y1 - y0, d), mat);
      mesh.position.set(x, (y0 + y1) / 2, z);
      mesh.rotation.y = angleY;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      const ca = Math.abs(Math.cos(angleY));
      const sa = Math.abs(Math.sin(angleY));
      const sb: SolidBox = {
        x,
        z,
        hx: Math.max(0.12, (w / 2) * ca + (d / 2) * sa),
        hz: Math.max(0.12, (w / 2) * sa + (d / 2) * ca),
        top: y1,
        bottom: y0,
        group: scene,
        stair: opts?.tag === 'stair',
      };
      solids.push(sb);
      shootable.push(mesh);
      registerDestructible(sb, mesh, mat, opts?.vox);
      playerBuiltVox.push(mesh);
      if (opts?.tag === 'stair' && mesh.userData.vox) stairPieces.push({ sb, vox: mesh.userData.vox });
      if (!opts?.silent) playSfx('build');
      return mesh;
    }

    // Door wall: solid side panels with a passable 1.3 m gap + a header
    // beam above it. Cover you can shoot and run through — all voxel.
    function buildFortniteDoor(x: number, y: number, z: number, angleY: number) {
      const ca = Math.cos(angleY);
      const sa = Math.sin(angleY);
      const off = 1.125;
      const o = { silent: true, vox: 0.32 };
      for (const side of [-1, 1]) {
        addVoxSolid(x + ca * off * side, y, y + 2.45, z - sa * off * side, 0.95, 0.2, bmBuildWood, angleY, o);
      }
      addVoxSolid(x, y + 2.3, y + 2.6, z, 1.3, 0.2, bmBuildBeam, angleY, o);
      playSfx('build');
    }

    // Ramp (staircase): three axis-aligned steps of 0.35 m rise (<=
    // step-up height), so sprinting up it just works with the stairs
    // logic. Each ramp records its run so the look-straight-up gesture
    // can chain the next staircase seamlessly onto this one's end.
    function buildFortniteRamp(x: number, z: number, angleY: number, feetY: number) {
      const dir = Math.abs(Math.sin(angleY)) > Math.abs(Math.cos(angleY))
        ? { x: Math.sign(Math.sin(angleY)) || 1, z: 0 }
        : { x: 0, z: Math.sign(Math.cos(angleY)) || 1 };
      const base = Math.max(feetY, groundAt(x, z) + 0.02);
      const rec: RampRec = { boxes: [], voxes: [], angleY, endX: x + dir.x * 2.7, endZ: z + dir.z * 2.7, topEnd: base + 1.05 };
      for (let i = 0; i < 3; i++) {
        const top = base + 0.35 * (i + 1);
        const m = addVoxSolid(x + dir.x * 0.9 * i, top - 0.4, top, z + dir.z * 0.9 * i, dir.x ? 0.9 : 3, dir.z ? 0.9 : 3, bmPlank, 0, { tag: 'stair' });
        const v = m.userData.vox as VoxelBox | undefined;
        if (v) {
          rec.voxes.push(v);
          rec.boxes.push(v.solidRefs[0]);
        }
      }
      stairRamps.push(rec);
    }

    // Ladder: a 45-degree rung ladder you walk straight up — rungs
    // advance 0.42 m along your facing (ramp-style footprint, so the
    // proven step-up mechanics climb it) and zig-zag laterally so it
    // reads as a ladder. ~6.7 m of climb per placement; stand on a
    // rung and place another to keep going.
    function buildFortniteLadder(x: number, z: number, angleY: number, feetY: number) {
      const base = Math.max(feetY, groundAt(x, z) + 0.02);
      const ca = Math.cos(angleY);
      const sa = Math.sin(angleY);
      for (let i = 0; i < 16; i++) {
        const off = i % 2 === 0 ? -0.34 : 0.34;
        addVoxSolid(x + sa * 0.42 * i + ca * off, base + i * 0.42, base + (i + 1) * 0.42, z + ca * 0.42 * i - sa * off, 0.85, 0.5, bmPlank, angleY, { silent: i > 0 });
      }
    }

    function placeWall() {
      if (!buildMode || !running() || playerDown) return;
      const forward = new THREE.Vector3();
      camera.getWorldDirection(forward);
      forward.y = 0;
      forward.normalize();
      const placeDist = 2.8;
      const px = camera.position.x + forward.x * placeDist;
      const pz = camera.position.z + forward.z * placeDist;
      const rawAngle = Math.atan2(forward.x, forward.z);
      const feetY = camera.position.y - eyeH;
      const kind = resolvedBuildKind();
      const piece = pieceFor(kind);
      // Wooden pieces cost wood in terrain modes (Harbor): the harvest
      // loop — chop trees, build cover. The Test Range stays free.
      if (terrainOn) {
        const cost = PIECE_COST[kind] ?? 10;
        if (woodRes < cost) {
          showMessage('🪵 Not enough wood (' + Math.floor(woodRes) + '/' + cost + ') — shoot or blast trees to harvest more!', 2.6);
          return;
        }
        woodRes -= cost;
        refreshWood();
      }
      // Walls + doors snap to the nearest cardinal (grid-style) so
      // every voxel panel's lattice matches its visual exactly.
      const snapCard = (a: number) => Math.round(a / (Math.PI / 2)) * (Math.PI / 2);
      const angle = kind === 'wall' || kind === 'door' ? snapCard(rawAngle) : rawAngle;
      const rampUnderfoot = onStaircase();
      const stacking = kind === 'ramp' && pitch > STAIR_STACK_PITCH && !!rampUnderfoot;

      if (kind === 'wall') {
        buildFortniteWall(px, groundAt(px, pz), pz, angle);
        showMessage('🧱 Wall deployed! (' + piece.hp + ' HP, voxel) Take cover — bullets chip it, grenades carve it!', 2.5);
      } else if (kind === 'door') {
        buildFortniteDoor(px, groundAt(px, pz), pz, angle);
        showMessage('🚪 Door wall up! Cover with a doorway you control!', 2.5);
      } else if (kind === 'floor') {
        const top = Math.max(feetY, groundAt(px, pz) + 0.05) + 0.06;
        addVoxSolid(px, top - 0.28, top, pz, 3, 3, bmPlank);
        showMessage('🟫 Floor placed! Bridge water or raise a platform!', 2.5);
      } else if (kind === 'ladder') {
        buildFortniteLadder(px, pz, angle, feetY);
        showMessage('🪜 Ladder placed! Walk in and keep moving — you climb it like a stair!', 2.5);
      } else if (stacking && rampUnderfoot) {
        // Continue THIS staircase: the next one starts where it ends, at
        // its top — walk straight up the chain into the sky.
        buildFortniteRamp(rampUnderfoot.endX, rampUnderfoot.endZ, rampUnderfoot.angleY, rampUnderfoot.topEnd);
        showMessage('📐 Another staircase stacks on top — keep climbing!', 2.5);
      } else {
        buildFortniteRamp(px, pz, angle, feetY);
        showMessage('📐 Ramp placed! Run up onto roofs and containers!', 2.5);
      }
      toggleBuildWall(false);
    }

    // Damage whichever structure (voxel or built wall) owns a given solid box —
    // used when a wall eats a grenade blast for whoever hides behind it.
    function damageStructureSolid(
      box: SolidBox,
      amount: number,
      origin: { x: number; y: number; z: number }
    ) {
      if (amount <= 0) return;
      const wall = solidToWall.get(box);
      if (wall) {
        damageWall(wall, amount, undefined, origin);
        return;
      }
      for (const v of voxBoxes) {
        if (v.gone) continue;
        if (v.solidRefs.indexOf(box) !== -1) {
          noteVoxDamage(v, amount);
          return;
        }
      }
    }

    // Per-frame update: floating damage numbers, health bar billboard timers
    // and the build mode hologram preview.
    function updateDestructibles(dt: number) {
      // 1. Update floating damage popups
      for (let i = damagePopups.length - 1; i >= 0; i--) {
        const p = damagePopups[i];
        p.t += dt;
        p.sprite.position.y += p.vy * dt;
        p.vy *= Math.exp(-3 * dt);
        if (p.t > p.life - 0.35) {
          p.mat.opacity = Math.max(0, (p.life - p.t) / 0.35);
        }
        if (p.t >= p.life) {
          disposeDamagePopup(p);
          damagePopups.splice(i, 1);
        }
      }

      // 2. Update health bar timers and orientation (voxel structures)
      for (const v of voxBoxes) {
        if (v.barGroup) {
          v.barGroup.quaternion.copy(camera.quaternion);
          if (v.barTimer > 0) {
            v.barTimer -= dt;
            v.barGroup.visible = v.barTimer > 0;
          } else {
            v.barGroup.visible = false;
          }
        }
      }

      // Built walls
      for (const dest of wallDests.values()) {
        if (dest.barGroup) {
          dest.barGroup.quaternion.copy(camera.quaternion);
          if (dest.barTimer !== undefined) {
            dest.barTimer -= dt;
            dest.barGroup.visible = dest.barTimer > 0;
          }
        }
      }

      // 3. Update build mode preview
      if (buildMode && previewMesh) {
        const forward = new THREE.Vector3();
        camera.getWorldDirection(forward);
        forward.y = 0;
        forward.normalize();
        const px = camera.position.x + forward.x * 2.8;
        const pz = camera.position.z + forward.z * 2.8;
        const kind = resolvedBuildKind();
        if (setPreviewGeometry(kind) && BUILD_PIECES[buildPieceIdx].kind === 'auto') updateBuildHud();
        if (kind === 'floor') {
          const feet = camera.position.y - eyeH;
          const top = Math.max(feet, groundAt(px, pz) + 0.05) + 0.06;
          previewMesh.position.set(px, top + 0.15, pz);
        } else if (kind === 'ladder') {
          const feet = camera.position.y - eyeH;
          const base = Math.max(feet, groundAt(px, pz) + 0.02);
          previewMesh.position.set(px, base + 1.75, pz);
        } else if (kind === 'ramp') {
          const feet = camera.position.y - eyeH;
          const base = Math.max(feet, groundAt(px, pz) + 0.02);
          previewMesh.position.set(px, base + 0.55, pz);
        } else {
          const py = groundAt(px, pz);
          previewMesh.position.set(px, py + 1.3, pz);
        }
        previewMesh.rotation.y =
          kind === 'wall' || kind === 'door'
            ? Math.round(Math.atan2(forward.x, forward.z) / (Math.PI / 2)) * (Math.PI / 2) // match the grid-snapped build
            : Math.atan2(forward.x, forward.z);
      }
    }

    // Clear every destructible-feedback artefact (popups, bars, built walls)
    // when switching maps / modes.
    function resetBuildables() {
      for (const p of damagePopups) {
        disposeDamagePopup(p);
      }
      damagePopups.length = 0;

      for (const dest of Array.from(wallDests.values())) {
        const sIdx = solids.indexOf(dest.solid);
        if (sIdx !== -1) solids.splice(sIdx, 1);
        solidToWall.delete(dest.solid);
        dest.mesh.traverse((obj) => {
          const shIdx = shootable.indexOf(obj);
          if (shIdx !== -1) shootable.splice(shIdx, 1);
        });
        dest.mesh.parent?.remove(dest.mesh);
        if (dest.barGroup) disposeBar(dest.barGroup);
        wallDests.delete(dest.mesh);
      }

      for (const v of voxBoxes) {
        if (v.barGroup) {
          disposeBar(v.barGroup);
          v.barGroup = null;
          v.barFill = null;
          v.barTimer = 0;
        }
      }

      buildMode = false;
      previewMesh.visible = false;
      const buildBtnEl = $('buildWallBtn');
      if (buildBtnEl) buildBtnEl.classList.remove('active');
      const touchBuildEl = $('touchBuildBtn');
      if (touchBuildEl) touchBuildEl.classList.remove('active');
      if (aimBtn) {
        aimBtn.textContent = 'AIM';
        aimBtn.classList.remove('build-active');
      }
    }

    interface DummyObject {
      group: THREE.Group;
      parts: THREE.Mesh[];
      hp: number;
      lifeMax: number;
      shield: number;
      shieldMax: number;
      quiet: number;
      state: string;
      timer: number;
      flash: number;
      shooter: boolean;
      armed: boolean;
      fireT: number;
      shots: number;
      hits: number;
      ai: any;
      bodyMat?: THREE.MeshLambertMaterial;
      gait?: number;
      walkAmp?: number;
      lastX?: number;
      lastZ?: number;
      legs?: any[];
      arms?: any[];
      muzzle?: THREE.Object3D;
      bubble?: THREE.Mesh;
      weaponKind?: string;
      gunGroup?: THREE.Group;
    }
    const dummies: DummyObject[] = [];
    const spots: Array<{ x: number; z: number }> = [];

    const DUMMY_LIFE = 120;
    const DUMMY_SHIELD = 152;
    let dummyShield = DUMMY_SHIELD;
    let shootingOn = true;
    const bubbleGeo = new THREE.SphereGeometry(1.05, 20, 14);

    // Shared weapon materials & 3D model builders (used for player, dummies, and ground drops)
    const metal = new THREE.MeshLambertMaterial({ color: 0x3a4250 });
    const dark = new THREE.MeshLambertMaterial({ color: 0x161b22 });
    const wood = new THREE.MeshLambertMaterial({ color: 0x6b4a2e });
    const amber = new THREE.MeshLambertMaterial({ color: 0xf2a516 });
    const steel = new THREE.MeshLambertMaterial({ color: 0xb6bec9 });

    function part(g: THREE.Group, geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0) {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.rotation.x = rx;
      m.castShadow = true;
      g.add(m);
      return m;
    }

    function buildSK(g: THREE.Group) {
      part(g, new THREE.BoxGeometry(0.075, 0.09, 0.24), metal, 0, 0, -0.12);
      part(g, new THREE.BoxGeometry(0.03, 0.018, 0.22), dark, 0, 0.054, -0.12);
      part(g, new THREE.BoxGeometry(0.02, 0.022, 0.02), dark, 0, 0.074, -0.03);
      part(g, new THREE.BoxGeometry(0.012, 0.054, 0.012), amber, 0, 0.058, -0.56);
      part(g, new THREE.CylinderGeometry(0.013, 0.013, 0.36, 10), metal, 0, 0.02, -0.42, Math.PI / 2);
      part(g, new THREE.CylinderGeometry(0.018, 0.018, 0.06, 10), dark, 0, 0.02, -0.63, Math.PI / 2);
      part(g, new THREE.BoxGeometry(0.068, 0.07, 0.2), wood, 0, -0.005, -0.4);
      part(g, new THREE.BoxGeometry(0.04, 0.12, 0.06), dark, 0, -0.11, -0.2);
      part(g, new THREE.BoxGeometry(0.04, 0.12, 0.05), dark, 0, -0.095, -0.05, -0.25);
      part(g, new THREE.BoxGeometry(0.06, 0.1, 0.22), wood, 0, -0.01, 0.12);
      part(g, new THREE.BoxGeometry(0.058, 0.11, 0.02), dark, 0, -0.01, 0.24);
      part(g, new THREE.BoxGeometry(0.01, 0.012, 0.04), dark, 0.042, 0.03, -0.1);
    }

    function buildSMG(g: THREE.Group) {
      part(g, new THREE.BoxGeometry(0.06, 0.07, 0.2), dark, 0, 0, -0.1);
      part(g, new THREE.BoxGeometry(0.03, 0.02, 0.12), dark, 0, 0.045, -0.12);
      part(g, new THREE.BoxGeometry(0.016, 0.02, 0.016), dark, 0, 0.065, -0.04);
      part(g, new THREE.BoxGeometry(0.01, 0.04, 0.01), amber, 0, 0.055, -0.32);
      part(g, new THREE.CylinderGeometry(0.009, 0.009, 0.16, 10), metal, 0, 0.01, -0.27, Math.PI / 2);
      part(g, new THREE.CylinderGeometry(0.013, 0.013, 0.03, 10), dark, 0, 0.01, -0.37, Math.PI / 2);
      part(g, new THREE.BoxGeometry(0.05, 0.05, 0.1), dark, 0, -0.01, -0.26);
      part(g, new THREE.BoxGeometry(0.03, 0.15, 0.05), steel, 0, -0.1, -0.13);
      part(g, new THREE.BoxGeometry(0.035, 0.09, 0.045), dark, 0, -0.07, -0.04, -0.2);
      part(g, new THREE.BoxGeometry(0.04, 0.05, 0.12), wood, 0, 0, 0.07);
      part(g, new THREE.BoxGeometry(0.042, 0.055, 0.012), dark, 0, 0, 0.135);
      for (let i = 0; i < 5; i++) {
        const t = new THREE.Mesh(new THREE.ConeGeometry(0.008, 0.02, 4), amber);
        t.rotation.z = -Math.PI / 2;
        t.position.set(0.034, 0.005, -0.04 - i * 0.03);
        t.castShadow = true;
        g.add(t);
      }
    }

    function buildSniper(g: THREE.Group) {
      part(g, new THREE.BoxGeometry(0.07, 0.085, 0.2), metal, 0, 0, -0.16);
      part(g, new THREE.CylinderGeometry(0.012, 0.012, 0.64, 10), metal, 0, 0.018, -0.58, Math.PI / 2);
      part(g, new THREE.CylinderGeometry(0.02, 0.02, 0.07, 10), dark, 0, 0.018, -0.9, Math.PI / 2);
      part(g, new THREE.BoxGeometry(0.03, 0.02, 0.26), dark, 0, 0.05, -0.2);
      part(g, new THREE.BoxGeometry(0.03, 0.03, 0.03), dark, 0, 0.07, -0.2);
      part(g, new THREE.CylinderGeometry(0.02, 0.02, 0.24, 14), dark, 0, 0.1, -0.2, Math.PI / 2);
      part(g, new THREE.CylinderGeometry(0.026, 0.02, 0.05, 14), dark, 0, 0.1, -0.06, Math.PI / 2);
      part(g, new THREE.CylinderGeometry(0.03, 0.026, 0.06, 14), dark, 0, 0.1, -0.34, Math.PI / 2);
      part(g, new THREE.BoxGeometry(0.04, 0.12, 0.06), dark, 0, -0.1, -0.16);
      part(g, new THREE.BoxGeometry(0.04, 0.12, 0.05), dark, 0, -0.095, -0.05, -0.25);
      part(g, new THREE.BoxGeometry(0.06, 0.1, 0.3), wood, 0, -0.01, 0.1);
      part(g, new THREE.BoxGeometry(0.058, 0.11, 0.02), dark, 0, -0.01, 0.26);
      part(g, new THREE.BoxGeometry(0.01, 0.012, 0.04), dark, 0.042, 0.03, -0.14);
    }

    function buildBetgun(g: THREE.Group) {
      part(g, new THREE.BoxGeometry(0.08, 0.1, 0.26), dark, 0, 0, -0.14);
      part(g, new THREE.CylinderGeometry(0.026, 0.026, 0.6, 12), metal, -0.022, 0.02, -0.56, Math.PI / 2);
      part(g, new THREE.CylinderGeometry(0.026, 0.026, 0.6, 12), metal, 0.022, 0.02, -0.56, Math.PI / 2);
      part(g, new THREE.BoxGeometry(0.07, 0.07, 0.2), wood, 0, -0.045, -0.4);
      part(g, new THREE.BoxGeometry(0.04, 0.12, 0.05), dark, 0, -0.1, -0.02, -0.25);
      part(g, new THREE.BoxGeometry(0.06, 0.12, 0.3), wood, 0, -0.01, 0.12);
      part(g, new THREE.BoxGeometry(0.058, 0.13, 0.02), dark, 0, -0.01, 0.28);
    }

    function buildWeaponModel(kind: string, g: THREE.Group) {
      if (kind === 'smg') buildSMG(g);
      else if (kind === 'sniper') buildSniper(g);
      else if (kind === 'betgun') buildBetgun(g);
      else buildSK(g);
    }

    // Segmented figures & IK
    const FIG = {
      hipX: 0.18,
      hipY: 0.92,
      shoulderX: 0.42,
      shoulderY: 1.5,
      thigh: 0.46,
      shin: 0.46,
      upper: 0.36,
      fore: 0.34,
      ankleY: 0.1,
      gun: new THREE.Vector3(0.2, 1.2, 0.3),
    };
    const FIG_UP = new THREE.Vector3(0, 1, 0);
    const KNEE_FWD_DUMMY = new THREE.Vector3(0, 0, 1);
    const ELBOW_BACK_DUMMY = new THREE.Vector3(0, 0, -1);
    const figTmp = {
      dir: new THREE.Vector3(),
      bend: new THREE.Vector3(),
      diff: new THREE.Vector3(),
      target: new THREE.Vector3(),
    };
    const figGeo = {
      thigh: new THREE.CylinderGeometry(0.11, 0.095, 1, 12),
      shin: new THREE.CylinderGeometry(0.095, 0.075, 1, 12),
      upper: new THREE.CylinderGeometry(0.085, 0.075, 1, 10),
      fore: new THREE.CylinderGeometry(0.075, 0.062, 1, 10),
      joint: new THREE.SphereGeometry(0.095, 12, 9),
      hand: new THREE.SphereGeometry(0.075, 10, 8),
    };

    function segment(mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3) {
      figTmp.diff.subVectors(b, a);
      const len = figTmp.diff.length();
      mesh.position.copy(a).addScaledVector(figTmp.diff, 0.5);
      mesh.quaternion.setFromUnitVectors(FIG_UP, figTmp.diff.divideScalar(len));
      mesh.scale.set(1, len, 1);
    }

    function twoBone(
      root: THREE.Vector3,
      target: THREE.Vector3,
      lenA: number,
      lenB: number,
      pole: THREE.Vector3,
      joint: THREE.Vector3,
      end: THREE.Vector3
    ) {
      figTmp.dir.subVectors(target, root);
      if (figTmp.dir.lengthSq() < 1e-12) figTmp.dir.set(0, -1, 0);
      const d = Math.min(Math.max(figTmp.dir.length(), 1e-3), lenA + lenB - 1e-3);
      figTmp.dir.normalize();
      const along = (lenA * lenA - lenB * lenB + d * d) / (2 * d);
      const across = Math.sqrt(Math.max(0, lenA * lenA - along * along));
      figTmp.bend.copy(pole).addScaledVector(figTmp.dir, -pole.dot(figTmp.dir)).normalize();
      joint.copy(root).addScaledVector(figTmp.dir, along).addScaledVector(figTmp.bend, across);
      end.copy(root).addScaledVector(figTmp.dir, d);
    }

    function buildFigure(d: DummyObject, bodyColor: number) {
      const bodyMat = new THREE.MeshLambertMaterial({ color: bodyColor });
      const jointMat = new THREE.MeshLambertMaterial({ color: 0x1f2937 });
      const headMat = new THREE.MeshLambertMaterial({ color: 0xf3f4f6 });
      const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
        const m = new THREE.Mesh(geo, mat);
        m.position.set(x, y, z);
        m.castShadow = true;
        m.userData.dummy = d;
        d.parts.push(m);
        d.group.add(m);
        shootable.push(m);
        return m;
      };
      d.bodyMat = bodyMat;
      d.gait = 0;
      d.walkAmp = 0;
      d.lastX = d.group.position.x;
      d.lastZ = d.group.position.z;

      add(new THREE.CylinderGeometry(0.36, 0.34, 0.3, 16), bodyMat, 0, 0.92, 0);
      add(new THREE.CylinderGeometry(0.33, 0.36, 0.28, 16), bodyMat, 0, 1.2, 0);
      add(new THREE.CylinderGeometry(0.4, 0.36, 0.36, 16), bodyMat, 0, 1.46, 0);
      add(new THREE.CylinderGeometry(0.1, 0.1, 0.12, 10), jointMat, 0, 1.66, 0);
      add(new THREE.SphereGeometry(0.25, 16, 12), headMat, 0, 1.84, 0);

      d.legs = [-1, 1].map((side) => {
        const leg = { side, hip: new THREE.Vector3(side * FIG.hipX, FIG.hipY, 0), knee: new THREE.Vector3(), end: new THREE.Vector3() } as any;
        leg.thigh = add(figGeo.thigh, bodyMat, 0, 0, 0);
        leg.kneeMesh = add(figGeo.joint, jointMat, 0, 0, 0);
        leg.shin = add(figGeo.shin, bodyMat, 0, 0, 0);
        leg.ankleMesh = add(figGeo.joint, jointMat, 0, 0, 0);
        leg.foot = add(new THREE.BoxGeometry(0.2, 0.1, 0.34), jointMat, 0, 0.05, 0);
        return leg;
      });

      d.arms = [-1, 1].map((side) => {
        const arm = { side, shoulder: new THREE.Vector3(side * FIG.shoulderX, FIG.shoulderY, 0), elbow: new THREE.Vector3(), hand: new THREE.Vector3() } as any;
        add(figGeo.joint, jointMat, arm.shoulder.x, arm.shoulder.y, 0);
        arm.upper = add(figGeo.upper, bodyMat, 0, 0, 0);
        arm.elbowMesh = add(figGeo.joint, jointMat, 0, 0, 0);
        arm.fore = add(figGeo.fore, bodyMat, 0, 0, 0);
        arm.handMesh = add(figGeo.hand, jointMat, 0, 0, 0);
        return arm;
      });
    }

    function poseFigure(d: DummyObject, dt: number) {
      const p = d.group.position;
      const moved = Math.min(Math.hypot(p.x - (d.lastX || 0), p.z - (d.lastZ || 0)), 0.3);
      d.lastX = p.x;
      d.lastZ = p.z;
      d.gait = (d.gait || 0) + moved * 4.5;
      d.walkAmp = (d.walkAmp || 0) + (Math.min(1, (dt > 0 ? moved / dt : 0) / 1.2) - (d.walkAmp || 0)) * Math.min(1, 8 * dt);
      const amp = d.walkAmp;

      if (d.legs) {
        for (const leg of d.legs) {
          const ph = (d.gait || 0) + (leg.side > 0 ? Math.PI : 0);
          figTmp.target.set(leg.side * FIG.hipX, FIG.ankleY + Math.max(0, Math.cos(ph)) * 0.1 * amp, Math.sin(ph) * 0.22 * amp);
          twoBone(leg.hip, figTmp.target, FIG.thigh, FIG.shin, KNEE_FWD_DUMMY, leg.knee, leg.end);
          segment(leg.thigh, leg.hip, leg.knee);
          segment(leg.shin, leg.knee, leg.end);
          leg.kneeMesh.position.copy(leg.knee);
          leg.ankleMesh.position.copy(leg.end);
          leg.foot.position.set(leg.end.x, 0.05, leg.end.z + 0.08);
        }
      }

      if (d.arms) {
        for (const arm of d.arms) {
          if (d.shooter) {
            if (arm.side > 0) figTmp.target.set(FIG.gun.x, FIG.gun.y - 0.05, FIG.gun.z + 0.02);
            else figTmp.target.set(FIG.gun.x - 0.22, FIG.gun.y - 0.06, FIG.gun.z + 0.18);
          } else {
            const ph = (d.gait || 0) + (arm.side < 0 ? Math.PI : 0);
            figTmp.target.set(arm.shoulder.x + arm.side * 0.04, arm.shoulder.y - 0.62, 0.08 + Math.sin(ph) * 0.2 * amp);
          }
          twoBone(arm.shoulder, figTmp.target, FIG.upper, FIG.fore, ELBOW_BACK_DUMMY, arm.elbow, arm.hand);
          segment(arm.upper, arm.shoulder, arm.elbow);
          segment(arm.fore, arm.elbow, arm.hand);
          arm.elbowMesh.position.copy(arm.elbow);
          arm.handMesh.position.copy(arm.hand);
        }
      }
    }

    const DUMMY_WEAPONS = ['sk', 'smg', 'sniper', 'betgun'];
    let dummyWeaponCounter = 0;

    function spawnDummy(x: number, z: number, shooter = false, ai = false, weaponChoice?: string) {
      const assignedWeapon = weaponChoice || (shooter ? DUMMY_WEAPONS[dummyWeaponCounter++ % DUMMY_WEAPONS.length] : 'sk');
      const d: DummyObject = {
        group: new THREE.Group(),
        parts: [],
        hp: DUMMY_LIFE,
        lifeMax: DUMMY_LIFE,
        shield: dummyShield,
        shieldMax: dummyShield,
        quiet: 99,
        state: 'up',
        timer: 0,
        flash: 0,
        shooter,
        armed: shootingOn,
        fireT: 1.5,
        shots: 0,
        hits: 0,
        ai: ai ? aiState(x, z) : null,
        weaponKind: assignedWeapon,
      };
      d.group.rotation.order = 'YXZ';
      d.group.position.set(x, 0, z);
      buildFigure(d, ai ? 0x14b8a6 : shooter ? 0x9f1239 : 0xf59e0b);

      if (shooter) {
        const gun = new THREE.Group();
        gun.position.copy(FIG.gun);
        // Build the identical weapon model used by the player
        const model = new THREE.Group();
        buildWeaponModel(assignedWeapon, model);
        // First-person models aim along -Z; rotate Math.PI around Y to aim along +Z for dummy
        model.rotation.y = Math.PI;
        model.position.set(0, 0, 0.18);
        gun.add(model);
        for (const child of model.children) {
          if ((child as THREE.Mesh).isMesh) {
            (child as THREE.Mesh).castShadow = true;
          }
        }
        d.gunGroup = gun;
        d.muzzle = new THREE.Object3D();
        const mz = assignedWeapon === 'sniper' ? 1.05 : assignedWeapon === 'betgun' ? 0.9 : assignedWeapon === 'smg' ? 0.65 : 0.85;
        d.muzzle.position.set(0, 0.02, mz);
        gun.add(d.muzzle);
        d.group.add(gun);
      }

      d.bubble = new THREE.Mesh(
        bubbleGeo,
        new THREE.MeshBasicMaterial({ color: 0x67e8f9, transparent: true, opacity: 0.3, depthWrite: false })
      );
      d.bubble.position.y = 1.0;
      d.group.add(d.bubble);

      world.add(d.group);
      dummies.push(d);
      spots.push({ x, z });
      return d;
    }

    function addCrate(x: number, z: number, w: number, h: number, depth: number, color: THREE.Color) {
      const mat = new THREE.MeshLambertMaterial({ color });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, depth), mat);
      mesh.position.set(x, h / 2, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      world.add(mesh);
      const sb: SolidBox = { x, z, hx: w / 2, hz: depth / 2, top: h };
      solids.push(sb);
      shootable.push(mesh);
      voxHpMap.set(mat, 70); // wooden crates splinter easily
      registerDestructible(sb, mesh, mat);
    }

    // Spawn initial dummies
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.random() * 0.3;
      const r = (18 + Math.random() * 28) * FIELD;
      spawnDummy(Math.cos(a) * r, Math.sin(a) * r);
    }

    // Armed shooter dummies wielding each weapon (SK, Sharkteeth SMG, Sniper, Betgun)
    const initialWeapons = ['sk', 'smg', 'sniper', 'betgun'];
    for (let i = 0; i < initialWeapons.length; i++) {
      let a = (i / initialWeapons.length) * Math.PI * 2;
      let tries = 0;
      while (nearPool(Math.cos(a) * 32, Math.sin(a) * 32, 3) && tries++ < 50) {
        a = Math.random() * Math.PI * 2;
      }
      spawnDummy(Math.cos(a) * 32, Math.sin(a) * 32, true, false, initialWeapons[i]);
    }

    // Scatter crates
    for (let i = 0; i < 45 * FIELD; i++) {
      const x = (Math.random() - 0.5) * SPREAD;
      const z = (Math.random() - 0.5) * SPREAD;
      if (Math.hypot(x, z) < 12 || nearPool(x, z, 3) || spots.some((s) => Math.hypot(s.x - x, s.z - z) < 4)) continue;
      const color = new THREE.Color().setHSL(0.07 + Math.random() * 0.05, 0.3, 0.3 + Math.random() * 0.2);
      addCrate(x, z, 1.5 + Math.random() * 3, 1.2 + Math.random() * 3.3, 1.5 + Math.random() * 3, color);
    }

    // ----------------------------------------------------
    // Player Movement & Physics
    // ----------------------------------------------------
    const EYE = 1.7;
    const RADIUS = 0.35;
    const WALK = 5;
    const SPRINT = 8.5;
    const JUMP = 8;
    const GRAVITY = 24;
    const SENS = 0.0033;
    const TOUCH_SENS = 0.0039;
    const STICK_RUN = 0.85;
    const UNARMED_SPEED = 1.3;
    let yaw = 0;
    let pitch = 0;
    let kick = 0;
    let vy = 0;
    let grounded = true;
    let jumpTap = false;
    let moving = false;
    let sprinting = false;
    let runDist = 0;
    const RUN_RAMP = 30;

    const CROUCH_EYE = 1.0;
    const SLIDE_EYE = 0.7;
    const SLIDE_SPEED = 18.5;
    const SLIDE_DECAY = 1.05;
    const SLIDE_STOP = 2.5;
    const SLIDE_TIME = 1.8;
    const SLIDE_STEER = 2.2;
    const ROLL_DIST = 6.8;
    const ROLL_TIME = 0.75;
    const ROLL_IFRAMES = 0.48;
    const ROLL_COOL = 0.4;
    let eyeH = EYE;
    // Feet level of the last grounded moment — the "takeoff" floor. While
    // airborne, horizontal collision bands cap at groundRef + standing head
    // height: overhead slabs, lintels and window heads are CEILINGS there,
    // never walls. Without this cap, a jump that pokes your head into an
    // overhead band lets the per-axis wall clamp sling you metres across a
    // room — the "lean on a wall and get teleported" bug.
    let groundRef = 0;
    let slide: any = null;
    let roll: any = null;
    let airCarry: any = null;
    let rollCool = 0;
    let slideReq = false;
    let rollReq = 0;
    let sliderTouch: any = null;
    camera.position.set(0, EYE, 14);

    const keys = new Set<string>();
    const axis = (plus: string, minus: string) => (keys.has(plus) ? 1 : 0) - (keys.has(minus) ? 1 : 0);
    const stick = { x: 0, y: 0 };

    function pushOut(b: SolidBox) {
      const p = camera.position;
      const cx = THREE.MathUtils.clamp(p.x, b.x - b.hx, b.x + b.hx);
      const cz = THREE.MathUtils.clamp(p.z, b.z - b.hz, b.z + b.hz);
      const ox = p.x - cx;
      const oz = p.z - cz;
      const dist = Math.hypot(ox, oz);
      if (dist >= RADIUS) return;
      if (dist > 1e-6) {
        p.x += (ox / dist) * (RADIUS - dist);
        p.z += (oz / dist) * (RADIUS - dist);
      } else {
        const exitX = b.hx + RADIUS - Math.abs(p.x - b.x);
        const exitZ = b.hz + RADIUS - Math.abs(p.z - b.z);
        if (exitX < exitZ) p.x += p.x >= b.x ? exitX : -exitX;
        else p.z += p.z >= b.z ? exitZ : -exitZ;
      }
    }

    const CLIMB_REACH = 2.85; // Height reachable by arms extended above head
    const CLIMB_RISE = 7.0; // Athletic pull-up speed
    const STEP_UP = 0.45;
    const STEP_DOWN = 0.5;
    let climb: any = null;

    // Strict swept horizontal collision.
    // Re-walks the frame's horizontal motion (preX/preZ -> current) in small
    // substeps, clamping the player's square (radius RADIUS) against every
    // solid box face along the way. Per-axis clamping keeps natural wall
    // sliding; substepping (<= 0.3 m) means even a sprint-slide on a lag
    // spike frame can never jump a wall's thickness. pushOut above stays as
    // a safety net for teleports and spawns that land inside geometry.
    function sweepMove(preX: number, preZ: number) {
      let dx = camera.position.x - preX;
      let dz = camera.position.z - preZ;
      if (!dx && !dz) return;
      const total = Math.hypot(dx, dz);
      const steps = Math.max(1, Math.ceil(total / 0.3));
      dx /= steps;
      dz /= steps;
      // Rewind to the frame's start, then re-walk the motion substep by
      // substep so each wall face is hit and clamped along the way.
      camera.position.x = preX;
      camera.position.z = preZ;
      for (let s = 0; s < steps; s++) {
        if (dx) sweepAxis(0, dx);
        if (dz) sweepAxis(1, dz);
      }
      // Re-apply the arena bounds that were clamped before the sweep.
      camera.position.x = THREE.MathUtils.clamp(camera.position.x, -mapHalf, mapHalf);
      camera.position.z = THREE.MathUtils.clamp(camera.position.z, -mapHalf, mapHalf);
    }

    function sweepAxis(axis: 0 | 1, d: number) {
      const p = camera.position;
      if (axis === 0) p.x += d;
      else p.z += d;
      const feet = p.y - eyeH;
      // Band top caps at the takeoff floor + standing head height: a box
      // that starts above your standing head (2nd-floor slab, door lintel,
      // window head) is a CEILING, not a wall — it must never grab you
      // horizontally mid-jump. overheadAt still bonks your head on it.
      const bandTop = Math.min(p.y + 0.2, groundRef + EYE + 0.2);
      for (const b of solids) {
        // Vertical band must overlap the box, same test as pushOut
        if (b.top <= feet + 0.05 || (b.bottom ?? 0) >= bandTop) continue;
        // Other axis must overlap (player square vs box square)
        const other = axis === 0 ? p.z : p.x;
        const bOther = axis === 0 ? b.z : b.x;
        const bOtherHalf = axis === 0 ? b.hz : b.hx;
        if (Math.abs(other - bOther) >= bOtherHalf + RADIUS) continue;
        // Move axis overlap: clamp to the wall face we came from
        const move = axis === 0 ? p.x : p.z;
        const bMove = axis === 0 ? b.x : b.z;
        const bMoveHalf = axis === 0 ? b.hx : b.hz;
        const nearFace = bMove - bMoveHalf - RADIUS;
        const farFace = bMove + bMoveHalf + RADIUS;
        if (move > nearFace && move < farFace) {
          const prev = move - d;
          if (prev > nearFace && prev < farFace) {
            // Already inside this box's span when the substep began (band
            // flipped mid-jump, a POI streamed in around us, a shove from a
            // neighbouring box): cancel the move. Ejecting to the far face
            // here is what read as a teleport THROUGH the wall.
            if (axis === 0) p.x -= d;
            else p.z -= d;
          } else {
            const clamped = d > 0 ? nearFace : farFace;
            if (axis === 0) p.x = clamped;
            else p.z = clamped;
          }
        }
      }
    }

    function supportAt(x: number, z: number, feet: number) {
      let h = groundAt(x, z);
      for (const b of solids) {
        if (b.top <= feet + 0.05 && b.top > h) {
          const cx = THREE.MathUtils.clamp(x, b.x - b.hx, b.x + b.hx);
          const cz = THREE.MathUtils.clamp(z, b.z - b.hz, b.z + b.hz);
          if (Math.hypot(cx - x, cz - z) <= RADIUS) h = b.top;
        }
      }
      return h;
    }

    function overheadAt(x: number, z: number, from: number, to: number) {
      let low: number | null = null;
      for (const b of solids) {
        const under = b.bottom ?? 0;
        if (from + 0.2 > under || to + 0.2 <= under) continue;
        const cx = THREE.MathUtils.clamp(x, b.x - b.hx, b.x + b.hx);
        const cz = THREE.MathUtils.clamp(z, b.z - b.hz, b.z + b.hz);
        if (Math.hypot(cx - x, cz - z) > RADIUS) continue;
        if (low === null || under < low) low = under;
      }
      return low === null ? null : low - 0.2;
    }

    function headLimit(x: number, z: number, feet: number) {
      let cap = EYE;
      for (const b of solids) {
        const under = b.bottom ?? 0;
        if (under <= feet + 0.2) continue;
        const cx = THREE.MathUtils.clamp(x, b.x - b.hx, b.x + b.hx);
        const cz = THREE.MathUtils.clamp(z, b.z - b.hz, b.z + b.hz);
        if (Math.hypot(cx - x, cz - z) > RADIUS) continue;
        cap = Math.min(cap, under - feet - 0.2);
      }
      return Math.max(cap, 0.6);
    }

    function setEye(h: number) {
      const feet = camera.position.y - eyeH;
      eyeH = h;
      camera.position.y = feet + eyeH;
    }

    let crouched = false;
    const crouchHeld = () => keys.has('KeyC') || crouched || sliderTouch?.down === true;

    function updateStance(dt: number, swimming: boolean) {
      // Sprinting deliberately does NOT cancel a toggled crouch: running keeps
      // the stance, it only raises the eye when nothing holds crouch anymore.
      const isCrouching = crouchHeld() && !swimming && !climb;
      if (sliderEl) sliderEl.classList.toggle('crouched', isCrouching);
      const wanted = slide ? SLIDE_EYE : isCrouching ? CROUCH_EYE : EYE;
      const feet = camera.position.y - eyeH;
      const target = Math.min(wanted, headLimit(camera.position.x, camera.position.z, feet));
      setEye(eyeH + (target - eyeH) * Math.min(1, 12 * dt));
    }

    // Water & swimming
    const SWIM_SLOW = 0.5;
    const SWIM_DEPTH = 1.4;
    const SWIM_HEAD = 0.3;
    const SWIM_STROKE = 3.2;
    const SINK_SPEED = 2.2;

    function waterState() {
      const floor = groundAt(camera.position.x, camera.position.z);
      const wet = floor < WATER_Y && camera.position.y - eyeH < WATER_Y + 0.05;
      return { floor, wet, swimming: wet && WATER_Y - floor > SWIM_DEPTH };
    }

    // Underwater screen tint + murky sea fog. The water itself is never a
    // collider: wading applies progressive drag (movePlayer) and swimming
    // floats you at the surface — dive with C, stroke up with Space.
    const waterFxEl = $('waterFx');
    const AIR_FOG = { color: 0x9cc7e8, near: 60 * FIELD, far: 220 * FIELD };
    const SEA_FOG = { color: 0x0f364c, near: 1.5, far: 18 };
    let underFx = false;
    function updateWaterFx() {
      const under = camera.position.y < WATER_Y + 0.03 && groundAt(camera.position.x, camera.position.z) < WATER_Y;
      if (under === underFx) return;
      underFx = under;
      if (waterFxEl) waterFxEl.classList.toggle('on', under);
      const f = scene.fog as THREE.Fog | null;
      if (f) {
        if (under) {
          f.color.setHex(SEA_FOG.color);
          f.near = SEA_FOG.near;
          f.far = SEA_FOG.far;
        } else {
          f.color.setHex(AIR_FOG.color);
          f.near = AIR_FOG.near;
          f.far = AIR_FOG.far;
        }
      }
    }

    function swimStep(dt: number) {
      const target = WATER_Y + SWIM_HEAD;
      let want = THREE.MathUtils.clamp((target - camera.position.y) * 4, -SINK_SPEED, SWIM_STROKE);
      if (keys.has('KeyC')) want = -SINK_SPEED;
      else if ((keys.has('Space') || jumpTap) && camera.position.y < target + 0.6) want = SWIM_STROKE;
      vy += (want - vy) * Math.min(1, 6 * dt);
      camera.position.y += vy * dt;
      const bottom = groundAt(camera.position.x, camera.position.z) + eyeH;
      grounded = false;
      if (camera.position.y <= bottom) {
        camera.position.y = bottom;
        vy = 0;
        grounded = true;
      }
      jumpTap = false;
    }

    function movePlayer(dt: number) {
      const preX = camera.position.x;
      const preZ = camera.position.z;
      const f = axis('KeyW', 'KeyS') - stick.y;
      const s = axis('KeyD', 'KeyA') + stick.x;
      const len = Math.hypot(f, s);
      const { floor, wet, swimming } = waterState();
      moving = len > 0 && !climb;
      sprinting = moving && !wet && (keys.has('ShiftLeft') || keys.has('ShiftRight') || -stick.y >= STICK_RUN);
      // Water drag: progressive wading slowdown the deeper you go
      // (75% speed at ankle depth down to 40% at swim depth), then a
      // full swim once the floor drops out of reach.
      const depth = wet ? Math.max(0, WATER_Y - floor) : 0;
      const waterDrag = swimming ? SWIM_SLOW : wet ? THREE.MathUtils.lerp(0.75, 0.4, THREE.MathUtils.clamp(depth / SWIM_DEPTH, 0, 1)) : 1;

      const wx = len > 0 ? (-Math.sin(yaw) * f + Math.cos(yaw) * s) / len : 0;
      const wz = len > 0 ? (-Math.cos(yaw) * f - Math.sin(yaw) * s) / len : 0;
      const onGround = grounded && !swimming && !climb;
      const triggerSlide =
        (slideReq || (sliderTouch?.down && !sliderTouch?.slid)) &&
        !slide &&
        !roll &&
        moving &&
        onGround &&
        sprinting; // a slide is a sprint move — tapping C while walking just crouches
      if (triggerSlide) {
        slide = { t: 0, dx: wx, dz: wz, v: SLIDE_SPEED, lean: 0, step: 0, x0: 0, z0: 0 };
        if (sliderTouch) sliderTouch.slid = true;
      }
      if (rollReq !== 0 && !slide && !roll && onGround && rollCool === 0) {
        // Lateral dodge roll left (rollReq = -1) or right (rollReq = +1)
        roll = {
          t: 0,
          dx: Math.cos(yaw) * rollReq,
          dz: -Math.sin(yaw) * rollReq,
          h: eyeH,
        };
      }
      slideReq = false;
      rollReq = 0;
      rollCool = Math.max(0, rollCool - dt);

      if (slide) {
        slide.t += dt;
        if (len > 0 && wx * slide.dx + wz * slide.dz > 0) {
          const ang = Math.atan2(slide.dx * wz - slide.dz * wx, slide.dx * wx + slide.dz * wz);
          const turn = THREE.MathUtils.clamp(ang, -SLIDE_STEER * dt, SLIDE_STEER * dt);
          const cT = Math.cos(turn);
          const sT = Math.sin(turn);
          [slide.dx, slide.dz] = [slide.dx * cT - slide.dz * sT, slide.dx * sT + slide.dz * cT];
          slide.lean += (THREE.MathUtils.clamp(ang, -1, 1) - slide.lean) * Math.min(1, 5 * dt);
        } else {
          slide.lean -= slide.lean * Math.min(1, 5 * dt);
        }
        slide.v = SLIDE_SPEED * Math.exp(-SLIDE_DECAY * slide.t);
        slide.x0 = camera.position.x;
        slide.z0 = camera.position.z;
        slide.step = slide.v * dt;
        camera.position.x += slide.dx * slide.step;
        camera.position.z += slide.dz * slide.step;
        runDist = 0;
        if (slide.v < SLIDE_STOP || slide.t >= SLIDE_TIME) slide = null;
      } else if (roll) {
        const u0 = roll.t / ROLL_TIME;
        roll.t += dt;
        const u = Math.min(1, roll.t / ROLL_TIME);
        const step = (1.5 * ROLL_DIST / ROLL_TIME) * (1 - u0 * u0) * dt;
        camera.position.x += roll.dx * step;
        camera.position.z += roll.dz * step;
        runDist = 0;
        const feetNow = camera.position.y - eyeH;
        eyeH = Math.min(
          rollEyeHeight(2 * Math.PI * u) * roll.h / EYE,
          headLimit(camera.position.x, camera.position.z, feetNow)
        );
        camera.position.y = feetNow + eyeH;
        if (roll.t >= ROLL_TIME) {
          roll = null;
          rollCool = ROLL_COOL;
        }
      } else if (moving) {
        const boost = 1 + 0.5 * Math.min(1, runDist / RUN_RAMP);
        const speed = (sprinting ? SPRINT : WALK) * boost * (current ? 1 : UNARMED_SPEED) * waterDrag;
        const step = speed * Math.min(1, len) * dt;
        camera.position.x += wx * step;
        camera.position.z += wz * step;
        runDist += step;
        playerGait += step * 4.5;
      } else {
        runDist = 0;
      }

      if (airCarry) {
        if (grounded || climb || swimming) airCarry = null;
        else {
          camera.position.x += airCarry.dx * airCarry.v * dt;
          camera.position.z += airCarry.dz * airCarry.v * dt;
          airCarry.v *= Math.exp(-2 * dt);
        }
      }

      camera.position.x = THREE.MathUtils.clamp(camera.position.x, -mapHalf, mapHalf);
      camera.position.z = THREE.MathUtils.clamp(camera.position.z, -mapHalf, mapHalf);

      // Stairs
      if (grounded && !climb) {
        const feetNow = camera.position.y - eyeH;
        let lift: number | null = null;
        for (const b of solids) {
          if (b.top <= feetNow + 0.05 || b.top - feetNow > STEP_UP) continue;
          const cx = THREE.MathUtils.clamp(camera.position.x, b.x - b.hx, b.x + b.hx);
          const cz = THREE.MathUtils.clamp(camera.position.z, b.z - b.hz, b.z + b.hz);
          if (Math.hypot(cx - camera.position.x, cz - camera.position.z) < RADIUS && (lift === null || b.top > lift)) {
            lift = b.top;
          }
        }
        if (lift !== null) {
          camera.position.y = eyeH + lift;
          vy = 0;
        }
      }

      // Strict swept collision: clamp the player back out along the actual
      // movement path so no wall can ever be tunnelled through, even on
      // lag-spike frames or while sprint-sliding (see sweepMove below).
      sweepMove(preX, preZ);

      for (const b of solids) {
        if (
          b.top > camera.position.y - eyeH + 0.05 &&
          (b.bottom ?? 0) < Math.min(camera.position.y + 0.2, groundRef + EYE + 0.2)
        ) {
          pushOut(b);
        }
      }

      if (slide && (camera.position.x - slide.x0) * slide.dx + (camera.position.z - slide.z0) * slide.dz < 0.5 * slide.step) {
        slide = null;
      }
      if (!roll) updateStance(dt, swimming);

      const feet = camera.position.y - eyeH;
      // Climb / vault is DELIBERATE: only an airborne grab (jump toward a
      // ledge) or Space while grounded triggers it. Merely walking forward
      // against a wall must hold the player outside — that used to auto-
      // mantle you over the far side, which read as clipping through walls.
      const wantClimb =
        !climb &&
        ((!grounded && vy > -12) || (grounded && (keys.has('Space') || jumpTap)));
      if (wantClimb) {
        const fx = -Math.sin(yaw);
        const fz = -Math.cos(yaw);
        let ledge: SolidBox | null = null;
        for (const b of solids) {
          const diff = b.top - feet;
          // Must be higher than step-up (0.45m), and up to arm-reach above head (2.85m)
          if (diff <= STEP_UP || diff > CLIMB_REACH || (ledge && b.top > ledge.top)) continue;
          const cx = THREE.MathUtils.clamp(camera.position.x, b.x - b.hx, b.x + b.hx);
          const cz = THREE.MathUtils.clamp(camera.position.z, b.z - b.hz, b.z + b.hz);
          const ox = cx - camera.position.x;
          const oz = cz - camera.position.z;
          const dist = Math.hypot(ox, oz);
          if (dist < 1e-6 || dist > RADIUS + 0.45) continue;
          if (ox * fx + oz * fz < 0.25 * dist) continue;
          ledge = b;
        }
        if (ledge) {
          climb = {
            top: ledge.top,
            tx: THREE.MathUtils.clamp(camera.position.x + fx * 0.35, ledge.x - ledge.hx + RADIUS, ledge.x + ledge.hx - RADIUS),
            tz: THREE.MathUtils.clamp(camera.position.z + fz * 0.35, ledge.z - ledge.hz + RADIUS, ledge.z + ledge.hz - RADIUS),
            t: 0,
          };
          vy = 0;
          grounded = false;
          slide = null;
          airCarry = null;
        }
      }

      if (climb) {
        climb.t += dt;
        const m = CLIMB_RISE * dt;
        if (camera.position.y - eyeH < climb.top - 0.02) {
          camera.position.y = Math.min(eyeH + climb.top, camera.position.y + m);
          const pull = Math.min(1, 2.5 * dt);
          camera.position.x += (climb.tx - camera.position.x) * pull;
          camera.position.z += (climb.tz - camera.position.z) * pull;
        } else {
          camera.position.y = eyeH + climb.top;
          const dx = climb.tx - camera.position.x;
          const dz = climb.tz - camera.position.z;
          const d = Math.hypot(dx, dz);
          if (d <= m || climb.t > 1.2) {
            camera.position.x = climb.tx;
            camera.position.z = climb.tz;
            climb = null;
            grounded = true;
            vy = 0;
          } else {
            camera.position.x += (dx / d) * m;
            camera.position.z += (dz / d) * m;
          }
        }
      } else if (swimming) {
        swimStep(dt);
      } else {
        const standing = grounded;
        const wantJump = (keys.has('Space') || jumpTap) && !roll;
        if (grounded && wantJump) {
          airCarry = slide ? { dx: slide.dx, dz: slide.dz, v: slide.v } : null;
          vy = JUMP;
          grounded = false;
          slide = null;
          crouched = false;
        }
        const before = camera.position.y - eyeH;
        const eyeFrom = camera.position.y;
        vy -= GRAVITY * dt;
        if (wet) vy *= Math.exp(-4 * dt);
        camera.position.y += vy * dt;
        const ceil = overheadAt(camera.position.x, camera.position.z, eyeFrom, camera.position.y);
        if (ceil !== null && vy > 0) {
          camera.position.y = ceil;
          vy = 0;
        }
        const landing = supportAt(camera.position.x, camera.position.z, before);
        if (camera.position.y - eyeH <= landing + 0.01 && vy <= 0) {
          camera.position.y = eyeH + landing;
          vy = 0;
          grounded = true;
        } else if (standing && vy <= 0 && before - landing <= STEP_DOWN) {
          camera.position.y = eyeH + landing;
          vy = 0;
          grounded = true;
        } else {
          grounded = false;
        }
      }
      if (grounded) {
        // Remember the takeoff floor for the airborne collision band cap.
        groundRef = camera.position.y - eyeH;
      } else {
        slide = null;
        roll = null;
      }
      jumpTap = false;
    }

    function rollEyeHeight(phi: number) {
      const centre = 0.45 + 0.35 * Math.abs(Math.cos(phi));
      const reach = 0.45 + 0.45 * Math.abs(Math.cos(phi / 2));
      return centre + reach * Math.cos(phi);
    }

    const rollAxis = new THREE.Vector3();
    const rollTurn = new THREE.Quaternion();

    function applyView() {
      camera.rotation.set(pitch + kick, yaw, slide ? -slide.lean * 0.07 : 0);
      if (roll) {
        rollAxis.set(roll.dz, 0, -roll.dx);
        camera.quaternion.premultiply(rollTurn.setFromAxisAngle(rollAxis, 2 * Math.PI * Math.min(1, roll.t / ROLL_TIME)));
      }
      bodyRig.rotation.x = -(pitch + kick);
      camera.updateMatrixWorld();
    }

    // ----------------------------------------------------
    // Input & Interaction States
    // ----------------------------------------------------
    let mouseHeld = false;
    let aimMouse = false;
    let locked = false;
    let stickId: number | null = null;
    let aimId: number | null = null;
    const touches = new Map<number, any>();
    const inventoryEl = $('inventory');
    const running = () => overlay?.hidden && menuEl?.hidden && inventoryEl?.hidden;
    const aiming = () => aimMouse || aimId !== null;

    function showPause() {
      if (!overlay || !btn) return;
      overlay.hidden = false;
      setMapOpen(false); // the tactical map never lingers behind the pause
      btn.textContent = touchDevice ? 'Tap to resume' : 'Click to resume';
      keys.clear();
      mouseHeld = aimMouse = false;
      releaseTouch();
      // Never leave build mode armed behind the pause screen
      buildMode = false;
      previewMesh.visible = false;
      const bp = $('buildWallBtn');
      if (bp) bp.classList.remove('active');
      const tb = $('touchBuildBtn');
      if (tb) tb.classList.remove('active');
      if (aimBtn) {
        aimBtn.textContent = 'AIM';
        aimBtn.classList.remove('build-active');
      }
      document.exitPointerLock?.();
    }

    overlay?.addEventListener('click', () => {
      overlay.hidden = true;
      canvas?.requestPointerLock?.()?.catch?.(() => {});
    });

    const onPointerLockChange = () => {
      locked = document.pointerLockElement === canvas;
      if (!locked && running()) showPause();
    };
    document.addEventListener('pointerlockchange', onPointerLockChange);

    const onKeyDown = (e: KeyboardEvent) => {
      if (inventoryEl && !inventoryEl.hidden) {
        if (e.code === 'Escape' || e.code === 'KeyB') closeInventory();
        return;
      }
      if (e.code === 'Escape') {
        if (buildMode) toggleBuildWall(false);
        if (running()) showPause();
        return;
      }
      if (e.code === 'KeyM' && !e.repeat && running() && character === 'antenna') {
        setMapOpen(!mapOpen);
        return;
      }
      if (!running()) return;
      if (e.code === 'Space') e.preventDefault();
      keys.add(e.code);
      if (e.code === 'KeyC' && !e.repeat) {
        if (moving && grounded) {
          slideReq = true;
          crouched = true;
        } else {
          crouched = !crouched;
        }
      }
      if (e.code === 'KeyZ' && !e.repeat) rollReq = -1;
      if (e.code === 'KeyX' && !e.repeat) rollReq = 1;
      if (e.code === 'KeyR') startReload();
      if (e.code === 'KeyF') forcePick();
      if (e.code === 'KeyV' && !e.repeat) toggleBuildWall();
      if (e.code === 'KeyT' && !e.repeat) cycleBuildPiece(1);
      if ((e.code === 'Digit3' || e.code === 'KeyH') && !e.repeat) {
        if (buildMode) toggleBuildWall(false);
        putAway();
        refreshHud();
        refreshSlots();
        showMessage('Holstered weapon (Unarmed)', 1.5);
      }
      if (e.code === 'Digit1' && !e.repeat) {
        if (buildMode) toggleBuildWall(false);
        pressSlot(0);
      }
      if (e.code === 'Digit2' && !e.repeat) {
        if (buildMode) toggleBuildWall(false);
        pressSlot(1);
      }
      if (e.code === 'KeyQ') {
        if (buildMode) toggleBuildWall(false);
        cycleWeapon();
      }
      if (e.code === 'KeyE' && (!e.repeat || character !== 'barrage')) {
        if (buildMode) toggleBuildWall(false);
        primaryAction();
      }
      if (e.code === 'KeyG' && !e.repeat) {
        if (buildMode) toggleBuildWall(false);
        grenadeDown('key', 'KeyG', null);
      }
      if (gPress?.open && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) grenadeWheel(e.code === 'ArrowUp' ? 1 : -1);
      if (e.code === 'KeyB' && !e.repeat) {
        if (buildMode) toggleBuildWall(false);
        openInventory();
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      keys.delete(e.code);
      if (e.code === 'Digit1') releaseSlot(0);
      if (e.code === 'Digit2') releaseSlot(1);
      if (e.code === 'KeyG') grenadeUp('key', 'KeyG');
    };

    const onMouseDown = (e: MouseEvent) => {
      if (mapOpen) {
        // The tactical map is glance-only: any click closes it
        setMapOpen(false);
        return;
      }
      if (!running()) return;
      getAudio(); // Ensure audio context is running on user interaction
      if (buildMode) {
        // Don't place/cancel when the click lands on a HUD build plate
        const onPlate =
          inRect($('buildWallBtn'), e.clientX, e.clientY, 8) ||
          inRect($('touchBuildBtn'), e.clientX, e.clientY, 12);
        if (!onPlate) {
          if (e.button === 0 || e.button === 2) {
            placeWall();
            return;
          }
        }
      }
      if (inRect($('fireModeAuto'), e.clientX, e.clientY, 4)) {
        setFireMode('auto');
        return;
      }
      if (inRect($('fireModeManual'), e.clientX, e.clientY, 4)) {
        setFireMode('manual');
        return;
      }
      if (inRect(sliderEl, e.clientX, e.clientY, 6)) {
        sliderTouch = { id: -1, x0: e.clientX, y0: e.clientY, committed: false, down: false };
        sliderEl?.classList.add('is-pressed');
        return;
      }
      if (e.button === 0) mouseHeld = true;
      if (e.button === 2) {
        aimMouse = true;
        aimPressed();
      }
    };

    const onMouseUp = (e: MouseEvent) => {
      if (sliderTouch && sliderTouch.id === -1) {
        sliderEnd();
      }
      if (e.button === 0) mouseHeld = false;
      if (e.button === 2) aimMouse = false;
    };

    const onContextMenu = (e: MouseEvent) => {
      if (running()) e.preventDefault();
    };

    const onWheel = (e: WheelEvent) => {
      if (gPress?.open) {
        e.preventDefault();
        grenadeWheel(-Math.sign(e.deltaY));
        return;
      }
      if (buildMode) {
        e.preventDefault();
        cycleBuildPiece(e.deltaY > 0 ? 1 : -1);
      }
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!running() || mapOpen) return;
      if (sliderTouch && sliderTouch.id === -1) {
        const dx = e.clientX - sliderTouch.x0;
        const dy = e.clientY - sliderTouch.y0;
        if (!sliderTouch.committed) {
          if (Math.abs(dx) >= SLIDER_GESTURE && Math.abs(dx) > Math.abs(dy)) {
            sliderTouch.committed = true;
            rollReq = dx < 0 ? -1 : 1;
          } else if (dy >= SLIDER_GESTURE && dy > Math.abs(dx)) {
            sliderTouch.committed = true;
            sliderTouch.down = true;
            if (moving && grounded) {
              slideReq = true;
              crouched = true;
            } else {
              crouched = !crouched;
            }
          }
        }
        const kx = THREE.MathUtils.clamp(dx, -SLIDER_KNOB_R, SLIDER_KNOB_R);
        const ky = THREE.MathUtils.clamp(dy, -SLIDER_KNOB_R, SLIDER_KNOB_R);
        if (sliderKnobEl) sliderKnobEl.style.transform = `translate(${kx}px, ${ky}px)`;
        return;
      }
      if (!(locked || mouseHeld || aimMouse)) return;
      if (Math.abs(e.movementX) > 300 || Math.abs(e.movementY) > 300) return;
      const sens = SENS * lookScale();
      yaw -= e.movementX * sens;
      pitch = THREE.MathUtils.clamp(pitch - e.movementY * sens, -1.5, 1.5);
    };

    const onBlur = () => {
      keys.clear();
      mouseHeld = aimMouse = false;
      releaseTouch();
    };

    const onResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onResize);

    // ----------------------------------------------------
    // Modes and Harbor entry
    // ----------------------------------------------------
    const inventoryModeEl = $('inventoryMode');
    const dummySecEl = $('dummySec');

    // ----------------------------------------------------
    // Harbor Infrastructure — pier into the sea, container yard,
    // warehouse and gantry crane. Everything is destructible: all
    // pieces register as voxel boxes, so grenades chew holes in the
    // dock planks, containers pit and collapse, and the warehouse
    // can be blasted open for a firefight inside.
    // ----------------------------------------------------
    const harborGroup = new THREE.Group();
    harborGroup.visible = false;
    scene.add(harborGroup);

    const bmPlank = new THREE.MeshLambertMaterial({ color: 0x8a6a3f });
    const bmPlankDark = new THREE.MeshLambertMaterial({ color: 0x6d5230 });
    // Player-built wall / door wood (voxel walls, beams + planks)
    const bmBuildWood = new THREE.MeshLambertMaterial({ color: 0x925f32 });
    const bmBuildBeam = new THREE.MeshLambertMaterial({ color: 0x734823 });
    const bmContainerRed = new THREE.MeshLambertMaterial({ color: 0x9c3b30 });
    const bmContainerBlue = new THREE.MeshLambertMaterial({ color: 0x2d5f8a });
    const bmContainerGreen = new THREE.MeshLambertMaterial({ color: 0x3e7a4a });
    const bmContainerOrange = new THREE.MeshLambertMaterial({ color: 0xb06a28 });
    voxHpMap.set(bmPlank, 70);
    voxHpMap.set(bmPlankDark, 90);
    voxHpMap.set(bmBuildWood, 40);
    voxHpMap.set(bmBuildBeam, 55);
    voxHpMap.set(bmContainerRed, 230);
    voxHpMap.set(bmContainerBlue, 230);
    voxHpMap.set(bmContainerGreen, 230);
    voxHpMap.set(bmContainerOrange, 230);

    const HARBOR_E = Math.SQRT1_2; // the sea lies toward the +X/+Z diagonal
    let harborAnchor: { x: number; z: number; t: number } | null = null;
    // Clearing radius around the port — no vegetation and no POIs inside
    // it. planHarbor grows it to cover the whole platform footprint.
    let portClearR = 330;
    // Landmark chips the top compass tracks in Harbor mode. buildHarbor
    // swaps in a fresh array each entry; the compass reconfigures on change.
    type HarborMark = { x: number; z: number; label: string; cls: string };
    let harborMarks: HarborMark[] = [];

    function clearHarbor() {
      harborGroup.traverse((o: any) => {
        if (o.isMesh && o.geometry) o.geometry.dispose();
      });
      harborGroup.clear();
    }

    // March from (x0,z0) toward the sea until the floor drops below the
    // waterline. Returns distance travelled, or -1 if the sea never starts.
    function marchWaterFrom(x0: number, z0: number, maxD = 200) {
      for (let d = 0; d <= maxD; d += 2) {
        if (terrainHeight(x0 + HARBOR_E * d, z0 + HARBOR_E * d) < WATER_Y - 0.12) return d;
      }
      return -1;
    }

    // Shipping-container footprint (a 40ft high-cube unit): taller than
    // the player, stackable, the workhorse of yards, cranes and decks.
    const CONT_L = 12.2;
    const CONT_W = 2.44;
    const CONT_H = 2.9;

    // Everything planHarbor decides before a single tile streams: the
    // concrete platform the whole port stands on, the mega-ship berth,
    // the beach spawn, the graving-dock and breakwater sites. Every
    // dimension is drawn from the terrain seed, so two harbors from two
    // games never look the same.
    interface PortPlan {
      cx: number;
      cz: number;
      L: number; // platform size along X (400-560)
      D: number; // platform size along Z (250-360)
      padTop: number; // deck surface height (absolute)
      berth: 'east' | 'south';
      ship: { axis: 'z' | 'x'; fixed: number; start: number; len: number; beam: number; deckY: number; gap?: number } | null;
      spawn: { x: number; z: number };
      dock: { x: number; z: number } | null;
      bwall: { x: number; z: number };
      ladders: Array<{ x: number; z: number }>;
      stats: { buildings: number; containers: number; cranes: number; tanks: number; shipBoxes: number; solids: number };
    }
    let portPlan: PortPlan | null = null;

    // Loot that lives ON structures — ship decks, dock walls, rock tops.
    // poiLoot only knows terrain height, so these place pickups directly.
    function shipLoot(kinds: string[], x: number, z: number, y: number) {
      for (const kind of kinds) {
        const group = pickupMesh(kind);
        group.position.set(x, y, z);
        group.userData.poi = -1;
        scene.add(group);
        pickups.push({ kind, x, z, group, taken: false, timer: 0 });
      }
    }

    // Port warehouse: 30-46 m of roll-doored steel with a parapet roof
    // you can walk, high windows, pillars and crate rows inside.
    function buildMegaWarehouse(B: any, gy: number, hx: number, hz: number, doors: number, parent?: THREE.Object3D) {
      const T = 0.5;
      const E = gy + 9;
      bWall(B, 'z', -hx, -hx + T, -hz, hz, gy, E, [], bmSteel, parent);
      bWall(B, 'z', hx - T, hx, -hz, hz, gy, E, [], bmSteel, parent);
      bWall(B, 'x', -hz, -hz + T, -hx, hx, gy, E, holes([[-hx + 4, -hx + 7], [hx - 7, hx - 4]], gy + 5.8, gy + 7.6), bmSteel, parent);
      const doorList: any[] = [];
      for (let i = 0; i < doors; i++) {
        const c = -hx + ((2 * hx) / doors) * (i + 0.5);
        doorList.push({ a: c - 2.6, b: c + 2.6, sill: gy, head: gy + 5.4, glass: false });
      }
      bWall(B, 'x', hz - T, hz, -hx, hx, gy, E, doorList, bmSteel, parent);
      bBox(B, 'x', -hz, hz, -hx, hx, E, E + 0.4, bmSteelDark, parent); // roof deck
      bBox(B, 'z', -hx, hx, -hz, -hz + 0.35, E + 0.4, E + 1.5, bmSteelDark, parent); // parapet ring
      bBox(B, 'z', -hx, hx, hz - 0.35, hz, E + 0.4, E + 1.5, bmSteelDark, parent);
      bBox(B, 'x', -hz, hz, -hx, -hx + 0.35, E + 0.4, E + 1.5, bmSteelDark, parent);
      bBox(B, 'x', -hz, hz, hx - 0.35, hx, E + 0.4, E + 1.5, bmSteelDark, parent);
      for (const px of [-hx + 2.6, hx - 2.6]) {
        for (const pz of [-hz + 2.6, hz - 2.6]) {
          bBox(B, 'z', px - 0.3, px + 0.3, pz - 0.3, pz + 0.3, gy, E, bmSteelDark, parent); // pillars
        }
      }
      for (let i = 0; i < 5; i++) {
        const cxx = -hx + 4 + (i / 4) * (2 * hx - 8);
        bBox(B, 'z', cxx - 0.9, cxx + 0.9, -hz + 3.4, -hz + 5.2, gy, gy + 1.4, bmCrate, parent);
        if (i % 2 === 0) bBox(B, 'z', cxx - 0.9, cxx + 0.9, -hz + 3.4, -hz + 5.2, gy + 1.4, gy + 2.6, bmCrate, parent);
      }
    }

    // Portal gantry crane straddling a container block: four legs, two
    // full-length booms, cross beam, trolley, spreader + hanging unit.
    function buildGantry(B: any, gy: number, halfSpan: number, halfLen: number, hangMat: THREE.Material, parent?: THREE.Object3D) {
      const legH = gy + 15.5;
      for (const su of [-1, 1]) {
        for (const sv of [-1, 1]) {
          bBox(B, 'z', su * halfSpan - 0.5, su * halfSpan + 0.5, sv * halfLen - 0.5, sv * halfLen + 0.5, gy - 0.6, legH, bmSteelDark, parent);
        }
        bBox(B, 'x', -halfLen, halfLen, su * halfSpan - 0.45, su * halfSpan + 0.45, legH, legH + 0.9, bmSteel, parent);
      }
      bBox(B, 'z', -halfSpan - 0.4, halfSpan + 0.4, -0.5, 0.5, legH, legH + 1.0, bmWarnOrange, parent); // cross beam
      bBox(B, 'z', -1.6, 1.6, -1.1, 1.1, legH - 1.7, legH, bmSteelDark, parent); // trolley
      bBox(B, 'z', -1.9, 1.9, -1.9, 1.9, legH - 2.5, legH - 1.7, bmSteel, parent); // spreader
      bBox(B, 'z', -CONT_W / 2, CONT_W / 2, -CONT_L / 2, CONT_L / 2, legH - 2.5 - CONT_H, legH - 2.5, hangMat, parent); // hanging unit
    }

    // THE mega-ship: 330-400 m of container freighter berthed at the
    // platform's seaward corner — hundreds of times the player's size.
    // Hull bands, bulkhead bays, open cargo holds you can drop into,
    // deck container stacks, accommodation + bridge with wings, funnel,
    // masts, rails, bollards. All of it voxel-destructible.
    function buildMegaShip(sh: NonNullable<PortPlan['ship']>, rnd: () => number, stats: PortPlan['stats'], parent: THREE.Object3D) {
      const along = sh.axis === 'z';
      const su = sh.start;
      const fixed = sh.fixed;
      const len = sh.len;
      const hb = sh.beam / 2;
      const keelY = WATER_Y - 5.6;
      const deckY = sh.deckY;
      const before = solids.length;
      // (u, v) -> world: u runs along the hull from the stern, v across.
      // v-ranges arrive sometimes high-to-low (the s=-1 side runs), so
      // normalize first — a negative half-extent would be a phantom box
      // that never collides.
      const box = (u0: number, u1: number, v0: number, v1: number, y0: number, y1: number, mat: THREE.Material) => {
        const bv0 = Math.min(v0, v1);
        const bv1 = Math.max(v0, v1);
        const cu = (u0 + u1) / 2;
        const cv = (bv0 + bv1) / 2;
        const du = (u1 - u0) / 2;
        const dv = (bv1 - bv0) / 2;
        if (along) bBox({ x: fixed + cv, z: su + cu, rot: 0 }, 'z', -dv, dv, -du, du, y0, y1, mat, parent);
        else bBox({ x: su + cu, z: fixed + cv, rot: 0 }, 'z', -du, du, -dv, dv, y0, y1, mat, parent);
      };
      // hull sides: full-beam run, then stepped bow taper — three bands
      // (antifouling red / waterline white / dark topsides)
      const sideRuns: Array<[number, number, number]> = [
        [6, len - 44, hb],
        [len - 44, len - 22, hb - 4],
        [len - 22, len - 8, hb - 8.5],
        [len - 8, len - 2, hb - 12],
      ];
      for (const [u0, u1, w] of sideRuns) {
        for (const s of [-1, 1]) {
          box(u0, u1, s * (w - 1.2), s * w, keelY + 0.7, WATER_Y + 0.2, bmContainerRed);
          box(u0, u1, s * (w - 1.2), s * w, WATER_Y + 0.2, WATER_Y + 0.6, bmWhite);
          box(u0, u1, s * (w - 1.2), s * w, WATER_Y + 0.6, deckY - 0.1, bmSteelDark);
        }
      }
      // bow cap + bulbous bow + stern transom
      box(len - 12, len - 2, -(hb - 11), hb - 11, deckY - 0.1, deckY + 1.5, bmSteelDark);
      box(len - 18, len - 2, -2.4, 2.4, keelY, keelY + 2.6, bmContainerRed);
      box(2, 8, -(hb - 1.2), hb - 1.2, keelY + 0.7, deckY - 0.1, bmSteelDark);
      // transverse bulkheads every 46 m — the deck reads as cargo bays
      const nb = Math.floor((len - 80) / 46);
      for (let i = 0; i < nb; i++) {
        box(46 + i * 46, 47.1 + i * 46, -(hb - 1.2), hb - 1.2, keelY + 1.5, deckY - 1.0, bmSteelDark);
      }
      // main deck segments; two seeded holds stay open (coaming ring,
      // tank top, crates below, ladder back up) — drop in for loot
      const holdSegs = new Set<number>();
      holdSegs.add(1 + Math.floor(rnd() * 2));
      holdSegs.add(3 + Math.floor(rnd() * 2));
      const nSeg = Math.ceil((len - 60) / 44);
      const holdU: Array<[number, number]> = [];
      for (let i = 0; i < nSeg; i++) {
        const u0 = 8 + i * 44;
        const u1 = Math.min(u0 + 44, len - 52);
        if (u1 - u0 < 20) break;
        if (!holdSegs.has(i)) {
          box(u0, u1, -(hb - 1.1), hb - 1.1, deckY - 0.9, deckY, bmSteel);
          continue;
        }
        holdU.push([u0, u1]);
        const w = hb - 1.8;
        for (const s of [-1, 1]) box(u0 + 0.5, u1 - 0.5, s * w - 0.35, s * w, deckY, deckY + 1.3, bmWarnOrange);
        box(u0 + 0.5, u0 + 0.85, -w, w, deckY, deckY + 1.3, bmWarnOrange);
        box(u1 - 0.85, u1 - 0.5, -w, w, deckY, deckY + 1.3, bmWarnOrange);
        box(u0 + 2, u1 - 2, -w + 1.0, w - 1.0, keelY + 2.6, keelY + 3.0, bmSteelDark); // tank top
        for (let c = 0; c < 6; c++) {
          const cu = u0 + 5 + Math.floor(c / 2) * ((u1 - u0 - 10) / 3);
          const cv = c % 2 === 0 ? -w + 2.8 : w - 5.0;
          box(cu - 1.1, cu + 1.1, cv - 1.1, cv + 1.1, keelY + 3.0, keelY + 5.4, bmCrate);
        }
        const steps = Math.ceil((deckY - keelY - 3.0) / 0.42);
        for (let s2 = 0; s2 < steps; s2++) {
          const off = s2 % 2 === 0 ? -w + 1.0 : -w + 1.8;
          box(u0 + 2.2, u0 + 3.0, off - 0.36, off + 0.36, keelY + 3.0 + s2 * 0.42, keelY + 3.0 + (s2 + 1) * 0.42, bmPlankDark);
        }
      }
      // forecastle: raised bow deck, steps up, windlass
      box(len - 52, len - 10, -(hb - 6.5), hb - 6.5, deckY, deckY + 0.9, bmSteel);
      box(len - 44, len - 42.5, -3.2, 3.2, deckY, deckY + 0.45, bmSteel);
      box(len - 42.5, len - 41, -3.2, 3.2, deckY + 0.45, deckY + 0.9, bmSteel);
      box(len - 26, len - 18, -1.6, 1.6, deckY + 0.9, deckY + 2.5, bmSteelDark);
      // accommodation block aft + bridge with wings + funnel + masts
      for (let i = 0; i < 4; i++) {
        box(20, 46, -11, 11, deckY + i * 2.7, deckY + i * 2.7 + 2.45, bmCream);
      }
      box(21, 45, -11.5, 11.5, deckY + 10.8, deckY + 11.2, bmSlab); // roof
      box(28, 44, -14, 14, deckY + 11.2, deckY + 13.8, bmWhite); // bridge with wings
      box(28, 44, -12.6, 12.6, deckY + 12.2, deckY + 13.4, bmSteelDark); // glazing band
      box(10, 18, -3.6, 3.6, deckY + 1.0, deckY + 9.5, bmWarnOrange); // funnel
      box(9.8, 18.2, -3.7, 3.7, deckY + 9.5, deckY + 10.6, bmSteelDark); // funnel cap band
      box(47.5, 48.3, -0.3, 0.3, deckY + 13.8, deckY + 21.5, bmSteelDark); // radar mast
      box(50.5, 51.1, -0.22, 0.22, deckY + 13.8, deckY + 18.5, bmSteelDark); // halyard mast
      // exterior stairs up the accommodation face to the roof + bridge
      const stepsUp = Math.ceil((deckY + 11.2 - deckY) / 0.42);
      for (let i = 0; i < stepsUp; i++) {
        box(20 + i * 0.75, 20.9 + i * 0.75, -12.7, -11.9, deckY + i * 0.42, deckY + (i + 1) * 0.42, bmStair);
      }
      for (let i = 0; i < 6; i++) {
        box(28 + i * 0.75, 28.9 + i * 0.75, -14.7, -14.0, deckY + 13.8 + i * 0.42, deckY + 13.8 + (i + 1) * 0.42, bmStair);
      }
      // deck cargo: seeded container bays between accom and bow
      const rows = [-7.6, -4.5, -1.5, 1.5, 4.5, 7.6];
      for (let u = 54; u + CONT_L < len - 60; u += CONT_L + 1.2) {
        if (holdU.some(([h0, h1]) => u < h1 && u + CONT_L > h0)) continue;
        for (const v of rows) {
          if (rnd() < 0.4) continue;
          const stackN = 1 + Math.floor(rnd() * 2);
          const mat = [bmContainerRed, bmContainerBlue, bmContainerGreen, bmContainerOrange][Math.floor(rnd() * 4)];
          for (let s = 0; s < stackN; s++) {
            box(u, u + CONT_L, v - CONT_W / 2, v + CONT_W / 2, deckY + s * CONT_H, deckY + (s + 1) * CONT_H, mat);
            stats.containers++;
          }
        }
      }
      // bulwark rails + mooring bollards along the deck edge
      for (let u = 8; u < len - 52; u += 52) {
        const u1 = Math.min(u + 52, len - 52);
        for (const s of [-1, 1]) box(u, u1, s * (hb - 0.75), s * (hb - 0.45), deckY, deckY + 1.05, bmSteel);
      }
      for (const u of [24, len / 2, len - 64]) {
        for (const s of [-1, 1]) box(u, u + 0.9, s * (hb - 2.4), s * (hb - 1.6), deckY, deckY + 1.0, bmSteelDark);
      }
      // loot: bridge roof, the centre deck lane, the bow, and inside each open hold
      const shipAt = (u: number, v: number) => (along ? { x: fixed + v, z: su + u } : { x: su + u, z: fixed + v });
      const bridge = shipAt(36, 0);
      shipLoot(['sniper', 'shield'], bridge.x, bridge.z, deckY + 14.1);
      const deck1 = shipAt(250, 0);
      shipLoot(['smg', 'heavy'], deck1.x, deck1.z, deckY + 0.2);
      const bowL = shipAt(len - 30, 0);
      shipLoot(['heavy', 'shield'], bowL.x, bowL.z, deckY + 1.2);
      for (const [h0, h1] of holdU) {
        const hl = shipAt((h0 + h1) / 2, 0);
        shipLoot(['heavy', 'light'], hl.x, hl.z, keelY + 3.4);
      }
      stats.shipBoxes = solids.length - before;
    }

    // Plan the whole port up front, BEFORE any terrain tile streams:
    // the pads and the keep-spawn blend become part of the terrain mesh.
    function planHarbor() {
      HARBOR_SPAWN = { x: PORT_SEARCH.x, z: PORT_SEARCH.z };
      portClearR = 330;
      const tWater = marchWaterFrom(PORT_SEARCH.x, PORT_SEARCH.z, 1700);
      if (tWater < 0) {
        harborAnchor = null;
        portPlan = null;
        return;
      }
      const rnd = mulberry32((terrainSeed ^ 0x7a2b0d5) >>> 0);
      const ax0 = PORT_SEARCH.x + HARBOR_E * tWater;
      const az0 = PORT_SEARCH.z + HARBOR_E * tWater;

      // Seeded dimensions, drawn once
      const L = 400 + Math.floor(rnd() * 160); // 400-560 m
      const D = 250 + Math.floor(rnd() * 110); // 250-360 m
      const CORNER = 140 + rnd() * 70; // corner reach past the waterline
      const beam = 30 + Math.floor(rnd() * 10);
      const len = 330 + Math.floor(rnd() * 70);
      const deckY = WATER_Y + 12.6;
      const dockSide = rnd() < 0.5 ? -1 : 1;
      const dockK = dockSide * (400 + Math.floor(rnd() * 90));
      const bwK = -dockSide * (380 + Math.floor(rnd() * 120));

      // The coast is noisy (SEA_WARP bends it +-200 m), so every slid
      // site re-marches to ITS OWN waterline and the rect is validated
      // against REAL terrain at several spots; if the bay is dirty here,
      // the whole platform slides along the coast.
      const hullClearLine = (x: number, z: number, axis: 'z' | 'x', start: number, depth: number) => {
        for (let u = 0; u <= len; u += 16) {
          const px = axis === 'z' ? x : start + u;
          const pz = axis === 'z' ? start + u : z;
          if (terrainHeight(px, pz) > WATER_Y - depth) return false;
        }
        return true;
      };
      // Dock the mega-ship RIGHT NEXT TO THE HARBOUR: walk the hull out
      // from the quay face gap by gap and moor at the FIRST line where
      // the seabed clears the hold floor (holds sit ~2.6 m under the
      // waterline). The walkway then bridges whatever gap is left, so
      // the ship reads as berthed at its quay, not anchored in the bay.
      // Pass 2 relaxes to any wet line; pass 3 — for dirty coasts —
      // moors at the DEEPEST line seen even if a shallow bump kisses
      // the keel. Only a truly dry coast falls back to the bay anchor.
      const berthAt = (side: 'east' | 'south', XE: number, ZS: number, cx: number, cz: number): PortPlan['ship'] => {
        const isZ = side === 'east'; // east face: hull runs along z at x=fixed
        const faceC = isZ ? cz : cx;
        const scan = (gaps: number[], depth: number): PortPlan['ship'] => {
          for (const gap of gaps) {
            const fixed = (isZ ? XE : ZS) + gap + beam / 2;
            for (let start = faceC - 250; start < faceC + 500; start += 16) {
              if (hullClearLine(isZ ? fixed : start, isZ ? start : fixed, isZ ? 'z' : 'x', start, depth)) {
                return { axis: isZ ? 'z' : 'x', fixed, start, len, beam, deckY, gap };
              }
            }
          }
          return null;
        };
        const pass1 =
          scan([8, 18, 30, 44, 60, 80, 105, 135, 170, 210], 2.6) ||
          scan([10, 24, 44, 80, 130, 180, 240], 0.1);
        if (pass1) return pass1;
        // pass 3: deepest-line mooring — the ship docks beside the quay
        // even when a shallow saddle crosses under part of the hull
        let bestShip: PortPlan['ship'] | null = null;
        let bestWorst = Infinity;
        for (const gap of [20, 60, 120, 200]) {
          const fixed = (isZ ? XE : ZS) + gap + beam / 2;
          for (let start = faceC - 250; start < faceC + 500; start += 32) {
            let worst = -Infinity;
            for (let u = 0; u <= len; u += len / 10) {
              const px = isZ ? fixed : start + u;
              const pz = isZ ? start + u : fixed;
              worst = Math.max(worst, terrainHeight(px, pz));
            }
            if (worst < bestWorst) {
              bestWorst = worst;
              bestShip = { axis: isZ ? 'z' : 'x', fixed, start, len, beam, deckY, gap };
            }
          }
        }
        if (bestShip && bestWorst < WATER_Y + 0.9) return bestShip;
        return null;
      };
      // Last resort: park the mega-ship AT ANCHOR in the open bay — march
      // the diagonal until a full hull length of deep water is verified.
      // The bay is uniformly deep far out, so this always finds a line.
      const anchorAt = (cx: number, cz: number): PortPlan['ship'] => {
        for (let t = 160; t <= 1600; t += 40) {
          const px = cx + HARBOR_E * t;
          const pz = cz + HARBOR_E * t;
          if (hullClearLine(px, 0, 'z', pz - len / 2, 6.0)) return { axis: 'z', fixed: px, start: pz - len / 2, len, beam, deckY };
          if (hullClearLine(0, pz, 'x', px - len / 2, 6.0)) return { axis: 'x', fixed: pz, start: px - len / 2, len, beam, deckY };
        }
        return null;
      };

      // Site scan: slide along the coast, re-anchoring every candidate to
      // its OWN waterline, then keep the WETTEST valid site — the port
      // always hugs the ocean, even on noisy or cliffy coasts. The
      // expensive berth walk + spawn search run ONLY on the winner.
      const R = (L / 2 + D / 2) / Math.SQRT2; // centre -> seaward corner, diagonal
      type Site = {
        plan: PortPlan;
        pads: Array<{ x: number; z: number; r: number }>;
        score: number;
        ok: boolean;
        wx0: number;
        wz0: number;
        XE: number;
        ZS: number;
      };
      let bestSite: Site | null = null;
      let wetSite: Site | null = null; // wettest site with a dry landward corner (fallback)
      let firstSite: Site | null = null;
      for (const k of [0, 80, -80, 160, -160, 240, -240, 320, -320, 400, -400, 480, -480, 560, -560, 640]) {
        const wx0 = ax0 + HARBOR_E * k;
        const wz0 = az0 - HARBOR_E * k;
        // Re-anchor every slid site to ITS OWN waterline: the coast
        // bends +-200 m along the slide, so without this a slid site
        // could site the platform half-inland. The seaward corner now
        // always juts CORNER metres past the LOCAL waterline — the
        // harbour hugs the ocean at every candidate.
        const tw = marchWaterFrom(wx0, wz0, 320);
        if (tw < 0) continue;
        const cx = wx0 + HARBOR_E * (tw + CORNER - R);
        const cz = wz0 + HARBOR_E * (tw + CORNER - R);
        const padTop = WATER_Y + 2.6;
        const XW = cx - L / 2;
        const XE = cx + L / 2;
        const ZN = cz - D / 2;
        const ZS = cz + D / 2;

        // Terrain pads under the whole landward footprint; near the
        // seaward edges the radius shrinks so the blend never raises
        // open seabed far outside the quay. Computed first, registered
        // only if this site is chosen (validation needs RAW terrain).
        const pads: Array<{ x: number; z: number; r: number }> = [];
        for (let gx = XW + 30; gx <= XE - 30; gx += 48) {
          for (let gz = ZN + 30; gz <= ZS - 30; gz += 48) {
            const dSea = Math.min(XE - gx, ZS - gz);
            const r = Math.max(14, Math.min(56, Math.min(gx - XW, gz - ZN), dSea - 4));
            if (r < 14) continue;
            pads.push({ x: gx, z: gz, r });
          }
        }

        // siting validation — the platform needs a real bay at the
        // seaward corner, real land at the landward one, and low faces
        // (face mids get +0.9: a noisy coast can hold the quay a little
        // above the waterline while the corner still stands in the bay)
        const landwardDry = terrainHeight(XW, ZN) > WATER_Y - 0.6;
        const ok =
          terrainHeight(XE, ZS) < WATER_Y + 0.3 && // corner in the water
          terrainHeight(XE, cz) < WATER_Y + 0.9 &&
          terrainHeight(cx, ZS) < WATER_Y + 0.9 &&
          terrainHeight(cx, cz) > WATER_Y + 0.1 &&
          landwardDry; // landward corner dry
        // wetness score: lower = more ocean at the seaward faces
        const score = terrainHeight(XE, ZS) + terrainHeight(XE, cz) + terrainHeight(cx, ZS);

        const candidate: PortPlan = {
          cx,
          cz,
          L,
          D,
          padTop,
          berth: 'east',
          ship: null,
          spawn: { x: XE - 30, z: cz }, // provisional — the real search runs on the winner
          dock: null,
          bwall: { x: wx0 + HARBOR_E * bwK, z: wz0 - HARBOR_E * bwK },
          ladders: [],
          stats: { buildings: 0, containers: 0, cranes: 0, tanks: 0, shipBoxes: 0, solids: 0 },
        };
        const site: Site = { plan: candidate, pads, score, ok, wx0, wz0, XE, ZS };
        if (!firstSite) firstSite = site;
        if (ok && (!bestSite || score < bestSite.score)) bestSite = site;
        // even on a coast where nothing fully validates, the wettest
        // site that still has dry land at the landward corner beats a
        // dry k=0 fallback — the port hugs the ocean whenever it can
        if (!ok && landwardDry && (!wetSite || score < wetSite.score)) wetSite = site;
      }

      const site = bestSite ?? wetSite ?? firstSite;
      let plan: PortPlan | null = null;
      if (site) {
        const { plan: P, XE, ZS } = site;
        const cx = P.cx;
        const cz = P.cz;
        const XW = cx - L / 2;
        const ZN = cz - D / 2;
        // berth: try both seaward faces (full hull length verified), then
        // the open-bay anchor line — the ship ALWAYS exists
        const berth: 'east' | 'south' = rnd() < 0.5 ? 'east' : 'south';
        const ship =
          berthAt(berth, XE, ZS, cx, cz) ||
          berthAt(berth === 'east' ? 'south' : 'east', XE, ZS, cx, cz) ||
          anchorAt(cx, cz);
        P.ship = ship;
        P.berth = (ship?.axis === 'x' ? 'south' : 'east') as 'east' | 'south';

        // spawn: dry sand just outside a seaward face — the ocean is
        // right there, the port in front of you. If no dry-sand slot
        // exists on this coast, stand ON the quay next to the berth
        // instead of deep inland.
        let sp: { x: number; z: number } | null = null;
        for (let u = XW + 40; u <= XE - 40 && !sp; u += 6) {
          for (const off of [12, 18, 26]) {
            const h = terrainHeight(u, ZS + off);
            const dd = seaDist(u, ZS + off);
            if (h > WATER_Y + 0.35 && h < WATER_Y + 1.9 && dd < -2 && dd > -100) sp = { x: u, z: ZS + off };
          }
        }
        for (let w = ZN + 40; w <= ZS - 40 && !sp; w += 6) {
          for (const off of [12, 18, 26]) {
            const h = terrainHeight(XE + off, w);
            const dd = seaDist(XE + off, w);
            if (h > WATER_Y + 0.35 && h < WATER_Y + 1.9 && dd < -2 && dd > -100) sp = { x: XE + off, z: w };
          }
        }
        P.spawn = sp ?? { x: XE - 30, z: cz + (rnd() - 0.5) * D * 0.4 };

        // graving dock: a coast point clear of the platform, channel east
        const dsx = site.wx0 + HARBOR_E * dockK;
        const dsz = site.wz0 - HARBOR_E * dockK;
        let dockX: number | null = null;
        for (let dd = 0; dd <= 300; dd += 2) {
          if (terrainHeight(dsx + dd, dsz) < WATER_Y - 0.12) {
            dockX = dsx + dd;
            break;
          }
        }
        P.dock = dockX !== null ? { x: dockX, z: dsz } : null;

        for (const p of site.pads) flatZones.push({ x: p.x, z: p.z, r: p.r, baseY: P.padTop - 0.42 });
        harborAnchor = { x: site.wx0, z: site.wz0, t: tWater };
        HARBOR_SPAWN = P.spawn; // keep-blend flattens the real spawn
        portClearR = Math.hypot(L, D) / 2 + 70;
        plan = P;
      }
      portPlan = plan;
    }

    function buildHarbor() {
      clearHarbor();
      harborMarks = []; // fresh chip set for this layout
      if (!harborAnchor || !portPlan) return; // no coastline this seed — bail out safely
      const P = portPlan;
      const { cx, cz, L, D, padTop, dock, bwall } = P;
      const stats = P.stats;
      const XW = cx - L / 2;
      const XE = cx + L / 2;
      const ZN = cz - D / 2;
      const ZS = cz + D / 2;
      const rnd = mulberry32((terrainSeed ^ 0x5eed17e) >>> 0);
      const contMat = () => [bmContainerRed, bmContainerBlue, bmContainerGreen, bmContainerOrange][Math.floor(rnd() * 4)];
      const solidsBefore = solids.length;

      // footprint registry — every district checks it before building so
      // the seeded layout can never stack two structures on one spot
      const placedRects: Array<{ x: number; z: number; hx: number; hz: number }> = [];
      const fits = (x: number, z: number, hx: number, hz: number, m = 8) =>
        !placedRects.some((p) => Math.abs(x - p.x) < hx + p.hx + m && Math.abs(z - p.z) < hz + p.hz + m);
      const markPlaced = (x: number, z: number, hx: number, hz: number) => placedRects.push({ x, z, hx, hz });

      // ---- The platform: chunky modular foundation caisson blocks; on the
      // seaward sides the slab bottoms drop below the waterline, so the
      // port reads as a real raised foundation standing in the bay.
      // Slabs are subdivided into chunky ~20-22m blocks with chunky 2.2m
      // voxels so shooting the ground only chips the local caisson block,
      // never voxelizing the entire floor! ----
      const CHUNK_PITCH = 22;
      const nX = Math.max(8, Math.round(L / CHUNK_PITCH));
      const nZ = Math.max(6, Math.round(D / CHUNK_PITCH));
      const FOUNDATION_VOX = 2.2;
      for (let i = 0; i < nX; i++) {
        for (let j = 0; j < nZ; j++) {
          const x0 = XW + (i / nX) * L;
          const x1 = XW + ((i + 1) / nX) * L;
          const z0 = ZN + (j / nZ) * D;
          const z1 = ZN + ((j + 1) / nZ) * D;
          const bottom = Math.min(padTop - 1.4, WATER_Y - 2.2);
          bBox(
            { x: (x0 + x1) / 2, z: (z0 + z1) / 2, rot: 0 },
            'z',
            -(x1 - x0) / 2,
            (x1 - x0) / 2,
            -(z1 - z0) / 2,
            (z1 - z0) / 2,
            bottom,
            padTop,
            bmConcrete,
            harborGroup,
            FOUNDATION_VOX
          );
        }
      }

      // ---- Perimeter fence (west + north faces) with a seeded gate ----
      const gateZ = cz + (rnd() - 0.5) * D * 0.3;
      for (let z = ZN + 16; z < ZS - 16; z += 22) {
        if (Math.abs(z + 10 - gateZ) < 6) continue;
        if (terrainHeight(XW - 2, z + 10) > padTop + 1.2) continue;
        bBox({ x: XW - 1.1, z: z + 10, rot: 0 }, 'z', -0.12, 0.12, -10, 10, padTop, padTop + 1.15, bmSteelDark, harborGroup);
      }
      for (let x = XW + 16; x < XE - 16; x += 22) {
        if (seaDist(x + 10, ZN - 2) > -12) continue; // fence stops at the waterline
        if (terrainHeight(x + 10, ZN - 2) > padTop + 1.2) continue;
        bBox({ x: x + 10, z: ZN - 1.1, rot: 0 }, 'z', -10, 10, -0.12, 0.12, padTop, padTop + 1.15, bmSteelDark, harborGroup);
      }
      if (fits(XW + 14, gateZ + 9, 3.5, 5.5, 4)) {
        buildShed({ x: XW + 14, z: gateZ + 9, rot: 0 }, padTop, harborGroup); // gatehouse
        markPlaced(XW + 14, gateZ + 9, 3.5, 5.5);
        stats.buildings++;
      }

      // ---- Quay bollards along both seaward faces ----
      for (let z = ZN + 18; z < ZS - 18; z += 16) {
        if (seaDist(XE + 1, z) < -6) continue;
        bBox({ x: XE + 0.7, z, rot: 0 }, 'z', -0.3, 0.3, -0.3, 0.3, padTop - 0.2, padTop + 0.95, bmSteelDark, harborGroup);
      }
      for (let x = XW + 24; x < XE - 18; x += 16) {
        if (seaDist(x, ZS + 1) < -6) continue;
        bBox({ x, z: ZS + 0.7, rot: 0 }, 'z', -0.3, 0.3, -0.3, 0.3, padTop - 0.2, padTop + 0.95, bmSteelDark, harborGroup);
      }

      // ---- Container yard: big-box bays with aisles + gantry cranes ----
      const yardX0 = cx + 12;
      const yardX1 = XE - 20;
      const yardZ0 = ZN + 64; // south of the service band, clear of it
      const yardZ1 = ZS - 26;
      const blockW = 4; // containers side by side across x
      const rows = 7; // bays along z
      const blockPitch = blockW * 2.7 + 12;
      const nBlocks = Math.max(2, Math.min(4, Math.floor((yardX1 - yardX0) / blockPitch)));
      const blockZW = yardZ0 + 8 + ((rows - 1) * 13.2) / 2; // block z centre
      markPlaced(
        yardX0 + ((nBlocks - 1) * blockPitch + blockW * 2.7) / 2,
        blockZW,
        ((nBlocks - 1) * blockPitch + blockW * 2.7) / 2 + 6,
        (rows * 13.2) / 2 + 6
      );
      for (let b = 0; b < nBlocks; b++) {
        const bx0 = yardX0 + b * blockPitch;
        for (let r = 0; r < rows; r++) {
          if (r === 3) continue; // cross aisle
          const rz = yardZ0 + 8 + r * 13.2;
          for (let c = 0; c < blockW; c++) {
            if (rnd() < 0.22) continue; // a missing unit — cover, or a gap
            const rx = bx0 + c * 2.7;
            const stackN = 1 + Math.floor(rnd() * 3);
            const mat = contMat();
            for (let s = 0; s < stackN; s++) {
              bBox({ x: rx, z: rz, rot: 0 }, 'z', -CONT_W / 2, CONT_W / 2, -CONT_L / 2, CONT_L / 2, padTop + s * CONT_H, padTop + (s + 1) * CONT_H, mat, harborGroup);
              stats.containers++;
            }
          }
        }
        buildGantry({ x: bx0 + blockW * 1.35, z: blockZW, rot: 0 }, padTop, blockW * 1.35 + 2.2, (rows * 13.2) / 2 + 3, contMat(), harborGroup);
        stats.cranes++;
        if (b === 0) {
          harborMarks.push({ x: bx0 + blockW * 1.35, z: blockZW, label: 'YARD', cls: 'c-yard' });
          harborMarks.push({ x: bx0 + blockW * 1.35, z: blockZW - (rows * 13.2) / 2, label: 'CRANE', cls: 'c-crane' });
        }
      }

      // ---- Fuel depot first (bermed tank cluster + pump shed) so the
      // warehouse row has to dodge IT, never the other way round ----
      let tankC: { x: number; z: number } | null = null;
      for (const [tx, tz] of [
        [XW + 60, ZN + 40],
        [XW + 60, ZS - 60],
        [XW + 60, cz + 40],
      ] as Array<[number, number]>) {
        if (fits(tx, tz, 38, 36, 6)) {
          tankC = { x: tx, z: tz };
          break;
        }
      }
      if (tankC) {
        markPlaced(tankC.x, tankC.z, 38, 36);
        for (const [fx0, fx1, fz0, fz1] of [
          [-36, 36, -1.0, -0.3],
          [-36, 36, 32.3, 33.0],
          [-1.0, -0.3, -1.0, 33.0],
          [35.3, 36.0, -1.0, 33.0],
        ] as Array<[number, number, number, number]>) {
          bBox({ x: tankC.x + (fx0 + fx1) / 2, z: tankC.z + (fz0 + fz1) / 2, rot: 0 }, 'z', -(fx1 - fx0) / 2, (fx1 - fx0) / 2, -(fz1 - fz0) / 2, (fz1 - fz0) / 2, padTop - 0.3, padTop + 0.9, bmConcreteDark, harborGroup);
        }
        const tankN = 4 + Math.floor(rnd() * 4);
        for (let i = 0; i < tankN; i++) {
          buildTank({ x: tankC.x - 20 + (i % 2) * 40, z: tankC.z - 12 + Math.floor(i / 2) * 28, rot: 0 }, padTop, harborGroup);
          stats.tanks++;
        }
        harborMarks.push({ x: tankC.x, z: tankC.z, label: 'TANKS', cls: 'c-fuel' });
      }
      if (fits(XW + 38, cz - 20, 4, 4, 6)) {
        buildShed({ x: XW + 38, z: cz - 20, rot: 0 }, padTop, harborGroup); // pump house
        markPlaced(XW + 38, cz - 20, 4, 4);
        stats.buildings++;
      }

      // ---- Admin corner: customs office + harbour control + water tower ----
      const offB = { x: XW + 38, z: cz + 40 };
      let offBuilt = false;
      for (const [ox, oz] of [
        [XW + 38, cz + 40],
        [XW + 38, ZN + 100],
        [XW + 38, ZS - 100],
      ] as Array<[number, number]>) {
        if (!fits(ox, oz, 6, 5, 6)) continue;
        offB.x = ox;
        offB.z = oz;
        buildOffice({ x: ox, z: oz, rot: 1 }, padTop - 0.25, harborGroup);
        markPlaced(ox, oz, 6, 5);
        stats.buildings++;
        offBuilt = true;
        harborMarks.push({ x: ox, z: oz, label: 'OFFICE', cls: 'c-outp' });
        break;
      }
      for (const [wx2, wz2] of [
        [XW + 38, cz + 70],
        [XW + 38, ZN + 60],
        [XW + 38, ZS - 40],
      ] as Array<[number, number]>) {
        if (!fits(wx2, wz2, 4, 4, 6)) continue;
        buildWaterTower({ x: wx2, z: wz2, rot: 0 }, padTop, harborGroup);
        markPlaced(wx2, wz2, 4, 4);
        stats.buildings++;
        break;
      }
      for (const [mx2, mz2] of [
        [XW + 62, cz + 50],
        [XW + 62, ZN + 80],
        [XW + 62, ZS - 30],
      ] as Array<[number, number]>) {
        if (!fits(mx2, mz2, 3, 3, 6)) continue;
        buildRadioMast({ x: mx2, z: mz2, rot: 0 }, padTop, harborGroup); // harbour control
        markPlaced(mx2, mz2, 3, 3);
        break;
      }

      // ---- Grain silos + headhouse ----
      let siloC: { x: number; z: number } | null = null;
      for (const [sx2, sz2] of [
        [XW + 96, cz + 70],
        [XW + 96, ZN + 100],
        [XW + 96, ZS - 100],
      ] as Array<[number, number]>) {
        if (fits(sx2, sz2, 18, 20, 6)) {
          siloC = { x: sx2, z: sz2 };
          break;
        }
      }
      if (siloC) {
        markPlaced(siloC.x, siloC.z, 18, 20);
        const siloN = 4 + Math.floor(rnd() * 3);
        for (let i = 0; i < siloN; i++) {
          buildSilo({ x: siloC.x + (i % 2) * 10 - 5, z: siloC.z + Math.floor(i / 2) * 10 - 10, rot: 0 }, padTop, harborGroup);
        }
        if (fits(siloC.x + 24, siloC.z - 6, 3.2, 4.8, 4)) {
          buildShed({ x: siloC.x + 24, z: siloC.z - 6, rot: 0 }, padTop, harborGroup); // headhouse
          stats.buildings++;
        }
        harborMarks.push({ x: siloC.x, z: siloC.z, label: 'SILO', cls: 'c-farm' });
      }

      // ---- Warehouse row: 30-46 m roll-doored steel giants ----
      const whRow: Array<{ x: number; z: number; hx: number; hz: number }> = [];
      let wz = ZN + 70;
      while (wz < ZS - 40 && whRow.length < 7) {
        const hz = 11 + Math.floor(rnd() * 4);
        const hx = 15 + Math.floor(rnd() * 8);
        for (let t = 0; t < 10; t++) {
          const wx = XW + 44 + hx + rnd() * Math.max(20, cx - XW - 90 - 2 * hx);
          if (!fits(wx, wz + hz, hx, hz, 10)) continue;
          buildMegaWarehouse({ x: wx, z: wz + hz, rot: 0 }, padTop, hx, hz, 2 + Math.floor(rnd() * 2), harborGroup);
          markPlaced(wx, wz + hz, hx, hz);
          stats.buildings++;
          whRow.push({ x: wx, z: wz + hz, hx, hz });
          break;
        }
        wz += hz * 2 + 18 + Math.floor(rnd() * 8);
      }
      if (whRow.length) harborMarks.push({ x: whRow[0].x, z: whRow[0].z, label: 'WHSE', cls: 'c-whse' });
      // LADDER objects up the east wall of the first two warehouses:
      // the parapet roof + its loot open up without building a ramp.
      // The 45-degree rungs start near the south corner and climb
      // north along the wall face.
      for (const w of whRow.slice(0, 2)) {
        const lx = w.x + w.hx + 0.55;
        const lz = w.z - 4;
        bLadder(lx, lz, padTop, padTop + 10.7, bmPlankDark, harborGroup, 'z');
        P.ladders.push({ x: lx, z: lz });
      }

      // ---- Dockworkers' row: cottages + houses by the west gate ----
      let hz2 = cz - 88;
      let hN = 0;
      while (hz2 < cz - 14 && hN < 5) {
        const B = { x: XW + 152 + rnd() * 34, z: hz2, rot: rnd() < 0.5 ? 0 : 1 };
        const r = hN % 2 === 0 ? { hx: 4.5, hz: 3.5 } : { hx: 6, hz: 4.5 };
        if (fits(B.x, B.z, r.hx, r.hz, 6)) {
          (hN % 2 === 0 ? buildCottage : buildHouse)(B, padTop, harborGroup);
          markPlaced(B.x, B.z, r.hx, r.hz);
          stats.buildings++;
          hN++;
        }
        hz2 += 21;
      }

      // ---- Service row along the north face + campus extras ----
      const serviceSlots: Array<{ x: number; z: number; rot: number }> = [];
      for (let sx = cx - 40; sx < XE - 40; sx += 17 + Math.floor(rnd() * 6)) {
        serviceSlots.push({ x: sx, z: ZN + 28 + rnd() * 22, rot: rnd() < 0.5 ? 0 : 1 });
      }
      let sN = 0;
      while (sN < 11 && serviceSlots.length) {
        const s = serviceSlots.shift()!;
        if (!fits(s.x, s.z, 3.2, 4.8, 5)) continue;
        buildShed({ x: s.x, z: s.z, rot: s.rot }, padTop, harborGroup);
        markPlaced(s.x, s.z, 3.2, 4.8);
        stats.buildings++;
        sN++;
      }
      const campus: Array<[number, number, number, string]> = [
        [cx - 66, ZN + 44, 0, 'cabin'],
        [cx - 94, ZN + 44, 0, 'green'],
        [cx - 122, ZN + 40, 1, 'ruin'],
      ];
      for (const [ex, ez, er, kind] of campus) {
        if (!fits(ex, ez, kind === 'green' ? 4 : 6, 5, 6)) continue;
        if (kind === 'cabin') buildCabinBox({ x: ex, z: ez, rot: er }, padTop, harborGroup);
        else if (kind === 'green') buildGreenhouse({ x: ex, z: ez, rot: er }, padTop, harborGroup);
        else buildRuin({ x: ex, z: ez, rot: er }, padTop, harborGroup);
        markPlaced(ex, ez, 6, 5);
        stats.buildings++;
      }

      // ---- Construction corner: tower crane + material + site cabin ----
      const conC = { x: cx - 60, z: ZS - 60 };
      if (fits(conC.x, conC.z, 14, 14, 6)) {
        markPlaced(conC.x, conC.z, 14, 14);
        buildTowerCrane({ x: conC.x, z: conC.z, rot: rnd() < 0.5 ? 0 : 1 }, padTop, harborGroup);
        stats.cranes++;
        if (fits(conC.x + 24, conC.z + 16, 4, 4, 4)) {
          buildCabinBox({ x: conC.x + 24, z: conC.z + 16, rot: 0 }, padTop, harborGroup);
          markPlaced(conC.x + 24, conC.z + 16, 4, 4);
          stats.buildings++;
        }
        for (let i = 0; i < 4; i++) {
          bBox({ x: conC.x - 14 + (i % 2) * 5, z: conC.z - 14 + Math.floor(i / 2) * 5, rot: 0 }, 'z', -1.1, 1.1, -1.1, 1.1, padTop, padTop + 1.6 + (i % 2) * 1.2, bmCrate, harborGroup);
        }
      }

      // ---- Guard towers by the west gate ----
      for (const [gx2, gz2] of [
        [XW + 16, ZN + 100],
        [XW + 16, ZS - 60],
      ] as Array<[number, number]>) {
        if (!fits(gx2, gz2, 3.5, 3.5, 6)) continue;
        buildGuardTower({ x: gx2, z: gz2, rot: 0 }, padTop, harborGroup);
        markPlaced(gx2, gz2, 3.5, 3.5);
        stats.buildings++;
      }

      // ---- Top-up to the "at least 30 buildings" floor ----
      // fits() rejections on a cramped seed can dip the count below the
      // spec'd 30, so scatter small sheds into free pad space (seeded, so
      // two harbours still never look the same) until the floor is met.
      let topTries = 0;
      while (stats.buildings < 30 && topTries < 80) {
        topTries++;
        const tx = XW + 14 + rnd() * Math.max(10, XE - XW - 28);
        const tz = ZN + 14 + rnd() * Math.max(10, ZS - ZN - 28);
        if (!fits(tx, tz, 3.2, 4.8, 5)) continue;
        buildShed({ x: tx, z: tz, rot: rnd() < 0.5 ? 0 : 1 }, padTop, harborGroup);
        markPlaced(tx, tz, 3.2, 4.8);
        stats.buildings++;
      }

      // ---- Moored boats ----
      if (seaDist(XE + 26, cz - 60) > 12) buildBoat(XE + 26, cz - 60 + rnd() * 30, harborGroup);
      for (let u = cx; u < XE; u += 8) {
        if (seaDist(u, ZS + 26) > 14) {
          buildBoat(u, ZS + 26, harborGroup);
          break;
        }
      }

      // ---- THE mega-ship at its berth + boarding stair + mooring line ----
      if (P.ship) {
        const sh = P.ship;
        buildMegaShip(sh, rnd, stats, harborGroup);
        const midU = sh.start + sh.len / 2;
        const shipMid = sh.axis === 'z' ? { x: sh.fixed, z: midU } : { x: midU, z: sh.fixed };
        harborMarks.push({ x: shipMid.x, z: shipMid.z, label: 'SHIP', cls: 'c-ship' });
        // boarding: berthed ships get a walkway + stair from the quay;
        // anchored ships (dirty-coast seeds) get a swim-out pontoon with
        // a hull ladder. Both end in a landing over the bulwark rail.
        const face = sh.fixed - sh.beam / 2; // quay-side hull face
        const alongside = sh.gap !== undefined; // berthed: walkway bridges the gap
        const quayEnd = sh.axis === 'z' ? ZS : XE;
        if (alongside) {
          const bU = Math.max(sh.start + 8, Math.min(sh.start + 58, quayEnd - 34));
          const climb = Math.ceil((sh.deckY + 1.25 - padTop) / 0.42);
          if (sh.axis === 'z') {
            bBox({ x: (XE - 1 + face) / 2, z: bU + 11, rot: 0 }, 'z', -(face - XE + 1) / 2, (face - XE + 1) / 2, -13, 13, WATER_Y - 2.2, padTop, bmSteelDark, harborGroup); // walkway across the gap
            for (let i = 0; i < climb; i++) {
              bBox({ x: (XE - 1 + face) / 2, z: bU + i * 0.8 + 0.4, rot: 0 }, 'z', -(face - XE + 1) / 2, (face - XE + 1) / 2, -0.4, 0.4, padTop + i * 0.42, padTop + (i + 1) * 0.42, bmStair, harborGroup);
            }
            bBox({ x: face - 2.3, z: bU + climb * 0.8 + 2.2, rot: 0 }, 'z', -4.7, 4.7, -1.4, 1.4, sh.deckY - 0.1, sh.deckY + 1.25, bmSteelDark, harborGroup); // landing onto the deck
            bBox({ x: face - 2.3, z: bU + climb * 0.8 + 3.7, rot: 0 }, 'z', -4.7, 4.7, -0.12, 0.12, sh.deckY + 1.25, sh.deckY + 2.35, bmSteel, harborGroup); // far-edge rail
            bBox({ x: XE + 2.5, z: bU + 34, rot: 0 }, 'z', -0.06, 0.06, -0.06, 0.06, padTop + 0.9, sh.deckY, bmSteelDark, harborGroup); // mooring line
          } else {
            bBox({ x: bU + 11, z: (ZS - 1 + face) / 2, rot: 0 }, 'z', -13, 13, -(face - ZS + 1) / 2, (face - ZS + 1) / 2, WATER_Y - 2.2, padTop, bmSteelDark, harborGroup); // walkway across the gap
            for (let i = 0; i < climb; i++) {
              bBox({ x: bU + i * 0.8 + 0.4, z: (ZS - 1 + face) / 2, rot: 0 }, 'z', -0.4, 0.4, -(face - ZS + 1) / 2, (face - ZS + 1) / 2, padTop + i * 0.42, padTop + (i + 1) * 0.42, bmStair, harborGroup);
            }
            bBox({ x: bU + climb * 0.8 + 2.2, z: face - 2.3, rot: 0 }, 'z', -1.4, 1.4, -4.7, 4.7, sh.deckY - 0.1, sh.deckY + 1.25, bmSteelDark, harborGroup); // landing onto the deck
            bBox({ x: bU + climb * 0.8 + 3.7, z: face - 2.3, rot: 0 }, 'z', -0.12, 0.12, -4.7, 4.7, sh.deckY + 1.25, sh.deckY + 2.35, bmSteel, harborGroup); // far-edge rail
            bBox({ x: bU + 34, z: ZS + 2.5, rot: 0 }, 'z', -0.06, 0.06, -0.06, 0.06, padTop + 0.9, sh.deckY, bmSteelDark, harborGroup); // mooring line
          }
          // Long-gap moorings read as a proper jetty: pilings under the
          // walkway every ~14 m so the deck isn't a floating slab.
          if ((sh.gap ?? 0) > 18) {
            const nP = Math.floor((sh.gap ?? 0) / 14);
            for (let i = 1; i <= nP; i++) {
              const t = i / (nP + 1);
              const bx = sh.axis === 'z' ? XE + (face - XE) * t : bU + 11;
              const bz = sh.axis === 'z' ? bU + 11 : ZS + (face - ZS) * t;
              const bed = Math.min(terrainHeight(bx, bz) - 0.4, WATER_Y - 2.6);
              bBox({ x: bx, z: bz, rot: 0 }, 'z', -0.45, 0.45, -0.45, 0.45, bed, WATER_Y - 2.2, bmConcreteDark, harborGroup);
            }
          }
        } else {
          // AT ANCHOR: swim-out boarding at the hull's midpoint. The
          // first wade step sits just below the swim-float feet so a
          // swimmer glides over it and lands in wading depth, then
          // climbs out onto the pontoon and up the hull ladder.
          const pU = sh.start + sh.len / 2;
          const climb2 = Math.ceil((sh.deckY + 1.25 - (WATER_Y + 0.35)) / 0.42);
          if (sh.axis === 'z') {
            for (let i = 0; i < 4; i++) {
              bBox({ x: face - 12.5 + i, z: pU, rot: 0 }, 'z', -0.5, 0.5, -8, 8, WATER_Y - 3.3, WATER_Y - 1.35 + i * 0.45, bmStair, harborGroup); // wade-out steps
            }
            bBox({ x: face - 5, z: pU, rot: 0 }, 'z', -4, 4, -16, 16, WATER_Y - 1.4, WATER_Y + 0.35, bmSteelDark, harborGroup); // pontoon
            for (let i = 0; i < climb2; i++) {
              bBox({ x: face - 1.1, z: pU - 14 + i * 0.8 + 0.4, rot: 0 }, 'z', -0.5, 0.5, -0.4, 0.4, WATER_Y + 0.35 + i * 0.42, WATER_Y + 0.77 + i * 0.42, bmStair, harborGroup); // hull ladder
            }
            bBox({ x: face - 2.3, z: pU - 14 + climb2 * 0.8 + 2.2, rot: 0 }, 'z', -4.7, 4.7, -1.4, 1.4, sh.deckY - 0.1, sh.deckY + 1.25, bmSteelDark, harborGroup); // landing
            bBox({ x: face - 2.3, z: pU - 14 + climb2 * 0.8 + 3.7, rot: 0 }, 'z', -4.7, 4.7, -0.12, 0.12, sh.deckY + 1.25, sh.deckY + 2.35, bmSteel, harborGroup); // rail
            bBox({ x: face - 3, z: pU + 20, rot: 0 }, 'z', -0.06, 0.06, -0.06, 0.06, WATER_Y + 0.35, sh.deckY, bmSteelDark, harborGroup); // mooring line
          } else {
            for (let i = 0; i < 4; i++) {
              bBox({ x: pU, z: face - 12.5 + i, rot: 0 }, 'z', -8, 8, -0.5, 0.5, WATER_Y - 3.3, WATER_Y - 1.35 + i * 0.45, bmStair, harborGroup); // wade-out steps
            }
            bBox({ x: pU, z: face - 5, rot: 0 }, 'z', -16, 16, -4, 4, WATER_Y - 1.4, WATER_Y + 0.35, bmSteelDark, harborGroup); // pontoon
            for (let i = 0; i < climb2; i++) {
              bBox({ x: pU - 14 + i * 0.8 + 0.4, z: face - 1.1, rot: 0 }, 'z', -0.4, 0.4, -0.5, 0.5, WATER_Y + 0.35 + i * 0.42, WATER_Y + 0.77 + i * 0.42, bmStair, harborGroup); // hull ladder
            }
            bBox({ x: pU - 14 + climb2 * 0.8 + 2.2, z: face - 2.3, rot: 0 }, 'z', -1.4, 1.4, -4.7, 4.7, sh.deckY - 0.1, sh.deckY + 1.25, bmSteelDark, harborGroup); // landing
            bBox({ x: pU - 14 + climb2 * 0.8 + 3.7, z: face - 2.3, rot: 0 }, 'z', -0.12, 0.12, -4.7, 4.7, sh.deckY + 1.25, sh.deckY + 2.35, bmSteel, harborGroup); // rail
            bBox({ x: pU + 20, z: face - 3, rot: 0 }, 'z', -0.06, 0.06, -0.06, 0.06, WATER_Y + 0.35, sh.deckY, bmSteelDark, harborGroup); // mooring line
          }
        }
        // spilled floating containers beside the hull (seaward side when
        // anchored, quay side when berthed — never under the boarding)
        for (let i = 0; i < 3; i++) {
          const su = sh.start + 40 + i * 60;
          const dir = alongside ? -1 : 1;
          const sv = sh.fixed + dir * (sh.beam / 2 + 3 + rnd() * 3);
          if (sh.axis === 'z') bBox({ x: sv, z: su, rot: 0 }, 'z', -CONT_W / 2, CONT_W / 2, -CONT_L / 2, CONT_L / 2, WATER_Y - 1.1, WATER_Y + CONT_H - 1.1, contMat(), harborGroup);
          else bBox({ x: su, z: sv, rot: 0 }, 'z', -CONT_L / 2, CONT_L / 2, -CONT_W / 2, CONT_W / 2, WATER_Y - 1.1, WATER_Y + CONT_H - 1.1, contMat(), harborGroup);
        }
      }

      // ---- Graving dock + the half-built hull ----
      if (dock) {
        const DZ = dock.z;
        const xIn = dock.x - 18;
        const xOut = dock.x + 58;
        const wallTop = WATER_Y + 1.05;
        for (const s of [-1, 1]) {
          for (let seg = 0; seg < 10; seg++) {
            const sx = xIn + seg * (76 / 10) + 76 / 20;
            const sz = DZ + s * 7.4;
            const bed = Math.min(terrainHeight(sx, sz) - 0.5, WATER_Y - 5);
            bBox({ x: sx, z: sz, rot: 0 }, 'x', -76 / 20, 76 / 20, -0.5, 0.5, bed, wallTop, bmConcreteDark, harborGroup);
          }
        }
        for (let seg = 0; seg < 7; seg++) {
          const sx = xIn + seg * (76 / 7) + 76 / 14;
          bBox({ x: sx, z: DZ, rot: 0 }, 'x', -76 / 14, 76 / 14, -7.0, 7.0, WATER_Y - 1.0, WATER_Y - 0.3, bmConcrete, harborGroup, 2.0);
        }
        bBox({ x: xOut, z: DZ, rot: 0 }, 'z', -0.55, 0.55, -7.6, 7.6, WATER_Y - 0.85, WATER_Y + 1.6, bmConcrete, harborGroup); // caisson gate
        bBox({ x: xIn - 1.8, z: DZ, rot: 0 }, 'z', -0.7, 0.7, -2.6, 2.6, terrainHeight(xIn - 1.8, DZ) - 0.3, WATER_Y + 0.45, bmConcrete, harborGroup); // steps
        buildShip(xIn + 18, WATER_Y - 0.3, DZ, harborGroup);
        shipLoot(['betgun', 'heavy'], xOut, DZ, wallTop + 0.2);
        harborMarks.push({ x: dock.x, z: DZ, label: 'DOCK', cls: 'c-dock' });
      }

      // ---- Breakwater arc + lighthouse at its tip ----
      {
        let bx = bwall.x;
        let bz = bwall.z;
        let lTop = WATER_Y + 1.2;
        for (let i = 0; i < 14; i++) {
          const t = i * 5.4;
          const drift = i * i * 0.13;
          bx = bwall.x + HARBOR_E * t + HARBOR_E * drift * 0.6;
          bz = bwall.z + HARBOR_E * t - HARBOR_E * drift * 0.6;
          const w = (i === 13 ? 8.5 : 6.8 - i * 0.2) + hash2(i, 7, terrainSeed) * 1.2;
          const top = WATER_Y + (i === 13 ? 1.8 : 1.1 + hash2(i, 3, terrainSeed) * 0.7);
          const bed = terrainHeight(bx, bz) - 0.55;
          bBox({ x: bx, z: bz, rot: 0 }, 'z', -w / 2, w / 2, -w / 2, w / 2, bed, top, bmRock, harborGroup);
          lTop = top;
        }
        buildLighthouse({ x: bx, z: bz, rot: 0 }, lTop, harborGroup);
        stats.buildings++;
        shipLoot(['light', 'shield'], bx, bz, lTop + 0.3);
        harborMarks.push({ x: bx, z: bz, label: 'LIGHT', cls: 'c-light' });
      }

      // ---- Guarantee 30+ buildings: fill remaining service slots,
      // then a south-band sweep ----
      while (stats.buildings < 30 && serviceSlots.length) {
        const s = serviceSlots.shift()!;
        if (!fits(s.x, s.z, 3.2, 4.8, 4)) continue;
        buildShed({ x: s.x, z: s.z, rot: s.rot }, padTop, harborGroup);
        markPlaced(s.x, s.z, 3.2, 4.8);
        stats.buildings++;
      }
      let fillZ = ZS - 88;
      while (stats.buildings < 30 && fillZ > ZN + 180) {
        for (const fx of [XW + 130, XW + 155, XW + 180, cx - 70, cx - 45]) {
          if (stats.buildings >= 30) break;
          if (!fits(fx, fillZ, 3.2, 4.8, 4)) continue;
          buildShed({ x: fx, z: fillZ, rot: 0 }, padTop, harborGroup);
          markPlaced(fx, fillZ, 3.2, 4.8);
          stats.buildings++;
        }
        fillZ -= 26;
      }

      // ---- Port loot: the richest rewards on the coast ----
      for (const w of whRow) poiLoot(['smg', 'heavy', 'shield', 'light'], w.x, w.z, 12, padTop, -1, rnd);
      if (offBuilt) poiLoot(['sniper', 'shield'], offB.x, offB.z, 9, padTop, -1, rnd);
      if (tankC) poiLoot(['heavy', 'shield'], tankC.x, tankC.z, 14, padTop, -1, rnd);
      poiLoot(['smg', 'light', 'shield'], yardX0 + 8, (yardZ0 + yardZ1) / 2, 16, padTop, -1, rnd);

      stats.solids = solids.length - solidsBefore;
    }

    // ----------------------------------------------------
    // Procedural POI generator — the map's second layer.
    // Seeded, spaced, above-water sites are scattered across the
    // inland while the port owns the coast. Villages, farms,
    // fuel depots, construction sites, camps, radio masts,
    // ruins, outposts and water towers fill the map, each with
    // loot and a compass chip. POIs materialize inside the fog
    // radius (streamPois) as you explore and are reclaimed far
    // beyond sight — every structure is voxel-destructible.
    // ----------------------------------------------------
    interface Poi {
      id: number;
      kind: string;
      label: string;
      cls: string;
      x: number;
      z: number;
      rot: number;
      gy: number;
      r: number;
      group: THREE.Group | null;
      built: boolean;
      tries: number;
    }
    const pois: Poi[] = [];
    const POI_BUILD_R = 700; // build inside the fog so nothing pops in
    const POI_KEEP_R = 980; // keep well past sight; beyond this, reclaim

    function mulberry32(a: number) {
      return function () {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    const POI_KINDS: Record<string, { label: string; cls: string; r: number; loot: string[]; n: number }> = {
      village: { label: 'VILL', cls: 'c-vill', r: 44, loot: ['smg', 'shield', 'light', 'heavy'], n: 3 },
      farm: { label: 'FARM', cls: 'c-farm', r: 40, loot: ['heavy', 'light', 'shield'], n: 2 },
      fuel: { label: 'FUEL', cls: 'c-fuel', r: 32, loot: ['heavy', 'shield', 'smg'], n: 2 },
      construction: { label: 'SITE', cls: 'c-site', r: 34, loot: ['heavy', 'smg', 'light'], n: 2 },
      camp: { label: 'CAMP', cls: 'c-camp', r: 26, loot: ['sniper', 'smg', 'shield'], n: 3 },
      radio: { label: 'MAST', cls: 'c-mast', r: 24, loot: ['sniper', 'shield'], n: 2 },
      ruins: { label: 'RUIN', cls: 'c-ruin', r: 30, loot: ['betgun', 'heavy', 'light'], n: 2 },
      outpost: { label: 'OUTP', cls: 'c-outp', r: 26, loot: ['sniper', 'heavy', 'shield'], n: 2 },
      watertower: { label: 'WATER', cls: 'c-tow', r: 18, loot: ['shield', 'light'], n: 2 },
    };

    function generatePois() {
      pois.length = 0;
      const rnd = mulberry32((terrainSeed ^ 0x9e3779b9) >>> 0);
      let id = 0;
      for (const kind of Object.keys(POI_KINDS)) {
        const def = POI_KINDS[kind];
        for (let i = 0; i < def.n; i++) {
          let best: { x: number; z: number; score: number } | null = null;
          for (let t = 0; t < 160; t++) {
            const x = (rnd() * 2 - 1) * (HARBOR_HALF - 330);
            const z = (rnd() * 2 - 1) * (HARBOR_HALF - 330);
            if (seaDist(x, z) > -160) continue; // dry land, well inland
            if (Math.hypot(x - HARBOR_SPAWN.x, z - HARBOR_SPAWN.z) < 340) continue; // spawn stays clear
            if (harborAnchor && Math.hypot(x - harborAnchor.x, z - harborAnchor.z) < portClearR + 260) continue; // the port owns the coast
            if (pois.some((p) => Math.hypot(p.x - x, p.z - z) < 300)) continue; // spread out
            const h0 = terrainHeight(x, z);
            if (h0 < WATER_Y + 2.5) continue;
            let spread = 0;
            const rr = def.r * 0.7;
            for (const off of [
              [rr, 0],
              [-rr, 0],
              [0, rr],
              [0, -rr],
            ]) {
              spread = Math.max(spread, Math.abs(terrainHeight(x + off[0], z + off[1]) - h0));
            }
            if (spread > 10) continue; // too steep to flatten gently
            const score = spread + rnd() * 2;
            if (!best || score < best.score) best = { x, z, score };
          }
          if (!best) continue; // rough seed — this POI simply doesn't exist
          const gy = terrainHeight(best.x, best.z);
          pois.push({ id: id++, kind, label: def.label, cls: def.cls, x: best.x, z: best.z, rot: rnd() < 0.5 ? 0 : 1, gy, r: def.r, group: null, built: false, tries: 0 });
          flatZones.push({ x: best.x, z: best.z, r: def.r * 0.65 + 10, baseY: gy });
        }
      }
    }

    // Build the transition-route network AFTER the POIs exist but
    // BEFORE any tile streams (tiles paint it). Minimum spanning tree
    // over POI centres + the port gate keeps every place reachable,
    // then 3 seeded short-circuit edges add loops so it feels like a
    // real road web. Every edge jitters into waypoints and resamples
    // to ~8 m; kind (dust / mud / gravel) and width are seeded.
    function generatePaths() {
      paths.length = 0;
      pathGrid.clear();
      pathSamples.length = 0;
      pathMeta.length = 0;
      if (!pois.length) return;
      const rnd = mulberry32((terrainSeed ^ 0x51a3c7e) >>> 0);
      const nodes: Array<{ x: number; z: number }> = pois.map((p) => ({ x: p.x, z: p.z }));
      if (portPlan) nodes.push({ x: portPlan.cx - portPlan.L / 2 - 14, z: portPlan.cz }); // the landward gate
      else nodes.push({ x: HARBOR_SPAWN.x, z: HARBOR_SPAWN.z });
      const n = nodes.length;
      // Prim MST
      const inTree = new Array(n).fill(false);
      const edges: Array<[number, number]> = [];
      inTree[0] = true;
      for (let e = 0; e < n - 1; e++) {
        let bi = -1;
        let bj = -1;
        let bd = Infinity;
        for (let i = 0; i < n; i++) {
          if (!inTree[i]) continue;
          for (let j = 0; j < n; j++) {
            if (inTree[j]) continue;
            const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].z - nodes[j].z);
            if (d < bd) {
              bd = d;
              bi = i;
              bj = j;
            }
          }
        }
        if (bj < 0) break;
        inTree[bj] = true;
        edges.push([bi, bj]);
      }
      // Seeded loop edges: the 3 shortest non-tree links under 950 m
      const loops: Array<{ a: number; b: number; d: number }> = [];
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          if (edges.some(([a, b]) => (a === i && b === j) || (a === j && b === i))) continue;
          const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].z - nodes[j].z);
          if (d < 950) loops.push({ a: i, b: j, d });
        }
      }
      loops.sort((p, q) => p.d - q.d);
      for (const lp of loops.slice(0, 3)) edges.push([lp.a, lp.b]);
      // Edge -> jittered polyline -> ~8 m samples
      for (const [ai, bi] of edges) {
        const A = nodes[ai];
        const B = nodes[bi];
        const len = Math.hypot(B.x - A.x, B.z - A.z);
        if (len < 40) continue;
        const dirx = (B.x - A.x) / len;
        const dirz = (B.z - A.z) / len;
        const perpx = -dirz;
        const perpz = dirx;
        const wp: Array<{ x: number; z: number }> = [{ x: A.x, z: A.z }];
        const nW = Math.max(1, Math.min(4, Math.floor(len / 260)));
        for (let i = 1; i <= nW; i++) {
          const t = i / (nW + 1);
          const jitter = (rnd() * 2 - 1) * Math.min(70, len * 0.09);
          wp.push({ x: A.x + dirx * len * t + perpx * jitter, z: A.z + dirz * len * t + perpz * jitter });
        }
        wp.push({ x: B.x, z: B.z });
        const roll = rnd();
        const kind = roll < 0.5 ? 0 : roll < 0.75 ? 1 : 2;
        const w = kind === 2 ? 6.2 + rnd() * 1.4 : 3.8 + rnd() * 1.2;
        const seg: PathSeg = { pts: [], w, kind };
        for (let i = 0; i < wp.length - 1; i++) {
          const p0 = wp[i];
          const p1 = wp[i + 1];
          const segLen = Math.hypot(p1.x - p0.x, p1.z - p0.z);
          const steps = Math.max(1, Math.ceil(segLen / 8));
          for (let s = 0; s < steps; s++) {
            const t = s / steps;
            const x = p0.x + (p1.x - p0.x) * t;
            const z = p0.z + (p1.z - p0.z) * t;
            seg.pts.push(x, z);
            registerPathSample(x, z, w, kind);
          }
        }
        seg.pts.push(B.x, B.z);
        registerPathSample(B.x, B.z, w, kind);
        paths.push(seg);
      }
    }

    // ----------------------------------------------------
    // WAR DECORATIONS — battlefield dressing scattered across the
    // whole island, deliberately NOT tied to any POI: tanks, troop
    // trucks, helicopters, artillery pieces, sandbag emplacements,
    // fallen skeletons and ammo-crate stacks. Seeded per map; the
    // heavy pieces are voxel-destructible scenery (bullets chip,
    // grenades gut them), the skeletons are quiet set dressing.
    // ----------------------------------------------------
    interface WarProp {
      kind: string;
      x: number;
      z: number;
      group: THREE.Group;
    }
    const warProps: WarProp[] = [];
    const warZones: Array<{ x: number; z: number; r: number }> = [];
    const bmArmyGreen = new THREE.MeshLambertMaterial({ color: 0x4a5240 });
    const bmArmyDark = new THREE.MeshLambertMaterial({ color: 0x333a2e });
    const bmArmyRust = new THREE.MeshLambertMaterial({ color: 0x6e5138 });
    const bmSandbag = new THREE.MeshLambertMaterial({ color: 0x9c8a5e });
    const bmBone = new THREE.MeshLambertMaterial({ color: 0xd8d3c4 });
    voxHpMap.set(bmArmyGreen, 60); // scenery-grade: a grenade visibly chunks a wreck
    voxHpMap.set(bmArmyDark, 70);
    voxHpMap.set(bmArmyRust, 50);
    voxHpMap.set(bmSandbag, 40);
    voxHpMap.set(bmBone, 40);

    // One rotated, voxel-destructible box of a war prop. Local (lx, lz)
    // around the prop origin, heights above the ground; the AABB grows
    // to cover the yaw like every built piece does.
    function warBox(
      g: THREE.Group,
      ox: number,
      oz: number,
      gy: number,
      lx: number,
      y0: number,
      y1: number,
      lz: number,
      w: number,
      d: number,
      mat: THREE.Material,
      yaw: number,
      voxSize = 0.55
    ) {
      const ca = Math.cos(yaw);
      const sa = Math.sin(yaw);
      const x = ox + lx * ca - lz * sa;
      const z = oz + lx * sa + lz * ca;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, y1 - y0, d), mat);
      mesh.position.set(x, gy + (y0 + y1) / 2, z);
      mesh.rotation.y = yaw;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      g.add(mesh);
      const sb: SolidBox = {
        x,
        z,
        hx: Math.max(0.1, (w / 2) * Math.abs(ca) + (d / 2) * Math.abs(sa)),
        hz: Math.max(0.1, (w / 2) * Math.abs(sa) + (d / 2) * Math.abs(ca)),
        top: gy + y1,
        bottom: gy + y0,
        group: g,
      };
      solids.push(sb);
      shootable.push(mesh);
      registerDestructible(sb, mesh, mat, voxSize);
    }

    // Main battle tank: twin tracks, hull, stepped glacis, turret,
    // gun + muzzle brake, rear stowage. (War-prop tank — the port's
    // fuel-tank "buildTank" is a different builder.)
    function buildWarTank(g: THREE.Group, ox: number, oz: number, gy: number, yaw: number) {
      for (const side of [-1, 1]) {
        warBox(g, ox, oz, gy, 0, 0, 0.92, side * 1.28, 6.2, 0.95, bmArmyDark, yaw, 0.6);
      }
      warBox(g, ox, oz, gy, 0, 0.85, 1.75, 0, 5.4, 2.4, bmArmyGreen, yaw, 0.6);
      warBox(g, ox, oz, gy, 2.95, 0.85, 1.45, 0, 0.7, 2.2, bmArmyGreen, yaw, 0.55);
      warBox(g, ox, oz, gy, -0.45, 1.75, 2.45, 0, 2.5, 1.9, bmArmyGreen, yaw, 0.6);
      warBox(g, ox, oz, gy, -0.85, 2.45, 2.75, 0.35, 0.6, 0.6, bmArmyDark, yaw, 0.5);
      warBox(g, ox, oz, gy, 2.35, 2.0, 2.16, 0, 2.9, 0.22, bmArmyDark, yaw, 0.5);
      warBox(g, ox, oz, gy, 3.9, 1.98, 2.18, 0, 0.36, 0.3, bmArmyDark, yaw, 0.45);
      warBox(g, ox, oz, gy, -2.75, 1.78, 2.42, 0, 0.9, 1.9, bmArmyRust, yaw, 0.5);
    }

    // Troop truck: 6 wheels, chassis, cab, canvas cargo tilt.
    function buildWarTruck(g: THREE.Group, ox: number, oz: number, gy: number, yaw: number) {
      for (const side of [-1, 1]) {
        for (const wx of [-2.0, -0.4, 2.2]) {
          warBox(g, ox, oz, gy, wx, -0.05, 0.75, side * 1.15, 1.1, 0.7, bmArmyDark, yaw, 0.5);
        }
      }
      warBox(g, ox, oz, gy, 0, 0.6, 1.05, 0, 5.6, 2.1, bmArmyDark, yaw, 0.55);
      warBox(g, ox, oz, gy, 1.85, 1.05, 2.3, 0, 1.5, 1.95, bmArmyGreen, yaw, 0.55);
      warBox(g, ox, oz, gy, 2.58, 1.7, 2.15, 0, 0.12, 1.7, bmArmyDark, yaw, 0.45);
      warBox(g, ox, oz, gy, -0.95, 1.05, 2.75, 0, 3.6, 2.15, bmArmyGreen, yaw, 0.55);
      warBox(g, ox, oz, gy, -0.95, 2.75, 2.95, 0, 3.2, 1.8, bmArmyGreen, yaw, 0.5);
    }

    // Gunship helicopter: skids, tail boom + fin, fuselage, glass
    // band, rotor mast with crossed blades, stub weapon wings.
    function buildHelicopter(g: THREE.Group, ox: number, oz: number, gy: number, yaw: number) {
      for (const side of [-1, 1]) {
        warBox(g, ox, oz, gy, 0, 0.15, 0.5, side * 1.05, 3.6, 0.18, bmArmyDark, yaw, 0.5);
        for (const sx of [-1.2, 1.2]) {
          warBox(g, ox, oz, gy, sx, 0.5, 0.78, side * 1.05, 0.16, 0.16, bmArmyDark, yaw, 0.4);
        }
      }
      warBox(g, ox, oz, gy, -3.3, 0.9, 1.3, 0, 4.4, 0.5, bmArmyGreen, yaw, 0.6);
      warBox(g, ox, oz, gy, -5.15, 1.2, 2.1, 0, 0.5, 0.16, bmArmyGreen, yaw, 0.5);
      warBox(g, ox, oz, gy, -5.05, 1.25, 2.35, 0, 0.16, 1.3, bmArmyDark, yaw, 0.4);
      warBox(g, ox, oz, gy, 0.6, 0.75, 2.05, 0, 3.3, 1.7, bmArmyGreen, yaw, 0.6);
      warBox(g, ox, oz, gy, 2.1, 1.25, 1.95, 0, 0.5, 1.5, bmArmyDark, yaw, 0.5);
      warBox(g, ox, oz, gy, 0.5, 2.05, 2.5, 0, 0.35, 0.35, bmArmyDark, yaw, 0.4);
      for (const a of [yaw, yaw + Math.PI / 2]) {
        warBox(g, ox, oz, gy, 0.5, 2.5, 2.62, 0, 7.4, 0.34, bmArmyDark, a, 0.5);
      }
      for (const side of [-1, 1]) {
        warBox(g, ox, oz, gy, 0.9, 1.7, 1.95, side * 1.35, 0.5, 0.3, bmArmyGreen, yaw, 0.45);
      }
    }

    // Field artillery: split trail, wheels, gun shield, stepped barrel.
    function buildArtillery(g: THREE.Group, ox: number, oz: number, gy: number, yaw: number) {
      for (const side of [-1, 1]) {
        warBox(g, ox, oz, gy, -2.2, 0.35, 0.85, side * 0.8, 3.2, 0.45, bmArmyDark, yaw, 0.45);
        warBox(g, ox, oz, gy, 0, -0.35, 0.75, side * 1.45, 1.3, 0.75, bmArmyDark, yaw, 0.45);
      }
      warBox(g, ox, oz, gy, 0, 0.45, 0.8, 0, 1.0, 2.6, bmArmyDark, yaw, 0.45);
      warBox(g, ox, oz, gy, 0.75, 0.8, 1.85, 0, 0.22, 2.3, bmArmyGreen, yaw, 0.45);
      warBox(g, ox, oz, gy, 1.6, 1.15, 1.5, 0, 1.7, 0.3, bmArmyDark, yaw, 0.45);
      warBox(g, ox, oz, gy, 2.4, 1.42, 1.72, 0, 1.5, 0.26, bmArmyDark, yaw, 0.45);
      warBox(g, ox, oz, gy, 3.6, 1.66, 1.86, 0, 1.3, 0.22, bmArmyDark, yaw, 0.4);
      warBox(g, ox, oz, gy, 4.2, 1.66, 1.86, 0, 0.34, 0.34, bmArmyDark, yaw, 0.4);
    }

    // Sandbag emplacement: a staggered L of khaki bags.
    function buildSandbags(g: THREE.Group, ox: number, oz: number, gy: number, yaw: number, rnd: () => number) {
      const bag = (lx: number, y0: number, y1: number, lz: number) =>
        warBox(g, ox, oz, gy, lx + (rnd() - 0.5) * 0.12, y0, y1, lz + (rnd() - 0.5) * 0.12, 0.92, 0.55, bmSandbag, yaw, 0.45);
      for (let i = 0; i < 5; i++) {
        const lx = -2 + i;
        bag(lx, 0, 0.4, 0);
        if (i < 4) bag(lx + 0.5, 0.4, 0.78, 0);
        if (i < 3) bag(lx + 0.25, 0.78, 1.12, 0);
      }
      for (let j = 1; j <= 3; j++) {
        bag(-2, 0, 0.4, j);
        if (j < 3) bag(-2, 0.4, 0.78, j + 0.5);
      }
    }

    // Fallen soldier: a flat skeleton laid out on the ground — skull,
    // spine, ribs, pelvis, splayed arms and legs, one merged quiet
    // mesh (no collision, no damage, just a story).
    function buildSkeleton(g: THREE.Group, ox: number, oz: number, gy: number, yaw: number) {
      const parts: Array<{ geo: THREE.BufferGeometry; mat: THREE.Matrix4; color: number }> = [];
      const P = (geo: THREE.BufferGeometry, x: number, y: number, z: number, color: number, ry = 0) => ({
        geo,
        mat: vegMat4(x, y, z, 0, ry),
        color,
      });
      const bone = 0xd8d3c4;
      const boneD = 0xc9c2b0;
      parts.push(P(new THREE.BoxGeometry(0.3, 0.3, 0.3), 1.05, 0.16, 0, bone));
      parts.push(P(new THREE.BoxGeometry(0.2, 0.1, 0.18), 1.05, 0.03, 0.02, boneD));
      for (let i = 0; i < 4; i++) parts.push(P(new THREE.BoxGeometry(0.34, 0.12, 0.2), 0.55 - i * 0.34, 0.12, 0, boneD));
      for (let i = 0; i < 3; i++) parts.push(P(new THREE.BoxGeometry(0.3, 0.16, 0.5), 0.45 - i * 0.32, 0.14, 0, bone));
      parts.push(P(new THREE.BoxGeometry(0.36, 0.14, 0.34), -0.75, 0.1, 0, boneD));
      parts.push(P(new THREE.BoxGeometry(0.14, 0.12, 0.8), 0.35, 0.1, 0.42, bone, 0.5));
      parts.push(P(new THREE.BoxGeometry(0.14, 0.12, 0.75), 0.3, 0.1, -0.4, bone, -0.7));
      parts.push(P(new THREE.BoxGeometry(0.9, 0.13, 0.15), -1.25, 0.09, 0.18, bone, 0.25));
      parts.push(P(new THREE.BoxGeometry(0.85, 0.13, 0.15), -1.2, 0.09, -0.2, bone, -0.15));
      parts.push(P(new THREE.BoxGeometry(0.14, 0.24, 0.4), -1.7, 0.1, 0.14, boneD, 0.2));
      parts.push(P(new THREE.BoxGeometry(0.14, 0.24, 0.38), -1.62, 0.1, -0.18, boneD, -0.1));
      const def = vegMerge(parts);
      const P2: number[] = [];
      const N2: number[] = [];
      const C2: number[] = [];
      stampVeg(def, ox, gy - 0.04, oz, yaw, 1, 1, P2, N2, C2);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P2), 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(N2), 3));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(C2), 3));
      const mesh = new THREE.Mesh(geo, vegMat);
      mesh.castShadow = true;
      g.add(mesh);
    }

    // Ammo crate stack: 4-6 olive crates, jittered.
    function buildAmmoCrates(g: THREE.Group, ox: number, oz: number, gy: number, yaw: number, rnd: () => number) {
      const n = 4 + Math.floor(rnd() * 3);
      let i = 0;
      for (let row = 0; row < 3 && i < n; row++) {
        for (let col = 0; col < 2 && i < n; col++) {
          warBox(
            g,
            ox,
            oz,
            gy,
            (col - 0.5) * 1.0 + (rnd() - 0.5) * 0.15,
            row * 0.62,
            row * 0.62 + 0.58,
            (rnd() - 0.5) * 0.5,
            1.0,
            0.72,
            bmArmyGreen,
            yaw + (rnd() - 0.5) * 0.3,
            0.45
          );
          i++;
        }
      }
    }

    const WAR_PROP_PLAN: Array<{ kind: string; n: number; r: number }> = [
      { kind: 'tank', n: 8, r: 6 },
      { kind: 'truck', n: 10, r: 5.5 },
      { kind: 'helicopter', n: 5, r: 7 },
      { kind: 'artillery', n: 5, r: 5 },
      { kind: 'sandbags', n: 10, r: 4 },
      { kind: 'skeleton', n: 18, r: 2 },
      { kind: 'ammo', n: 8, r: 3 },
    ];

    function generateWarProps() {
      const rnd = mulberry32((terrainSeed ^ 0x5e17a11) >>> 0);
      for (const plan of WAR_PROP_PLAN) {
        for (let i = 0; i < plan.n; i++) {
          for (let t = 0; t < 90; t++) {
            const x = (rnd() * 2 - 1) * (HARBOR_HALF - 80);
            const z = (rnd() * 2 - 1) * (HARBOR_HALF - 80);
            if (Math.hypot(x - HARBOR_SPAWN.x, z - HARBOR_SPAWN.z) < 45) continue; // spawn stays clean
            if (seaDist(x, z) > -60) continue; // inland of the beach band
            if (harborAnchor && Math.hypot(x - harborAnchor.x, z - harborAnchor.z) < portClearR + 40) continue; // port owns the coast
            if (flatZones.some((f) => Math.hypot(x - f.x, z - f.z) < f.r + 14)) continue; // never on a POI pad
            if (warZones.some((w) => Math.hypot(x - w.x, z - w.z) < w.r + 18)) continue; // spread out
            const gy = terrainHeight(x, z);
            if (gy < WATER_Y + 0.8) continue;
            const spread = Math.max(
              Math.abs(terrainHeight(x + 4, z) - gy),
              Math.abs(terrainHeight(x - 4, z) - gy),
              Math.abs(terrainHeight(x, z + 4) - gy),
              Math.abs(terrainHeight(x, z - 4) - gy)
            );
            if (spread > 4.5) continue; // heavy props sit on flat-enough ground
            const yaw = rnd() * Math.PI * 2;
            const g = new THREE.Group();
            scene.add(g);
            if (plan.kind === 'tank') buildWarTank(g, x, z, gy, yaw);
            else if (plan.kind === 'truck') buildWarTruck(g, x, z, gy, yaw);
            else if (plan.kind === 'helicopter') buildHelicopter(g, x, z, gy, yaw);
            else if (plan.kind === 'artillery') buildArtillery(g, x, z, gy, yaw);
            else if (plan.kind === 'sandbags') buildSandbags(g, x, z, gy, yaw, rnd);
            else if (plan.kind === 'ammo') buildAmmoCrates(g, x, z, gy, yaw, rnd);
            else if (plan.kind === 'skeleton') buildSkeleton(g, x, z, gy, yaw);
            warProps.push({ kind: plan.kind, x, z, group: g });
            warZones.push({ x, z, r: plan.r });
            break;
          }
        }
      }
    }

    function clearWarProps() {
      for (const p of warProps) {
        const g = p.group;
        for (let i = voxBoxes.length - 1; i >= 0; i--) {
          const v = voxBoxes[i];
          if (v.group !== g) continue;
          if (v.inst) {
            v.group.remove(v.inst);
            const si = shootable.indexOf(v.inst);
            if (si >= 0) shootable.splice(si, 1);
            v.inst.geometry.dispose();
            (v.inst.material as THREE.Material).dispose();
            v.inst.dispose();
            v.inst = null;
          }
          if (v.barGroup) {
            disposeBar(v.barGroup);
            v.barGroup = null;
            v.barFill = null;
          }
          voxBoxes.splice(i, 1);
        }
        for (let i = shootable.length - 1; i >= 0; i--) {
          if ((shootable[i] as THREE.Object3D).parent === g) shootable.splice(i, 1);
        }
        for (let i = solids.length - 1; i >= 0; i--) {
          if (solids[i].group === g) solids.splice(i, 1);
        }
        g.traverse((o: any) => {
          if (o.isMesh) o.geometry?.dispose?.();
        });
        scene.remove(g);
      }
      warProps.length = 0;
      warZones.length = 0;
    }

    // Loot spawner shared by POIs and the port (poiId -1 = port).
    function poiLoot(kinds: string[], cx: number, cz: number, radius: number, gy: number, poiId: number, rnd: () => number) {
      for (const kind of kinds) {
        for (let t = 0; t < 24; t++) {
          const a = rnd() * Math.PI * 2;
          const d = 3 + rnd() * radius;
          const lx = cx + Math.cos(a) * d;
          const lz = cz + Math.sin(a) * d;
          const ly = terrainHeight(lx, lz);
          if (ly < gy - 1.6 || ly < WATER_Y + 0.2) continue; // off the pad / in water
          if (solids.some((b) => Math.abs(lx - b.x) < b.hx + 1.1 && Math.abs(lz - b.z) < b.hz + 1.1)) continue;
          const group = pickupMesh(kind);
          group.position.set(lx, ly, lz);
          group.userData.poi = poiId;
          scene.add(group);
          pickups.push({ kind, x: lx, z: lz, group, taken: false, timer: 0 });
          break;
        }
      }
    }

    function buildPoiAt(p: Poi) {
      if (p.built || p.tries >= 3) return;
      const voxBefore = voxBoxes.length;
      const g = new THREE.Group();
      scene.add(g);
      p.group = g;
      p.built = true;
      // NOTE: tries counts FAILURES only — successful builds must stay
      // infinitely revisitable (dismantle-on-distance then rebuild fresh).
      const rnd = mulberry32((terrainSeed ^ (p.id * 7919 + 13)) >>> 0);
      const B = { x: p.x, z: p.z, rot: p.rot };
      const place = (u: number, v: number) => turnPoint(B, u, v);
      const gy = p.gy;
      const fail = () => {
        p.tries++;
        dismantlePoi(p);
      };
      try {
      switch (p.kind) {
        case 'village': {
          const ring: Array<[number, number]> = [
            [-17, 2],
            [16, -8],
            [9, 15],
            [-9, -16],
            [1, -1],
            [18, 9],
          ];
          for (let i = 0; i < ring.length; i++) {
            const c = place(ring[i][0] + (rnd() - 0.5) * 4, ring[i][1] + (rnd() - 0.5) * 4);
            const br = { x: c.x, z: c.z, rot: i % 2 };
            if (i === 0 || i === 4) buildHouse(br, gy, g);
            else if (i === 1 || i === 2) buildCottage(br, gy, g);
            else buildShed(br, gy, g);
          }
          const w = place(-3, 8);
          bBox({ x: w.x, z: w.z, rot: 0 }, 'z', -0.9, 0.9, -0.9, 0.9, gy, gy + 1.0, bmRock, g); // well
          bBox({ x: w.x, z: w.z, rot: 0 }, 'z', -0.4, 0.4, -0.4, 0.4, gy + 1.0, gy + 1.4, bmWood, g);
          const m = place(11, 3);
          bBox({ x: m.x, z: m.z, rot: 0 }, 'x', -1.4, 1.4, -0.5, 0.5, gy, gy + 0.85, bmPlank, g); // market table
          bBox({ x: m.x, z: m.z, rot: 0 }, 'x', -0.6, 0.6, -0.4, 0.4, gy + 0.85, gy + 1.05, bmCrate, g);
          break;
        }
        case 'farm': {
          buildBarn(B, gy, g);
          const fh = place(-14, 10);
          buildCottage({ x: fh.x, z: fh.z, rot: 1 }, gy, g);
          const s1 = place(11, -7);
          buildSilo({ x: s1.x, z: s1.z, rot: 0 }, gy, g);
          const s2 = place(15, -1);
          buildSilo({ x: s2.x, z: s2.z, rot: 0 }, gy, g);
          const tr = place(-2, -13); // tractor
          bBox({ x: tr.x, z: tr.z, rot: 0 }, 'x', -1.3, 1.1, -0.9, 0.9, gy, gy + 1.15, bmWarnOrange, g);
          bBox({ x: tr.x, z: tr.z, rot: 0 }, 'x', 0.35, 0.85, -0.55, 0.55, gy + 1.15, gy + 2.05, bmSteelDark, g);
          bBox({ x: tr.x, z: tr.z, rot: 0 }, 'z', -1.1, -0.5, -0.35, 0.35, gy, gy + 0.7, bmCrate, g);
          bBox({ x: tr.x, z: tr.z, rot: 0 }, 'z', 0.5, 1.1, -0.35, 0.35, gy, gy + 0.7, bmCrate, g);
          for (const [hu, hv] of [
            [7, 9],
            [-13, -6],
            [3, -17],
          ]) {
            const hb = place(hu, hv);
            bBox({ x: hb.x, z: hb.z, rot: 0 }, 'z', -0.75, 0.75, -0.75, 0.75, gy, gy + 1.4, bmHay, g); // hay bales
          }
          break;
        }
        case 'fuel': {
          buildTank(B, gy, g);
          const t2 = place(0, 21);
          buildTank({ x: t2.x, z: t2.z, rot: p.rot }, gy, g);
          bBox(
            { x: (B.x + t2.x) / 2, z: (B.z + t2.z) / 2, rot: 0 },
            'x',
            -1.6,
            1.6,
            -0.14,
            0.14,
            gy + 0.55,
            gy + 0.95,
            bmSteelDark,
            g
          ); // pipe run between tanks
          const sh = place(-12, 9);
          buildShed({ x: sh.x, z: sh.z, rot: 1 }, gy, g);
          const wp = place(9, -7); // warning post
          bBox({ x: wp.x, z: wp.z, rot: 0 }, 'z', -0.1, 0.1, -0.1, 0.1, gy, gy + 2.4, bmSteelDark, g);
          bBox({ x: wp.x, z: wp.z, rot: 0 }, 'z', -0.3, 0.3, -0.3, 0.3, gy + 2.4, gy + 2.8, bmWarnOrange, g);
          break;
        }
        case 'construction': {
          bBox(B, 'x', -9, 9, -6.5, 6.5, gy - 0.3, gy + 0.15, bmConcrete, g); // foundation
          for (const cuv of [
            [-7.5, -4.5],
            [0, -4.5],
            [7.5, -4.5],
            [-7.5, 4.5],
            [0, 4.5],
            [7.5, 4.5],
          ]) {
            const c = place(cuv[0], cuv[1]);
            bBox({ x: c.x, z: c.z, rot: 0 }, 'z', -0.22, 0.22, -0.22, 0.22, gy + 0.15, gy + 5.2, bmSteel, g); // columns
          }
          for (const cv of [-4.5, 4.5]) {
            bBox(B, 'x', cv - 0.18, cv + 0.18, -7.7, 7.7, gy + 5.0, gy + 5.3, bmSteel, g); // top beams
          }
          bBox(B, 'x', -4.5, 4.6, -7.6, -0.2, gy + 5.3, gy + 5.62, bmConcreteDark, g); // partial slab
          // stair to the slab — zig-zag steps along the south columns
          const steps = Math.ceil(5.62 / 0.42);
          for (let i = 0; i < steps; i++) {
            const s = place(i % 2 === 0 ? -1.1 : 1.1, 6.4);
            bBox({ x: s.x, z: s.z, rot: 0 }, 'x', -0.4, 0.4, -0.44, 0.44, gy + i * 0.42, gy + (i + 1) * 0.42, bmPlankDark, g);
          }
          const tc = place(17, -11);
          buildTowerCrane({ x: tc.x, z: tc.z, rot: 0 }, gy, g);
          const cb = place(-14, 1);
          buildCabinBox({ x: cb.x, z: cb.z, rot: 0 }, gy, g);
          for (const [bu, bv] of [
            [-4, 10],
            [2, 12],
            [8, 9],
          ]) {
            const bb = place(bu, bv);
            bBox({ x: bb.x, z: bb.z, rot: 0 }, 'x', -1.2, 1.2, -0.3, 0.3, gy, gy + 0.9, bmConcrete, g); // jersey barriers
          }
          for (const [pu, pv] of [
            [4, -9],
            [6.5, -10],
          ]) {
            const pp = place(pu, pv);
            bBox({ x: pp.x, z: pp.z, rot: 0 }, 'z', -0.7, 0.7, -0.45, 0.45, gy, gy + 0.35, bmCrate, g); // pallets
            bBox({ x: pp.x, z: pp.z, rot: 0 }, 'z', -0.55, 0.55, -0.35, 0.35, gy + 0.35, gy + 0.62, bmCrate, g);
          }
          const gp = place(-9, -11);
          bBox({ x: gp.x, z: gp.z, rot: 0 }, 'z', -1.6, 1.6, -1.2, 1.2, gy, gy + 1.1, bmGravel, g); // gravel pile
          break;
        }
        case 'camp': {
          for (let i = 0; i < 3; i++) {
            const a = (i / 3) * Math.PI * 2 + 0.5;
            const c = place(Math.cos(a) * 8, Math.sin(a) * 8);
            buildTent({ x: c.x, z: c.z, rot: 0 }, gy, g, i === 1 ? bmCanvasGreen : bmCanvasTan);
          }
          for (let i = 0; i < 6; i++) {
            const a = (i / 6) * Math.PI * 2;
            const st = place(Math.cos(a) * 1.15, Math.sin(a) * 1.15);
            bBox({ x: st.x, z: st.z, rot: 0 }, 'z', -0.26, 0.26, -0.26, 0.26, gy, gy + 0.5, bmRock, g); // fire ring
          }
          bBox({ x: B.x, z: B.z, rot: 0 }, 'z', -0.4, 0.4, -0.4, 0.4, gy + 0.05, gy + 0.5, bmRock, g); // embers
          for (let i = 0; i < 3; i++) {
            const lg = place(1.6 + i * 0.75, -0.3);
            bBox({ x: lg.x, z: lg.z, rot: 0 }, 'x', -0.35, 0.35, -0.35, 0.35, gy + 0.15, gy + 0.45, bmPlankDark, g); // logs
          }
          for (const [su, sv] of [
            [3.4, 3.0],
            [-3.6, -2.6],
          ]) {
            const seat = place(su, sv);
            bBox({ x: seat.x, z: seat.z, rot: 0 }, 'x', -0.9, 0.9, -0.28, 0.28, gy, gy + 0.4, bmPlank, g); // log seats
          }
          const wr = place(-5.5, 5.5); // weapon rack
          bBox({ x: wr.x, z: wr.z, rot: 0 }, 'z', -0.08, 0.08, -0.08, 0.08, gy, gy + 1.3, bmPlankDark, g);
          bBox({ x: wr.x, z: wr.z, rot: 0 }, 'z', -0.08, 0.08, -0.08, 0.08, gy + 0.9, gy + 1.05, bmPlank, g);
          const cr = place(5.5, -5);
          bBox({ x: cr.x, z: cr.z, rot: 0 }, 'z', -0.55, 0.55, -0.55, 0.55, gy, gy + 1.0, bmCrate, g);
          break;
        }
        case 'radio': {
          buildRadioMast(B, gy, g);
          const h = place(-10, 7);
          buildShed({ x: h.x, z: h.z, rot: 1 }, gy, g);
          for (const side of [-1, 1]) {
            bBox(B, 'x', side * 10 - 0.12, side * 10 + 0.12, -10, 10, gy, gy + 1.1, bmWood, g);
          }
          bBox(B, 'z', -10, 10, -10.12, -9.88, gy, gy + 1.1, bmWood, g);
          const gen = place(3.5, -6);
          bBox({ x: gen.x, z: gen.z, rot: 0 }, 'z', -0.75, 0.75, -0.55, 0.55, gy, gy + 0.9, bmSteelDark, g); // generator
          break;
        }
        case 'ruins': {
          buildRuin(B, gy, g);
          const r2 = place(-15, 5);
          buildRuin({ x: r2.x, z: r2.z, rot: 1 }, gy, g);
          const tw = place(13, -11); // broken tower
          bBox({ x: tw.x, z: tw.z, rot: 0 }, 'z', -1.8, -1.5, -1.8, 1.8, gy, gy + 4.2, bmWall, g);
          bBox({ x: tw.x, z: tw.z, rot: 0 }, 'z', 1.5, 1.8, -1.8, 1.8, gy, gy + 3.1, bmWall, g);
          bBox({ x: tw.x, z: tw.z, rot: 0 }, 'x', -1.8, 1.8, -1.8, 1.8, gy + 4.2, gy + 4.5, bmSlab, g);
          bBox({ x: tw.x, z: tw.z, rot: 0 }, 'x', -1.8, 1.8, 1.5, 1.8, gy, gy + 4.2, bmWall, g);
          for (const [ru, rv] of [
            [6, 8],
            [-6, -13],
            [15, 2],
          ]) {
            const rb = place(ru, rv);
            bBox({ x: rb.x, z: rb.z, rot: 0 }, 'z', -0.5, 0.5, -0.5, 0.5, gy, gy + (0.4 + rnd() * 0.7), bmGravel, g); // rubble
          }
          break;
        }
        case 'outpost': {
          buildGuardTower(B, gy, g);
          const sh = place(-9, 9);
          buildShed({ x: sh.x, z: sh.z, rot: 0 }, gy, g);
          for (const [bu, bv] of [
            [6, 6],
            [-7, -6],
            [2, -8],
          ]) {
            const bb = place(bu, bv);
            bBox({ x: bb.x, z: bb.z, rot: 0 }, 'x', -1.2, 1.2, -0.3, 0.3, gy, gy + 0.9, bmConcrete, g); // barriers
          }
          const cr = place(4.5, -3.5);
          bBox({ x: cr.x, z: cr.z, rot: 0 }, 'z', -0.55, 0.55, -0.55, 0.55, gy, gy + 1.0, bmCrate, g);
          const fl = place(-3, 3); // floodlight post
          bBox({ x: fl.x, z: fl.z, rot: 0 }, 'z', -0.1, 0.1, -0.1, 0.1, gy, gy + 3.6, bmSteelDark, g);
          bBox({ x: fl.x, z: fl.z, rot: 0 }, 'z', -0.4, 0.4, -0.25, 0.25, gy + 3.6, gy + 4.1, bmLamp, g);
          break;
        }
        case 'watertower': {
          buildWaterTower(B, gy, g);
          const sh = place(8, -8);
          buildShed({ x: sh.x, z: sh.z, rot: 0 }, gy, g);
          break;
        }
      }

      poiLoot(POI_KINDS[p.kind].loot, p.x, p.z, p.r * 0.5, gy, p.id, rnd);
      } catch (err) {
        // A failed POI build must never kill the frame loop: record it,
        // reclaim the half-built group and retry on a later frame.
        console.error('POI build failed:', p.kind, err);
        const w = window as any;
        w.__poiBuildErr = w.__poiBuildErr || [];
        w.__poiBuildErr.push(p.kind + ': ' + String(err));
        fail();
        return;
      }
      // Safety net: a truncated build (few boxes registered, no throw)
      // re-arms itself for another attempt; three strikes and it stays down.
      const diff = voxBoxes.length - voxBefore;
      const w0 = window as any;
      w0.__poiBuildLog = w0.__poiBuildLog || [];
      w0.__poiBuildLog.push(p.kind + ' diff=' + diff + ' tries=' + p.tries);
      if (diff < 12) fail();
    }

    function dismantlePoi(p: Poi) {
      const g = p.group;
      if (!g) return;
      g.traverse((o: any) => {
        if (o.isMesh) o.geometry?.dispose?.();
      });
      scene.remove(g);
      for (let i = voxBoxes.length - 1; i >= 0; i--) {
        const v = voxBoxes[i];
        if (v.group === g) {
          if (v.inst) {
            v.group.remove(v.inst);
            const si = shootable.indexOf(v.inst);
            if (si >= 0) shootable.splice(si, 1);
            v.inst.geometry.dispose();
            (v.inst.material as THREE.Material).dispose();
            v.inst.dispose();
            v.inst = null;
          }
          if (v.barGroup) {
            disposeBar(v.barGroup);
            v.barGroup = null;
            v.barFill = null;
          }
          voxBoxes.splice(i, 1);
        }
      }
      for (let i = shootable.length - 1; i >= 0; i--) {
        const s: any = shootable[i];
        if (s.parent === g || s.userData?.vox?.group === g) shootable.splice(i, 1);
      }
      for (let i = solids.length - 1; i >= 0; i--) {
        if (solids[i].group === g) solids.splice(i, 1);
      }
      for (let i = pickups.length - 1; i >= 0; i--) {
        if (pickups[i].group.userData.poi === p.id) {
          scene.remove(pickups[i].group);
          pickups.splice(i, 1);
        }
      }
      p.group = null;
      p.built = false;
    }

    function clearPois() {
      for (const p of pois) dismantlePoi(p);
      pois.length = 0;
      flatZones.length = 0;
      clearWarProps(); // scattered war dressing belongs to the map too
      // POI pickups (incl. the port's, id -1) live in the scene
      for (let i = pickups.length - 1; i >= 0; i--) {
        if ((pickups[i].group.userData as any).poi !== undefined) {
          scene.remove(pickups[i].group);
          pickups.splice(i, 1);
        }
      }
    }

    function streamPois() {
      if (!terrainOn) return;
      const px = camera.position.x;
      const pz = camera.position.z;
      let budget = 1; // one POI per frame — building is hitch-free
      for (const p of pois) {
        const d = Math.hypot(p.x - px, p.z - pz);
        if (!p.built) {
          if (p.tries >= 3) continue; // gave up after repeated failures
          if (d < POI_BUILD_R && budget > 0) {
            buildPoiAt(p);
            budget--;
          }
        } else if (d > POI_KEEP_R) {
          dismantlePoi(p);
        }
      }
    }

    function enterHarbor() {
      world.visible = false;
      clearPois(); // reclaim any previous map's POIs, pickups and pads
      dummies.length = 0;
      spots.length = 0;
      solids.length = 0;
      shootable.length = 0;
      resetVox();
      pickups.length = 0;
      BUILDINGS.length = 0;
      // ?seed=N pins the map (reproducible harbours for e2e / sharing)
      const wantedSeed = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('seed') : null;
      terrainSeed = wantedSeed ? Math.abs(Math.floor(+wantedSeed)) || 1 : 1 + Math.floor(Math.random() * 1000000);
      for (const t of tiles.values()) disposeTile(t);
      tiles.clear();
      vegSolids.length = 0;
      mapHalf = HARBOR_HALF;
      terrainOn = true;
      seaMesh.visible = true;
      ground.visible = false;
      grid.visible = false;
      if (inventoryModeEl) inventoryModeEl.textContent = 'Harbor';
      if (dummySecEl) dummySecEl.hidden = true;
      // Plan the whole map BEFORE any terrain tile is built: the port
      // complex owns the coast, then seeded POIs (with their flatten
      // pads) fill the inland — the streamed mesh carries the pads.
      planHarbor();
      generatePois();
      generatePaths(); // road network paints onto the tiles as they stream
      generateWarProps(); // scattered battlefield dressing, clear of POIs
      woodRes = 60; // fresh harvest purse per match
      refreshWood();
      streamTerrain(true);
      // Harbor infrastructure: pier over the sea, container yard,
      // warehouses, crane, customs office, fuel tanks, dry dock,
      // breakwater + lighthouse — all voxel-destructible.
      harborGroup.visible = true;
      buildHarbor();
      // POI chips join the port chips on the compass
      for (const p of pois) harborMarks.push({ x: p.x, z: p.z, label: p.label, cls: p.cls });
      spawn = HARBOR_SPAWN;
      eyeH = EYE;
      camera.position.set(spawn.x, EYE + groundAt(spawn.x, spawn.z), spawn.z);
      yaw = portPlan ? Math.atan2(-(portPlan.cx - spawn.x), -(portPlan.cz - spawn.z)) : 0; // face the port centre
      pitch = 0;
      kick = 0;
      vy = 0;
      grounded = true;
      climb = null;
      slide = null;
      roll = null;
      airCarry = null;
      slideReq = false;
      rollReq = 0;
      // Harbor patrols: AI squads roam the island so recon (the
      // Antenna's scan, the shooters' duel) has someone to track.
      spawnHarborPatrols();
    }

    const HARBOR_PATROLS = 8;
    function spawnHarborPatrols() {
      let placed = 0;
      // Ring pass 1 (55-185 m) keeps patrols near the action, but on some
      // seeds the port platform + sea swallow the whole ring — pass 2
      // escalates outward (200-460 m) so the island is never empty.
      for (const [r0, r1, tries] of [
        [55, 185, 600],
        [200, 460, 900],
      ] as const) {
        for (let t = 0; placed < HARBOR_PATROLS && t < tries; t++) {
          const a = Math.random() * Math.PI * 2;
          const r = r0 + Math.random() * (r1 - r0);
          const x = HARBOR_SPAWN.x + Math.cos(a) * r;
          const z = HARBOR_SPAWN.z + Math.sin(a) * r;
          if (terrainHeight(x, z) < WATER_Y + 0.5) continue; // land only
          // never inside the port platform itself — patrols belong on
          // the island, not wedged between warehouse walls
          if (
            portPlan &&
            x > portPlan.cx - portPlan.L / 2 - 12 &&
            x < portPlan.cx + portPlan.L / 2 + 12 &&
            z > portPlan.cz - portPlan.D / 2 - 12 &&
            z < portPlan.cz + portPlan.D / 2 + 12
          )
            continue;
          if (!aiFree(x, z, null)) continue;
          // never inside a war decoration — no patrol wedged in a tank hull
          if (warZones.some((w) => Math.hypot(x - w.x, z - w.z) < w.r + 2)) continue;
          if (dummies.some((o) => Math.hypot(o.group.position.x - x, o.group.position.z - z) < 30)) continue;
          const d = spawnDummy(x, z, true, true);
          // The flat range world group is hidden in Harbor: patrols live
          // on the scene and ride the streamed terrain mesh.
          world.remove(d.group);
          scene.add(d.group);
          d.group.position.set(x, Math.max(groundAt(x, z), WATER_Y), z);
          placed += 1;
        }
        if (placed >= HARBOR_PATROLS) break;
      }
    }

    // ----------------------------------------------------
    // Top compass: a scrolling N/E/S/W strip at the top of the
    // HUD that tracks the camera yaw. In Harbor mode it also
    // carries landmark chips (PIER / YARD / CRANE / WHSE) with
    // live bearing and distance, so the facilities are easy to
    // find. Chips pin to the strip edge (with ‹ › arrows) when
    // the landmark is off-screen — turn that way to reach it.
    // ----------------------------------------------------
    const compassEl = $('compass');
    const compassWin = $('compassWindow');
    const compassStrip = $('compassStrip');
    const compassMarksEl = $('compassMarks');
    const compassDegEl = $('compassDeg');
    const COMPASS_PX = 4; // pixels per degree of bearing
    const COMPASS_PERIOD = 360 * COMPASS_PX; // one full ring of the strip
    const CARD8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

    if (compassStrip) {
      // Three copies of the tick ring so the strip can scroll through
      // the 0/360 seam without ever showing a gap.
      for (let copy = 0; copy < 3; copy++) {
        for (let d = 0; d < 360; d += 15) {
          const x = copy * COMPASS_PERIOD + d * COMPASS_PX;
          const tick = document.createElement('i');
          tick.className = 'compass-tick' + (d % 90 === 0 ? ' major' : d % 45 === 0 ? ' mid' : '');
          tick.style.left = x + 'px';
          compassStrip.appendChild(tick);
          if (d % 45 === 0) {
            const card = document.createElement('b');
            const name = CARD8[d / 45];
            card.className = 'compass-card' + (d % 90 === 0 ? '' : ' minor') + (name === 'N' ? ' n' : '');
            card.textContent = name;
            card.style.left = x + 'px';
            compassStrip.appendChild(card);
          }
        }
      }
    }

    // Up to six landmark chips, reconfigured to the NEAREST marks
    // whenever the set changes or the player travels 40+ m — with the
    // port complex and every POI carrying a chip, the closest six are
    // always the ones worth navigating by.
    const compassChips: HTMLSpanElement[] = [];
    if (compassMarksEl) {
      for (let i = 0; i < 6; i++) {
        const chip = document.createElement('span');
        chip.className = 'compass-mark';
        chip.style.display = 'none';
        const lbl = document.createElement('b');
        const dist = document.createElement('small');
        chip.appendChild(lbl);
        chip.appendChild(dist);
        compassMarksEl.appendChild(chip);
        compassChips.push(chip);
      }
    }
    let compassChipsFor: HarborMark[] | null = null;
    let compassSelFor: HarborMark[] | null = null;
    let compassSelPx = NaN;
    let compassSelPz = NaN;
    let compassSel: HarborMark[] = [];

    function compassSelection(): HarborMark[] {
      const p = camera.position;
      if (harborMarks !== compassSelFor || Math.hypot(p.x - compassSelPx, p.z - compassSelPz) > 40) {
        compassSelFor = harborMarks;
        compassSelPx = p.x;
        compassSelPz = p.z;
        compassSel = harborMarks
          .map((m) => ({ m, d: Math.hypot(m.x - p.x, m.z - p.z) }))
          .sort((a, b) => a.d - b.d)
          .slice(0, compassChips.length)
          .map((q) => q.m);
      }
      return compassSel;
    }

    function updateCompass() {
      if (!compassEl || !compassWin || !compassStrip) return;
      if (!running()) {
        if (!compassEl.hidden) compassEl.hidden = true; // menu / pause / inventory
        return;
      }
      if (compassEl.hidden) compassEl.hidden = false;
      const w = compassWin.clientWidth || 1;
      // Yaw 0 faces -Z (north); turning right lowers yaw, so compass
      // bearing is -yaw wrapped to 0..360 (N -> E -> S -> W clockwise).
      const bearing = (((-yaw * 180) / Math.PI) % 360 + 360) % 360;
      compassStrip.style.transform = `translateX(${w / 2 - (COMPASS_PERIOD + bearing * COMPASS_PX)}px)`;
      if (compassDegEl) {
        const txt = `${CARD8[Math.round(bearing / 45) % 8]} ${Math.round(bearing)}\u00b0`;
        if (compassDegEl.textContent !== txt) compassDegEl.textContent = txt;
      }
      const sel = compassSelection();
      if (sel !== compassChipsFor) {
        compassChipsFor = sel;
        for (let i = 0; i < compassChips.length; i++) {
          const chip = compassChips[i];
          const m = sel[i];
          chip.style.display = m ? '' : 'none';
          if (!m) continue;
          chip.className = 'compass-mark ' + m.cls;
          const lbl = chip.querySelector('b');
          if (lbl) lbl.textContent = m.label;
        }
      }
      if (!compassChips.length) return;
      const maxOff = w / 2 - 26;
      const p = camera.position;
      // Chip half-widths, read once per frame (single reflow).
      const hws = compassChips.map((c) => (c.offsetWidth || 36) / 2);
      const placed: { c: number; hw: number }[] = [];
      for (let i = 0; i < compassChips.length; i++) {
        const chip = compassChips[i];
        const m = sel[i];
        if (!m) continue;
        const hw = hws[i];
        const dx = m.x - p.x;
        const dz = m.z - p.z;
        const dist = Math.round(Math.hypot(dx, dz));
        const rel = (((Math.atan2(dx, -dz) * 180) / Math.PI - bearing + 540) % 360) - 180;
        const relPx = rel * COMPASS_PX;
        const offScreen = relPx < -maxOff || relPx > maxOff;
        let off = Math.max(-maxOff, Math.min(maxOff, relPx));
        // Landmarks that share a bearing fan out along the strip so chips
        // never overlap: the first chip keeps the exact bearing, later
        // ones step toward the strip centre by measured chip width.
        const collide = (x: number) => placed.some((q) => Math.abs(x - q.c) < hw + q.hw + 14);
        if (collide(off)) {
          const dir = off >= 0 ? -1 : 1;
          const step = hw * 2 + 14;
          const tryFan = (allowCross: boolean) => {
            let c = off;
            for (let t = 0; t < 8; t++) {
              c += dir * step;
              if (Math.abs(c) > maxOff || (!allowCross && c * off < 0)) return null;
              if (!collide(c)) return c;
            }
            return null;
          };
          off = tryFan(false) ?? tryFan(true) ?? off;
        }
        placed.push({ c: off, hw });
        // Off-screen landmarks go compact (label only); an edge arrow marks
        // the chip still sitting exactly at the strip border.
        let cls = 'compass-mark ' + m.cls + (offScreen ? ' pinned' : '');
        if (off <= -maxOff + 0.5) cls += ' pin-l';
        else if (off >= maxOff - 0.5) cls += ' pin-r';
        if (chip.className !== cls) chip.className = cls;
        chip.style.transform = `translate(calc(${off}px - 50%), 0px)`;
        const dTxt = dist + 'm';
        const sm = chip.querySelector('small');
        if (sm && sm.textContent !== dTxt) sm.textContent = dTxt;
      }
    }

    // Main menu & Character Pick
    let character = 'bulwark';
    const modeBtns = Array.from(document.querySelectorAll('.mode')) as HTMLButtonElement[];
    const charBtns = Array.from(document.querySelectorAll('.char')) as HTMLButtonElement[];
    const lobbyEnvBg = $('lobbyEnvBg');
    const lobbyCharStage = $('lobbyCharStage');
    const lobbyCharTag = $('lobbyCharTag');
    let selectedMode = 'range';

    function updateLobbyScene(mode: string, char: string) {
      if (lobbyEnvBg) {
        lobbyEnvBg.setAttribute('data-mode', mode);
        lobbyEnvBg.className = `lobby-env-bg mode-${mode}`;
      }
      if (lobbyCharStage) {
        lobbyCharStage.setAttribute('data-char', char);
      }
      if (lobbyCharTag) {
        const modeLabel = mode === 'harbor' ? 'HARBOR SHORE' : mode === 'quarry' ? 'QUARRY PITS' : 'FIRING RANGE';
        const charLabel = char === 'barrage' ? 'BARRAGE' : char === 'antenna' ? 'ANTENNA' : 'BULWARK';
        lobbyCharTag.textContent = `OPERATOR // ${charLabel} - FACING ${modeLabel}`;
      }
    }

    function pickOne(buttons: HTMLButtonElement[], chosen: HTMLButtonElement) {
      for (const b of buttons) b.setAttribute('aria-checked', String(b === chosen));
    }

    modeBtns.forEach((b) =>
      b.addEventListener('click', () => {
        if (b.disabled) return;
        selectedMode = b.dataset.mode || 'range';
        pickOne(modeBtns, b);
        updateLobbyScene(selectedMode, character);
      })
    );

    charBtns.forEach((b) =>
      b.addEventListener('click', () => {
        pickOne(charBtns, b);
        character = b.dataset.char || 'bulwark';
        applyCharacter();
        updateLobbyScene(selectedMode, character);
      })
    );

    updateLobbyScene(selectedMode, character);

    function startGame() {
      if (selectedMode === 'harbor') enterHarbor();
      else if (selectedMode !== 'range') return;
      else refreshWood(); // Test Range: free builds — hide the wood plate
      if (menuEl) menuEl.hidden = true;
      canvas?.requestPointerLock?.()?.catch?.(() => {});
    }

    playBtn?.addEventListener('click', startGame);

    // Check for ?autostart=1 query param (Ultra Mode requirement)
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.get('autostart') === '1') {
        setTimeout(startGame, 100);
      }
      if (params.get('debug') === '1') {
        // Dev-only test hook (?debug=1): drive explosions and teleports so
        // voxel destruction and blast-cover mechanics can be verified live
        setTimeout(() => {
          (window as any).__debug = {
            blast: (bx: number, bz: number) =>
              explode(bx, bz, GREN.blast.radius, GREN.blast.dmg, GREN.blast.selfDmg),
            buildings: () => BUILDINGS.map((b: any) => ({ x: b.x, z: b.z, hx: b.hx, hz: b.hz, kind: b.kind, rot: b.rot, door: b.door })),
            moveTo: (mx: number, mz: number, my?: number) => {
              if (my !== undefined) {
                camera.position.set(mx, my, mz);
                vy = 0;
                grounded = true;
                return;
              }
              const s = supportAt(mx, mz, groundAt(mx, mz) + 3);
              camera.position.set(mx, s + EYE, mz);
              vy = 0;
              grounded = true;
            },
            grenades: () => {
              grenades.blast = 9;
              refreshGrenades();
            },
            buildWall: (bx: number, bz: number, ang = 0) => buildFortniteWall(bx, groundAt(bx, bz), bz, ang),
            popupInfo: () => ({
              cam: { x: +camera.position.x.toFixed(1), y: +camera.position.y.toFixed(1), z: +camera.position.z.toFixed(1) },
              popups: damagePopups.map((p) => ({
                x: +p.sprite.position.x.toFixed(1),
                y: +p.sprite.position.y.toFixed(1),
                z: +p.sprite.position.z.toFixed(1),
                o: +p.mat.opacity.toFixed(2),
                s: p.sprite.scale.x.toFixed(1),
              })),
            }),
            voxStats: () => ({
              boxes: voxBoxes.length,
              alive: voxBoxes.reduce((n, v) => n + (v.gone ? 0 : 1), 0),
              aliveVox: voxBoxes.reduce((n, v) => n + (v.gone ? 0 : v.aliveCount), 0),
              collapsed: voxBoxes.reduce((n, v) => n + (v.collapsed ? 1 : 0), 0),
              walls: wallDests.size,
              popups: damagePopups.length,
            }),
            setYaw: (rad: number) => {
              yaw = rad;
              pitch = 0;
            },
            groundAt: (gx: number, gz: number) => +groundAt(gx, gz).toFixed(3),
            waterInfo: () => {
              const s = waterState();
              return { floor: +s.floor.toFixed(2), wet: s.wet, swimming: s.swimming, depth: +(WATER_Y - s.floor).toFixed(2), underFx };
            },
            harborInfo: () => harborAnchor,
            antenna: () =>
              antenna
                ? {
                    x: +antenna.group.position.x.toFixed(1),
                    z: +antenna.group.position.z.toFixed(1),
                    hp: Math.ceil(antenna.hp),
                    maxHp: antenna.maxHp,
                    left: +antenna.left.toFixed(1),
                  }
                : null,
            charInfo: () => ({
              character,
              life: Math.ceil(life),
              lifeMax: lifeMax(),
              enemiesUp: dummies.filter((d) => d.state === 'up').length,
              mapOpen,
              minimapHidden: ($('minimap') as any)?.hidden ?? true,
            }),
            moveInfo: () => ({
              x: +camera.position.x.toFixed(2),
              y: +camera.position.y.toFixed(2),
              z: +camera.position.z.toFixed(2),
              feet: +(camera.position.y - eyeH).toFixed(2),
              ground: +groundAt(camera.position.x, camera.position.z).toFixed(2),
              groundRef: +groundRef.toFixed(2),
              grounded,
              sprinting,
              crouched: crouchHeld(),
              sliding: !!slide,
              eyeH: +eyeH.toFixed(2),
              pitch: +pitch.toFixed(2),
            }),
            buildInfo: () => ({
              mode: buildMode,
              piece: BUILD_PIECES[buildPieceIdx].kind,
              resolved: buildMode ? resolvedBuildKind() : null,
            }),
            setPitch: (rad: number) => {
              pitch = THREE.MathUtils.clamp(rad, -1.5, 1.5);
            },
            placeAuto: () => {
              buildPieceIdx = 0;
              toggleBuildWall(true);
              placeWall();
            },
            armBuild: () => {
              buildPieceIdx = 0;
              toggleBuildWall(true);
            },
            disarmBuild: () => toggleBuildWall(false),
            biome: (bx: number, bz: number) => {
              biomeWeights(bx, bz, VW);
              return {
                mw: +VW.mw.toFixed(3),
                lw: +VW.lw.toFixed(3),
                jw: +VW.jw.toFixed(3),
                fw: +VW.fw.toFixed(3),
                gw: +VW.gw.toFixed(3),
                sum: +(VW.mw + VW.lw + VW.jw + VW.fw + VW.gw).toFixed(3),
                h: +terrainHeight(bx, bz).toFixed(2),
              };
            },
            vegInfo: () => {
              let withVeg = 0;
              let vegSolidCount = 0;
              for (const t of tiles.values()) {
                if (t.veg) {
                  withVeg++;
                  vegSolidCount += (t.vegSolids ?? []).length;
                }
              }
              return {
                tiles: tiles.size,
                withVeg,
                vegSolids: vegSolids.length,
                vegSolidRefs: vegSolidCount,
                solids: solids.length,
                sample: vegSolids.slice(0, 4).map((s) => ({ x: +s.x.toFixed(1), z: +s.z.toFixed(1), b: +(s.bottom ?? 0).toFixed(1), t: +s.top.toFixed(1) })),
              };
            },
            vegRay: (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max = 60) => {
              const d = vegCut(new THREE.Vector3(ox, oy, oz), new THREE.Vector3(dx, dy, dz).normalize(), max);
              return d === Infinity ? null : +d.toFixed(2);
            },
            port: () => portPlan,
            seed: () => terrainSeed,
            paths: () => ({
              segs: paths.length,
              samples: pathMeta.length,
              kinds: paths.reduce((acc, s) => {
                acc[s.kind] = (acc[s.kind] || 0) + 1;
                return acc;
              }, {} as Record<number, number>),
              totalLen: Math.round(paths.reduce((a, s) => a + (s.pts.length / 2 - 1) * 8, 0)),
              longest: paths.length ? Math.round(Math.max(...paths.map((s) => (s.pts.length / 2 - 1) * 8))) : 0,
            }),
            pathAt: (x: number, z: number) => {
              const np = nearPath(x, z);
              return np ? { d: +np.d.toFixed(1), w: +np.w.toFixed(1), kind: np.kind } : null;
            },
            wood: () => Math.floor(woodRes),
            addWood: (n: number) => {
              woodRes = Math.max(0, woodRes + n);
              refreshWood();
              return Math.floor(woodRes);
            },
            // Replay the patrol-placement predicates and report why each
            // candidate fails (e2e diagnostics for empty patrol spawns).
            patrolProbe: () => {
              const why = { sea: 0, port: 0, ai: 0, war: 0, close: 0, ok: 0 };
              let firstOk: { x: number; z: number } | null = null;
              for (let t = 0; t < 600; t++) {
                const a = Math.random() * Math.PI * 2;
                const r = 55 + Math.random() * 130;
                const x = HARBOR_SPAWN.x + Math.cos(a) * r;
                const z = HARBOR_SPAWN.z + Math.sin(a) * r;
                if (terrainHeight(x, z) < WATER_Y + 0.5) {
                  why.sea++;
                  continue;
                }
                if (
                  portPlan &&
                  x > portPlan.cx - portPlan.L / 2 - 12 &&
                  x < portPlan.cx + portPlan.L / 2 + 12 &&
                  z > portPlan.cz - portPlan.D / 2 - 12 &&
                  z < portPlan.cz + portPlan.D / 2 + 12
                ) {
                  why.port++;
                  continue;
                }
                if (!aiFree(x, z, null)) {
                  why.ai++;
                  continue;
                }
                if (warZones.some((w) => Math.hypot(x - w.x, z - w.z) < w.r + 2)) {
                  why.war++;
                  continue;
                }
                if (dummies.some((o) => Math.hypot(o.group.position.x - x, o.group.position.z - z) < 30)) {
                  why.close++;
                  continue;
                }
                why.ok++;
                if (!firstOk) firstOk = { x: +x.toFixed(1), z: +z.toFixed(1) };
              }
              return { why, firstOk, spawn: { x: +HARBOR_SPAWN.x.toFixed(0), z: +HARBOR_SPAWN.z.toFixed(0) }, live: dummies.length };
            },
            warProps: () => {
              const byKind: Record<string, number> = {};
              for (const p of warProps) byKind[p.kind] = (byKind[p.kind] || 0) + 1;
              return {
                total: warProps.length,
                byKind,
                sample: warProps.slice(0, 6).map((p) => ({ kind: p.kind, x: +p.x.toFixed(0), z: +p.z.toFixed(0), boxes: p.group.children.length })),
                inWater: warProps.filter((p) => terrainHeight(p.x, p.z) < WATER_Y).length,
                onPoi: warProps.filter((p) => flatZones.some((f) => Math.hypot(p.x - f.x, p.z - f.z) < f.r)).length,
              };
            },
            // Nearest destructible tree lattices — harvest e2e teleports
            // next to one and shootPoints its trunk.
            trees: (n = 12) => {
              const list = voxBoxes
                .filter((v) => v.gain > 0)
                .map((v) => {
                  const cx = v.x0 + (v.nx * v.sx) / 2;
                  const cz = v.z0 + (v.nz * v.sz) / 2;
                  return {
                    x: +cx.toFixed(1),
                    z: +cz.toFixed(1),
                    base: +v.y0.toFixed(1),
                    top: +(v.y0 + v.ny * v.sy).toFixed(1),
                    alive: v.aliveCount,
                    total: v.total,
                    inst: !!v.inst,
                    gone: v.gone,
                    d: Math.round(Math.hypot(cx - camera.position.x, cz - camera.position.z)),
                  };
                })
                .sort((a, b) => a.d - b.d);
              return { count: list.length, nearest: list.slice(0, n) };
            },
            // Atomic e2e: aim at a world point, run the full shoot()
            // cut pipeline and — when the line is clean — fire for real.
            // Used to prove bullets chip voxel trees / war props.
            shootPoint: (x: number, y: number, z: number) => {
              const dx = x - camera.position.x;
              const dz = z - camera.position.z;
              const dist = Math.max(2, Math.hypot(dx, dz));
              yaw = Math.atan2(-dx, -dz);
              pitch = Math.atan2(y - camera.position.y, dist);
              applyView();
              raycaster.setFromCamera(centre, camera);
              const hit = raycaster.intersectObjects(nearShootable(170), false)[0];
              if (!hit) return { saw: false, vox: false, fired: false, reason: 'no-hit' };
              const vox = !!hit.object.userData.vox;
              if (shotCut(raycaster.ray, hit.distance) < hit.distance) return { saw: true, vox, fired: false, reason: 'structure' };
              if (vegCut(raycaster.ray.origin, raycaster.ray.direction, hit.distance) < hit.distance) return { saw: true, vox, fired: false, reason: 'veg' };
              if (smokeDist(raycaster.ray.origin, raycaster.ray.direction, hit.distance) < Infinity) return { saw: true, vox, fired: false, reason: 'smoke' };
              const w = current;
              const can = !!w && w.loaded > 0 && cooldown <= 0 && reloadT <= 0 && !roll && !buildMode && !gArmed && !bombArmed;
              shoot();
              return { saw: true, vox, fired: can, d: +hit.distance.toFixed(1) };
            },
            // Debug grenade: carve trees / walls / props without the throw
            blastAt: (x: number, z: number, r = 7, dmg = 120, y?: number) => {
              explode(x, z, r, dmg, 0, undefined, undefined, y);
              return true;
            },
            dummiesInfo: () =>
              dummies.map((d) => ({
                hp: +d.hp.toFixed(1),
                lifeMax: d.lifeMax,
                shield: +d.shield.toFixed(1),
                state: d.state,
                x: +d.group.position.x.toFixed(1),
                z: +d.group.position.z.toFixed(1),
                shooter: !!d.shooter,
                ai: !!d.ai,
              })),
            fire: () => {
              const w = current;
              // report whether the trigger pull would actually shoot —
              // e2e uses it to tell "missed" apart from "never fired"
              const can = !!w && w.loaded > 0 && cooldown <= 0 && reloadT <= 0 && !roll && !buildMode && !gArmed && !bombArmed;
              shoot();
              return can;
            },
            rayHit: () => {
              applyView();
              raycaster.setFromCamera(centre, camera);
              const hit = raycaster.intersectObjects(nearShootable(170), false)[0];
              let reach = hit ? hit.distance : 150;
              const gc = shotCut(raycaster.ray, reach);
              const cut = gc < reach;
              if (cut) reach = gc;
              const vc = vegCut(raycaster.ray.origin, raycaster.ray.direction, reach);
              const veg = vc < reach;
              if (veg) reach = vc;
              const smoke = smokeDist(raycaster.ray.origin, raycaster.ray.direction, reach) < Infinity;
              return {
                d: +reach.toFixed(2),
                // dummy AND the full shoot() cut pipeline is clean — a
                // bullet fired with this camera state WILL damage it
                dummy: !!hit && !!hit.object.userData.dummy && !cut && !veg && !smoke,
                seesDummy: !!hit?.object.userData.dummy,
                cut,
                veg,
                smoke,
              };
            },
            // Atomic e2e probe: aim the camera at patrol `idx`'s chest,
            // run the exact shoot() cut pipeline, and — when the line is
            // clean — pull the trigger for real. No eval-latency gaps
            // between aim, probe and shot.
            shootPatrol: (idx: number) => {
              const d2 = dummies[idx];
              if (!d2 || d2.state !== 'up') return { saw: false, clean: false, fired: false, reason: 'gone' };
              const px = d2.group.position.x;
              const pz = d2.group.position.z;
              const gy = Math.max(groundAt(px, pz), WATER_Y);
              const dx = px - camera.position.x;
              const dz = pz - camera.position.z;
              const dist = Math.max(2, Math.hypot(dx, dz));
              yaw = Math.atan2(-dx, -dz);
              pitch = Math.atan2(gy + 1.15 - camera.position.y, dist);
              applyView();
              raycaster.setFromCamera(centre, camera);
              const hit = raycaster.intersectObjects(nearShootable(170), false)[0];
              const saw = !!hit?.object.userData.dummy;
              if (!saw) return { saw, clean: false, fired: false, reason: 'no-dummy' };
              const reach = hit.distance;
              if (shotCut(raycaster.ray, reach) < reach) return { saw, clean: false, fired: false, reason: 'structure' };
              if (vegCut(raycaster.ray.origin, raycaster.ray.direction, reach) < reach) return { saw, clean: false, fired: false, reason: 'veg' };
              if (smokeDist(raycaster.ray.origin, raycaster.ray.direction, reach) < Infinity) return { saw, clean: false, fired: false, reason: 'smoke' };
              const w = current;
              const can = !!w && w.loaded > 0 && cooldown <= 0 && reloadT <= 0 && !roll && !buildMode && !gArmed && !bombArmed;
              shoot();
              return { saw, clean: true, fired: can };
            },
            pickupsInfo: () =>
              pickups.map((p) => ({
                k: p.kind,
                x: +p.x.toFixed(0),
                z: +p.z.toFixed(0),
                poi: (p.group.userData as any).poi,
                taken: p.taken,
              })),
            pois: () =>
              pois.map((p) => ({
                id: p.id,
                kind: p.kind,
                x: +p.x.toFixed(0),
                z: +p.z.toFixed(0),
                gy: +p.gy.toFixed(1),
                r: p.r,
                rot: p.rot,
                built: p.built,
                tries: p.tries,
                dist: Math.round(Math.hypot(p.x - camera.position.x, p.z - camera.position.z)),
              })),
            streamInfo: () => ({
              poisBuilt: pois.filter((p) => p.built).length,
              poisTotal: pois.length,
              solids: solids.length,
              voxBoxes: voxBoxes.length,
              shootable: shootable.length,
              pickups: pickups.length,
              marks: harborMarks.length,
            }),
            compassInfo: () => {
              const b = (((-yaw * 180) / Math.PI) % 360 + 360) % 360;
              const p = camera.position;
              return {
                bearing: +b.toFixed(1),
                facing: CARD8[Math.round(b / 45) % 8],
                visible: !!compassEl && !compassEl.hidden,
                marks: harborMarks.map((m) => ({
                  label: m.label,
                  dist: Math.round(Math.hypot(m.x - p.x, m.z - p.z)),
                  rel: +((((Math.atan2(m.x - p.x, -(m.z - p.z)) * 180) / Math.PI - b + 540) % 360) - 180).toFixed(1),
                })),
              };
            },
            solidsNear: (nx: number, nz: number, r = 8) =>
              solids
                .filter((b) => Math.hypot(b.x - nx, b.z - nz) < r)
                .map((b) => ({ x: +b.x.toFixed(1), z: +b.z.toFixed(1), hx: +b.hx.toFixed(2), hz: +b.hz.toFixed(2), top: +b.top.toFixed(2), bottom: +(b.bottom ?? 0).toFixed(2) })),
            buildPiece: () => BUILD_PIECES[buildPieceIdx].kind,
            cyclePiece: (dir = 1) => cycleBuildPiece(dir),
          };
        }, 300);
      }
    }

    // ----------------------------------------------------
    // Headless-only test hook (never active for real players).
    // Parity with the BR-web repo's window.__brTest so the same
    // e2e scripts verify grenade/cover/destruction mechanics.
    // ----------------------------------------------------
    if (isHeadless) {
      (window as any).__brTest = {
        giveGrenade: (kind: string = 'blast', n: number = 1) => {
          (grenades as any)[kind] = ((grenades as any)[kind] ?? 0) + n;
          refreshGrenades();
        },
        grenadeCounts: () => ({ ...(grenades as any) }),
        destructibleCount: () => wallDests.size + voxBoxes.reduce((n, v) => n + (v.gone ? 0 : 1), 0),
        isPlayerDown: () => playerDown,
        buildAt: (x: number, z: number, ang = 0) => buildFortniteWall(x, groundAt(x, z), z, ang),
        wallCount: () => wallDests.size,
        damageWallByIndex: (i: number, amount: number) => {
          const dest = Array.from(wallDests.values())[i];
          if (dest) damageWall(dest, amount);
        },
        pickCharacter: (c: string) => {
          character = c;
          applyCharacter();
          return character;
        },
        deployAntenna: () => {
          summonAntenna();
          return !!antenna;
        },
        antennaInfo: () =>
          antenna
            ? {
                hp: +antenna.hp.toFixed(1),
                maxHp: antenna.maxHp,
                left: +antenna.left.toFixed(1),
                x: +antenna.group.position.x.toFixed(1),
                z: +antenna.group.position.z.toFixed(1),
              }
            : null,
        hurtAntenna: (amount: number) => {
          damageAntenna(amount);
          return antenna ? Math.ceil(antenna.hp) : 0;
        },
        toggleMap: (open: boolean) => {
          setMapOpen(open);
          return mapOpen;
        },
      };
    }

    // ----------------------------------------------------
    // Touch controls
    // ----------------------------------------------------
    function setStick(x: number, y: number) {
      if (!stickBase || !stickKnob) return;
      const r = stickBase.getBoundingClientRect();
      let dx = (x - (r.left + r.width / 2)) / (r.width / 2);
      let dy = (y - (r.top + r.height / 2)) / (r.height / 2);
      const len = Math.hypot(dx, dy);
      if (len > 1) {
        dx /= len;
        dy /= len;
      }
      if (len < 0.12) {
        dx = 0;
        dy = 0;
      }
      stick.x = dx;
      stick.y = dy;
      stickKnob.style.transform = `translate(${dx * 36}px, ${dy * 36}px)`;
    }

    function releaseTouch() {
      touches.clear();
      stickId = aimId = null;
      stick.x = stick.y = 0;
      if (stickKnob) stickKnob.style.transform = '';
      sliderTouch = null;
      sliderEl?.classList.remove('is-pressed');
      if (sliderKnobEl) sliderKnobEl.style.transform = '';
      aimBtn?.classList.remove('is-pressed');
      slotEls.forEach((el) => el?.classList.remove('is-pressed'));
      slotHold = null;
      cancelGrenadePress();
    }

    function slotAt(x: number, y: number) {
      for (let i = 0; i < slotEls.length; i++) {
        const el = slotEls[i];
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (x >= r.left - 6 && x <= r.right + 6 && y >= r.top - 6 && y <= r.bottom + 6) return i;
      }
      return -1;
    }

    function roleAt(x: number, y: number) {
      const near = (el: HTMLElement | null, k: number) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2)) <= (r.width / 2) * k;
      };
      if (inRect($('fireModeAuto'), x, y, 6)) return 'fireModeAuto';
      if (inRect($('fireModeManual'), x, y, 6)) return 'fireModeManual';
      if (inRect(minimapEl, x, y, 8)) return 'minimap';
      if (near(stickBase, 1.5)) return 'stick';
      if (near(aimBtn, 1.2)) return 'aim';
      if (near(turretEl, 1)) return 'turret';
      if (near($('touchBuildBtn'), 1.2)) return 'build';
      if (inRect(gBtnEl, x, y, 12)) return 'grenade';
      if (inRect(inventoryBtnEl, x, y, 6)) return 'inventory';
      if (pickOffer && pickBtn) {
        const r = pickBtn.getBoundingClientRect();
        if (x >= r.left - 8 && x <= r.right + 8 && y >= r.top - 8 && y <= r.bottom + 8) return 'pick';
      }
      if (inRect(sliderEl, x, y, 6)) return 'slider';
      if (slotAt(x, y) >= 0) return 'slot';
      return 'look';
    }

    const SLIDER_GESTURE = 22;
    const SLIDER_KNOB_R = 24;

    function sliderStart(t: Touch) {
      sliderTouch = { id: t.identifier, x0: t.clientX, y0: t.clientY, committed: false, down: false };
      sliderEl?.classList.add('is-pressed');
    }

    function sliderMove(t: Touch) {
      const s = sliderTouch;
      if (!s) return;
      const dx = t.clientX - s.x0;
      const dy = t.clientY - s.y0;
      if (!s.committed) {
        if (Math.abs(dx) >= SLIDER_GESTURE && Math.abs(dx) > Math.abs(dy)) {
          s.committed = true;
          rollReq = dx < 0 ? -1 : 1;
        } else if (dy >= SLIDER_GESTURE && dy > Math.abs(dx)) {
          s.committed = true;
          s.down = true;
          if (moving && grounded) {
            slideReq = true;
            crouched = true;
          } else {
            crouched = !crouched;
          }
        }
      }
      const kx = THREE.MathUtils.clamp(dx, -SLIDER_KNOB_R, SLIDER_KNOB_R);
      const ky = THREE.MathUtils.clamp(dy, -SLIDER_KNOB_R, SLIDER_KNOB_R);
      if (sliderKnobEl) sliderKnobEl.style.transform = `translate(${kx}px, ${ky}px)`;
    }

    function sliderEnd() {
      const s = sliderTouch;
      sliderTouch = null;
      sliderEl?.classList.remove('is-pressed');
      if (sliderKnobEl) sliderKnobEl.style.transform = '';
      if (s && !s.committed) {
        jumpTap = true;
        crouched = false;
      }
    }

    const onTouchStart = (e: TouchEvent) => {
      if (!running()) return;
      if (mapOpen) {
        e.preventDefault();
        setMapOpen(false);
        return;
      }
      e.preventDefault();
      for (const t of Array.from(e.changedTouches)) {
        let role = roleAt(t.clientX, t.clientY);
        if (role === 'fireModeAuto') {
          setFireMode('auto');
          continue;
        }
        if (role === 'fireModeManual') {
          setFireMode('manual');
          continue;
        }
        if (role === 'minimap') {
          setMapOpen(true);
          continue;
        }
        if (role === 'stick' && stickId !== null) role = 'look';
        if (role === 'aim' && aimId !== null) role = 'look';
        if (role === 'slider' && sliderTouch !== null) role = 'look';
        const slot = role === 'slot' ? slotAt(t.clientX, t.clientY) : -1;
        touches.set(t.identifier, { role, x: t.clientX, y: t.clientY, slot });
        if (role === 'stick') {
          stickId = t.identifier;
          setStick(t.clientX, t.clientY);
        }
        if (role === 'aim') {
          aimId = t.identifier;
          aimBtn?.classList.add('is-pressed');
          aimPressed();
        }
        if (role === 'slot' && slot >= 0) {
          pressSlot(slot);
          slotEls[slot]?.classList.add('is-pressed');
        }
        if (role === 'pick') {
          forcePick();
          pickBtn?.classList.add('is-pressed');
          setTimeout(() => pickBtn?.classList.remove('is-pressed'), 120);
        }
        if (role === 'slider') sliderStart(t);
        if (role === 'turret') {
          primaryAction();
          turretEl?.classList.add('is-pressed');
          setTimeout(() => turretEl?.classList.remove('is-pressed'), 120);
        }
        if (role === 'grenade') {
          grenadeDown('touch', t.identifier, t.clientY);
          gBtnEl?.classList.add('is-pressed');
          setTimeout(() => gBtnEl?.classList.remove('is-pressed'), 120);
        }
        if (role === 'build') {
          toggleBuildWall();
          touchBuildBtnEl?.classList.add('is-pressed');
          setTimeout(() => touchBuildBtnEl?.classList.remove('is-pressed'), 120);
        }
        if (role === 'inventory') openInventory();
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!running()) return;
      e.preventDefault();
      for (const t of Array.from(e.changedTouches)) {
        const tc = touches.get(t.identifier);
        if (!tc) continue;
        if (tc.role === 'stick') setStick(t.clientX, t.clientY);
        if (tc.role === 'slider') sliderMove(t);
        if (tc.role === 'grenade') grenadeSlide(t.identifier, t.clientY);
        if (tc.role === 'look' || tc.role === 'aim') {
          const sens = TOUCH_SENS * lookScale();
          yaw -= (t.clientX - tc.x) * sens;
          pitch = THREE.MathUtils.clamp(pitch - (t.clientY - tc.y) * sens, -1.5, 1.5);
        }
        tc.x = t.clientX;
        tc.y = t.clientY;
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (running()) e.preventDefault();
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === stickId) {
          stickId = null;
          stick.x = stick.y = 0;
          if (stickKnob) stickKnob.style.transform = '';
        }
        if (sliderTouch && t.identifier === sliderTouch.id) sliderEnd();
        if (t.identifier === aimId) {
          aimId = null;
          aimBtn?.classList.remove('is-pressed');
        }
        grenadeUp('touch', t.identifier);
        const tc = touches.get(t.identifier);
        if (tc?.role === 'slot' && tc.slot >= 0) {
          releaseSlot(tc.slot);
          slotEls[tc.slot]?.classList.remove('is-pressed');
        }
        touches.delete(t.identifier);
      }
    };

    window.addEventListener('touchstart', onTouchStart, { passive: false });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd, { passive: false });
    window.addEventListener('touchcancel', onTouchEnd, { passive: false });

    // ----------------------------------------------------
    // Weapons and Arsenal
    // ----------------------------------------------------
    const FOV_HIP = 75;
    const FOV_AIM = 50;
    let scopeT = 0;
    const zoomFov = (power: number) => THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(FOV_HIP / 2)) / power));
    const lookScale = () => (1 - 0.35 * aimT) * (1 - 0.5 * scopeT);
    let aimT = 0;
    let bobT = 0;
    let bobAmp = 0;
    let lastStatus = '';
    let cooldown = 0;
    let reloadT = 0;
    let flashT = 0;
    let downs = 0;
    let hitTimer: any = null;
    let slotHold: any = null;
    const HOLD_TIME = 0.4;
    let lastSlot = 0;
    let msgT = 0;
    let msgText = '';
    const reserve = { heavy: 60, light: 0 } as Record<string, number>;

    const LIFE_MAX = 120;
    // Antenna is a recon frame: 100 life instead of the usual 120
    const lifeMax = () => (character === 'antenna' ? 100 : LIFE_MAX);
    const SHIELD_LEVELS = [152, 304, 456];
    const SHIELD_DELAY = 6;
    const SHIELD_REGEN = 0.25;
    const RESPAWN_TIME = 3;
    let life = LIFE_MAX;
    let shieldLevel = 1;
    let shield = SHIELD_LEVELS[0];
    let sinceHurt = 99;
    let hurtFlash = 0;
    let shieldFlash = 0;
    let playerDown = false;
    let respawnT = 0;
    character = 'bulwark';
    const shieldMax = () => SHIELD_LEVELS[shieldLevel - 1];

    const raycaster = new THREE.Raycaster();
    const centre = new THREE.Vector2(0, 0);

    const gunHold = new THREE.Group();

    function makeWeapon(cfg: any, build: (g: THREE.Group) => void) {
      const g = new THREE.Group();
      build(g);
      const muzzle = new THREE.Object3D();
      muzzle.position.set(0, 0.02, cfg.muzzleZ);
      const flare = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), new THREE.MeshBasicMaterial({ color: 0xfde68a }));
      flare.position.copy(muzzle.position);
      flare.visible = false;
      g.add(muzzle, flare);
      g.position.copy(cfg.grip).negate();
      g.traverse((o) => o.layers.set(1));
      g.visible = false;
      gunHold.add(g);
      Object.assign(cfg, { gun: g, muzzle, flare });
    }

    const WEAPONS: Record<string, any> = {
      sk: {
        name: 'SK',
        kind: 'sk',
        ammo: 'heavy',
        mag: 30,
        loaded: 30,
        damage: 38,
        delay: 0.1,
        reload: 1.2,
        recoil: 0.03,
        muzzleZ: -0.68,
        falloff: [60, 180] as [number, number],
        hip: new THREE.Vector3(0.24, -0.22, -0.55),
        ads: new THREE.Vector3(0, -0.085, -0.4),
        grip: new THREE.Vector3(0, -0.1, -0.05),
        support: new THREE.Vector3(0, -0.04, -0.32),
      },
      smg: {
        name: 'Sharkteeth',
        kind: 'smg',
        ammo: 'light',
        mag: 40,
        loaded: 0,
        damage: 15.2 * 1.4,
        delay: 0.05,
        reload: 1.0,
        recoil: 0.01,
        muzzleZ: -0.4,
        falloff: [20, 60] as [number, number],
        hip: new THREE.Vector3(0.22, -0.2, -0.5),
        ads: new THREE.Vector3(0, -0.075, -0.38),
        grip: new THREE.Vector3(0, -0.08, -0.04),
        support: new THREE.Vector3(0, -0.03, -0.24),
      },
      sniper: {
        name: 'Sniper',
        kind: 'sniper',
        ammo: 'heavy',
        mag: 5,
        loaded: 0,
        damage: 304,
        delay: 0.9,
        reload: 1.8,
        recoil: 0.06,
        muzzleZ: -0.95,
        falloff: [200, 600] as [number, number],
        scope: 8,
        hip: new THREE.Vector3(0.26, -0.24, -0.5),
        ads: new THREE.Vector3(0, -0.1, -0.3),
        grip: new THREE.Vector3(0, -0.1, -0.05),
        support: new THREE.Vector3(0, -0.04, -0.28),
      },
      betgun: {
        name: 'Betgun',
        kind: 'betgun',
        ammo: 'heavy',
        mag: 6,
        loaded: 0,
        damage: 150,
        delay: 0.9,
        reload: 1.6,
        recoil: 0.09,
        muzzleZ: -0.84,
        shotgun: true,
        falloff: [30, 60] as [number, number],
        hip: new THREE.Vector3(0.24, -0.22, -0.5),
        ads: new THREE.Vector3(0, -0.095, -0.36),
        grip: new THREE.Vector3(0, -0.1, -0.03),
        support: new THREE.Vector3(0, -0.045, -0.36),
      },
    };

    makeWeapon(WEAPONS.sk, buildSK);
    makeWeapon(WEAPONS.smg, buildSMG);
    makeWeapon(WEAPONS.sniper, buildSniper);
    makeWeapon(WEAPONS.betgun, buildBetgun);

    let current = WEAPONS.sk;
    const slots: any[] = [WEAPONS.sk, null];
    const owned = (w: any) => slots.includes(w);
    current.gun.visible = true;

    // Player first-person body & arms
    const skin = new THREE.MeshLambertMaterial({ color: 0xd8a47f });
    const sleeve = new THREE.MeshLambertMaterial({ color: 0x2c333d });
    const vest = new THREE.MeshLambertMaterial({ color: 0x3d4a3a });
    const trousers = new THREE.MeshLambertMaterial({ color: 0x1f2630 });
    const bodyRig = new THREE.Group();
    camera.add(bodyRig);
    const armRig = new THREE.Group();
    camera.add(armRig);

    function bodyPart(geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      bodyRig.add(m);
      return m;
    }

    const LEG_THIGH = 0.46;
    const LEG_SHIN = 0.46;
    const KNEE_FWD = new THREE.Vector3(0, 0, -1);
    const bootMat = new THREE.MeshLambertMaterial({ color: 0x101418 });
    const pelvisMesh = bodyPart(new THREE.BoxGeometry(0.34, 1, 0.22), trousers, 0, 0, 0);
    const lowerMesh = bodyPart(new THREE.BoxGeometry(0.36, 1, 0.23), vest, 0, 0, 0);
    const chestMesh = bodyPart(new THREE.BoxGeometry(0.44, 1, 0.27), vest, 0, 0, 0);

    const playerLegs = [-1, 1].map((side) => {
      const leg = { side, hip: new THREE.Vector3(), knee: new THREE.Vector3(), end: new THREE.Vector3() } as any;
      leg.thigh = bodyPart(new THREE.CylinderGeometry(0.075, 0.062, 1, 10), trousers, 0, 0, 0);
      leg.kneeMesh = bodyPart(new THREE.SphereGeometry(0.065, 10, 8), trousers, 0, 0, 0);
      leg.shin = bodyPart(new THREE.CylinderGeometry(0.062, 0.048, 1, 10), trousers, 0, 0, 0);
      leg.ankleMesh = bodyPart(new THREE.SphereGeometry(0.05, 10, 8), trousers, 0, 0, 0);
      leg.foot = bodyPart(new THREE.BoxGeometry(0.13, 0.07, 0.26), bootMat, 0, 0, 0);
      return leg;
    });

    for (const m of [pelvisMesh, lowerMesh, ...playerLegs.flatMap((l) => [l.thigh, l.kneeMesh, l.shin, l.ankleMesh, l.foot])]) {
      m.layers.set(2);
    }

    let playerGait = 0;
    let playerWalk = 0;

    function poseBody(dt: number) {
      const feet = -eyeH;
      playerWalk += ((moving && !slide && !roll ? 1 : 0) - playerWalk) * Math.min(1, 8 * dt);
      const low = Math.min(1.4, (EYE - eyeH) / (EYE - CROUCH_EYE));
      const hip = feet + Math.max(0.4, 0.9 - 0.4 * low);
      const top = Math.min(hip + 0.56, -0.2);
      const chestBottom = Math.min(hip + 0.27, top - 0.04);
      pelvisMesh.position.set(0, hip + 0.05, 0);
      pelvisMesh.scale.y = 0.14;
      lowerMesh.position.set(0, hip + 0.2, 0);
      lowerMesh.scale.y = 0.14;
      chestMesh.position.set(0, (top + chestBottom) / 2, 0);
      chestMesh.scale.y = top - chestBottom;

      for (const leg of playerLegs) {
        const ph = playerGait + (leg.side > 0 ? Math.PI : 0);
        leg.hip.set(leg.side * 0.1, hip, 0);
        figTmp.target.set(leg.side * 0.11, feet + 0.08 + Math.max(0, Math.cos(ph)) * 0.06 * playerWalk, -Math.sin(ph) * 0.12 * playerWalk);
        twoBone(leg.hip, figTmp.target, LEG_THIGH, LEG_SHIN, KNEE_FWD, leg.knee, leg.end);
        segment(leg.thigh, leg.hip, leg.knee);
        segment(leg.shin, leg.knee, leg.end);
        leg.kneeMesh.position.copy(leg.knee);
        leg.ankleMesh.position.copy(leg.end);
        leg.foot.position.set(leg.end.x, feet + 0.035, leg.end.z - 0.06);
      }
    }

    const ARM_UPPER = 0.42;
    const ARM_FORE = 0.48;
    const limbGeo = new THREE.CylinderGeometry(0.04, 0.035, 1, 8);
    const jointGeo = new THREE.SphereGeometry(0.04, 8, 6);
    const handGeo = new THREE.SphereGeometry(0.036, 10, 8);
    const UP_AXIS = new THREE.Vector3(0, 1, 0);
    const tmpA = new THREE.Vector3();
    const tmpB = new THREE.Vector3();
    const tmpC = new THREE.Vector3();
    const tmpD = new THREE.Vector3();
    const tmpE = new THREE.Vector3();
    const tmpT = new THREE.Vector3();

    function makeArm(side: number, shoulder: THREE.Vector3) {
      const arm = {
        side,
        shoulder,
        upper: new THREE.Mesh(limbGeo, sleeve),
        elbow: new THREE.Mesh(jointGeo, sleeve),
        fore: new THREE.Mesh(limbGeo, sleeve),
        hand: new THREE.Mesh(handGeo, skin),
        wrist: new THREE.Object3D(),
      };
      armRig.add(arm.upper, arm.elbow, arm.fore, arm.hand, arm.wrist);
      return arm;
    }

    const armR = makeArm(1, new THREE.Vector3(0.22, -0.3, 0));
    const armL = makeArm(-1, new THREE.Vector3(-0.22, -0.3, 0));
    armRig.traverse((o) => o.layers.set(1));
    armR.wrist.add(gunHold);

    function placeLimb(mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3) {
      tmpD.subVectors(b, a);
      const len = tmpD.length();
      mesh.position.copy(a).addScaledVector(tmpD, 0.5);
      mesh.quaternion.setFromUnitVectors(UP_AXIS, tmpD.divideScalar(len));
      mesh.scale.set(1, len, 1);
    }

    function solveArm(arm: any, target: THREE.Vector3) {
      const dir = tmpA.subVectors(target, arm.shoulder);
      const dist = Math.min(dir.length(), ARM_UPPER + ARM_FORE - 0.001);
      dir.normalize();
      const hand = tmpB.copy(arm.shoulder).addScaledVector(dir, dist);
      const along = (ARM_UPPER * ARM_UPPER - ARM_FORE * ARM_FORE + dist * dist) / (2 * dist);
      const across = Math.sqrt(Math.max(0, ARM_UPPER * ARM_UPPER - along * along));
      const pole = tmpC.set(arm.side * 0.6, -1, 0);
      pole.addScaledVector(dir, -pole.dot(dir)).normalize();
      const elbow = tmpE.copy(arm.shoulder).addScaledVector(dir, along).addScaledVector(pole, across);
      placeLimb(arm.upper, arm.shoulder, elbow);
      arm.elbow.position.copy(elbow);
      placeLimb(arm.fore, elbow, hand);
      arm.hand.position.copy(hand);
      arm.wrist.position.copy(hand);
    }

    function gunPoint(w: any, local: THREE.Vector3, out: THREE.Vector3) {
      return out.copy(local).sub(w.grip).applyEuler(gunHold.rotation).add(armR.wrist.position);
    }

    const REST_R = new THREE.Vector3(0.2, -0.4, -0.6);
    const REST_L = new THREE.Vector3(-0.2, -0.4, -0.6);
    const wristTarget = new THREE.Vector3();

    function updateBody(w: any, dt: number) {
      poseBody(dt);
      if (!w) {
        solveArm(armR, REST_R);
        solveArm(armL, REST_L);
        return;
      }
      solveArm(armR, wristTarget);
      solveArm(armL, gunPoint(w, w.support, tmpT));
    }

    function refreshHud() {
      if (!current) {
        if (weaponEl) weaponEl.textContent = 'Unarmed';
        if (ammoEl) ammoEl.textContent = '-';
        if (magEl) magEl.textContent = '';
        if (reserveEl) reserveEl.textContent = '';
        return;
      }
      if (weaponEl) weaponEl.textContent = current.name;
      if (ammoEl) ammoEl.textContent = String(current.loaded);
      if (magEl) magEl.textContent = ` / ${current.mag}`;
      if (reserveEl) reserveEl.textContent = `${current.ammo.toUpperCase()} ${reserve[current.ammo] || 0}`;
    }

    function showMessage(text: string, seconds: number) {
      msgText = text;
      msgT = seconds;
    }

    function putAway() {
      if (current) {
        current.gun.visible = false;
        current.flare.visible = false;
      }
      reloadT = 0;
      scopeT = 0;
      scopeEl?.classList.remove('on');
      slotHold = null;
      current = null;
    }

    function equip(w: any) {
      if (w === current || !owned(w)) return;
      putAway();
      current = w;
      lastSlot = slots.indexOf(w);
      w.gun.visible = true;
      refreshHud();
      refreshSlots();
    }

    function pressSlot(i: number) {
      const w = slots[i];
      if (!w) {
        if (current) {
          putAway();
          refreshHud();
          refreshSlots();
          showMessage('Unarmed (no weapon in hand)', 1.5);
        }
        return;
      }
      if (w !== current) {
        equip(w);
        return;
      }
      // Clicking the already equipped weapon holsters it so character has no weapon in hand
      putAway();
      refreshHud();
      refreshSlots();
      showMessage('Holstered weapon (Unarmed)', 1.5);
    }

    function releaseSlot(i: number) {
      slotHold = null;
    }

    function cycleWeapon() {
      const other = current ? slots[1 - slots.indexOf(current)] : slots[lastSlot];
      if (other) equip(other);
    }

    function refreshSlots() {
      slots.forEach((w, i) => {
        if (slotNameEls[i]) slotNameEls[i]!.textContent = w ? w.name : 'Empty';
        slotEls[i]?.classList.toggle('active', !!w && w === current);
        slotEls[i]?.classList.toggle('empty', !w);
      });
    }

    function setStatus(text: string) {
      if (text === lastStatus || !statusEl) return;
      statusEl.textContent = text;
      lastStatus = text;
    }

    function startReload() {
      const w = current;
      if (!w || reloadT > 0 || w.loaded === w.mag) return;
      if ((reserve[w.ammo] || 0) <= 0) {
        showMessage(`No ${w.ammo} ammo`, 1.5);
        return;
      }
      reloadT = w.reload;
    }

    const tracerMats = new Map<number, THREE.LineBasicMaterial>();
    function tracer(from: THREE.Vector3, to: THREE.Vector3, color = 0xfde68a) {
      let mat = tracerMats.get(color);
      if (!mat) {
        mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 });
        tracerMats.set(color, mat);
      }
      const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
      const line = new THREE.Line(geo, mat);
      scene.add(line);
      setTimeout(() => {
        scene.remove(line);
        geo.dispose();
      }, 70);
    }

    function showHit() {
      if (!hitmark) return;
      hitmark.classList.add('show');
      clearTimeout(hitTimer);
      hitTimer = setTimeout(() => hitmark.classList.remove('show'), 120);
    }

    function hitDummy(d: DummyObject, dmg: number, pen = 0) {
      if (d.state !== 'up') return;
      const through = Math.min(d.shield, dmg);
      d.shield -= through;
      d.hp -= (dmg - through) + pen;
      d.quiet = 0;
      d.flash = 0.12;
      showHit();
      if (d.hp <= 0.001) dummyDown(d);
    }

    const DOWN_CREDITS = 50;
    function dummyDown(d: DummyObject) {
      d.state = 'falling';
      downs += 1;
      if (downsEl) downsEl.textContent = String(downs);
      credits += DOWN_CREDITS;
      if (creditsEl) creditsEl.textContent = String(credits);
    }

    function burnDummy(d: DummyObject, dmg: number, pen = 0) {
      if (d.state !== 'up') return;
      const through = Math.min(d.shield, dmg);
      d.shield -= through;
      d.hp -= (dmg - through) + pen;
      d.quiet = 0;
      d.flash = Math.max(d.flash, 0.05);
      if (d.hp <= 0.001) dummyDown(d);
    }

    // Horizontal distance pre-filter for bullet raycasts. With the POI
    // generator streaming structures across the map, `shootable` can
    // hold hundreds of far-away meshes; bullets never reach past ~170 m
    // so only nearby objects are worth intersecting. InstancedMesh
    // position sits at its group's origin, so use the voxel box's
    // center for those.
    function nearShootable(maxDist: number, ox = camera.position.x, oz = camera.position.z) {
      const m2 = maxDist * maxDist;
      const out: THREE.Object3D[] = [];
      for (const o of shootable) {
        const u = (o as any).userData ?? {};
        const vox = u.vox as VoxelBox | undefined;
        const ant = u.antenna as any;
        // Antenna meshes live in a group placed at world coords, so their
        // local positions cannot seed the distance test — use the mast base.
        // SAME CLASS OF BUG for three more groups of objects whose meshes
        // are children of a positioned group (or carry world coords in the
        // geometry): dummy FIGURE PARTS, player-built WALL panels and
        // GABLE roofs. Their .position is local / near-origin, so the
        // pre-filter used to reject them the moment the fight happened
        // far from the map origin — Harbor — which is exactly the
        // "can't damage bots in harbor mode" bug (every patrol figure
        // sat at local ~(0,0) while the camera was 500+ m away).
        const dum = u.dummy as DummyObject | undefined;
        const wd = (u.wallDest ?? (o.parent ? (o.parent as any).userData?.wallDest : null)) as any;
        const wc = u.wc as { x: number; z: number } | undefined;
        const px = vox
          ? vox.x0 + (vox.nx * vox.sx) / 2
          : ant
          ? ant.group.position.x
          : dum
          ? dum.group.position.x
          : wd
          ? wd.bounds.x
          : wc
          ? wc.x
          : o.position.x;
        const pz = vox
          ? vox.z0 + (vox.nz * vox.sz) / 2
          : ant
          ? ant.group.position.z
          : dum
          ? dum.group.position.z
          : wd
          ? wd.bounds.z
          : wc
          ? wc.z
          : o.position.z;
        const dx = px - ox;
        const dz = pz - oz;
        if (dx * dx + dz * dz < m2) out.push(o);
      }
      return out;
    }

    function shoot() {
      const w = current;
      if (!w || cooldown > 0 || reloadT > 0 || roll || buildMode || gArmed || bombArmed) return;
      if (w.loaded === 0) {
        startReload();
        return;
      }
      w.loaded -= 1;
      cooldown = w.delay;
      flashT = 0.05;
      refreshHud();
      applyView();
      raycaster.setFromCamera(centre, camera);
      let hit = raycaster.intersectObjects(nearShootable(170), false)[0];
      const from = w.muzzle.getWorldPosition(new THREE.Vector3());
      let reach = hit ? hit.distance : 150;
      const gc = shotCut(raycaster.ray, reach);
      if (gc < reach) {
        reach = gc;
        hit = null as any;
      }
      // Vegetation soaks bullets too: tree trunks and boulders end
      // the tracer with a wooden thunk. (They also block grenade
      // blasts via `solids`, so forests are real cover.)
      const vc = vegCut(raycaster.ray.origin, raycaster.ray.direction, reach);
      if (vc < reach) {
        reach = vc;
        hit = null as any;
        playSfx('wood_hit');
      }
      const sd = smokeDist(raycaster.ray.origin, raycaster.ray.direction, reach);
      const to =
        sd < Infinity
          ? raycaster.ray.at(sd, new THREE.Vector3())
          : hit
          ? hit.point
          : raycaster.ray.at(reach, new THREE.Vector3());
      tracer(from, to);
      if (sd === Infinity && hit?.object.userData.dummy) {
        const s = shotDamage(w, hit.distance);
        hitDummy(hit.object.userData.dummy, s.dmg, s.pen);
      } else if (sd === Infinity && hit?.object) {
        if (hit.object.userData.antenna) {
          // Own fire can smash the scanner — it is a soft 300 HP target
          const s = shotDamage(w, hit.distance);
          damageAntenna(s.dmg, hit.point);
        } else {
          const wall = hit.object.userData.wallDest || (hit.object.parent && hit.object.parent.userData.wallDest);
          if (wall) {
            // Bullets chew player-built walls (structure damage, same kind as BR-web)
            const s = shotDamage(w, hit.distance);
            damageWall(wall, calculateStructureDamage(w.kind || 'sk', s.dmg), hit.point);
          } else if (hit.object.userData.vox) {
            // Bullets chew chunks out of walls and crates
            const s = shotDamage(w, hit.distance);
            chipVoxelAtPoint(
              hit.object.userData.vox as VoxelBox,
              hit.point,
              calculateStructureDamage(w.kind || 'sk', s.dmg)
            );
          }
        }
      }
      kick = w.recoil;
    }

    const PROXIMITY = 15;
    function autoShoot() {
      if (!current || reloadT > 0 || roll) return;
      applyView();
      raycaster.setFromCamera(centre, camera);
      const hit = raycaster.intersectObjects(nearShootable(170), false)[0];
      const target = hit?.object.userData.dummy;
      if (!target || target.state !== 'up') return;
      if (smokeDist(raycaster.ray.origin, raycaster.ray.direction, hit.distance) < Infinity) return;
      const dist = Math.hypot(target.group.position.x - camera.position.x, target.group.position.z - camera.position.z);
      if (aiming() || dist <= PROXIMITY) shoot();
    }

    let tuck = 0;
    function updateWeapon(dt: number) {
      const w = current;
      cooldown = Math.max(0, cooldown - dt);
      flashT -= dt;
      if (w) w.flare.visible = flashT > 0;
      kick *= Math.exp(-12 * dt);
      if (slotHold && !slotHold.held) {
        slotHold.t += dt;
        if (slotHold.t >= HOLD_TIME) {
          slotHold.held = true;
          startReload();
        }
      }
      if (w && reloadT > 0) {
        reloadT -= dt;
        if (reloadT <= 0) {
          const take = Math.min(w.mag - w.loaded, reserve[w.ammo] || 0);
          w.loaded += take;
          reserve[w.ammo] = (reserve[w.ammo] || 0) - take;
          refreshHud();
        }
      }
      msgT = Math.max(0, msgT - dt);
      const reloading = reloadT > 0;
      const aimed = aiming() && !!w && !buildMode;
      const prompt = pickOffer && !touchDevice ? `F to pick up ${WEAPONS[pickOffer.kind]?.name || ''}` : '';
      setStatus(msgT > 0 ? msgText : reloading ? 'Reloading' : prompt || (buildMode ? 'Build Mode' : aimed ? 'Aiming' : w ? '' : 'Unarmed'));

      aimT = THREE.MathUtils.lerp(aimT, aimed && !reloading ? 1 : 0, 1 - Math.exp(-14 * dt));
      scopeT = THREE.MathUtils.lerp(scopeT, aimed && !reloading && w?.scope ? 1 : 0, 1 - Math.exp(-10 * dt));
      const aimFov = FOV_HIP + (FOV_AIM - FOV_HIP) * aimT;
      const fov = THREE.MathUtils.lerp(aimFov, w?.scope ? zoomFov(w.scope) : aimFov, scopeT);
      if (camera.fov !== fov) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }
      document.body.classList.toggle('aiming', aimT > 0.5);
      const scoped = scopeT > 0.5;
      scopeEl?.classList.toggle('on', scoped);

      const weaponInHand = !!w && !buildMode && !gArmed && !bombArmed;
      if (w) w.gun.visible = weaponInHand && !scoped;

      bobAmp = THREE.MathUtils.lerp(bobAmp, moving && !slide && !roll ? 1 : 0, 1 - Math.exp(-8 * dt));
      if (moving) bobT += dt * (sprinting ? 14 : 9);
      const calm = (1 - 0.8 * aimT) * bobAmp;
      tuck = THREE.MathUtils.lerp(tuck, slide ? 1 : 0, 1 - Math.exp(-10 * dt));
      if (weaponInHand) {
        const dip = reloading ? Math.sin((1 - reloadT / w.reload) * Math.PI) : 0;
        wristTarget.lerpVectors(w.hip, w.ads, aimT).add(w.grip);
        wristTarget.x += Math.cos(bobT * 0.5) * 0.008 * calm;
        wristTarget.y += -Math.abs(Math.sin(bobT)) * 0.01 * calm - dip * 0.14 - tuck * 0.12;
        wristTarget.z += kick * 3 + tuck * 0.05;
        gunHold.rotation.set(-tuck * 0.5, 0, dip * 0.35);
      } else {
        gunHold.rotation.set(0, 0, 0);
      }
      bodyRig.visible = armRig.visible = !scoped;
      updateBody(weaponInHand ? w : null, dt);
    }

    // ----------------------------------------------------
    // Pickups
    // ----------------------------------------------------
    const PICKUP_RADIUS = 1.2;
    const RESPAWN = 25;
    interface PickupItem {
      kind: string;
      x: number;
      z: number;
      group: THREE.Group;
      taken: boolean;
      timer: number;
      dropped?: boolean;
      armed?: boolean;
      gone?: boolean;
    }
    const pickups: PickupItem[] = [];

    function clearOfCrates(x: number, z: number) {
      if (Math.hypot(x, z) < 12) return false;
      if (nearPool(x, z, 2)) return false;
      for (const b of solids) {
        if (Math.abs(x - b.x) < b.hx + 1.2 && Math.abs(z - b.z) < b.hz + 1.2) return false;
      }
      return true;
    }

    const cyanCore = new THREE.MeshLambertMaterial({ color: 0x67e8f9, emissive: 0x0e7490 });

    function pickupMesh(kind: string) {
      const g = new THREE.Group();
      if (kind === 'smg' || kind === 'sk' || kind === 'sniper' || kind === 'betgun') {
        const gun = new THREE.Group();
        buildWeaponModel(kind, gun);
        gun.position.set(0, 0.28, 0);
        gun.rotation.set(0, Math.PI / 4, Math.PI / 16);
        for (const child of gun.children) {
          if ((child as THREE.Mesh).isMesh) {
            (child as THREE.Mesh).castShadow = true;
          }
        }
        g.add(gun);
        const ringColor =
          kind === 'smg' ? 0x38bdf8 : kind === 'sniper' ? 0x818cf8 : kind === 'betgun' ? 0xf97316 : 0xf59e0b;
        const ringMat = new THREE.MeshBasicMaterial({ color: ringColor, transparent: true, opacity: 0.65 });
        part(g, new THREE.TorusGeometry(0.38, 0.015, 6, 24), ringMat, 0, 0.04, 0, Math.PI / 2);
      } else if (kind === 'blast' || kind === 'fire' || kind === 'smoke') {
        const body = new THREE.MeshLambertMaterial({
          color: kind === 'blast' ? 0x5b6b3a : kind === 'fire' ? 0xd9480f : 0x9ca3af,
        });
        part(g, new THREE.SphereGeometry(0.2, 12, 10), body, 0, 0.22, 0);
        part(g, new THREE.TorusGeometry(0.2, 0.03, 6, 14), amber, 0, 0.22, 0, Math.PI / 2);
      } else if (kind === 'shield') {
        part(g, new THREE.OctahedronGeometry(0.34), cyanCore, 0, 0.7, 0);
      } else {
        const body = new THREE.MeshLambertMaterial({ color: kind === 'heavy' ? 0x6b7a2a : 0x2a9fd6 });
        part(g, new THREE.BoxGeometry(0.6, 0.35, 0.5), body, 0, 0.18, 0);
        part(g, new THREE.BoxGeometry(0.62, 0.06, 0.52), kind === 'heavy' ? amber : steel, 0, 0.38, 0);
      }
      return g;
    }

    function scatter(kind: string, count: number) {
      for (let i = 0; i < count; i++) {
        let x: number, z: number, tries = 0;
        do {
          x = (Math.random() - 0.5) * SPREAD;
          z = (Math.random() - 0.5) * SPREAD;
          tries++;
        } while (!clearOfCrates(x, z) && tries < 300);
        const group = pickupMesh(kind);
        group.position.set(x, 0, z);
        world.add(group);
        pickups.push({ kind, x, z, group, taken: false, timer: 0 });
      }
    }

    // ----------------------------------------------------
    // Buildings
    // ----------------------------------------------------
    const bmWall = new THREE.MeshLambertMaterial({ color: 0xd9c9ad });
    const bmCream = new THREE.MeshLambertMaterial({ color: 0xe6d5b3 });
    const bmTile = new THREE.MeshLambertMaterial({ color: 0x8b4a35, side: THREE.DoubleSide });
    const bmSlab = new THREE.MeshLambertMaterial({ color: 0x8d7f70 });
    const bmStair = new THREE.MeshLambertMaterial({ color: 0xa08f7c });
    const bmRoof = new THREE.MeshLambertMaterial({ color: 0x5b4636 });
    const bmGlass = new THREE.MeshLambertMaterial({
      color: 0xa5d8ff,
      transparent: true,
      opacity: 0.35,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const bmConcrete = new THREE.MeshLambertMaterial({ color: 0x9a9d98 });
    const bmConcreteDark = new THREE.MeshLambertMaterial({ color: 0x66696a });
    const bmSteel = new THREE.MeshLambertMaterial({ color: 0x8a94a6 });
    const bmSteelDark = new THREE.MeshLambertMaterial({ color: 0x4b5563 });
    const bmCrate = new THREE.MeshLambertMaterial({ color: 0x8f6b3e });
    const bmWood = new THREE.MeshLambertMaterial({ color: 0x7a5a3a });

    // Structure toughness: hit points of one voxel chunk per material
    voxHpMap.set(bmWall, 110);
    voxHpMap.set(bmCream, 110);
    voxHpMap.set(bmTile, 130);
    voxHpMap.set(bmSlab, 150);
    voxHpMap.set(bmStair, 90);
    voxHpMap.set(bmRoof, 90);
    voxHpMap.set(bmConcrete, 170);
    voxHpMap.set(bmConcreteDark, 170);
    voxHpMap.set(bmSteel, 230);
    voxHpMap.set(bmSteelDark, 230);
    voxHpMap.set(bmCrate, 70);
    voxHpMap.set(bmWood, 70);

    function turnPoint(B: any, u: number, v: number) {
      return B.rot ? { x: B.x - v, z: B.z + u } : { x: B.x + u, z: B.z + v };
    }

    function turnBox(B: any, u0: number, u1: number, v0: number, v1: number) {
      const c = turnPoint(B, (u0 + u1) / 2, (v0 + v1) / 2);
      const hu = (u1 - u0) / 2;
      const hv = (v1 - v0) / 2;
      return B.rot ? { x: c.x, z: c.z, hx: hv, hz: hu } : { x: c.x, z: c.z, hx: hu, hz: hv };
    }

    const spanOf = (axisName: string, f0: number, f1: number, a0: number, a1: number): [number, number, number, number] =>
      axisName === 'x' ? [a0, a1, f0, f1] : [f0, f1, a0, a1];

    function bBox(
      B: any,
      axisName: string,
      f0: number,
      f1: number,
      a0: number,
      a1: number,
      y0: number,
      y1: number,
      mat: THREE.Material,
      parent?: THREE.Object3D,
      customVoxSize?: number
    ) {
      const w = turnBox(B, ...spanOf(axisName, f0, f1, a0, a1));
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w.hx * 2, y1 - y0, w.hz * 2), mat);
      mesh.position.set(w.x, (y0 + y1) / 2, w.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      (parent ?? world).add(mesh);
      const sb: SolidBox = { x: w.x, z: w.z, hx: w.hx, hz: w.hz, top: y1, bottom: y0, group: parent };
      solids.push(sb);
      shootable.push(mesh);
      registerDestructible(sb, mesh, mat, customVoxSize);
    }

    function bPane(B: any, axisName: string, f0: number, f1: number, a0: number, a1: number, y0: number, y1: number, parent?: THREE.Object3D) {
      const fm = (f0 + f1) / 2;
      const w = turnBox(B, ...spanOf(axisName, fm, fm, a0, a1));
      const m = new THREE.Mesh(new THREE.PlaneGeometry(2 * Math.max(w.hx, w.hz), y1 - y0), bmGlass);
      m.position.set(w.x, (y0 + y1) / 2, w.z);
      m.rotation.y = w.hx > w.hz ? 0 : Math.PI / 2;
      (parent ?? world).add(m);
    }

    function bWall(
      B: any,
      axisName: string,
      f0: number,
      f1: number,
      a0: number,
      a1: number,
      y0: number,
      y1: number,
      openings: any[],
      mat: THREE.Material,
      parent?: THREE.Object3D
    ) {
      let at = a0;
      for (const o of openings.slice().sort((p, q) => p.a - q.a)) {
        if (o.a > at) bBox(B, axisName, f0, f1, at, o.a, y0, y1, mat, parent);
        if (o.sill > y0) bBox(B, axisName, f0, f1, o.a, o.b, y0, o.sill, mat, parent);
        if (o.head < y1) bBox(B, axisName, f0, f1, o.a, o.b, o.head, y1, mat, parent);
        if (o.sill > y0 && o.glass !== false) bPane(B, axisName, f0, f1, o.a, o.b, o.sill, o.head, parent);
        at = o.b;
      }
      if (at < a1) bBox(B, axisName, f0, f1, at, a1, y0, y1, mat, parent);
    }

    const holes = (pairs: number[][], sill: number, head: number, glass?: boolean) =>
      pairs.map(([a, b]) => ({ a, b, sill, head, glass }));

    function bGable(B: any, u0: number, u1: number, v0: number, v1: number, eaveY: number, ridgeY: number, mat: THREE.Material, parent?: THREE.Object3D) {
      const vm = (v0 + v1) / 2;
      const E = eaveY;
      const K = ridgeY;
      const pos: number[] = [];
      const pt = (u: number, y: number, v: number) => {
        const p = turnPoint(B, u, v);
        pos.push(p.x, y, p.z);
      };
      const tri = (a: number[], b: number[], c: number[]) => {
        pt(a[0], a[1], a[2]);
        pt(b[0], b[1], b[2]);
        pt(c[0], c[1], c[2]);
      };
      tri([u0, E, v0], [u1, E, v0], [u1, K, vm]);
      tri([u0, E, v0], [u1, K, vm], [u0, K, vm]);
      tri([u0, K, vm], [u1, K, vm], [u1, E, v1]);
      tri([u0, K, vm], [u1, E, v1], [u0, E, v1]);
      tri([u0, E, v0], [u0, K, vm], [u0, E, v1]);
      tri([u1, E, v0], [u1, E, v1], [u1, K, vm]);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // Gable geometry carries WORLD coords with the mesh parked at the
      // origin, so stash the real centre for nearShootable's pre-filter
      // (roofs far from the map origin would otherwise be un-hittable).
      geo.computeBoundingBox();
      if (geo.boundingBox) {
        const bc = geo.boundingBox.getCenter(new THREE.Vector3());
        mesh.userData.wc = { x: bc.x, z: bc.z };
      }
      (parent ?? world).add(mesh);
      shootable.push(mesh);
    }

    // LADDER object: a 45-degree rung ladder — each rung advances
    // 0.42 m along `climb` ('x' or 'z') so the footprint works like
    // the buildable ramp (walk straight up via the step logic), with
    // the rungs reading as a ladder. Bolt it onto walls, tanks, silos.
    function bLadder(x: number, z: number, gy: number, topY: number, mat: THREE.Material, parent?: THREE.Object3D, climb: 'x' | 'z' = 'z') {
      const steps = Math.max(2, Math.ceil((topY - gy) / 0.42));
      for (let i = 0; i < steps; i++) {
        const y0 = gy + i * 0.42;
        if (climb === 'z') {
          bBox({ x, z: z + 0.42 * i, rot: 0 }, 'z', -0.42, 0.42, -0.25, 0.25, y0, y0 + 0.42, mat, parent);
        } else {
          bBox({ x: x + 0.42 * i, z, rot: 0 }, 'z', -0.25, 0.25, -0.42, 0.42, y0, y0 + 0.42, mat, parent);
        }
      }
    }

    function buildHouse(B: any, gy = 0, parent?: THREE.Object3D) {
      const hx = 6;
      const hz = 4.5;
      const T = 0.4;
      const FLOOR = gy + 3.2;
      const ROOF = gy + 6.4;
      const G = gy;
      const L = -hx;
      const R = hx;
      const N = -hz;
      const S = hz;
      const iL = L + T;
      const iR = R - T;
      const iN = N + T;
      const iS = S - T;
      const winSide = [[-2.8, -1.2], [1.2, 2.8]];
      const winBack = [[-4.0, -2.4], [2.4, 4.0]];

      bWall(B, 'z', L, iL, N, S, G, FLOOR, holes(winSide, gy + 0.9, gy + 2.2), bmWall, parent);
      bWall(B, 'z', iR, R, N, S, G, FLOOR, holes(winSide, gy + 0.9, gy + 2.2), bmWall, parent);
      bWall(B, 'x', N, iN, L, R, G, FLOOR, holes(winBack, gy + 0.9, gy + 2.2), bmWall, parent);
      bWall(B, 'x', iS, S, L, R, G, FLOOR, [...holes(winBack, gy + 0.9, gy + 2.2), { a: -1, b: 1, sill: gy, head: gy + 2.4 }], bmWall, parent);

      bWall(B, 'z', L, iL, N, S, FLOOR, ROOF, holes(winSide, gy + 4.1, gy + 5.5), bmWall, parent);
      bWall(B, 'z', iR, R, N, S, FLOOR, ROOF, holes(winSide, gy + 4.1, gy + 5.5), bmWall, parent);
      bWall(B, 'x', N, iN, L, R, FLOOR, ROOF, holes(winBack, gy + 4.1, gy + 5.5), bmWall, parent);
      bWall(B, 'x', iS, S, L, R, FLOOR, ROOF, holes(winBack, gy + 4.1, gy + 5.5), bmWall, parent);

      const STEPS = 10;
      const RISE = 0.32;
      const RUN = 0.3;
      const zs = iS - 0.8;
      for (let i = 0; i < STEPS; i++) {
        bBox(B, 'z', iL + 0.4, iL + 1.6, zs - (i + 1) * RUN, zs - i * RUN, gy, gy + (i + 1) * RISE, bmStair, parent);
      }

      const edgeZ = zs - STEPS * RUN;
      bBox(B, 'x', iN, edgeZ, iL, iR, FLOOR - 0.4, FLOOR, bmSlab, parent);
      bBox(B, 'x', edgeZ, iS, iL + 2.2, iR, FLOOR - 0.4, FLOOR, bmSlab, parent);
      bBox(B, 'x', N, S, L, R, ROOF, ROOF + 0.3, bmRoof, parent);
      return { u: 0, v: S, nu: 0, nv: 1 };
    }

    function buildCottage(B: any, gy = 0, parent?: THREE.Object3D) {
      const hx = 4.5;
      const hz = 3.5;
      const T = 0.3;
      const H = gy + 3.0;
      const SLAB = 0.2;
      const OVER = 0.4;
      const PEAK = 2.2;
      const G = gy;
      const L = -hx;
      const R = hx;
      const N = -hz;
      const S = hz;
      const iL = L + T;
      const iR = R - T;
      const iN = N + T;
      const iS = S - T;
      const winSide = [[-2.2, -0.8], [0.8, 2.2]];
      const winBack = [[-3.0, -1.6], [1.6, 3.0]];
      const winFront = [[-3.0, -1.6], [1.6, 3.0]];

      bWall(B, 'z', L, iL, N, S, G, H, holes(winSide, gy + 0.9, gy + 2.1), bmCream, parent);
      bWall(B, 'z', iR, R, N, S, G, H, holes(winSide, gy + 0.9, gy + 2.1), bmCream, parent);
      bWall(B, 'x', N, iN, L, R, G, H, holes(winBack, gy + 0.9, gy + 2.1), bmCream, parent);
      bWall(B, 'x', iS, S, L, R, G, H, [...holes(winFront, gy + 0.9, gy + 2.1), { a: -0.6, b: 0.6, sill: gy, head: gy + 2.1 }], bmCream, parent);

      bBox(B, 'x', N, S, L, R, H, H + SLAB, bmSlab, parent);
      bGable(B, L - OVER, R + OVER, N - OVER, S + OVER, H + SLAB, H + SLAB + PEAK, bmTile, parent);

      bBox(B, 'x', -3.0, -2.0, -3.8, -1.8, gy, gy + 0.5, bmWood, parent);
      bBox(B, 'x', 0.6, 1.4, 1.2, 2.2, gy, gy + 0.8, bmWood, parent);
      return { u: 0, v: S, nu: 0, nv: 1 };
    }

    function buildBunker(B: any, gy = 0, parent?: THREE.Object3D) {
      const hx = 5;
      const hz = 3.5;
      const T = 0.6;
      const H = gy + 2.6;
      const SLAB = 0.4;
      const OVER = 0.4;
      const G = gy;
      const L = -hx;
      const R = hx;
      const N = -hz;
      const S = hz;
      const iL = L + T;
      const iR = R - T;
      const iN = N + T;
      const iS = S - T;
      const slits = (cs: number[]) => cs.map((c) => ({ a: c - 0.3, b: c + 0.3, sill: gy + 1.4, head: gy + 1.7, glass: false }));

      bWall(B, 'z', L, iL, N, S, G, H, slits([-2.2, 0, 2.2]), bmConcrete, parent);
      bWall(B, 'z', iR, R, N, S, G, H, slits([-2.2, 0, 2.2]), bmConcrete, parent);
      bWall(B, 'x', N, iN, L, R, G, H, [], bmConcrete, parent);
      bWall(B, 'x', iS, S, L, R, G, H, [...slits([-3.0, 3.0]), { a: -0.7, b: 0.7, sill: gy, head: gy + 2.1 }], bmConcrete, parent);
      bBox(B, 'x', N - OVER, S + OVER, L - OVER, R + OVER, H, H + SLAB, bmConcreteDark, parent);

      bBox(B, 'x', iN, iN + 0.6, -3.0, 3.0, gy, gy + 0.5, bmWood, parent);
      bBox(B, 'x', 0.4, 1.4, 1.5, 2.6, gy, gy + 0.9, bmCrate, parent);
      return { u: 0, v: S, nu: 0, nv: 1 };
    }

    function buildWarehouse(B: any, gy = 0, parent?: THREE.Object3D) {
      const hx = 7;
      const hz = 5;
      const T = 0.4;
      const H = gy + 5.0;
      const OVER = 0.5;
      const G = gy;
      const L = -hx;
      const R = hx;
      const N = -hz;
      const S = hz;
      const iL = L + T;
      const iR = R - T;
      const iN = N + T;
      const high = [[-3.6, -2.0], [-0.8, 0.8], [2.0, 3.6]];

      bWall(B, 'z', L, iL, N, S, G, H, holes(high, gy + 3.2, gy + 4.2), bmSteel, parent);
      bWall(B, 'z', iR, R, N, S, G, H, holes(high, gy + 3.2, gy + 4.2), bmSteel, parent);
      bWall(B, 'x', N, iN, L, R, G, H, [{ a: -1.4, b: 1.4, sill: gy, head: gy + 3.4 }], bmSteel, parent);

      bBox(B, 'x', S - 0.9, S - 0.3, L + T + 0.2, L + T + 0.8, G, H, bmSteelDark, parent);
      bBox(B, 'x', S - 0.9, S - 0.3, R - T - 0.8, R - T - 0.2, G, H, bmSteelDark, parent);
      bBox(B, 'x', N - OVER, S + OVER, L - OVER, R + OVER, H, H + 0.3, bmSteelDark, parent);

      bBox(B, 'x', -2.6, -0.6, -5.0, -3.4, gy, gy + 1.4, bmCrate, parent);
      bBox(B, 'x', 1.0, 2.8, 2.0, 3.4, gy, gy + 1.4, bmCrate, parent);
      return { u: 0, v: S, nu: 0, nv: 1 };
    }

    // ----------------------------------------------------
    // POI structure palette + builders. Every piece registers
    // through bBox/bWall so the whole POI is voxel-destructible
    // and blast-occluding, exactly like the range buildings.
    // Builders take (B, gy, parent): local u/v around B, ground
    // level gy, and the POI group they live in.
    // ----------------------------------------------------
    const bmBarn = new THREE.MeshLambertMaterial({ color: 0x9a4433 });
    const bmHay = new THREE.MeshLambertMaterial({ color: 0xc9a84e });
    const bmCanvasTan = new THREE.MeshLambertMaterial({ color: 0xb59a6a });
    const bmCanvasGreen = new THREE.MeshLambertMaterial({ color: 0x5e7a4a });
    const bmRock = new THREE.MeshLambertMaterial({ color: 0x767b7e });
    const bmWhite = new THREE.MeshLambertMaterial({ color: 0xe4e4dc });
    const bmBandRed = new THREE.MeshLambertMaterial({ color: 0xb03a30 });
    const bmSilo = new THREE.MeshLambertMaterial({ color: 0xb8bcc2 });
    const bmRust = new THREE.MeshLambertMaterial({ color: 0x9a6248 });
    const bmWarnOrange = new THREE.MeshLambertMaterial({ color: 0xd99021 });
    const bmGravel = new THREE.MeshLambertMaterial({ color: 0x8d8578 });
    const bmLamp = new THREE.MeshLambertMaterial({ color: 0xffe9a0, emissive: 0xffc94d });
    const bmBeaconRed = new THREE.MeshLambertMaterial({ color: 0xff6b5e, emissive: 0xb03a30 });
    voxHpMap.set(bmBarn, 110);
    voxHpMap.set(bmHay, 60);
    voxHpMap.set(bmCanvasTan, 55);
    voxHpMap.set(bmCanvasGreen, 55);
    voxHpMap.set(bmRock, 210);
    voxHpMap.set(bmWhite, 110);
    voxHpMap.set(bmBandRed, 110);
    voxHpMap.set(bmSilo, 170);
    voxHpMap.set(bmRust, 130);
    voxHpMap.set(bmWarnOrange, 90);
    voxHpMap.set(bmGravel, 100);

    function buildShed(B: any, gy = 0, parent?: THREE.Object3D) {
      const hx = 1.6;
      const hz = 2.4;
      const T = 0.25;
      const H = gy + 2.3;
      const G = gy;
      const L = -hx;
      const R = hx;
      const N = -hz;
      const S = hz;
      const iL = L + T;
      const iR = R - T;
      const iN = N + T;
      const iS = S - T;
      bWall(B, 'z', L, iL, N, S, G, H, holes([[-1.2, -0.4]], gy + 0.7, gy + 1.6), bmWood, parent);
      bWall(B, 'z', iR, R, N, S, G, H, [], bmWood, parent);
      bWall(B, 'x', N, iN, L, R, G, H, [], bmWood, parent);
      bWall(B, 'x', iS, S, L, R, G, H, [{ a: -0.5, b: 0.5, sill: gy, head: gy + 1.9, glass: false }], bmWood, parent);
      bBox(B, 'x', N - 0.25, S + 0.25, L - 0.25, R + 0.25, H, H + 0.18, bmRoof, parent);
      bBox(B, 'x', -0.7, 0.1, -1.4, -0.6, gy, gy + 0.7, bmCrate, parent);
      return { u: 0, v: S, nu: 0, nv: 1 };
    }

    function buildBarn(B: any, gy = 0, parent?: THREE.Object3D) {
      const hx = 5;
      const hz = 3.6;
      const T = 0.35;
      const H = gy + 4.4;
      const OVER = 0.45;
      const PEAK = 2.4;
      const G = gy;
      const L = -hx;
      const R = hx;
      const N = -hz;
      const S = hz;
      const iL = L + T;
      const iR = R - T;
      const iN = N + T;
      const iS = S - T;
      const loft = [[-3.4, -2.2], [2.2, 3.4]];
      bWall(B, 'z', L, iL, N, S, G, H, holes(loft, gy + 2.4, gy + 3.5), bmBarn, parent);
      bWall(B, 'z', iR, R, N, S, G, H, holes(loft, gy + 2.4, gy + 3.5), bmBarn, parent);
      bWall(B, 'x', N, iN, L, R, G, H, [{ a: -1.2, b: 1.2, sill: gy + 2.6, head: gy + 3.9 }], bmBarn, parent);
      bWall(B, 'x', iS - 1.6, iS, L, R, G, H, holes([[-3.6, -2.8]], gy + 1.0, gy + 2.2), bmBarn, parent);
      bBox(B, 'x', iS - 1.6, iS, L, R, gy + 3.9, H, bmBarn, parent); // header over the big door
      bBox(B, 'x', iS, S, L, R, H, H + 0.2, bmBarn, parent);
      bGable(B, L - OVER, R + OVER, N - OVER, S + OVER, H + 0.2, H + 0.2 + PEAK, bmBarn, parent);
      bBox(B, 'x', -3.2, -2.0, -2.2, -1.0, gy, gy + 1.1, bmHay, parent);
      bBox(B, 'x', 1.4, 2.6, 0.2, 1.4, gy, gy + 1.6, bmHay, parent);
      bBox(B, 'x', -0.6, 0.6, -2.0, -0.8, gy, gy + 0.7, bmHay, parent);
      return { u: 0, v: S, nu: 0, nv: 1 };
    }

    function buildSilo(B: any, gy = 0, parent?: THREE.Object3D) {
      bBox(B, 'z', -1.5, 1.5, -1.5, 1.5, gy - 0.4, gy + 11, bmSilo, parent);
      bBox(B, 'z', -1.05, 1.05, -1.05, 1.05, gy + 11, gy + 12.2, bmSilo, parent);
      bBox(B, 'z', -0.45, 0.45, -0.45, 0.45, gy + 12.2, gy + 12.7, bmWarnOrange, parent);
    }

    function buildWaterTower(B: any, gy = 0, parent?: THREE.Object3D) {
      for (const sx of [-1.4, 1.4]) {
        for (const sz of [-1.4, 1.4]) {
          bBox(B, 'z', sx - 0.18, sx + 0.18, sz - 0.18, sz + 0.18, gy, gy + 7.2, bmRust, parent);
        }
      }
      for (const yy of [2.4, 4.8]) {
        bBox(B, 'x', -1.55, 1.55, -0.09, 0.09, gy + yy, gy + yy + 0.2, bmRust, parent);
        bBox(B, 'z', -0.09, 0.09, -1.55, 1.55, gy + yy, gy + yy + 0.2, bmRust, parent);
      }
      bBox(B, 'z', -2.1, 2.1, -2.1, 2.1, gy + 7.2, gy + 10.1, bmWhite, parent);
      bBox(B, 'z', -1.6, 1.6, -1.6, 1.6, gy + 10.1, gy + 10.9, bmBandRed, parent);
      bBox(B, 'z', -0.75, 0.75, -0.75, 0.75, gy + 10.9, gy + 11.4, bmBandRed, parent);
      bBox(B, 'z', -0.16, 0.16, -0.16, 0.16, gy, gy + 7.4, bmRust, parent); // riser pipe
      bBox(B, 'x', 1.5, 2.7, 1.5, 2.4, gy, gy + 0.9, bmCrate, parent); // starter crate
    }

    function buildGuardTower(B: any, gy = 0, parent?: THREE.Object3D) {
      const PL = 4.6;
      for (const sx of [-1.5, 1.5]) {
        for (const sz of [-1.5, 1.5]) {
          bBox(B, 'z', sx - 0.2, sx + 0.2, sz - 0.2, sz + 0.2, gy, gy + PL, bmWood, parent);
        }
      }
      bBox(B, 'x', -1.95, 1.95, -0.12, 0.12, gy + 2.1, gy + 2.3, bmWood, parent);
      bBox(B, 'z', -0.12, 0.12, -1.95, 1.95, gy + 2.1, gy + 2.3, bmWood, parent);
      bBox(B, 'z', -1.95, 1.95, -1.95, 1.95, gy + PL, gy + PL + 0.35, bmPlank, parent);
      // railing with viewing slits on all four sides
      bBox(B, 'z', -1.95, 1.95, 1.8, 1.95, gy + PL + 0.35, gy + PL + 1.25, bmWood, parent);
      bBox(B, 'z', -1.95, 1.95, -1.95, -1.8, gy + PL + 0.35, gy + PL + 1.25, bmWood, parent);
      bBox(B, 'x', -1.95, 1.95, 1.8, 1.95, gy + PL + 0.35, gy + PL + 1.25, bmWood, parent);
      bBox(B, 'x', -1.95, 1.95, -1.95, -1.8, gy + PL + 0.35, gy + PL + 1.25, bmWood, parent);
      for (const sx of [-1.7, 1.7]) {
        for (const sz of [-1.7, 1.7]) {
          bBox(B, 'z', sx - 0.12, sx + 0.12, sz - 0.12, sz + 0.12, gy + PL + 1.25, gy + PL + 1.95, bmWood, parent);
        }
      }
      bBox(B, 'z', -2.3, 2.3, -2.3, 2.3, gy + PL + 1.95, gy + PL + 2.25, bmRoof, parent);
      // zig-zag ladder up the south face: 0.42 m steps (<= step-up) so
      // you can simply walk to the top — no build pieces needed.
      const steps = Math.ceil((PL + 0.35 - 0.42) / 0.42);
      for (let i = 0; i < steps; i++) {
        const off = i % 2 === 0 ? -0.35 : 0.35;
        bBox(B, 'x', off - 0.36, off + 0.36, 1.62, 2.06, gy + (i + 1) * 0.42 - 0.42, gy + (i + 1) * 0.42, bmPlankDark, parent);
      }
      bBox(B, 'x', 2.1, 2.9, -2.4, -1.4, gy, gy + 0.85, bmCrate, parent);
    }

    function buildRadioMast(B: any, gy = 0, parent?: THREE.Object3D) {
      const legs: Array<[number, number]> = [
        [0, 1.25],
        [-1.08, -0.62],
        [1.08, -0.62],
      ];
      for (const [lx, lz] of legs) {
        bBox(B, 'z', lx - 0.13, lx + 0.13, lz - 0.13, lz + 0.13, gy, gy + 20, bmRust, parent);
      }
      for (let lvl = 0; lvl < 6; lvl++) {
        const yy = gy + 2.4 + lvl * 3.1;
        bBox(B, 'x', -1.2, 1.2, -0.1, 0.1, yy, yy + 0.18, bmRust, parent);
        bBox(B, 'x', -0.1, 0.1, -1.25, 1.25, yy, yy + 0.18, bmRust, parent);
        bBox(B, 'z', -1.2, 1.2, -0.75, -0.55, yy, yy + 0.18, bmRust, parent);
      }
      bBox(B, 'z', -0.16, 0.16, -0.16, 0.16, gy + 20, gy + 24, bmSteelDark, parent);
      bBox(B, 'z', -0.3, 0.3, -0.3, 0.3, gy + 24, gy + 24.6, bmBeaconRed, parent);
      bBox(B, 'x', 0, 0.24, -0.12, 0.12, gy + 21.6, gy + 22.8, bmRust, parent); // dish post
      bBox(B, 'z', -0.06, 0.06, -0.85, 0.85, gy + 22.8, gy + 24.0, bmWhite, parent); // dish face
      bBox(B, 'x', 1.6, 2.3, 0.9, 1.6, gy, gy + 0.5, bmSteelDark, parent); // equipment box
    }

    function buildRuin(B: any, gy = 0, parent?: THREE.Object3D) {
      const jags = (a0: number, a1: number) => [
        { a: a0, b: a0 + 1.1, h: 2.4 },
        { a: a0 + 1.1, b: a0 + 2.2, h: 1.15 },
        { a: a0 + 2.2, b: a1, h: 1.9 },
      ];
      for (const s of jags(-3, 3)) bBox(B, 'z', -3, -2.7, s.a, s.b, gy, gy + s.h, bmWall, parent);
      for (const s of jags(-3, 3)) bBox(B, 'x', 2.7, 3, s.a, s.b, gy, gy + s.h + 0.3, bmWall, parent);
      bBox(B, 'x', -3, 3, -0.9, -0.45, gy, gy + 1.3, bmWall, parent); // south fragment + door gap
      bBox(B, 'x', -3, 3, 0.45, 0.9, gy, gy + 1.6, bmWall, parent);
      bBox(B, 'x', -3, 3, -0.9, 0.9, gy + 2.4, gy + 2.6, bmWall, parent); // fallen lintel
      bBox(B, 'z', 1.2, 2.6, -2.4, -1.0, gy, gy + 0.35, bmSlab, parent); // collapsed roof
      bBox(B, 'z', -0.2, 1.2, -2.4, -1.0, gy, gy + 0.22, bmSlab, parent);
      bBox(B, 'x', -2.2, -1.2, 1.2, 2.2, gy, gy + 0.6, bmCrate, parent);
      bBox(B, 'x', 0.4, 1.3, -2.0, -1.1, gy, gy + 0.45, bmGravel, parent);
    }

    function buildTent(B: any, gy = 0, parent?: THREE.Object3D, mat = bmCanvasTan) {
      const W = 1.3;
      bBox(B, 'z', -W, W, -1.5, -1.35, gy, gy + 1.6, mat, parent); // back
      bBox(B, 'z', -W, -W + 0.12, -1.35, 1.1, gy, gy + 1.15, mat, parent); // sides
      bBox(B, 'z', W - 0.12, W, -1.35, 1.1, gy, gy + 1.15, mat, parent);
      bBox(B, 'x', 0.65, 1.1, -W, W, gy, gy + 1.15, mat, parent);
      bBox(B, 'x', 1.1, 1.35, -W, W, gy, gy + 1.9, mat, parent); // front header
      bBox(B, 'x', -1.62, 1.62, -1.78, 1.5, gy + 1.9, gy + 2.05, mat, parent); // roof
    }

    function buildTank(B: any, gy = 0, parent?: THREE.Object3D) {
      // containment berm — knee-high cover ring around the tank
      bBox(B, 'x', -4.3, 4.3, -4.3, -3.9, gy, gy + 1.1, bmConcrete, parent);
      bBox(B, 'x', -4.3, 4.3, 3.9, 4.3, gy, gy + 1.1, bmConcrete, parent);
      bBox(B, 'z', -4.3, -3.9, -3.9, 3.9, gy, gy + 1.1, bmConcrete, parent);
      bBox(B, 'z', 3.9, 4.3, -3.9, 3.9, gy, gy + 1.1, bmConcrete, parent);
      bBox(B, 'z', -2.8, 2.8, -2.8, 2.8, gy, gy + 0.9, bmConcrete, parent); // plinth
      bBox(B, 'z', -2.6, 2.6, -2.6, 2.6, gy + 0.9, gy + 5.4, bmWhite, parent); // drum
      bBox(B, 'z', -2.2, 2.2, -2.2, 2.2, gy + 5.4, gy + 6.6, bmWhite, parent); // dome
      bBox(B, 'z', -0.7, 0.7, -0.7, 0.7, gy + 6.6, gy + 7.2, bmBandRed, parent); // vent
      bBox(B, 'x', 2.6, 3.4, -0.1, 0.1, gy + 0.9, gy + 3.6, bmSteelDark, parent); // pipe run
      bBox(B, 'x', 3.2, 3.6, -0.1, 0.1, gy, gy + 0.9, bmSteelDark, parent);
    }

    function buildGreenhouse(B: any, gy = 0, parent?: THREE.Object3D) {
      const hx = 2.6;
      const hz = 4.2;
      const T = 0.22;
      const H = gy + 2.6;
      const G = gy;
      const L = -hx;
      const R = hx;
      const N = -hz;
      const S = hz;
      const iL = L + T;
      const iR = R - T;
      const iN = N + T;
      const iS = S - T;
      const big = [[-3.4, -0.8], [0.8, 3.4]];
      bWall(B, 'z', L, iL, N, S, G, H, holes(big, gy + 0.4, gy + 2.2), bmWhite, parent);
      bWall(B, 'z', iR, R, N, S, G, H, holes(big, gy + 0.4, gy + 2.2), bmWhite, parent);
      bWall(B, 'x', N, iN, L, R, G, H, holes([[-1.8, -0.6], [0.6, 1.8]], gy + 0.4, gy + 2.2), bmWhite, parent);
      bWall(B, 'x', iS, S, L, R, G, H, holes([[-1.8, -0.6], [0.6, 1.8]], gy + 0.4, gy + 2.2), bmWhite, parent);
      bBox(B, 'x', N - 0.2, S + 0.2, L - 0.2, R + 0.2, H, H + 0.16, bmWhite, parent);
      bBox(B, 'x', -1.8, -1.0, -3.2, -2.2, gy, gy + 0.55, bmHay, parent); // planters
      bBox(B, 'x', 0.6, 1.4, 1.4, 2.4, gy, gy + 0.55, bmHay, parent);
      bBox(B, 'x', -0.6, 0.6, -0.8, 0.4, gy, gy + 0.45, bmHay, parent);
    }

    function buildOffice(B: any, gy = 0, parent?: THREE.Object3D) {
      const hx = 5;
      const hz = 3.5;
      const T = 0.35;
      const F1 = gy + 3.1;
      const SLAB = 0.4;
      const F2 = F1 + SLAB;
      const TOP = F2 + 2.7;
      const G = gy;
      const L = -hx;
      const R = hx;
      const N = -hz;
      const S = hz;
      const iL = L + T;
      const iR = R - T;
      const iN = N + T;
      const iS = S - T;
      const win = [[-3.8, -2.4], [-1.2, 1.2], [2.4, 3.8]];
      const winSide = [[-2.4, -1.0], [1.0, 2.4]];

      bWall(B, 'z', L, iL, N, S, G, F1, holes(winSide, gy + 0.9, gy + 2.3), bmCream, parent);
      bWall(B, 'z', iR, R, N, S, G, F1, holes(winSide, gy + 0.9, gy + 2.3), bmCream, parent);
      bWall(B, 'x', N, iN, L, R, G, F1, holes(win, gy + 0.9, gy + 2.3), bmCream, parent);
      bWall(B, 'x', iS, S, L, R, G, F1, [...holes(win.slice(0, 2), gy + 0.9, gy + 2.3), { a: -0.9, b: 0.9, sill: gy, head: gy + 2.3 }], bmCream, parent);

      bWall(B, 'z', L, iL, N, S, F2, TOP, holes(winSide, F2 + 0.9, F2 + 2.1), bmCream, parent);
      bWall(B, 'z', iR, R, N, S, F2, TOP, holes(winSide, F2 + 0.9, F2 + 2.1), bmCream, parent);
      bWall(B, 'x', N, iN, L, R, F2, TOP, holes(win, F2 + 0.9, F2 + 2.1), bmCream, parent);
      bWall(B, 'x', iS, S, L, R, F2, TOP, holes(win, F2 + 0.9, F2 + 2.1), bmCream, parent);

      bBox(B, 'x', N, -0.4, iL, iR, F1, F1 + SLAB, bmSlab, parent); // second-floor slab (north half)
      bBox(B, 'x', -0.4, iS, iL + 2.4, iR, F1, F1 + SLAB, bmSlab, parent); // landing
      const STEPS = 9;
      const RISE = 0.32;
      const RUN = 0.32;
      for (let i = 0; i < STEPS; i++) {
        bBox(B, 'z', iR - 0.9, iR - 0.1, iS - (i + 1) * RUN - 2.2, iS - i * RUN - 2.2, gy, gy + (i + 1) * RISE, bmStair, parent);
      }
      bBox(B, 'x', N, S, L, R, TOP, TOP + 0.28, bmRoof, parent); // roof deck
      // parapet ring — rooftop cover with the sea view
      bBox(B, 'x', N - 0.2, S + 0.2, L - 0.2, L + 0.15, TOP + 0.28, TOP + 1.05, bmCream, parent);
      bBox(B, 'x', N - 0.2, S + 0.2, R - 0.15, R + 0.2, TOP + 0.28, TOP + 1.05, bmCream, parent);
      bBox(B, 'z', L - 0.2, L + 0.15, N - 0.2, S + 0.2, TOP + 0.28, TOP + 1.05, bmCream, parent);
      bBox(B, 'z', R - 0.15, R + 0.2, N - 0.2, S + 0.2, TOP + 0.28, TOP + 1.05, bmCream, parent);
      bBox(B, 'x', -1.0, 1.0, 2.0, 2.9, gy, gy + 0.85, bmCrate, parent); // stacked import crates
      bBox(B, 'x', -2.1, -1.2, 2.2, 2.9, gy, gy + 0.6, bmCrate, parent);
    }

    function buildTowerCrane(B: any, gy = 0, parent?: THREE.Object3D) {
      const MAST = 18;
      bBox(B, 'z', -0.75, -0.45, -0.15, 0.15, gy, gy + MAST, bmWarnOrange, parent);
      bBox(B, 'z', 0.45, 0.75, -0.15, 0.15, gy, gy + MAST, bmWarnOrange, parent);
      for (let lvl = 0; lvl < 8; lvl++) {
        const yy = gy + 1.4 + lvl * 2.2;
        bBox(B, 'x', -0.75, 0.75, -0.09, 0.09, yy, yy + 0.2, bmWarnOrange, parent);
      }
      bBox(B, 'z', -0.9, 0.9, -0.8, 0.8, gy + MAST, gy + MAST + 1.4, bmSteelDark, parent); // cab
      bBox(B, 'x', -11.5, 11.5, -0.12, 0.12, gy + MAST + 1.4, gy + MAST + 2.1, bmWarnOrange, parent); // jib
      bBox(B, 'x', -4.6, -1.4, -0.14, 0.14, gy + MAST + 2.1, gy + MAST + 2.5, bmWarnOrange, parent); // counter-jib
      bBox(B, 'x', -4.3, -1.7, -0.75, 0.75, gy + MAST + 1.5, gy + MAST + 2.6, bmConcrete, parent); // counterweight
      bBox(B, 'x', 7.4, 7.6, -0.05, 0.05, gy + MAST - 3.4, gy + MAST + 2.0, bmSteelDark, parent); // hoist cable
      bBox(B, 'x', 6.6, 8.4, -0.9, 0.9, gy + MAST - 4.6, gy + MAST - 3.4, bmConcrete, parent); // hanging slab
      bBox(B, 'z', -0.26, 0.26, -0.26, 0.26, gy + MAST + 2.1, gy + MAST + 2.6, bmBeaconRed, parent); // beacon
    }

    function buildCabinBox(B: any, gy = 0, parent?: THREE.Object3D) {
      const hx = 2.1;
      const hz = 1.6;
      const T = 0.2;
      const H = gy + 2.6;
      const G = gy;
      const L = -hx;
      const R = hx;
      const N = -hz;
      const S = hz;
      const iL = L + T;
      const iR = R - T;
      const iN = N + T;
      const iS = S - T;
      bWall(B, 'z', L, iL, N, S, G, H, holes([[-0.7, 0.7]], gy + 1.0, gy + 2.0), bmWhite, parent);
      bWall(B, 'z', iR, R, N, S, G, H, holes([[-0.7, 0.7]], gy + 1.0, gy + 2.0), bmWhite, parent);
      bWall(B, 'x', N, iN, L, R, G, H, [], bmWhite, parent);
      bWall(B, 'x', iS, S, L, R, G, H, [{ a: -0.7, b: 0.7, sill: gy, head: gy + 1.9, glass: false }], bmWhite, parent);
      bBox(B, 'x', N - 0.2, S + 0.2, L - 0.2, R + 0.2, H, H + 0.16, bmRoof, parent);
      bBox(B, 'x', 0.3, 1.3, N + 0.1, N + 1.0, H + 0.16, H + 0.6, bmSteelDark, parent); // AC unit
    }

    function buildLighthouse(B: any, gy = 0, parent?: THREE.Object3D) {
      const segs = [
        { w: 1.55, h: 2.1, mat: bmWhite },
        { w: 1.35, h: 2.1, mat: bmBandRed },
        { w: 1.15, h: 2.1, mat: bmWhite },
        { w: 0.98, h: 2.0, mat: bmBandRed },
      ];
      let y = gy;
      for (const s of segs) {
        bBox(B, 'z', -s.w, s.w, -s.w, s.w, y - 0.12, y + s.h, s.mat, parent);
        y += s.h;
      }
      const GAL = y;
      bBox(B, 'z', -1.72, 1.72, -1.72, 1.72, GAL, GAL + 0.3, bmSteelDark, parent); // gallery deck
      bBox(B, 'z', -1.72, 1.72, 1.55, 1.72, GAL + 0.3, GAL + 1.15, bmSteelDark, parent); // gallery rail
      bBox(B, 'z', -1.72, 1.72, -1.72, -1.55, GAL + 0.3, GAL + 1.15, bmSteelDark, parent);
      bBox(B, 'x', -1.72, 1.72, 1.55, 1.72, GAL + 0.3, GAL + 1.15, bmSteelDark, parent);
      bBox(B, 'x', -1.72, 1.72, -1.72, -1.55, GAL + 0.3, GAL + 1.15, bmSteelDark, parent);
      bBox(B, 'z', -0.55, 0.55, -0.55, 0.55, GAL + 0.3, GAL + 1.85, bmLamp, parent); // the light
      bBox(B, 'z', -0.95, 0.95, -0.95, 0.95, GAL + 1.85, GAL + 2.2, bmBandRed, parent); // lamp roof
      bBox(B, 'z', -0.45, 0.45, -0.45, 0.45, GAL + 2.2, GAL + 2.7, bmBandRed, parent); // finial
      // zig-zag stair winding up the south face — 0.42 m rise per step
      // (under the 0.45 step-up) so the gallery is simply walkable.
      const rise = 0.42;
      const steps = Math.ceil((GAL - rise) / rise);
      for (let i = 0; i < steps; i++) {
        const side = i % 2 === 0 ? -1 : 1;
        bBox(B, 'x', side * 0.85 - 0.34, side * 0.85 + 0.34, 1.55, 1.99, gy + i * rise, gy + (i + 1) * rise, bmPlankDark, parent);
      }
    }

    // Half-built ship for the dry dock: keel, stepped hull sides,
    // deck plate, cabin and funnel — chunky cover you can fight on.
    function buildShip(cx: number, floorTop: number, cz: number, parent?: THREE.Object3D) {
      const s = 2.2; // graving-dock hull — twice the old scale
      bBox({ x: cx, z: cz, rot: 0 }, 'x', -7.5 * s, 7.5 * s, -0.65 * s, 0.65 * s, floorTop + 0.3, floorTop + 2.75, bmRust, parent); // keel
      for (const sd of [-1, 1]) {
        bBox({ x: cx, z: cz, rot: 0 }, 'x', -7.2 * s, 7.2 * s, sd * 1.2 * s - 0.55 * s, sd * 1.2 * s + 0.55 * s, floorTop + 2.75, floorTop + 5.7, bmRust, parent);
        bBox({ x: cx, z: cz, rot: 0 }, 'x', -7.2 * s, 7.2 * s, sd * 2.75 * s - 0.55 * s, sd * 2.75 * s + 0.55 * s, floorTop + 1.3, floorTop + 4.2, bmRust, parent);
      }
      bBox({ x: cx, z: cz, rot: 0 }, 'x', -7.4 * s, 7.4 * s, -3.1 * s, 3.1 * s, floorTop + 5.7, floorTop + 6.5, bmSteelDark, parent); // deck
      bBox({ x: cx, z: cz, rot: 0 }, 'x', 6.0 * s, 8.6 * s, -2.1 * s, 2.1 * s, floorTop + 6.5, floorTop + 7.3, bmRust, parent); // bow
      bBox({ x: cx, z: cz, rot: 0 }, 'x', 7.8 * s, 9.6 * s, -1.2 * s, 1.2 * s, floorTop + 5.7, floorTop + 6.5, bmRust, parent); // bow tip
      bBox({ x: cx - 4.4 * s, z: cz, rot: 0 }, 'z', -1.6 * s, 1.6 * s, -1.3 * s, 1.3 * s, floorTop + 6.5, floorTop + 11.6, bmWhite, parent); // cabin
      bBox({ x: cx - 4.4 * s, z: cz, rot: 0 }, 'z', -0.5 * s, 0.5 * s, -0.5 * s, 0.5 * s, floorTop + 11.6, floorTop + 15.6, bmWarnOrange, parent); // funnel
      bBox({ x: cx + 1.5 * s, z: cz, rot: 0 }, 'z', -1.1 * s, 1.1 * s, -1.1 * s, 1.1 * s, floorTop + 6.5, floorTop + 8.8, bmCrate, parent); // deck cargo
    }

    // Small moored boat beside the pier head — a swim-out platform.
    function buildBoat(bx: number, bz: number, parent?: THREE.Object3D) {
      bBox({ x: bx, z: bz, rot: 0 }, 'x', -2.8, 2.8, -1.0, 1.0, WATER_Y - 0.95, WATER_Y + 0.55, bmRust, parent); // hull
      bBox({ x: bx + 2.8, z: bz, rot: 0 }, 'x', 0, 1.7, -0.75, 0.75, WATER_Y - 0.55, WATER_Y + 0.55, bmRust, parent); // bow
      bBox({ x: bx + 4.5, z: bz, rot: 0 }, 'x', 0, 0.9, -0.45, 0.45, WATER_Y - 0.3, WATER_Y + 0.55, bmRust, parent); // bow tip
      bBox({ x: bx - 1.9, z: bz, rot: 0 }, 'z', -0.95, 0.95, -0.85, 0.85, WATER_Y + 0.55, WATER_Y + 2.05, bmWhite, parent); // wheelhouse
      bBox({ x: bx - 0.6, z: bz, rot: 0 }, 'x', -0.5, 0.5, -0.9, 0.9, WATER_Y + 0.55, WATER_Y + 0.95, bmCrate, parent); // deck cargo
    }

    const DESIGNS = [
      { kind: 'house', hx: 6, hz: 4.5, build: buildHouse },
      { kind: 'cottage', hx: 4.5, hz: 3.5, build: buildCottage },
      { kind: 'bunker', hx: 5, hz: 3.5, build: buildBunker },
      { kind: 'warehouse', hx: 7, hz: 5, build: buildWarehouse },
    ];

    const BUILDINGS: any[] = [];
    for (const d of DESIGNS) {
      const R = Math.max(d.hx, d.hz) + 3;
      for (let t = 0; t < 500; t++) {
        const x = (Math.random() - 0.5) * 120 * FIELD;
        const z = (Math.random() - 0.5) * 120 * FIELD;
        if (Math.hypot(x, z - 14) < 26 + R) continue;
        if (nearPool(x, z, R + 3)) continue;
        if (spots.some((s) => Math.hypot(s.x - x, s.z - z) < R + 2)) continue;
        if (solids.some((b) => Math.abs(x - b.x) < b.hx + R && Math.abs(z - b.z) < b.hz + R)) continue;
        const B = { x, z, rot: Math.random() < 0.5 ? 0 : 1 };
        const door = d.build(B);
        const p = turnPoint(B, door.u, door.v);
        const q = turnPoint(B, door.u + door.nu, door.v + door.nv);
        BUILDINGS.push({ kind: d.kind, x, z, rot: B.rot, hx: d.hx, hz: d.hz, door: { x: p.x, z: p.z, nx: q.x - p.x, nz: q.z - p.z } });
        break;
      }
    }

    // Scatters
    scatter('heavy', 24 * FIELD);
    scatter('light', 24 * FIELD);
    scatter('smg', 3 * FIELD);
    scatter('sniper', 2 * FIELD);
    scatter('betgun', 2 * FIELD);
    scatter('shield', 4 * FIELD);

    const AMMO_BONUS: Record<string, number> = { smg: 40, sniper: 10, sk: 10, betgun: 12 };

    function addWeapon(w: any, replaceSlot: number) {
      if (w.loaded === 0) {
        const take = Math.min(w.mag, reserve[w.ammo] || 0);
        w.loaded = take;
        reserve[w.ammo] = (reserve[w.ammo] || 0) - take;
      }
      let i = slots.indexOf(null);
      if (i < 0) {
        i = replaceSlot;
        dropWeapon(slots[i]);
      }
      slots[i] = w;
      equip(w);
      showMessage(w.name + ' in slot ' + (i + 1), 1.6);
    }

    function dropWeapon(w: any) {
      const kind = Object.keys(WEAPONS).find((k) => WEAPONS[k] === w);
      if (!kind) return;
      const group = pickupMesh(kind);
      group.position.set(camera.position.x, groundAt(camera.position.x, camera.position.z), camera.position.z);
      scene.add(group);
      pickups.push({
        kind,
        x: camera.position.x,
        z: camera.position.z,
        group,
        taken: false,
        timer: 0,
        dropped: true,
        armed: false,
        gone: false,
      });
    }

    function collect(p: PickupItem) {
      if (p.kind in GREN) {
        grenades[p.kind as keyof typeof grenades] += 1;
        showMessage('+1 ' + GREN[p.kind as keyof typeof GREN].name + ' grenade', 1.5);
        p.taken = true;
        p.timer = RESPAWN;
        p.group.visible = false;
        refreshGrenades();
        return;
      }
      if (p.dropped) p.gone = true;
      else {
        p.taken = true;
        p.timer = RESPAWN;
        p.group.visible = false;
      }
      if (p.kind === 'smg' || p.kind === 'sniper' || p.kind === 'sk' || p.kind === 'betgun') {
        const w = WEAPONS[p.kind];
        if (slots.includes(w)) {
          const amount = AMMO_BONUS[p.kind] || 20;
          reserve[w.ammo] = (reserve[w.ammo] || 0) + amount;
          showMessage('+' + amount + ' ' + w.ammo + ' ammo', 1.5);
        } else {
          if (!p.dropped) reserve[w.ammo] = (reserve[w.ammo] || 0) + (AMMO_BONUS[p.kind] || 0);
          addWeapon(w, lastSlot);
        }
      } else if (p.kind === 'shield') {
        shield = shieldMax();
        gainXp(ORB_XP, 'Shield refilled');
      } else {
        const amount = p.kind === 'heavy' ? 20 : 40;
        reserve[p.kind] = (reserve[p.kind] || 0) + amount;
        showMessage('+' + amount + ' ' + p.kind + ' ammo', 1.5);
      }
      refreshHud();
    }

    // Health, Shield & Respawn
    function hurtPlayer(dmg: number, pen = 0) {
      if (playerDown || dmg <= 0) return;
      if (roll && roll.t < ROLL_IFRAMES) return;
      const had = shield;
      const absorbed = Math.min(shield, dmg);
      shield -= absorbed;
      life = Math.max(0, life - (dmg - absorbed) - pen);
      sinceHurt = 0;
      hurtFlash = 0.35;
      shieldFlash = 0.22;
      if (had > 0 && shield <= 0) showMessage('Shield down', 1.5);
      if (life <= 0) goDown();
    }

    function goDown() {
      if (bombArmed) {
        bombArmed = false;
        updateBombHud();
      }
      disarmGrenade();
      cancelGrenadePress();
      playerDown = true;
      respawnT = RESPAWN_TIME;
      mouseHeld = aimMouse = false;
      releaseTouch();
      setOffer(null);
      slide = null;
      roll = null;
      airCarry = null;
      slideReq = false;
      rollReq = 0;
      if (turret) turret.carried = false;
      if (character === 'barrage') releaseVolley();
      reloadT = 0;
      scopeT = 0;
      scopeEl?.classList.remove('on');
    }

    function respawn() {
      playerDown = false;
      life = lifeMax();
      shield = shieldMax();
      sinceHurt = 99;
      eyeH = EYE;
      camera.position.set(spawn.x, EYE + groundAt(spawn.x, spawn.z), spawn.z);
      yaw = 0;
      pitch = 0;
      kick = 0;
      vy = 0;
      grounded = true;
      climb = null;
      slide = null;
      roll = null;
      airCarry = null;
      slideReq = false;
      rollReq = 0;
      showMessage('Back in the fight', 1.5);
    }

    function updateShield(dt: number) {
      sinceHurt += dt;
      hurtFlash = Math.max(0, hurtFlash - dt);
      shieldFlash = Math.max(0, shieldFlash - dt);
      shield = calculateShieldRegen(shield, shieldMax(), sinceHurt, SHIELD_DELAY, SHIELD_REGEN, dt, playerDown);
    }

    let vitalsShown = '';
    function updateVitals() {
      const cap = shieldMax();
      const sf = Math.max(0, Math.min(1, shield / cap));
      const regenerating = !playerDown && sinceHurt >= SHIELD_DELAY && shield < cap;
      const key = Math.ceil(shield) + '/' + cap + '|' + Math.ceil(life) + '|' + shieldLevel;
      if (key !== vitalsShown) {
        vitalsShown = key;
        if (shieldNumEl) shieldNumEl.textContent = Math.ceil(shield) + ' / ' + cap;
        if (lifeNumEl) lifeNumEl.textContent = Math.ceil(life) + ' / ' + lifeMax();
        pipEls.forEach((p, i) => p.classList.toggle('on', i < shieldLevel));
      }
      if (shieldFill) shieldFill.style.transform = 'scaleX(' + sf.toFixed(4) + ')';
      if (lifeFill) lifeFill.style.transform = 'scaleX(' + Math.max(0, life / lifeMax()).toFixed(4) + ')';
      shieldRow?.classList.toggle('regen', regenerating);
      if (shieldFx) {
        shieldFx.style.setProperty('--sh', sf.toFixed(3));
        shieldFx.classList.toggle('regen', regenerating);
        shieldFx.classList.toggle('flick', shieldFlash > 0);
      }
      if (hurtFx) hurtFx.style.opacity = (hurtFlash / 0.35).toFixed(3);
      if (downedEl) downedEl.hidden = !playerDown;
      if (playerDown && downedTimerEl) downedTimerEl.textContent = String(Math.ceil(respawnT));
      updateLevelHud();
      updateTurretHud();
    }

    let pickOffer: PickupItem | null = null;
    function updatePickups(dt: number) {
      let offer: PickupItem | null = null;
      for (const p of pickups) {
        if (p.gone) continue;
        if (p.taken) {
          p.timer -= dt;
          if (p.timer <= 0) {
            p.taken = false;
            p.group.visible = true;
          }
          continue;
        }
        p.group.rotation.y += dt * 1.2;
        const near = Math.hypot(p.x - camera.position.x, p.z - camera.position.z) < PICKUP_RADIUS;
        if (p.dropped && !p.armed) {
          if (!near) p.armed = true;
          continue;
        }
        if (!near) continue;
        if (p.kind in WEAPONS && !owned(WEAPONS[p.kind]) && slots.indexOf(null) < 0) {
          offer = offer || p;
          continue;
        }
        if (p.kind in GREN && gTotal() >= carryCap()) {
          if (msgT <= 0) showMessage('Grenades full: ' + carryCap() + ' carried', 1.2);
          continue;
        }
        collect(p);
      }
      for (let i = pickups.length - 1; i >= 0; i--) {
        if (pickups[i].gone) {
          scene.remove(pickups[i].group);
          pickups.splice(i, 1);
        }
      }
      setOffer(offer);
    }

    function setOffer(p: PickupItem | null) {
      if (p === pickOffer) return;
      pickOffer = p;
      pickBtn?.classList.toggle('off', !p);
      pickBtn?.setAttribute('aria-disabled', String(!p));
      if (pickNameEl) pickNameEl.textContent = p ? WEAPONS[p.kind]?.name || '' : '';
    }

    function forcePick() {
      if (!running() || playerDown || !pickOffer) return;
      const p = pickOffer;
      setOffer(null);
      collect(p);
    }

    // ----------------------------------------------------
    // XP and Leveling
    // ----------------------------------------------------
    const ORB_XP = 200;
    let xp = 0;
    let playerLevel = 1;

    const TURRET_UPGRADES: Record<number, any> = {
      2: { text: 'your shield up to 304', shieldLevel: 2 },
      3: {
        text: 'turret damage +50%',
        damageMult: 1.5,
        bomb: { dmgMult: 1.5, text: 'bombardment damage +50%' },
        ant: { hpMult: 1.5, text: 'antenna durability +50%' },
      },
      4: { text: 'your shield up to 456', shieldLevel: 3 },
      5: {
        text: 'turret fire rate +50%',
        delay: 0.4,
        bomb: { radiusMult: 1.25, shellsMult: 1.5, text: 'bombardment radius +25%, 50% more shells' },
        ant: { durMult: 1.5, text: 'antenna uptime +50% (90 s scan)' },
      },
    };
    const TURRET = { range: 30, mag: 40, spinUp: 0.3, reach: 2.5, carryDist: [1.2, 0.8, 0.4] };
    let turretLevel = 1;
    let turretDamage = 38;
    let turretDelay = 0.6;
    let turret: any = null;

    const turretEl = $('turret');
    const turretLvEl = $('turretLv');
    const turretStateEl = $('turretState');
    const levelNumEl = $('levelNum');
    const xpNumEl = $('xpNum');
    const xpFillEl = $('xpFill');

    function gainXp(amount: number, text = '') {
      const was = playerLevel;
      const res = calculateXpProgression(playerLevel, xp, amount);
      playerLevel = res.newLevel;
      xp = res.newXp;
      for (const lvl of res.levelsGained) {
        levelUp(lvl);
      }
      if (playerLevel === was) showMessage((text ? text + ' · ' : '') + '+' + amount + ' XP', 1.6);
    }

    function levelUp(l: number) {
      const up = TURRET_UPGRADES[l];
      if (!up) return;
      turretLevel = l;
      if (up.shieldLevel && shieldLevel < up.shieldLevel) {
        const before = shieldMax();
        shieldLevel = up.shieldLevel;
        shield += shieldMax() - before;
      }
      if (up.damageMult) turretDamage *= up.damageMult;
      if (up.delay) turretDelay = up.delay;
      if (up.bomb) {
        if (up.bomb.dmgMult) BOMB.dmg *= up.bomb.dmgMult;
        if (up.bomb.radiusMult) {
          BOMB.spread *= up.bomb.radiusMult;
          BOMB.blastR *= up.bomb.radiusMult;
        }
        if (up.bomb.shellsMult) BOMB.shells = Math.round(BOMB.shells * up.bomb.shellsMult);
      }
      if (up.ant && character === 'antenna') {
        if (up.ant.hpMult) {
          antHpMult *= up.ant.hpMult;
          if (antenna) {
            const add = Math.round(antenna.maxHp * (up.ant.hpMult - 1));
            antenna.maxHp += add;
            antenna.hp += add;
          }
        }
        if (up.ant.durMult) {
          antDurMult *= up.ant.durMult;
          if (antenna) antenna.left += ANT.duration * (up.ant.durMult - 1);
        }
      }
      const msg =
        character === 'barrage' && up.bomb ? up.bomb.text : character === 'antenna' && up.ant ? up.ant.text : up.text;
      showMessage('Level ' + l + ': ' + msg, 2.5);
    }

    // ----------------------------------------------------
    // Turret Ability
    // ----------------------------------------------------
    function buildTurretMesh() {
      const g = new THREE.Group();
      part(g, new THREE.CylinderGeometry(0.42, 0.5, 0.22, 16), metal, 0, 0.11, 0);
      part(g, new THREE.TorusGeometry(0.44, 0.03, 8, 24), cyanCore, 0, 0.24, 0, Math.PI / 2);
      part(g, new THREE.BoxGeometry(0.36, 0.26, 0.4), dark, 0, 0.5, 0);
      part(g, new THREE.CylinderGeometry(0.05, 0.05, 0.7, 10), metal, 0, 0.5, 0.55, Math.PI / 2);
      const muzzle = new THREE.Object3D();
      muzzle.position.set(0, 0.5, 0.92);
      g.add(muzzle);
      return { group: g, muzzle };
    }

    function clearSpotAhead(dists: number[]) {
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      // Floor solids (top at/below the player's feet) are NOT obstacles —
      // the harbor deck is one solid foundation grid, and treating the
      // floor as a blocker made turret/antenna deployment impossible
      // anywhere on the port platform.
      const feet = camera.position.y - eyeH;
      for (const dist of dists) {
        const x = camera.position.x + fx * dist;
        const z = camera.position.z + fz * dist;
        if (
          !nearPool(x, z, 1) &&
          solids.every((b) => b.top <= feet + 0.15 || Math.abs(x - b.x) >= b.hx + 0.5 || Math.abs(z - b.z) >= b.hz + 0.5)
        ) {
          return { x, z };
        }
      }
      return null;
    }

    const turretInReach = () =>
      !!turret &&
      Math.hypot(turret.group.position.x - camera.position.x, turret.group.position.z - camera.position.z) <= TURRET.reach;

    function summonTurret() {
      const spot = clearSpotAhead([2.5, 1.6, 0.9]);
      if (!spot) {
        showMessage('No room for a turret here', 1.5);
        return;
      }
      const { group, muzzle } = buildTurretMesh();
      group.position.set(spot.x, groundAt(spot.x, spot.z), spot.z);
      scene.add(group);
      turret = { group, muzzle, ammo: TURRET.mag, carried: false, age: 0, fireT: TURRET.spinUp, shots: 0 };
      showMessage('Turret deployed', 1.5);
    }

    function turretAction() {
      if (playerDown) return;
      if (!turret) {
        summonTurret();
        return;
      }
      if (turret.carried) {
        turret.carried = false;
        turret.fireT = TURRET.spinUp;
        showMessage('Turret placed', 1.2);
        return;
      }
      if (!turretInReach()) {
        showMessage('Get within ' + TURRET.reach + ' m of the turret', 1.5);
        return;
      }
      if (turret.ammo === 0) {
        if ((reserve.light || 0) <= 0) {
          showMessage('No light ammo to reload the turret', 1.5);
          return;
        }
        const take = Math.min(TURRET.mag - turret.ammo, reserve.light);
        turret.ammo += take;
        reserve.light -= take;
        refreshHud();
        showMessage('Turret reloaded: +' + take + ' light ammo', 1.5);
        return;
      }
      turret.carried = true;
      showMessage('Carrying the turret. Press again to put it down', 1.8);
    }

    function carryTurret() {
      const spot = clearSpotAhead(TURRET.carryDist);
      if (spot) turret.group.position.set(spot.x, groundAt(spot.x, spot.z), spot.z);
      turret.group.rotation.y = yaw + Math.PI;
    }

    const turretRay = new THREE.Raycaster();
    const turretEye = new THREE.Vector3();
    const turretAim = new THREE.Vector3();
    const turretDir = new THREE.Vector3();

    function turretSees(d: DummyObject) {
      turretAim.set(d.group.position.x, 1, d.group.position.z);
      turretDir.subVectors(turretAim, turretEye).normalize();
      turretRay.set(turretEye, turretDir);
      const hit = turretRay.intersectObjects(shootable, false)[0];
      return !!hit && hit.object.userData.dummy === d && smokeDist(turretEye, turretDir, hit.distance) === Infinity;
    }

    function turretTarget() {
      const g = turret.group.position;
      turretEye.set(g.x, 0.5, g.z);
      let best: DummyObject | null = null;
      let bestDist = TURRET.range;
      for (const d of dummies) {
        if (d.state !== 'up') continue;
        const dist = Math.hypot(d.group.position.x - g.x, d.group.position.z - g.z);
        if (dist < bestDist && turretSees(d)) {
          best = d;
          bestDist = dist;
        }
      }
      return best;
    }

    function updateTurret(dt: number) {
      if (!turret) return;
      turret.age += dt;
      turret.group.scale.setScalar(0.3 + 0.7 * Math.min(1, turret.age / 0.25));
      turret.fireT = Math.max(0, turret.fireT - dt);
      if (turret.carried) {
        carryTurret();
        return;
      }
      if (turret.ammo <= 0) return;
      const target = turretTarget();
      if (!target) return;
      const g = turret.group.position;
      turret.group.rotation.y = Math.atan2(target.group.position.x - g.x, target.group.position.z - g.z);
      if (turret.fireT > 0) return;
      turret.fireT = turretDelay;
      turret.ammo -= 1;
      turret.shots += 1;
      tracer(turret.muzzle.getWorldPosition(new THREE.Vector3()), new THREE.Vector3(target.group.position.x, 1, target.group.position.z), 0x67e8f9);
      hitDummy(target, turretDamage);
    }

    let levelKey = '';
    let turretKey = '';
    function updateLevelHud() {
      const key = xp + '|' + playerLevel;
      if (key === levelKey) return;
      levelKey = key;
      const top = playerLevel >= MAX_LEVEL;
      const cost = top ? 1 : LEVEL_COST[playerLevel - 1];
      if (levelNumEl) levelNumEl.textContent = String(playerLevel);
      if (xpNumEl) xpNumEl.textContent = top ? 'MAX' : xp + ' / ' + cost + ' XP';
      if (xpFillEl) xpFillEl.style.transform = 'scaleX(' + (top ? 1 : Math.min(1, xp / cost)).toFixed(4) + ')';
    }

    function updateTurretHud() {
      if (character === 'barrage') return updateBombHud();
      if (character === 'antenna') return updateAntennaHud();
      const state = !turret
        ? 'Ready'
        : turret.carried
        ? 'Carrying'
        : turret.ammo > 0
        ? 'Ammo ' + turret.ammo
        : turretInReach() && (reserve.light || 0) > 0
        ? 'Reload'
        : 'Empty';
      const key = turretLevel + '|' + state;
      if (key === turretKey) return;
      turretKey = key;
      if (turretLvEl) turretLvEl.textContent = 'Lv ' + turretLevel;
      if (turretStateEl) turretStateEl.textContent = state;
      turretEl?.classList.toggle('ready', !turret);
    }

    // ----------------------------------------------------
    // Antenna Ability (Antenna character): plant a scanner
    // mast that runs for 60 s and reveals every enemy on
    // the minimap and the tactical map. 300 HP — bullets,
    // blasts and shooters can knock it offline early.
    // ----------------------------------------------------
    const ANT = { hp: 300, duration: 60 };
    const ANT_SHOT_DMG = 18; // per enemy hit on the mast
    let antHpMult = 1;
    let antDurMult = 1;
    let antenna: any = null;
    let antKey = '';

    function buildAntennaMesh() {
      const g = new THREE.Group();
      part(g, new THREE.CylinderGeometry(0.36, 0.44, 0.16, 14), metal, 0, 0.08, 0);
      part(g, new THREE.TorusGeometry(0.4, 0.03, 8, 24), cyanCore, 0, 0.19, 0, Math.PI / 2);
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + 0.5;
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.35, 6), metal);
        leg.position.set(Math.cos(a) * 0.33, 0.72, Math.sin(a) * 0.33);
        leg.rotation.z = -Math.cos(a) * 0.42;
        leg.rotation.x = Math.sin(a) * 0.42;
        leg.castShadow = true;
        g.add(leg);
      }
      part(g, new THREE.CylinderGeometry(0.045, 0.06, 1.5, 10), steel, 0, 1.62, 0);
      part(g, new THREE.BoxGeometry(0.86, 0.05, 0.05), dark, 0, 2.02, 0);
      part(g, new THREE.BoxGeometry(0.05, 0.05, 0.86), dark, 0, 2.02, 0);
      part(g, new THREE.BoxGeometry(0.6, 0.045, 0.045), dark, 0, 2.28, 0);
      part(g, new THREE.BoxGeometry(0.045, 0.045, 0.6), dark, 0, 2.28, 0);
      part(g, new THREE.SphereGeometry(0.07, 12, 10), cyanCore, 0, 2.52, 0);
      const beacon = new THREE.Mesh(
        new THREE.SphereGeometry(0.085, 12, 10),
        new THREE.MeshBasicMaterial({ color: 0x67e8f9, transparent: true, opacity: 0.95, depthWrite: false })
      );
      beacon.position.set(0, 2.52, 0);
      g.add(beacon);
      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(0.24, 14, 10),
        new THREE.MeshBasicMaterial({
          color: 0x67e8f9,
          transparent: true,
          opacity: 0.35,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        })
      );
      halo.position.set(0, 2.52, 0);
      g.add(halo);
      return { group: g, beacon, halo };
    }

    function removeAntenna(silent = false) {
      if (!antenna) return;
      for (let i = shootable.length - 1; i >= 0; i--) {
        if ((shootable[i] as any).userData?.antenna === antenna) shootable.splice(i, 1);
      }
      scene.remove(antenna.group);
      disposeBar(antenna.bar);
      antenna = null;
      antKey = '';
      if (!silent) updateAntennaHud();
    }

    function summonAntenna(redeploy = false) {
      const spot = clearSpotAhead([2.6, 1.7, 1.0]);
      if (!spot) {
        showMessage('No room for the antenna here', 1.5);
        return;
      }
      removeAntenna(true);
      const { group, beacon, halo } = buildAntennaMesh();
      const gy = groundAt(spot.x, spot.z);
      group.position.set(spot.x, gy, spot.z);
      scene.add(group);
      const { group: bar, fill } = makeHealthBar();
      bar.position.set(spot.x, gy + 3.15, spot.z);
      scene.add(bar);
      const maxHp = Math.round(ANT.hp * antHpMult);
      antenna = { group, beacon, halo, bar, barFill: fill, hp: maxHp, maxHp, t: 0, left: ANT.duration * antDurMult };
      group.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.userData.antenna = antenna;
          shootable.push(o);
        }
      });
      showMessage(
        redeploy ? 'Antenna redeployed — scanning' : 'Antenna online — every enemy revealed for ' + Math.round(ANT.duration * antDurMult) + ' s',
        1.8
      );
      updateAntennaHud();
    }

    function antennaAction() {
      if (playerDown) return;
      summonAntenna(!!antenna);
    }

    function damageAntenna(amount: number, point?: THREE.Vector3) {
      if (!antenna || amount <= 0) return;
      antenna.hp -= amount;
      const at = point ?? antenna.group.position.clone().setY(antenna.group.position.y + 2.2);
      const shown = Math.round(amount);
      if (shown > 0) showDamagePopup(String(shown), at, '#67e8f9', false);
      if (antenna.hp <= 0) {
        showDamagePopup('ANTENNA DOWN', at.clone().setY(at.y + 0.6), '#ef4444', true);
        playSfx('shatter');
        removeAntenna();
        showMessage('Antenna destroyed — enemy scan lost', 2.2);
      }
    }

    function updateAntenna(dt: number) {
      if (!antenna) return;
      antenna.t += dt;
      antenna.left -= dt;
      antenna.group.scale.setScalar(0.3 + 0.7 * Math.min(1, antenna.t / 0.25));
      const pulse = 0.5 + 0.5 * Math.sin(antenna.t * 8);
      antenna.beacon.scale.setScalar(0.8 + 0.5 * pulse);
      (antenna.halo.material as THREE.MeshBasicMaterial).opacity = 0.2 + 0.5 * pulse;
      antenna.bar.lookAt(camera.position);
      setBarFill(antenna.barFill, Math.max(0, antenna.hp / antenna.maxHp));
      updateAntennaHud();
      if (antenna.left <= 0) {
        removeAntenna();
        showMessage('Antenna power spent — press E to redeploy', 2);
      }
    }

    function updateAntennaHud() {
      const state = !antenna
        ? 'Ready · ' + Math.round(ANT.duration * antDurMult) + ' s scan'
        : 'Scan ' + Math.ceil(antenna.left) + ' s · ' + Math.max(0, Math.ceil(antenna.hp)) + ' HP';
      if (state === antKey) return;
      antKey = state;
      if (turretLvEl) turretLvEl.textContent = 'Lv ' + turretLevel;
      if (turretStateEl) turretStateEl.textContent = state;
      turretEl?.classList.toggle('ready', !antenna);
    }

    // ----------------------------------------------------
    // Grenades & Effects
    // ----------------------------------------------------
    const GREN: Record<string, any> = {
      blast: { name: 'Blast', fuse: 1.8, radius: 12, dmg: 450, selfDmg: 60 },
      fire: { name: 'Fire', fuse: 1.6, radius: 7, life: 8, dps: 32, pen: 16 },
      smoke: { name: 'Smoke', fuse: 1.6, radius: 8.4, life: 9 },
    };
    const GREN_KINDS = Object.keys(GREN);
    const GREN_MAX = 4;
    const GREN_THROW = 13;
    const GREN_GRAVITY = 16;
    const GREN_COOL = 0.6;
    const grenades = { blast: 0, fire: 0, smoke: 0 };
    let gSel = 0;
    let gCool = 0;
    let gArmed = false;
    let armedKind: string | null = null;
    let heldMesh: THREE.Group | null = null;
    let gPress: any = null;
    const GREN_HOLD = 0.3;
    const projectiles: any[] = [];
    const effects: any[] = [];
    const SMOKE_Y = 1.6;
    const gTotal = () => grenades.blast + grenades.fire + grenades.smoke;
    const gPlateName = $('gName');
    const gPlateCount = $('gCount');
    const gBtnEl = $('gBtn');
    const gBtnName = $('gBtnName');
    const gBtnCount = $('gBtnCount');
    const touchBuildBtnEl = $('touchBuildBtn');
    const smokeFxEl = $('smokeFx');
    const shockGeo = new THREE.SphereGeometry(1, 16, 12);
    const puffGeo = new THREE.SphereGeometry(1, 12, 10);
    const flameGeo = new THREE.ConeGeometry(0.35, 1.1, 6);

    function inRect(el: HTMLElement | null, x: number, y: number, pad = 8) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
    }

    function grenadeMesh(kind: string) {
      const g = new THREE.Group();
      const body = new THREE.MeshLambertMaterial({
        color: kind === 'blast' ? 0x5b6b3a : kind === 'fire' ? 0xd9480f : 0x9ca3af,
      });
      g.add(new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 10), body));
      g.add(new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.025, 6, 12), amber));
      return g;
    }

    const gPlateEl = $('gPlate');
    const gPickEl = $('gPick');
    const PICK_PITCH = 42;
    const pickItems: HTMLDivElement[] = [];
    if (gPickEl) {
      gPickEl.innerHTML = '';
      GREN_KINDS.forEach(() => {
        const el = document.createElement('div');
        el.className = 'gpick-item';
        gPickEl.appendChild(el);
        pickItems.push(el);
      });
    }

    function refreshGrenades() {
      const kind = GREN_KINDS[gSel];
      const n = (grenades as any)[kind];
      if (gPlateName) gPlateName.textContent = GREN[kind].name;
      const cap = carryCap();
      const aimKey = document.body.classList.contains('touch') ? 'AIM' : 'right click';
      if (gPlateCount) {
        gPlateCount.textContent = gArmed
          ? 'Armed · ' + aimKey + ' throws it'
          : n + ' left · ' + gTotal() + (cap === Infinity ? ' carried' : ' of ' + cap + ' carried');
      }
      if (gBtnName) gBtnName.textContent = GREN[kind].name;
      if (gBtnCount) gBtnCount.textContent = gArmed ? 'Armed' : String(n);
      gBtnEl?.classList.toggle('empty', n <= 0);
      gBtnEl?.classList.toggle('armed', gArmed);
      refreshPicker();
    }

    function pickSlot(bottomY: number, y: number) {
      const i = Math.floor((bottomY - y) / PICK_PITCH);
      return i < 0 ? null : Math.min(i, GREN_KINDS.length - 1);
    }

    function refreshPicker() {
      const open = !!gPress?.open;
      GREN_KINDS.forEach((k, i) => {
        const el = pickItems[i];
        if (!el) return;
        const n = (grenades as any)[k];
        el.textContent = GREN[k].name + ' · ' + n;
        el.classList.toggle('cur', i === gSel);
        el.classList.toggle('sel', open && gPress.pending === i);
        el.classList.toggle('empty', n <= 0);
      });
    }

    function openPicker() {
      const p = gPress;
      if (!p || !gPickEl) return;
      const anchor = document.body.classList.contains('touch') ? gBtnEl : gPlateEl;
      if (!anchor) return;
      const r = anchor.getBoundingClientRect();
      gPickEl.style.left = Math.max(8, r.left + r.width / 2 - 60) + 'px';
      gPickEl.style.bottom = window.innerHeight - r.top + 12 + 'px';
      p.bottomY = r.top - 12;
      p.open = true;
      p.pending = p.src === 'touch' ? pickSlot(p.bottomY, p.y) : null;
      gPickEl.classList.add('open');
      refreshPicker();
    }

    function updateGrenadePress(dt: number) {
      if (gPress?.kind !== 'hold' || gPress.open) return;
      gPress.t += dt;
      if (gPress.t >= GREN_HOLD) openPicker();
    }

    function grenadeSlide(id: number, y: number) {
      if (!gPress || gPress.src !== 'touch' || gPress.id !== id) return;
      gPress.y = y;
      if (gPress.open) {
        gPress.pending = pickSlot(gPress.bottomY, y);
        refreshPicker();
      }
    }

    function grenadeWheel(step: number) {
      if (!gPress?.open) return;
      const base = gPress.pending ?? gSel;
      gPress.pending = THREE.MathUtils.clamp(base + step, 0, GREN_KINDS.length - 1);
      refreshPicker();
    }

    function grenadeDown(src: string, id: any, y: number | null) {
      if (gPress || !running() || playerDown) return;
      if (gArmed) {
        disarmGrenade();
        gPress = { src, id, kind: 'cancel' };
        showMessage('Grenade cancelled', 1.2);
        return;
      }
      gPress = { src, id, kind: 'hold', t: 0, open: false, pending: null, y: y ?? 0, bottomY: 0 };
    }

    function grenadeUp(src: string, id: any) {
      if (!gPress || gPress.src !== src || gPress.id !== id) return;
      const p = gPress;
      gPress = null;
      if (p.kind === 'cancel') return;
      if (p.open) {
        gPickEl?.classList.remove('open');
        if (p.pending !== null && p.pending !== gSel) {
          gSel = p.pending;
          showMessage(GREN[GREN_KINDS[gSel]].name + ' grenade picked', 1.2);
        }
        refreshGrenades();
        return;
      }
      armGrenade();
    }

    function cancelGrenadePress() {
      if (!gPress) return;
      gPress = null;
      gPickEl?.classList.remove('open');
      refreshPicker();
    }

    function armGrenade() {
      if (!running() || playerDown || gArmed) return;
      const kind = GREN_KINDS[gSel];
      if ((grenades as any)[kind] <= 0) {
        showMessage('No ' + GREN[kind].name + ' grenades', 1.2);
        return;
      }
      if (gCool > 0) {
        showMessage('Grenade ready in ' + gCool.toFixed(1) + ' s', 1);
        return;
      }
      gArmed = true;
      armedKind = kind;
      showHeld(kind);
      showMessage(document.body.classList.contains('touch') ? 'Armed: tap AIM to throw' : 'Armed: right click throws it', 2);
      refreshGrenades();
    }

    function disarmGrenade() {
      if (!gArmed) return;
      gArmed = false;
      hideHeld();
      refreshGrenades();
    }

    function throwArmedGrenade() {
      if (!gArmed || !running() || playerDown || !armedKind) return;
      const kind = armedKind;
      disarmGrenade();
      (grenades as any)[kind] -= 1;
      gCool = GREN_COOL;
      applyView();
      const dir = camera.getWorldDirection(new THREE.Vector3());
      const mesh = grenadeMesh(kind);
      const p = {
        kind,
        mesh,
        bounces: 0,
        fuse: GREN[kind].fuse,
        x: camera.position.x + dir.x * 0.5,
        y: camera.position.y - 0.25,
        z: camera.position.z + dir.z * 0.5,
        vx: dir.x * GREN_THROW,
        vy: dir.y * GREN_THROW + 3,
        vz: dir.z * GREN_THROW,
      };
      mesh.position.set(p.x, p.y, p.z);
      scene.add(mesh);
      projectiles.push(p);
      refreshGrenades();
    }

    function showHeld(kind: string) {
      hideHeld();
      heldMesh = grenadeMesh(kind);
      heldMesh.scale.setScalar(0.2);
      heldMesh.position.set(-0.07, -0.12, -0.5);
      heldMesh.traverse((o) => o.layers.set(1));
      camera.add(heldMesh);
    }

    function hideHeld() {
      if (!heldMesh) return;
      camera.remove(heldMesh);
      heldMesh.traverse((o: any) => {
        o.geometry?.dispose?.();
        if (o.material && o.material !== amber) o.material.dispose?.();
      });
      heldMesh = null;
    }

    const linearShare = (radius: number) => (d: number) => 1 - d / radius;

    function explode(
      x: number,
      z: number,
      radius: number,
      dmg: number,
      selfDmg: number,
      share: (d: number) => number = linearShare(radius),
      selfShare: (d: number) => number = share,
      y?: number
    ) {
      const by = y ?? groundAt(x, z) + 0.5;
      const blastOrigin = { x, y: by, z };
      // Cover first: decide who the blast reaches BEFORE chewing structures,
      // so an intact wall eats the damage of the grenade that breaks it
      const hits: Array<[DummyObject, number]> = [];
      const wallHits: Array<[SolidBox, number]> = [];
      for (const d of dummies) {
        const dist = Math.hypot(d.group.position.x - x, d.group.position.z - z);
        if (dist >= radius) continue;
        const ty = groundAt(d.group.position.x, d.group.position.z) + 1.25;
        const cover = isCoverBlocked(blastOrigin, { x: d.group.position.x, y: ty, z: d.group.position.z }, solids);
        if (cover.blocked && cover.blockingBox) {
          // Wall detected between grenade and dummy! Dummy is protected behind cover
          wallHits.push([cover.blockingBox as SolidBox, calculateStructureDamage('blast', dmg * share(dist))]);
          continue;
        }
        hits.push([d, dmg * share(dist)]);
      }
      const pd = Math.hypot(camera.position.x - x, camera.position.z - z);
      let selfHit = false;
      let playerCoverBox: SolidBox | null = null;
      let playerCoverDmg = 0;
      if (pd < radius) {
        const cover = isCoverBlocked(
          blastOrigin,
          { x: camera.position.x, y: camera.position.y - 0.4, z: camera.position.z },
          solids
        );
        if (cover.blocked && cover.blockingBox) {
          // GRENADE DETECTED A WALL! Player is safely taking cover behind the wall!
          playerCoverBox = cover.blockingBox as SolidBox;
          playerCoverDmg = calculateStructureDamage('blast', selfDmg * selfShare(pd));
        } else {
          selfHit = true;
        }
      }
      // Structures eat what is left: chew voxel chunks near the centre
      carveBlast(x, by, z, radius, dmg);
      // Demolition: player-built walls inside the blast radius take structural damage
      for (const dest of Array.from(wallDests.values())) {
        const dDist = Math.hypot(dest.bounds.x - x, dest.bounds.z - z);
        if (dDist < radius) {
          damageWall(dest, calculateStructureDamage('blast', dmg * share(dDist)), undefined, blastOrigin);
        }
      }
      // Blocking walls soak the blast for whoever hid behind them
      for (const [box, amount] of wallHits) damageStructureSolid(box, amount, blastOrigin);
      // The scanner is a soft target: blasts knock the antenna offline fast
      if (antenna) {
        const aDist = Math.hypot(antenna.group.position.x - x, antenna.group.position.z - z);
        if (aDist < radius) {
          damageAntenna(
            dmg * share(aDist),
            antenna.group.position.clone().setY(antenna.group.position.y + 1.6)
          );
        }
      }
      if (playerCoverBox) {
        damageStructureSolid(playerCoverBox, playerCoverDmg, blastOrigin);
        playSfx('cover_block');
        showMessage('🛡️ Cover blocked grenade blast! Protected behind wall!', 2.4);
        if (shieldFx) {
          shieldFx.style.background = 'rgba(56, 189, 248, 0.35)';
          shieldFx.style.opacity = '1';
          setTimeout(() => {
            if (shieldFx) {
              shieldFx.style.opacity = '';
              shieldFx.style.background = '';
            }
          }, 220);
        }
      }
      for (const [d, amount] of hits) hitDummy(d, amount);
      if (selfHit) hurtPlayer(selfDmg * selfShare(pd));
      const ring = new THREE.Mesh(
        shockGeo,
        new THREE.MeshBasicMaterial({ color: 0xffb020, transparent: true, opacity: 0.6, depthWrite: false })
      );
      ring.position.set(x, groundAt(x, z) + 0.6, z);
      scene.add(ring);
      effects.push({ kind: 'shock', mesh: ring, t: 0, life: 0.35, radius });
      const flash = new THREE.Mesh(
        voxFlashGeo,
        new THREE.MeshBasicMaterial({
          color: 0xffb050,
          transparent: true,
          opacity: 0.9,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        })
      );
      flash.position.set(x, by + 0.35, z);
      scene.add(flash);
      effects.push({ kind: 'flash', mesh: flash, t: 0, life: 0.22, radius: radius * 0.32 });
    }

    function blast(x: number, z: number, y: number) {
      const G = GREN.blast;
      explode(x, z, G.radius, G.dmg, G.selfDmg, blastShare, () => 1, y - 0.15);
    }

    function fireZone(x: number, z: number) {
      const G = GREN.fire;
      const g = new THREE.Group();
      const geo = new THREE.CircleGeometry(G.radius, 24);
      const disc = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xff7a18, transparent: true, opacity: 0.5, depthWrite: false }));
      disc.rotation.x = -Math.PI / 2;
      disc.position.y = 0.05;
      g.add(disc);
      const flames: THREE.Mesh[] = [];
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2;
        const f = new THREE.Mesh(flameGeo, new THREE.MeshBasicMaterial({ color: i % 2 ? 0xffb020 : 0xff4d00 }));
        f.position.set(Math.cos(a) * G.radius * 0.5, 0.55, Math.sin(a) * G.radius * 0.5);
        g.add(f);
        flames.push(f);
      }
      g.position.set(x, groundAt(x, z), z);
      scene.add(g);
      effects.push({ kind: 'fire', group: g, disc, geo, flames, t: 0, life: G.life, x, z });
    }

    function smokeCloud(x: number, z: number) {
      const G = GREN.smoke;
      const g = new THREE.Group();
      const puffs: THREE.Mesh[] = [];
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const reach = i === 0 ? 0 : G.radius * 0.55;
        const m = new THREE.Mesh(puffGeo, new THREE.MeshBasicMaterial({ color: 0xd4d8de, transparent: true, opacity: 0.85, depthWrite: false }));
        m.position.set(Math.cos(a) * reach, 1.4 + (i % 3) * 0.5, Math.sin(a) * reach);
        m.scale.setScalar(G.radius * 0.5 + (i % 2) * 0.6);
        g.add(m);
        puffs.push(m);
      }
      g.position.set(x, groundAt(x, z), z);
      scene.add(g);
      effects.push({ kind: 'smoke', group: g, puffs, t: 0, life: G.life, x, z, r: G.radius });
    }

    function smokeDist(o: THREE.Vector3, dir: THREE.Vector3, maxDist: number) {
      let best = Infinity;
      for (const e of effects) {
        if (e.kind !== 'smoke') continue;
        const ox = o.x - e.x;
        const oy = o.y - groundAt(e.x, e.z) - SMOKE_Y;
        const oz = o.z - e.z;
        const c = ox * ox + oy * oy + oz * oz - e.r * e.r;
        if (c < 0) continue;
        const b = ox * dir.x + oy * dir.y + oz * dir.z;
        const disc = b * b - c;
        if (disc < 0) continue;
        const t = -b - Math.sqrt(disc);
        if (t > 0 && t < maxDist && t < best) best = t;
      }
      return best;
    }

    function removeEffect(e: any) {
      const obj = e.group ?? e.mesh;
      scene.remove(obj);
      obj.traverse((o: any) => o.material?.dispose?.());
      e.geo?.dispose();
    }

    function updateGrenades(dt: number) {
      gCool = Math.max(0, gCool - dt);
      updateBombardment(dt);
      for (let i = projectiles.length - 1; i >= 0; i--) {
        const p = projectiles[i];
        const px = p.x;
        const pz = p.z;
        p.vy -= GREN_GRAVITY * dt;
        p.x += p.vx * dt;
        p.z += p.vz * dt;
        p.y += p.vy * dt;
        for (const b of solids) {
          if (p.y < b.top && p.y > (b.bottom ?? 0) && Math.abs(p.x - b.x) < b.hx && Math.abs(p.z - b.z) < b.hz) {
            p.x = px;
            p.z = pz;
            p.vx *= -0.3;
            p.vz *= -0.3;
            break;
          }
        }
        if (p.y < WATER_Y && groundAt(p.x, p.z) < WATER_Y) {
          const k = Math.exp(-8 * dt);
          p.vx *= k;
          p.vy *= k;
          p.vz *= k;
        }
        const gy = groundAt(p.x, p.z);
        if (p.y < gy + 0.12) {
          p.y = gy + 0.12;
          if (p.vy < -2.5 && p.bounces < 2) {
            p.vy = -p.vy * 0.4;
            p.vx *= 0.6;
            p.vz *= 0.6;
            p.bounces += 1;
          } else {
            p.vy = 0;
            const k = Math.exp(-6 * dt);
            p.vx *= k;
            p.vz *= k;
          }
          if (p.kind !== 'blast') p.fuse = Math.min(p.fuse, 0.3);
        }
        p.mesh.position.set(p.x, p.y, p.z);
        p.mesh.rotation.x += dt * 9;
        p.fuse -= dt;
        if (p.fuse <= 0) {
          if (p.kind === 'blast') blast(p.x, p.z, p.y);
          else if (p.kind === 'fire') fireZone(p.x, p.z);
          else smokeCloud(p.x, p.z);
          scene.remove(p.mesh);
          p.mesh.traverse((o: any) => {
            o.geometry?.dispose?.();
            o.material?.dispose?.();
          });
          projectiles.splice(i, 1);
        }
      }

      updateDebris(dt);
      updateDestructibles(dt);

      for (let i = effects.length - 1; i >= 0; i--) {
        const e = effects[i];
        e.t += dt;
        if (e.kind === 'shock') {
          const k = e.t / e.life;
          e.mesh.scale.setScalar(0.5 + k * e.radius);
          e.mesh.material.opacity = 0.6 * (1 - k);
        } else if (e.kind === 'mark') {
          e.mesh.material.opacity = (0.5 + 0.5 * Math.abs(Math.sin(e.t * 6))) * Math.min(1, (e.life - e.t) / 0.5);
        } else if (e.kind === 'shell') {
          e.mesh.position.y = groundAt(e.x, e.z) + 25 * (1 - Math.min(1, e.t / e.life) ** 2);
          if (e.t >= e.life) explode(e.x, e.z, BOMB.blastR, BOMB.dmg, BOMB.selfDmg);
        } else if (e.kind === 'fire') {
          e.flames.forEach((f: THREE.Mesh, j: number) => {
            f.scale.y = 0.8 + 0.4 * Math.sin(e.t * 12 + j * 1.7);
          });
          e.disc.material.opacity = (0.4 + 0.15 * Math.sin(e.t * 9)) * Math.min(1, (e.life - e.t) / 0.6);
          for (const d of dummies) {
            const dd = Math.hypot(d.group.position.x - e.x, d.group.position.z - e.z);
            const burning =
              dd < GREN.fire.radius &&
              fireClear(
                e.x,
                e.z,
                dd,
                GREN.fire.radius * 0.45,
                d.group.position.x,
                groundAt(d.group.position.x, d.group.position.z) + 1.25,
                d.group.position.z
              );
            if (burning) {
              burnDummy(d, GREN.fire.dps * dt, GREN.fire.pen * dt);
            }
          }
          const pdd = Math.hypot(camera.position.x - e.x, camera.position.z - e.z);
          if (
            pdd < GREN.fire.radius &&
            fireClear(e.x, e.z, pdd, GREN.fire.radius * 0.45, camera.position.x, camera.position.y - 0.4, camera.position.z)
          ) {
            hurtPlayer(GREN.fire.dps * dt, GREN.fire.pen * dt);
          }
        } else if (e.kind === 'flash') {
          const k = e.t / e.life;
          e.mesh.scale.setScalar(0.3 + k * e.radius * 2.4);
          e.mesh.material.opacity = 0.9 * (1 - k);
        } else {
          const fade = Math.min(1, (e.life - e.t) / 1.5);
          for (const m of e.puffs) m.material.opacity = 0.85 * fade;
        }
        if (e.t >= e.life) {
          removeEffect(e);
          effects.splice(i, 1);
        }
      }

      let inSmoke = 0;
      for (const e of effects) {
        if (e.kind !== 'smoke') continue;
        const dd = Math.hypot(camera.position.x - e.x, camera.position.z - e.z);
        if (dd < e.r) inSmoke = Math.max(inSmoke, Math.min(1, (e.r - dd) / 1.5) * Math.min(1, (e.life - e.t) / 1.5));
      }
      if (smokeFxEl) smokeFxEl.style.opacity = (inSmoke * 0.7).toFixed(2);
    }

    // ----------------------------------------------------
    // Inventory and Shop
    // ----------------------------------------------------
    const inventoryBtnEl = $('inventoryBtn');
    const inventoryCloseEl = $('inventoryClose');
    const inventoryCreditsEl = $('inventoryCredits');
    const inventoryWeaponsEl = $('inventoryWeapons');
    const inventoryAmmoEl = $('inventoryAmmo');
    let credits = 300;
    const INVENTORY_PRICE: Record<string, number> = {
      smg: 120,
      sniper: 260,
      betgun: 220,
      sk: 90,
      heavy: 40,
      light: 30,
      blast: 60,
      fire: 60,
      smoke: 50,
    };
    const INVENTORY_AMMO: Record<string, number> = { heavy: 30, light: 40 };
    const INVENTORY_NAME: Record<string, string> = {
      smg: 'Sharkteeth',
      sniper: 'Sniper',
      betgun: 'Betgun',
      sk: 'SK',
      heavy: 'Heavy ammo',
      light: 'Light ammo',
      blast: 'Blast grenade',
      fire: 'Fire grenade',
      smoke: 'Smoke grenade',
    };
    const inventoryItems = new Map<string, HTMLButtonElement>();
    const inventoryRows: Array<{ box: HTMLElement; read: () => any }> = [];

    function addInventoryItem(box: HTMLElement | null, id: string) {
      if (!box) return;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'inventory-item';
      b.innerHTML = '<b></b><span></span>';
      b.addEventListener('click', () => inventoryBuy(id));
      box.appendChild(b);
      inventoryItems.set(id, b);
    }

    function addSetting(box: HTMLElement | null, options: Array<{ v: any; label: string }>, read: () => any, write: (v: any) => void) {
      if (!box) return;
      for (const o of options) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'seg-btn';
        b.textContent = o.label;
        b.dataset.v = String(o.v);
        b.addEventListener('click', () => {
          write(o.v);
          refreshInventory();
        });
        box.appendChild(b);
      }
      inventoryRows.push({ box, read });
    }

    function inventorySetItem(id: string, note: string, disabled: boolean) {
      const b = inventoryItems.get(id);
      if (!b) return;
      (b.children[0] as HTMLElement).textContent = INVENTORY_NAME[id] + ' · ' + INVENTORY_PRICE[id] + ' cr';
      (b.children[1] as HTMLElement).textContent = note;
      b.disabled = disabled;
    }

    function refreshInventory() {
      if (inventoryCreditsEl) inventoryCreditsEl.textContent = String(credits);
      const free = slots.indexOf(null) >= 0;
      for (const id of ['smg', 'sniper', 'betgun', 'sk']) {
        const carried = owned(WEAPONS[id]);
        const note = carried ? 'Carried' : !free ? 'Both slots full' : 'Buy';
        inventorySetItem(id, note, !free || carried || credits < INVENTORY_PRICE[id]);
      }
      for (const id of ['heavy', 'light']) {
        inventorySetItem(id, 'Adds ' + INVENTORY_AMMO[id] + ' rounds', credits < INVENTORY_PRICE[id]);
      }
      for (const id of ['blast', 'fire', 'smoke']) {
        const cap = carryCap();
        const full = gTotal() >= cap;
        const note = full ? cap + ' carried, full' : (grenades as any)[id] + ' carried';
        inventorySetItem(id, note, full || credits < INVENTORY_PRICE[id]);
      }
      for (const r of inventoryRows) {
        for (const b of Array.from(r.box.children) as HTMLButtonElement[]) {
          b.setAttribute('aria-pressed', String(b.dataset.v === String(r.read())));
        }
      }
    }

    function inventoryBuy(id: string) {
      const price = INVENTORY_PRICE[id];
      if (playerDown || credits < price) return;
      if (id in WEAPONS) {
        const w = WEAPONS[id];
        if (owned(w) || slots.indexOf(null) < 0) return;
        credits -= price;
        reserve[w.ammo] = (reserve[w.ammo] || 0) + (AMMO_BONUS[id] || 0);
        addWeapon(w, lastSlot);
      } else if (id in GREN) {
        if (gTotal() >= carryCap()) return;
        credits -= price;
        (grenades as any)[id] += 1;
        refreshGrenades();
      } else {
        credits -= price;
        reserve[id] = (reserve[id] || 0) + INVENTORY_AMMO[id];
        showMessage('+' + INVENTORY_AMMO[id] + ' ' + id + ' ammo', 1.5);
      }
      if (creditsEl) creditsEl.textContent = String(credits);
      refreshHud();
      refreshInventory();
    }

    function setDummyShield(v: number) {
      dummyShield = v;
      for (const d of dummies) {
        d.shieldMax = v;
        d.shield = v;
      }
    }

    function setShooting(on: boolean) {
      shootingOn = on;
      for (const d of dummies) {
        if (d.shooter) d.armed = on;
      }
    }

    function openInventory() {
      if (!running() || playerDown || !inventoryEl) return;
      inventoryEl.hidden = false;
      keys.clear();
      mouseHeld = aimMouse = false;
      releaseTouch();
      document.exitPointerLock?.();
      refreshInventory();
    }

    function closeInventory() {
      if (!inventoryEl) return;
      inventoryEl.hidden = true;
      canvas?.requestPointerLock?.()?.catch?.(() => {});
    }

    const inventoryReturnMenuEl = $('inventoryReturnMenu');
    function returnToMenu() {
      if (inventoryEl) inventoryEl.hidden = true;
      if (overlay) overlay.hidden = true;
      if (menuEl) menuEl.hidden = false;
      if (buildMode) toggleBuildWall(false);
      document.exitPointerLock?.();
      keys.clear();
      mouseHeld = aimMouse = false;
      releaseTouch();
    }

    inventoryCloseEl?.addEventListener('click', closeInventory);
    inventoryReturnMenuEl?.addEventListener('click', returnToMenu);
    inventoryBtnEl?.addEventListener('click', openInventory);

    // Fortnite Wall Build plates (desktop plate + touch button)
    let lastTouchBuildTap = 0;
    $('buildWallBtn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      getAudio();
      toggleBuildWall();
    });
    touchBuildBtnEl?.addEventListener('click', (e) => {
      e.stopPropagation();
      getAudio();
      // Double-tap while armed cycles the build piece; single tap toggles.
      const now = performance.now();
      if (buildMode && now - lastTouchBuildTap < 350) {
        cycleBuildPiece(1);
        lastTouchBuildTap = 0;
        return;
      }
      lastTouchBuildTap = now;
      toggleBuildWall();
    });
    updateBuildHud();

    if (inventoryWeaponsEl) inventoryWeaponsEl.innerHTML = '';
    if (inventoryAmmoEl) inventoryAmmoEl.innerHTML = '';
    ['smg', 'sniper', 'betgun', 'sk'].forEach((id) => addInventoryItem(inventoryWeaponsEl, id));
    ['heavy', 'light', 'blast', 'fire', 'smoke'].forEach((id) => addInventoryItem(inventoryAmmoEl, id));

    const segShieldEl = $('segShield');
    const segShootEl = $('segShoot');
    if (segShieldEl) segShieldEl.innerHTML = '';
    if (segShootEl) segShootEl.innerHTML = '';
    addSetting(
      segShieldEl,
      [0, 152, 304, 456].map((v) => ({ v, label: v ? String(v) : 'None' })),
      () => dummyShield,
      (v) => setDummyShield(v)
    );
    addSetting(
      segShootEl,
      [{ v: true, label: 'On' }, { v: false, label: 'Off' }],
      () => shootingOn,
      (v) => setShooting(v)
    );
    refreshInventory();
    refreshGrenades();

    // Grenade pickups scatter
    scatter('blast', 4 * FIELD);
    scatter('fire', 3 * FIELD);
    scatter('smoke', 3 * FIELD);

    // ----------------------------------------------------
    // Characters & Bombardment
    // ----------------------------------------------------
    const primaryNameEl = $('primaryName');
    const BOMB = { range: 60, cool: 30, delay: 2.5, shells: 16, span: 3, spread: 14, blastR: 5.5, dmg: 200, selfDmg: 60 };
    let bombCool = 0;
    let bombardment: any = null;
    let bombArmed = false;

    function primaryAction() {
      if (character === 'antenna') {
        antennaAction();
        return;
      }
      if (character !== 'barrage') {
        turretAction();
        return;
      }
      if (bombArmed) {
        bombArmed = false;
        showMessage('Bombardment disarmed', 1.2);
        updateBombHud();
      } else {
        armBombardment();
      }
    }

    function armBombardment() {
      if (!running() || playerDown) return;
      if (bombardment) {
        showMessage('A bombardment is already on its way', 1.2);
        return;
      }
      if (bombCool > 0) {
        showMessage('Bombardment ready in ' + Math.ceil(bombCool) + ' s', 1.2);
        return;
      }
      bombArmed = true;
      showMessage(document.body.classList.contains('touch') ? 'Armed: tap AIM to call it in' : 'Armed: right click calls it in', 2);
      updateBombHud();
    }

    function aimPressed() {
      if (buildMode) {
        placeWall();
        return;
      }
      if (gArmed) {
        throwArmedGrenade();
        return;
      }
      if (bombArmed) {
        callBombardment();
        return;
      }
      if (!current) {
        toggleBuildWall(true);
        return;
      }
      if (fireMode === 'manual') {
        shoot();
        return;
      }
    }

    function applyCharacter() {
      if (primaryNameEl)
        primaryNameEl.textContent = character === 'barrage' ? 'Bombard' : character === 'antenna' ? 'Antenna' : 'Turret';
      bombArmed = false;
      disarmGrenade();
      turretEl?.classList.remove('armed');
      turretKey = '';
      antKey = '';
      if (character !== 'antenna') {
        removeAntenna(true);
        setMapOpen(false);
      }
      // Swapping characters in the menu refits vitals (Antenna: 100 life)
      life = lifeMax();
      shield = shieldMax();
      sinceHurt = 99;
      vitalsShown = '';
      refreshGrenades();
    }

    function carryCap() {
      return character === 'barrage' ? Infinity : GREN_MAX;
    }

    function bombTarget() {
      applyView();
      raycaster.setFromCamera(centre, camera);
      const o = raycaster.ray.origin;
      const d = raycaster.ray.direction;
      const dist = Math.min(BOMB.range, groundCut(raycaster.ray, BOMB.range), surfaceCut(raycaster.ray, BOMB.range));
      return {
        x: THREE.MathUtils.clamp(o.x + d.x * dist, -mapHalf, mapHalf),
        z: THREE.MathUtils.clamp(o.z + d.z * dist, -mapHalf, mapHalf),
      };
    }

    function callBombardment() {
      bombArmed = false;
      if (!running() || playerDown) return;
      if (bombardment) {
        showMessage('A bombardment is already on its way', 1.2);
        return;
      }
      if (bombCool > 0) {
        showMessage('Bombardment ready in ' + Math.ceil(bombCool) + ' s', 1.2);
        return;
      }
      const { x, z } = bombTarget();
      bombardment = { x, z, t: 0, fired: 0 };
      bombCool = BOMB.cool;
      const geo = new THREE.RingGeometry(BOMB.spread * 0.9, BOMB.spread, 48);
      const mark = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xff1f1f, transparent: true, opacity: 1, depthWrite: false }));
      mark.rotation.x = -Math.PI / 2;
      mark.position.set(x, groundAt(x, z) + 0.07, z);
      scene.add(mark);
      effects.push({ kind: 'mark', mesh: mark, geo, t: 0, life: BOMB.delay + BOMB.span + 0.7 });
      showMessage('Bombardment called in', 1.5);
      updateBombHud();
    }

    const shellBodyGeo = new THREE.CylinderGeometry(0.14, 0.14, 0.9, 8);
    const shellNoseGeo = new THREE.ConeGeometry(0.14, 0.3, 8);

    function shellMesh() {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(shellBodyGeo, new THREE.MeshLambertMaterial({ color: 0x6b7280 })));
      const nose = new THREE.Mesh(shellNoseGeo, new THREE.MeshLambertMaterial({ color: 0x1f2937 }));
      nose.position.y = -0.6;
      nose.rotation.x = Math.PI;
      g.add(nose);
      return g;
    }

    function updateBombardment(dt: number) {
      bombCool = Math.max(0, bombCool - dt);
      if (bombardment) {
        const B = bombardment;
        B.t += dt;
        const gap = BOMB.span / (BOMB.shells - 1);
        while (B.fired < BOMB.shells && B.t >= BOMB.delay + B.fired * gap) {
          const a = Math.random() * Math.PI * 2;
          const r = Math.random() * BOMB.spread;
          const x = B.x + Math.cos(a) * r;
          const z = B.z + Math.sin(a) * r;
          const mesh = shellMesh();
          mesh.position.set(x, 25, z);
          scene.add(mesh);
          effects.push({ kind: 'shell', mesh, x, z, t: 0, life: 0.7 });
          B.fired += 1;
        }
        if (B.fired >= BOMB.shells && !effects.some((e) => e.kind === 'shell' || e.kind === 'mark')) {
          bombardment = null;
        }
      }
      updateBombHud();
    }

    function updateBombHud() {
      const state = bombardment
        ? 'Incoming'
        : bombArmed
        ? 'Armed'
        : bombCool > 0
        ? 'Ready in ' + Math.ceil(bombCool) + ' s'
        : 'Ready';
      const key = 'bomb|' + state;
      if (key === turretKey) return;
      turretKey = key;
      if (turretLvEl) turretLvEl.textContent = '';
      if (turretStateEl) turretStateEl.textContent = state;
      turretEl?.classList.toggle('armed', bombArmed);
      turretEl?.classList.toggle('ready', !bombardment && !bombArmed && bombCool <= 0);
    }

    function releaseVolley() {
      const all: string[] = [];
      for (let round = 0; ; round++) {
        const row = GREN_KINDS.filter((k) => (grenades as any)[k] > round);
        if (!row.length) break;
        all.push(...row);
      }
      for (const k of GREN_KINDS) (grenades as any)[k] = 0;
      all.forEach((kind, i) => {
        const a = (i / all.length) * Math.PI * 2 + 0.3;
        const mesh = grenadeMesh(kind);
        const p = {
          kind,
          mesh,
          bounces: 0,
          fuse: 0.4 + 0.6 * (i / Math.max(1, all.length - 1)),
          x: camera.position.x,
          y: 1,
          z: camera.position.z,
          vx: Math.cos(a) * 6,
          vy: 3,
          vz: Math.sin(a) * 6,
        };
        mesh.position.set(p.x, p.y, p.z);
        scene.add(mesh);
        projectiles.push(p);
      });
      refreshGrenades();
    }

    // ----------------------------------------------------
    // Turret & Antenna screen-space trackers: a diamond mark
    // floats over the deployable, or pins to the nearest screen
    // edge with an arrow when it is out of view.
    // ----------------------------------------------------
    const trackerEl = $('tracker');
    const trackerDirEl = $('trackerDir');
    const trackerTagEl = $('trackerTag');
    const antTrackerEl = $('antTracker');
    const antTrackerDirEl = $('antTrackerDir');
    const antTrackerTagEl = $('antTrackerTag');
    const TRACK_INSET = 64;
    const trackTop = new THREE.Vector3();
    const trackV = new THREE.Vector3();
    const trackFwd = new THREE.Vector3();
    const trackRight = new THREE.Vector3();
    const trackUp = new THREE.Vector3();

    function trackMark(
      el: HTMLElement | null,
      dirEl: HTMLElement | null,
      tagEl: HTMLElement | null,
      p: THREE.Vector3,
      topOffset: number,
      text: (dist: number) => string
    ) {
      if (!el) return;
      el.hidden = false;
      trackTop.set(p.x, p.y + topOffset, p.z);
      const dist = trackTop.distanceTo(camera.position);
      trackFwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
      trackRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
      trackUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
      trackV.subVectors(trackTop, camera.position);
      const a = trackV.dot(trackRight);
      const b = trackV.dot(trackUp);
      const c = trackV.dot(trackFwd);
      const W = window.innerWidth;
      const H = window.innerHeight;
      const M = TRACK_INSET;
      let sx = 0;
      let sy = 0;
      let dx = 0;
      let dy = 0;
      let onScreen = false;

      if (c > 0.01) {
        const focal = H / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
        sx = W / 2 + (focal * a) / c;
        sy = H / 2 - (focal * b) / c;
        onScreen = sx >= M && sx <= W - M && sy >= M && sy <= H - M;
        dx = sx - W / 2;
        dy = sy - H / 2;
      } else {
        dx = a;
        dy = Math.max(-c, 1e-3);
      }

      if (onScreen) {
        el.dataset.state = 'on';
      } else {
        const L = Math.hypot(dx, dy) || 1;
        dx /= L;
        dy /= L;
        const tx = Math.abs(dx) > 1e-9 ? (W / 2 - M) / Math.abs(dx) : Infinity;
        const ty = Math.abs(dy) > 1e-9 ? (H / 2 - M) / Math.abs(dy) : Infinity;
        const t = Math.min(tx, ty);
        sx = W / 2 + dx * t;
        sy = H / 2 + dy * t;
        el.dataset.state = 'edge';
        if (dirEl) dirEl.style.transform = `rotate(${(Math.atan2(dy, dx) * 180) / Math.PI + 90}deg)`;
      }
      el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
      const txt = text(Math.round(dist));
      if (tagEl && tagEl.textContent !== txt) tagEl.textContent = txt;
    }

    function updateTracker() {
      if (!turret || turret.carried) {
        if (trackerEl) trackerEl.hidden = true;
        return;
      }
      trackMark(trackerEl, trackerDirEl, trackerTagEl, turret.group.position, 1.2, (d) => 'Turret ' + d + ' m');
    }

    function updateAntTracker() {
      if (!antenna) {
        if (antTrackerEl) antTrackerEl.hidden = true;
        return;
      }
      trackMark(antTrackerEl, antTrackerDirEl, antTrackerTagEl, antenna.group.position, 1.6, (d) =>
        'Antenna ' + d + ' m · ' + Math.max(0, Math.ceil(antenna.hp)) + ' HP'
      );
    }

    // ----------------------------------------------------
    // Antenna passive: round minimap + simplified tactical
    // map. Terrain is sampled once per map into an offscreen
    // canvas; the minimap crops a moving window around the
    // player, the overlay shows the whole island with
    // landmark labels. Enemy blips appear on both only
    // while the scanner mast is live.
    // ----------------------------------------------------
    const minimapEl = $('minimap');
    const minimapCvs = $('minimapCanvas') as HTMLCanvasElement | null;
    const minimapCtx = minimapCvs ? minimapCvs.getContext('2d') : null;
    const mapOverlayEl = $('mapOverlay');
    const mapCvs = $('mapCanvas') as HTMLCanvasElement | null;
    const mapCtx = mapCvs ? mapCvs.getContext('2d') : null;
    const mapStatusEl = $('mapStatus');
    const mapCloseEl = $('mapClose');
    let mapOpen = false;
    const MINIMAP_R = 130; // metres of half-view around the player
    const MAP_MARK_COLORS: Record<string, string> = {
      'c-pier': '#67e8f9',
      'c-yard': '#fbbf24',
      'c-crane': '#f97316',
      'c-whse': '#a3e635',
      'c-dock': '#38bdf8',
      'c-light': '#fde047',
      'c-vill': '#f472b6',
      'c-farm': '#84cc16',
      'c-fuel': '#ef4444',
      'c-site': '#fb923c',
      'c-camp': '#22d3ee',
      'c-mast': '#e879f9',
      'c-ruin': '#a8a29e',
      'c-outp': '#facc15',
      'c-tow': '#60a5fa',
    };
    const mapMarkColor = (cls: string) => MAP_MARK_COLORS[cls] || '#cbd5e1';
    const mapTerrain = typeof document !== 'undefined' ? document.createElement('canvas') : null;
    let mapTerrainKey = '';

    function ensureTerrainCanvas() {
      if (!mapTerrain) return;
      const key = (terrainOn ? 'H' : 'R') + '|' + terrainSeed;
      if (key === mapTerrainKey) return;
      mapTerrainKey = key;
      const N = 144;
      const half = mapHalf + 60;
      const S = 720;
      mapTerrain.width = S;
      mapTerrain.height = S;
      const c = mapTerrain.getContext('2d');
      if (!c) return;
      const cell = S / N;
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          const x = -half + ((i + 0.5) / N) * 2 * half;
          const z = -half + ((j + 0.5) / N) * 2 * half;
          const h = terrainOn ? terrainHeight(x, z) : groundAt(x, z);
          let col = '#618e54';
          if (h < WATER_Y) {
            const d = THREE.MathUtils.clamp((WATER_Y - h) / 6, 0, 1);
            col = 'rgb(' + Math.round(30 - 10 * d) + ',' + Math.round(84 - 30 * d) + ',' + Math.round(126 - 38 * d) + ')';
          } else if (h < BEACH_Y + 0.15) col = '#d3c493';
          else if (h < 14) col = '#618e54';
          else if (h < 32) col = '#7c9350';
          else if (h < 58) col = '#8b8471';
          else col = '#e8edf1';
          c.fillStyle = col;
          c.fillRect(i * cell, j * cell, cell + 1, cell + 1);
        }
      }
      // Transition routes over the sampled terrain: dust / mud / gravel
      // strokes — the minimap crop and the big tactical map both inherit
      // them, so navigating POI-to-POI reads at a glance.
      if (paths.length) {
        const toPx = (wx: number) => ((wx + half) / (2 * half)) * S;
        c.lineJoin = 'round';
        c.lineCap = 'round';
        c.globalAlpha = 0.85;
        for (const seg of paths) {
          c.strokeStyle = PATH_KIND_CSS[seg.kind];
          c.lineWidth = Math.max(1.4, (seg.w * S) / (2 * half));
          c.beginPath();
          for (let i = 0; i < seg.pts.length; i += 2) {
            const px = toPx(seg.pts[i]);
            const pz = toPx(seg.pts[i + 1]);
            if (i === 0) c.moveTo(px, pz);
            else c.lineTo(px, pz);
          }
          c.stroke();
        }
        c.globalAlpha = 1;
      }
    }

    function drawBlip(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = Math.max(1.2, r * 0.3);
      ctx.strokeStyle = 'rgba(8, 12, 18, 0.85)';
      ctx.stroke();
    }

    function drawDiamond(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = '#67e8f9';
      ctx.fillRect(-s, -s, s * 2, s * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(8, 12, 18, 0.85)';
      ctx.strokeRect(-s, -s, s * 2, s * 2);
      ctx.restore();
    }

    function drawPlayerArrow(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-yaw); // yaw 0 faces north (up); bearing = -yaw
      ctx.beginPath();
      ctx.moveTo(0, -s);
      ctx.lineTo(s * 0.62, s * 0.92);
      ctx.lineTo(0, s * 0.48);
      ctx.lineTo(-s * 0.62, s * 0.92);
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#0b0f15';
      ctx.stroke();
      ctx.restore();
    }

    function updateMinimapVisibility() {
      if (!minimapEl) return;
      const show = character === 'antenna' && running();
      if (minimapEl.hidden === show) minimapEl.hidden = !show;
    }

    function renderMinimap() {
      updateMinimapVisibility();
      if (!minimapEl || minimapEl.hidden || !minimapCtx || !minimapCvs || !mapTerrain) return;
      ensureTerrainCanvas();
      const ctx = minimapCtx;
      const S = minimapCvs.width;
      const R = S / 2;
      const p = camera.position;
      ctx.clearRect(0, 0, S, S);
      ctx.save();
      ctx.beginPath();
      ctx.arc(R, R, R - 3, 0, Math.PI * 2);
      ctx.clip();
      const half = mapHalf + 60;
      const worldPerPx = (2 * half) / mapTerrain.width;
      const crop = (MINIMAP_R * 2) / worldPerPx;
      const cx = (p.x + half) / worldPerPx;
      const cy = (p.z + half) / worldPerPx;
      ctx.drawImage(mapTerrain, cx - crop / 2, cy - crop / 2, crop, crop, 3, 3, S - 6, S - 6);
      const toX = (wx: number) => R + ((wx - p.x) / MINIMAP_R) * (R - 6);
      const toY = (wz: number) => R + ((wz - p.z) / MINIMAP_R) * (R - 6);
      for (const m of harborMarks) {
        if (Math.abs(m.x - p.x) > MINIMAP_R || Math.abs(m.z - p.z) > MINIMAP_R) continue;
        drawBlip(ctx, toX(m.x), toY(m.z), 4, mapMarkColor(m.cls));
      }
      if (antenna) {
        for (const d of dummies) {
          if (d.state !== 'up') continue;
          drawBlip(ctx, toX(d.group.position.x), toY(d.group.position.z), 6.5, '#ff5c6b');
        }
        drawDiamond(ctx, toX(antenna.group.position.x), toY(antenna.group.position.z), 5.5);
      }
      drawPlayerArrow(ctx, R, R, 12);
      ctx.restore();
      if (antenna) {
        // radar sweep while the scan is live
        const t = (antenna.t * 0.8) % 1;
        ctx.beginPath();
        ctx.arc(R, R, (R - 3) * t, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(103, 232, 249, ' + (0.5 * (1 - t)).toFixed(3) + ')';
        ctx.lineWidth = 3;
        ctx.stroke();
      }
    }

    function renderBigMap() {
      if (!mapCtx || !mapCvs || !mapTerrain) return;
      ensureTerrainCanvas();
      const ctx = mapCtx;
      const S = mapCvs.width;
      const half = mapHalf + 60;
      ctx.clearRect(0, 0, S, S);
      ctx.drawImage(mapTerrain, 0, 0, mapTerrain.width, mapTerrain.height, 0, 0, S, S);
      const toX = (wx: number) => ((wx + half) / (2 * half)) * S;
      const toY = (wz: number) => ((wz + half) / (2 * half)) * S;
      // survey grid
      ctx.strokeStyle = 'rgba(245, 247, 250, 0.08)';
      ctx.lineWidth = 1;
      for (let g = -500; g <= half; g += 500) {
        if (g < -half) continue;
        ctx.beginPath();
        ctx.moveTo(toX(g), 0);
        ctx.lineTo(toX(g), S);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, toY(g));
        ctx.lineTo(S, toY(g));
        ctx.stroke();
      }
      ctx.font = '600 13px Barlow, Arial, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
      ctx.shadowBlur = 4;
      let flip = 0;
      for (const m of harborMarks) {
        const x = toX(m.x);
        const y = toY(m.z);
        drawBlip(ctx, x, y, 4.5, mapMarkColor(m.cls));
        ctx.fillStyle = 'rgba(245, 247, 250, 0.95)';
        ctx.fillText(m.label, x + 8, y + (flip++ % 2 ? -11 : 12));
      }
      if (antenna) {
        for (const d of dummies) {
          if (d.state !== 'up') continue;
          drawBlip(ctx, toX(d.group.position.x), toY(d.group.position.z), 6.5, '#ff5c6b');
        }
        const ax = toX(antenna.group.position.x);
        const ay = toY(antenna.group.position.z);
        drawDiamond(ctx, ax, ay, 7);
        ctx.fillStyle = '#67e8f9';
        ctx.fillText('ANT', ax + 12, ay);
      }
      ctx.shadowBlur = 0;
      drawPlayerArrow(ctx, toX(camera.position.x), toY(camera.position.z), 14);
    }

    function setMapOpen(open: boolean) {
      if (mapOpen === open) return;
      mapOpen = open;
      if (mapOverlayEl) mapOverlayEl.hidden = !open;
    }

    function updateMapHud() {
      if (!mapStatusEl) return;
      const txt = antenna
        ? 'Scan ' + Math.ceil(antenna.left) + ' s · ' + Math.max(0, Math.ceil(antenna.hp)) + ' HP'
        : 'Scan offline · deploy with E';
      if (mapStatusEl.textContent !== txt) mapStatusEl.textContent = txt;
      mapStatusEl.classList.toggle('on', !!antenna);
    }

    function renderAntennaHud() {
      renderMinimap();
      if (mapOpen) {
        renderBigMap();
        updateMapHud();
      }
    }

    minimapEl?.addEventListener('click', () => {
      if (character === 'antenna' && running() && !mapOpen) setMapOpen(true);
    });
    mapCloseEl?.addEventListener('click', () => setMapOpen(false));
    mapOverlayEl?.addEventListener('click', (e) => {
      if (e.target === mapOverlayEl) setMapOpen(false);
    });

    // ----------------------------------------------------
    // Dummy Update & Basic AI
    // ----------------------------------------------------
    function updateDummy(d: DummyObject, dt: number) {
      poseFigure(d, dt);
      // Harbor patrols ride the streamed terrain mesh (range floor is flat)
      if (terrainOn) d.group.position.y = Math.max(groundAt(d.group.position.x, d.group.position.z), WATER_Y - 0.05);
      d.flash = Math.max(0, d.flash - dt);
      const glow = d.flash > 0 ? 0.8 : 0;
      for (const p of d.parts) (p.material as any).emissive?.setRGB(glow, 0, 0);

      d.quiet += dt;
      if (d.state === 'up' && d.quiet >= SHIELD_DELAY && d.shield < d.shieldMax) {
        d.shield = Math.min(d.shieldMax, d.shield + SHIELD_REGEN * d.shieldMax * dt);
      }
      const share = d.shieldMax > 0 ? d.shield / d.shieldMax : 0;
      if (d.bubble) {
        d.bubble.visible = d.state === 'up' && share > 0.01;
        (d.bubble.material as any).opacity = 0.3 * share + (d.flash > 0 ? 0.25 : 0);
      }

      if (d.state === 'falling') {
        d.group.rotation.x = Math.max(-Math.PI / 2, d.group.rotation.x - dt * 6);
        if (d.group.rotation.x <= -Math.PI / 2) {
          d.state = 'down';
          d.timer = 3;
        }
      } else if (d.state === 'down') {
        d.timer -= dt;
        if (d.timer <= 0) {
          d.state = 'up';
          d.hp = d.lifeMax;
          d.shield = d.shieldMax;
          d.quiet = 99;
          d.group.rotation.x = 0;
        }
      }
    }

    const ENEMY_RANGE = 40;
    const ENEMY_DELAY = 1.1;
    const ENEMY_DAMAGE = 12;
    const ENEMY_SPREAD = 0.03;
    const PLAYER_HIT = 0.4;
    const lineRay = new THREE.Raycaster();
    const shotFrom = new THREE.Vector3();
    const shotTo = new THREE.Vector3();
    const shotDir = new THREE.Vector3();

    function updateShooter(d: DummyObject, dt: number) {
      if (!d.shooter || !d.armed || d.state !== 'up' || playerDown) return;
      if (d.ai && d.ai.state === 'patrol') return;
      const px = camera.position.x - d.group.position.x;
      const pz = camera.position.z - d.group.position.z;
      if (!d.ai) d.group.rotation.y = Math.atan2(px, pz);
      d.fireT = Math.max(0, d.fireT - dt);
      const dist = Math.hypot(px, pz);

      // Deployed scanners are priority targets: a shooter closer to the
      // antenna than to the player opens fire on the mast instead
      if (antenna && d.fireT <= 0) {
        const ap = antenna.group.position;
        const aDist = Math.hypot(ap.x - d.group.position.x, ap.z - d.group.position.z);
        if (aDist < dist && aDist <= ENEMY_RANGE) {
          if (d.muzzle) d.muzzle.getWorldPosition(shotFrom);
          else shotFrom.copy(d.group.position).add(FIG.gun);
          shotTo.set(ap.x, ap.y + 1.5, ap.z);
          shotDir.subVectors(shotTo, shotFrom);
          const aLen = shotDir.length();
          lineRay.set(shotFrom, shotDir.normalize());
          lineRay.far = Math.max(0.5, aLen - 0.5); // stop short of the mast itself
          const aBlocked =
            lineRay.intersectObjects(shootable, false).some((h) => !h.object.userData.antenna) ||
            smokeDist(shotFrom, shotDir, aLen) < Infinity;
          lineRay.far = Infinity;
          if (!aBlocked) {
            d.fireT = (d.ai ? AI.delay : ENEMY_DELAY) + Math.random() * 0.3;
            d.shots += 1;
            tracer(shotFrom.clone(), shotTo, 0xff5c6b);
            damageAntenna(ANT_SHOT_DMG, shotTo);
            return;
          }
        }
      }

      if (d.muzzle) {
        d.muzzle.getWorldPosition(shotFrom);
      } else {
        shotFrom.copy(d.group.position).add(FIG.gun);
      }
      shotTo.set(camera.position.x, camera.position.y - 0.5, camera.position.z);
      shotDir.subVectors(shotTo, shotFrom);
      const len = shotDir.length();
      lineRay.set(shotFrom, shotDir.normalize());
      lineRay.far = len;
      const blocked =
        dist > ENEMY_RANGE ||
        lineRay.intersectObjects(shootable, false).length > 0 ||
        smokeDist(shotFrom, shotDir, len) < Infinity;
      if (blocked) {
        d.fireT = Math.max(d.fireT, 0.6);
        return;
      }
      if (d.fireT > 0) return;
      const wKind = d.weaponKind || 'sk';
      d.shots += 1;
      const err = (d.ai ? AI.spread : ENEMY_SPREAD) * dist;
      const ox = (Math.random() * 2 - 1) * err;
      const oy = (Math.random() * 2 - 1) * err;
      const aim = new THREE.Vector3(camera.position.x + ox, camera.position.y - 0.5 + oy, camera.position.z);

      if (wKind === 'smg') {
        d.fireT = (d.ai ? 0.16 : 0.12) + Math.random() * 0.08;
        tracer(shotFrom.clone(), aim, 0xfde68a);
        if (Math.hypot(ox, oy) < PLAYER_HIT * 1.2) {
          d.hits += 1;
          hurtPlayer(16);
        }
      } else if (wKind === 'sniper') {
        d.fireT = (d.ai ? 2.6 : 2.2) + Math.random() * 0.4;
        tracer(shotFrom.clone(), aim, 0x60a5fa);
        if (Math.hypot(ox, oy) < PLAYER_HIT * 0.9) {
          d.hits += 1;
          hurtPlayer(70);
        }
      } else if (wKind === 'betgun') {
        d.fireT = (d.ai ? 1.5 : 1.3) + Math.random() * 0.3;
        let hits = 0;
        for (let p = 0; p < 5; p++) {
          const pox = ox + (Math.random() * 2 - 1) * 0.9;
          const poy = oy + (Math.random() * 2 - 1) * 0.9;
          const pAim = new THREE.Vector3(camera.position.x + pox, camera.position.y - 0.5 + poy, camera.position.z);
          tracer(shotFrom.clone(), pAim, 0xf97316);
          if (Math.hypot(pox, poy) < PLAYER_HIT * 1.5) hits++;
        }
        if (hits > 0) {
          d.hits += 1;
          hurtPlayer(14 * hits);
        }
      } else {
        d.fireT = (d.ai ? AI.delay : ENEMY_DELAY) + Math.random() * 0.3;
        tracer(shotFrom.clone(), aim, 0xff5c6b);
        if (Math.hypot(ox, oy) < PLAYER_HIT) {
          d.hits += 1;
          hurtPlayer(ENEMY_DAMAGE);
        }
      }
    }

    const AI_DUMMIES = 3;
    const AI = {
      walk: 1.6,
      strafe: 2.2,
      run: 3.4,
      view: 100,
      close: 6,
      reaction: 0.8,
      lost: 4,
      coverAt: 0.6,
      hide: 3.5,
      coverRest: 4,
      band: [12, 24],
      delay: 1.4,
      spread: 0.04,
      startZone: 50,
    };
    const AI_TURNS = [0, 0.5, -0.5, 1, -1, 1.6, -1.6];
    const aiFrom = new THREE.Vector3();
    const aiTo = new THREE.Vector3();
    const aiDir = new THREE.Vector3();

    function aiState(x: number, z: number) {
      return {
        home: { x, z },
        state: 'patrol',
        target: null as any,
        search: null as any,
        idle: 0.5,
        travelT: 0,
        blockedT: 0,
        seen: 0,
        lost: 0,
        sees: false,
        lookT: 0,
        hideT: 0,
        coverCool: 0,
        strafeDir: 1,
        strafeT: 0,
        lastSeen: null as any,
        hpSeen: DUMMY_LIFE,
        shieldSeen: dummyShield,
        hot: false,
      };
    }

    function aiFree(x: number, z: number, self: DummyObject | null) {
      if (Math.abs(x) > mapHalf - 4 || Math.abs(z) > mapHalf - 4) return false;
      if (nearPool(x, z, 2)) return false;
      // Harbor patrols stay ashore: wading into the sea is off-limits
      if (terrainOn && terrainHeight(x, z) < WATER_Y + 0.25) return false;
      for (const b of solids) {
        if ((b.bottom ?? 0) > 1.9) continue;
        if (Math.abs(x - b.x) < b.hx + 0.6 && Math.abs(z - b.z) < b.hz + 0.6) return false;
      }
      for (const o of dummies) {
        if (o !== self && Math.hypot(o.group.position.x - x, o.group.position.z - z) < 1.3) return false;
      }
      return true;
    }

    function aiPathClear(d: DummyObject, x1: number, z1: number) {
      const p = d.group.position;
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - p.x, z1 - p.z) / 0.5));
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        if (!aiFree(p.x + (x1 - p.x) * t, p.z + (z1 - p.z) * t, d)) return false;
      }
      return true;
    }

    function aiStep(d: DummyObject, tx: number, tz: number, speed: number, dt: number) {
      const p = d.group.position;
      const dx = tx - p.x;
      const dz = tz - p.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.2) return 'arrived';
      const step = Math.min(dist, speed * dt);
      const way = Math.atan2(dx, dz);
      for (const turn of AI_TURNS) {
        const a = way + turn;
        const nx = p.x + Math.sin(a) * step;
        const nz = p.z + Math.cos(a) * step;
        if (aiFree(nx, nz, d)) {
          p.x = nx;
          p.z = nz;
          d.group.rotation.y = a;
          return 'moving';
        }
      }
      return 'blocked';
    }

    function aiPickPoint(d: DummyObject) {
      const h = d.ai.home;
      for (let t = 0; t < 30; t++) {
        const a = Math.random() * Math.PI * 2;
        const r = 4 + Math.random() * 16;
        const x = h.x + Math.cos(a) * r;
        const z = h.z + Math.sin(a) * r;
        if (Math.hypot(x, z) >= AI.startZone && aiFree(x, z, d)) return { x, z };
      }
      return null;
    }

    function aiSees(d: DummyObject) {
      if (playerDown) return false;
      const p = d.group.position;
      const px = camera.position.x - p.x;
      const pz = camera.position.z - p.z;
      const dist = Math.hypot(px, pz);
      if (dist > ENEMY_RANGE) return false;
      if (dist > AI.close) {
        let off = Math.abs(Math.atan2(px, pz) - d.group.rotation.y) % (Math.PI * 2);
        if (off > Math.PI) off = Math.PI * 2 - off;
        if (off > ((AI.view / 2) * Math.PI) / 180) return false;
      }
      const yawRot = d.group.rotation.y;
      aiFrom.set(p.x + Math.sin(yawRot) * 0.6, 1.6, p.z + Math.cos(yawRot) * 0.6);
      aiTo.set(camera.position.x, camera.position.y - 0.3, camera.position.z);
      aiDir.subVectors(aiTo, aiFrom);
      const len = aiDir.length();
      aiDir.normalize();
      lineRay.set(aiFrom, aiDir);
      lineRay.far = len;
      if (lineRay.intersectObjects(shootable, false).some((h) => h.object.userData.dummy !== d)) return false;
      return smokeDist(aiFrom, aiDir, len) === Infinity;
    }

    function aiCover(d: DummyObject) {
      const p = d.group.position;
      let best: { x: number; z: number } | null = null;
      let bestD = Infinity;
      for (const b of solids) {
        if (b.top < 1.8 || (b.bottom ?? 0) > 0.5) continue;
        if (Math.hypot(b.x - p.x, b.z - p.z) > 16) continue;
        let ux = b.x - camera.position.x;
        let uz = b.z - camera.position.z;
        const l = Math.hypot(ux, uz);
        if (l < 1e-3) continue;
        ux /= l;
        uz /= l;
        const reach = Math.abs(ux) * b.hx + Math.abs(uz) * b.hz + 1;
        const x = b.x + ux * reach;
        const z = b.z + uz * reach;
        const cd = Math.hypot(x - p.x, z - p.z);
        if (cd < bestD && aiFree(x, z, d) && aiPathClear(d, x, z)) {
          best = { x, z };
          bestD = cd;
        }
      }
      return best;
    }

    function aiRetreat(d: DummyObject) {
      const p = d.group.position;
      const base = Math.atan2(p.x - camera.position.x, p.z - camera.position.z);
      for (const turn of [0, 0.5, -0.5, 1, -1]) {
        const a = base + turn;
        const x = p.x + Math.sin(a) * 8;
        const z = p.z + Math.cos(a) * 8;
        if (aiFree(x, z, d) && aiPathClear(d, x, z)) return { x, z };
      }
      return null;
    }

    function aiWander(d: DummyObject, dt: number) {
      const a = d.ai;
      if (a.idle > 0) {
        a.idle -= dt;
        return;
      }
      if (!a.target) {
        a.target = a.search && aiFree(a.search.x, a.search.z, d) ? a.search : aiPickPoint(d);
        a.search = null;
        a.travelT = 25;
        if (!a.target) {
          a.idle = 1;
          return;
        }
      }
      a.travelT -= dt;
      const r = aiStep(d, a.target.x, a.target.z, AI.walk, dt);
      if (r === 'arrived' || a.travelT <= 0) {
        a.target = null;
        a.idle = 1.5 + Math.random() * 2;
        a.blockedT = 0;
      } else if (r === 'blocked') {
        a.blockedT += dt;
        if (a.blockedT > 0.6) {
          a.target = null;
          a.idle = 0.5;
          a.blockedT = 0;
        }
      } else {
        a.blockedT = 0;
      }
    }

    function aiEngage(d: DummyObject, dt: number) {
      const a = d.ai;
      const p = d.group.position;
      const dx = camera.position.x - p.x;
      const dz = camera.position.z - p.z;
      const dist = Math.hypot(dx, dz) || 1e-3;
      const fx = dx / dist;
      const fz = dz / dist;
      const sx = -fz * a.strafeDir;
      const sz = fx * a.strafeDir;
      a.strafeT -= dt;
      if (a.strafeT <= 0) {
        if (Math.random() < 0.5) a.strafeDir = -a.strafeDir;
        a.strafeT = 1.5 + Math.random() * 1.5;
      }
      let mx = sx;
      let mz = sz;
      if (dist > AI.band[1]) {
        mx = fx * 0.9 + sx * 0.5;
        mz = fz * 0.9 + sz * 0.5;
      } else if (dist < AI.band[0]) {
        mx = -fx * 0.9 + sx * 0.5;
        mz = -fz * 0.9 + sz * 0.5;
      }
      if (aiStep(d, p.x + mx * 4, p.z + mz * 4, AI.strafe, dt) === 'blocked') {
        a.strafeDir = -a.strafeDir;
        a.strafeT = 1;
      }
      d.group.rotation.y = Math.atan2(dx, dz);
    }

    function engageNow(d: DummyObject) {
      d.ai.state = 'engage';
      d.ai.lost = 0;
      d.ai.seen = 0;
      d.fireT = Math.max(d.fireT, 0.6);
    }

    function setBody(d: DummyObject, hot: boolean) {
      if (d.ai.hot === hot || !d.bodyMat) return;
      d.ai.hot = hot;
      d.bodyMat.color.setHex(hot ? 0xf43f5e : 0x14b8a6);
    }

    function updateAI(d: DummyObject, dt: number) {
      const a = d.ai;
      if (!a) return;
      if (d.state !== 'up') {
        Object.assign(a, {
          state: 'patrol',
          target: null,
          search: null,
          seen: 0,
          lost: 0,
          hideT: 0,
          idle: 0.5,
          blockedT: 0,
          sees: false,
        });
        a.hpSeen = d.hp;
        a.shieldSeen = d.shield;
        setBody(d, false);
        return;
      }
      if (d.hp < a.hpSeen - 1e-6 || d.shield < a.shieldSeen - 1e-6) {
        if (!playerDown) a.lastSeen = { x: camera.position.x, z: camera.position.z };
        if (a.state === 'patrol') engageNow(d);
      }
      a.hpSeen = d.hp;
      a.shieldSeen = d.shield;
      a.coverCool = Math.max(0, a.coverCool - dt);

      a.lookT -= dt;
      if (a.lookT <= 0) {
        a.lookT = 0.25;
        a.sees = aiSees(d);
        if (a.sees) a.lastSeen = { x: camera.position.x, z: camera.position.z };
      }
      const p = d.group.position;
      const ang = Math.atan2(camera.position.x - p.x, camera.position.z - p.z);

      if (a.state === 'patrol') {
        a.seen = a.sees ? a.seen + dt : Math.max(0, a.seen - dt);
        if (a.seen >= AI.reaction) engageNow(d);
        else if (a.sees) d.group.rotation.y = ang;
        else aiWander(d, dt);
      }
      if (a.state === 'engage') {
        a.lost = a.sees ? 0 : a.lost + dt;
        if (a.lost > AI.lost) {
          a.state = 'patrol';
          a.search = a.lastSeen;
          a.target = null;
          a.seen = 0;
          a.idle = 0;
          a.lost = 0;
        } else if (d.hp <= AI.coverAt * d.lifeMax && a.coverCool <= 0) {
          const spot = aiCover(d) || aiRetreat(d);
          if (spot) {
            a.state = 'cover';
            a.target = spot;
            a.travelT = 6;
            a.blockedT = 0;
            a.hideT = AI.hide;
          } else aiEngage(d, dt);
        } else aiEngage(d, dt);
      }
      if (a.state === 'cover') {
        if (a.target) {
          const r = aiStep(d, a.target.x, a.target.z, AI.run, dt);
          a.travelT -= dt;
          if (r !== 'moving' || a.travelT <= 0) a.target = null;
        }
        if (!a.target) {
          a.hideT -= dt;
          if (a.hideT <= 0) {
            a.state = 'engage';
            a.coverCool = AI.coverRest;
            a.lost = 0;
          }
        }
        d.group.rotation.y = ang;
      }
      setBody(d, a.state !== 'patrol');
    }

    function spawnAIDummies() {
      for (let placed = 0, t = 0; placed < AI_DUMMIES && t < 3000; t++) {
        const a = Math.random() * Math.PI * 2;
        const r = 60 + Math.random() * 70;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        if (!aiFree(x, z, null)) continue;
        if (dummies.some((o) => Math.hypot(o.group.position.x - x, o.group.position.z - z) < 25)) continue;
        spawnDummy(x, z, true, true);
        placed += 1;
      }
    }
    spawnAIDummies();

    // ----------------------------------------------------
    // Main Game Loop
    // ----------------------------------------------------
    function update(dt: number) {
      streamTerrain();
      streamPois();
      updateGrenadePress(dt);
      updateShield(dt);
      if (playerDown) {
        respawnT -= dt;
        if (respawnT <= 0) respawn();
        for (const d of dummies) {
          updateDummy(d, dt);
          updateAI(d, dt);
        }
        updateTurret(dt);
        updateGrenades(dt);
        updateVitals();
        return;
      }
      movePlayer(dt);
      updateWaterFx();
      updatePickups(dt);
      updateWeapon(dt);
      if (mouseHeld) shoot();
      if (fireMode === 'manual') {
        if (aiming() && !buildMode && !gArmed && !bombArmed) {
          shoot();
        }
      } else {
        autoShoot();
      }
      for (const d of dummies) {
        updateDummy(d, dt);
        updateAI(d, dt);
        updateShooter(d, dt);
      }
      updateTurret(dt);
      updateAntenna(dt);
      updateGrenades(dt);
      updateVitals();
    }

    renderer.autoClear = false;
    scene.traverse((o: any) => {
      if (o.isLight) o.layers.enable(1);
    });

    const clock = new THREE.Clock();
    let animId: number;

    function frame() {
      const dt = Math.min(clock.getDelta(), 0.05);
      // The tactical map pauses the world but never the HUD renders
      if (running() && !mapOpen) {
        try {
          update(dt);
        } catch (err) {
          // Record and survive: a fault in one frame must not take the
          // whole game down. __poiBuildErr logs the finer-grained cause.
          console.error('frame error:', err);
          const w = window as any;
          w.__frameErr = w.__frameErr || [];
          w.__frameErr.push(String((err as any)?.stack || err));
        }
      }
      applyView();
      updateCompass();
      updateTracker();
      updateAntTracker();
      renderAntennaHud();
      followSun();

      camera.layers.set(0);
      renderer.render(scene, camera);
      const sky = scene.background;
      scene.background = null;
      renderer.clearDepth();
      camera.layers.set(1);
      renderer.render(scene, camera);
      scene.background = sky;
      animId = requestAnimationFrame(frame);
    }
    animId = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
      window.removeEventListener('touchcancel', onTouchEnd);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      renderer.dispose();
    };
  }, []);

  return (
    <div ref={containerRef} className="relative w-full h-full overflow-hidden select-none touch-none">
      <canvas id="game" ref={canvasRef} aria-label="First-person view" />
      <div className="shield-fx" id="shieldFx" aria-hidden="true" />
      <div className="hurt-fx" id="hurtFx" aria-hidden="true" />
      <div className="smoke-fx" id="smokeFx" aria-hidden="true" />
      <div className="water-fx" id="waterFx" aria-hidden="true" />

      {/* Top compass: N/E/S/W strip + harbor landmark chips */}
      <div className="hud compass" id="compass" role="img" aria-label="Compass" hidden>
        <div className="compass-window" id="compassWindow">
          <div className="compass-strip" id="compassStrip" aria-hidden="true" />
          <div className="compass-marks" id="compassMarks" aria-hidden="true" />
          <span className="compass-caret" aria-hidden="true" />
          <span className="compass-deg" id="compassDeg">
            N 0&deg;
          </span>
        </div>
      </div>

      {/* Antenna minimap (passive — tap it or M for the tactical map) */}
      <div className="hud minimap" id="minimap" hidden aria-label="Minimap — open the tactical map">
        <canvas id="minimapCanvas" width={352} height={352} />
        <span className="minimap-n">N</span>
        <kbd className="minimap-key">M</kbd>
      </div>

      {/* Top HUD: Downs and credits */}
      <div className="hud downs">
        Downs<span id="downs">0</span>
        <span className="credits">
          &middot; <b id="credits">300</b> cr
        </span>
        <span className="inventorybtn" id="inventoryBtn" role="button" tabIndex={0}>
          Inventory
        </span>
      </div>

      {/* Vitals HUD */}
      <div className="hud vitals" aria-label="Shield and life">
        <div className="vital" id="shieldRow">
          <div className="vital-head">
            <span className="vital-name">Shield</span>
            <span className="pips" aria-label="Shield level">
              <i className="on" />
              <i />
              <i />
            </span>
            <span className="vital-num" id="shieldNum">
              152 / 152
            </span>
          </div>
          <div className="track">
            <span className="fill shield-fill" id="shieldFill" />
          </div>
        </div>
        <div className="vital">
          <div className="vital-head">
            <span className="vital-name">Life</span>
            <span className="vital-num" id="lifeNum">
              120 / 120
            </span>
          </div>
          <div className="track">
            <span className="fill life-fill" id="lifeFill" />
          </div>
        </div>
        <div className="vital">
          <div className="vital-head">
            <span className="vital-name">
              Level <span id="levelNum">1</span>
            </span>
            <span className="vital-num" id="xpNum">
              0 / 100 XP
            </span>
          </div>
          <div className="track">
            <span className="fill xp-fill" id="xpFill" />
          </div>
        </div>
      </div>

      {/* Downed notification */}
      <div className="downed" id="downed" hidden>
        <div className="downed-card">
          <div className="downed-title">Down</div>
          <div className="downed-sub">
            Respawning in <span id="downedTimer">3</span>
          </div>
        </div>
      </div>

      {/* Control Hints (desktop) */}
      <div className="hud hint">
        WASD move &middot; Shift sprint &middot; Space jump &middot; C crouch / sprint-slide &middot; Z/X roll &middot; R reload
        &middot; 1/2/Q weapon slots &middot; E turret/bombard/antenna &middot; G grenade (hold to pick) &middot; Right click
        aim/call &middot; M map (Antenna) &middot; B inventory &middot; Esc pause
      </div>

      {/* Crosshair & Hitmarker */}
      <div className="hud crosshair" />
      <div className="hud hitmark" id="hitmark" />
      <div className="scope" id="scope" aria-hidden="true">
        <div className="lens" />
      </div>

      {/* Weapon Slots */}
      <div className="slots" id="slots" aria-label="Weapon slots">
        <div className="slot active" id="slot0">
          <span className="slot-key">1</span>
          <span className="slot-name" id="slotName0">
            SK
          </span>
        </div>
        <div className="slot empty" id="slot1">
          <span className="slot-key">2</span>
          <span className="slot-name" id="slotName1">
            Empty
          </span>
        </div>
      </div>

      {/* Turret / Primary Ability Plate */}
      <div className="hud turret" id="turret">
        <div className="t-name">
          <span id="primaryName">Turret</span> <span className="t-lv" id="turretLv">Lv 1</span>
          <kbd className="t-key">E</kbd>
        </div>
        <div className="t-state" id="turretState">
          Ready
        </div>
      </div>

      {/* Grenade Plate (Desktop) */}
      <div className="hud gplate" id="gPlate">
        <div className="t-name">
          Grenade <span id="gName">Blast</span>
          <kbd className="t-key">G</kbd>
        </div>
        <div className="t-state" id="gCount">
          0 left
        </div>
      </div>

      {/* Wood purse — harvested from voxelized trees, spent on builds */}
      <div className="hud gplate woodplate" id="woodPlate" hidden>
        <div className="t-name">
          Wood <span id="woodCount">60</span>
        </div>
        <div className="t-state" id="woodHint">
          chop trees to build
        </div>
      </div>

      {/* Fortnite Build Plate (Desktop) */}
      <button
        type="button"
        className="hud build-plate"
        id="buildWallBtn"
        aria-label="Build Fortnite Cover"
      >
        <div className="t-name">
          <span id="buildWallName">🧱 Wall Cover</span>
          <kbd className="t-key">V</kbd>
        </div>
        <div className="t-state" id="buildWallState">
          250 HP &middot; Blocks Blast
        </div>
      </button>

      {/* Ammo Plate */}
      <div className="hud ammo">
        <div className="weapon-header">
          <div className="weapon" id="weapon">
            SK
          </div>
          <div className="fire-mode-seg" role="group" aria-label="Firing Mode">
            <button
              type="button"
              className="fire-mode-btn active"
              id="fireModeAuto"
              title="Auto: fires automatically when an enemy is in front"
            >
              auto
            </button>
            <button
              type="button"
              className="fire-mode-btn"
              id="fireModeManual"
              title="Manual: fires with the AIM button even without enemy"
            >
              manual
            </button>
          </div>
        </div>
        <div className="status" id="status" />
        <div className="count">
          <span id="ammo">30</span>
          <small id="mag"> / 30</small>
        </div>
        <div className="reserve" id="reserve">
          HEAVY 60
        </div>
      </div>

      {/* Touch UI (Mobile) */}
      <div className="touch-ui" aria-hidden="true">
        <div className="stick" id="stick">
          <div className="knob" id="knob" />
        </div>
        <div className="slider" id="slider" aria-hidden="true">
          <div className="slider-knob" id="sliderKnob" />
        </div>
        <div className="pick off" id="pick" aria-disabled="true">
          <span className="pick-label">Pick up</span>
          <small className="pick-name" id="pickName" />
        </div>

        <div className="aim" id="aim">
          Aim
        </div>
        <div className="gbtn" id="gBtn">
          <span className="gbtn-name" id="gBtnName">
            Blast
          </span>
          <small className="gbtn-count" id="gBtnCount">
            0
          </small>
        </div>
        <div className="touch-build" id="touchBuildBtn" role="button" aria-label="Build">
          <span className="tb-icon" id="buildPieceIcon">🧱</span>
          <span className="tb-label" id="buildPieceLabel">Wall</span>
        </div>
      </div>
      <div className="gpick" id="gPick" aria-hidden="true" />

      {/* Turret Tracker */}
      <div className="tracker" id="tracker" hidden>
        <div className="tracker-dir" id="trackerDir">
          <span className="tracker-arrow" />
        </div>
        <span className="tracker-mark" />
        <span className="tracker-tag" id="trackerTag" />
      </div>

      {/* Antenna Tracker */}
      <div className="tracker ant" id="antTracker" hidden>
        <div className="tracker-dir" id="antTrackerDir">
          <span className="tracker-arrow" />
        </div>
        <span className="tracker-mark" />
        <span className="tracker-tag" id="antTrackerTag" />
      </div>

      {/* Main Menu Lobby */}
      <div className="menu" id="menu" role="dialog" aria-modal="true" aria-labelledby="menuTitle">
        {/* Dynamic Mode Environment Backdrop & Character Stage */}
        <div className="lobby-viewport" id="lobbyViewport" aria-hidden="true">
          <div className="lobby-env-bg mode-range" id="lobbyEnvBg" data-mode="range">
            {/* Mode Shape 1: Test Range firing grid, bunker silhouette, and ballistic target lanes */}
            <svg className="mode-shape mode-shape-range" viewBox="0 0 1200 800" preserveAspectRatio="xMidYMid slice">
              <defs>
                <linearGradient id="rangeSky" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#111827" />
                  <stop offset="45%" stopColor="#1f293d" />
                  <stop offset="70%" stopColor="#3d2d24" />
                  <stop offset="100%" stopColor="#131720" />
                </linearGradient>
                <linearGradient id="rangeFloor" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#252b36" />
                  <stop offset="50%" stopColor="#141922" />
                  <stop offset="100%" stopColor="#0a0d13" />
                </linearGradient>
                <linearGradient id="targetGlow" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.8" />
                  <stop offset="100%" stopColor="#ef4444" stopOpacity="0.2" />
                </linearGradient>
              </defs>
              <rect width="1200" height="800" fill="url(#rangeSky)" />

              {/* Distant mountain silhouette */}
              <polygon points="0,520 180,440 340,490 520,410 740,470 960,390 1200,480 1200,800 0,800" fill="#141a24" />
              <polygon points="0,540 220,480 460,530 680,460 910,510 1200,460 1200,800 0,800" fill="#192230" opacity="0.8" />

              {/* Proving Ground Floor with Perspective Grid */}
              <polygon points="120,530 1080,530 1200,800 0,800" fill="url(#rangeFloor)" />
              {/* Ballistic firing lane guidelines */}
              <line x1="600" y1="530" x2="600" y2="800" stroke="#f2a516" strokeWidth="2" strokeDasharray="12 8" opacity="0.6" />
              <line x1="420" y1="530" x2="180" y2="800" stroke="#67e8f9" strokeWidth="1.5" strokeDasharray="10 8" opacity="0.4" />
              <line x1="780" y1="530" x2="1020" y2="800" stroke="#67e8f9" strokeWidth="1.5" strokeDasharray="10 8" opacity="0.4" />
              <line x1="280" y1="530" x2="-80" y2="800" stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
              <line x1="920" y1="530" x2="1280" y2="800" stroke="rgba(255,255,255,0.15)" strokeWidth="1" />

              {/* Range Distance Markers & Silhouette Bunkers */}
              {/* 200M line */}
              <line x1="260" y1="560" x2="940" y2="560" stroke="#475569" strokeWidth="1.5" strokeDasharray="6 6" />
              <text x="600" y="555" fill="#94a3b8" fontSize="13" fontWeight="800" textAnchor="middle" letterSpacing="3">--- 200M TARGET LINE ---</text>
              {/* Distant targets */}
              <rect x="470" y="525" width="22" height="32" rx="3" fill="#334155" />
              <circle cx="481" cy="535" r="5" fill="#ef4444" opacity="0.8" />
              <rect x="710" y="525" width="22" height="32" rx="3" fill="#334155" />
              <circle cx="721" cy="535" r="5" fill="#ef4444" opacity="0.8" />

              {/* 100M line with Voxel Wall Block */}
              <line x1="190" y1="620" x2="1010" y2="620" stroke="#f2a516" strokeWidth="2" opacity="0.5" strokeDasharray="8 6" />
              <text x="600" y="612" fill="#f2a516" fontSize="15" fontWeight="800" textAnchor="middle" letterSpacing="4">[ 100M DESTRUCTIBLE VOXEL WALL ]</text>
              {/* Destructible Voxel Wall Silhouette */}
              <g transform="translate(510, 565)">
                <rect x="0" y="0" width="180" height="48" rx="4" fill="#384353" stroke="#526075" strokeWidth="2" />
                {/* Voxel grid pattern representing the tessellated blocks */}
                <line x1="36" y1="0" x2="36" y2="48" stroke="#252d38" strokeWidth="1.5" />
                <line x1="72" y1="0" x2="72" y2="48" stroke="#252d38" strokeWidth="1.5" />
                <line x1="108" y1="0" x2="108" y2="48" stroke="#252d38" strokeWidth="1.5" />
                <line x1="144" y1="0" x2="144" y2="48" stroke="#252d38" strokeWidth="1.5" />
                <line x1="0" y1="24" x2="180" y2="24" stroke="#252d38" strokeWidth="1.5" />
                <rect x="55" y="10" width="70" height="28" rx="2" fill="rgba(242, 165, 22, 0.2)" stroke="#f2a516" strokeWidth="1" strokeDasharray="3 3" />
                <text x="90" y="28" fill="#f2a516" fontSize="10" fontWeight="bold" textAnchor="middle">TEST TARGET</text>
              </g>

              {/* Tactical Range Reticles & Neon HUD Lines */}
              <circle cx="600" cy="530" r="120" fill="none" stroke="#67e8f9" strokeWidth="1" opacity="0.25" strokeDasharray="4 8" />
              <circle cx="600" cy="530" r="60" fill="none" stroke="#f2a516" strokeWidth="1.5" opacity="0.35" />
              <line x1="600" y1="380" x2="600" y2="490" stroke="#f2a516" strokeWidth="1.5" opacity="0.4" />
              <line x1="450" y1="530" x2="560" y2="530" stroke="#f2a516" strokeWidth="1.5" opacity="0.4" />
              <line x1="640" y1="530" x2="750" y2="530" stroke="#f2a516" strokeWidth="1.5" opacity="0.4" />
            </svg>

            {/* Mode Shape 2: Harbor coastal bay, container gantry crane, pier, and lighthouse */}
            <svg className="mode-shape mode-shape-harbor" viewBox="0 0 1200 800" preserveAspectRatio="xMidYMid slice">
              <defs>
                <linearGradient id="harborSky" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#08101e" />
                  <stop offset="50%" stopColor="#12233b" />
                  <stop offset="75%" stopColor="#223a59" />
                  <stop offset="100%" stopColor="#0c1827" />
                </linearGradient>
                <linearGradient id="harborSea" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#0f263e" />
                  <stop offset="60%" stopColor="#071728" />
                  <stop offset="100%" stopColor="#030b14" />
                </linearGradient>
                <linearGradient id="lightBeam" x1="0" y1="0" x2="1" y2="0.6">
                  <stop offset="0%" stopColor="#fef08a" stopOpacity="0.85" />
                  <stop offset="60%" stopColor="#38bdf8" stopOpacity="0.25" />
                  <stop offset="100%" stopColor="#38bdf8" stopOpacity="0" />
                </linearGradient>
              </defs>
              <rect width="1200" height="800" fill="url(#harborSky)" />

              {/* Sea Ocean Surface */}
              <polygon points="0,480 1200,480 1200,800 0,800" fill="url(#harborSea)" />

              {/* Animated wave lines */}
              <g opacity="0.4" style={{ animation: 'wave-glide 6s ease-in-out infinite' }}>
                <line x1="-50" y1="520" x2="1250" y2="520" stroke="#38bdf8" strokeWidth="2" strokeDasharray="35 25" />
                <line x1="-30" y1="560" x2="1250" y2="560" stroke="#0ea5e9" strokeWidth="2" strokeDasharray="50 30" />
                <line x1="-80" y1="610" x2="1250" y2="610" stroke="#67e8f9" strokeWidth="1.5" strokeDasharray="60 40" />
                <line x1="-20" y1="680" x2="1250" y2="680" stroke="#38bdf8" strokeWidth="2" strokeDasharray="70 50" />
              </g>

              {/* Breakwater Rock Jetty and Lighthouse (Right Side) */}
              <polygon points="860,510 1020,470 1200,475 1200,560 840,550" fill="#15202e" />
              {/* Lighthouse tower */}
              <polygon points="1060,470 1090,470 1084,330 1066,330" fill="#e2e8f0" stroke="#334155" strokeWidth="2" />
              {/* Red bands on lighthouse */}
              <polygon points="1064,360 1086,360 1083,390 1067,390" fill="#e11d2e" />
              <polygon points="1062,420 1088,420 1087,445 1061,445" fill="#e11d2e" />
              {/* Lighthouse Lantern Top */}
              <rect x="1065" y="315" width="20" height="15" rx="3" fill="#fef08a" />
              <polygon points="1060,315 1090,315 1075,295" fill="#1e293b" />
              {/* Sweeping Lighthouse Light Beam */}
              <polygon points="1075,322 0,220 0,440" fill="url(#lightBeam)" style={{ transformOrigin: '1075px 322px', animation: 'lighthouse-sweep 7s ease-in-out infinite' }} />

              {/* Massive Container Gantry Crane Silhouette (Left Side) */}
              <g transform="translate(140, 240)">
                {/* Legs */}
                <polygon points="20,290 35,290 70,50 55,50" fill="#e11d2e" opacity="0.9" />
                <polygon points="180,290 165,290 130,50 145,50" fill="#e11d2e" opacity="0.9" />
                {/* Cross beams & truss */}
                <line x1="30" y1="210" x2="170" y2="210" stroke="#e11d2e" strokeWidth="6" />
                <line x1="45" y1="130" x2="155" y2="130" stroke="#e11d2e" strokeWidth="6" />
                <line x1="30" y1="210" x2="155" y2="130" stroke="#cbd5e1" strokeWidth="2.5" />
                <line x1="170" y1="210" x2="45" y2="130" stroke="#cbd5e1" strokeWidth="2.5" />
                {/* Overhead boom cantilever */}
                <rect x="-40" y="38" width="310" height="18" fill="#e11d2e" />
                <polygon points="50,38 100,-25 150,38" fill="none" stroke="#e11d2e" strokeWidth="5" />
                <line x1="100" y1="-25" x2="-35" y2="38" stroke="#94a3b8" strokeWidth="2" />
                <line x1="100" y1="-25" x2="265" y2="38" stroke="#94a3b8" strokeWidth="2" />
                {/* Trolley and hoisting cables */}
                <rect x="180" y="56" width="26" height="14" fill="#0f172a" />
                <line x1="188" y1="70" x2="188" y2="130" stroke="#f2a516" strokeWidth="1.5" />
                <line x1="198" y1="70" x2="198" y2="130" stroke="#f2a516" strokeWidth="1.5" />
                {/* Suspended Shipping Container */}
                <rect x="175" y="130" width="56" height="26" rx="2" fill="#0284c7" stroke="#38bdf8" strokeWidth="1.5" />
              </g>

              {/* The Pier Deck Extending Out to Sea (Center) */}
              <polygon points="520,500 680,500 780,800 420,800" fill="#2d3748" />
              {/* Pier timber planks */}
              <line x1="510" y1="520" x2="690" y2="520" stroke="#1a202c" strokeWidth="3" />
              <line x1="495" y1="550" x2="705" y2="550" stroke="#1a202c" strokeWidth="3" />
              <line x1="480" y1="585" x2="720" y2="585" stroke="#1a202c" strokeWidth="3.5" />
              <line x1="460" y1="630" x2="740" y2="630" stroke="#1a202c" strokeWidth="4" />
              <line x1="440" y1="685" x2="760" y2="685" stroke="#1a202c" strokeWidth="4.5" />

              {/* Shipping Container Stacks along Quay */}
              <g transform="translate(340, 480)">
                <rect x="0" y="0" width="60" height="26" rx="2" fill="#ea580c" stroke="#fb923c" strokeWidth="1.5" />
                <rect x="6" y="-26" width="60" height="26" rx="2" fill="#2563eb" stroke="#60a5fa" strokeWidth="1.5" />
              </g>
              <g transform="translate(690, 485)">
                <rect x="0" y="0" width="60" height="26" rx="2" fill="#16a34a" stroke="#4ade80" strokeWidth="1.5" />
                <rect x="5" y="-26" width="60" height="26" rx="2" fill="#dc2626" stroke="#f87171" strokeWidth="1.5" />
              </g>

              {/* Cargo Vessel on Horizon */}
              <g transform="translate(490, 455)" opacity="0.85">
                <polygon points="0,25 30,5 170,5 190,25" fill="#0f172a" />
                <rect x="135" y="-15" width="25" height="20" fill="#334155" />
                <rect x="145" y="-24" width="6" height="10" fill="#e11d2e" />
                <rect x="35" y="-4" width="90" height="10" fill="#d97706" />
              </g>
            </svg>
          </div>

          {/* Chosen Character Shown Facing The Background (Back turned to player, looking ahead into arena) */}
          <div className="lobby-character-stage" id="lobbyCharStage" data-char="bulwark">
            {/* The character figure SVG */}
            <svg className="lobby-character-figure" viewBox="0 0 200 320" aria-label="Character facing the arena">
              {/* ================= BULWARK (Rear View Facing Ahead) ================= */}
              <g className="char-back-view char-back-bulwark">
                {/* Heavy Combat Boots & Greaves */}
                <path d="M 62 270 L 82 270 L 86 312 L 56 312 Z" fill="#1e293b" stroke="#334155" strokeWidth="2" />
                <path d="M 118 270 L 138 270 L 144 312 L 114 312 Z" fill="#1e293b" stroke="#334155" strokeWidth="2" />
                {/* Armored Legs */}
                <path d="M 68 200 L 92 200 L 88 272 L 64 272 Z" fill="#334155" stroke="#1e293b" strokeWidth="2" />
                <path d="M 108 200 L 132 200 L 136 272 L 112 272 Z" fill="#334155" stroke="#1e293b" strokeWidth="2" />
                {/* Utility Pouches & Holsters */}
                <rect x="52" y="210" width="14" height="22" rx="3" fill="#1e293b" stroke="#475569" strokeWidth="1.5" />
                <rect x="134" y="212" width="14" height="24" rx="3" fill="#1e293b" stroke="#475569" strokeWidth="1.5" />

                {/* Tactical Belt */}
                <rect x="62" y="185" width="76" height="16" rx="4" fill="#0f172a" stroke="#475569" strokeWidth="2" />
                <rect x="94" y="187" width="12" height="12" rx="2" fill="#67e8f9" opacity="0.8" />

                {/* Armored Torso Plate (Viewed From Behind) */}
                <path d="M 54 90 L 146 90 L 136 186 L 64 186 Z" fill="#1e293b" stroke="#334155" strokeWidth="2.5" />
                {/* Spine Reinforcement Ridge */}
                <rect x="95" y="98" width="10" height="78" rx="4" fill="#0f172a" stroke="#67e8f9" strokeWidth="1.5" />
                <circle cx="100" cy="110" r="2.5" fill="#67e8f9" className="pulse-cyan" />
                <circle cx="100" cy="130" r="2.5" fill="#67e8f9" className="pulse-cyan" />
                <circle cx="100" cy="150" r="2.5" fill="#67e8f9" className="pulse-cyan" />

                {/* Shoulders & Pauldrons */}
                <path d="M 38 92 L 64 88 L 60 140 L 36 130 Z" fill="#334155" stroke="#1e293b" strokeWidth="2" />
                <path d="M 162 92 L 136 88 L 140 140 L 164 130 Z" fill="#334155" stroke="#1e293b" strokeWidth="2" />

                {/* Bulwark's Backpack Minigun Turret Unit (Folded on Right Shoulder) */}
                <g transform="translate(125, 52)">
                  {/* Turret Mounting Swivel & Arm */}
                  <rect x="0" y="30" width="22" height="20" rx="4" fill="#0f172a" stroke="#475569" strokeWidth="2" />
                  {/* Rotary Barrels Pointing Forward into Horizon */}
                  <rect x="8" y="-12" width="6" height="44" rx="2" fill="#475569" stroke="#64748b" strokeWidth="1" />
                  <rect x="18" y="-10" width="6" height="42" rx="2" fill="#475569" stroke="#64748b" strokeWidth="1" />
                  <ellipse cx="16" cy="-12" rx="10" ry="4" fill="#0f172a" stroke="#67e8f9" strokeWidth="1.5" />
                  {/* Energy Conduit with Cyan Glow */}
                  <path d="M 4 45 Q -10 60 -25 55" fill="none" stroke="#67e8f9" strokeWidth="3" className="pulse-cyan" />
                </g>

                {/* Left Shoulder Shield Emitter Pylon */}
                <g transform="translate(48, 65)">
                  <polygon points="0,20 16,0 24,10 8,30" fill="#0f172a" stroke="#67e8f9" strokeWidth="2" />
                  <circle cx="12" cy="15" r="4" fill="#67e8f9" className="pulse-cyan" />
                </g>

                {/* Combat Helmet (Seen From Behind, Facing Forward into Horizon) */}
                <ellipse cx="100" cy="62" rx="24" ry="26" fill="#1e293b" stroke="#334155" strokeWidth="2.5" />
                {/* Helmet Spine & Neck Shield */}
                <path d="M 88 78 L 112 78 L 108 92 L 92 92 Z" fill="#0f172a" stroke="#334155" strokeWidth="1.5" />
                <rect x="97" y="44" width="6" height="28" rx="2" fill="#475569" />
                {/* Comms Antenna */}
                <line x1="82" y1="60" x2="76" y2="35" stroke="#94a3b8" strokeWidth="2" />
                <circle cx="76" cy="35" r="2" fill="#67e8f9" className="pulse-cyan" />
                {/* Forward Visor Glow Reflection Casting Light Forward */}
                <ellipse cx="100" cy="40" rx="18" ry="6" fill="#67e8f9" opacity="0.35" className="pulse-cyan" />
              </g>

              {/* ================= BARRAGE (Rear View Facing Ahead) ================= */}
              <g className="char-back-view char-back-barrage">
                {/* Heavy Demolition Combat Boots */}
                <path d="M 62 270 L 82 270 L 86 312 L 56 312 Z" fill="#1c1917" stroke="#44403c" strokeWidth="2" />
                <path d="M 118 270 L 138 270 L 144 312 L 114 312 Z" fill="#1c1917" stroke="#44403c" strokeWidth="2" />
                {/* Armored Blast Legs */}
                <path d="M 68 200 L 92 200 L 88 272 L 64 272 Z" fill="#292524" stroke="#44403c" strokeWidth="2" />
                <path d="M 108 200 L 132 200 L 136 272 L 112 272 Z" fill="#292524" stroke="#44403c" strokeWidth="2" />

                {/* Demolition Utility Belt with Grenade Canisters */}
                <rect x="58" y="185" width="84" height="18" rx="4" fill="#0c0a09" stroke="#f59e0b" strokeWidth="2" />
                <rect x="65" y="187" width="10" height="14" rx="2" fill="#f59e0b" />
                <rect x="80" y="187" width="10" height="14" rx="2" fill="#f59e0b" />
                <rect x="110" y="187" width="10" height="14" rx="2" fill="#f59e0b" />
                <rect x="125" y="187" width="10" height="14" rx="2" fill="#f59e0b" />

                {/* Heavy Blast Carrier Vest */}
                <path d="M 52 90 L 148 90 L 138 186 L 62 186 Z" fill="#292524" stroke="#44403c" strokeWidth="2.5" />
                {/* Yellow Hazard Stripes Across Back */}
                <path d="M 68 115 L 132 115 L 128 135 L 72 135 Z" fill="#f59e0b" />
                <polygon points="76,115 88,115 78,135 66,135" fill="#1c1917" />
                <polygon points="96,115 108,115 98,135 86,135" fill="#1c1917" />
                <polygon points="116,115 128,115 118,135 106,135" fill="#1c1917" />

                {/* Slung Twin Heavy Mortar Tubes Cross-Mounted on Back */}
                <g transform="translate(62, 50) rotate(-28)">
                  <rect x="0" y="-15" width="18" height="110" rx="5" fill="#1c1917" stroke="#78716c" strokeWidth="2" />
                  <ellipse cx="9" cy="-15" rx="9" ry="4" fill="#f59e0b" />
                  <line x1="0" y1="20" x2="18" y2="20" stroke="#f59e0b" strokeWidth="2" />
                  <line x1="0" y1="50" x2="18" y2="50" stroke="#f59e0b" strokeWidth="2" />
                </g>
                <g transform="translate(138, 50) rotate(28)">
                  <rect x="-18" y="-15" width="18" height="110" rx="5" fill="#1c1917" stroke="#78716c" strokeWidth="2" />
                  <ellipse cx="-9" cy="-15" rx="9" ry="4" fill="#f59e0b" />
                  <line x1="-18" y1="20" x2="0" y2="20" stroke="#f59e0b" strokeWidth="2" />
                  <line x1="-18" y1="50" x2="0" y2="50" stroke="#f59e0b" strokeWidth="2" />
                </g>

                {/* Thermal Exhaust Vent (Glowing Amber Pulse) */}
                <circle cx="100" cy="160" r="8" fill="#f59e0b" className="pulse-amber" />
                <circle cx="100" cy="160" r="4" fill="#fff" />

                {/* Shoulders */}
                <path d="M 36 94 L 62 90 L 58 140 L 34 130 Z" fill="#44403c" stroke="#1c1917" strokeWidth="2" />
                <path d="M 164 94 L 138 90 L 142 140 L 166 130 Z" fill="#44403c" stroke="#1c1917" strokeWidth="2" />

                {/* Blast Helmet (Rear View, Looking Forward Ahead) */}
                <ellipse cx="100" cy="62" rx="25" ry="26" fill="#292524" stroke="#f59e0b" strokeWidth="2" />
                <path d="M 86 78 L 114 78 L 110 94 L 90 94 Z" fill="#1c1917" stroke="#44403c" strokeWidth="1.5" />
                {/* Amber Visor Forward Projection */}
                <ellipse cx="100" cy="40" rx="18" ry="6" fill="#f59e0b" opacity="0.4" className="pulse-amber" />
              </g>

              {/* ================= ANTENNA (Rear View Facing Ahead) ================= */}
              <g className="char-back-view char-back-antenna">
                {/* Recon Boots */}
                <path d="M 62 270 L 82 270 L 86 312 L 56 312 Z" fill="#0f172a" stroke="#334155" strokeWidth="2" />
                <path d="M 118 270 L 138 270 L 144 312 L 114 312 Z" fill="#0f172a" stroke="#334155" strokeWidth="2" />
                {/* Slim Recon Legs */}
                <path d="M 70 200 L 90 200 L 87 272 L 67 272 Z" fill="#1e293b" stroke="#334155" strokeWidth="2" />
                <path d="M 110 200 L 130 200 L 133 272 L 113 272 Z" fill="#1e293b" stroke="#334155" strokeWidth="2" />
                {/* Thigh Scanner Holster */}
                <rect x="130" y="212" width="12" height="20" rx="3" fill="#0f172a" stroke="#67e8f9" strokeWidth="1.5" />

                {/* Recon Belt with Data Cells */}
                <rect x="62" y="185" width="76" height="16" rx="4" fill="#0f172a" stroke="#475569" strokeWidth="2" />
                <rect x="72" y="188" width="16" height="10" rx="2" fill="#155e75" />
                <rect x="112" y="188" width="16" height="10" rx="2" fill="#155e75" />

                {/* Recon Carrier Vest */}
                <path d="M 56 90 L 144 90 L 134 186 L 66 186 Z" fill="#1e293b" stroke="#334155" strokeWidth="2.5" />
                {/* Signal Pouches */}
                <rect x="66" y="128" width="14" height="16" rx="3" fill="#0f172a" stroke="#67e8f9" strokeWidth="1" />
                <rect x="120" y="128" width="14" height="16" rx="3" fill="#0f172a" stroke="#67e8f9" strokeWidth="1" />
                {/* Spine Data Conduit */}
                <rect x="96" y="98" width="8" height="76" rx="4" fill="#0f172a" stroke="#67e8f9" strokeWidth="1.5" />
                <circle cx="100" cy="112" r="2.5" fill="#67e8f9" className="pulse-cyan" />
                <circle cx="100" cy="132" r="2.5" fill="#67e8f9" className="pulse-cyan" />
                <circle cx="100" cy="152" r="2.5" fill="#67e8f9" className="pulse-cyan" />

                {/* Backpack Scanner Mast Unit (Deployable Antenna Rig, Folded Flat) */}
                <g transform="translate(100, 96)">
                  {/* Tripod Mount Plate */}
                  <path d="M -20 12 L 20 12 L 14 0 L -14 0 Z" fill="#0f172a" stroke="#475569" strokeWidth="2" />
                  {/* Telescoping Mast */}
                  <rect x="-4" y="-76" width="8" height="76" rx="3" fill="#334155" stroke="#67e8f9" strokeWidth="1.5" />
                  <rect x="-3" y="-76" width="6" height="26" rx="2" fill="#67e8f9" opacity="0.45" />
                  {/* Dipole Crossbars (clear the helmet line) */}
                  <rect x="-10" y="-70" width="20" height="4" rx="2" fill="#475569" stroke="#67e8f9" strokeWidth="1" />
                  <rect x="-20" y="-62" width="40" height="5" rx="2" fill="#475569" stroke="#67e8f9" strokeWidth="1" />
                  {/* Mast Tip Beacon */}
                  <circle cx="0" cy="-78" r="4.5" fill="#67e8f9" className="pulse-cyan" />
                  {/* Broadcast Arcs Above the Tip */}
                  <path d="M -28 -84 Q 0 -104 28 -84" fill="none" stroke="#67e8f9" strokeWidth="2.5" className="pulse-cyan" />
                  <path d="M -16 -88 Q 0 -102 16 -88" fill="none" stroke="#67e8f9" strokeWidth="2" className="pulse-cyan" />
                  {/* Side Feed Cable */}
                  <path d="M 16 4 Q 34 20 26 42" fill="none" stroke="#67e8f9" strokeWidth="2" className="pulse-cyan" />
                </g>

                {/* Shoulders (Slim Recon Pauldrons) */}
                <path d="M 40 94 L 64 90 L 60 132 L 38 124 Z" fill="#334155" stroke="#1e293b" strokeWidth="2" />
                <path d="M 160 94 L 136 90 L 140 132 L 162 124 Z" fill="#334155" stroke="#1e293b" strokeWidth="2" />

                {/* Recon Helmet (Rear View) */}
                <ellipse cx="100" cy="62" rx="23" ry="25" fill="#1e293b" stroke="#334155" strokeWidth="2.5" />
                {/* Helmet Signal Grid */}
                <line x1="84" y1="52" x2="116" y2="52" stroke="#67e8f9" strokeWidth="1" opacity="0.6" />
                <line x1="82" y1="60" x2="118" y2="60" stroke="#67e8f9" strokeWidth="1" opacity="0.6" />
                <line x1="84" y1="68" x2="116" y2="68" stroke="#67e8f9" strokeWidth="1" opacity="0.6" />
                {/* Twin Comms Whips */}
                <line x1="86" y1="58" x2="80" y2="34" stroke="#94a3b8" strokeWidth="2" />
                <line x1="114" y1="58" x2="120" y2="34" stroke="#94a3b8" strokeWidth="2" />
                <circle cx="80" cy="34" r="2" fill="#67e8f9" className="pulse-cyan" />
                <circle cx="120" cy="34" r="2" fill="#67e8f9" className="pulse-cyan" />
                {/* Neck Shield */}
                <path d="M 88 78 L 112 78 L 108 92 L 92 92 Z" fill="#0f172a" stroke="#334155" strokeWidth="1.5" />
                {/* Forward Visor Glow */}
                <ellipse cx="100" cy="40" rx="18" ry="6" fill="#67e8f9" opacity="0.35" className="pulse-cyan" />
              </g>
            </svg>

            {/* Glowing Deployment Pedestal */}
            <div className="lobby-pedestal">
              <div className="lobby-pedestal-ring" />
              <div className="lobby-char-facing-tag" id="lobbyCharTag">
                OPERATOR // BULWARK - FACING FIRING RANGE
              </div>
            </div>
          </div>
        </div>

        {/* Floating Glassmorphic HUD & Menu Cards */}
        <div className="menu-card">
          <div className="menu-head">
            <div className="eyebrow">Tactical Deployment</div>
            <h1 id="menuTitle">Battle Royale FPS</h1>
          </div>
          <div className="menu-body">
            {/* Character Selection (Glass Buttons) */}
            <section className="menu-side" aria-labelledby="charLabel">
              <h2 className="menu-label" id="charLabel">
                Operator Selection
              </h2>
              <div className="chars" role="radiogroup" aria-labelledby="charLabel">
                <button className="char" type="button" role="radio" aria-checked="true" data-char="bulwark">
                  <svg className="char-art" viewBox="0 0 96 96" aria-hidden="true">
                    <ellipse className="ic-base" cx="48" cy="77" rx="32" ry="9" />
                    <ellipse className="ic-ring" cx="48" cy="75" rx="27" ry="6.5" />
                    <rect className="ic-body" x="30" y="40" width="34" height="30" rx="5" />
                    <rect className="ic-barrel" x="58" y="45" width="30" height="9" rx="3" />
                    <circle className="ic-glow" cx="40" cy="55" r="3.5" />
                  </svg>
                  <div className="char-info">
                    <span className="char-name">Bulwark</span>
                    <span className="char-role">Deployable Turret Rig</span>
                  </div>
                </button>
                <button className="char" type="button" role="radio" aria-checked="false" data-char="barrage">
                  <svg className="char-art" viewBox="0 0 96 96" aria-hidden="true">
                    <ellipse className="ic-base" cx="48" cy="77" rx="32" ry="9" />
                    <ellipse className="ic-ring" cx="48" cy="75" rx="27" ry="6.5" />
                    <rect className="ic-body" x="34" y="56" width="28" height="18" rx="4" />
                    <rect className="ic-barrel" x="41" y="24" width="14" height="40" rx="6" transform="rotate(-22 48 56)" />
                    <circle className="ic-ring-warn" cx="74" cy="28" r="11" />
                    <circle className="ic-warn" cx="74" cy="28" r="4.5" />
                  </svg>
                  <div className="char-info">
                    <span className="char-name">Barrage</span>
                    <span className="char-role">Artillery Bombardment</span>
                  </div>
                </button>
                <button className="char" type="button" role="radio" aria-checked="false" data-char="antenna">
                  <svg className="char-art" viewBox="0 0 96 96" aria-hidden="true">
                    <ellipse className="ic-base" cx="48" cy="77" rx="32" ry="9" />
                    <ellipse className="ic-ring" cx="48" cy="75" rx="27" ry="6.5" />
                    <rect className="ic-barrel" x="46" y="24" width="4" height="50" rx="2" />
                    <rect className="ic-body" x="36" y="62" width="24" height="10" rx="3" />
                    <rect className="ic-body" x="32" y="36" width="32" height="4" rx="2" />
                    <rect className="ic-body" x="38" y="45" width="20" height="4" rx="2" />
                    <circle className="ic-glow" cx="48" cy="19" r="6" />
                    <path className="ic-ring-warn" d="M30 30 A 24 24 0 0 1 66 30" />
                    <path className="ic-ring-warn" d="M37 36 A 16 16 0 0 1 59 36" />
                  </svg>
                  <div className="char-info">
                    <span className="char-name">Antenna</span>
                    <span className="char-role">Recon — minimap + enemy scan, 100 life</span>
                  </div>
                </button>
              </div>
            </section>

            {/* Mode Selection (Glass Buttons) & Big Glass Play CTA */}
            <section className="menu-main" aria-labelledby="modeLabel">
              <h2 className="menu-label" id="modeLabel">
                Environment / Map
              </h2>
              <div className="modes" role="radiogroup" aria-labelledby="modeLabel">
                <button className="mode" type="button" role="radio" aria-checked="true" data-mode="range">
                  <span className="mode-name">Test range</span>
                  <span className="mode-tag">Proving Ground</span>
                </button>
                <button className="mode" type="button" role="radio" aria-checked="false" data-mode="harbor">
                  <span className="mode-name">Harbor</span>
                  <span className="mode-tag">Naval Basin</span>
                </button>
                <button className="mode" type="button" role="radio" aria-checked="false" data-mode="quarry" disabled>
                  <span className="mode-name">Quarry</span>
                  <span className="mode-tag">Locked</span>
                </button>
              </div>
              <button className="btn play" id="play" type="button">
                Deploy
              </button>
            </section>
          </div>
        </div>
      </div>

      {/* Pause Overlay */}
      <div className="overlay" id="overlay" hidden>
        <div className="card">
          <div className="eyebrow">Paused</div>
          <h1>Battle Royale FPS</h1>
          <p>Learn to move, look and shoot. The rest of the match comes next.</p>
          <ul className="controls keys-only">
            <li>
              <kbd>W</kbd>
              <kbd>A</kbd>
              <kbd>S</kbd>
              <kbd>D</kbd> move, <kbd>Shift</kbd> sprint, <kbd>Space</kbd> jump
            </li>
            <li>
              <kbd>C</kbd> hold to crouch, or tap while <b>sprinting</b> to slide. <kbd>Z</kbd> and <kbd>X</kbd> roll the way you are moving
            </li>
            <li>Mouse to look, hold <kbd>Left click</kbd> to fire</li>
            <li>Dummies within 15 m are shot automatically. Hold <kbd>Right click</kbd> to aim at range.</li>
            <li>Sniper: hold <kbd>Right click</kbd> to look through its 8x scope</li>
            <li>Betgun: 150 damage within 30 m. Within 10 m, 80 more skips the shield. Less damage beyond 30 m</li>
            <li>Jump into a crate in front of you to climb onto it, or hold <kbd>Space</kbd> at a ledge to vault</li>
            <li>Water slows you the deeper you wade, then you swim: <kbd>C</kbd> dives, <kbd>Space</kbd> strokes upward</li>
            <li>Take cover: walls and crates block grenade blasts and fire — for you and for the dummies</li>
            <li>Cover fails eventually: blasts chew voxel holes through walls and crates, and bullets chip chunks off</li>
            <li>Structures have health: damage numbers pop, health bars show, and a gutted building collapses</li>
            <li>
              Top compass points you around the map. In Harbor the nearest landmarks ride the strip as chips with live distance — a chip pinned at the strip edge means turn that way
            </li>
            <li>
              <b>Harbor is a procedural map.</b> The port owns the coast — pier, container yard, warehouses, gantry cranes, customs office, fuel tanks, a dry dock with a half-built ship, and a breakwater crowned by a climbable lighthouse. Every structure is destructible and the port holds the best loot
            </li>
            <li>
              The rest of the map fills with POIs — <b>VILL</b>age, <b>FARM</b>, <b>FUEL</b> depot, construction <b>SITE</b> (tower crane!), <b>CAMP</b>, radio <b>MAST</b>, <b>RUIN</b>ns, <b>OUTP</b>ost and <b>WATER</b> tower — each with loot and a compass chip. Guard towers and lighthouses have walkable stairs to the top, and the port's warehouses have LADDERs up to their roofs
            </li>
            <li>
              Dust, mud and gravel transition routes stitch the port gate to every POI — follow the tan / brown corridors through the biomes instead of bushwhacking, and watch for them on the tactical map
            </li>
            <li>
              <b>Every tree is voxelized.</b> Shoot or blast a trunk and the crown chews away into chunky wood voxels — each one knocked loose pays <b>wood</b> into your purse (top left of the build plate). Grenades carve whole handfuls at once
            </li>
            <li>
              <b>Wooden builds cost wood</b> in Harbor — wall 10, door 12, floor 10, ramp 10, ladder 15. You start with 60; chop trees to keep building
            </li>
            <li>
              <b>War leftovers litter the island</b> — tanks, troop trucks, helicopters, artillery, sandbag lines and fallen soldiers, deliberately far from any POI. The heavy wrecks are destructible cover: chip them, grenade them
            </li>
            <li>
              <kbd>V</kbd> opens build mode. The default <b>Auto</b> piece reads your aim: look <b>straight up while standing on a staircase</b> = <b>another staircase stacks on top</b> (chain them into the sky!), look <b>up</b> = <b>Ladder</b>, look <b>down on the ground</b> = <b>Ramp</b>, look <b>forward</b> = <b>Wall</b>, look <b>down while on a ramp / roof / container</b> (or mid-air) = <b>Platform</b>. <kbd>T</kbd> or the mouse wheel cycles manual pieces — <b>Wall</b>, <b>Door Wall</b>, <b>Floor</b>, <b>Ramp</b>, <b>Ladder</b>; <kbd>Left click</kbd> places. Walls and Doors
              are voxel now — bullets chip chunks out of them and grenades carve holes straight through; Floors bridge water; Ramps run you onto roofs; Ladders climb any wall — walk into them and keep moving
            </li>
            <li>Bullets lose power with range: SMG past 20 m, SK past 60 m, sniper past 200 m</li>
            <li>Shield takes hits first, then life. It recharges after 6 s without damage</li>
            <li>Dummies have a shield too: it takes hits first, then life, and it recharges</li>
            <li>Cyan shield cores refill your shield and give 200 XP</li>
            <li>
              Levels 2 and 4 raise shield to 304 and 456. Levels 3 and 5 upgrade the turret / bombardment / antenna
            </li>
            <li><kbd>E</kbd> summons a turret. Reload with light ammo or pick up and relocate</li>
            <li>The red dummy shoots back. Teal dummies patrol, spot you, and take cover</li>
            <li><kbd>R</kbd> reload, <kbd>1</kbd> <kbd>2</kbd> or <kbd>Q</kbd> switch weapon slot, <kbd>Esc</kbd> pause</li>
            <li>
              <kbd>G</kbd> arms the selected grenade, right click throws. Hold <kbd>G</kbd> and scroll to pick Blast, Fire or Smoke
            </li>
            <li><kbd>B</kbd> opens the inventory: weapons, ammo, grenades, and dummy settings</li>
            <li>Barrage: <kbd>E</kbd> arms bombardment, right click calls it. Grenade pack clusters on death</li>
            <li>
              <b>Antenna</b> runs on 100 life. Passive minimap (top right): tap it or press <kbd>M</kbd> for the
              simplified tactical map. <kbd>E</kbd> plants a 300 HP scanner for 60 s — every enemy shows on map
              and minimap until it powers down or gets shot out. Enemy shooters prioritise it when it is closer
              than you
            </li>
          </ul>
          <ul className="controls touch-only">
            <li>Left stick to move. Push fully forward to run</li>
            <li>Slide the screen to look</li>
            <li>Hold AIM to aim and turn the view</li>
            <li>Tap slider to jump. Slide left/right to roll, down to crouch — while running it slides</li>
            <li>Tap GRENADE to arm, tap AIM to throw. Hold GRENADE and slide up to pick kind</li>
            <li>
              Tap WALL to arm build mode, then tap AIM to place. Auto reads your aim — look straight up on a staircase = another staircase on top, look up = ladder, look down on the ground = ramp, look forward = wall, look down from a ramp / roof = platform. Double-tap WALL to cycle pieces manually
            </li>
            <li>Trees are voxelized: shoot or blast them for WOOD — the fuel for every wooden build (the plate under the minimap shows your purse)</li>
            <li>War wrecks — tanks, trucks, helicopters, skeletons — dot the island away from the POIs. They are destructible cover</li>
            <li>Wade into the sea: you slow down, then swim. Hold crouch to dive, tap jump to stroke up</li>
            <li>The top compass shows the nearest landmarks with distances — edge-pinned chips show which way to turn. Follow the port chips (PIER, YARD, DOCK, LIGHT) for the best loot</li>
            <li>Dust, mud and gravel routes run between the port gate and every POI — follow the tan / brown corridors instead of bushwhacking</li>
            <li>Tap INVENTORY to purchase weapons, ammo and customize dummies</li>
            <li>Antenna recon: tap the round minimap (top right) for the full map. Tap ANTENNA to start the 60 s enemy scan — it has 300 HP, so guard it</li>
          </ul>
          <button className="btn" id="btn" type="button">
            Click to resume
          </button>
        </div>
      </div>

      {/* Tactical map overlay (Antenna character) */}
      <div className="overlay map-overlay" id="mapOverlay" role="dialog" aria-modal="true" aria-labelledby="mapTitle" hidden>
        <div className="card map-card">
          <div className="map-head">
            <div>
              <div className="eyebrow">Recon</div>
              <h1 id="mapTitle">Tactical map</h1>
            </div>
            <div className="map-status" id="mapStatus">
              Scan offline
            </div>
          </div>
          <div className="map-wrap">
            <canvas id="mapCanvas" width={900} height={900} aria-label="Simplified map of the island" />
          </div>
          <div className="map-legend">
            <span>
              <i className="lg lg-you" /> You
            </span>
            <span>
              <i className="lg lg-ant" /> Antenna
            </span>
            <span>
              <i className="lg lg-enemy" /> Enemy (while scanning)
            </span>
            <span>
              <i className="lg lg-mark" /> Landmark
            </span>
          </div>
          <button className="btn" id="mapClose" type="button">
            Close map
          </button>
        </div>
      </div>

      {/* Inventory & Dummy Settings Modal */}
      <div className="overlay inventory" id="inventory" role="dialog" aria-modal="true" aria-labelledby="inventoryTitle" hidden>
        <div className="card inventory-card">
          <div className="inventory-head">
            <div>
              <div className="eyebrow" id="inventoryMode">
                Test range
              </div>
              <h1 id="inventoryTitle">Inventory</h1>
            </div>
            <div className="inventory-cr">
              <span id="inventoryCredits">300</span>
              <small>credits</small>
            </div>
          </div>
          <div className="inventory-body">
            <section className="inventory-sec">
              <h2 className="menu-label">Weapons</h2>
              <div className="inventory-list" id="inventoryWeapons" />
            </section>
            <section className="inventory-sec">
              <h2 className="menu-label">Ammo and grenades</h2>
              <div className="inventory-list" id="inventoryAmmo" />
            </section>
            <section className="inventory-sec" id="dummySec">
              <h2 className="menu-label">Dummies</h2>
              <div className="inventory-row">
                <span>Shield</span>
                <div className="seg" id="segShield" />
              </div>
              <div className="inventory-row">
                <span>Shoots back</span>
                <div className="seg" id="segShoot" />
              </div>
            </section>
          </div>
          <div className="inventory-actions">
            <button className="btn" id="inventoryClose" type="button">
              Close inventory
            </button>
            <button className="btn btn-menu" id="inventoryReturnMenu" type="button">
              Return to Menu
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
