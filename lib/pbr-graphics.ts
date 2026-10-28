/**
 * pbr-graphics.ts — procedural cinematic rendering toolkit for the
 * Battle Royale game. Everything here is generated at runtime on a
 * <canvas> (zero asset downloads):
 *
 *  - pbrMaterial(): converts flat Lambert-style params into a full
 *    MeshStandardMaterial with a cached PROCEDURAL PBR texture set
 *    (albedo + roughness + normal maps) built from tileable FBM noise.
 *  - makeGerstnerWater(): GPU ocean/pool shader — summed Gerstner
 *    waves displace the mesh vertically AND horizontally, fragment
 *    normals carry small-scale ripple detail, Schlick-Fresnel blends
 *    the deep body colour with the sky, swells glow with a faint
 *    subsurface teal at their tops, and only genuinely compressed
 *    crests foam over. Sun glints stay tight sparkles. Fog-aware
 *    (FogExp2 + ACES).
 *  - makeSkyDome(): atmospheric gradient sky (warm horizon → deep
 *    zenith + sun disc & glow) with DRIFTING procedural cumulus
 *    clouds, optionally tone-mapped.
 *  - buildEnvironment(): bakes the sky into a PMREM cubemap so every
 *    PBR material gets image-based ambient light and metals reflect.
 *  - makeLeafAtlas(): a 2x2 atlas of leaf-cluster sprites (lush, dry,
 *    jungle, sparse) used by the crossed 2D foliage planes.
 *  - makeContactShadowTexture(): soft radial AO blob used as vertex
 *    contact darkening under trees, bushes, boulders and props.
 *  - makeNoiseTexture(): tileable grayscale noise the water shader
 *    samples for ripple detail + foam breakup.
 */

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Tiny deterministic hash / noise (tileable value noise → FBM)
// ---------------------------------------------------------------------------

function hash2(ix: number, iy: number, seed: number): number {
  let n = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1440662683);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  n = n ^ (n >>> 16);
  return (n >>> 0) / 4294967295;
}

const fade = (t: number) => t * t * (3 - 2 * t);

/** Tileable 2D value noise: lattice wraps at `freq` so the field repeats
 *  seamlessly — required because the textures tile across the world. */
function tileNoise(x: number, y: number, freq: number, seed: number): number {
  const fx = ((x % freq) + freq) % freq;
  const fy = ((y % freq) + freq) % freq;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fade(fx - ix);
  const ty = fade(fy - iy);
  const ix1 = (ix + 1) % freq;
  const iy1 = (iy + 1) % freq;
  const a = hash2(ix, iy, seed);
  const b = hash2(ix1, iy, seed);
  const c = hash2(ix, iy1, seed);
  const d = hash2(ix1, iy1, seed);
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}

