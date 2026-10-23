/**
 * game-math — pure combat/economy math for the Battle Royale FPS.
 *
 * Everything here is framework-free so it can be unit-tested in isolation
 * and shared between the player, dummies, turrets and grenades.
 */

/** Falloff band of a weapon: full power up to `start`, zero power at `end`. */
export type Falloff = [start: number, end: number];

export interface WeaponLike {
  /** Base damage per shot at full power. */
  damage: number;
  /** Range band over which the bullet keeps / loses its power. */
  falloff: Falloff;
  /** Shotguns carry a shield-piercing bonus at very close range. */
  shotgun?: boolean;
}

/** Grenade blast behaviour (Blast grenade). */
export const BLAST = {
  /** Radius (m) in which the blast can damage anything. */
  radius: 12,
  /** Distance (m) inside which the blast deals its full damage. */
  fullRadius: 4,
} as const;

/** Damage share of a Blast grenade at `dist` metres from the epicentre.
 * Stepped bands: 100% inside 4m, 66.7% inside 8m, 33.3% inside 12m, 0 beyond. */
export function blastShare(dist: number): number {
  if (dist <= 4) return 1.0;
  if (dist <= 8) return 2 / 3;
  if (dist <= 12) return 1 / 3;
  return 0;
}

/** Remaining bullet power (0..1) at `dist` metres for weapon `w`.
 * Stepped three-bracket falloff: 100% close, 60% mid-range, 30% far (20% for shotguns). */
export function powerAt(w: { falloff: Falloff; shotgun?: boolean }, dist: number): number {
  const [start, end] = w.falloff;
  if (dist < start) return 1.0;
  if (dist < end) return 0.6;
  return w.shotgun ? 0.2 : 0.3;
}

/** BETGUN constant config */
export const BETGUN = {
  damage: 150,
} as const;

/** Close range (m) inside which shotgun pellets pierce shields. */
const SHOTGUN_PEN_RANGE = 10;
/** Shield damage skipped by a shotgun when fired point-blank. */
const SHOTGUN_PEN_FLAT = 80;

export interface ShotResult {
  /** Damage that hits the shield first. */
  dmg: number;
  /** Damage that skips the shield entirely. */
  pen: number;
}

/** Resolve a single bullet at `dist` metres into shield + piercing damage. */
export function shotDamage(w: WeaponLike, dist: number): ShotResult {
  const power = powerAt(w, dist);
  const dmg = w.damage * power;
  // Betgun: within 10 m an extra 80 damage skips the shield.
  const pen = w.shotgun && dist <= SHOTGUN_PEN_RANGE ? SHOTGUN_PEN_FLAT : 0;
  return { dmg, pen };
}

/** Slide mechanics with exponential decay and slope momentum */
export function calculateSlideVelocity(
  t: number,
  initialSpeed = 16.5,
  decayRate = 1.15,
  slopeBonus = 0
): number {
  return initialSpeed * Math.exp(-decayRate * t) + slopeBonus;
}

/** Souls roll invulnerability frames */
export const SOULS_ROLL_IFRAMES = 0.35;

export function isRollInvulnerable(t: number): boolean {
  return t >= 0 && t < SOULS_ROLL_IFRAMES;
}

/** Souls roll camera eye height profile */
export function soulsRollEyeHeight(progress: number, standingEye = 1.7): number {
  const p = Math.max(0, Math.min(1, progress));
  const drop = Math.sin(p * Math.PI) * (standingEye - 0.45);
  return standingEye - drop;
}

/** Highest reachable level (levels 3 & 5 upgrade turret / bombardment). */
export const MAX_LEVEL = 5;

/** XP required to advance from level `n` to `n + 1` (index 0 = level 1 -> 2). */
export const LEVEL_COST: readonly number[] = [100, 300, 500, 1000];

export interface XpResult {
  newLevel: number;
  newXp: number;
  /** Every level crossed during this gain, in order. */
  levelsGained: number[];
}

/** Add `amount` XP to a player at (`level`, `xp`) and resolve level-ups. */
export function calculateXpProgression(level: number, xp: number, amount: number): XpResult {
  let newLevel = level;
  let newXp = xp + amount;
  const levelsGained: number[] = [];

  while (newLevel < MAX_LEVEL && newXp >= LEVEL_COST[newLevel - 1]) {
    newXp -= LEVEL_COST[newLevel - 1];
    newLevel += 1;
    levelsGained.push(newLevel);
  }

  if (newLevel >= MAX_LEVEL) newXp = Math.min(newXp, LEVEL_COST[MAX_LEVEL - 2]);
  return { newLevel, newXp, levelsGained };
}

/**
 * Shield recharge after `delay` seconds without taking damage.
 * Recharges `regen` (fraction of max shield) per second while standing up.
 */
export function calculateShieldRegen(
  shield: number,
  shieldMax: number,
  sinceHurt: number,
  delay: number,
  regen: number,
  dt: number,
  down: boolean
): number {
  if (down || sinceHurt < delay || shield >= shieldMax) return shield;
  return Math.min(shieldMax, shield + shieldMax * regen * dt);
}

// ----------------------------------------------------
// Fortnite-style destruction math (ported from BR-web)
// ----------------------------------------------------

