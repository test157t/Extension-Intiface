/**
* Play Mode Loader
* Discovers, loads, and manages modular play modes
* Replaces hardcoded mode constants with dynamic loading
* All modes are discovered from the play_modes folder structure
*/

const PlayModeLoader = {
  // Registry of loaded modes (key = folder name)
  modes: {},

  // Registry of all available patterns organized by mode folder name
  patterns: {},

  // Registry of sequences organized by mode folder name
  sequences: {},

  // Mode settings (enabled/disabled)
  settings: {},

  // Base path for loading mode files
  basePath: '/scripts/extensions/third-party/Extension-Intiface/play_modes',

  /**
  * Initialize the loader
  * Discovers modes from filesystem, loads basic first, then others
  */
  async init() {
    // Discover available modes from filesystem
    const modeIds = await this.discoverModes();
    console.log(`[PlayModeLoader] Discovered ${modeIds.length} modes:`, modeIds);

    // Load basic mode first (always enabled, not toggleable)
    if (modeIds.includes('basic')) {
      await this.loadMode('basic');
    }

    // Load settings from localStorage
    this.loadSettings();

    // Load other modes
    for (const modeId of modeIds) {
      if (modeId !== 'basic') {
        await this.loadMode(modeId);
      }
    }

    // Load custom user-created modes from localStorage
    this.loadCustomModes();

    console.log(`[PlayModeLoader] Loaded:`);
    console.log(` - Modes: ${Object.keys(this.modes).length}`);
    console.log(` - Patterns: ${Object.keys(this.patterns).length} mode(s)`);
    console.log(` - Sequences: ${Object.keys(this.sequences).length} mode(s)`);

    return this;
  },

  /**
  * Discover available modes by scanning the play_modes directory
  * Uses a manifest file or directory listing to find mode folders
  * @returns {string[]} Array of mode folder names
  */
  async discoverModes() {
    try {
      // Try to fetch a modes manifest file first
      const manifestResponse = await fetch(`${this.basePath}/modes.json`);
      if (manifestResponse.ok) {
        const manifest = await manifestResponse.json();
        return manifest.modes || [];
      }
    } catch (e) {
      // Manifest doesn't exist, fall back to scanning
    }

    // Fallback: scan directory by attempting to load mode.json from common mode folders
    // This is done by checking which folders have a valid mode.json
    const potentialModes = [
      'basic', 'denial', 'milking', 'training', 'robotic',
      'sissy', 'prejac', 'evil', 'frustration', 'hypno', 'chastity'
    ];

    const discoveredModes = [];

    for (const modeId of potentialModes) {
      try {
        const response = await fetch(`${this.basePath}/${modeId}/mode.json`);
        if (response.ok) {
          discoveredModes.push(modeId);
        }
      } catch (e) {
        // Mode doesn't exist, skip
      }
    }

    // If no modes discovered, return empty array (basic will be handled separately)
    return discoveredModes;
  },

  /**
  * Load a specific mode from its folder
  * @param {string} modeId - Mode folder name
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

      // Store mode data using folder name as the key
      this.modes[modeId] = modeData;

      // Load patterns.js if it exists
      try {
        await this.loadScript(`${this.basePath}/${modeId}/patterns.js`);

        // Wait a tick for script to execute
        await new Promise(resolve => setTimeout(resolve, 10));

        // Register patterns - use folder name to find the global variable
        const patternVarName = this.getPatternVariableName(modeId);
        if (window[patternVarName]) {
          this.patterns[modeId] = window[patternVarName];
        } else {
          // Try alternative naming (for backwards compatibility)
          const altPatternVarName = this.getPatternVariableName(modeData.id);
          if (window[altPatternVarName]) {
            this.patterns[modeId] = window[altPatternVarName];
          } else {
            console.warn(`[PlayModeLoader] Pattern variable not found for ${modeId} (tried ${patternVarName})`);
          }
        }
      } catch (e) {
        // Patterns.js is optional
      }

      // Load sequences.json if it exists
      try {
        const seqResponse = await fetch(`${this.basePath}/${modeId}/sequences.json`);
        if (seqResponse.ok) {
          const sequences = await seqResponse.json();
          this.sequences[modeId] = sequences;
        }
      } catch (e) {
        // sequences.json is optional
      }

      // Initialize settings with defaults from mode.json
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
  * Load custom user-created modes from localStorage
  * These are modes created via the Mode Builder UI
  */
  loadCustomModes() {
    try {
      const saved = localStorage.getItem('intiface-custom-modes');
      if (!saved) return;

      const customModes = JSON.parse(saved);
      let loadedCount = 0;

      for (const [modeId, modeData] of Object.entries(customModes)) {
        // Skip if a built-in mode with same ID exists
        if (this.modes[modeId]) {
          console.warn(`[PlayModeLoader] Custom mode '${modeId}' conflicts with built-in mode, skipping`);
          continue;
        }

        // Register the custom mode
        this.modes[modeId] = modeData;

        // Register custom patterns
        if (modeData.patterns && Object.keys(modeData.patterns).length > 0) {
          this.patterns[modeId] = {};
          for (const [patternName, patternCode] of Object.entries(modeData.patterns)) {
            try {
              // Create function from code string
              const patternFunc = new Function('phase', 'intensity', patternCode);
              this.patterns[modeId][patternName] = patternFunc;
            } catch (e) {
              console.warn(`[PlayModeLoader] Failed to compile pattern '${patternName}':`, e);
            }
          }
        }

        // Register custom sequences
        if (modeData.sequences) {
          this.sequences[modeId] = modeData.sequences;
        }

        // Initialize settings
        if (!(modeId in this.settings)) {
          this.settings[modeId] = {
            enabled: modeData.ui?.defaultEnabled ?? false,
            intensityMultiplier: modeData.intensityMultiplier ?? 1.0
          };
        }

        loadedCount++;
      }

      if (loadedCount > 0) {
        console.log(`[PlayModeLoader] Loaded ${loadedCount} custom modes from localStorage`);
      }
    } catch (e) {
      console.error('[PlayModeLoader] Failed to load custom modes:', e);
    }
  },

  /**
  * Load a script dynamically
  * @param {string} url - Script URL
  */
  loadScript(url) {
    return new Promise((resolve, reject) => {
      // Check if script already loaded
      if (document.querySelector(`script[src="${url}"]`)) {
        resolve();
        return;
      }

      const script = document.createElement('script');
      script.src = url;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  },

  /**
  * Get the global variable name for a mode's patterns
  * Converts folder name to PascalCase + Patterns suffix
  * @param {string} modeId - Mode folder name
  */
  getPatternVariableName(modeId) {
    // Convert snake_case or kebab-case to PascalCase
    const parts = modeId.split(/[_-]/);
    const pascalCase = parts.map(part =>
      part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
    ).join('');
    return pascalCase + 'Patterns';
  },

  /**
  * Load settings from localStorage
  * Handles migration from legacy format
  */
  loadSettings() {
    const saved = localStorage.getItem('intiface-playmode-settings');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        
        // Migrate from legacy format (boolean values) to new format (objects)
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === 'boolean') {
            // Legacy format: { denial: true } -> convert to { denial: { enabled: true, intensityMultiplier: 1.0 } }
            this.settings[key] = {
              enabled: value,
              intensityMultiplier: 1.0
            };
          } else if (typeof value === 'object' && value !== null) {
            // New format already
            this.settings[key] = value;
          }
        }
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
  * @param {string} modeId - Mode folder name
  * @param {boolean} enabled - Enabled state
  */
  setModeEnabled(modeId, enabled) {
    // Initialize settings for this mode if not exists
    if (!this.settings[modeId] || typeof this.settings[modeId] !== 'object') {
      this.settings[modeId] = {
        enabled: enabled,
        intensityMultiplier: this.modes[modeId]?.intensityMultiplier ?? 1.0
      };
    } else {
      this.settings[modeId].enabled = enabled;
    }
    this.saveSettings();
  },

  /**
  * Check if a mode is enabled
  * @param {string} modeId - Mode folder name
  */
  isModeEnabled(modeId) {
    // Basic mode is always enabled
    if (modeId === 'basic') return true;
    const setting = this.settings[modeId];
    if (typeof setting === 'boolean') {
      // Handle legacy boolean format
      return setting;
    }
    return setting?.enabled ?? false;
  },

  /**
  * Get all loaded modes
  * @returns {Object} Object with modeId -> modeData
  */
  getAllModes() {
    return this.modes;
  },

  /**
  * Get all toggleable modes (excluding basic)
  * @returns {Object} Object with modeId -> modeData for toggleable modes
  */
  getToggleableModes() {
    const result = {};
    for (const [modeId, modeData] of Object.entries(this.modes)) {
      if (modeData.ui?.toggleable !== false && modeId !== 'basic') {
        result[modeId] = modeData;
      }
    }
    return result;
  },

  /**
  * Get all enabled modes
  * @returns {string[]} Array of mode folder names
  */
  getEnabledModes() {
    return Object.keys(this.modes).filter(id => this.isModeEnabled(id));
  },

  /**
  * Get mode metadata
  * @param {string} modeId - Mode folder name
  */
  getMode(modeId) {
    return this.modes[modeId] || null;
  },

  /**
  * Get all patterns for a specific mode
  * @param {string} modeId - Mode folder name
  */
  getPatternsForMode(modeId) {
    return this.patterns[modeId] || {};
  },

  /**
  * Get all sequences for a specific mode
  * @param {string} modeId - Mode folder name
  */
  getSequencesForMode(modeId) {
    return this.sequences[modeId] || {};
  },

  /**
  * Get sequences for all enabled modes
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
  * @param {string} modeId - Mode folder name
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
    return this.getPattern(patternName) !== null;
  },

  /**
  * Get all available patterns organized by mode
  * Returns patterns grouped by mode folder name
  */
  getAllPatterns() {
    return this.patterns;
  },

  /**
  * Get all patterns organized for UI display
  * Returns patterns grouped by mode with metadata
  */
  getPatternsForUI() {
    const result = {};
    for (const [modeId, modePatterns] of Object.entries(this.patterns)) {
      if (this.isModeEnabled(modeId)) {
        result[modeId] = {
          mode: this.modes[modeId],
          patterns: modePatterns
        };
      }
    }
    return result;
  },

  /**
  * Get intensity multiplier for a mode
  * @param {string} modeId - Mode folder name
  */
  getIntensityMultiplier(modeId) {
    return this.settings[modeId]?.intensityMultiplier ??
      this.modes[modeId]?.intensityMultiplier ?? 1.0;
  },

  /**
  * Set intensity multiplier for a mode
  * @param {string} modeId - Mode folder name
  * @param {number} multiplier - Intensity multiplier
  */
  setIntensityMultiplier(modeId, multiplier) {
    // Initialize settings for this mode if not exists
    if (!this.settings[modeId] || typeof this.settings[modeId] !== 'object') {
      this.settings[modeId] = {
        enabled: this.modes[modeId]?.ui?.defaultEnabled ?? false,
        intensityMultiplier: multiplier
      };
    } else {
      this.settings[modeId].intensityMultiplier = multiplier;
    }
    this.saveSettings();
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
  * Get AI prompt for a mode
  * @param {string} modeId - Mode folder name
  */
  getAIPrompt(modeId) {
    return this.modes[modeId]?.aiPrompts || null;
  },

  /**
  * Refresh modes - reload custom modes and regenerate UI
  * Call this after adding/editing custom modes
  */
  refresh() {
    // Reload custom modes
    this.loadCustomModes();

    console.log(`[PlayModeLoader] Refreshed: ${Object.keys(this.modes).length} total modes`);

    // Return current state for UI regeneration
    return this.getUIData();
  },

  /**
  * Get display info for UI generation
  * Returns all info needed to generate tabs, toggles, etc.
  */
  getUIData() {
    const data = {
      modes: [],
      toggleable: [],
      basic: null
    };

    for (const [modeId, modeData] of Object.entries(this.modes)) {
      const uiInfo = {
        id: modeId,
        name: modeData.name || modeId,
        description: modeData.description || '',
        icon: modeData.ui?.icon || 'fa-circle',
        color: modeData.ui?.color || '#888',
        enabled: this.isModeEnabled(modeId),
        toggleable: modeData.ui?.toggleable !== false && modeId !== 'basic',
        defaultEnabled: modeData.ui?.defaultEnabled ?? false,
        intensityMultiplier: this.getIntensityMultiplier(modeId),
        hasPatterns: !!this.patterns[modeId] && Object.keys(this.patterns[modeId]).length > 0,
        hasSequences: !!this.sequences[modeId] && Object.keys(this.sequences[modeId]).length > 0,
        patternCount: this.patterns[modeId] ? Object.keys(this.patterns[modeId]).length : 0,
        sequenceCount: this.sequences[modeId] ? Object.keys(this.sequences[modeId]).length : 0
      };

      data.modes.push(uiInfo);

      if (modeId === 'basic') {
        data.basic = uiInfo;
      } else if (uiInfo.toggleable) {
        data.toggleable.push(uiInfo);
      }
    }

    return data;
  },

  /**
  * Generate HTML for mode tabs
  * @returns {string} HTML string for tabs
  */
  generateTabsHTML() {
    const uiData = this.getUIData();
    const enabledModes = uiData.modes.filter(m => m.enabled || m.id === 'basic');

    return enabledModes.map(mode => `
      <button id="intiface-tab-${mode.id}" class="menu_button playmode-tab ${mode.id === 'basic' ? 'active' : ''}" data-category="${mode.id}"
        style="padding: 4px 10px; font-size: 0.75em; border-radius: 3px; ${mode.id === 'basic' ? 'background: rgba(100,150,255,0.3);' : ''}">
        <i class="fa-solid ${mode.icon}" style="color: ${mode.color};"></i> ${mode.name}
      </button>
    `).join('');
  },

  /**
  * Generate HTML for mode toggles
  * @returns {string} HTML string for toggles
  */
  generateTogglesHTML() {
    const uiData = this.getUIData();

    return uiData.toggleable.map(mode => `
      <label style="font-size: 0.75em; display: flex; align-items: center; cursor: pointer; background: rgba(${this.hexToRgb(mode.color)},0.1); padding: 3px 8px; border-radius: 3px;">
        <input type="checkbox" id="intiface-mode-${mode.id}" class="playmode-toggle" data-mode="${mode.id}" ${mode.enabled ? 'checked' : ''} style="margin-right: 5px;">
        <i class="fa-solid ${mode.icon}" style="margin-right: 4px; color: ${mode.color}; font-size: 0.8em;"></i>
        ${mode.name}
      </label>
    `).join('');
  },

  /**
  * Generate HTML for intensity sliders
  * @returns {string} HTML string for intensity controls
  */
  generateIntensityHTML() {
    const uiData = this.getUIData();

    return uiData.toggleable.map(mode => `
      <div class="intensity-slider-container" data-mode="${mode.id}" style="margin-bottom: 10px; ${mode.enabled ? '' : 'display: none;'}">
        <div style="display: flex; justify-content: space-between; font-size: 0.75em; margin-bottom: 3px;">
          <span>${mode.name}</span>
          <span id="intiface-mode-intensity-${mode.id}-display" style="color: #64B5F6;">${Math.round(mode.intensityMultiplier * 100)}%</span>
        </div>
        <input type="range" id="intiface-mode-intensity-${mode.id}" min="50" max="400" value="${Math.round(mode.intensityMultiplier * 100)}" style="width: 100%;" data-mode="${mode.id}">
      </div>
    `).join('');
  },

  /**
  * Helper: Convert hex color to RGB
  */
  hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ?
      `${parseInt(result[1], 16)},${parseInt(result[2], 16)},${parseInt(result[3], 16)}` :
      '100,100,100';
  }
};

// Export for use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PlayModeLoader };
}

// ES Module export for browser
export { PlayModeLoader };
export default PlayModeLoader;
