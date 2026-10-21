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
  fullRadius: 3,
} as const;

/** Damage share of a Blast grenade at `dist` metres from the epicentre.
 * Full damage inside the inner radius, then linear falloff to zero. */
export function blastShare(dist: number): number {
  if (dist <= BLAST.fullRadius) return 1;
  if (dist >= BLAST.radius) return 0;
  return 1 - (dist - BLAST.fullRadius) / (BLAST.radius - BLAST.fullRadius);
}

/** Remaining bullet power (0..1) at `dist` metres for weapon `w`. */
export function powerAt(w: WeaponLike, dist: number): number {
  const [start, end] = w.falloff;
  if (dist <= start) return 1;
  if (dist >= end) return 0;
  return 1 - (dist - start) / (end - start);
}

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

/** Highest reachable level (levels 3 & 5 upgrade turret / bombardment). */
export const MAX_LEVEL = 5;

/** XP required to advance from level `n` to `n + 1` (index 0 = level 1 -> 2). */
export const LEVEL_COST: readonly number[] = [100, 250, 500, 1000];

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
