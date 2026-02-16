/**
 * HypnoHelper Patterns
 * Mode-specific waveform patterns
 */

const HypnoHelperPatterns = {
      hypno_wave: (phase, intensity) => {
      const wave1 = Math.sin(phase * Math.PI * 0.8);
      const wave2 = Math.sin(phase * Math.PI * 1.6);
      const wave3 = Math.sin(phase * Math.PI * 2.4);
      return ((wave1 * 0.5 + wave2 * 0.3 + wave3 * 0.2) * 0.5 + 0.5) * intensity * 0.85;
    },
      trance_rhythm: (phase, intensity) => {
      const tranceCycle = Math.sin(phase * Math.PI);
      return Math.pow((tranceCycle + 1) / 2, 0.7) * intensity * 0.8;
    },
      sleepy_spiral: (phase, intensity) => {
      const spiral = Math.sin(phase * 3 * Math.PI * 2);
      return (Math.abs(spiral) * 0.7 + 0.15) * intensity * 0.75;
    },
      hypnotic_pulse: (phase, intensity) => {
      const pulsePhase = (phase * 4) % 1;
      if (pulsePhase < 0.6) {
        return Math.sin(pulsePhase / 0.6 * Math.PI * 0.5) * intensity * 0.75;
      }
      return Math.sin((pulsePhase - 0.6) / 0.4 * Math.PI) * intensity * 0.4 + intensity * 0.3;
    },
      dreamy_flow: (phase, intensity) => {
      const flowPhase = Math.sin(phase * Math.PI * 1.5);
      return Math.pow((flowPhase + 1) / 2, 0.6) * intensity * 0.8;
    },
      entrancement_zone: (phase, intensity) => {
      const zone = Math.sin(phase * Math.PI * 2) * 0.4 + 0.5;
      return Math.min(zone, 0.85) * intensity * 0.75;
    },
      sleepy_build: (phase, intensity) => {
      const buildUp = Math.pow(phase, 0.5);
      return (Math.sin(buildUp * Math.PI * 1.5) * 0.4 + 0.4) * intensity * 0.7;
    },
      trance_oscillation: (phase, intensity) => {
      const tranceWave = Math.sin(phase * Math.PI * 1.2);
      const oscillating = (tranceWave + 1) / 2;
      return Math.min(oscillating, 0.85) * intensity * 0.8;
    },
      hypnotic_drift: (phase, intensity) => {
      const drift = Math.sin(phase * Math.PI * 0.6) * 0.5 + 0.5;
      return Math.pow(drift, 0.8) * 0.9 * intensity * 0.75;
    },
      edge_trance: (phase, intensity) => {
      const trancePhase = Math.floor(phase * 3);
      const phaseProgress = (phase * 3) % 1;
      const tranceBase = Math.sin(phaseProgress * Math.PI * 2) * 0.4 + 0.45;
      const stageMod = 0.6 + (trancePhase / 10) * 0.25;
      return Math.min(tranceBase * stageMod, 0.85) * intensity * 0.75;
    },
};

// Export for module system
if (typeof module !== 'undefined' && module.exports) {
    module.exports = HypnoHelperPatterns;
}

// Register on window for dynamic loading
if (typeof window !== 'undefined') {
    window.HypnoHelperPatterns = HypnoHelperPatterns;
}
