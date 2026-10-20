import test from 'node:test';
import assert from 'node:assert/strict';
import {
  powerAt,
  shotDamage,
  blastShare,
  calculateXpProgression,
  calculateShieldRegen,
  BETGUN,
  calculateSlideVelocity,
  isRollInvulnerable,
  soulsRollEyeHeight,
  SOULS_ROLL_IFRAMES,
  segmentIntersectsBox,
  isCoverBlocked,
  calculateStructureDamage,
  calculateVoxelImpulse,
} from './game-math.ts';

test('powerAt applies three damage falloff brackets', () => {
  const sk = { falloff: [60, 180] as [number, number] };
  assert.equal(powerAt(sk, 10), 1.0);
  assert.equal(powerAt(sk, 59.9), 1.0);
  assert.equal(powerAt(sk, 60), 0.6);
  assert.equal(powerAt(sk, 179), 0.6);
  assert.equal(powerAt(sk, 180), 0.3);
  assert.equal(powerAt(sk, 300), 0.3);
});

test('shotDamage calculates standard weapon with falloff', () => {
  const sk = { damage: 38, falloff: [60, 180] as [number, number] };
  const close = shotDamage(sk, 20);
  assert.equal(close.dmg, 38);
  assert.equal(close.pen, 0);

  const mid = shotDamage(sk, 100);
  assert.equal(mid.dmg, 38 * 0.6);
  assert.equal(mid.pen, 0);
});

test('shotDamage calculates betgun close penetration and distance falloff', () => {
  const betgun = {
    shotgun: true,
    damage: BETGUN.damage,
    falloff: [30, 60] as [number, number],
  };

  const close = shotDamage(betgun, 8);
  assert.equal(close.dmg, 150);
  assert.equal(close.pen, 80);

  const mid = shotDamage(betgun, 25);
  assert.equal(mid.dmg, 150);
  assert.equal(mid.pen, 0);

  const far = shotDamage(betgun, 45);
  assert.equal(far.dmg, 90);
  assert.equal(far.pen, 0);

  const maxRange = shotDamage(betgun, 60);
  assert.equal(maxRange.dmg, 30);
});

test('blastShare returns correct stepped damage percentages', () => {
  assert.equal(blastShare(2), 1.0);
  assert.equal(blastShare(4), 1.0);
  assert.equal(blastShare(6), 2 / 3);
  assert.equal(blastShare(8), 2 / 3);
  assert.equal(blastShare(10), 1 / 3);
  assert.equal(blastShare(12), 1 / 3);
  assert.equal(blastShare(13), 0);
});

test('calculateXpProgression handles single and multi-level rollover', () => {
  const r1 = calculateXpProgression(1, 40, 70);
  assert.equal(r1.newLevel, 2);
  assert.equal(r1.newXp, 10);
  assert.deepEqual(r1.levelsGained, [2]);

  const r2 = calculateXpProgression(1, 0, 1000);
  assert.equal(r2.newLevel, 4);
  assert.equal(r2.newXp, 100);
  assert.deepEqual(r2.levelsGained, [2, 3, 4]);
});

test('calculateShieldRegen does not regen when recently damaged or player down', () => {
  const max = 152;
  assert.equal(calculateShieldRegen(50, max, 3.0, 6.0, 0.25, 0.1, false), 50);
  assert.equal(calculateShieldRegen(50, max, 7.0, 6.0, 0.25, 0.1, true), 50);
  const regenerated = calculateShieldRegen(50, max, 6.5, 6.0, 0.25, 0.1, false);
  assert.equal(regenerated, 53.8);
});

test('calculateSlideVelocity produces high initial speed and smooth exponential decay', () => {
  const v0 = calculateSlideVelocity(0);
  assert.equal(v0, 16.5);

  const vHalf = calculateSlideVelocity(0.5);
  assert(vHalf < 16.5 && vHalf > 8.0);

  // Downhill slope adds velocity
  const vSlope = calculateSlideVelocity(0.5, 16.5, 1.15, 2.5);
  assert.equal(vSlope, vHalf + 2.5);
});