/** FBM height field, size x size samples, tileable, 0..1. */
function fbmField(size: number, cells: number, seed: number, octaves: number): Float32Array {
  const out = new Float32Array(size * size);
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const freq = cells << o; // lattice cells per texture edge
    const step = freq / size;
    for (let y = 0; y < size; y++) {
      const yy = y * step;
      for (let x = 0; x < size; x++) {
        out[y * size + x] += tileNoise(x * step, yy, freq, seed + o * 101) * amp;
      }
    }
    total += amp;
    amp *= 0.55;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

// ---------------------------------------------------------------------------
// Procedural PBR material kinds
// ---------------------------------------------------------------------------

export type PBRKind =
  | 'generic'
  | 'terrain'
  | 'grass'
  | 'foliage'
  | 'bark'
  | 'wood'
  | 'plank'
  | 'metal'
  | 'painted'
  | 'concrete'
  | 'rock'
  | 'sand'
  | 'fabric'
  | 'skin'
  | 'glass';

interface KindSpec {
  octaves: number;
  contrast: number; // albedo modulation depth
  grain: number; // fine per-pixel grain
  roughLo: number;
  roughHi: number;
  metal: number;
  normal: number; // normal-map strength
  repeat: number; // texture.repeat (per-kind, textures are cached per kind)
  warm: number; // -1 cool .. +1 warm hue shift
  cells: number; // base noise lattice density
  seed: number;
}

const KINDS: Record<PBRKind, KindSpec> = {
  generic:   { octaves: 6, contrast: 0.38, grain: 0.10, roughLo: 0.62, roughHi: 0.92, metal: 0.04, normal: 0.55, repeat: 1.6,  warm: 0.0,  cells: 8,  seed: 11 },
  terrain:   { octaves: 6, contrast: 0.52, grain: 0.12, roughLo: 0.82, roughHi: 1.00, metal: 0.0,  normal: 0.62, repeat: 0.16, warm: 0.0,  cells: 8,  seed: 27 },
  grass:     { octaves: 6, contrast: 0.55, grain: 0.13, roughLo: 0.80, roughHi: 1.00, metal: 0.0,  normal: 0.5,  repeat: 0.2,  warm: 0.05, cells: 10, seed: 33 },
  foliage:   { octaves: 6, contrast: 0.45, grain: 0.11, roughLo: 0.75, roughHi: 0.95, metal: 0.0,  normal: 0.45, repeat: 1.0,  warm: 0.05, cells: 9,  seed: 41 },
  bark:      { octaves: 5, contrast: 0.52, grain: 0.13, roughLo: 0.80, roughHi: 1.00, metal: 0.0,  normal: 0.9,  repeat: 2.0,  warm: 0.12, cells: 7,  seed: 57 },
  wood:      { octaves: 5, contrast: 0.50, grain: 0.12, roughLo: 0.62, roughHi: 0.9,  metal: 0.0,  normal: 0.6,  repeat: 1.8,  warm: 0.15, cells: 7,  seed: 63 },
  plank:     { octaves: 5, contrast: 0.55, grain: 0.13, roughLo: 0.58, roughHi: 0.88, metal: 0.0,  normal: 0.7,  repeat: 1.8,  warm: 0.12, cells: 6,  seed: 71 },
  metal:     { octaves: 5, contrast: 0.38, grain: 0.08, roughLo: 0.24, roughHi: 0.58, metal: 0.45, normal: 0.35, repeat: 2.0,  warm: -0.06, cells: 8, seed: 83 },
  painted:   { octaves: 5, contrast: 0.32, grain: 0.07, roughLo: 0.34, roughHi: 0.6,  metal: 0.28, normal: 0.3,  repeat: 2.0,  warm: 0.0,  cells: 8,  seed: 91 },
  concrete:  { octaves: 6, contrast: 0.45, grain: 0.14, roughLo: 0.68, roughHi: 0.98, metal: 0.0,  normal: 0.7,  repeat: 1.7,  warm: 0.04, cells: 8, seed: 103 },
  rock:      { octaves: 6, contrast: 0.60, grain: 0.14, roughLo: 0.66, roughHi: 1.00, metal: 0.0,  normal: 1.0,  repeat: 1.6,  warm: -0.04, cells: 7, seed: 109 },
  sand:      { octaves: 6, contrast: 0.40, grain: 0.12, roughLo: 0.85, roughHi: 1.00, metal: 0.0,  normal: 0.4,  repeat: 2.0,  warm: 0.18, cells: 9, seed: 127 },
  fabric:    { octaves: 5, contrast: 0.35, grain: 0.11, roughLo: 0.74, roughHi: 0.96, metal: 0.0,  normal: 0.4,  repeat: 2.4,  warm: 0.02, cells: 10, seed: 131 },
  skin:      { octaves: 4, contrast: 0.2,  grain: 0.06, roughLo: 0.42, roughHi: 0.62, metal: 0.0,  normal: 0.22, repeat: 3.0,  warm: 0.2,  cells: 9, seed: 139 },
  glass:     { octaves: 3, contrast: 0.10, grain: 0.02, roughLo: 0.04, roughHi: 0.12, metal: 0.06, normal: 0.1,  repeat: 1.0,  warm: -0.02, cells: 4, seed: 149 },
};

interface PBRTextures {
  map: THREE.Texture;
  roughnessMap: THREE.Texture;
  normalMap: THREE.Texture;
}

// Lite mode for software-rasterized test environments (headless Chrome /
// SwiftShader): full PBR + image-based lighting costs 2-3x frame time and
// starves the e2e suites' wall-clock budgets. Lite keeps the albedo map
// (screenshots still show the textures) but drops normal/roughness maps,
// metalness and the PMREM environment.
let LITE = false;
export function setLitePBR(on: boolean) {
  LITE = !!on;
}

const TEX_SIZE = 256;
const texCache = new Map<PBRKind, PBRTextures>();

/** Builds (and caches) the three procedural maps for a kind. All
 *  materials of one kind share one texture set — GPU memory stays
 *  bounded no matter how many materials the game spawns. */
function kindTextures(kind: PBRKind): PBRTextures {
  const hit = texCache.get(kind);
  if (hit) return hit;
  const s = KINDS[kind] ?? KINDS.generic;
  const S = TEX_SIZE;
  const hgt = fbmField(S, s.cells, s.seed, s.octaves);

  const alb = document.createElement('canvas');
  alb.width = alb.height = S;
  const aCtx = alb.getContext('2d')!;
  const aImg = aCtx.createImageData(S, S);

  const rgh = document.createElement('canvas');
  rgh.width = rgh.height = S;
  const rCtx = rgh.getContext('2d')!;
  const rImg = rCtx.createImageData(S, S);

  const norC = document.createElement('canvas');
  norC.width = norC.height = S;
  const nCtx = norC.getContext('2d')!;
  const nImg = nCtx.createImageData(S, S);

  const at = (x: number, y: number) => hgt[((y % S) + S) % S * S + (((x % S) + S) % S)];
  const strength = 2.2; // sobel gain

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const h = hgt[i];
      // albedo: BRIGHT-CENTERED noise (mean ~0.9) so the map adds grain
      // without darkening the material's own colour, plus independent
      // CHROMATIC grain per channel — hue jitter reads as far richer
      // organic surface detail than plain brightness noise.
      let v = 0.9 + (h - 0.5) * s.contrast * 1.3;
      const p = i * 4;
      const jr = 1 + (hash2(x, y, s.seed + 7) - 0.5) * s.grain * 2.6;
      const jg = 1 + (hash2(x, y, s.seed + 13) - 0.5) * s.grain * 2.6;
      const jb = 1 + (hash2(x, y, s.seed + 29) - 0.5) * s.grain * 2.6;
      v = Math.min(1.25, Math.max(0.3, v));
      aImg.data[p] = Math.round(255 * Math.min(1, v * (1 + s.warm * 0.05) * jr));
      aImg.data[p + 1] = Math.round(255 * Math.min(1, v * jg));
      aImg.data[p + 2] = Math.round(255 * Math.min(1, v * (1 - s.warm * 0.05) * jb));
      aImg.data[p + 3] = 255;
      // roughness: crevices (low height) rougher than exposed ridges
      const rough = s.roughLo + (s.roughHi - s.roughLo) * (1 - h);
      const rv = Math.round(255 * Math.min(1, Math.max(0, rough)));
      rImg.data[p] = rv;
      rImg.data[p + 1] = rv;
      rImg.data[p + 2] = rv;
      rImg.data[p + 3] = 255;
      // normal: sobel over the height field
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const nl = Math.hypot(dx, dy, 1);
      nImg.data[p] = Math.round(((-dx / nl) * 0.5 + 0.5) * 255);
      nImg.data[p + 1] = Math.round(((-dy / nl) * 0.5 + 0.5) * 255);
      nImg.data[p + 2] = Math.round((1 / nl) * 0.5 * 255 + 127.5);
      nImg.data[p + 3] = 255;
    }
  }
  aCtx.putImageData(aImg, 0, 0);
  rCtx.putImageData(rImg, 0, 0);
  nCtx.putImageData(nImg, 0, 0);

  const mk = (cv: HTMLCanvasElement, srgb: boolean) => {
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(s.repeat, s.repeat);
    t.anisotropy = 4;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };
  const set: PBRTextures = {
    map: mk(alb, true),
    roughnessMap: mk(rgh, false),
    normalMap: mk(norC, false),
  };
  texCache.set(kind, set);
  return set;
}

