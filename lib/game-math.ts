// Pure mathematical and rule logic for Battle Royale FPS

export interface WeaponConfig {
  name: string;
  ammo: 'heavy' | 'light';
  mag: number;
  damage: number;
  delay: number;
  reload: number;
  recoil: number;
  falloff: [number, number];
  shotgun?: boolean;
}

export const POWER_LEVELS = [1, 0.6, 0.3] as const;

export function powerAt(w: { falloff: [number, number] }, dist: number): number {
  if (dist < w.falloff[0]) return POWER_LEVELS[0];
  return dist < w.falloff[1] ? POWER_LEVELS[1] : POWER_LEVELS[2];
}

export const BETGUN = {
  damage: 150,
  pen: 80,
  close: 10,
  full: 30,
  far: 60,
  low: 30,
};

export function shotDamage(
  w: { shotgun?: boolean; damage: number; falloff: [number, number] },
  dist: number
): { dmg: number; pen: number } {
  if (!w.shotgun) {
    return { dmg: w.damage * powerAt(w, dist), pen: 0 };
  }
  if (dist <= BETGUN.close) return { dmg: BETGUN.damage, pen: BETGUN.pen };
  if (dist < BETGUN.full) return { dmg: BETGUN.damage, pen: 0 };
  const t = Math.min(1, (dist - BETGUN.full) / (BETGUN.far - BETGUN.full));
  return { dmg: BETGUN.damage + (BETGUN.low - BETGUN.damage) * t, pen: 0 };
}

export function blastShare(dist: number): number {
  if (dist <= 4) return 1;
  if (dist <= 8) return 2 / 3;
  if (dist <= 12) return 1 / 3;
  return 0;
}

export const LEVEL_COST = [100, 300, 500, 700] as const;
export const MAX_LEVEL = LEVEL_COST.length + 1;

export function calculateXpProgression(
  currentLevel: number,
  currentXp: number,
  earnedXp: number
): { newLevel: number; newXp: number; levelsGained: number[] } {
  let level = currentLevel;
  let xp = currentXp + earnedXp;
  const levelsGained: number[] = [];

  while (level < MAX_LEVEL && xp >= LEVEL_COST[level - 1]) {
    xp -= LEVEL_COST[level - 1];
    level += 1;
    levelsGained.push(level);
  }

  return { newLevel: level, newXp: xp, levelsGained };
}

export function calculateShieldRegen(
  currentShield: number,
  maxShield: number,
  sinceHurt: number,
  delay: number,
  rate: number,
  dt: number,
  isDown: boolean
): number {
  if (isDown || sinceHurt < delay || currentShield >= maxShield) {
    return currentShield;
  }
  return Math.min(maxShield, currentShield + rate * maxShield * dt);
}

// ----------------------------------------------------------------------------
// CoD / Apex Slide Physics Logic
// ----------------------------------------------------------------------------
export const SLIDE_INITIAL_SPEED = 16.5; // m/s burst
export const SLIDE_DECAY_RATE = 1.15;
export const SLIDE_MIN_SPEED = 3.0;
export const SLIDE_MAX_TIME = 1.4;

export function calculateSlideVelocity(
  time: number,
  initialSpeed = SLIDE_INITIAL_SPEED,
  decayRate = SLIDE_DECAY_RATE,
  slopeBonus = 0
): number {
  const base = initialSpeed * Math.exp(-decayRate * time);
  return Math.max(0, base + slopeBonus);
}

// ----------------------------------------------------------------------------
// Souls-like Dodge Roll Logic & i-Frames
// ----------------------------------------------------------------------------
export const SOULS_ROLL_DURATION = 0.75; // seconds
export const SOULS_ROLL_IFRAMES = 0.42;  // ~13 frames at 30fps invincibility window
export const SOULS_ROLL_DISTANCE = 4.8;  // meters
export const SOULS_ROLL_COOLDOWN = 0.35; // recovery cooldown

export function isRollInvulnerable(rollT: number, iframes = SOULS_ROLL_IFRAMES): boolean {
  return rollT >= 0 && rollT < iframes;
}

export function soulsRollEyeHeight(
  progress: number, // 0 to 1
  standingEyeH = 1.7
): number {
  const p = Math.max(0, Math.min(1, progress));
  const angle = 2 * Math.PI * p;
  // Center drops down during tuck, head swings over in somersault
  const center = 0.45 + 0.35 * Math.abs(Math.cos(angle));
  const reach = 0.45 + 0.45 * Math.abs(Math.cos(angle / 2));
  const rawH = center + reach * Math.cos(angle);
  return Math.max(0.38, (rawH * standingEyeH) / 1.7);
}

// ----------------------------------------------------------------------------
// Wall / Cover Detection & Fortnite-style Physical Destruction
// ----------------------------------------------------------------------------
export interface SolidBoxAABB {
  x: number;
  z: number;
  hx: number;
  hz: number;
  top: number;
  bottom?: number;
}

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/**
 * Checks if a 3D line segment from p0 to p1 intersects an axis-aligned box.
 * Returns intersection parameter t in [0, 1] or null if no hit.
 */
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

/**
 * Checks if a wall or solid cover blocks direct line of sight between an explosion
 * and a target (player or dummy).
 */
export function isCoverBlocked(
  blastOrigin: Vec3Like,
  targetPos: Vec3Like,
  solids: SolidBoxAABB[],
  ignoredBox?: SolidBoxAABB | null
): { blocked: boolean; blockingBox: SolidBoxAABB | null; distance: number } {
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

