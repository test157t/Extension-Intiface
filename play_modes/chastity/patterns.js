/**
 * ChastityCaretaker Patterns
 * Mode-specific waveform patterns
 */

const ChastityCaretakerPatterns = {
      gentle_checkup: (phase, intensity) => {
      const checkPhase = (phase * 8) % 1;
      if (checkPhase < 0.2) return intensity * 0.15;
      if (checkPhase < 0.4) return intensity * 0.08;
      return intensity * 0.02;
    },
      caring_tap: (phase, intensity) => {
      const tapPhase = Math.floor(phase * 20);
      if (tapPhase % 5 === 0) return intensity * 0.25;
      if (tapPhase % 3 === 0) return intensity * 0.1;
      return intensity * 0.03;
    },
      tender_flutter: (phase, intensity) => {
      const flutter = Math.sin(phase * Math.PI * 6) * 0.5 + 0.5;
      const caring = flutter < 0.6 ? flutter * 0.2 : flutter * 0.05;
      return caring * intensity * 0.3;
    },
      nurturing_pulse: (phase, intensity) => {
      const pulseCycle = (phase * 5) % 1;
      if (pulseCycle < 0.5) return Math.sin(pulseCycle * Math.PI * 2) * intensity * 0.25;
      return intensity * 0.05;
    },
      cage_nurse: (phase, intensity) => {
      const nursePhase = Math.floor(phase * 12);
      const checkIn = nursePhase % 4 === 0 ? 0.2 : 0.05;
      const care = nursePhase % 3 === 0 ? 0.15 : 0.03;
      return Math.max(checkIn, care) * intensity * 0.3;
    },
      gentle_denial: (phase, intensity) => {
      const denialPhase = Math.sin(phase * Math.PI * 1.5);
      return Math.abs(denialPhase > 0 ? denialPhase * 0.2 : 0) * intensity * 0.25;
    },
      tender_torment: (phase, intensity) => {
      const torment = Math.random() > 0.85 ? intensity * 0.3 : 
                     (Math.random() > 0.6 ? intensity * 0.1 : intensity * 0.02);
      return torment * Math.min(phase * 1.2, 1) * 0.4;
    },
      loving_check: (phase, intensity) => {
      const lovePhase = (phase * 10) % 1;
      if (lovePhase < 0.25) return intensity * 0.18;
      if (lovePhase < 0.4) return intensity * 0.06;
      return intensity * 0.01;
    },
      caretaker_hums: (phase, intensity) => {
      const hum = Math.sin(phase * Math.PI * 3) * 0.4 + 0.5;
      return Math.pow(hum, 0.7) * 0.5 * intensity * 0.3;
    },
      sweet_frustration: (phase, intensity) => {
      const sweetPhase = (phase * 6) % 1;
      if (sweetPhase < 0.3) return intensity * 0.2;
      if (sweetPhase < 0.6) return intensity * 0.05;
      if (sweetPhase < 0.75) return intensity * 0.15;
      return intensity * 0.02;
    },
      daily_routine: (phase, intensity) => {
      const routine = Math.floor(phase * 8) % 4;
      switch (routine) {
        case 0: return intensity * 0.25;
        case 1: return intensity * 0.05;
        case 2: return intensity * 0.15;
        case 3: return intensity * 0.03;
        default: return intensity * 0.02;
      }
    },
};

// Export for module system
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ChastityCaretakerPatterns;
}

// Register on window for dynamic loading
if (typeof window !== 'undefined') {
    window.ChastityCaretakerPatterns = ChastityCaretakerPatterns;
}
