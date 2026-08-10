export interface Particle { active: boolean; x: number; y: number; age: number; life: number; velocityX: number; velocityY: number }
export class ParticlePool {
  readonly particles: Particle[]; reused = 0;
  constructor(size = 48) { this.particles = Array.from({ length: size }, () => ({ active: false, x: 0, y: 0, age: 0, life: 0, velocityX: 0, velocityY: 0 })); }
  acquire(x: number, y: number, life = 900) { const particle = this.particles.find(item => !item.active); if (!particle) return null; this.reused++; Object.assign(particle, { active: true, x, y, age: 0, life, velocityX: 0, velocityY: -0.012 }); return particle; }
  update(deltaMs: number) { for (const particle of this.particles) if (particle.active) { particle.age += deltaMs; if (particle.age >= particle.life) particle.active = false; else { particle.x += particle.velocityX * deltaMs; particle.y += particle.velocityY * deltaMs; } } }
  releaseAll() { for (const particle of this.particles) particle.active = false; }
  get activeCount() { let count = 0; for (const particle of this.particles) if (particle.active) count++; return count; }
}
