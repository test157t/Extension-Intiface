/**
 * PetTraining Patterns
 * Mode-specific waveform patterns
 */

const PetTrainingPatterns = {
      rapid_micro: (phase, intensity) => Math.random() > 0.3 ? 
      intensity * (0.02 + Math.random() * 0.08) : intensity * (0.2 + Math.random() * 0.3),
      peak_and_drop: (phase, intensity) => {
      const phaseCycle = (phase * 3) % 1;
      return phaseCycle < 0.8 ? Math.sin(phaseCycle * Math.PI * 1.25) * intensity * 0.95 : 0;
    },
      ghost_tease: (phase, intensity) => {
      const ghostPhase = Math.floor(phase * 15);
      if (ghostPhase % 4 === 0) return intensity * (0.5 + Math.random() * 0.3);
      if (ghostPhase % 4 === 2) return intensity * (0.02 + Math.random() * 0.05);
      return 0;
    },
      erratic: (phase, intensity) => {
      const erraticValue = Math.random();
      if (erraticValue > 0.75) return intensity * 0.7;
      if (erraticValue > 0.5) return intensity * 0.2;
      if (erraticValue > 0.3) return intensity * 0.05;
      return intensity * 0.01;
    },
};

// Export for module system
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PetTrainingPatterns;
}

// Register on window for dynamic loading
if (typeof window !== 'undefined') {
    window.PetTrainingPatterns = PetTrainingPatterns;
}
