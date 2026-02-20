/**
 * FrustrationFairy Patterns
 * Mode-specific waveform patterns
 */

const FrustrationFairyPatterns = {
      fairy_dust: (phase, intensity) => {
      const dustPhase = Math.floor(phase * 50);
      const randomDust = dustPhase % 7 === 0 ? 1 : (dustPhase % 3 === 0 ? 0.3 : 0.05);
      return randomDust * intensity * 0.2;
    },
      impish_flutter: (phase, intensity) => {
      const flutterPhase = (phase * 30) % 1;
      const flutter = Math.sin(flutterPhase * Math.PI * 4);
      const whisper = flutter > 0.7 ? flutter * 0.15 : flutter * 0.02;
      return Math.abs(whisper) * intensity * 0.25;
    },
      maddening_tickle: (phase, intensity) => {
      const ticklePhase = Math.floor(phase * 40);
      if (ticklePhase % 5 === 0) return intensity * (0.1 + Math.random() * 0.15);
      if (ticklePhase % 2 === 0) return intensity * 0.03;
      return intensity * 0.01;
    },
      phantom_touch: (phase, intensity) => {
      const ghostCycle = Math.floor(phase * 25);
      if (ghostCycle % 8 === 0) return intensity * 0.25;
      if (ghostCycle % 3 === 0) return intensity * (0.02 + Math.random() * 0.03);
      return intensity * 0.005;
    },
      frustrating_flutter: (phase, intensity) => {
      const flutterPhase = (phase * 40) % 1;
      const flutter = flutterPhase < 0.15 ? 0.3 : flutterPhase < 0.3 ? 0.1 : 0.02;
      return flutter * (Math.sin(phase * Math.PI * 8) * 0.3 + 0.7) * intensity * 0.2;
    },
      unbearable_lightness: (phase, intensity) => {
      const lightPhase = (phase * 60) % 1;
      const lightness = lightPhase < 0.1 ? 0.2 : (lightPhase < 0.15 ? 0.05 : 0.01);
      return lightness * Math.min(phase * 1.5, 1) * intensity * 0.3;
    },
      teasing_whisper: (phase, intensity) => {
      const whisperPhase = Math.sin(phase * Math.PI * 12);
      const whisper = whisperPhase > 0.8 ? (whisperPhase - 0.8) * 5 : 0;
      return whisper * intensity * 0.15;
    },
      maddening_ripples: (phase, intensity) => {
      const ripplePhase = (phase * 20) % 1;
      const ripple = Math.sin(ripplePhase * Math.PI * 6) * 0.5 + 0.5;
      const tease = ripple < 0.5 ? ripple * 0.2 : ripple * 0.05;
      return tease * intensity * 0.25;
    },
      infuriating_flicker: (phase, intensity) => {
      const flickerPhase = Math.floor(phase * 80);
      const flicker = flickerPhase % 4 === 0 ? 0.3 : (flickerPhase % 2 === 0 ? 0.08 : 0.01);
      return flicker * Math.min(phase * 2, 1) * intensity * 0.3;
    },
};

// Export for module system
if (typeof module !== 'undefined' && module.exports) {
    module.exports = FrustrationFairyPatterns;
}

// Register on window for dynamic loading
if (typeof window !== 'undefined') {
    window.FrustrationFairyPatterns = FrustrationFairyPatterns;
}
