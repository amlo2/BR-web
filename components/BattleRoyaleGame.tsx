'use client';

import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import {
  powerAt,
  shotDamage,
  blastShare,
  calculateXpProgression,
  calculateShieldRegen,
  LEVEL_COST,
  MAX_LEVEL,
  isCoverBlocked,
  calculateStructureDamage,
  calculateVoxelImpulse,
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
    const buildWallBtn = $('buildWallBtn');
    const touchBuildBtn = $('touchBuildBtn');

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
        new THREE.MeshLambertMaterial({ color: 0x1d6e9c, transparent: true, opacity: 0.55, depthWrite: false })
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
    const HARBOR_SPAWN = { x: 0, z: 0 };
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
      let sum = 0;
      let amp = 1;
      let norm = 0;
      let fq = 1;
      for (let o = 0; o < 4; o++) {
        sum += amp * gradNoise(x * fq, z * fq, s + o * 31);
        norm += amp;
        amp *= 0.5;
        fq *= 2.03;
      }
      return sum / norm;
    }

    const TERRAIN_HEIGHT = 24;
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

    function seaDist(x: number, z: number) {
      const base = (x + z - SEA_C) / Math.SQRT2;
      if (base < -(SEA_WARP + 200) || base > SEA_WARP + 300) return base;
      return base + SEA_WARP * fbm(x / SEA_SPAN, z / SEA_SPAN, terrainSeed + 500);
    }

    function terrainHeight(x: number, z: number) {
      const keep = THREE.MathUtils.smoothstep(Math.hypot(x - HARBOR_SPAWN.x, z - HARBOR_SPAWN.z), 8, 60);
      const land = keep * Math.max(0.3, TERRAIN_LIFT + TERRAIN_HEIGHT * fbm(x / TERRAIN_SPAN, z / TERRAIN_SPAN, terrainSeed));
      const d = seaDist(x, z);
      const inland = THREE.MathUtils.smoothstep(-d, 10, 110);
      const shore = land * inland + BEACH_Y * (1 - inland);
      const bed = WATER_Y - SEA_DEPTH * THREE.MathUtils.smoothstep(d, 0, 200);
      return shore + (bed - shore) * THREE.MathUtils.smoothstep(d, -10, 10);
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
    const TILE_LOW = new THREE.Color(0x557d42);
    const TILE_HIGH = new THREE.Color(0x9a9a86);
    const TILE_SAND = new THREE.Color(0xd8c48f);
    const TILE_DEEP = new THREE.Color(0x2f5d70);
    const tiles = new Map<string, { mesh: THREE.Mesh; cx: number; cz: number }>();

    const seaMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2 * (HARBOR_HALF + TERRAIN_MARGIN), 2 * (HARBOR_HALF + TERRAIN_MARGIN)),
      new THREE.MeshLambertMaterial({ color: 0x2f79a8, transparent: true, opacity: 0.7, depthWrite: false })
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
          c.copy(TILE_LOW).lerp(TILE_HIGH, THREE.MathUtils.clamp((h + 6) / 22, 0, 1));
          const coast = 1 - THREE.MathUtils.smoothstep(Math.abs(seaDist(x0 + i * TILE_STEP, z0 + j * TILE_STEP)), 12, 60);
          c.lerp(TILE_SAND, coast);
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
      tiles.set(tx + ',' + tz, { mesh, cx: (tx + 0.5) * TILE, cz: (tz + 0.5) * TILE });
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
          scene.remove(t.mesh);
          t.mesh.geometry.dispose();
          tiles.delete(key);
        }
      }
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
    }
    const solids: SolidBox[] = [];
    const shootable: THREE.Object3D[] = [];

    // ----------------------------------------------------
    // Fortnite-Style Physical Voxel Destruction & Building
    // ----------------------------------------------------
    interface DestructibleObject {
      id: string;
      mesh: THREE.Object3D;
      solid: SolidBox;
      hp: number;
      maxHp: number;
      kind: 'crate' | 'wood' | 'building' | 'brick' | 'metal';
      color: number | THREE.Color;
      bounds: { x: number; y: number; z: number; w: number; h: number; d: number };
      healthBarGroup?: THREE.Group;
      healthBarFill?: THREE.Mesh;
      healthBarTimer?: number;
    }

    const destructibles = new Map<THREE.Object3D, DestructibleObject>();
    const solidToDestructible = new Map<SolidBox, DestructibleObject>();

    interface VoxelDebris {
      mesh: THREE.Mesh;
      vx: number;
      vy: number;
      vz: number;
      rx: number;
      ry: number;
      rz: number;
      t: number;
      life: number;
      baseScaleX: number;
      baseScaleY: number;
      baseScaleZ: number;
    }
    const activeVoxels: VoxelDebris[] = [];
    const sharedVoxelGeo = new THREE.BoxGeometry(1, 1, 1);

    interface DamagePopup {
      sprite: THREE.Sprite;
      texture: THREE.CanvasTexture;
      mat: THREE.SpriteMaterial;
      t: number;
      life: number;
      vy: number;
    }
    const damagePopups: DamagePopup[] = [];

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
    function showDamagePopup(text: string, pos: THREE.Vector3, color = '#facc15', isBig = false) {
      if (typeof document === 'undefined') return;
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
      world.add(sprite);
      damagePopups.push({ sprite, texture, mat, t: 0, life: 1.1, vy: 1.6 });
    }

    function registerDestructible(dest: DestructibleObject) {
      destructibles.set(dest.mesh, dest);
      solidToDestructible.set(dest.solid, dest);
      dest.mesh.userData.destructible = dest;
      // Also register children if group
      dest.mesh.traverse((child) => {
        child.userData.destructible = dest;
      });
    }

    function showHealthBar(dest: DestructibleObject) {
      if (!dest.healthBarGroup) {
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

        g.position.set(dest.bounds.x, dest.bounds.y + dest.bounds.h / 2 + 0.35, dest.bounds.z);
        world.add(g);
        dest.healthBarGroup = g;
        dest.healthBarFill = fill;
      }
      dest.healthBarTimer = 3.0;
      const pct = Math.max(0, Math.min(1, dest.hp / dest.maxHp));
      if (dest.healthBarFill) {
        dest.healthBarFill.scale.x = pct;
        dest.healthBarFill.position.x = -(1 - pct) * 0.78;
        const col = pct > 0.5 ? 0x22c55e : pct > 0.25 ? 0xf59e0b : 0xef4444;
        (dest.healthBarFill.material as THREE.MeshBasicMaterial).color.setHex(col);
      }
    }

    function damageDestructible(
      dest: DestructibleObject,
      amount: number,
      hitPoint?: THREE.Vector3,
      hitDir?: THREE.Vector3,
      blastOrigin?: { x: number; y: number; z: number }
    ) {
      if (dest.hp <= 0) return;
      dest.hp = Math.max(0, dest.hp - amount);
      const pos = hitPoint ? hitPoint.clone() : new THREE.Vector3(dest.bounds.x, dest.bounds.y, dest.bounds.z);

      // Popup damage text
      const isCrit = amount >= 120;
      showDamagePopup(`${Math.round(amount)}`, pos, isCrit ? '#f59e0b' : '#fde047', isCrit);
      showHealthBar(dest);

      // Small voxel chips flying off
      const chipCount = Math.min(6, Math.max(2, Math.round(amount / 30)));
      for (let c = 0; c < chipCount; c++) {
        const chipMat = new THREE.MeshLambertMaterial({ color: dest.color });
        const chip = new THREE.Mesh(sharedVoxelGeo, chipMat);
        const sz = 0.12 + Math.random() * 0.14;
        chip.scale.set(sz, sz, sz);
        chip.position.set(
          pos.x + (Math.random() - 0.5) * 0.25,
          pos.y + (Math.random() - 0.5) * 0.25,
          pos.z + (Math.random() - 0.5) * 0.25
        );
        const impulse = calculateVoxelImpulse(
          { x: chip.position.x, y: chip.position.y, z: chip.position.z },
          blastOrigin ?? (hitPoint ? { x: hitPoint.x - (hitDir?.x ?? 0), y: hitPoint.y, z: hitPoint.z - (hitDir?.z ?? 0) } : { x: dest.bounds.x, y: dest.bounds.y, z: dest.bounds.z }),
          5 + Math.random() * 4,
          2.5
        );
        world.add(chip);
        activeVoxels.push({
          mesh: chip,
          vx: impulse.x,
          vy: impulse.y,
          vz: impulse.z,
          rx: (Math.random() - 0.5) * 14,
          ry: (Math.random() - 0.5) * 14,
          rz: (Math.random() - 0.5) * 14,
          t: 0,
          life: 2.0 + Math.random() * 1.0,
          baseScaleX: sz,
          baseScaleY: sz,
          baseScaleZ: sz,
        });
      }

      playSfx('wood_hit');

      if (dest.hp <= 0) {
        destroyDestructible(dest, blastOrigin ? blastOrigin : hitPoint ? { x: hitPoint.x, y: hitPoint.y, z: hitPoint.z } : undefined);
      }
    }

    function damageDestructibleBySolid(
      solidBox: SolidBox,
      amount: number,
      blastOrigin?: { x: number; y: number; z: number }
    ) {
      const dest = solidToDestructible.get(solidBox);
      if (dest) {
        damageDestructible(dest, amount, undefined, undefined, blastOrigin);
      }
    }

    function destroyDestructible(dest: DestructibleObject, blastOrigin?: { x: number; y: number; z: number }) {
      playSfx('shatter');
      const origin = blastOrigin ?? { x: dest.bounds.x, y: dest.bounds.y, z: dest.bounds.z };
      showDamagePopup('💥 DESTROYED', new THREE.Vector3(dest.bounds.x, dest.bounds.y + 0.5, dest.bounds.z), '#ef4444', true);

      // 1. Remove solid from collision immediately so player and projectiles can pass through
      const sIdx = solids.indexOf(dest.solid);
      if (sIdx !== -1) solids.splice(sIdx, 1);
      solidToDestructible.delete(dest.solid);

      // 2. Remove mesh from shootables and world
      dest.mesh.traverse((obj) => {
        const shIdx = shootable.indexOf(obj);
        if (shIdx !== -1) shootable.splice(shIdx, 1);
      });
      world.remove(dest.mesh);
      destructibles.delete(dest.mesh);

      // Clean up health bar
      if (dest.healthBarGroup) {
        world.remove(dest.healthBarGroup);
        dest.healthBarGroup.traverse((o: any) => {
          o.geometry?.dispose?.();
          o.material?.dispose?.();
        });
        dest.healthBarGroup = undefined;
      }

      // 3. Generate physical 3D voxel debris chunks
      const b = dest.bounds;
      const countX = Math.max(2, Math.min(4, Math.round(b.w / 0.7)));
      const countY = Math.max(2, Math.min(4, Math.round(b.h / 0.7)));
      const countZ = Math.max(1, Math.min(3, Math.round(b.d / 0.7)));
      const sizeX = b.w / countX;
      const sizeY = b.h / countY;
      const sizeZ = b.d / countZ;

      const voxelMat = new THREE.MeshLambertMaterial({
        color: dest.color,
      });

      for (let ix = 0; ix < countX; ix++) {
        for (let iy = 0; iy < countY; iy++) {
          for (let iz = 0; iz < countZ; iz++) {
            const vx0 = b.x - b.w / 2 + (ix + 0.5) * sizeX + (Math.random() - 0.5) * 0.05;
            const vy0 = b.y - b.h / 2 + (iy + 0.5) * sizeY + (Math.random() - 0.5) * 0.05;
            const vz0 = b.z - b.d / 2 + (iz + 0.5) * sizeZ + (Math.random() - 0.5) * 0.05;

            const voxelMesh = new THREE.Mesh(sharedVoxelGeo, voxelMat.clone());
            const sx = sizeX * 0.92;
            const sy = sizeY * 0.92;
            const sz = sizeZ * 0.92;
            voxelMesh.scale.set(sx, sy, sz);
            voxelMesh.position.set(vx0, vy0, vz0);
            voxelMesh.castShadow = true;
            voxelMesh.receiveShadow = true;
            world.add(voxelMesh);

            const impulse = calculateVoxelImpulse(
              { x: vx0, y: vy0, z: vz0 },
              origin,
              8.5 + Math.random() * 5.0,
              3.6
            );

            activeVoxels.push({
              mesh: voxelMesh,
              vx: impulse.x,
              vy: impulse.y,
              vz: impulse.z,
              rx: (Math.random() - 0.5) * 12,
              ry: (Math.random() - 0.5) * 12,
              rz: (Math.random() - 0.5) * 12,
              t: 0,
              life: 4.2 + Math.random() * 1.8,
              baseScaleX: sx,
              baseScaleY: sy,
              baseScaleZ: sz,
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

    // Fortnite Wooden Wall Construction
    function buildFortniteWall(x: number, y: number, z: number, angleY: number): THREE.Group {
      const g = new THREE.Group();
      const woodMat = new THREE.MeshLambertMaterial({ color: 0x925f32 });
      const woodBeamMat = new THREE.MeshLambertMaterial({ color: 0x734823 });

      // Left & Right corner posts
      const postGeo = new THREE.BoxGeometry(0.24, 2.6, 0.24);
      const leftPost = new THREE.Mesh(postGeo, woodBeamMat);
      leftPost.position.set(-1.48, 1.3, 0);
      leftPost.castShadow = true;
      leftPost.receiveShadow = true;
      g.add(leftPost);

      const rightPost = new THREE.Mesh(postGeo, woodBeamMat);
      rightPost.position.set(1.48, 1.3, 0);
      rightPost.castShadow = true;
      rightPost.receiveShadow = true;
      g.add(rightPost);

      // Top header beam
      const headerGeo = new THREE.BoxGeometry(3.2, 0.22, 0.24);
      const header = new THREE.Mesh(headerGeo, woodBeamMat);
      header.position.set(0, 2.5, 0);
      header.castShadow = true;
      header.receiveShadow = true;
      g.add(header);

      // Bottom sill beam
      const sillGeo = new THREE.BoxGeometry(3.2, 0.18, 0.24);
      const sill = new THREE.Mesh(sillGeo, woodBeamMat);
      sill.position.set(0, 0.1, 0);
      sill.castShadow = true;
      sill.receiveShadow = true;
      g.add(sill);

      // 4 horizontal wood planks
      const plankGeo = new THREE.BoxGeometry(2.76, 0.46, 0.14);
      for (let p = 0; p < 4; p++) {
        const plank = new THREE.Mesh(plankGeo, woodMat);
        plank.position.set((p % 2 === 0 ? 0.02 : -0.02), 0.45 + p * 0.52, (p % 2 === 0 ? 0.02 : -0.02));
        plank.castShadow = true;
        plank.receiveShadow = true;
        g.add(plank);
      }

      // Diagonal cross brace (Fortnite wood style)
      const braceGeo = new THREE.BoxGeometry(3.4, 0.15, 0.16);
      const brace = new THREE.Mesh(braceGeo, woodBeamMat);
      brace.position.set(0, 1.3, 0.08);
      brace.rotation.z = Math.atan2(2.4, 2.8);
      brace.castShadow = true;
      brace.receiveShadow = true;
      g.add(brace);

      g.position.set(x, y, z);
      g.rotation.y = angleY;
      world.add(g);

      // Calculate AABB for solid collision
      const cosA = Math.abs(Math.cos(angleY));
      const sinA = Math.abs(Math.sin(angleY));
      const hx = 1.6 * cosA + 0.2 * sinA;
      const hz = 1.6 * sinA + 0.2 * cosA;

      const solid: SolidBox = {
        x,
        z,
        hx: Math.max(0.4, hx),
        hz: Math.max(0.4, hz),
        top: y + 2.6,
        bottom: y,
      };
      solids.push(solid);
      g.traverse((c) => {
        if (c instanceof THREE.Mesh) shootable.push(c);
      });

      registerDestructible({
        id: 'wall_' + Math.random().toString(36).slice(2, 7),
        mesh: g,
        solid,
        hp: 250,
        maxHp: 250,
        kind: 'wood',
        color: 0x925f32,
        bounds: { x, y: y + 1.3, z, w: 3.2, h: 2.6, d: 0.4 },
      });

      playSfx('build');
      return g;
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
    world.add(previewMesh);

    function toggleBuildWall(forceState?: boolean) {
      if (!running() || playerDown) return;
      buildMode = forceState !== undefined ? forceState : !buildMode;
      previewMesh.visible = buildMode;
      const buildBtnEl = $('buildWallBtn');
      if (buildBtnEl) buildBtnEl.classList.toggle('active', buildMode);
      const touchBuildEl = $('touchBuildBtn');
      if (touchBuildEl) touchBuildEl.classList.toggle('active', buildMode);

      if (buildMode) {
        showMessage('🧱 Build Mode: [LEFT CLICK / TAP] Place Wall (250 HP) | [V / RIGHT CLICK] Cancel', 3.0);
        playSfx('build');
      } else {
        setStatus('');
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
      const py = groundAt(px, pz);
      const angle = Math.atan2(forward.x, forward.z);

      buildFortniteWall(px, py, pz, angle);
      showMessage('🧱 Wall deployed! (250 HP) Take cover from gunfire & grenades!', 2.5);
      toggleBuildWall(false);
    }

    function updateVoxels(dt: number) {
      for (let i = activeVoxels.length - 1; i >= 0; i--) {
        const v = activeVoxels[i];
        v.t += dt;
        v.vy -= 22 * dt;
        v.mesh.position.x += v.vx * dt;
        v.mesh.position.z += v.vz * dt;
        v.mesh.position.y += v.vy * dt;
        v.mesh.rotation.x += v.rx * dt;
        v.mesh.rotation.y += v.ry * dt;
        v.mesh.rotation.z += v.rz * dt;

        const gy = groundAt(v.mesh.position.x, v.mesh.position.z);
        const floorY = gy + v.baseScaleY * 0.5;
        if (v.mesh.position.y < floorY) {
          v.mesh.position.y = floorY;
          if (v.vy < -1.5) {
            v.vy = -v.vy * 0.35;
            v.vx *= 0.65;
            v.vz *= 0.65;
            v.rx *= 0.6;
            v.rz *= 0.6;
          } else {
            v.vy = 0;
            const k = Math.exp(-6 * dt);
            v.vx *= k;
            v.vz *= k;
            v.rx *= k;
            v.rz *= k;
          }
        }

        if (v.t > v.life - 0.7) {
          const s = Math.max(0.01, (v.life - v.t) / 0.7);
          v.mesh.scale.set(v.baseScaleX * s, v.baseScaleY * s, v.baseScaleZ * s);
        }

        if (v.t >= v.life) {
          world.remove(v.mesh);
          (v.mesh.material as any)?.dispose?.();
          activeVoxels.splice(i, 1);
        }
      }
    }

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
          world.remove(p.sprite);
          p.mat.dispose();
          p.texture.dispose();
          damagePopups.splice(i, 1);
        }
      }

      // 2. Update health bar timers and orientation
      for (const dest of destructibles.values()) {
        if (dest.healthBarGroup) {
          dest.healthBarGroup.quaternion.copy(camera.quaternion);
          if (dest.healthBarTimer !== undefined) {
            dest.healthBarTimer -= dt;
            if (dest.healthBarTimer <= 0) {
              dest.healthBarGroup.visible = false;
            } else {
              dest.healthBarGroup.visible = true;
            }
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
        const py = groundAt(px, pz);
        previewMesh.position.set(px, py + 1.3, pz);
        previewMesh.rotation.y = Math.atan2(forward.x, forward.z);
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
    }

    function addCrate(x: number, z: number, w: number, h: number, depth: number, color: THREE.Color) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, depth), new THREE.MeshLambertMaterial({ color }));
      mesh.position.set(x, h / 2, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      world.add(mesh);
      const solid: SolidBox = { x, z, hx: w / 2, hz: depth / 2, top: h };
      solids.push(solid);
      shootable.push(mesh);
      registerDestructible({
        id: 'crate_' + Math.random().toString(36).slice(2, 7),
        mesh,
        solid,
        hp: 120,
        maxHp: 120,
        kind: 'crate',
        color,
        bounds: { x, y: h / 2, z, w, h, d: depth },
      });
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

    const crouchHeld = () => keys.has('KeyC') || sliderTouch?.down === true;

    function updateStance(dt: number, swimming: boolean) {
      const wanted = slide ? SLIDE_EYE : crouchHeld() && !swimming && !climb ? CROUCH_EYE : EYE;
      const feet = camera.position.y - eyeH;
      const target = Math.min(wanted, headLimit(camera.position.x, camera.position.z, feet));
      setEye(eyeH + (target - eyeH) * Math.min(1, 12 * dt));
    }

    // Water & swimming
    const WADE_SLOW = 0.6;
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
      const f = axis('KeyW', 'KeyS') - stick.y;
      const s = axis('KeyD', 'KeyA') + stick.x;
      const len = Math.hypot(f, s);
      const { wet, swimming } = waterState();
      moving = len > 0 && !climb;
      sprinting = moving && !wet && (keys.has('ShiftLeft') || keys.has('ShiftRight') || -stick.y >= STICK_RUN);

      const wx = len > 0 ? (-Math.sin(yaw) * f + Math.cos(yaw) * s) / len : 0;
      const wz = len > 0 ? (-Math.cos(yaw) * f - Math.sin(yaw) * s) / len : 0;
      const onGround = grounded && !swimming && !climb;
      const triggerSlide =
        (slideReq || (sliderTouch?.down && !sliderTouch?.slid)) && !slide && !roll && moving && onGround;
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
        const speed = (sprinting ? SPRINT : WALK) * boost * (current ? 1 : UNARMED_SPEED) * (swimming ? SWIM_SLOW : wet ? WADE_SLOW : 1);
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

      for (const b of solids) {
        if (b.top > camera.position.y - eyeH + 0.05 && (b.bottom ?? 0) < camera.position.y + 0.2) {
          pushOut(b);
        }
      }

      if (slide && (camera.position.x - slide.x0) * slide.dx + (camera.position.z - slide.z0) * slide.dz < 0.5 * slide.step) {
        slide = null;
      }
      if (!roll) updateStance(dt, swimming);

      const feet = camera.position.y - eyeH;
      const wantClimb =
        !climb &&
        ((!grounded && vy > -12) ||
          (grounded && (keys.has('Space') || jumpTap || keys.has('KeyW') || -stick.y > 0.35)));
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
      if (!grounded) {
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
      if (isHeadless) return;
      if (!overlay || !btn) return;
      overlay.hidden = false;
      btn.textContent = touchDevice ? 'Tap to resume' : 'Click to resume';
      keys.clear();
      mouseHeld = aimMouse = false;
      releaseTouch();
      document.exitPointerLock?.();
    }

    overlay?.addEventListener('click', () => {
      overlay.hidden = true;
      canvas?.requestPointerLock?.()?.catch?.(() => {});
    });

    const onPointerLockChange = () => {
      locked = document.pointerLockElement === canvas;
      if (!locked && running() && !isHeadless) showPause();
    };
    document.addEventListener('pointerlockchange', onPointerLockChange);

    const onKeyDown = (e: KeyboardEvent) => {
      if (inventoryEl && !inventoryEl.hidden) {
        if (e.code === 'Escape' || e.code === 'KeyB') closeInventory();
        return;
      }
      if (e.code === 'Escape') {
        if (running()) showPause();
        return;
      }
      if (!running()) return;
      if (e.code === 'Space') e.preventDefault();
      keys.add(e.code);
      if (e.code === 'KeyC' && !e.repeat) slideReq = true;
      if (e.code === 'KeyZ' && !e.repeat) rollReq = -1;
      if (e.code === 'KeyX' && !e.repeat) rollReq = 1;
      if (e.code === 'KeyR') startReload();
      if (e.code === 'KeyF') forcePick();
      if (e.code === 'Digit1' && !e.repeat) {
        if (buildMode) toggleBuildWall(false);
        pressSlot(0);
      }
      if (e.code === 'Digit2' && !e.repeat) {
        if (buildMode) toggleBuildWall(false);
        pressSlot(1);
      }
      if (e.code === 'KeyV' && !e.repeat) toggleBuildWall();
      if (e.code === 'KeyQ' && !e.repeat) toggleBuildWall();
      if (e.code === 'KeyE' && (!e.repeat || character !== 'barrage')) {
        if (buildMode) toggleBuildWall(false);
        primaryAction();
      }
      if (e.code === 'KeyG' && !e.repeat) {
        if (buildMode) toggleBuildWall(false);
        grenadeDown('key', 'KeyG', null);
      }
      if (gPress?.open && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) grenadeWheel(e.code === 'ArrowUp' ? 1 : -1);
      if (e.code === 'KeyB' && !e.repeat) openInventory();
    };

    const onKeyUp = (e: KeyboardEvent) => {
      keys.delete(e.code);
      if (e.code === 'Digit1') releaseSlot(0);
      if (e.code === 'Digit2') releaseSlot(1);
      if (e.code === 'KeyG') grenadeUp('key', 'KeyG');
    };

    const onMouseDown = (e: MouseEvent) => {
      if (!running()) return;
      getAudio(); // Ensure audio context is running on user interaction
      if (buildMode) {
        if (e.button === 0) {
          placeWall();
          return;
        }
        if (e.button === 2) {
          toggleBuildWall(false);
          return;
        }
      }
      if (inRect(sliderEl, e.clientX, e.clientY, 6)) {
        sliderTouch = { id: -1, x0: e.clientX, y0: e.clientY, committed: false, down: false };
        sliderEl?.classList.add('is-pressed');
        return;
      }
      if (e.button === 0) {
        mouseHeld = true;
        shoot();
      }
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
      }
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!running()) return;
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
            if (moving) slideReq = true;
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

    function enterHarbor() {
      world.visible = false;
      dummies.length = 0;
      spots.length = 0;
      solids.length = 0;
      shootable.length = 0;
      pickups.length = 0;
      BUILDINGS.length = 0;
      terrainSeed = 1 + Math.floor(Math.random() * 1000000);
      for (const t of tiles.values()) {
        scene.remove(t.mesh);
        t.mesh.geometry.dispose();
      }
      tiles.clear();
      mapHalf = HARBOR_HALF;
      terrainOn = true;
      seaMesh.visible = true;
      ground.visible = false;
      grid.visible = false;
      if (inventoryModeEl) inventoryModeEl.textContent = 'Harbor';
      if (dummySecEl) dummySecEl.hidden = true;
      spawn = HARBOR_SPAWN;
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
      streamTerrain(true);
    }

    // Main menu & Character Pick
    const modeBtns = Array.from(document.querySelectorAll('.mode')) as HTMLButtonElement[];
    const charBtns = Array.from(document.querySelectorAll('.char')) as HTMLButtonElement[];
    let selectedMode = 'range';

    function pickOne(buttons: HTMLButtonElement[], chosen: HTMLButtonElement) {
      for (const b of buttons) b.setAttribute('aria-checked', String(b === chosen));
    }

    modeBtns.forEach((b) =>
      b.addEventListener('click', () => {
        if (b.disabled) return;
        selectedMode = b.dataset.mode || 'range';
        pickOne(modeBtns, b);
      })
    );

    charBtns.forEach((b) =>
      b.addEventListener('click', () => {
        pickOne(charBtns, b);
        character = b.dataset.char || 'bulwark';
        applyCharacter();
      })
    );

    function startGame() {
      if (selectedMode === 'harbor') enterHarbor();
      else if (selectedMode !== 'range') return;
      if (menuEl) menuEl.hidden = true;
      canvas?.requestPointerLock?.()?.catch?.(() => {});
    }

    playBtn?.addEventListener('click', startGame);

    buildWallBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      getAudio();
      toggleBuildWall();
    });
    touchBuildBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      getAudio();
      toggleBuildWall();
    });

    // Check for ?autostart=1 query param (Ultra Mode requirement)
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.get('autostart') === '1') {
        setTimeout(startGame, 100);
      }
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
      if (near(stickBase, 1.5)) return 'stick';
      if (near(aimBtn, 1.2)) return 'aim';
      if (near(turretEl, 1)) return 'turret';
      if (inRect(gBtnEl, x, y, 12)) return 'grenade';
      if (inRect(touchBuildBtn, x, y, 10)) return 'build';
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
          if (moving) slideReq = true;
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
      if (s && !s.committed) jumpTap = true;
    }

    const onTouchStart = (e: TouchEvent) => {
      if (!running()) return;
      e.preventDefault();
      getAudio();
      for (const t of Array.from(e.changedTouches)) {
        let role = roleAt(t.clientX, t.clientY);
        if (role === 'build') {
          toggleBuildWall();
          touchBuildBtn?.classList.add('is-pressed');
          setTimeout(() => touchBuildBtn?.classList.remove('is-pressed'), 120);
          continue;
        }
        if (buildMode && role === 'look') {
          placeWall();
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
    let character = 'bulwark';
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
      if (!w) return;
      if (w !== current) {
        equip(w);
        return;
      }
      slotHold = { i, t: 0, held: false };
    }

    function releaseSlot(i: number) {
      if (!slotHold || slotHold.i !== i) return;
      const held = slotHold.held;
      slotHold = null;
      if (!held && current && slots[i] === current) {
        putAway();
        refreshHud();
        refreshSlots();
      }
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

    function shoot() {
      const w = current;
      if (!w || cooldown > 0 || reloadT > 0 || roll) return;
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
      let hit = raycaster.intersectObjects(shootable, false)[0];
      const from = w.muzzle.getWorldPosition(new THREE.Vector3());
      let reach = hit ? hit.distance : 150;
      const gc = shotCut(raycaster.ray, reach);
      if (gc < reach) {
        reach = gc;
        hit = null as any;
      }
      const sd = smokeDist(raycaster.ray.origin, raycaster.ray.direction, reach);
      const to =
        sd < Infinity
          ? raycaster.ray.at(sd, new THREE.Vector3())
          : hit
          ? hit.point
          : raycaster.ray.at(reach, new THREE.Vector3());
      tracer(from, to);
      if (sd === Infinity && hit?.object) {
        if (hit.object.userData.dummy) {
          const s = shotDamage(w, hit.distance);
          hitDummy(hit.object.userData.dummy, s.dmg, s.pen);
        } else {
          const dest = hit.object.userData.destructible || (hit.object.parent && hit.object.parent.userData.destructible);
          if (dest) {
            const s = shotDamage(w, hit.distance);
            const structDmg = calculateStructureDamage(w.kind || 'sk', s.dmg);
            damageDestructible(dest, structDmg, hit.point, raycaster.ray.direction);
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
      const hit = raycaster.intersectObjects(shootable, false)[0];
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
      const aimed = aiming() && !!w;
      const prompt = pickOffer && !touchDevice ? `F to pick up ${WEAPONS[pickOffer.kind]?.name || ''}` : '';
      setStatus(msgT > 0 ? msgText : reloading ? 'Reloading' : prompt || (aimed ? 'Aiming' : w ? '' : 'Unarmed'));

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
      if (w) w.gun.visible = !scoped;

      bobAmp = THREE.MathUtils.lerp(bobAmp, moving && !slide && !roll ? 1 : 0, 1 - Math.exp(-8 * dt));
      if (moving) bobT += dt * (sprinting ? 14 : 9);
      const calm = (1 - 0.8 * aimT) * bobAmp;
      tuck = THREE.MathUtils.lerp(tuck, slide ? 1 : 0, 1 - Math.exp(-10 * dt));
      if (w) {
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
      updateBody(w, dt);
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

    function bBox(B: any, axisName: string, f0: number, f1: number, a0: number, a1: number, y0: number, y1: number, mat: THREE.Material) {
      const w = turnBox(B, ...spanOf(axisName, f0, f1, a0, a1));
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w.hx * 2, y1 - y0, w.hz * 2), mat);
      mesh.position.set(w.x, (y0 + y1) / 2, w.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      world.add(mesh);
      const solid: SolidBox = { x: w.x, z: w.z, hx: w.hx, hz: w.hz, top: y1, bottom: y0 };
      solids.push(solid);
      shootable.push(mesh);
      registerDestructible({
        id: 'wall_' + Math.random().toString(36).slice(2, 7),
        mesh,
        solid,
        hp: 280,
        maxHp: 280,
        kind: 'building',
        color: (mat as any).color ? (mat as any).color : 0x7c8594,
        bounds: { x: w.x, y: (y0 + y1) / 2, z: w.z, w: w.hx * 2, h: y1 - y0, d: w.hz * 2 },
      });
    }

    function bPane(B: any, axisName: string, f0: number, f1: number, a0: number, a1: number, y0: number, y1: number) {
      const fm = (f0 + f1) / 2;
      const w = turnBox(B, ...spanOf(axisName, fm, fm, a0, a1));
      const m = new THREE.Mesh(new THREE.PlaneGeometry(2 * Math.max(w.hx, w.hz), y1 - y0), bmGlass);
      m.position.set(w.x, (y0 + y1) / 2, w.z);
      m.rotation.y = w.hx > w.hz ? 0 : Math.PI / 2;
      world.add(m);
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
      mat: THREE.Material
    ) {
      let at = a0;
      for (const o of openings.slice().sort((p, q) => p.a - q.a)) {
        if (o.a > at) bBox(B, axisName, f0, f1, at, o.a, y0, y1, mat);
        if (o.sill > y0) bBox(B, axisName, f0, f1, o.a, o.b, y0, o.sill, mat);
        if (o.head < y1) bBox(B, axisName, f0, f1, o.a, o.b, o.head, y1, mat);
        if (o.sill > y0 && o.glass !== false) bPane(B, axisName, f0, f1, o.a, o.b, o.sill, o.head);
        at = o.b;
      }
      if (at < a1) bBox(B, axisName, f0, f1, at, a1, y0, y1, mat);
    }

    const holes = (pairs: number[][], sill: number, head: number, glass?: boolean) =>
      pairs.map(([a, b]) => ({ a, b, sill, head, glass }));

    function bGable(B: any, u0: number, u1: number, v0: number, v1: number, eaveY: number, ridgeY: number, mat: THREE.Material) {
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
      world.add(mesh);
      shootable.push(mesh);
    }

    function buildHouse(B: any) {
      const hx = 6;
      const hz = 4.5;
      const T = 0.4;
      const FLOOR = 3.2;
      const ROOF = 6.4;
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

      bWall(B, 'z', L, iL, N, S, 0, FLOOR, holes(winSide, 0.9, 2.2), bmWall);
      bWall(B, 'z', iR, R, N, S, 0, FLOOR, holes(winSide, 0.9, 2.2), bmWall);
      bWall(B, 'x', N, iN, L, R, 0, FLOOR, holes(winBack, 0.9, 2.2), bmWall);
      bWall(B, 'x', iS, S, L, R, 0, FLOOR, [...holes(winBack, 0.9, 2.2), { a: -1, b: 1, sill: 0, head: 2.4 }], bmWall);

      bWall(B, 'z', L, iL, N, S, FLOOR, ROOF, holes(winSide, 4.1, 5.5), bmWall);
      bWall(B, 'z', iR, R, N, S, FLOOR, ROOF, holes(winSide, 4.1, 5.5), bmWall);
      bWall(B, 'x', N, iN, L, R, FLOOR, ROOF, holes(winBack, 4.1, 5.5), bmWall);
      bWall(B, 'x', iS, S, L, R, FLOOR, ROOF, holes(winBack, 4.1, 5.5), bmWall);

      const STEPS = 10;
      const RISE = 0.32;
      const RUN = 0.3;
      const zs = iS - 0.8;
      for (let i = 0; i < STEPS; i++) {
        bBox(B, 'z', iL + 0.4, iL + 1.6, zs - (i + 1) * RUN, zs - i * RUN, 0, (i + 1) * RISE, bmStair);
      }

      const edgeZ = zs - STEPS * RUN;
      bBox(B, 'x', iN, edgeZ, iL, iR, FLOOR - 0.4, FLOOR, bmSlab);
      bBox(B, 'x', edgeZ, iS, iL + 2.2, iR, FLOOR - 0.4, FLOOR, bmSlab);
      bBox(B, 'x', N, S, L, R, ROOF, ROOF + 0.3, bmRoof);
      return { u: 0, v: S, nu: 0, nv: 1 };
    }

    function buildCottage(B: any) {
      const hx = 4.5;
      const hz = 3.5;
      const T = 0.3;
      const H = 3.0;
      const SLAB = 0.2;
      const OVER = 0.4;
      const PEAK = 2.2;
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

      bWall(B, 'z', L, iL, N, S, 0, H, holes(winSide, 0.9, 2.1), bmCream);
      bWall(B, 'z', iR, R, N, S, 0, H, holes(winSide, 0.9, 2.1), bmCream);
      bWall(B, 'x', N, iN, L, R, 0, H, holes(winBack, 0.9, 2.1), bmCream);
      bWall(B, 'x', iS, S, L, R, 0, H, [...holes(winFront, 0.9, 2.1), { a: -0.6, b: 0.6, sill: 0, head: 2.1 }], bmCream);

      bBox(B, 'x', N, S, L, R, H, H + SLAB, bmSlab);
      bGable(B, L - OVER, R + OVER, N - OVER, S + OVER, H + SLAB, H + SLAB + PEAK, bmTile);

      bBox(B, 'x', -3.0, -2.0, -3.8, -1.8, 0, 0.5, bmWood);
      bBox(B, 'x', 0.6, 1.4, 1.2, 2.2, 0, 0.8, bmWood);
      return { u: 0, v: S, nu: 0, nv: 1 };
    }

    function buildBunker(B: any) {
      const hx = 5;
      const hz = 3.5;
      const T = 0.6;
      const H = 2.6;
      const SLAB = 0.4;
      const OVER = 0.4;
      const L = -hx;
      const R = hx;
      const N = -hz;
      const S = hz;
      const iL = L + T;
      const iR = R - T;
      const iN = N + T;
      const iS = S - T;
      const slits = (cs: number[]) => cs.map((c) => ({ a: c - 0.3, b: c + 0.3, sill: 1.4, head: 1.7, glass: false }));

      bWall(B, 'z', L, iL, N, S, 0, H, slits([-2.2, 0, 2.2]), bmConcrete);
      bWall(B, 'z', iR, R, N, S, 0, H, slits([-2.2, 0, 2.2]), bmConcrete);
      bWall(B, 'x', N, iN, L, R, 0, H, [], bmConcrete);
      bWall(B, 'x', iS, S, L, R, 0, H, [...slits([-3.0, 3.0]), { a: -0.7, b: 0.7, sill: 0, head: 2.1 }], bmConcrete);
      bBox(B, 'x', N - OVER, S + OVER, L - OVER, R + OVER, H, H + SLAB, bmConcreteDark);

      bBox(B, 'x', iN, iN + 0.6, -3.0, 3.0, 0, 0.5, bmWood);
      bBox(B, 'x', 0.4, 1.4, 1.5, 2.6, 0, 0.9, bmCrate);
      return { u: 0, v: S, nu: 0, nv: 1 };
    }

    function buildWarehouse(B: any) {
      const hx = 7;
      const hz = 5;
      const T = 0.4;
      const H = 5.0;
      const OVER = 0.5;
      const L = -hx;
      const R = hx;
      const N = -hz;
      const S = hz;
      const iL = L + T;
      const iR = R - T;
      const iN = N + T;
      const high = [[-3.6, -2.0], [-0.8, 0.8], [2.0, 3.6]];

      bWall(B, 'z', L, iL, N, S, 0, H, holes(high, 3.2, 4.2), bmSteel);
      bWall(B, 'z', iR, R, N, S, 0, H, holes(high, 3.2, 4.2), bmSteel);
      bWall(B, 'x', N, iN, L, R, 0, H, [{ a: -1.4, b: 1.4, sill: 0, head: 3.4 }], bmSteel);

      bBox(B, 'x', S - 0.9, S - 0.3, L + T + 0.2, L + T + 0.8, 0, H, bmSteelDark);
      bBox(B, 'x', S - 0.9, S - 0.3, R - T - 0.8, R - T - 0.2, 0, H, bmSteelDark);
      bBox(B, 'x', N - OVER, S + OVER, L - OVER, R + OVER, H, H + 0.3, bmSteelDark);

      bBox(B, 'x', -2.6, -0.6, -5.0, -3.4, 0, 1.4, bmCrate);
      bBox(B, 'x', 1.0, 2.8, 2.0, 3.4, 0, 1.4, bmCrate);
      return { u: 0, v: S, nu: 0, nv: 1 };
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
      life = LIFE_MAX;
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
        if (lifeNumEl) lifeNumEl.textContent = Math.ceil(life) + ' / ' + LIFE_MAX;
        pipEls.forEach((p, i) => p.classList.toggle('on', i < shieldLevel));
      }
      if (shieldFill) shieldFill.style.transform = 'scaleX(' + sf.toFixed(4) + ')';
      if (lifeFill) lifeFill.style.transform = 'scaleX(' + Math.max(0, life / LIFE_MAX).toFixed(4) + ')';
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
      3: { text: 'turret damage +50%', damageMult: 1.5, bomb: { dmgMult: 1.5, text: 'bombardment damage +50%' } },
      4: { text: 'your shield up to 456', shieldLevel: 3 },
      5: {
        text: 'turret fire rate +50%',
        delay: 0.4,
        bomb: { radiusMult: 1.25, shellsMult: 1.5, text: 'bombardment radius +25%, 50% more shells' },
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
      const msg = character === 'barrage' && up.bomb ? up.bomb.text : up.text;
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
      for (const dist of dists) {
        const x = camera.position.x + fx * dist;
        const z = camera.position.z + fz * dist;
        if (!nearPool(x, z, 1) && solids.every((b) => Math.abs(x - b.x) >= b.hx + 0.5 || Math.abs(z - b.z) >= b.hz + 0.5)) {
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
      customY?: number
    ) {
      const blastY = customY ?? (groundAt(x, z) + 0.35);
      const blastOrigin = { x, y: blastY, z };

      // 1. Dummies: detect walls and cover
      for (const d of dummies) {
        const dist = Math.hypot(d.group.position.x - x, d.group.position.z - z);
        if (dist < radius) {
          const dTarget = { x: d.group.position.x, y: d.group.position.y + 0.9, z: d.group.position.z };
          const cover = isCoverBlocked(blastOrigin, dTarget, solids);
          if (cover.blocked && cover.blockingBox) {
            // Wall detected between grenade and dummy! Dummy is protected behind cover
            const wallDmg = calculateStructureDamage('blast', dmg * share(dist));
            damageDestructibleBySolid(cover.blockingBox, wallDmg, blastOrigin);
          } else {
            hitDummy(d, dmg * share(dist));
          }
        }
      }

      // 2. Player: detect walls and cover
      const pd = Math.hypot(camera.position.x - x, camera.position.z - z);
      if (pd < radius) {
        const playerTarget = { x: camera.position.x, y: camera.position.y - 0.4, z: camera.position.z };
        const cover = isCoverBlocked(blastOrigin, playerTarget, solids);
        if (cover.blocked && cover.blockingBox) {
          // GRENADE DETECTED A WALL! Player is safely taking cover behind the wall!
          const wallDmg = calculateStructureDamage('blast', selfDmg * selfShare(pd));
          damageDestructibleBySolid(cover.blockingBox, wallDmg, blastOrigin);
          playSfx('cover_block');
          showMessage('🛡️ Cover blocked grenade blast! Protected behind wall!', 2.4);
          if (shieldFx) {
            shieldFx.style.background = 'rgba(56, 189, 248, 0.35)';
            shieldFx.style.opacity = '1';
            setTimeout(() => {
              if (shieldFx) {
                shieldFx.style.opacity = '0';
                shieldFx.style.background = '';
              }
            }, 220);
          }
        } else {
          // Player is exposed to blast
          hurtPlayer(selfDmg * selfShare(pd));
        }
      }

      // 3. Demolition: damage all nearby destructible structures in blast radius
      for (const dest of Array.from(destructibles.values())) {
        const dDist = Math.hypot(dest.bounds.x - x, dest.bounds.z - z);
        if (dDist < radius) {
          const structDmg = calculateStructureDamage('blast', dmg * share(dDist));
          damageDestructible(dest, structDmg, undefined, undefined, blastOrigin);
        }
      }

      const ring = new THREE.Mesh(
        shockGeo,
        new THREE.MeshBasicMaterial({ color: 0xffb020, transparent: true, opacity: 0.6, depthWrite: false })
      );
      ring.position.set(x, blastY + 0.25, z);
      scene.add(ring);
      effects.push({ kind: 'shock', mesh: ring, t: 0, life: 0.35, radius });
    }

    function blast(x: number, z: number, y?: number) {
      const G = GREN.blast;
      explode(x, z, G.radius, G.dmg, G.selfDmg, blastShare, () => 1, y);
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
          const fireOrigin = { x: e.x, y: groundAt(e.x, e.z) + 0.35, z: e.z };
          for (const d of dummies) {
            if (Math.hypot(d.group.position.x - e.x, d.group.position.z - e.z) < GREN.fire.radius) {
              const cover = isCoverBlocked(
                fireOrigin,
                { x: d.group.position.x, y: d.group.position.y + 0.9, z: d.group.position.z },
                solids
              );
              if (cover.blocked && cover.blockingBox) {
                damageDestructibleBySolid(cover.blockingBox, GREN.fire.dps * dt * 0.6, fireOrigin);
              } else {
                burnDummy(d, GREN.fire.dps * dt, GREN.fire.pen * dt);
              }
            }
          }
          if (Math.hypot(camera.position.x - e.x, camera.position.z - e.z) < GREN.fire.radius) {
            const cover = isCoverBlocked(
              fireOrigin,
              { x: camera.position.x, y: camera.position.y - 0.4, z: camera.position.z },
              solids
            );
            if (cover.blocked && cover.blockingBox) {
              damageDestructibleBySolid(cover.blockingBox, GREN.fire.dps * dt * 0.6, fireOrigin);
            } else {
              hurtPlayer(GREN.fire.dps * dt, GREN.fire.pen * dt);
            }
          }
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

    inventoryCloseEl?.addEventListener('click', closeInventory);
    inventoryBtnEl?.addEventListener('click', openInventory);

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
      if (gArmed) throwArmedGrenade();
      if (bombArmed) callBombardment();
    }

    function applyCharacter() {
      if (primaryNameEl) primaryNameEl.textContent = character === 'barrage' ? 'Bombard' : 'Turret';
      bombArmed = false;
      disarmGrenade();
      turretEl?.classList.remove('armed');
      turretKey = '';
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
    // Turret Tracker
    // ----------------------------------------------------
    const trackerEl = $('tracker');
    const trackerDirEl = $('trackerDir');
    const trackerTagEl = $('trackerTag');
    const TRACK_INSET = 64;
    const trackTop = new THREE.Vector3();
    const trackV = new THREE.Vector3();
    const trackFwd = new THREE.Vector3();
    const trackRight = new THREE.Vector3();
    const trackUp = new THREE.Vector3();

    function updateTracker() {
      if (!turret || turret.carried || !trackerEl) {
        if (trackerEl) trackerEl.hidden = true;
        return;
      }
      trackerEl.hidden = false;
      const p = turret.group.position;
      trackTop.set(p.x, p.y + 1.2, p.z);
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
        trackerEl.dataset.state = 'on';
      } else {
        const L = Math.hypot(dx, dy) || 1;
        dx /= L;
        dy /= L;
        const tx = Math.abs(dx) > 1e-9 ? (W / 2 - M) / Math.abs(dx) : Infinity;
        const ty = Math.abs(dy) > 1e-9 ? (H / 2 - M) / Math.abs(dy) : Infinity;
        const t = Math.min(tx, ty);
        sx = W / 2 + dx * t;
        sy = H / 2 + dy * t;
        trackerEl.dataset.state = 'edge';
        if (trackerDirEl) trackerDirEl.style.transform = `rotate(${(Math.atan2(dy, dx) * 180) / Math.PI + 90}deg)`;
      }
      trackerEl.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
      const text = 'Turret ' + Math.round(dist) + ' m';
      if (trackerTagEl && trackerTagEl.textContent !== text) trackerTagEl.textContent = text;
    }

    // ----------------------------------------------------
    // Dummy Update & Basic AI
    // ----------------------------------------------------
    function updateDummy(d: DummyObject, dt: number) {
      poseFigure(d, dt);
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
        updateDestructibles(dt);
        updateVoxels(dt);
        updateVitals();
        return;
      }
      movePlayer(dt);
      updatePickups(dt);
      updateWeapon(dt);
      if (mouseHeld) shoot();
      autoShoot();
      for (const d of dummies) {
        updateDummy(d, dt);
        updateAI(d, dt);
        updateShooter(d, dt);
      }
      updateTurret(dt);
      updateGrenades(dt);
      updateDestructibles(dt);
      updateVoxels(dt);
      updateVitals();
    }

    // ----------------------------------------------------
    // Headless-only test hook (never active for real players)
    // Enables automated e2e verification of grenade/cover mechanics.
    // ----------------------------------------------------
    if (isHeadless) {
      (window as any).__brTest = {
        giveGrenade: (kind: string = 'blast', n: number = 1) => {
          (grenades as any)[kind] = ((grenades as any)[kind] ?? 0) + n;
          refreshGrenades();
        },
        grenadeCounts: () => ({ ...(grenades as any) }),
        destructibleCount: () => destructibles.size,
        isPlayerDown: () => playerDown,
      };
    }

    renderer.autoClear = false;
    scene.traverse((o: any) => {
      if (o.isLight) o.layers.enable(1);
    });

    const clock = new THREE.Clock();
    let animId: number;

    function frame() {
      const dt = Math.min(clock.getDelta(), 0.05);
      if (running()) update(dt);
      applyView();
      updateTracker();
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
        WASD move &middot; Shift sprint &middot; Space jump &middot; C crouch/slide &middot; Z/X roll &middot; R reload
        &middot; 1/2/Q weapon slots &middot; E turret/bombard &middot; G grenade (hold to pick) &middot; Right click aim/call
        &middot; B inventory &middot; Esc pause
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

      {/* Fortnite Wall Build Plate (Desktop) */}
      <button
        type="button"
        className="hud build-plate"
        id="buildWallBtn"
        aria-label="Build Fortnite Wooden Wall Cover"
      >
        <div className="t-name">
          <span>🧱 Wall Cover</span>
          <kbd className="t-key">V</kbd>
        </div>
        <div className="t-state" id="buildWallState">
          250 HP &middot; Blocks Blast
        </div>
      </button>

      {/* Ammo Plate */}
      <div className="hud ammo">
        <div className="weapon" id="weapon">
          SK
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
        <div className="touch-build" id="touchBuildBtn" role="button" aria-label="Build Wall">
          <span className="tb-icon">🧱</span>
          <span className="tb-label">Wall</span>
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

      {/* Main Menu */}
      <div className="menu" id="menu" role="dialog" aria-modal="true" aria-labelledby="menuTitle">
        <div className="menu-card">
          <div className="menu-head">
            <div className="eyebrow">Main menu</div>
            <h1 id="menuTitle">Battle Royale FPS</h1>
          </div>
          <div className="menu-body">
            <section className="menu-side" aria-labelledby="charLabel">
              <h2 className="menu-label" id="charLabel">
                Character
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
                  <span className="char-name">Bulwark</span>
                  <span className="char-role">Turret specialist</span>
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
                  <span className="char-name">Barrage</span>
                  <span className="char-role">Bombardment, no grenade limit</span>
                </button>
              </div>
            </section>
            <section className="menu-main" aria-labelledby="modeLabel">
              <h2 className="menu-label" id="modeLabel">
                Mode
              </h2>
              <div className="modes" role="radiogroup" aria-labelledby="modeLabel">
                <button className="mode" type="button" role="radio" aria-checked="true" data-mode="range">
                  <span className="mode-name">Test range</span>
                  <span className="mode-tag">Ready</span>
                </button>
                <button className="mode" type="button" role="radio" aria-checked="false" data-mode="harbor">
                  <span className="mode-name">Harbor</span>
                  <span className="mode-tag">Ready</span>
                </button>
                <button className="mode" type="button" role="radio" aria-checked="false" data-mode="quarry" disabled>
                  <span className="mode-name">Quarry</span>
                  <span className="mode-tag">Coming soon</span>
                </button>
              </div>
              <button className="btn play" id="play" type="button">
                Play
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
              <kbd>C</kbd> hold to crouch, or tap while moving to slide. <kbd>Z</kbd> and <kbd>X</kbd> roll the way you are moving
            </li>
            <li>Mouse to look, hold <kbd>Left click</kbd> to fire</li>
            <li>Dummies within 15 m are shot automatically. Hold <kbd>Right click</kbd> to aim at range.</li>
            <li>Sniper: hold <kbd>Right click</kbd> to look through its 8x scope</li>
            <li>Betgun: 150 damage within 30 m. Within 10 m, 80 more skips the shield. Less damage beyond 30 m</li>
            <li>Jump into a crate in front of you to climb onto it</li>
            <li>Bullets lose power with range: SMG past 20 m, SK past 60 m, sniper past 200 m</li>
            <li>Shield takes hits first, then life. It recharges after 6 s without damage</li>
            <li>Dummies have a shield too: it takes hits first, then life, and it recharges</li>
            <li>Cyan shield cores refill your shield and give 200 XP</li>
            <li>
              Levels 2 and 4 raise shield to 304 and 456. Levels 3 and 5 upgrade the turret / bombardment
            </li>
            <li><kbd>E</kbd> summons a turret. Reload with light ammo or pick up and relocate</li>
            <li>The red dummy shoots back. Teal dummies patrol, spot you, and take cover</li>
            <li>
              <kbd>V</kbd> or <kbd>Q</kbd> toggles <b>Fortnite Wall Build</b> mode. Left click to place a wooden cover wall (250 HP) to take cover from gunfire and grenades!
            </li>
            <li>
              <b>Wall Cover Detection:</b> Grenade explosions detect walls and solid cover! Taking cover behind any wall or crate completely shields you from blast damage while the wall absorbs the explosion.
            </li>
            <li>
              <b>Physical Voxel Destruction:</b> Crates, walls, and placed structures break apart into tumbling physical voxel blocks with bouncing physics, scattering debris when shot or hit by explosions.
            </li>
            <li><kbd>R</kbd> reload, <kbd>1</kbd> <kbd>2</kbd> switch weapon slot, <kbd>Esc</kbd> pause</li>
            <li>
              <kbd>G</kbd> arms the selected grenade, right click throws. Hold <kbd>G</kbd> and scroll to pick Blast, Fire or Smoke
            </li>
            <li><kbd>B</kbd> opens the inventory: weapons, ammo, grenades, and dummy settings</li>
            <li>Barrage: <kbd>E</kbd> arms bombardment, right click calls it. Grenade pack clusters on death</li>
          </ul>
          <ul className="controls touch-only">
            <li>Left stick to move. Push fully forward to run</li>
            <li>Slide the screen to look</li>
            <li>Hold AIM to aim and turn the view</li>
            <li>Tap 🧱 WALL to enter build mode, tap screen to place cover wall</li>
            <li>Tap slider to jump. Slide left/right to roll, down to crouch/slide</li>
            <li>Tap GRENADE to arm, tap AIM to throw. Walls & crates block grenade blasts!</li>
            <li>Tap INVENTORY to purchase weapons, ammo and customize dummies</li>
          </ul>
          <button className="btn" id="btn" type="button">
            Click to resume
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
          <button className="btn" id="inventoryClose" type="button">
            Close inventory
          </button>
        </div>
      </div>
    </div>
  );
}