test('isRollInvulnerable strictly protects during Souls i-frame window', () => {
  assert.equal(isRollInvulnerable(0.0), true);
  assert.equal(isRollInvulnerable(0.2), true);
  assert.equal(isRollInvulnerable(SOULS_ROLL_IFRAMES - 0.01), true);
  assert.equal(isRollInvulnerable(SOULS_ROLL_IFRAMES), false);
  assert.equal(isRollInvulnerable(0.5), false);
  assert.equal(isRollInvulnerable(-0.1), false);
});

test('soulsRollEyeHeight drops during tuck and returns to standing', () => {
  const startH = soulsRollEyeHeight(0, 1.7);
  assert(Math.abs(startH - 1.7) < 0.05);

  // Midpoint inverted somersault is lowest
  const midH = soulsRollEyeHeight(0.5, 1.7);
  assert(midH < 0.55 && midH >= 0.38);

  const endH = soulsRollEyeHeight(1.0, 1.7);
  assert(Math.abs(endH - 1.7) < 0.05);
});

test('segmentIntersectsBox detects ray passing through solid wall and misses outside', () => {
  const wall = { x: 0, z: 0, hx: 2, hz: 0.2, top: 3, bottom: 0 };

  // Ray through center
  const hitT = segmentIntersectsBox({ x: 0, y: 1.5, z: 5 }, { x: 0, y: 1.5, z: -5 }, wall);
  assert(hitT !== null && hitT > 0.4 && hitT < 0.6);

  // Ray over the wall (y = 4 is above top: 3)
  const missHigh = segmentIntersectsBox({ x: 0, y: 4, z: 5 }, { x: 0, y: 4, z: -5 }, wall);
  assert.equal(missHigh, null);

  // Ray to the side (x = 5 is beyond hx: 2)
  const missSide = segmentIntersectsBox({ x: 5, y: 1.5, z: 5 }, { x: 5, y: 1.5, z: -5 }, wall);
  assert.equal(missSide, null);
});

test('isCoverBlocked protects player taking cover behind a wall against grenade blast', () => {
  const wall = { x: 0, z: 2, hx: 2.5, hz: 0.25, top: 2.5, bottom: 0 };
  const crate = { x: 8, z: 0, hx: 1, hz: 1, top: 1.5, bottom: 0 };
  const solids = [wall, crate];

  // Grenade is at (0, 0.2, 5), player is at (0, 1.7, 0) -> wall at z=2 blocks line of sight
  const grenadeOrigin = { x: 0, y: 0.2, z: 5 };
  const playerInCover = { x: 0, y: 1.7, z: 0 };
  const coverResult = isCoverBlocked(grenadeOrigin, playerInCover, solids);
  assert.equal(coverResult.blocked, true);
  assert.equal(coverResult.blockingBox, wall);

  // Player peeks well around the wall at x = 6 -> line of sight is clear, takes blast
  const playerExposed = { x: 6, y: 1.7, z: 0 };
  const exposedResult = isCoverBlocked(grenadeOrigin, playerExposed, solids);
  assert.equal(exposedResult.blocked, false);
  assert.equal(exposedResult.blockingBox, null);
});

test('calculateStructureDamage applies weapon and explosive multipliers', () => {
  // Shotgun deals massive structural punch
  assert.equal(calculateStructureDamage('betgun', 150), 330);
  // Explosive blast deals demolition damage
  assert.equal(calculateStructureDamage('blast', 100), 350);
  // Standard rifle
  assert.equal(calculateStructureDamage('sk', 38), 38);
});

test('calculateVoxelImpulse blasts voxels outward with upward pop', () => {
  const blastCenter = { x: 0, y: 0.5, z: 0 };
  const voxelAtWall = { x: 2, y: 1.0, z: 0 };
  const impulse = calculateVoxelImpulse(voxelAtWall, blastCenter, 12, 4);

  // X should be positive (blasting away from center)
  assert(impulse.x > 5);
  // Y should have upward pop
  assert(impulse.y > 4);
});