/**
 * Drop-in upgrade for `new THREE.MeshLambertMaterial(params)`: same
 * constructor params (colour, vertexColors, transparent, opacity, side,
 * depthWrite, emissive... all pass straight through) but the material
 * comes back as a metalness/roughness PBR surface with procedural
 * albedo + roughness + normal maps.
 */
export function pbrMaterial(
  params: THREE.MeshStandardMaterialParameters = {},
  kind: PBRKind = 'generic'
): THREE.MeshStandardMaterial {
  const s = KINDS[kind] ?? KINDS.generic;
  const m = new THREE.MeshStandardMaterial(params);
  const t = kindTextures(kind);
  m.map = t.map;
  if (!LITE) {
    m.roughnessMap = t.roughnessMap;
    m.normalMap = t.normalMap;
    m.normalScale = new THREE.Vector2(s.normal, s.normal);
  }
  // caller-provided metalness/roughness win (e.g. the viewmodel weapons
  // stay dielectric-ish so their dark paints never read as black blobs)
  if (params.metalness === undefined) m.metalness = LITE ? 0 : s.metal;
  if (params.roughness === undefined) m.roughness = 1.0;
  return m;
}

// ---------------------------------------------------------------------------
// Atmospheric sky dome (gradient + sun disc + glow)
// ---------------------------------------------------------------------------

