/**
 * Play Mode Loader
 * Discovers, loads, and manages modular play modes
 * Replaces hardcoded mode constants with dynamic loading
 */

const PlayModeLoader = {
  // Registry of loaded modes
  modes: {},

  // Registry of all available patterns (organized by mode)
  patterns: {},

  // Registry of sequences (organized by mode)
  sequences: {},

  // Mode settings (enabled/disabled)
  settings: {},

  // Base path for loading mode files
  basePath: '/scripts/extensions/third-party/Extension-Intiface/play_modes',

  /**
   * Initialize the loader
   * Loads basic mode first, then discovers and loads other modes
   */
  async init() {

    // Load basic mode first (always enabled)
    await this.loadMode('basic');

    // Discover other modes
    const modeIds = await this.discoverModes();

    // Load settings from localStorage
    this.loadSettings();

    // Load other modes
    for (const modeId of modeIds) {
      if (modeId !== 'basic') {
        await this.loadMode(modeId);
      }
    }

    console.log(`  - Modes: ${Object.keys(this.modes).length}`);
    console.log(`  - Patterns: ${Object.keys(this.patterns).length}`);
    console.log(`  - Sequences: ${Object.keys(this.sequences).length}`);

    return this;
  },

  /**
   * Discover available modes by scanning the play_modes directory
   * @returns {string[]} Array of mode IDs
   */
  async discoverModes() {
    // In browser environment, we'll need to scan differently
    // For now, return known modes (could be fetched from server)
    const knownModes = [
      'basic',
      'denial_domina',
      'milk_maid',
      'pet_training',
      'robotic_ruination',
      'sissy_surrender',
      'prejac_princess',
      'evil_edging_mistress',
      'frustration_fairy',
      'hypno_helper',
      'chastity_caretaker'
    ];

    return knownModes;
  },

  /**
   * Load a specific mode
   * @param {string} modeId - Mode identifier
   */
  async loadMode(modeId) {
    try {
      // Load mode.json (metadata)
      const modeResponse = await fetch(`${this.basePath}/${modeId}/mode.json`);
      if (!modeResponse.ok) {
        console.warn(`[PlayModeLoader] Failed to load mode ${modeId}: ${modeResponse.status}`);
        return false;
      }

      const modeData = await modeResponse.json();
      this.modes[modeId] = modeData;

    // Load patterns.js
    try {
      await this.loadScript(`${this.basePath}/${modeId}/patterns.js`);
      
      // Wait a tick for script to execute
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Register patterns based on mode ID
      const patternVarName = this.getPatternVariableName(modeId);
      if (window[patternVarName]) {
        this.patterns[modeId] = window[patternVarName];
      } else {
        console.warn(`[PlayModeLoader] Pattern variable ${patternVarName} not found for ${modeId}`);
        // Try basic patterns
        if (modeId === 'basic' && window.BasicPatterns) {
          this.patterns[modeId] = window.BasicPatterns;
        }
      }
    } catch (e) {
    }

      // Load sequences.json
      try {
        const seqResponse = await fetch(`${this.basePath}/${modeId}/sequences.json`);
        if (seqResponse.ok) {
          const sequences = await seqResponse.json();
          this.sequences[modeId] = sequences;
        }
      } catch (e) {
      }

      // Initialize settings
      if (!(modeId in this.settings)) {
        this.settings[modeId] = {
          enabled: modeData.ui?.defaultEnabled ?? false,
          intensityMultiplier: modeData.intensityMultiplier ?? 1.0
        };
      }

      return true;
    } catch (e) {
      console.error(`[PlayModeLoader] Error loading mode ${modeId}:`, e);
      return false;
    }
  },

  /**
   * Load a script dynamically
   * @param {string} url - Script URL
   */
  loadScript(url) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = url;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  },

  /**
   * Get the global variable name for a mode's patterns
   * @param {string} modeId - Mode identifier
   */
  getPatternVariableName(modeId) {
    // Convert snake_case to PascalCase and add Patterns suffix
    const camelCase = modeId.replace(/_([a-z])/g, (g) => g[1].toUpperCase());
    const pascalCase = camelCase.charAt(0).toUpperCase() + camelCase.slice(1);
    return pascalCase + 'Patterns';
  },

  /**
   * Load settings from localStorage
   */
  loadSettings() {
    const saved = localStorage.getItem('intiface-playmode-settings');
    if (saved) {
      try {
        this.settings = { ...this.settings, ...JSON.parse(saved) };
      } catch (e) {
        console.error('[PlayModeLoader] Failed to parse settings:', e);
      }
    }
  },

  /**
   * Save settings to localStorage
   */
  saveSettings() {
    localStorage.setItem('intiface-playmode-settings', JSON.stringify(this.settings));
  },

  /**
   * Enable/disable a mode
   * @param {string} modeId - Mode identifier
   * @param {boolean} enabled - Enabled state
   */
  setModeEnabled(modeId, enabled) {
    if (this.settings[modeId]) {
      this.settings[modeId].enabled = enabled;
      this.saveSettings();
    }
  },

  /**
   * Check if a mode is enabled
   * @param {string} modeId - Mode identifier
   */
  isModeEnabled(modeId) {
    // Basic mode is always enabled
    if (modeId === 'basic') return true;
    return this.settings[modeId]?.enabled ?? false;
  },

  /**
   * Get all enabled modes
   */
  getEnabledModes() {
    return Object.keys(this.modes).filter(id => this.isModeEnabled(id));
  },

  /**
   * Get sequences for enabled modes
   * Organized by mode ID for UI display
   */
  getEnabledSequences() {
    const result = {};
    for (const [modeId, modeSequences] of Object.entries(this.sequences)) {
      if (this.isModeEnabled(modeId)) {
        result[modeId] = {
          mode: this.modes[modeId],
          sequences: modeSequences
        };
      }
    }
    return result;
  },

  /**
   * Get a specific sequence
   * @param {string} modeId - Mode identifier
   * @param {string} sequenceName - Sequence name
   */
  getSequence(modeId, sequenceName) {
    if (this.sequences[modeId] && this.sequences[modeId][sequenceName]) {
      const seq = this.sequences[modeId][sequenceName];
      return {
        ...seq,
        modeId,
        name: sequenceName
      };
    }
    return null;
  },

  /**
   * Get a pattern function by name
   * Searches across all mode patterns
   * @param {string} patternName - Pattern name
   */
  getPattern(patternName) {
    // Search through all mode patterns
    for (const modePatterns of Object.values(this.patterns)) {
      if (modePatterns[patternName]) {
        return modePatterns[patternName];
      }
    }
    return null;
  },

  /**
   * Check if pattern exists
   * @param {string} patternName - Pattern name
   */
  hasPattern(patternName) {
    // Search through all mode patterns
    for (const modePatterns of Object.values(this.patterns)) {
      if (modePatterns[patternName]) {
        return true;
      }
    }
    return false;
  },

  /**
   * Get intensity multiplier for a mode
   * @param {string} modeId - Mode identifier
   */
  getIntensityMultiplier(modeId) {
    return this.settings[modeId]?.intensityMultiplier ??
           this.modes[modeId]?.intensityMultiplier ?? 1.0;
  },

  /**
   * Set intensity multiplier for a mode
   * @param {string} modeId - Mode identifier
   * @param {number} multiplier - Intensity multiplier
   */
  setIntensityMultiplier(modeId, multiplier) {
    if (this.settings[modeId]) {
      this.settings[modeId].intensityMultiplier = multiplier;
      this.saveSettings();
    }
  },

  /**
   * Generate waveform values for a pattern
   * @param {string} patternName - Pattern name
   * @param {number} steps - Number of steps
   * @param {number} min - Min intensity (0-100)
   * @param {number} max - Max intensity (0-100)
   * @returns {number[]} Array of intensity values
   */
  generateValues(patternName, steps, min, max) {
    const generator = this.getPattern(patternName);
    if (!generator) {
      console.warn(`[PlayModeLoader] Pattern '${patternName}' not found, using sine fallback`);
      return this.generateValues('sine', steps, min, max);
    }

    const values = [];
    const range = max - min;

    for (let i = 0; i < steps; i++) {
      const phase = i / steps;
      const normalized = generator(phase, 1);
      const value = min + (normalized * range);
      values.push(Math.max(0, Math.min(100, Math.round(value))));
    }

    return values;
  },

  /**
   * Get patterns organized by category
   * Returns patterns grouped by their mode/category
   */
  getPatternsByCategory() {
    const categories = {};
    
    // Map mode IDs to category names
    const categoryMap = {
      'basic': 'basic',
      'denial_domina': 'denial',
      'milk_maid': 'milking',
      'pet_training': 'training',
      'robotic_ruination': 'robotic',
      'sissy_surrender': 'sissy',
      'prejac_princess': 'prejac',
      'evil_edging_mistress': 'evil',
      'frustration_fairy': 'frustration',
      'hypno_helper': 'hypno',
      'chastity_caretaker': 'chastity'
    };
    
    // Group patterns by category
    for (const [modeId, modePatterns] of Object.entries(this.patterns)) {
      const category = categoryMap[modeId] || modeId;
      if (!categories[category]) {
        categories[category] = {};
      }
      Object.assign(categories[category], modePatterns);
    }

    return categories;
  },

  /**
   * Get patterns for a specific category
   * @param {string} category - Category name
   */
  getPatternsForCategory(category) {
    const byCategory = this.getPatternsByCategory();
    return byCategory[category] || {};
  },

  /**
   * Get AI prompt for a mode
   * @param {string} modeId - Mode identifier
   */
  getAIPrompt(modeId) {
    return this.modes[modeId]?.aiPrompts || null;
  }
};

// Export for use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PlayModeLoader };
}

// ES Module export for browser
export { PlayModeLoader };
export default PlayModeLoader;