/** Minimal 3D position (metres, world space). */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Axis-aligned solid box used for movement / cover / ray casts. */
export interface SolidBoxAABB {
  x: number;
  z: number;
  hx: number;
  hz: number;
  top: number;
  bottom?: number;
}

/** Slab-method segment vs AABB test: returns entry t in [0, 1] or null. */
export function segmentIntersectsBox(
  p0: Vec3Like,
  p1: Vec3Like,
  b: SolidBoxAABB
): number | null {
  const minX = b.x - b.hx;
  const maxX = b.x + b.hx;
  const minY = b.bottom ?? 0;
  const maxY = b.top;
  const minZ = b.z - b.hz;
  const maxZ = b.z + b.hz;

  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const dz = p1.z - p0.z;

  let tMin = 0;
  let tMax = 1;

  // X slab
  if (Math.abs(dx) < 1e-9) {
    if (p0.x < minX || p0.x > maxX) return null;
  } else {
    const ood = 1.0 / dx;
    let t1 = (minX - p0.x) * ood;
    let t2 = (maxX - p0.x) * ood;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }

  // Y slab
  if (Math.abs(dy) < 1e-9) {
    if (p0.y < minY || p0.y > maxY) return null;
  } else {
    const ood = 1.0 / dy;
    let t1 = (minY - p0.y) * ood;
    let t2 = (maxY - p0.y) * ood;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }

  // Z slab
  if (Math.abs(dz) < 1e-9) {
    if (p0.z < minZ || p0.z > maxZ) return null;
  } else {
    const ood = 1.0 / dz;
    let t1 = (minZ - p0.z) * ood;
    let t2 = (maxZ - p0.z) * ood;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }

  return tMin;
}

export interface CoverResult {
  blocked: boolean;
  blockingBox: SolidBoxAABB | null;
  /** Straight-line distance from origin to the blocking surface. */
  distance: number;
}

/**
 * Checks if a wall or solid cover blocks direct line of sight between an explosion
 * and a target (player or dummy).
 */
export function isCoverBlocked(
  blastOrigin: Vec3Like,
  targetPos: Vec3Like,
  solids: SolidBoxAABB[],
  ignoredBox?: SolidBoxAABB | null
): CoverResult {
  let closestT = 1;
  let blocking: SolidBoxAABB | null = null;

  for (const b of solids) {
    if (b === ignoredBox) continue;
    const t = segmentIntersectsBox(blastOrigin, targetPos, b);
    if (t !== null && t < closestT && t > 0.001) {
      closestT = t;
      blocking = b;
    }
  }

  const dx = targetPos.x - blastOrigin.x;
  const dy = targetPos.y - blastOrigin.y;
  const dz = targetPos.z - blastOrigin.z;
  const totalDist = Math.sqrt(dx * dx + dy * dy + dz * dz);

  return {
    blocked: blocking !== null,
    blockingBox: blocking,
    distance: totalDist * closestT,
  };
}

/**
 * Fortnite-style structural damage:
 * Weapons and explosives deal tuned damage against structures.
 */
export const STRUCTURE_DAMAGE_MULTIPLIER: Record<string, number> = {
  sk: 1.0,      // standard assault rifle
  smg: 0.9,     // rapid fire wood shredder
  sniper: 1.8,  // heavy anti-material punch
  betgun: 2.2,  // close-range shotgun destroys wood walls fast
  blast: 3.5,   // explosive grenade deals massive demolition damage
  fire: 1.2,    // burns through wooden cover
};

export function calculateStructureDamage(
  weaponOrExplosive: string,
  baseDamage: number
): number {
  const mult = STRUCTURE_DAMAGE_MULTIPLIER[weaponOrExplosive] ?? 1.0;
  return Math.round(baseDamage * mult);
}

/**
 * Computes initial 3D impulse velocity for a voxel debris chunk blasted outward
 * from an epicenter.
 */
export function calculateVoxelImpulse(
  voxelPos: Vec3Like,
  epicenter: Vec3Like,
  power = 10,
  upwardBonus = 3.5
): Vec3Like {
  let dx = voxelPos.x - epicenter.x;
  let dy = voxelPos.y - epicenter.y;
  let dz = voxelPos.z - epicenter.z;
  let dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist < 0.01) {
    dx = (Math.random() - 0.5) * 0.1;
    dz = (Math.random() - 0.5) * 0.1;
    dist = Math.sqrt(dx * dx + dz * dz);
  }
  const normX = dx / dist;
  const normZ = dz / dist;
  const speed = power * (0.8 + Math.random() * 0.6);

  return {
    x: normX * speed,
    y: Math.max(1.5, dy + upwardBonus) + Math.random() * 2,
    z: normZ * speed,
  };
}

/**
 * Calculates voxel grid dimensions for a bounding box given a voxel size.
 * Clamps each axis between 1 and maxDim.
 */
export function calculateVoxelDimensions(
  width: number,
  height: number,
  depth: number,
  voxSize = 0.55,
  maxDim = 96
): { nx: number; ny: number; nz: number; total: number } {
  const nx = Math.max(1, Math.min(maxDim, Math.round(width / voxSize)));
  const ny = Math.max(1, Math.min(maxDim, Math.round(height / voxSize)));
  const nz = Math.max(1, Math.min(maxDim, Math.round(depth / voxSize)));
  return { nx, ny, nz, total: nx * ny * nz };
}