export function makeSkyDome(opts: {
  zenith: number;
  horizon: number;
  ground: number;
  sunColor: number;
  sunDir: THREE.Vector3;
  toneMapped?: boolean;
}): THREE.ShaderMaterial {
  const u = {
    uZenith: { value: new THREE.Color(opts.zenith) },
    uHorizon: { value: new THREE.Color(opts.horizon) },
    uGround: { value: new THREE.Color(opts.ground) },
    uSunColor: { value: new THREE.Color(opts.sunColor) },
    uSunDir: { value: opts.sunDir.clone().normalize() },
    uTime: { value: 0 },
    uNoise: { value: makeNoiseTexture() },
    // Task N darkzone: 0 = bright day, 1 = storm-shroud night. The game
    // lerps this as the camera crosses into the danger zone (or a cave)
    // so the whole sky — clouds, sun disc and all — dies to near-black.
    uDark: { value: 0 },
  };
  const toneTail =
    opts.toneMapped === false
      ? ''
      : '\n#include <tonemapping_fragment>\n#include <colorspace_fragment>';
  const frag = /* glsl */ `
    uniform vec3 uZenith;
    uniform vec3 uHorizon;
    uniform vec3 uGround;
    uniform vec3 uSunColor;
    uniform vec3 uSunDir;
    uniform float uTime;
    uniform float uDark;
    uniform sampler2D uNoise;
    varying vec3 vDir;
    void main() {
      vec3 d = normalize(vDir);
      float h = clamp(d.y, -1.0, 1.0);
      vec3 col = h >= 0.0
        ? mix(uHorizon, uZenith, pow(h, 0.55))
        : mix(uHorizon, uGround, pow(-h, 0.5));
      // DRIFTING CUMULUS: project the view ray onto a virtual cloud
      // plane, sample two scrolling noise octaves and shade the cloud
      // tops with the sun's colour. The band fades clouds out at the
      // horizon and near the zenith so the dome stays a gradient first.
      if (d.y > 0.015) {
        vec2 cp = d.xz / (d.y + 0.12);
        float c1 = texture2D(uNoise, cp * 0.014 + vec2(uTime * 0.0042, uTime * 0.0017)).r;
        float c2 = texture2D(uNoise, cp * 0.052 - vec2(uTime * 0.0058, uTime * 0.0009)).r;
        float cov = smoothstep(0.52, 0.8, c1 * 0.72 + c2 * 0.38);
        float band = smoothstep(0.015, 0.09, d.y) * (1.0 - smoothstep(0.5, 0.95, d.y));
        vec3 ccol = mix(vec3(0.98, 0.99, 1.03), uSunColor, 0.2);
        col = mix(col, ccol * (0.84 + 0.32 * c2), cov * band * 0.82);
      }
      float sd = max(dot(d, normalize(uSunDir)), 0.0);
      col += uSunColor * (pow(sd, 900.0) * 3.0 + pow(sd, 9.0) * 0.18);
      // Darkzone blend: the storm shroud swallows the sky. A whisper of
      // violet stays so "black" still reads as storm, never as a bug.
      vec3 darkCol = vec3(0.010, 0.007, 0.024)
        + 0.012 * vec3(0.30, 0.16, 0.55) * (0.5 + 0.5 * sin(uTime * 0.7 + d.y * 6.0));
      col = mix(col, darkCol, clamp(uDark, 0.0, 1.0));
      gl_FragColor = vec4(col, 1.0);${toneTail}
    }
  `;
  return new THREE.ShaderMaterial({
    uniforms: u,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: frag,
  });
}

