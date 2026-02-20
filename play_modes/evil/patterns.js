/**
 * EvilEdgingMistress Patterns
 * Mode-specific waveform patterns
 */

const EvilEdgingMistressPatterns = {
      forbidden_peaks: (phase, intensity) => {
      const peakCycle = (phase * 2) % 1;
      const baseBuild = Math.min(phase * 3, 1);
      const quickRise = peakCycle < 0.6 ? 
        baseBuild * Math.pow(peakCycle / 0.6, 1.5) : 
        baseBuild * (1 - (peakCycle - 0.6) / 0.4);
      return quickRise * (Math.sin(phase * Math.PI * 8) * 0.3 + 0.7) * intensity;
    },
      multiple_peaks: (phase, intensity) => {
      const peakCount = Math.floor(phase * 6);
      const subPhase = (phase * 6) % 1;
      const base = Math.min((peakCount + 1) / 6, 1);
      const peak = subPhase < 0.7 ? subPhase / 0.7 : 1 - ((subPhase - 0.7) / 0.3);
      return base * peak * (Math.sin(phase * Math.PI * 12) * 0.2 + 0.8) * intensity;
    },
      intense_waves: (phase, intensity) => {
      const wave1 = Math.sin(phase * Math.PI * 3);
      const wave2 = Math.sin(phase * Math.PI * 7);
      const wave3 = Math.sin(phase * Math.PI * 12);
      const combined = (Math.abs(wave1) * 0.5 + Math.abs(wave2) * 0.3 + Math.abs(wave3) * 0.2);
      return combined * (Math.min(phase * 2, 1) * 0.7 + 0.3) * intensity;
    },
      ripple_thruster: (phase, intensity) => {
      const phaseCycle = (phase * 4) % 1;
      const ripple = Math.sin((phase * 8) % 1 * Math.PI * 4) * 0.5 + 0.5;
      return (phaseCycle < 0.8 ? ripple : ripple * 0.3) * intensity;
    },
      rapid_fire: (phase, intensity) => {
      const burstCycle = (phase * 10) % 1;
      const burst = burstCycle < 0.15 ? 1 : burstCycle < 0.3 ? 0.2 : 0.05;
      return burst * Math.min(phase * 1.5, 1) * intensity;
    },
      evil_ripple: (phase, intensity) => {
      const ripplePhase = (phase * 12) % 1;
      const rippleSize = Math.sin(ripplePhase * Math.PI * 2) * 0.5 + 0.5;
      return Math.pow(rippleSize, 1.5) * intensity * 0.9;
    },
      cruel_sine: (phase, intensity) => {
      const sineValue = Math.sin(phase * Math.PI * 2);
      return Math.abs(sineValue) * Math.pow(Math.abs(sineValue), 0.5) * intensity;
    },
      torture_pulse: (phase, intensity) => {
      const pulseCycle = Math.floor(phase * 15);
      const pulsePhase = (phase * 15) % 1;
      const isPulse = pulsePhase < 0.3;
      const pulseIntensity = isPulse ? Math.random() * 0.3 + 0.7 : 0.05;
      return pulseIntensity * (0.5 + (pulseCycle / 15) * 0.5) * intensity;
    },
      wicked_build: (phase, intensity) => {
      const buildPhase = Math.pow(phase, 0.8);
      const wickedness = Math.sin(buildPhase * Math.PI * 4) * 0.3 + 0.7;
      const spike = Math.random() > 0.9 ? intensity * 0.3 : 0;
      return wickedness * intensity * buildPhase + spike;
    },
      malicious_flicker: (phase, intensity) => {
      const flickerPhase = Math.floor(phase * 40);
      const flicker = flickerPhase % 3 === 0 ? 1 : (flickerPhase % 3 === 1 ? 0.3 : 0.05);
      return flicker * Math.min(phase * 2, 1) * intensity;
    },
      sadistic_hold: (phase, intensity) => {
      const holdCycle = (phase * 2.5) % 1;
      if (holdCycle < 0.5) return Math.pow(holdCycle * 2, 0.8) * intensity;
      if (holdCycle < 0.7) return intensity * 0.95;
      if (holdCycle < 0.75) return intensity * 0.02;
      return intensity * (holdCycle - 0.75) * 4 * 0.1;
    },
      torment_wave: (phase, intensity) => {
      const wave1 = Math.sin(phase * Math.PI * 6);
      const wave2 = Math.sin(phase * Math.PI * 13);
      const wave3 = Math.sin(phase * Math.PI * 19);
      const combined = (Math.abs(wave1) * 0.5 + Math.abs(wave2) * 0.3 + Math.abs(wave3) * 0.2);
      return Math.pow(combined, 1.5) * intensity;
    },
      vindictive_spikes: (phase, intensity) => {
      const spikePhase = (phase * 8) % 1;
      if (spikePhase < 0.1) return intensity * (0.8 + Math.random() * 0.2);
      if (spikePhase < 0.3) return intensity * 0.5;
      if (spikePhase < 0.5) return intensity * 0.2;
      return intensity * 0.02;
    },
};

// Export for module system
if (typeof module !== 'undefined' && module.exports) {
    module.exports = EvilEdgingMistressPatterns;
}

// Register on window for dynamic loading
if (typeof window !== 'undefined') {
    window.EvilEdgingMistressPatterns = EvilEdgingMistressPatterns;
}
