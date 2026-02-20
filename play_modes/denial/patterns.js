/**
 * DenialDomina Patterns
 * Mode-specific waveform patterns
 */

const DenialDominaPatterns = {
      heartbeat: (phase, intensity) => {
      const cycle = phase * 2;
      const part1 = cycle % 1;
      const part2 = (cycle + 0.3) % 1;
      return (part1 < 0.15 ? intensity * 1.0 : part1 < 0.25 ? intensity * 0.4 : 0) + 
             (part2 < 0.15 ? intensity * 0.6 : part2 < 0.25 ? intensity * 0.2 : 0);
    },
      tickle: (phase, intensity) => Math.random() > 0.5 ? 
      intensity * (0.3 + Math.random() * 0.4) : intensity * (0.1 + Math.random() * 0.15),
      edging: (phase, intensity) => {
      const edgePhase = (phase * 4) % 1;
      const ramp = Math.sin(phase * Math.PI * 1.5);
      return edgePhase < 0.9 ? ramp * intensity * 0.8 : 0;
    },
      ruin: (phase, intensity) => phase < 0.85 ? 
      Math.sin(phase * Math.PI * 0.85) * intensity : intensity * 0.2,
      teasing: (phase, intensity) => {
      const sub = phase * 3;
      const wave = Math.sin(sub * Math.PI * 2);
      const tease = wave < 0 ? wave * 0.1 : wave * (0.3 + Math.random() * 0.3);
      return Math.abs(tease) * intensity;
    },
      desperation: (phase, intensity) => {
      const desperation = phase * phase;
      const bursts = Math.floor(phase * 8) % 3 === 0 ? 1 : 0.1;
      return desperation * bursts * intensity;
    },
      mercy: (phase, intensity) => {
      const cycle = phase * 5;
      const rest = cycle % 2 > 1 ? 0 : 1;
      return rest * Math.sin(cycle * Math.PI) * intensity * 0.6;
    },
      tease_escalate: (phase, intensity) => {
      const base = phase;
      const tease = (phase % 0.3) < 0.15 ? 1 : 0.2;
      return base * tease * intensity;
    },
      stop_start: (phase, intensity) => Math.floor(phase * 10) % 2 === 0 ? intensity * 0.7 : 0,
      random_tease: (_, intensity) => Math.random() > 0.6 ? intensity * (0.2 + Math.random() * 0.7) : 0,
      micro_tease: (phase, intensity) => {
      const tickCount = Math.floor(phase * 20);
      const baseMicro = (tickCount % 3 === 0) ? 0.05 + Math.random() * 0.15 : 
                       (tickCount % 3 === 1) ? 0.5 + Math.random() * 0.2 : 0.1 + Math.random() * 0.1;
      return Math.random() > 0.7 ? intensity * 0.7 : intensity * baseMicro;
    },
      abrupt_edge: (phase, intensity) => {
      const buildPhase = phase % 0.4;
      return buildPhase < 0.35 ? Math.sin(buildPhase * Math.PI * 2.85) * intensity : 0;
    },
      build_and_ruin: (phase, intensity) => {
      const cycle = phase * 2;
      const build = Math.sin(cycle * Math.PI * 0.9) * intensity;
      return (cycle % 1) > 0.9 ? intensity * 0.1 : build;
    },
      held_edge: (phase, intensity) => {
      const holdPhase = (phase * 1.5) % 1;
      if (holdPhase < 0.6) return Math.sin(holdPhase * Math.PI * 1.66) * intensity;
      if (holdPhase < 0.8) return intensity * 0.9;
      return intensity * 0.05;
    },
      flutter: (phase, intensity) => {
      const flutterCount = Math.floor(phase * 30);
      const flutter = flutterCount % 2 === 0 ? intensity * 0.4 : intensity * 0.1;
      return Math.min(Math.sqrt(phase) * flutter, intensity * 0.5);
    },
};

// Export for module system
if (typeof module !== 'undefined' && module.exports) {
    module.exports = DenialDominaPatterns;
}

// Register on window for dynamic loading
if (typeof window !== 'undefined') {
    window.DenialDominaPatterns = DenialDominaPatterns;
}