/** Bakes the given sky material into a PMREM environment map so all
 *  MeshStandardMaterials receive image-based ambient light and metals
 *  get believable reflections. Returns null if unsupported. */
export function buildEnvironment(
  renderer: THREE.WebGLRenderer,
  sky: THREE.ShaderMaterial
): THREE.Texture | null {
  try {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const sc = new THREE.Scene();
    sc.add(new THREE.Mesh(new THREE.SphereGeometry(80, 32, 16), sky));
    const rt = pmrem.fromScene(sc, 0.08, 0.5, 200);
    pmrem.dispose();
    (sc.children[0] as THREE.Mesh).geometry.dispose();
    return rt.texture;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Gerstner Waves + Fresnel water — tuned for believable open water:
// gentle rolling swell, tight sun sparkles, a whisper of teal light
// breathing through the wave tops, and foam ONLY where crests
// genuinely compress. (No milk.)
// ---------------------------------------------------------------------------

export interface GerstnerWave {
  dirDeg: number;
  steepness: number;
  wavelength: number;
}

export interface GerstnerStyle {
  deep: number; // body colour
  sky: number; // fresnel reflection colour
  sunColor: number;
  opacity: number;
  waves: GerstnerWave[];
  crest?: number; // foam crest sensitivity (default 2.2)
}

export function makeGerstnerWater(width: number, depth: number, segments: number, style: GerstnerStyle) {
  const geo = new THREE.PlaneGeometry(width, depth, segments, segments);
  geo.rotateX(-Math.PI / 2); // baked: mesh transform stays identity
  // up to four waves; missing slots become zero-steepness ghosts so the
  // shader uniforms always exist (fewer waves = calmer seas by design)
  const waves = [0, 1, 2, 3].map(
    (i) => style.waves[i] ?? ({ dirDeg: 0, steepness: 0, wavelength: 60 } as GerstnerWave)
  );
  const asVec4 = (w: GerstnerWave) => {
    const a = (w.dirDeg * Math.PI) / 180;
    return new THREE.Vector4(Math.cos(a), Math.sin(a), w.steepness, w.wavelength);
  };
  const material = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uDeep: { value: new THREE.Color(style.deep) },
        uSky: { value: new THREE.Color(style.sky) },
        uSunColor: { value: new THREE.Color(style.sunColor) },
        uSunDir: { value: new THREE.Vector3(0.45, 0.55, 0.3).normalize() },
        uOpacity: { value: style.opacity },
        uCrest: { value: style.crest ?? 2.2 },
        uWaveA: { value: asVec4(waves[0]) },
        uWaveB: { value: asVec4(waves[1]) },
        uWaveC: { value: asVec4(waves[2]) },
        uWaveD: { value: asVec4(waves[3]) },
      },
    ] as unknown as Record<string, THREE.IUniform>[]),
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uCrest;
      uniform vec4 uWaveA;
      uniform vec4 uWaveB;
      uniform vec4 uWaveC;
      uniform vec4 uWaveD;
      #include <common>
      #include <fog_pars_vertex>
      varying vec3 vWorld;
      varying vec3 vN;
      varying float vCrest;

      vec3 gerstner(vec4 w, vec3 p, inout vec3 T, inout vec3 B) {
        float k = 6.2831853 / w.w;
        float c = sqrt(9.81 / k);
        vec2 d = normalize(w.xy);
        float f = k * (dot(d, p.xz) - c * uTime);
        float a = w.z / k;
        float sf = sin(f);
        float cf = cos(f);
        T += vec3(-d.x * d.x * w.z * sf, d.x * w.z * cf, -d.x * d.y * w.z * sf);
        B += vec3(-d.x * d.y * w.z * sf, d.y * w.z * cf, -d.y * d.y * w.z * sf);
        return vec3(d.x * a * cf, a * sf, d.y * a * cf);
      }

      void main() {
        vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
        vec3 T = vec3(1.0, 0.0, 0.0);
        vec3 B = vec3(0.0, 0.0, 1.0);
        vec3 off = vec3(0.0);
        off += gerstner(uWaveA, wp, T, B);
        off += gerstner(uWaveB, wp, T, B);
        off += gerstner(uWaveC, wp, T, B);
        off += gerstner(uWaveD, wp, T, B);
        vec3 pos = wp + off;
        vN = normalize(cross(B, T));
        vCrest = clamp(length(off.xz) * uCrest, 0.0, 1.0);
        vWorld = pos;
        vec4 mvPosition = viewMatrix * vec4(pos, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uDeep;
      uniform vec3 uSky;
      uniform vec3 uSunColor;
      uniform vec3 uSunDir;
      uniform float uOpacity;
      uniform float uTime;
      uniform sampler2D uNoise;
      varying vec3 vWorld;
      varying vec3 vN;
      varying float vCrest;
      #include <common>
      #include <fog_pars_fragment>
      void main() {
        vec3 V = normalize(cameraPosition - vWorld);
        vec3 N = normalize(vN);
        if (!gl_FrontFacing) N = -N;
        // distance fade for the fine detail: ripple normals + glints
        // alias into shimmer mush far out, where fog takes over anyway
        float dR = clamp(1.0 - vFogDepth / 700.0, 0.15, 1.0);
        // small-scale ripple detail from scrolling tileable noise
        float n1 = texture2D(uNoise, vWorld.xz * 0.045 + vec2(uTime * 0.021, uTime * 0.013)).r;
        float n2 = texture2D(uNoise, vWorld.xz * 0.085 - vec2(uTime * 0.03, uTime * 0.017)).r;
        N = normalize(N + vec3(n1 * 2.0 - 1.0, 0.0, n2 * 2.0 - 1.0) * 0.22 * dR);
        // Schlick fresnel, F0 = 0.02 for water. Mix is COMPRESSED so even
        // grazing water keeps some body colour instead of reading as a
        // pale sky-milk sheet all the way to the horizon.
        float fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
        vec3 col = mix(uDeep, uSky, clamp(fres * 0.62 + 0.03, 0.0, 1.0));
        // sun glint — tight sparkle on ripple facets, gentle broad sheen
        vec3 R = reflect(-normalize(uSunDir), N);
        float spec = pow(max(dot(R, V), 0.0), 110.0);
        float sheen = pow(max(dot(R, V), 0.0), 12.0);
        col += uSunColor * (spec * 1.05 * dR + sheen * 0.12);
        // subtle body scatter variation
        col += (n1 - 0.5) * 0.05 * dR;
        // subsurface teal glow where the swell thickens toward its top —
        // light passing through the wave instead of white milk on it
        col += (uDeep * vec3(0.55, 1.35, 1.15) + vec3(0.015, 0.05, 0.04))
               * smoothstep(0.2, 0.9, vCrest) * 0.16;
        // foam ONLY on genuinely compressed crests, heavily broken up by noise
        float foam = smoothstep(0.58, 0.96, vCrest) * smoothstep(0.52, 0.86, n2) * dR;
        col = mix(col, vec3(0.93, 0.96, 0.98), foam * 0.5);
        float alpha = clamp(uOpacity + fres * 0.22 + foam * 0.1, 0.0, 1.0);
        gl_FragColor = vec4(col, alpha);
        #include <fog_fragment>
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
  });
  material.uniforms.uNoise = { value: makeNoiseTexture() };
  const mesh = new THREE.Mesh(geo, material);
  return { mesh, material };
}

