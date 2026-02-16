/**
 * RoboticRuination Patterns
 * Mode-specific waveform patterns
 */

const RoboticRuinationPatterns = {
      mechanical: (phase, intensity) => {
      const stepPhase = Math.floor(phase * 16) / 16;
      const mechanical = Math.sin(stepPhase * Math.PI * 2);
      return (mechanical > 0 ? mechanical : mechanical * 0.3) * intensity;
    },
      algorithm: (phase, intensity) => {
      const algoPhase = (phase * 4) % 1;
      return algoPhase < 0.9 ? 
        Math.pow(algoPhase / 0.9, 1.5) * intensity : 
        intensity * ((1 - algoPhase) / 0.1);
    },
      systematic_ruin: (phase, intensity) => {
      const cycle = (phase * 2.5) % 1;
      const buildPhase = Math.min(cycle / 0.92, 1);
      return Math.pow(cycle >= 0.92 ? 0.08 : buildPhase, 1.2) * intensity;
    },
      cold_calculation: (phase, intensity) => {
      const tickPhase = Math.floor(phase * 20);
      const tickLevel = Math.min(tickPhase / 18, 1);
      const suddenDrop = tickPhase >= 19 ? 0.05 : tickLevel;
      return Math.sin(tickPhase * 0.5 * Math.PI) * suddenDrop * intensity;
    },
};

// Export for module system
if (typeof module !== 'undefined' && module.exports) {
    module.exports = RoboticRuinationPatterns;
}

// Register on window for dynamic loading
if (typeof window !== 'undefined') {
    window.RoboticRuinationPatterns = RoboticRuinationPatterns;
}
