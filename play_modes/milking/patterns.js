/**
 * MilkMaid Patterns
 * Mode-specific waveform patterns
 */

const MilkMaidPatterns = {
      crescendo: (phase, intensity) => Math.min(Math.pow(phase, 1.5), 1) * intensity,
      tidal_wave: (phase, intensity) => {
      const wave = Math.sin(phase * Math.PI * 2);
      const tide = Math.sin(phase * Math.PI * 0.5) * 0.7 + 0.3;
      return Math.abs(wave) * tide * intensity;
    },
      milking_pump: (phase, intensity) => {
      const pumpPhase = (phase * 4) % 1;
      if (pumpPhase < 0.7) return Math.pow(pumpPhase / 0.7, 1.5) * intensity;
      if (pumpPhase < 0.85) return intensity;
      return intensity * ((0.85 - pumpPhase) / 0.15);
    },
      relentless: (phase, intensity) => {
      const relentlessPhase = phase * 2;
      const wave1 = Math.sin(relentlessPhase * Math.PI * 2.5);
      const wave2 = Math.sin(relentlessPhase * Math.PI * 7);
      const build = Math.min(phase * 3, 1);
      return (Math.abs(wave1) * 0.6 + Math.abs(wave2) * 0.4) * build * intensity;
    },
      overload: (phase, intensity) => {
      const phaseQuadrant = Math.floor(phase * 8);
      const subPhase = (phase * 8) % 1;
      const baseIntensity = Math.min((phaseQuadrant + 1) / 8, 1);
      return Math.abs(Math.sin(subPhase * Math.PI * 4)) * baseIntensity * intensity;
    },
      forced_peak: (phase, intensity) => {
      const cycle = (phase * 3) % 1;
      const buildPhase = cycle * 0.6;
      if (cycle < 0.7) return Math.pow(buildPhase / 0.6, 2) * intensity;
      if (cycle < 0.95) return intensity;
      return intensity * (1 - (cycle - 0.95) / 0.05);
    },
      spiral_up: (phase, intensity) => {
      const spiral = Math.sin(phase * Math.PI * (4 + phase * 6));
      return Math.abs(spiral) * Math.min(phase * 2, 1) * intensity;
    },
      tsunami: (phase, intensity) => {
      const tsunamiPhase = (phase * 3) % 1;
      const buildUp = Math.pow(tsunamiPhase, 0.5) * 0.8;
      const peak = tsunamiPhase < 0.7 ? buildUp : 
                  (tsunamiPhase < 0.85 ? 1 : (1 - (tsunamiPhase - 0.85) / 0.15));
      const waves = Math.sin(tsunamiPhase * Math.PI * 10) * 0.3 + 0.7;
      return peak * waves * intensity;
    },
};

// Export for module system
if (typeof module !== 'undefined' && module.exports) {
    module.exports = MilkMaidPatterns;
}

// Register on window for dynamic loading
if (typeof window !== 'undefined') {
    window.MilkMaidPatterns = MilkMaidPatterns;
}