// ---------------------------------------------------------------------------
// Foliage leaf atlas (2D crossed-plane foliage)
// ---------------------------------------------------------------------------

let leafAtlas: THREE.Texture | null = null;
const LEAF_QUADS = 4; // lush | dry | jungle | sparse

/** 512x512 atlas, 2x2 quadrants of leaf-cluster sprites. Quadrant
 *  selection happens through per-card UVs (see stampLeaves). */
export function makeLeafAtlasTexture(): THREE.Texture {
  if (leafAtlas) return leafAtlas;
  const S = 512;
  const H = S / 2;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d')!;
  // palettes per quadrant: [hue, sat, light] ranges + leaf count
  const pal = [
    { n: 64, h: [96, 130], s: [42, 60], l: [30, 44], long: 1.9 }, // 0 lush
    { n: 55, h: [58, 78], s: [32, 48], l: [38, 52], long: 1.7 }, // 1 dry
    { n: 70, h: [104, 142], s: [46, 62], l: [18, 32], long: 2.1 }, // 2 jungle
    { n: 34, h: [80, 100], s: [18, 30], l: [34, 46], long: 1.5 }, // 3 sparse
  ];
  const rnd = (() => {
    let s = 20260101;
    return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967295);
  })();
  for (let q = 0; q < LEAF_QUADS; q++) {
    const ox = (q & 1) * H;
    const oy = (q >> 1) * H;
    const p = pal[q];
    for (let i = 0; i < p.n; i++) {
      const ang = rnd() * Math.PI * 2;
      const rad = Math.pow(rnd(), 0.55) * H * 0.46;
      const cx = ox + H / 2 + Math.cos(ang) * rad;
      const cy = oy + H / 2 + Math.sin(ang) * rad * 0.9;
      const hue = p.h[0] + rnd() * (p.h[1] - p.h[0]);
      const sat = p.s[0] + rnd() * (p.s[1] - p.s[0]);
      const lig = p.l[0] + rnd() * (p.l[1] - p.l[0]);
      const w = 7 + rnd() * 9;
      const h = w * (p.long + rnd() * 0.5);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rnd() * Math.PI * 2);
      // leaf body
      ctx.fillStyle = `hsl(${hue} ${sat}% ${lig}%)`;
      ctx.beginPath();
      ctx.ellipse(0, 0, w, h, 0, 0, Math.PI * 2);
      ctx.fill();
      // sheen half for depth
      ctx.fillStyle = `hsl(${hue} ${sat}% ${Math.min(92, lig + 9)}%)`;
      ctx.beginPath();
      ctx.ellipse(-w * 0.2, -h * 0.18, w * 0.6, h * 0.7, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.needsUpdate = true;
  leafAtlas = t;
  return t;
}

let leafMaterial: THREE.MeshStandardMaterial | null = null;
const leafSwayUniform = { value: 0 };
/** Advances the shared wind clock that bends every leaf card. */
export function tickLeafSway(t: number) {
  leafSwayUniform.value = t;
}
/** Shared alpha-tested foliage material for the crossed 2D leaf planes.
 * WIND SWAY: each card vertex carries an `aSway` weight (0 at the
 * branch, 1 at the tip) injected through onBeforeCompile — the whole
 * forest breathes in a light breeze for the cost of two sines. */
export function makeLeafMaterial(): THREE.MeshStandardMaterial {
  if (leafMaterial) return leafMaterial;
  leafMaterial = new THREE.MeshStandardMaterial({
    map: makeLeafAtlasTexture(),
    alphaTest: 0.45,
    side: THREE.DoubleSide,
    vertexColors: true,
    roughness: 0.88,
    metalness: 0,
  });
  leafMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.uSwayT = leafSwayUniform;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float aSway;\nuniform float uSwayT;'
      )
      .replace(
        '#include <begin_vertex>',
        `vec3 transformed = vec3( position );
        float swPh = uSwayT * 1.9 + position.x * 0.31 + position.z * 0.23;
        transformed.x += ( sin( swPh ) + sin( swPh * 1.71 + 1.3 ) * 0.5 ) * 0.05 * aSway;
        transformed.z += cos( swPh * 0.83 + 0.7 ) * 0.035 * aSway;`
      );
  };
  leafMaterial.customProgramCacheKey = () => 'leaf-sway';
  return leafMaterial;
}

