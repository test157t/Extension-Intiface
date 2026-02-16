/**
 * Basic Waveform Patterns
 * Core patterns available to all modes
 */

const BasicPatterns = {
      sine: (phase, intensity) => Math.sin(phase * Math.PI * 2) * intensity,
      sawtooth: (phase, intensity) => (phase < 0.5 ? phase * 2 : (1 - phase) * 2) * intensity,
      square: (phase, intensity) => (phase < 0.5 ? intensity : 0),
      triangle: (phase, intensity) => (phase < 0.5 ? phase * 2 : (1 - phase) * 2) * intensity,
      pulse: (phase, intensity) => (phase < 0.1 ? intensity : phase < 0.2 ? intensity * 0.3 : 0),
      random: (_, intensity) => Math.random() * intensity,
      ramp_up: (phase, intensity) => phase * intensity,
      ramp_down: (phase, intensity) => (1 - phase) * intensity,
};

// Export for module system
if (typeof module !== 'undefined' && module.exports) {
    module.exports = BasicPatterns;
}

// Register on window for dynamic loading
if (typeof window !== 'undefined') {
    window.BasicPatterns = BasicPatterns;
}