// ---------------------------------------------------------------------------
// Vertex contact shadows (soft AO decals)
// ---------------------------------------------------------------------------

let contactTex: THREE.Texture | null = null;
/** Soft radial black gradient used as a contact AO blob under plants,
 *  boulders and props — grounds them into the terrain visually. */
export function makeContactShadowTexture(): THREE.Texture {
  if (contactTex) return contactTex;
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(0,0,0,0.85)');
  g.addColorStop(0.45, 'rgba(0,0,0,0.45)');
  g.addColorStop(0.8, 'rgba(0,0,0,0.12)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(cv);
  t.needsUpdate = true;
  contactTex = t;
  return t;
}

let contactMat: THREE.MeshBasicMaterial | null = null;
export function makeContactShadowMaterial(): THREE.MeshBasicMaterial {
  if (contactMat) return contactMat;
  contactMat = new THREE.MeshBasicMaterial({
    map: makeContactShadowTexture(),
    transparent: true,
    depthWrite: false,
    opacity: 0.55,
    toneMapped: false,
  });
  return contactMat;
}

// ---------------------------------------------------------------------------
// Water noise + misc
// ---------------------------------------------------------------------------

let muzzleTex: THREE.Texture | null = null;
/** Muzzle-flash sprite: white-hot core, orange shell, radial streaks. */
export function makeMuzzleTexture(): THREE.Texture {
  if (muzzleTex) return muzzleTex;
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d')!;
  const c = S / 2;
  // streaks first (behind the core)
  ctx.translate(c, c);
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + 0.31;
    const len = c * (i % 2 ? 0.94 : 0.62);
    const grd = ctx.createLinearGradient(0, 0, Math.cos(a) * len, Math.sin(a) * len);
    grd.addColorStop(0, 'rgba(255,214,140,0.95)');
    grd.addColorStop(1, 'rgba(255,140,40,0)');
    ctx.strokeStyle = grd;
    ctx.lineWidth = 5 + (i % 3) * 3;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(a) * len, Math.sin(a) * len);
    ctx.stroke();
  }
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, c * 0.5);
  g.addColorStop(0, 'rgba(255,255,244,1)');
  g.addColorStop(0.35, 'rgba(255,226,150,0.9)');
  g.addColorStop(0.75, 'rgba(255,150,54,0.35)');
  g.addColorStop(1, 'rgba(255,120,30,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, c * 0.5, 0, Math.PI * 2);
  ctx.fill();
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  muzzleTex = t;
  return t;
}

let birdTex: THREE.Texture | null = null;
/** Distant gull glyph (alpha-tested) for the ambient sky birds. */
export function makeBirdTexture(): THREE.Texture {
  if (birdTex) return birdTex;
  const cv = document.createElement('canvas');
  cv.width = 128;
  cv.height = 64;
  const ctx = cv.getContext('2d')!;
  ctx.strokeStyle = '#f7f9fb';
  ctx.lineCap = 'round';
  // two swept wings meeting at a small body
  ctx.lineWidth = 9;
  ctx.beginPath();
  ctx.moveTo(6, 26);
  ctx.quadraticCurveTo(40, 4, 64, 24);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(122, 26);
  ctx.quadraticCurveTo(88, 4, 64, 24);
  ctx.stroke();
  ctx.lineWidth = 6;
  ctx.fillStyle = '#f7f9fb';
  ctx.beginPath();
  ctx.ellipse(64, 26, 9, 4.5, 0, 0, Math.PI * 2);
  ctx.fill();
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  birdTex = t;
  return t;
}

let noiseTex: THREE.Texture | null = null;
/** Tileable grayscale FBM noise for the water shader's ripples/foam. */
export function makeNoiseTexture(size = 128): THREE.Texture {
  if (noiseTex) return noiseTex;
  const f = fbmField(size, 6, 313, 4);
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = Math.round(f[i] * 255);
    const p = i * 4;
    img.data[p] = v;
    img.data[p + 1] = v;
    img.data[p + 2] = v;
    img.data[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true;
  noiseTex = t;
  return t;
}
