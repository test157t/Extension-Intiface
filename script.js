import { renderExtensionTemplateAsync } from "../../../extensions.js"
import { eventSource, event_types, setExtensionPrompt, extension_prompt_types, extension_prompt_roles, getRequestHeaders, messageFormatting, appendMediaToMessage, addCopyToCodeBlocks } from "../../../../script.js"
import { PlayModeLoader } from "./play_modes/_loader.js"
import {
  mediaPlayer,
  funscriptCache,
  initMediaModule,
  initMediaPlayer,
  loadMediaPlayerAppearance,
  saveMediaPlayerAppearance,
  applyMediaPlayerAppearance,
  startInternalProxy,
  stopInternalProxy,
  updateProxyStatus,
  refreshMenuMediaList,
  loadFunscript,
  processFunscript,
  startFunscriptSync,
  stopFunscriptSync,
  startFunscriptSyncTimer,
  stopFunscriptSyncTimer,
  executeFunscriptAction,
  stopMediaPlayback,
  updateMediaPlayerStatus,
  createChatSidebarPanel,
  setupChatPanelEventHandlers,
  showChatMediaPanel,
  hideChatMediaPanel,
  loadChatMediaFile,
  setupChatVideoEventListeners,
  updateChatFunscriptUI,
  handleFunscriptView,
  checkForVideoMentions
} from "./media.js"

// @ts-ignore: Hack to suppress IDE errors
const $ = window.$
// @ts-ignore
const { getContext } = window.SillyTavern
const NAME = "intiface-connect"
const extensionName = "Extension-Intiface"

let buttplug
let client
let connector
let device
let devices = [] // Track all connected devices
let deviceAssignments = {} // device.index -> 'A', 'B', 'C', etc. for multi-funscript support
let intervalId

// Chat-based control variables
let messageCommands = [] // Commands from current AI message
let executedCommands = new Set() // Track executed commands
let streamingText = '' // Accumulate streaming text
let seenCommands = new Set() // Track command text signatures that have been seen complete
let commandQueueInterval = null // Interval for sequential execution
let isExecutingCommands = false
let isStartingIntiface = false // Prevent multiple simultaneous start attempts

// Timer worker for background vibration (avoids setTimeout throttling in hidden tabs)
let timerWorker = null
let workerTimers = new Map() // timerId -> { callback, interval, createdAt, lastExecuted, isOneShot }
let workerTimerId = 0
let isWorkerTimerRunning = false

// Mode settings (which mode categories are enabled)
let modeSettings = {
  denialDomina: true,
  milkMaid: true,
  petTraining: true,
  sissySurrender: true,
  prejacPrincess: true,
  roboticRuination: true,
  evilEdgingMistress: true,
  frustrationFairy: true,
  hypnoHelper: true,
  chastityCaretaker: true
}

// Global intensity scale (affects ALL playback, not just funscripts)
// AI can override this via INTENSITY command
let globalIntensityScale = 100 // Default 100% (no scaling)

// Mode-specific intensity multipliers (stacked on top of global intensity)
// These add slight variations based on the mode's character
// User can adjust these per mode (50%-150% range)
let modeIntensityMultipliers = {
  denialDomina: 1.0,
  milkMaid: 1.0,
  petTraining: 1.0,
  sissySurrender: 1.0,
  prejacPrincess: 1.0,
  roboticRuination: 1.0,
  evilEdgingMistress: 1.0,
  frustrationFairy: 1.0,
  hypnoHelper: 1.0,
  chastityCaretaker: 1.0
}

// Prompt update tracking to prevent excessive reinjection
let lastPromptHash = ''
let promptUpdateTimer = null
let pendingPromptUpdate = false

// Global inversion setting (applies to ALL devices)
let globalInvert = false

// Load global inversion from localStorage
function loadGlobalInvert() {
  try {
    const saved = localStorage.getItem('intiface-global-invert')
    if (saved !== null) {
      globalInvert = saved === 'true'
      console.log(`${NAME}: Loaded global invert: ${globalInvert}`)
    }
  } catch (e) {
    console.error(`${NAME}: Failed to load global invert:`, e)
    globalInvert = false
  }
}

// Save global inversion to localStorage
function saveGlobalInvert(value) {
  try {
    globalInvert = value
    localStorage.setItem('intiface-global-invert', value.toString())
    console.log(`${NAME}: Saved global invert: ${value}`)
  } catch (e) {
    console.error(`${NAME}: Failed to save global invert:`, e)
  }
}

// Apply inversion to intensity/position values (0-100)
function applyInversion(value) {
  if (globalInvert) {
    return 100 - value
  }
  return value
}

// Global device polling rate (Hz) - controls how often commands are sent to devices
// Higher = smoother but more CPU/BT traffic, Lower = less spam but less smooth
let devicePollingRate = 30 // Default 30Hz (33ms interval)

// Load polling rate from localStorage
function loadDevicePollingRate() {
  try {
    const saved = localStorage.getItem('intiface-polling-rate')
    if (saved) {
      devicePollingRate = parseInt(saved, 10) || 30
      // Validate range
      if (devicePollingRate < 10) devicePollingRate = 10
      if (devicePollingRate > 120) devicePollingRate = 120
    }
    console.log(`${NAME}: Device polling rate set to ${devicePollingRate}Hz`)
  } catch (e) {
    console.error(`${NAME}: Failed to load polling rate:`, e)
    devicePollingRate = 30
  }
}

// Save polling rate to localStorage
function saveDevicePollingRate(rate) {
  try {
    devicePollingRate = rate
    localStorage.setItem('intiface-polling-rate', rate.toString())
    console.log(`${NAME}: Device polling rate saved: ${rate}Hz`)
  } catch (e) {
    console.error(`${NAME}: Failed to save polling rate:`, e)
  }
}

// Get polling interval in milliseconds
function getPollingInterval() {
  return Math.round(1000 / devicePollingRate)
}

// Apply global intensity to values with optional mode scaling
function applyIntensityScale(values, modeName = null) {
  // Get base scale from global intensity (default 100%)
  let scale = globalIntensityScale / 100
  
  // Apply mode-specific multiplier if provided
  if (modeName && modeIntensityMultipliers[modeName]) {
    scale *= modeIntensityMultipliers[modeName]
  }
  
  // Scale values around neutral point (50) to preserve dynamic range
  return values.map(v => {
    const scaled = 50 + (v - 50) * scale
    return Math.min(100, Math.max(0, Math.round(scaled)))
  })
}

// Initialize timer worker
function initTimerWorker() {
  try {
    const workerUrl = new URL('timer-worker.js', import.meta.url).href
    timerWorker = new Worker(workerUrl)

    timerWorker.onmessage = (e) => {
      const { type, drift, timerId: workerTimerId_, timestamp } = e.data
      if (type === 'tick') {
        // Execute callbacks for timers that are due
        const now = timestamp || Date.now()
        const timersToExecute = []

        for (const [id, timer] of workerTimers) {
          if (!timer.callback) continue

          // Check if this timer is due to execute
          const timeSinceCreationOrLast = timer.lastExecuted ? now - timer.lastExecuted : now - timer.createdAt
          const isDue = timeSinceCreationOrLast >= timer.interval

          if (isDue) {
            timersToExecute.push(id)
          }
        }

        // Execute all due timers
        for (const id of timersToExecute) {
          const timer = workerTimers.get(id)
          if (timer && timer.callback) {
            try {
              timer.callback()
              if (!timer.isOneShot) {
                // For repeating timers, update lastExecuted time
                timer.lastExecuted = now
              } else {
                // For one-shot timers, remove them
                workerTimers.delete(id)
              }
            } catch (err) {
              console.error(`${NAME}: Timer callback error:`, err)
              workerTimers.delete(id)
            }
          }
        }
      } else if (type === 'heartbeat') {
        // Keep worker alive
      }
    }
    
    timerWorker.onerror = (err) => {
      console.error(`${NAME}: Timer worker error:`, err)
      timerWorker = null
      isWorkerTimerRunning = false
    }
    
    console.log(`${NAME}: Timer worker initialized successfully`)
  } catch (e) {
    console.error(`${NAME}: Failed to initialize timer worker:`, e)
    timerWorker = null
  }
}

// Set timeout using worker (if available) or fall back to regular setTimeout
function setWorkerTimeout(callback, delay) {
  if (timerWorker && delay >= 50) {
    const id = ++workerTimerId
    const now = Date.now()
    workerTimers.set(id, { callback, interval: delay, createdAt: now, lastExecuted: null, isOneShot: true })

    // Only start the worker timer if not already running
    if (!isWorkerTimerRunning) {
      timerWorker.postMessage({ command: 'start', data: { interval: delay } })
      isWorkerTimerRunning = true
    }

    return id
  } else {
    return setTimeout(callback, delay)
  }
}

// Set interval using worker
function setWorkerInterval(callback, delay) {
  if (timerWorker && delay >= 50) {
    const id = ++workerTimerId
    const now = Date.now()
    workerTimers.set(id, { callback, interval: delay, createdAt: now, lastExecuted: null, isOneShot: false })

    // Only start the worker timer if not already running
    if (!isWorkerTimerRunning) {
      timerWorker.postMessage({ command: 'start', data: { interval: delay } })
      isWorkerTimerRunning = true
    }

    return id
  } else {
    return setInterval(callback, delay)
  }
}

// Clear worker timeout/interval
function clearWorkerTimeout(id) {
  if (typeof id === 'number' && workerTimers.has(id)) {
    workerTimers.delete(id)

    // If no more timers, stop the worker
    if (timerWorker && workerTimers.size === 0 && isWorkerTimerRunning) {
      timerWorker.postMessage({ command: 'stop' })
      isWorkerTimerRunning = false
    }
  } else if (typeof id === 'number' && id !== 0) {
    // It's a native setInterval ID (not in workerTimers)
    clearInterval(id)
  } else if (typeof id === 'object' && id !== null) {
    // It's a regular timeout ID
    clearTimeout(id)
  }
}


// UNIFIED PLAY MODE SYSTEM
// =======================
// All patterns consolidated into one library with device compatibility

const PatternLibrary = {
  // Device compatibility metadata for patterns
  // All patterns work with all devices by default, but some are optimized
  compatibility: {
    // Device type to waveform pattern mappings - which patterns work best with which device types
    // All device types default to 'general' patterns if not specified here
    byDeviceType: {
      vibration: ['sine', 'pulse', 'heartbeat', 'tickle', 'edging', 'ruin', 'teasing', 'desperation',
        'mercy', 'stop_start', 'random_tease', 'micro_tease', 'abrupt_edge', 'crescendo',
        'tidal_wave', 'milking_pump', 'relentless', 'overload', 'tsunami', 'forbidden_peaks'],
      linear: ['sine', 'sawtooth', 'triangle', 'pulse', 'ramp_up', 'ramp_down', 'ripple_thruster',
        'crescendo', 'tsunami', 'milking_pump']
    },
    // All devices support all patterns - will be populated after initialization
    all: []
  },

  // Device type detection configuration
  // Maps device name patterns to device types and properties
  devices: {
    // Device type patterns - used to detect device type from device name
    typePatterns: {
      cage: ['cage'],
      plug: ['plug'],
      stroker: ['solace', 'stroker', 'launch'],
      vibrator: ['lush', 'hush', 'nora', 'max', 'domi'],
      gush: ['gush'],
      general: [] // Fallback for unmatched devices
    },
    // Device-specific default intensities
    defaultIntensities: {
      gush: 117, // Gush 2 works better at 117%
      default: 100
    },
    // Device shorthand mappings (for display)
    shorthandPatterns: {
      cage: ['cage'],
      plug: ['plug'],
      solace: ['solace'],
      lush: ['lush'],
      hush: ['hush'],
      nora: ['nora'],
      max: ['max'],
      domi: ['domi'],
      edge: ['edge'],
      gush: ['gush']
    }
  },

  // Preset patterns - ready-to-use configurations
  presets: {
    // Basic/simple patterns (always available)
    warmup: {
      type: 'waveform',
      pattern: 'sine',
      min: 10,
      max: 30,
      duration: 5000,
      cycles: 3,
      description: 'Gentle warmup pattern',
      compatibleDevices: ['cage', 'plug', 'stroker', 'general']
    },
    tease: {
      type: 'waveform',
      pattern: 'teasing',
      min: 20,
      max: 60,
      duration: 8000,
      cycles: 4,
      description: 'Irregular teasing pattern',
      compatibleDevices: ['cage', 'plug', 'general']
    },
    pulse: {
      type: 'waveform',
      pattern: 'pulse',
      min: 30,
      max: 70,
      duration: 4000,
      cycles: 8,
      description: 'Rhythmic pulsing',
      compatibleDevices: ['cage', 'plug', 'general']
    },
    edge: {
      type: 'waveform',
      pattern: 'edging',
      min: 10,
      max: 90,
      duration: 12000,
      cycles: 2,
      description: 'Build to edge then stop',
      compatibleDevices: ['cage', 'plug', 'general']
    },

    // General patterns for all devices
    build: { type: 'waveform', pattern: 'ramp_up', min: 30, max: 80, duration: 12000, cycles: 1, description: 'Gradual build', compatibleDevices: ['cage', 'plug', 'stroker', 'general'] },
    peak: { type: 'waveform', pattern: 'square', min: 70, max: 100, duration: 3000, cycles: 3, description: 'Peak intensity', compatibleDevices: ['cage', 'plug', 'general'] },
    cooldown: { type: 'gradient', start: 60, end: 10, duration: 8000, description: 'Cool down', compatibleDevices: ['cage', 'plug', 'stroker', 'general'] },
    peak_and_drop: { type: 'waveform', pattern: 'peak_and_drop', min: 5, max: 95, duration: 6000, cycles: 3, description: 'Peak to 95% then drop', compatibleDevices: ['cage', 'plug', 'general'] },
    flutter: { type: 'waveform', pattern: 'flutter', min: 5, max: 50, duration: 4000, cycles: 8, description: 'Light fluttering', compatibleDevices: ['cage', 'plug', 'general'] }
  },



  // Helper function to get compatible presets for a device type
  getCompatiblePresets(deviceType) {
    return Object.entries(this.presets)
      .filter(([_, preset]) => 
        preset.compatibleDevices.includes(deviceType) || 
        preset.compatibleDevices.includes('general')
      )
      .reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {});
  },

  // Helper function to check if pattern is compatible
  isCompatible(patternName, deviceType) {
    const preset = this.presets[patternName];
    if (!preset) return true; // Unknown patterns assumed compatible
    return preset.compatibleDevices.includes(deviceType) || 
           preset.compatibleDevices.includes('general');
  }
};

// Active pattern tracking
let activePatterns = new Map(); // deviceIndex -> { pattern, interval, controls }

// NOTE: All play modes have been migrated to the modular system
// Each mode has its own directory in play_modes/ with mode.json, patterns.js, and sequences.json
// The PlayModeLoader dynamically loads and manages these modes
// Access modes via: PlayModeLoader.getSequence(modeId, sequenceName)

function applyMaxVibrate(value, motorIndex = 0) {
  // No max limit anymore, just return the value clamped to 0-100
  return Math.min(value, 100)
}

function applyMaxOscillate(value) {
  return Math.min(value, 100)
}

// Generate waveform pattern values
function generateWaveformValues(pattern, steps, min, max) {
  const values = []
  const generator = PlayModeLoader.getPattern(pattern) || PlayModeLoader.getPattern('sine')
  const range = max - min
  
  for (let i = 0; i < steps; i++) {
    const phase = i / steps
    const normalized = generator(phase, 1)
    const value = min + (normalized * range)
    values.push(Math.max(0, Math.min(100, Math.round(value))))
  }
  return values
}

// Generate dual motor waveform values with phase offset for motor 2
function generateDualMotorWaveform(pattern, steps, min, max) {
  const motor1Values = []
  const motor2Values = []
  const generator = PlayModeLoader.getPattern(pattern) || PlayModeLoader.getPattern('sine')
  const range = max - min

  for (let i = 0; i < steps; i++) {
    // Motor 1: Normal phase
    const phase1 = i / steps
    const normalized1 = generator(phase1, 1)
    const value1 = min + (normalized1 * range)
    motor1Values.push(Math.max(0, Math.min(100, Math.round(value1))))

    // Motor 2: Phase offset by 0.5 (opposite timing) for diversity
    const phase2 = ((i / steps) + 0.5) % 1
    const normalized2 = generator(phase2, 1)
    const value2 = min + (normalized2 * range)
    motor2Values.push(Math.max(0, Math.min(100, Math.round(value2))))
  }

  return { motor1: motor1Values, motor2: motor2Values }
}

// Check if device has multiple motors
function getMotorCount(device) {
  if (!device || !device.vibrateAttributes) return 1
  return device.vibrateAttributes.length || 1
}
async function executeWaveformPattern(deviceIndex, presetName, options = {}) {
  const targetDevice = devices[deviceIndex] || devices[0]
  if (!targetDevice) {
    console.error(`${NAME}: No device found for waveform pattern`)
    return
  }

  // Determine device type using PatternLibrary configuration
  const deviceType = getDeviceType(targetDevice)

  // Get preset from PatternLibrary
  let preset = PatternLibrary.presets[presetName]
  // Check compatibility - if not compatible with this device type, try device-specific version
  if (preset && !PatternLibrary.isCompatible(presetName, deviceType)) {
    const deviceSpecificName = `${deviceType}_${presetName}`
    if (PatternLibrary.presets[deviceSpecificName]) {
      preset = PatternLibrary.presets[deviceSpecificName]
    }
  }
  // Fall back to warmup if preset not found or not compatible
  if (!preset || !PatternLibrary.isCompatible(presetName, deviceType)) {
    preset = PatternLibrary.presets.warmup || { type: 'waveform', pattern: 'sine', min: 20, max: 60, duration: 3000, cycles: 3 }
  }

  // Merge with options
  const config = { ...preset, ...options }

  // Stop existing pattern for this device
  await stopDevicePattern(deviceIndex)

  const deviceName = getDeviceDisplayName(targetDevice)

  if (config.type === 'waveform') {
    const steps = Math.floor(config.duration / 100) // 100ms resolution
    const intervals = Array(steps).fill(100)

    // Check if device has multiple motors
    const motorCount = getMotorCount(targetDevice)
    let patternData

    if (motorCount >= 2) {
      // Generate dual motor pattern with phase offset
      const dualValues = generateDualMotorWaveform(config.pattern, steps, config.min, config.max)
      // Apply global intensity scaling
      dualValues.motor1 = applyIntensityScale(dualValues.motor1)
      dualValues.motor2 = applyIntensityScale(dualValues.motor2)
      // Apply device inversion
      dualValues.motor1 = dualValues.motor1.map(v => applyInversion(v))
      dualValues.motor2 = dualValues.motor2.map(v => applyInversion(v))
      patternData = {
          pattern: dualValues,
          intervals: intervals,
          loop: config.cycles || 1,
          fromTimeline: config.fromTimeline || false
        }
        updateStatus(`${deviceName}: ${presetName} dual-motor pattern (${config.pattern}) [${globalIntensityScale}%]`)
      } else {
        // Single motor - traditional approach
        const values = generateWaveformValues(config.pattern, steps, config.min, config.max)
        // Apply global intensity scaling
        const scaledValues = applyIntensityScale(values)
        // Apply device inversion
        const invertedValues = scaledValues.map(v => applyInversion(v))
        patternData = {
          pattern: invertedValues,
          intervals: intervals,
          loop: config.cycles || 1,
          fromTimeline: config.fromTimeline || false
        }
      updateStatus(`${deviceName}: ${presetName} pattern (${config.pattern}) [${globalIntensityScale}%]`)
    }

    const patternResult = await executePattern(patternData, 'vibrate', deviceIndex)
    // Store pattern result for proper cleanup
    // patternResult is a Promise with a .stop() method attached
    if (patternResult && typeof patternResult.stop === 'function') {
      activePatterns.set(deviceIndex, {
        mode: 'pattern',
        modeName: `waveform_${presetName}`,
        stop: patternResult.stop
      })
    }
  } else if (config.type === 'gradient') {
    await executeGradientPattern(deviceIndex, config)
    updateStatus(`${deviceName}: ${presetName} gradient`)
  } else if (config.type === 'linear_waveform') {
    await executeLinearWaveform(deviceIndex, config)
    updateStatus(`${deviceName}: ${presetName} linear pattern`)
  } else if (config.type === 'linear_gradient') {
    await executeLinearGradient(deviceIndex, config)
    updateStatus(`${deviceName}: ${presetName} linear gradient`)
  }
}

// Execute gradient pattern (smooth intensity transition)
async function executeGradientPattern(deviceIndex, config) {
  const { start, end, duration, hold = 0, release = 0 } = config
  const steps = Math.floor(duration / 50) // 50ms steps
  const motor1Values = []
  const motor2Values = []
  const intervals = []

  // Ramp up
  for (let i = 0; i < steps; i++) {
    const progress = i / steps
    const value = Math.round(start + (end - start) * progress)
    motor1Values.push(value)
    // Motor 2: Inverted gradient for diversity
    motor2Values.push(Math.round(start + (end - start) * (1 - progress)))
    intervals.push(50)
  }

  // Hold
  if (hold > 0) {
    const holdSteps = Math.floor(hold / 100)
    for (let i = 0; i < holdSteps; i++) {
      motor1Values.push(end)
      motor2Values.push(end)
      intervals.push(100)
    }
  }

  // Release
  if (release > 0) {
    const releaseSteps = Math.floor(release / 50)
    for (let i = 0; i < releaseSteps; i++) {
      const progress = i / releaseSteps
      const value = Math.round(end - (end * progress))
      motor1Values.push(value)
      // Motor 2: Inverted release
      motor2Values.push(Math.round(end * progress))
      intervals.push(50)
    }
  }

// Check if device has multiple motors
  const targetDevice = devices[deviceIndex] || devices[0]
  const motorCount = getMotorCount(targetDevice)

  // Apply global intensity scaling to gradient values
  const scaledMotor1Values = applyIntensityScale(motor1Values)
  const scaledMotor2Values = applyIntensityScale(motor2Values)

  // Apply device inversion
  const invertedMotor1Values = scaledMotor1Values.map(v => applyInversion(v))
  const invertedMotor2Values = scaledMotor2Values.map(v => applyInversion(v))

  let patternData
  if (motorCount >= 2) {
    patternData = {
      pattern: { motor1: invertedMotor1Values, motor2: invertedMotor2Values },
      intervals
    }
  } else {
    patternData = { pattern: invertedMotor1Values, intervals }
  }

  const patternResult = await executePattern(patternData, 'vibrate', deviceIndex)
// Store pattern result for proper cleanup
if (patternResult && typeof patternResult === 'function') {
activePatterns.set(deviceIndex, {
mode: 'pattern',
modeName: 'gradient',
stop: patternResult
})
}
return patternResult
}

// Execute linear waveform (position-based)
async function executeLinearWaveform(deviceIndex, config) {
  const { pattern, positions, duration, cycles } = config
  const [startPos, endPos] = positions
  const steps = Math.floor(duration / 100)
  const generator = PlayModeLoader.getPattern(pattern) || PlayModeLoader.getPattern('sine')

  const targetDevice = devices[deviceIndex] || devices[0]
  if (!targetDevice) return

  // Apply device inversion to positions
  const invertedStartPos = applyInversion(startPos)
  const invertedEndPos = applyInversion(endPos)

  let currentCycle = 0
  let currentStep = 0
  let stepTimeoutId = null
  let isRunning = true

  const executeStep = async () => {
    if (!isRunning || currentCycle >= cycles || !client.connected) {
      activePatterns.delete(deviceIndex)
      return
    }

    const phase = currentStep / steps
    const normalized = generator(phase, 1)
    const position = Math.round(invertedStartPos + (invertedEndPos - invertedStartPos) * normalized)

    try {
      await targetDevice.linear(position / 100, 100)
    } catch (e) {
      console.error(`${NAME}: Linear waveform step failed:`, e)
    }

    currentStep++
    if (currentStep >= steps) {
      currentStep = 0
      currentCycle++
    }

    if (currentCycle < cycles && isRunning) {
      stepTimeoutId = setWorkerTimeout(executeStep, 100)
      // Update active patterns with the timeout ID
      activePatterns.set(deviceIndex, {
        mode: 'linear_waveform',
        modeName: `linear_${pattern}`,
        interval: stepTimeoutId
      })
    }
  }

  // Start execution
  stepTimeoutId = setWorkerTimeout(executeStep, 100)
  activePatterns.set(deviceIndex, {
    mode: 'linear_waveform',
    modeName: `linear_${pattern}`,
    interval: stepTimeoutId
  })
}

// Execute linear gradient
async function executeLinearGradient(deviceIndex, config) {
  const { positions, duration, hold = 0 } = config
  const [startPos, endPos] = positions
  const steps = Math.floor(duration / 50)

  const targetDevice = devices[deviceIndex] || devices[0]
  if (!targetDevice) return

  // Apply device inversion to positions
  const invertedStartPos = applyInversion(startPos)
  const invertedEndPos = applyInversion(endPos)

  // Create a controller to allow stopping
  let isRunning = true
  const stopController = () => { isRunning = false }
  activePatterns.set(deviceIndex, {
    mode: 'linear_gradient',
    modeName: 'linear_gradient',
    stop: stopController
  })

  for (let i = 0; i < steps; i++) {
    if (!isRunning || !client.connected) break
    const progress = i / steps
    const position = Math.round(invertedStartPos + (invertedEndPos - invertedStartPos) * progress)
    try {
      await targetDevice.linear(position / 100, 50)
    } catch (e) {
      console.error(`${NAME}: Linear gradient step failed:`, e)
    }
    if (isRunning) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }

  if (isRunning && hold > 0 && client.connected) {
    await new Promise(resolve => {
      const holdTimeout = setTimeout(resolve, hold)
      // Store timeout so it can be cleared
      activePatterns.set(deviceIndex, {
        mode: 'linear_gradient',
        modeName: 'linear_gradient',
        stop: () => {
          isRunning = false
          clearTimeout(holdTimeout)
        },
        interval: holdTimeout
      })
    })
  }

  activePatterns.delete(deviceIndex)
}

// Execute Mode sequence (Denial Domina, Milk Maid, Pet Training)
async function executeTeaseAndDenialMode(deviceIndex, modeName) {
  const targetDevice = devices[deviceIndex] || devices[0]
  if (!targetDevice) {
    console.error(`${NAME}: No device found for mode`)
    return
  }

  // Search for sequence across all enabled modes
  let mode = null
  let foundModeId = null
  const enabledModes = PlayModeLoader.getEnabledModes()
  
  console.log(`${NAME}: executeTeaseAndDenialMode - Looking for "${modeName}" in enabled modes:`, enabledModes)

  for (const modeId of enabledModes) {
    console.log(`${NAME}: Checking mode "${modeId}" for sequence "${modeName}"`)
    const sequence = PlayModeLoader.getSequence(modeId, modeName)
    console.log(`${NAME}: PlayModeLoader.getSequence("${modeId}", "${modeName}") returned:`, sequence ? 'FOUND' : 'NOT FOUND')
    if (sequence) {
      mode = sequence
      foundModeId = modeId
      break
    }
  }

        if (!mode) {
            // Silently skip - mode validation happens at parse time
            return
        }

  await stopDevicePattern(deviceIndex)

        const deviceName = getDeviceDisplayName(targetDevice)
        const sequence = mode.steps || mode.sequence
        const repeat = mode.repeat !== false

  updateStatus(`${deviceName}: ${modeName} mode (${mode.description})`)

  // Get device ID for inversion

  let sequenceIndex = 0
  let isRunning = true
  let stepTimeoutId = null

  const executeSequenceStep = async () => {
    if (!isRunning || !client.connected) return

    const step = sequence[sequenceIndex]
    const { pattern, min, max, duration, pause } = step

    try {
      const steps = Math.floor(duration / 100)
      const motorCount = getMotorCount(targetDevice)
      let patternData

      if (motorCount >= 2) {
        // Use dual motor patterns with phase offset
        const dualValues = generateDualMotorWaveform(pattern, steps, min, max)
        // Apply global intensity with mode-specific scaling
        dualValues.motor1 = applyIntensityScale(dualValues.motor1, modeName)
        dualValues.motor2 = applyIntensityScale(dualValues.motor2, modeName)
        // Apply device inversion
        dualValues.motor1 = dualValues.motor1.map(v => applyInversion(v))
        dualValues.motor2 = dualValues.motor2.map(v => applyInversion(v))
        patternData = {
          pattern: dualValues,
          intervals: Array(steps).fill(100),
          loop: 1
        }
      } else {
        // Single motor
        const values = generateWaveformValues(pattern, steps, min, max)
        // Apply global intensity with mode-specific scaling
        const scaledValues = applyIntensityScale(values, modeName)
        // Apply device inversion
        const invertedValues = scaledValues.map(v => applyInversion(v))
        patternData = {
          pattern: invertedValues,
          intervals: Array(steps).fill(100),
          loop: 1
        }
      }
      
      const patternResult = await executePattern(patternData, 'vibrate', deviceIndex)

      if (pause && pause > 0) {
        updateStatus(`${deviceName}: Pausing for ${pause}ms...`)
        await new Promise(resolve => setTimeout(resolve, pause))
      }

      sequenceIndex++
      if (sequenceIndex >= sequence.length) {
        if (repeat) {
          sequenceIndex = 0
          updateStatus(`${deviceName}: Repeating ${modeName} mode...`)
        } else {
          updateStatus(`${deviceName}: ${modeName} mode complete`)
          return
        }
      }

      if (isRunning && client.connected) {
        stepTimeoutId = setWorkerTimeout(executeSequenceStep, 100)
      }
    } catch (e) {
      console.error(`${NAME}: Step failed:`, e)
      isRunning = false
    }
  }

  activePatterns.set(deviceIndex, {
    mode: 'sequence',
    modeName: modeName,
    interval: stepTimeoutId,
    stop: () => {
      isRunning = false
      if (stepTimeoutId) {
        clearWorkerTimeout(stepTimeoutId)
        stepTimeoutId = null
      }
    }
  })

  executeSequenceStep()
}

// Stop pattern for specific device
async function stopDevicePattern(deviceIndex) {
  if (activePatterns.has(deviceIndex)) {
    const active = activePatterns.get(deviceIndex)
    if (active.interval) {
      clearWorkerTimeout(active.interval)
    }
    if (active.stop && typeof active.stop === 'function') {
      active.stop()
    }
    activePatterns.delete(deviceIndex)
  }

  // Stop the device
  const targetDevice = devices[deviceIndex]
  if (targetDevice) {
    try {
      // Try simple vibrate method first (better for Lovense), fallback to scalar
      try {
        await targetDevice.vibrate(0)
      } catch (e) {
        // Fallback to scalar command
        const vibrateAttributes = targetDevice.vibrateAttributes
        if (vibrateAttributes && vibrateAttributes.length > 0) {
          for (let i = 0; i < vibrateAttributes.length; i++) {
            const scalarCommand = new buttplug.ScalarSubcommand(vibrateAttributes[i].Index, 0, "Vibrate")
            await targetDevice.scalar(scalarCommand)
          }
        }
      }
      await targetDevice.oscillate(0)
    } catch (e) {
      // Ignore errors
    }
  }
}

// Parse device commands from AI text
// Supports self-closing format with device type matching:
// <cage:VIBRATE: 50> - Matches devices with "cage" in name
// <plug:OSCILLATE: 75> - Matches devices with "plug" in its name
// <any:VIBRATE: 50> - Matches any device (first available)
// <solace:LINEAR: start=10, end=90, duration=1000>
// <toy:PATTERN: [20, 40, 60], interval=[1000, 500, 1000], loop=3>
// <cage:PRESET: tease> - Use device-specific preset
// <any:WAVEFORM: sine, min=10, max=80, duration=5000>
// <cage:GRADIENT: start=0, end=90, duration=10000>
// Media commands:
// <media:LIST> - List available media files
// <media:PLAY: filename.ext> - Play a media file with optional funscript sync (supports: mp4, m4a, mp3, wav, webm, mkv, avi, mov, ogg)
// <media:STOP> - Stop media playback

// Mode command configurations - maps command prefix to settings key and command type
const MODE_COMMANDS = [
    { prefix: 'DENIAL_DOMINA', settingKey: 'denialDomina', cmdType: 'denial_domina', logName: 'DENIAL_DOMINA' },
    { prefix: 'MILK_MAID', settingKey: 'milkMaid', cmdType: 'milking', logName: 'MILK_MAID' },
    { prefix: 'PET_TRAINING', settingKey: 'petTraining', cmdType: 'pet_training', logName: 'PET_TRAINING' },
    { prefix: 'SISSY_SURRENDER', settingKey: 'sissySurrender', cmdType: 'sissy_surrender', logName: 'SISSY_SURRENDER' },
    { prefix: 'PREJAC_PRINCESS', settingKey: 'prejacPrincess', cmdType: 'prejac_princess', logName: 'PREJAC_PRINCESS' },
    { prefix: 'ROBOTIC_RUINATION', settingKey: 'roboticRuination', cmdType: 'robotic_ruination', logName: 'ROBOTIC_RUINATION' },
    { prefix: 'EVIL_EDGING_MISTRESS', settingKey: 'evilEdgingMistress', cmdType: 'evil_edging_mistress', logName: 'EVIL_EDGING_MISTRESS' },
    { prefix: 'FRUSTRATION_FAIRY', settingKey: 'frustrationFairy', cmdType: 'frustration_fairy', logName: 'FRUSTRATION_FAIRY' },
    { prefix: 'HYPNO_HELPER', settingKey: 'hypnoHelper', cmdType: 'hypno_helper', logName: 'HYPNO_HELPER' },
    { prefix: 'CHASTITY_CARETAKER', settingKey: 'chastityCaretaker', cmdType: 'chastity_caretaker', logName: 'CHASTITY_CARETAKER' }
];

function parseDeviceCommands(text, skipModeCommands = false) {
    const commands = []

    console.log(`${NAME}: Parsing commands from text:`, text.substring(0, 100) + '...', skipModeCommands ? '(skipping mode commands)' : '')
  
  // Match self-closing tags with device type: <type:command>
  const deviceRegex = /<([a-z]+):([^>]+)>/gi
  let match
  
  while ((match = deviceRegex.exec(text)) !== null) {
    const deviceType = match[1].toLowerCase()
    const commandText = match[2].trim().toUpperCase()
    
    console.log(`${NAME}: Found command - type: ${deviceType}, text: ${commandText}`)
    
    // Find matching device
    let targetDeviceIndex = 0 // Default to first device
    if (deviceType !== 'any' && deviceType !== 'device' && devices.length > 0) {
      // Try to find device matching the type/name
      const matchedIndex = devices.findIndex(dev => {
        const devName = (dev.displayName || dev.name || '').toLowerCase()
        return devName.includes(deviceType)
      })
      if (matchedIndex !== -1) {
        targetDeviceIndex = matchedIndex
      }
    }
    
    // Check for STOP command first
    if (commandText === 'STOP') {
      commands.push({ type: 'stop', deviceIndex: targetDeviceIndex })
      continue
    }
    
    // Check for INTERFACE system commands (start, connect, disconnect)
    if (deviceType === 'interface' || deviceType === 'system') {
if (commandText === 'START') {
commands.push({ type: 'interface_start' })
continue
}
if (commandText === 'CONNECT') {
commands.push({ type: 'interface_connect' })
continue
}
if (commandText === 'DISCONNECT') {
commands.push({ type: 'interface_disconnect' })
continue
}
if (commandText === 'SCAN') {
commands.push({ type: 'interface_scan' })
continue
}
}

// Check for MEDIA commands
if (deviceType === 'media') {
if (commandText === 'LIST') {
commands.push({ type: 'media_list' })
continue
}
if (commandText === 'STOP') {
commands.push({ type: 'media_stop' })
continue
}
if (commandText === 'PAUSE') {
commands.push({ type: 'media_pause' })
continue
}
if (commandText === 'RESUME' || commandText === 'PLAY') {
commands.push({ type: 'media_resume' })
continue
}
// Parse PLAY command with filename
// Format: PLAY: filename.ext or PLAY filename.ext (supports: mp4, m4a, mp3, wav, webm, mkv, avi, mov, ogg)
const playMatch = commandText.match(/PLAY[\s:]+(.+)/i)
if (playMatch) {
commands.push({
type: 'media_play',
filename: playMatch[1].trim()
})
continue
}
// Parse INTENSITY command for funscript
// Format: INTENSITY: 150 or INTENSITY 150 (sets funscript intensity percentage)
const intensityMatch = commandText.match(/INTENSITY[\s:]+(\d+)/i)
if (intensityMatch) {
const intensity = parseInt(intensityMatch[1])
if (intensity >= 0 && intensity <= 500) {
commands.push({
type: 'media_intensity',
intensity: intensity
})
} else {
console.log(`${NAME}: Ignoring out-of-range media intensity: ${intensity}%`)
}
      continue
    }
  }

// Parse PRESET command
    // Format: PRESET: tease or PRESET tease
    const presetMatch = commandText.match(/PRESET[\s:]+(\w+)/i)
    if (presetMatch) {
      commands.push({
        type: 'preset',
        presetName: presetMatch[1].toLowerCase(),
        deviceIndex: targetDeviceIndex
      })
      continue
    }

            // Parse mode commands using configuration (skip during streaming)
            if (!skipModeCommands) {
                for (const modeCmd of MODE_COMMANDS) {
                    const regex = new RegExp(`${modeCmd.prefix}\\s*[:\\s]\\s*([\\w_]+)`, 'i')
                    const match = commandText.match(regex)
                    if (match && modeSettings[modeCmd.settingKey]) {
                        const modeName = match[1].toLowerCase()
                        // Validate mode exists before queuing (prevents incomplete streaming parses)
                        const enabledModes = PlayModeLoader.getEnabledModes()
                        const modeExists = enabledModes.some(modeId => PlayModeLoader.getSequence(modeId, modeName))
                        if (modeExists) {
                            commands.push({
                                type: modeCmd.cmdType,
                                modeName: modeName,
                                deviceIndex: targetDeviceIndex
                            })
                        }
                        continue
                    }
                }
            }

    // Parse DUAL command (independent motor patterns)
  // Format: DUAL: pattern1=sine, pattern2=sawtooth, min=10, max=80, duration=5000, cycles=3
  const dualMatch = commandText.match(/DUAL[\s:]+pattern1[=:]?(\w+)(?:[\s,]+pattern2[=:]?(\w+))?(?:[\s,]+min[=:]?(\d+))?(?:[\s,]+max[=:]?(\d+))?(?:[\s,]+duration[=:]?(\d+))?(?:[\s,]+cycles[=:]?(\d+))?/i)
  if (dualMatch) {
    commands.push({
      type: 'dual_waveform',
      pattern1: dualMatch[1].toLowerCase(),
      pattern2: dualMatch[2] ? dualMatch[2].toLowerCase() : dualMatch[1].toLowerCase(),
      min: dualMatch[3] ? parseInt(dualMatch[3]) : 20,
      max: dualMatch[4] ? parseInt(dualMatch[4]) : 80,
      duration: dualMatch[5] ? parseInt(dualMatch[5]) : 5000,
      cycles: dualMatch[6] ? parseInt(dualMatch[6]) : 3,
      deviceIndex: targetDeviceIndex
    })
    continue
  }

  // Parse WAVEFORM command
    // Format: WAVEFORM: sine, min=10, max=80, duration=5000, cycles=3
    const waveformMatch = commandText.match(/WAVEFORM[\s:]+(\w+)(?:[\s,]+min[=:]?(\d+))?(?:[\s,]+max[=:]?(\d+))?(?:[\s,]+duration[=:]?(\d+))?(?:[\s,]+cycles[=:]?(\d+))?/i)
    if (waveformMatch) {
      commands.push({
        type: 'waveform',
        pattern: waveformMatch[1].toLowerCase(),
        min: waveformMatch[2] ? parseInt(waveformMatch[2]) : 20,
        max: waveformMatch[3] ? parseInt(waveformMatch[3]) : 80,
        duration: waveformMatch[4] ? parseInt(waveformMatch[4]) : 5000,
        cycles: waveformMatch[5] ? parseInt(waveformMatch[5]) : 3,
        deviceIndex: targetDeviceIndex
      })
      continue
    }
    
    // Parse GRADIENT command
    // Format: GRADIENT: start=0, end=90, duration=10000, hold=5000
    const gradientMatch = commandText.match(/GRADIENT[\s:]+start[=:]?(\d+)(?:[\s,]+end[=:]?(\d+))(?:[\s,]+duration[=:]?(\d+))?(?:[\s,]+hold[=:]?(\d+))?(?:[\s,]+release[=:]?(\d+))?/i)
    if (gradientMatch) {
      commands.push({
        type: 'gradient',
        start: parseInt(gradientMatch[1]),
        end: parseInt(gradientMatch[2]),
        duration: gradientMatch[3] ? parseInt(gradientMatch[3]) : 10000,
        hold: gradientMatch[4] ? parseInt(gradientMatch[4]) : 0,
        release: gradientMatch[5] ? parseInt(gradientMatch[5]) : 0,
        deviceIndex: targetDeviceIndex
      })
      continue
    }
    
    // Parse INTENSITY command for AI to set global intensity
  // Format: INTENSITY: 150 or INTENSITY 150 (can be 0-400)
  const intensityMatch = commandText.match(/INTENSITY[\s:]+(\d+)/i)
  if (intensityMatch) {
    commands.push({
      type: 'set_intensity',
      intensity: Math.max(0, Math.min(400, parseInt(intensityMatch[1]))),
      deviceIndex: targetDeviceIndex
    })
    continue
  }

  // Parse VIBRATE command
    // Format: VIBRATE: 50 or VIBRATE 50
    const vibrateMatch = commandText.match(/VIBRATE[:\s]+(\d+)/i)
    if (vibrateMatch) {
      commands.push({
        type: 'vibrate',
        intensity: Math.max(0, Math.min(100, parseInt(vibrateMatch[1]))),
        motorIndex: 0,
        deviceIndex: targetDeviceIndex
      })
      continue
    }
    
    // Parse OSCILLATE command
    // Format: OSCILLATE: 75 or OSCILLATE 75
    const oscillateMatch = commandText.match(/OSCILLATE[:\s]+(\d+)/i)
    if (oscillateMatch) {
      commands.push({
        type: 'oscillate',
        intensity: Math.max(0, Math.min(100, parseInt(oscillateMatch[1]))),
        deviceIndex: targetDeviceIndex
      })
      continue
    }
    
    // Parse LINEAR command
    // Format: LINEAR: start=10, end=90, duration=1000
    const linearMatch = commandText.match(/LINEAR[:\s]+start[=:\s]*(\d+)[,\s]+end[=:\s]*(\d+)[,\s]+duration[=:\s]*(\d+)/i)
    if (linearMatch) {
      commands.push({
        type: 'linear',
        startPos: parseInt(linearMatch[1]),
        endPos: parseInt(linearMatch[2]),
        duration: parseInt(linearMatch[3]),
        deviceIndex: targetDeviceIndex
      })
      continue
    }
    
    // Parse PATTERN command
    // Format: PATTERN: [20, 40, 60], interval=[1000, 500, 1000], loop=3
    const patternMatch = commandText.match(/PATTERN[:\s]+\[([^\]]+)\](?:[,\s]+interval[=:\s]+\[([^\]]+)\])?(?:[,\s]+loop[=:\s]*(\d+))?/i)
    if (patternMatch) {
      const intensities = patternMatch[1].split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n))
      const intervals = patternMatch[2]
        ? patternMatch[2].split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n))
        : [1000]
      const loop = patternMatch[3] ? parseInt(patternMatch[3]) : undefined
      
      if (intensities.length > 0) {
        commands.push({
          type: 'vibrate_pattern',
          pattern: intensities,
          intervals: intervals,
          loop: loop,
          deviceIndex: targetDeviceIndex
        })
      }
      continue
    }
    
    // Try old JSON format as fallback
    try {
      const jsonText = commandText.startsWith('{') ? commandText : `{${commandText}}`
      const command = JSON.parse(jsonText)
      
      if (command.VIBRATE !== undefined) {
        if (typeof command.VIBRATE === 'number') {
          commands.push({
            type: 'vibrate',
            intensity: Math.max(0, Math.min(100, command.VIBRATE)),
            motorIndex: 0,
            deviceIndex: targetDeviceIndex
          })
        } else if (typeof command.VIBRATE === 'object') {
          commands.push({
            type: 'vibrate_pattern',
            pattern: command.VIBRATE.pattern || [50],
            intervals: command.VIBRATE.interval || [1000],
            loop: command.VIBRATE.loop,
            deviceIndex: targetDeviceIndex
          })
        }
      }
      
      if (command.OSCILLATE !== undefined) {
        if (typeof command.OSCILLATE === 'number') {
          commands.push({
            type: 'oscillate',
            intensity: Math.max(0, Math.min(100, command.OSCILLATE)),
            deviceIndex: targetDeviceIndex
          })
        } else if (typeof command.OSCILLATE === 'object') {
          commands.push({
            type: 'oscillate_pattern',
            pattern: command.OSCILLATE.pattern || [50],
            intervals: command.OSCILLATE.interval || [1000],
            loop: command.OSCILLATE.loop,
            deviceIndex: targetDeviceIndex
          })
        }
      }
      
      if (command.LINEAR !== undefined && typeof command.LINEAR === 'object') {
        commands.push({
          type: 'linear',
          startPos: command.LINEAR.start_position || 0,
          endPos: command.LINEAR.end_position || 100,
          duration: command.LINEAR.duration || 1000,
          deviceIndex: targetDeviceIndex
        })
      }
      
      if (command.STOP !== undefined) {
        commands.push({ type: 'stop' })
      }
    } catch (e) {
      // Command not recognized
      console.log(`${NAME}: Unrecognized command format: ${commandText}`)
    }
  }
  
  return commands
}

// Execute a single command
async function executeCommand(cmd) {
  // Only log non-vibrate commands or vibrate commands without motorIndex/motorIndex 0
  if (cmd.type !== 'vibrate' || cmd.motorIndex === undefined || cmd.motorIndex === 0) {
    console.log(`${NAME}: Executing command type: ${cmd.type}`)
  }
  
// System commands can run without connection
if (cmd.type === 'interface_start' || cmd.type === 'interface_connect' || cmd.type === 'interface_disconnect' || cmd.type === 'interface_scan') {
try {
switch (cmd.type) {
case 'interface_start':
await handleIntifaceStart()
break
case 'interface_connect':
await handleIntifaceConnect()
break
case 'interface_disconnect':
await handleIntifaceDisconnect()
break
case 'interface_scan':
await handleDeviceScan()
break
}
    } catch (e) {
      console.error(`${NAME}: System command execution failed:`, e)
    }
    return
  }

// Media commands
if (cmd.type === 'media_list' || cmd.type === 'media_play' || cmd.type === 'media_stop' ||
cmd.type === 'media_pause' || cmd.type === 'media_resume' || cmd.type === 'media_intensity') {
try {
switch (cmd.type) {
case 'media_list':
await handleMediaList()
break
case 'media_play':
await handleMediaPlay(cmd.filename)
break
case 'media_stop':
await handleMediaStop()
break
case 'media_pause':
await handleMediaPause()
break
case 'media_resume':
await handleMediaResume()
break
    case 'media_intensity':
      await handleMediaIntensity(cmd.intensity)
      break
    }
  } catch (e) {
    console.error(`${NAME}: Media command execution failed:`, e)
  }
  return
}

  // Device commands require connection
  if (!client.connected || devices.length === 0) {
    console.log(`${NAME}: Cannot execute device command - not connected or no devices`)
    return
  }
  
  // Use specified device index or default to first device
  const deviceIndex = cmd.deviceIndex !== undefined ? cmd.deviceIndex : 0
  const targetDevice = devices[deviceIndex] || devices[0]
  
  if (!targetDevice) {
    console.log(`${NAME}: No device found at index ${deviceIndex}`)
    return
  }
  
  try {
    const deviceName = targetDevice?.displayName || targetDevice?.name || `Device ${deviceIndex}`
    
  switch (cmd.type) {

  case 'set_intensity':
    // AI sets global intensity scale (0-400%)
    globalIntensityScale = cmd.intensity
    updateStatus(`Global intensity set to ${cmd.intensity}% by AI`)
    break

case 'vibrate':
        const vibrateAttrs = targetDevice.vibrateAttributes
        if (vibrateAttrs && vibrateAttrs[cmd.motorIndex]) {
          // Apply global inversion if enabled
          let intensity = applyInversion(cmd.intensity)
          const intensityValue = intensity / 100
          // Try simple vibrate method first (better for Lovense), fallback to scalar
          try {
            await targetDevice.vibrate(intensityValue)
          } catch (e) {
            // Fallback to scalar command
            const scalarCmd = new buttplug.ScalarSubcommand(
              vibrateAttrs[cmd.motorIndex].Index,
              intensityValue,
              "Vibrate"
            )
            await targetDevice.scalar(scalarCmd)
          }
          updateStatus(`${deviceName} vibrating at ${intensity}%`)
        }
        break

      case 'oscillate':
        // Apply global inversion if enabled
        let oscillateIntensity = applyInversion(cmd.intensity)
        await targetDevice.oscillate(oscillateIntensity / 100)
        updateStatus(`${deviceName} oscillating at ${oscillateIntensity}%`)
        break

      case 'linear':
        // Apply global inversion if enabled (invert both positions)
        let startPos = applyInversion(cmd.startPos)
        let endPos = applyInversion(cmd.endPos)
        await targetDevice.linear(endPos / 100, cmd.duration)
        updateStatus(`${deviceName} linear stroke ${startPos}% to ${endPos}%`)
        break
      
      case 'stop':
        await stopAllDeviceActions()
        break
      
      case 'vibrate_pattern':
        // Execute pattern - store in activePatterns for cleanup
        const vibrateStop = executePattern(cmd, 'vibrate', deviceIndex)
        activePatterns.set(deviceIndex, {
          mode: 'pattern',
          modeName: 'vibrate_pattern',
          stop: vibrateStop
        })
        break

      case 'oscillate_pattern':
        // Execute pattern - store in activePatterns for cleanup
        const oscillateStop = executePattern(cmd, 'oscillate', deviceIndex)
        activePatterns.set(deviceIndex, {
          mode: 'pattern',
          modeName: 'oscillate_pattern',
          stop: oscillateStop
        })
        break
      
      case 'preset':
        await executeWaveformPattern(deviceIndex, cmd.presetName)
        break
      
    case 'waveform':
      await executeWaveformPattern(deviceIndex, 'custom', {
        pattern: cmd.pattern,
        min: cmd.min,
        max: cmd.max,
        duration: cmd.duration,
        cycles: cmd.cycles
      })
      updateStatus(`${deviceName}: ${cmd.pattern} waveform (${cmd.min}-${cmd.max}%)`)
      break

    case 'dual_waveform':
      // Generate independent patterns for each motor
      // targetDevice already declared at function scope
      const motorCountDual = getMotorCount(targetDevice)
      const stepsDual = Math.floor(cmd.duration / 100)
      const intervalsDual = Array(stepsDual).fill(100)
      
      let patternDataDual
      if (motorCountDual >= 2) {
        // Generate different patterns for each motor
        const motor1Values = generateWaveformValues(cmd.pattern1, stepsDual, cmd.min, cmd.max)
        const motor2Values = generateWaveformValues(cmd.pattern2, stepsDual, cmd.min, cmd.max)
        patternDataDual = {
          pattern: { motor1: motor1Values, motor2: motor2Values },
          intervals: intervalsDual,
          loop: cmd.cycles || 3
        }
        updateStatus(`${deviceName}: dual waveform (${cmd.pattern1}/${cmd.pattern2})`)
      } else {
        // Single motor - use pattern1 only
        const values = generateWaveformValues(cmd.pattern1, stepsDual, cmd.min, cmd.max)
        patternDataDual = {
          pattern: values,
          intervals: intervalsDual,
          loop: cmd.cycles || 3
        }
        updateStatus(`${deviceName}: ${cmd.pattern1} waveform (${cmd.min}-${cmd.max}%)`)
      }
      await executePattern(patternDataDual, 'vibrate', deviceIndex)
      break
      
      case 'gradient':
        await executeGradientPattern(deviceIndex, {
          start: cmd.start,
          end: cmd.end,
          duration: cmd.duration,
          hold: cmd.hold,
          release: cmd.release
        })
        updateStatus(`${deviceName}: gradient ${cmd.start}% → ${cmd.end}%`)
        break

      case 'denial_domina':
      case 'milking':
      case 'pet_training':
      case 'sissy_surrender':
      case 'prejac_princess':
      case 'robotic_ruination':
      case 'evil_edging_mistress':
      case 'frustration_fairy':
      case 'hypno_helper':
      case 'chastity_caretaker':
        await executeTeaseAndDenialMode(cmd.deviceIndex, cmd.modeName)
        updateStatus(`${deviceName}: Mode - ${cmd.modeName}`)
        break
    }
  } catch (e) {
    console.error(`${NAME}: Command execution failed:`, e)
  }
}

// Handle Intiface start command
async function handleIntifaceStart() {
  // Prevent multiple simultaneous start attempts
  if (isStartingIntiface) {
    console.log(`${NAME}: Intiface is already being started, skipping duplicate request`)
    return
  }
  
  isStartingIntiface = true
  
  const exePath = localStorage.getItem("intiface-exe-path")
  console.log(`${NAME}: handleIntifaceStart called, exePath:`, exePath)
  
  if (!exePath) {
    console.log(`${NAME}: Cannot start - no exe path configured`)
    updateStatus("Cannot start - configure path in settings first", true)
    isStartingIntiface = false
    return
  }
  
  try {
    console.log(`${NAME}: Starting Intiface Central from chat command...`)
    console.log(`${NAME}: Calling backend at /api/plugins/intiface-launcher/start`)
    
    const response = await fetch('/api/plugins/intiface-launcher/start', {
      method: 'POST',
      headers: getRequestHeaders(),
      body: JSON.stringify({ exePath })
    })
    
    console.log(`${NAME}: Backend response status:`, response.status)
    
    if (response.ok) {
      const result = await response.json()
      console.log(`${NAME}: Backend response:`, result)
      
      if (result.success) {
        updateStatus(`Intiface Central started (PID: ${result.pid})`)
        // Wait 3 seconds then auto-connect
        setTimeout(() => {
          if (!client.connected) {
            connect()
          }
        }, 3000)
      } else {
        updateStatus(`Failed to start: ${result.error || 'Unknown error'}`, true)
      }
    } else {
      const errorText = await response.text()
      console.error(`${NAME}: Backend error:`, errorText)
      updateStatus(`Backend error: ${response.status} - ${errorText}`, true)
    }
  } catch (error) {
    console.error(`${NAME}: Error starting Intiface:`, error)
    updateStatus(`Backend not available - ${error.message}`, true)
  } finally {
    // Reset the flag after a delay to prevent immediate re-trigger
    setTimeout(() => {
      isStartingIntiface = false
      console.log(`${NAME}: Start attempt completed, flag reset`)
    }, 5000)
  }
}

// Handle Intiface connect command
async function handleIntifaceConnect() {
  if (client.connected) {
    console.log(`${NAME}: Already connected`)
    return
  }
  try {
    await connect()
    updateStatus(`Connected to Intiface`)
  } catch (e) {
    updateStatus(`Connection failed: ${e.message}`, true)
  }
}

// Handle Intiface disconnect command
async function handleIntifaceDisconnect() {
if (!client.connected) {
console.log(`${NAME}: Not connected`)
return
}
try {
await disconnect()
updateStatus(`Disconnected from Intiface`)
} catch (e) {
updateStatus(`Disconnect failed: ${e.message}`, true)
}
}

// Handle device scan command - appends device list to the last message
async function handleDeviceScan() {
if (!client.connected) {
updateStatus('Cannot scan - not connected to Intiface', true)
console.log(`${NAME}: Cannot scan - not connected`)
return
}

try {
updateStatus('Scanning for devices...')
console.log(`${NAME}: === DEVICE SCAN STARTED ===`)
console.log(`${NAME}: Client connected: ${client.connected}`)
console.log(`${NAME}: Current device count before scan: ${devices.length}`)

// Set scanning flag
isScanningForDevices = true

// Start scanning
console.log(`${NAME}: Calling client.startScanning()...`)
await client.startScanning()
console.log(`${NAME}: client.startScanning() completed`)

// Scan for 5 seconds then stop
setTimeout(async () => {
try {
console.log(`${NAME}: === DEVICE SCAN STOPPING ===`)
console.log(`${NAME}: Current device count before stop: ${devices.length}`)
console.log(`${NAME}: Is scanning flag: ${isScanningForDevices}`)

await client.stopScanning()
console.log(`${NAME}: client.stopScanning() completed`)

// Clear scanning flag
isScanningForDevices = false

// Wait a moment for devices to be added to the devices array
console.log(`${NAME}: Waiting for device events to process...`)
await new Promise(resolve => setTimeout(resolve, 800))

const deviceCount = devices.length
console.log(`${NAME}: === DEVICE SCAN COMPLETE ===`)
console.log(`${NAME}: Final device count: ${deviceCount}`)
if (deviceCount > 0) {
console.log(`${NAME}: Devices:`, devices.map(d => d.name).join(', '))
}

// Build device list block for the AI
let deviceListBlock
if (deviceCount === 0) {
deviceListBlock = `

---
**Device Scan Results** (0 devices found)

\`\`\`
No devices detected. Make sure your device is:
- Turned on and in pairing mode
- Within Bluetooth range
- Not connected to another app
\`\`\``
} else {
const deviceInfoList = devices.map((dev, idx) => {
const devType = getDeviceType(dev)
const hasVibe = dev.vibrateAttributes && dev.vibrateAttributes.length > 0
const vibeCount = hasVibe ? dev.vibrateAttributes.length : 0
const hasLinear = dev.messageAttributes?.LinearCmd !== undefined
const hasOscillate = dev.messageAttributes?.OscillateCmd !== undefined

let capabilities = []
if (hasVibe) capabilities.push(`${vibeCount}x vibrate`)
if (hasLinear) capabilities.push('linear')
if (hasOscillate) capabilities.push('oscillate')

return `${idx + 1}. ${dev.name} [${devType}] - ${capabilities.join(', ') || 'unknown'}`
}).join('\n')

deviceListBlock = `

---
**Device Scan Results** (${deviceCount} device${deviceCount > 1 ? 's' : ''} connected)

\`\`\`
${deviceInfoList}
\`\`\`

Use device commands to control:
- <deviceName:VIBRATE: 50> - Set vibration intensity (0-100)
- <deviceName:OSCILLATE: 75> - Set oscillation (0-100)
- <deviceName:LINEAR: start=0, end=100, duration=1000> - Linear motion
- <deviceName:PRESET: tease> - Use preset patterns
- <deviceName:WAVEFORM: sine, min=10, max=80, duration=5000> - Waveform patterns`}

// Get the last message in chat and append the device list
const context = getContext()
const chat = context.chat
if (chat && chat.length > 0) {
// Find the last message (from the AI, not user)
let lastMessageIndex = chat.length - 1
while (lastMessageIndex >= 0 && chat[lastMessageIndex].is_user) {
lastMessageIndex--
}

if (lastMessageIndex >= 0) {
const lastMessage = chat[lastMessageIndex]
// Check if device list was already appended to avoid duplicates
if (lastMessage.mes && lastMessage.mes.includes('**Device Scan Results**')) {
updateStatus(`Device list already exists in message`)
console.log(`${NAME}: Device list already appended to message ${lastMessageIndex}`)
return
}

// Append device list to the message
lastMessage.mes = (lastMessage.mes || '') + deviceListBlock

// Update the message UI directly following SillyTavern's pattern
const messageElement = $(`.mes[mesid="${lastMessageIndex}"]`)
console.log(`${NAME}: Looking for message element with mesid=${lastMessageIndex}, found:`, messageElement.length > 0)
if (messageElement.length) {
const mesBlock = messageElement.find('.mes_block')
console.log(`${NAME}: Found mes_block:`, mesBlock.length > 0)
const formattedText = messageFormatting(lastMessage.mes, lastMessage.name, lastMessage.is_system, lastMessage.is_user, lastMessageIndex, {}, false)
const mesText = mesBlock.find('.mes_text')
console.log(`${NAME}: Found mes_text:`, mesText.length > 0, 'Message length:', lastMessage.mes.length)
mesText.empty().append(formattedText)
addCopyToCodeBlocks(messageElement)
console.log(`${NAME}: Device list UI updated successfully`)
}

updateStatus(`Scan complete - ${deviceCount} device(s) found`)
console.log(`${NAME}: Device list appended to message ${lastMessageIndex}`)
} else {
updateStatus('No assistant message to append device list to', true)
}
} else {
updateStatus('No chat messages found', true)
}
} catch (e) {
console.log(`${NAME}: Stop scanning failed:`, e)
updateStatus(`Scan error: ${e.message}`, true)
}
}, 5000)

console.log(`${NAME}: Device scan timer set for 5000ms`)

} catch (e) {
updateStatus(`Scan failed: ${e.message}`, true)
console.error(`${NAME}: Device scan error:`, e)
}
}

// Handle media list command - appends list to the last message
async function handleMediaList() {
  try {
    // Get asset paths
    const pathsResponse = await fetch('/api/plugins/intiface-launcher/asset-paths', {
      method: 'GET',
      headers: getRequestHeaders()
    })

    if (!pathsResponse.ok) throw new Error('Failed to get paths')

    const pathsData = await pathsResponse.json()
    const mediaPath = pathsData.paths?.intifaceMedia

    if (!mediaPath) throw new Error('No media path configured')

    // Fetch media files
    const response = await fetch(`/api/plugins/intiface-launcher/media?dir=${encodeURIComponent(mediaPath)}`, {
      method: 'GET',
      headers: getRequestHeaders()
    })

    if (!response.ok) throw new Error('Failed to fetch media list')

    const data = await response.json()
    if (!data.success) throw new Error(data.error || 'Unknown error')

// Get video and audio files
const mediaFiles = data.files?.filter(f => f.type === 'video' || f.type === 'audio') || []

// Build the media list for display
let mediaListBlock
if (mediaFiles.length === 0) {
mediaListBlock = `

---
**Media Library** (0 media files found)

\`\`\`
No media files available in the media library.
Place videos/audio in: ${mediaPath}
\`\`\``
} else {
            const fileList = mediaFiles.map(file => {
                const typeLabel = file.type === 'audio' ? '[audio]' : '[video]'
                return `${file.name} ${typeLabel}`
            }).join('\n')

mediaListBlock = `

---
**Media Library** (${mediaFiles.length} media files available)

\`\`\`
${fileList}
\`\`\`

Use <media:PLAY: filename.ext> to play media with funscript sync (supports: mp4, m4a, mp3, wav, webm, mkv, avi, mov, ogg).`
}

// Get the last message in chat and append the media list
const context = getContext()
const chat = context.chat
if (chat && chat.length > 0) {
// Find the last message (from the AI, not user)
let lastMessageIndex = chat.length - 1
while (lastMessageIndex >= 0 && chat[lastMessageIndex].is_user) {
lastMessageIndex--
}

if (lastMessageIndex >= 0) {
const lastMessage = chat[lastMessageIndex]
// Check if media list was already appended to avoid duplicates
if (lastMessage.mes && lastMessage.mes.includes('**Media Library**')) {
updateStatus(`Media list already exists in message`)
console.log(`${NAME}: Media list already appended to message ${lastMessageIndex}`)
return
}

// Append the media list to the message
lastMessage.mes = (lastMessage.mes || '') + mediaListBlock
// Update the message UI directly following SillyTavern's pattern
const messageElement = $(`.mes[mesid="${lastMessageIndex}"]`)
console.log(`${NAME}: Looking for message element with mesid=${lastMessageIndex}, found:`, messageElement.length > 0)
if (messageElement.length) {
const mesBlock = messageElement.find('.mes_block')
console.log(`${NAME}: Found mes_block:`, mesBlock.length > 0)
const formattedText = messageFormatting(lastMessage.mes, lastMessage.name, lastMessage.is_system, lastMessage.is_user, lastMessageIndex, {}, false)
const mesText = mesBlock.find('.mes_text')
console.log(`${NAME}: Found mes_text:`, mesText.length > 0, 'Message length:', lastMessage.mes.length)
mesText.empty().append(formattedText)
addCopyToCodeBlocks(messageElement)
console.log(`${NAME}: Message UI updated successfully`)
    }
    updateStatus(`Media list appended to last message (${mediaFiles.length} files)`)
    console.log(`${NAME}: Media list appended to message ${lastMessageIndex}`)
  } else {
    updateStatus('No AI message found to append media list')
  }
} else {
  updateStatus('No chat messages found')
}
} catch (e) {
  updateStatus(`Failed to list media: ${e.message}`, true)
  console.error(`${NAME}: Media list error:`, e)
}
}

// Handle media play command
async function handleMediaPlay(filename) {
  if (!filename) {
    updateStatus('No filename specified for media play', true)
    return
  }

  try {
    await loadChatMediaFile(filename)
    updateStatus(`Playing media: ${filename}`)
  } catch (e) {
    updateStatus(`Failed to play media: ${e.message}`, true)
    console.error(`${NAME}: Media play error:`, e)
  }
}

// Handle media stop command
async function handleMediaStop() {
  try {
    // Stop video playback
    if (mediaPlayer.videoElement) {
      mediaPlayer.videoElement.pause()
      mediaPlayer.videoElement.currentTime = 0
      mediaPlayer.isPlaying = false
    }

    // Stop funscript sync
    stopFunscriptSync()

    // Stop device actions
    await stopAllDeviceActions()

updateStatus('Media playback stopped')
} catch (e) {
updateStatus(`Failed to stop media: ${e.message}`, true)
console.error(`${NAME}: Media stop error:`, e)
}
}

// Handle media pause command
async function handleMediaPause() {
try {
if (mediaPlayer.videoElement && !mediaPlayer.videoElement.paused) {
mediaPlayer.videoElement.pause()
mediaPlayer.isPlaying = false
stopFunscriptSync()
updateStatus('Media paused')
$("#intiface-chat-funscript-info").text("Paused").css("color", "#FFA500")
} else {
console.log(`${NAME}: Media already paused or no video playing`)
}
} catch (e) {
updateStatus(`Failed to pause media: ${e.message}`, true)
console.error(`${NAME}: Media pause error:`, e)
}
}

// Handle media resume command
async function handleMediaResume() {
try {
if (mediaPlayer.videoElement && mediaPlayer.videoElement.paused) {
await mediaPlayer.videoElement.play()
mediaPlayer.isPlaying = true
startFunscriptSync()
updateStatus('Media resumed')
$("#intiface-chat-funscript-info").text("Playing - Funscript active").css("color", "#4CAF50")
} else if (!mediaPlayer.videoElement) {
updateStatus('No media loaded to resume', true)
} else {
console.log(`${NAME}: Media already playing`)
}
} catch (e) {
updateStatus(`Failed to resume media: ${e.message}`, true)
console.error(`${NAME}: Media resume error:`, e)
}
}

// Handle media intensity command
async function handleMediaIntensity(intensity) {
try {
if (intensity >= 0 && intensity <= 500) {
mediaPlayer.globalIntensity = intensity
globalIntensityScale = intensity
updateStatus(`Media intensity set to ${intensity}%`)
console.log(`${NAME}: Media intensity changed to ${intensity}%`)
// Update display if slider exists
$("#intiface-menu-funscript-intensity").val(intensity)
$("#intiface-menu-funscript-intensity-display").text(`${intensity}%`)
} else {
updateStatus(`Invalid intensity: ${intensity}% (must be 0-500)`, true)
}
} catch (e) {
updateStatus(`Failed to set intensity: ${e.message}`, true)
console.error(`${NAME}: Media intensity error:`, e)
}
}

// Execute pattern commands with intervals
async function executePattern(cmd, actionType, deviceIndex = 0) {
  const pattern = cmd.pattern || [50]
  const intervals = cmd.intervals || [1000]
  const loopCount = cmd.loop || 1

  // Check if this is a dual motor pattern
  const isDualMotor = pattern && typeof pattern === 'object' && pattern.motor1 && pattern.motor2
  const motor1Pattern = isDualMotor ? pattern.motor1 : pattern
  const motor2Pattern = isDualMotor ? pattern.motor2 : null

  // Get device motor count
  const targetDevice = devices[deviceIndex] || devices[0]
  const motorCount = getMotorCount(targetDevice)
  const shouldUseDual = isDualMotor && motorCount >= 2

  let currentLoop = 0
  let patternIndex = 0
  let patternIntervalId = null
  let isRunning = true
  let resolvePromise = null

  const executeStep = async () => {
    // Check timeline status for timeline-triggered patterns
    if (!mediaPlayer.isPlaying && cmd.fromTimeline) {
      isRunning = false
    }
      
      if (!isRunning || !client.connected || currentLoop >= loopCount) {
        if (resolvePromise) {
          resolvePromise()
          resolvePromise = null
        }
        return
      }

      const intensity = motor1Pattern[patternIndex % motor1Pattern.length]
      const interval = intervals[patternIndex % intervals.length]

      // Check isRunning again before sending commands (might have changed during await)
      if (!isRunning) return

      if (actionType === 'vibrate') {
      // Always send to motor 1
      await executeCommand({ type: 'vibrate', intensity, motorIndex: 0, deviceIndex })

      // Check isRunning after first motor command
      if (!isRunning) return

      // Send to motor 2 if available and dual pattern provided
      if (shouldUseDual && motor2Pattern) {
        const intensity2 = motor2Pattern[patternIndex % motor2Pattern.length]
        await executeCommand({ type: 'vibrate', intensity: intensity2, motorIndex: 1, deviceIndex })
      }
    } else if (actionType === 'oscillate') {
      await executeCommand({ type: 'oscillate', intensity, deviceIndex })
    }

    // Check isRunning before continuing
    if (!isRunning) return

    patternIndex++
    if (patternIndex >= motor1Pattern.length) {
      patternIndex = 0
      currentLoop++
    }

    if (!isRunning) return

    if (currentLoop < loopCount || cmd.loop === undefined) {
      patternIntervalId = setWorkerTimeout(executeStep, interval)
    } else {
      isRunning = false
      if (resolvePromise) {
        resolvePromise()
        resolvePromise = null
      }
    }
  }

  const completionPromise = new Promise(resolve => {
    resolvePromise = resolve
    executeStep()
  })

  const stopPattern = () => {
    isRunning = false
    if (patternIntervalId) {
      clearWorkerTimeout(patternIntervalId)
      patternIntervalId = null
    }
    if (resolvePromise) {
      resolvePromise()
      resolvePromise = null
    }
  }

  const result = completionPromise
  result.stop = stopPattern
  return result
}

// AI status check interval
let aiStatusCheckInterval = null

// Update AI control status indicator based on actual activity
function updateAIStatusFromActivity() {
const statusEl = $("#intiface-ai-status")
const textEl = $("#intiface-ai-status-text")

// Check if any patterns are active or command queue is running
const hasActivePatterns = activePatterns.size > 0
const isProcessing = isExecutingCommands || messageCommands.length > 0

if (hasActivePatterns || isProcessing) {
statusEl.css("background", "rgba(76, 175, 80, 0.15)")
textEl.css("color", "#4CAF50").text("AI is controlling your device...")
} else {
statusEl.css("background", "rgba(0,0,0,0.05)")
textEl.css("color", "#888").text("AI is ready to control your device via chat commands")
}
}

// Start monitoring AI activity status
function startAIStatusMonitoring() {
if (aiStatusCheckInterval) return
aiStatusCheckInterval = setInterval(updateAIStatusFromActivity, 500)
}

// Stop monitoring AI activity status
function stopAIStatusMonitoring() {
if (aiStatusCheckInterval) {
clearInterval(aiStatusCheckInterval)
aiStatusCheckInterval = null
}
}

// Process command queue sequentially
async function processCommandQueue() {
if (isExecutingCommands || messageCommands.length === 0) return

// Check if media player is active before starting
const playerPanel = $("#intiface-chat-media-panel")
const isMediaPlaying = playerPanel.length > 0 && playerPanel.is(":visible") && mediaPlayer.isPlaying

if (isMediaPlaying) {
// Clear all pending commands if media is playing
if (messageCommands.length > 0) {
console.log(`${NAME}: Clearing ${messageCommands.length} pending AI commands - media player is active`)
messageCommands = []
}
return
}

isExecutingCommands = true
startAIStatusMonitoring()

while (messageCommands.length > 0) {
const cmd = messageCommands.shift()

// Skip system commands - they should have been handled immediately
if (cmd.type === 'interface_start' || cmd.type === 'interrface_connect' || cmd.type === 'interface_disconnect') {
console.log(`${NAME}: Skipping system command in queue (should have been handled immediately): ${cmd.type}`)
continue
}

// Skip AI device commands when media player is open (funscript/media has priority until player is closed)
const currentPlayerPanel = $("#intiface-chat-media-panel")
if (currentPlayerPanel.length > 0 && currentPlayerPanel.is(":visible") && mediaPlayer.isPlaying) {
console.log(`${NAME}: Skipping AI command - media player is active: ${cmd.type}`)
// Clear remaining commands
messageCommands = []
break
}

// Device commands require connection
if (client.connected) {
await executeCommand(cmd)
} else {
console.log(`${NAME}: Skipping device command - not connected`)
}
}

isExecutingCommands = false
updateAIStatusFromActivity()
}

// Handle streaming token received
async function onStreamTokenReceived(data) {
    const token = typeof data === 'string' ? data : (data?.text || data?.message || '')
    if (!token) return

    streamingText += token

    // Check for video mentions
    const videoFilename = checkForVideoMentions(streamingText)
    if (videoFilename && !executedCommands.has(`video:${videoFilename}`)) {
        executedCommands.add(`video:${videoFilename}`)
        console.log(`${NAME}: Detected video mention in stream:`, videoFilename)
        await loadChatMediaFile(videoFilename)
    }

    // Only parse and queue commands when we have complete command tags (ending with >)
    // This prevents queuing incomplete commands during streaming
    if (!streamingText.includes('>')) return

    const commands = parseDeviceCommands(streamingText)

    // Check if media player is active (funscript has priority)
    const playerPanel = $("#intiface-chat-media-panel")
    const isMediaPlaying = playerPanel.length > 0 && playerPanel.is(":visible") && mediaPlayer.isPlaying

    for (const cmd of commands) {
        // Create a signature based on the command's essential properties
        // This ensures we only process a command when it's fully formed
        const cmdSignature = JSON.stringify({
            type: cmd.type,
            deviceIndex: cmd.deviceIndex,
            modeName: cmd.modeName,
            presetName: cmd.presetName,
            pattern: cmd.pattern,
            intensity: cmd.intensity
        })

        // Only process if we haven't seen this exact command before
        if (!seenCommands.has(cmdSignature)) {
            seenCommands.add(cmdSignature)

            // Now check if it's been executed (for deduplication across streaming and final)
            const cmdKey = JSON.stringify({
                type: cmd.type,
                deviceIndex: cmd.deviceIndex,
                modeName: cmd.modeName,
                presetName: cmd.presetName,
                pattern: cmd.pattern,
                intensity: cmd.intensity
            })

            if (!executedCommands.has(cmdKey)) {
                executedCommands.add(cmdKey)
                console.log(`${NAME}: New command detected: ${cmd.type}`)

                // Execute system commands immediately (don't add to queue)
                if (cmd.type === 'interface_start' || cmd.type === 'intiface_connect' || cmd.type === 'interface_disconnect') {
                    console.log(`${NAME}: Executing system command immediately: ${cmd.type}`)
                    executeCommand(cmd)
                } else if (isMediaPlaying) {
                    // Skip device commands when media player is active (funscript has priority)
                    console.log(`${NAME}: Skipping AI device command - media player is active: ${cmd.type}`)
                } else {
                    // Device commands go to queue
                    messageCommands.push(cmd)
                }
            }
        }
    }
}

// Handle message received (fallback for non-streaming)
async function onMessageReceived(data) {
  const context = getContext()
  const messageId = typeof data === 'number' ? data : data?.index
  const message = context.chat[messageId]
  
  if (!message || message.is_user) return
  
  const messageText = message.mes || ''
  
  // Check for video mentions in the complete message
  const videoFilename = checkForVideoMentions(messageText)
  if (videoFilename) {
    console.log(`${NAME}: Detected video mention in message:`, videoFilename)
    await loadChatMediaFile(videoFilename)
  }
  
const commands = parseDeviceCommands(messageText)

if (commands.length === 0 && !videoFilename) return

// Separate system commands from device commands
const systemCommands = commands.filter(cmd =>
cmd.type === 'interface_start' ||
cmd.type === 'interface_connect' ||
cmd.type === 'interface_disconnect'
)

// Check if media player is active (funscript has priority)
const playerPanel = $("#intiface-chat-media-panel")
const isMediaPlaying = playerPanel.length > 0 && playerPanel.is(":visible") && mediaPlayer.isPlaying

// Filter out device commands if media is playing
const deviceCommandsList = isMediaPlaying ? [] : commands.filter(cmd =>
cmd.type !== 'interface_start' &&
cmd.type !== 'interface_connect' &&
cmd.type !== 'intiface_disconnect'
)

if (isMediaPlaying && commands.some(cmd =>
cmd.type !== 'interface_start' &&
cmd.type !== 'interface_connect' &&
cmd.type !== 'interface_disconnect'
)) {
console.log(`${NAME}: Skipping AI device commands - media player is active`)
}

// Execute system commands immediately (even if not connected)
for (const cmd of systemCommands) {
await executeCommand(cmd)
}

// Only process device commands if connected
if (!client.connected && !videoFilename) return

// Clear previous commands and stop current activity (unless we're playing video OR tab is hidden)
if (!mediaPlayer.isPlaying && !document.hidden) {
messageCommands = []
executedCommands.clear()
streamingText = ''

if (commandQueueInterval) {
clearWorkerTimeout(commandQueueInterval)
commandQueueInterval = null
}

await stopAllDeviceActions()
}

    // Queue new device commands (empty if media is playing)
    // Clear any incomplete commands from streaming before replacing with final parsed commands
    messageCommands = deviceCommandsList.filter(cmd => {
        // For mode commands, ensure modeName exists and is not empty/invalid
        if (cmd.modeName && !cmd.modeName.includes('_') && cmd.modeName.length < 5) {
            console.log(`${NAME}: Filtering out likely incomplete mode command: ${cmd.modeName}`)
            return false
        }
        return true
    })
    executedCommands = new Set(messageCommands.map(cmd => JSON.stringify(cmd)))

// Start processing
processCommandQueue()
}

// Handle generation started
function onGenerationStarted() {
    executedCommands.clear()
    seenCommands.clear()
    messageCommands = []
    streamingText = ''
}

// Handle generation ended
function onGenerationEnded() {
    streamingText = ''
    seenCommands.clear()
    // Process any remaining commands
    processCommandQueue()
}

// Get device display name (prefer displayName over name)
function getDeviceDisplayName(dev) {
  if (!dev) return 'Unknown'
  return dev.displayName || dev.name || 'Unknown Device'
}

// Get device type classification using PatternLibrary configuration
function getDeviceType(dev) {
  const devName = (dev.displayName || dev.name || '').toLowerCase()
  const patterns = PatternLibrary.devices.typePatterns

  // Check each device type in order
  for (const [deviceType, keywords] of Object.entries(patterns)) {
    if (deviceType === 'general') continue // Skip fallback, check last
    if (keywords.some(keyword => devName.includes(keyword))) {
      return deviceType
    }
  }

  return 'general'
}

// Get device-specific default intensity using PatternLibrary configuration
function getDeviceDefaultIntensity(dev) {
  const devName = (dev.displayName || dev.name || '').toLowerCase()
  const type = getDeviceType(dev)
  const intensities = PatternLibrary.devices.defaultIntensities

  // Check for device type-specific intensity first
  if (intensities[type] !== undefined && type !== 'default') {
    return intensities[type]
  }

  // Check for device name match in shorthand patterns
  const shorthandPatterns = PatternLibrary.devices.shorthandPatterns
  for (const [shorthand, keywords] of Object.entries(shorthandPatterns)) {
    if (keywords.some(keyword => devName.includes(keyword))) {
      if (intensities[shorthand] !== undefined) {
        return intensities[shorthand]
      }
    }
  }

  return intensities.default || 100
}

// Get shorthand for device using PatternLibrary configuration
function getDeviceShorthand(dev) {
  const devName = (dev.displayName || dev.name || '').toLowerCase()
  const patterns = PatternLibrary.devices.shorthandPatterns

  // Check each shorthand pattern
  for (const [shorthand, keywords] of Object.entries(patterns)) {
    if (keywords.some(keyword => devName.includes(keyword))) {
      return shorthand
    }
  }

  // Return first word of device name as fallback
  return devName.split(' ')[0]
}

function clickHandlerHack() {
  try {
    const element = document.querySelector("#extensions-settings-button .drawer-toggle")
    if (element) {
      const events = $._data(element, "events")
      if (events && events.click && events.click[0]) {
        const doNavbarIconClick = events.click[0].handler
        $("#intiface-connect-button .drawer-toggle").on("click", doNavbarIconClick)
      }
    }
  } catch (error) {
    console.error(`${NAME}: Failed to apply click handler hack.`, error)
  }
}

function updateStatus(status, isError = false) {
  const statusPanel = $("#intiface-status-panel")
  statusPanel.text(`Status: ${status}`)
  if (isError) {
    statusPanel.removeClass("connected").addClass("disconnected")
  }
}

function updateButtonStates(isConnected) {
  const connectButton = $("#intiface-connect-action-button")
  if (isConnected) {
    connectButton
      .html('<i class="fa-solid fa-power-off"></i> Disconnect')
      .removeClass("connect-button")
      .addClass("disconnect-button")
  } else {
    connectButton
      .html('<i class="fa-solid fa-power-off"></i> Connect')
      .removeClass("disconnect-button")
      .addClass("connect-button")
  }
  $("#intiface-rescan-button").toggle(isConnected)
  $("#intiface-start-timer-button").toggle(isConnected)
  $("#intiface-connect-button .drawer-icon").toggleClass("flashing-icon", isConnected)
}

async function connect(isAutoConnect = false) {
  console.log(`${NAME}: connect() called${isAutoConnect ? ' (auto-connect mode)' : ''}`)

  try {
    const serverIp = $("#intiface-ip-input").val().replace(/^https?:\/\//, '').replace(/^wss?:\/\//, '')
    // Use wss:// for HTTPS pages, ws:// for HTTP pages (browser security requirement)
    const protocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://'
    const serverUrl = `${protocol}${serverIp}`
    console.log(`${NAME}: Connecting to ${serverUrl}`)
    localStorage.setItem("intiface-server-ip", serverIp) // Save on connect
    connector = new buttplug.ButtplugBrowserWebsocketClientConnector(serverUrl)
    
    if (!isAutoConnect) {
      updateStatus("Connecting...")
    }
    
    console.log(`${NAME}: Calling client.connect()...`)
    await client.connect(connector)
    console.log(`${NAME}: client.connect() succeeded`)
    updateStatus("Connected")
    $("#intiface-status-panel").removeClass("disconnected").addClass("connected")
    updateButtonStates(true)
    intervalId = setInterval(processMessage, 1000) // Start processing messages

    // Re-attach device event handlers
    attachDeviceEventHandlers()

    // Check for already-connected devices (devices paired before disconnect)
    // The buttplug client maintains internal device list
    setTimeout(() => {
      // Access internal devices map from the client
      const internalDevices = client._devices || new Map()
      console.log(`${NAME}: Internal device count: ${internalDevices.size}`)

      // Process any existing devices
      internalDevices.forEach((dev, index) => {
        console.log(`${NAME}: Processing existing device: ${getDeviceDisplayName(dev)} (index: ${index})`)
        // Only add if not already in our list
        if (!devices.find(d => d.index === dev.index)) {
          handleDeviceAdded(dev)
        }
      })

      // If still no devices, try scanning
      if (devices.length === 0) {
        console.log(`${NAME}: No devices found, attempting to scan...`)
        try {
          client.startScanning().catch(e => {
            console.log(`${NAME}: Start scanning failed:`, e)
          })
          // Stop scanning after 3 seconds
          setTimeout(() => {
            client.stopScanning().catch(e => {
              console.log(`${NAME}: Stop scanning failed:`, e)
            })
          }, 3000)
        } catch (e) {
          console.log(`${NAME}: Could not start scanning:`, e)
        }
      } else {
        console.log(`${NAME}: Found ${devices.length} device(s) after reconnect`)
      }
    }, 500)

    // Update prompt to show connection status
    updatePrompt()
  } catch (e) {
    // Handle various error formats - some WebSocket errors are weird objects
    let errorMsg = e?.message || e?.toString?.() || String(e) || 'Unknown error'
    
    // Clean up common connection error messages
    if (!errorMsg || errorMsg === 'undefined' || errorMsg === 'null') {
      errorMsg = 'Server not available'
    } else if (errorMsg.includes('WebSocket') && errorMsg.includes('failed')) {
      errorMsg = 'Server not available'
    } else if (errorMsg.includes('ECONNREFUSED') || errorMsg.includes('refused')) {
      errorMsg = 'Connection refused - server may be offline'
    } else if (errorMsg.includes('ENOTFOUND') || errorMsg.includes('not found')) {
      errorMsg = 'Server address not found'
    } else if (errorMsg.includes('ETIMEDOUT') || errorMsg.includes('timeout')) {
      errorMsg = 'Connection timed out'
    }
    
    // During auto-connect, don't show scary error - just log quietly
    if (isAutoConnect) {
      console.log(`${NAME}: Auto-connect attempt failed - server not available`)
    } else {
      // Manual connection - show cleaner error
      console.log(`${NAME}: Connect failed:`, e?.message || errorMsg)
      updateStatus(errorMsg, true)
    }
    
    // Update prompt even on failure
    updatePrompt()
    
    // Re-throw so caller knows it failed
    throw e
  }
}

async function disconnect() {
  console.log(`${NAME}: Disconnect called, client.connected = ${client?.connected}`)

  try {
    await client.disconnect()
    console.log(`${NAME}: client.disconnect() completed`)
    updateStatus("Disconnected")
    $("#intiface-status-panel").removeClass("connected").addClass("disconnected")
    updateButtonStates(false)
    $("#intiface-devices").empty()
    devices = [] // Clear devices array
    device = null
    if (intervalId) {
      clearWorkerTimeout(intervalId) // Stop processing messages
      intervalId = null
    }
    if (strokerIntervalId) {
      clearWorkerTimeout(strokerIntervalId)
      strokerIntervalId = null
    }
    isStroking = false
    if (vibrateIntervalId) {
      clearWorkerTimeout(vibrateIntervalId)
      vibrateIntervalId = null
    }
    if (oscillateIntervalId) {
      clearWorkerTimeout(oscillateIntervalId)
      oscillateIntervalId = null
    }

    // Update prompt to show disconnection status
    updatePrompt()
  } catch (e) {
    const errorMsg = e?.message || String(e) || 'Unknown error'
    updateStatus(`Error disconnecting: ${errorMsg}`, true)
    console.error(`${NAME}: Disconnect error:`, e)
    // Even on error, clear the state and update UI
    devices = []
    device = null
    $("#intiface-devices").empty()
    $("#intiface-status-panel").removeClass("connected").addClass("disconnected")
    updateButtonStates(false)
    updatePrompt()
  }
}

// Forward declarations for Play Mode functions (defined in initialization section)
let populatePatternButtons;
let executePlayModeSequence;
let executePatternStep;

async function handleDeviceAdded(newDevice) {
  console.log(`${NAME}: handleDeviceAdded called for ${newDevice.name}`)
  updateStatus(`Device found: ${newDevice.name}`)

  // Add to devices array if not already present
  if (!devices.find(d => d.index === newDevice.index)) {
    devices.push(newDevice)
    console.log(`${NAME}: Added device ${newDevice.name} to array. Total: ${devices.length}`)
  } else {
    console.log(`${NAME}: Device ${newDevice.name} already in array`)
  }

  // Set as active device (use first available)
  device = devices[0]

  const devicesEl = $("#intiface-devices")
  devicesEl.empty()

// Show device count header
const deviceCount = devices.length
const headerHtml = `<div style="margin-bottom: 10px; padding: 5px; background: rgba(0,0,0,0.1); border-radius: 4px;">
<strong>Connected Devices (${deviceCount}):</strong>
</div>`
devicesEl.append(headerHtml)

// Loop through ALL devices and create controls for each
for (let devIndex = 0; devIndex < devices.length; devIndex++) {
const currentDevice = devices[devIndex]
const deviceDiv = $(`<div id="device-${currentDevice.index}" style="margin-bottom: 15px; padding: 10px; background: rgba(0,0,0,0.05); border-radius: 4px;"></div>`)

// Device header
const deviceHeaderHtml = `<div style="font-size: 0.9em; font-weight: bold; margin-bottom: 8px; color: #fff;">
${currentDevice.name} ${devIndex === 0 ? '(active)' : ''}
</div>`
deviceDiv.append(deviceHeaderHtml)

// Check device capabilities from message attributes
const messageAttrs = currentDevice.messageAttributes
const hasVibration = currentDevice.vibrateAttributes && currentDevice.vibrateAttributes.length > 0
const hasOscillate = messageAttrs?.OscillateCmd !== undefined
const hasLinear = messageAttrs?.LinearCmd !== undefined

// Get device type
const deviceType = getDeviceType(currentDevice)

// Apply device-specific default intensity (only for first device)
if (devIndex === 0) {
const deviceDefaultIntensity = getDeviceDefaultIntensity(currentDevice)
if (deviceDefaultIntensity !== 100 && globalIntensityScale === 100) {
globalIntensityScale = deviceDefaultIntensity
console.log(`${NAME}: Applied ${deviceDefaultIntensity}% default intensity for ${currentDevice.name}`)
updateStatus(`Device ${currentDevice.name}: Using ${deviceDefaultIntensity}% intensity default`)
}
}

// Show supported features info
const featuresList = []
if (hasVibration) featuresList.push(`Vibrate (${currentDevice.vibrateAttributes.length} motor${currentDevice.vibrateAttributes.length > 1 ? 's' : ''})`)
if (hasOscillate) featuresList.push('Oscillate')
if (hasLinear) featuresList.push('Linear')

if (featuresList.length > 0) {
const featuresHtml = `<div style="margin: 5px 0; font-size: 0.85em; color: #888;">
<strong>Supported:</strong> ${featuresList.join(', ')}
</div>
<div style="margin: 3px 0; font-size: 0.8em; color: #666; font-style: italic;">
Type: ${deviceType}
</div>`
deviceDiv.append(featuresHtml)
}

// Update Play Mode pattern buttons (only once, for first device)
if (devIndex === 0) {
populatePatternButtons(deviceType)
}

// Get the actual device index for this device
const deviceIndex = currentDevice.index

// Add device assignment dropdown for multi-funscript support
const currentAssignment = deviceAssignments[deviceIndex] || '-'
const assignmentHtml = `
<div style="margin-top: 8px; padding: 5px; background: rgba(100,100,100,0.1); border-radius: 3px;">
<label style="font-size: 0.75em; color: #aaa; display: block; margin-bottom: 3px;">
<i class="fa-solid fa-layer-group"></i> Funscript Channel:
</label>
<select id="device-assignment-${deviceIndex}" class="device-assignment-select" data-device-index="${deviceIndex}"
style="width: 100%; padding: 3px; font-size: 0.75em; background: rgba(0,0,0,0.3); color: #fff; border: 1px solid rgba(255,255,255,0.2); border-radius: 3px;">
<option value="-" ${currentAssignment === '-' ? 'selected' : ''}>All Channels</option>
<option value="A" ${currentAssignment === 'A' ? 'selected' : ''}>Channel A</option>
<option value="B" ${currentAssignment === 'B' ? 'selected' : ''}>Channel B</option>
<option value="C" ${currentAssignment === 'C' ? 'selected' : ''}>Channel C</option>
<option value="D" ${currentAssignment === 'D' ? 'selected' : ''}>Channel D</option>
</select>
<div style="font-size: 0.65em; color: #666; margin-top: 2px;">
Use filename_A.funscript for specific channels
</div>
</div>
`
deviceDiv.append(assignmentHtml)
$(document).on("click", "[id^='intiface-presets-toggle-']", function() {
const toggleId = $(this).attr("id")
const deviceIndex = toggleId.replace("intiface-presets-toggle-", "")
const content = $(`#intiface-presets-content-${deviceIndex}`)
const arrow = $(`#intiface-presets-arrow-${deviceIndex}`)

if (content.is(":visible")) {
content.slideUp(200)
arrow.css("transform", "rotate(0deg)")
} else {
content.slideDown(200)
arrow.css("transform", "rotate(180deg)")
}
})

// Handle motors toggle click (delegated for dynamically added devices)
$(document).on("click", "[id^='intiface-motors-toggle-']", function() {
  const toggleId = $(this).attr("id")
  const deviceIndex = toggleId.replace("intiface-motors-toggle-", "")
  const content = $(`#intiface-motors-content-${deviceIndex}`)
  const arrow = $(`#intiface-motors-arrow-${deviceIndex}`)
  
  if (content.is(":visible")) {
    content.slideUp(200)
    arrow.css("transform", "rotate(0deg)")
  } else {
    content.slideDown(200)
    arrow.css("transform", "rotate(180deg)")
  }
})

// Handle modes toggle click (delegated for dynamically added devices)
$(document).on("click", "[id^='intiface-modes-toggle-']", function() {
const toggleId = $(this).attr("id")
const deviceIndex = toggleId.replace("intiface-modes-toggle-", "")
const content = $(`#intiface-modes-content-${deviceIndex}`)
const arrow = $(`#intiface-modes-arrow-${deviceIndex}`)

if (content.is(":visible")) {
content.slideUp(200)
arrow.css("transform", "rotate(0deg)")
} else {
content.slideDown(200)
arrow.css("transform", "rotate(180deg)")
}
})
  
// Add per-motor controls if multiple motors
if (hasVibration && currentDevice.vibrateAttributes.length > 1) {
const deviceArrayIndex = devIndex // Use array position, not device.index
const motorsHtml = `
<div style="margin-top: 10px;">
<div id="intiface-motors-toggle-${deviceArrayIndex}" class="menu_button" style="width: 100%; text-align: left; padding: 8px; background: rgba(0,0,0,0.1); border-radius: 4px;">
<span style="display: flex; justify-content: space-between; align-items: center;">
<span style="font-size: 0.85em; font-weight: bold;">Individual Motor Control</span>
<span id="intiface-motors-arrow-${deviceArrayIndex}" style="transition: transform 0.3s;">▼</span>
</span>
</div>
<div id="intiface-motors-content-${deviceArrayIndex}" style="display: none; margin-top: 8px; padding: 8px; background: rgba(0,0,0,0.05); border-radius: 4px;">
${currentDevice.vibrateAttributes.map((attr, idx) => `
<div style="margin: 5px 0;">
<label style="font-size: 0.8em;">Motor ${idx + 1}:</label>
<input type="range" class="motor-slider" data-device="${deviceArrayIndex}" data-motor="${idx}"
min="0" max="100" value="0" style="width: 100%; margin-top: 3px;">
</div>
`).join('')}
</div>
</div>
`
deviceDiv.append(motorsHtml)
}

// Waveform patterns are now in the unified Play Mode section
// Per-device waveform generator removed

// Play Mode patterns are now shown in the unified Play Mode section in the menu
// Old per-device mode buttons removed - now centralized in menu

// Removed old per-device Play Modes section

devicesEl.append(deviceDiv)
} // End of for loop for all devices

// Update AI prompt with device info
updatePrompt()

// Setup device assignment change handler
$(document).on('change', '.device-assignment-select', function() {
const deviceIndex = $(this).data('device-index')
const assignment = $(this).val()
if (assignment === '-') {
delete deviceAssignments[deviceIndex]
} else {
deviceAssignments[deviceIndex] = assignment
}
// Save to localStorage
localStorage.setItem('intiface-device-assignments', JSON.stringify(deviceAssignments))
console.log(`${NAME}: Device ${deviceIndex} assigned to channel ${assignment}`)
})

// Load saved device assignments
const savedAssignments = localStorage.getItem('intiface-device-assignments')
if (savedAssignments) {
try {
deviceAssignments = JSON.parse(savedAssignments)
} catch (e) {
console.error(`${NAME}: Failed to parse device assignments`, e)
}
}
}

function handleDeviceRemoved(removedDevice) {
  const deviceName = removedDevice?.name || devices[0]?.name || 'Unknown'
  updateStatus(`Device removed: ${deviceName}`)

  // Remove from devices array
  if (removedDevice) {
    devices = devices.filter(d => d.index !== removedDevice.index)
  } else {
    // Fallback: clear all if no specific device info
    devices = []
  }

  // Update active device
  device = devices.length > 0 ? devices[0] : null

  const devicesEl = $("#intiface-devices")
  devicesEl.empty()

  if (devices.length > 0) {
    // Show updated device count header
    const deviceCount = devices.length
    const headerHtml = `<div style="margin-bottom: 10px; padding: 5px; background: rgba(0,0,0,0.1); border-radius: 4px;">
      <strong>Connected Devices (${deviceCount}):</strong>
    </div>`
    devicesEl.append(headerHtml)

    // List remaining connected devices
    devices.forEach((dev, idx) => {
      const deviceListItem = $(`<div style="padding: 5px; margin: 2px 0; background: rgba(100,100,100,0.2); border-radius: 3px; font-size: 0.9em;">
        ${idx + 1}. ${dev.name} ${idx === 0 ? '(active)' : ''}
      </div>`)
      devicesEl.append(deviceListItem)
    })

    devicesEl.append('<hr style="margin: 10px 0; opacity: 0.3;">')
  }

  if (strokerIntervalId) {
    clearWorkerTimeout(strokerIntervalId)
    strokerIntervalId = null
  }
  isStroking = false
  if (vibrateIntervalId) {
    clearWorkerTimeout(vibrateIntervalId)
    vibrateIntervalId = null
  }
  if (oscillateIntervalId) {
    clearWorkerTimeout(oscillateIntervalId)
    oscillateIntervalId = null
  }

  // Update AI prompt with new device info
  updatePrompt()
}

// Simple hash function for prompt comparison
function hashPrompt(str) {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32bit integer
  }
  return hash.toString(16)
}

// Debounced prompt update function
function updatePrompt() {
  // Clear existing timer
  if (promptUpdateTimer) {
    clearTimeout(promptUpdateTimer)
  }
  
  // Set new timer to actually update after 100ms debounce
  promptUpdateTimer = setTimeout(() => {
    actuallyUpdatePrompt()
  }, 100)
}

// Actually update the prompt (internal function)
function actuallyUpdatePrompt() {
  console.log(`${NAME}: actuallyUpdatePrompt() STARTING`)
  try {
    console.log(`${NAME}: actuallyUpdatePrompt() called, devices.length=${devices?.length ?? 'undefined'}, client.connected=${client?.connected ?? 'undefined'}`)

    // Check if Intiface exe path is configured
    const exePath = localStorage.getItem("intiface-exe-path")
    const canStartIntiface = !!exePath

    // Only show devices if actually connected
    const connectedDevices = client?.connected ? devices : []

    // Build device info (only if connected)
    const deviceInfo = connectedDevices.map((dev, idx) => {
    const caps = []
    if (dev.vibrateAttributes?.length > 0) caps.push('vibrate')
    if (dev.messageAttributes?.OscillateCmd) caps.push('oscillate')
    if (dev.messageAttributes?.LinearCmd) caps.push('linear')
    const deviceType = getDeviceType(dev)
    return {
      name: dev.displayName || dev.name,
      index: idx,
      capabilities: caps,
      type: deviceType,
      motors: dev.vibrateAttributes?.length || 0
    }
  })

    const deviceShorthands = connectedDevices.length > 0 ? connectedDevices.map((dev, idx) => {
      const shorthand = getDeviceShorthand(dev)
      return `${dev.displayName || dev.name} (${shorthand})`
    }).join(', ') : 'No devices connected'

    console.log(`${NAME}: Building prompt... canStartIntiface=${canStartIntiface}, connectedDevices=${connectedDevices.length}`)

    const startCommand = `
System commands (to manage Intiface itself):
${canStartIntiface ? `- <interface:START> - Start Intiface Central application (configured: ${exePath})` : ''}
- <interface:CONNECT> - Connect to Intiface server
- <interface:DISCONNECT> - Disconnect from Intiface server
- <interface:SCAN> - Scan for new devices (runs for 5 seconds)`

    // Build dynamic device examples based on connected devices
    let deviceTypeExamples = ''
    let presetExamples = ''
    let gradientExamples = ''
    let patternExamples = ''

    if (connectedDevices.length > 0) {
      // Get unique device types from connected devices
      const connectedTypes = [...new Set(connectedDevices.map(dev => getDeviceType(dev)))]
      const firstDevice = connectedDevices[0]
      const firstDeviceName = firstDevice.displayName || firstDevice.name
    const firstShorthand = getDeviceShorthand(firstDevice)
    
    // Build device type command examples
    const typeExamples = connectedTypes.map(type => {
      const typeDevice = devices.find(d => getDeviceType(d) === type)
      const shorthand = getDeviceShorthand(typeDevice)
      if (type === 'stroker') {
        return `- <${shorthand}:LINEAR: start=10, end=90, duration=1000> - Linear stroke for ${typeDevice.displayName || typeDevice.name}`
      } else {
        return `- <${shorthand}:VIBRATE: 50> - Vibrate ${typeDevice.displayName || typeDevice.name} at 50%`
      }
    }).join('\n')
    
  // Build preset examples for connected device types
  const presetList = []
  connectedTypes.forEach(type => {
    const typePresets = PatternLibrary.getCompatiblePresets(type)
    const presetNames = Object.keys(typePresets).slice(0, 3) // Max 3 presets per type
    const typeDevice = devices.find(d => getDeviceType(d) === type)
    const shorthand = getDeviceShorthand(typeDevice)
    presetNames.forEach(presetName => {
      presetList.push(`- <${shorthand}:PRESET: ${presetName}> - ${typePresets[presetName].description || presetName} pattern`)
    })
  })
    presetExamples = presetList.join('\n')
    
    // Build device-specific examples
    deviceTypeExamples = `${typeExamples}
- <any:VIBRATE: 30> - Vibrate the first connected device at 30%
- <any:STOP> - Stop all devices`
    
    // Gradient examples using first connected device type
    gradientExamples = `- <${firstShorthand}:GRADIENT: start=0, end=90, duration=10000> - Ramp from 0% to 90% over 10 seconds`
    
    // Pattern examples
    patternExamples = `- <${firstShorthand}:PATTERN: [20, 40, 60], interval=[1000, 500, 1000]> - Cycle through intensities`
  }

    const deviceCommands = devices.length > 0 ? `
Device commands:
${deviceTypeExamples}

PRESET commands (device-optimized patterns):
${presetExamples}
${modeSettings.denialDomina ? `
DENIAL_DOMINA MODE (dominance and denial sequences):
- <any:DENIAL_DOMINA: gentle_tease> - Gentle teasing with soft pulses
- <any:DENIAL_DOMINA: mind_games> - Random start-stop patterns
- <any:DENIAL_DOMINA: edge_mania> - Multiple edging sequences
- <any:DENIAL_DOMINA: desperation> - Builds desperation with intense pauses
- <any:DENIAL_DOMINA: mercy> - Gentle patterns with rest periods
- <any:DENIAL_DOMINA: ultimate_tease> - Ultimate tease that never allows release
- <any:DENIAL_DOMINA: slow_burn> - Very slow build with long pauses
- <any:DENIAL_DOMINA: micro_tickle> - Micro twitching from community scripts
- <any:DENIAL_DOMINA: abrupt_edge> - Peaks then abruptly stops (tease.funscript style)
- <any:DENIAL_DOMINA: ghost_touches> - Almost imperceptible touches with rare bursts
- <any:DENIAL_DOMINA: unpredictably_cruel> - Chaotic mix for maximum confusion
` : ''}${modeSettings.milkMaid ? `
MILK_MAID MODE (forced release - multiple crescendos):
- <any:MILK_MAID: milk_maid> - Classic milking with slow builds to intense crescendos
- <any:MILK_MAID: relentless_milking> - No breaks - relentless intensity
- <any:MILK_MAID: tsunami_assault> - Massive wave after massive wave
- <any:MILK_MAID: spiral_crescendos> - Spiraling intensity that keeps building
- <any:MILK_MAID: overload_milking> - Overload senses - maximum intensity
- <any:MILK_MAID: gentle_milking> - Slower, more deliberate milking
` : ''}${modeSettings.petTraining ? `
PET_TRAINING MODE (obedience and discipline):
- <any:PET_TRAINING: sit_stay> - Basic obedience - hold still and endure
- <any:PET_TRAINING: reward_training> - Wait patiently for rewards
- <any:PET_TRAINING: discipline_time> - Discipline for disobedience
- <any:PET_TRAINING: patient_pet> - Testing patience and endurance
- <any:PET_TRAINING: good_boy> - Reward for being a good pet
- <any:PET_TRAINING: bad_pet> - Punishment for bad behavior - edging only
- <any:PET_TRAINING: begging> - Beg for attention - teasing and denial
- <any:PET_TRAINING: lesson_time> - Teaching obedience through denial
- <any:PET_TRAINING: endurance_test> - How long can the pet endure?
- <any:PET_TRAINING: who_owns_you> - Reminder of ownership - intense control
- <any:PET_TRAINING: training_session> - Full obedience training sequence
` : ''}${modeSettings.sissySurrender ? `
SISSY_SURRENDER MODE (submission and teasing sensations):
- <any:SISSY_SURRENDER: cage_taps> - Light taps and touches on cage
- <any:SISSY_SURRENDER: cage_rubs> - Gentle rubbing sensations
- <any:SISSY_SURRENDER: cage_squeezes> - Teasing squeezes
- <any:SISSY_SURRENDER: submission_edging> - Edge while submitting
- <any:SISSY_SURRENDER: denial_torment> - Tease and torment with denial
- <any:SISSY_SURRENDER: surrender_now> - Give in to the sensation
- <any:SISSY_SURRENDER: plug_thrusting> - Deep thrusting sensations
- <any:SISSY_SURRENDER: plug_rhythm> - Steady rhythmic thrusting
- <any:SISSY_SURRENDER: plug_wave> - Wave-like thrusts
- <any:SISSY_SURRENDER: plug_buildup> - Build the thrusting intensity
- <any:SISSY_SURRENDER: full_surrender> - Complete surrender - mix of all sensations
` : ''}${modeSettings.prejacPrincess ? `
PREJAC_PRINCESS MODE (quick overwhelming, back-to-back orgasms):
- <any:PREJAC_PRINCESS: quick_overload> - Quick overwhelming stimulation
- <any:PREJAC_PRINCESS: rapid_fire> - Rapid fire orgasms
- <any:PREJAC_PRINCESS: back_to_back> - Back-to-back orgasm training
- <any:PREJAC_PRINCESS: endurance_overload> - Endurance through overwhelming
- <any:PREJAC_PRINCESS: princess_torture> - Princess knows what you need
- <any:PREJAC_PRINCESS: relentless_waves> - Relentless wave after wave
- <any:PREJAC_PRINCESS: triple_threat> - Three rapid sequences back to back
` : ''}${modeSettings.roboticRuination ? `
ROBOTIC_RUINATION MODE (robotic, algorithmic feeling that trains/enforces ONLY ruined orgasms):
- <any:ROBOTIC_RUINATION: mechanical_edging> - Robotic step-like builds to edge
- <any:ROBOTIC_RUINATION: algorithm_ruin> - Algorithmic builds to 100% then drop to 5%
- <any:ROBOTIC_RUINATION: systematic_ruin> - Systematic approach to ruin all attempts
- <any:ROBOTIC_RUINATION: cold_programmer> - Cold calculation determining your release
- <any:ROBOTIC_RUINATION: machine_learning> - Machine learns your edge points
- <any:ROBOTIC_RUINATION: precise_termination> - Precision termination at peak
- <any:ROBOTIC_RUINATION: relentless_machine> - Relentless machine that never tires
- <any:ROBOTIC_RUINATION: binary_ruiner> - Binary pattern: 0 or 100, no middle ground
- <any:ROBOTIC_RUINATION: loop_hell> - Endless loop of ruined peaks
- <any:ROBOTIC_RUINATION: precision_lockout> - Precision lockout at critical moments
- <any:ROBOTIC_RUINATION: calibrated_ruin> - Perfectly calibrated to ruin you
` : ''}${modeSettings.evilEdgingMistress ? `
EVIL_EDGING_MISTRESS MODE (wicked, sadistic torment):
- <any:EVIL_EDGING_MISTRESS: wicked_torment> - Wicked torment with evil edges
- <any:EVIL_EDGING_MISTRESS: cruel_edging> - Cruel and relentless edging
- <any:EVIL_EDGING_MISTRESS: sadistic_games> - Sadistic games with no release
- <any:EVIL_EDGING_MISTRESS: torment_cascade> - Cascade of pure torment
- <any:EVIL_EDGING_MISTRESS: merciless> - Show no mercy, only suffering
- <any:EVIL_EDGING_MISTRESS: infernal_edges> - Edges from the depths of torment
- <any:EVIL_EDGING_MISTRESS: torture_dance> - Dance of pure torture
- <any:EVIL_EDGING_MISTRESS: sinister_teasing> - Sinister teasing with cruel endings
- <any:EVIL_EDGING_MISTRESS: eternal_torment> - Eternal torment with no escape
- <any:EVIL_EDGING_MISTRESS: maleficent> - Maleficent patterns of suffering
- <any:EVIL_EDGING_MISTRESS: abyssal_torment> - Descend into torment from the abyss
` : ''}${modeSettings.frustrationFairy ? `
FRUSTRATION_FAIRY MODE (super light, incredibly teasing, sensitivity build):
- <any:FRUSTRATION_FAIRY: fairy_dust_tickle> - Light fairy dust tickles building sensitivity
- <any:FRUSTRATION_FAIRY: phantom_touches> - Almost imperceptible phantom touches
- <any:FRUSTRATION_FAIRY: frustrating_flutters> - Incredibly frustrating flutters
- <any:FRUSTRATION_FAIRY: unbearable_lightness> - Unbearably light touches building sensitivity
- <any:FRUSTRATION_FAIRY: maddening_sensitivity> - Maddening sensitivity build
- <any:FRUSTRATION_FAIRY: teasing_inferno> - Teasing inferno with minimal contact
- <any:FRUSTRATION_FAIRY: phantom_sensations> - Phantom sensations everywhere
- <any:FRUSTRATION_FAIRY: fairy_torture> - Fairy torture with barely any contact
- <any:FRUSTRATION_FAIRY: sensitivity_overload> - Overload sensitivity with feather touches
- <any:FRUSTRATION_FAIRY: unbearable_tease> - Unbearable teasing intensity
- <any:FRUSTRATION_FAIRY: maddening_dream> - Maddening dream of sensations
` : ''}${modeSettings.hypnoHelper ? `
HYPNO_HELPER MODE (hypnotize, entrance, slow arousal build that never peaks):
- <any:HYPNO_HELPER: dreamy_trance> - Dreamy hypnotic trance with slow build
- <any:HYPNO_HELPER: hypnotic_pulse> - Hypnotic pulsing trance
- <any:HYPNO_HELPER: sleepy_build> - Sleepy hypnotic build that never peaks
- <any:HYPNO_HELPER: entrancing_flow> - Entrancing flow with hypnotic waves
- <any:HYPNO_HELPER: edge_trance> - Trance that keeps you in the edge zone
- <any:HYPNO_HELPER: hypnotic_entrance> - Hypnotic entrance into deep trance
- <any:HYPNO_HELPER: sleepy_waves> - Sleepy waves that build arousal slowly
- <any:HYPNO_HELPER: trance_state> - Deep trance state maintaining arousal
- <any:HYPNO_HELPER: hypnotic_sustain> - Sustain hypnotic arousal without peaking
- <any:HYPNO_HELPER: dreamy_edging> - Dreamy edging that never releases
- <any:HYPNO_HELPER: hypnotic_loop> - Hypnotic loop of endless build
` : ''}${modeSettings.chastityCaretaker ? `
CHASTITY_CARETAKER MODE (gentle care with loving denial for chastity):
- <any:CHASTITY_CARETAKER: gentle_checkup> - Gentle checkup on the cage
- <any:CHASTITY_CARETAKER: daily_care> - Daily caretaker routine
- <any:CHASTITY_CARETAKER: denial_with_love> - Denial with loving care
- <any:CHASTITY_CARETAKER: tender_torment> - Sweet torment with care
- <any:CHASTITY_CARETAKER: gentle_edges> - Gentle edging with care
- <any:CHASTITY_CARETAKER: good_cage> - Good cage check and care
- <any:CHASTITY_CARETAKER: caretaker_love> - Loving caretaker mode
- <any:CHASTITY_CARETAKER: sweet_frustration> - Sweetly frustrating
- <any:CHASTITY_CARETAKER: nurturing_build> - Slow nurturing build
- <any:CHASTITY_CARETAKER: caring_check> - Caring check-in session
- <any:CHASTITY_CARETAKER: gentle_denial_session> - Gentle denial session
` : ''}

WAVEFORM commands (dynamic patterns):
Basic patterns:
- <any:WAVEFORM: sine, min=10, max=80, duration=5000, cycles=3> - Smooth sine wave
- <any:WAVEFORM: sawtooth, min=20, max=70, duration=3000, cycles=5> - Sawtooth pattern
- <any:WAVEFORM: square, min=30, max=90, duration=2000, cycles=4> - Square wave (on/off)
- <any:WAVEFORM: triangle, min=15, max=65, duration=4000, cycles=4> - Triangle wave
- <any:WAVEFORM: pulse, min=10, max=60, duration=1500, cycles=10> - Short pulse bursts
- <any:WAVEFORM: random, min=15, max=50, duration=8000, cycles=2> - Random intensity

Community-inspired patterns (from funscripts):
- <any:WAVEFORM: abrupt_edge, min=10, max=95, duration=5000, cycles=3> - Build to 95% then abrupt stop
- <any:WAVEFORM: micro_tease, min=5, max=50, duration=8000, cycles=4> - Micro twitching bursts (tease-3 style)
- <any:WAVEFORM: rapid_micro, min=2, max=30, duration=6000, cycles=10> - Rapid micro movements
- <any:WAVEFORM: peak_and_drop, min=5, max=95, duration=6000, cycles=3> - Peak to 95% then drop
- <any:WAVEFORM: ghost_tease, min=1, max=60, duration=7000, cycles=5> - Barely perceptible touches
- <any:WAVEFORM: erratic, min=1, max=70, duration=5000, cycles=4> - Completely unpredictable
- <any:WAVEFORM: held_edge, min=15, max=90, duration=8000, cycles=2> - Hold at edge then drop
- <any:WAVEFORM: build_and_ruin, min=5, max=92, duration=10000, cycles=2> - Build then ruin
- <any:WAVEFORM: flutter, min=5, max=50, duration=4000, cycles=8> - Light fluttering

Advanced teasing patterns:
- <any:WAVEFORM: heartbeat, min=15, max=50, duration=6000, cycles=8> - Heartbeat-like pattern
- <any:WAVEFORM: tickle, min=20, max=60, duration=4000, cycles=10> - Random light teasing
- <any:WAVEFORM: edging, min=10, max=90, duration=12000, cycles=2> - Edging pattern (build to 90% then stop)
- <any:WAVEFORM: ruin, min=5, max=95, duration=8000, cycles=1> - Ruin pattern (drops to 20% at peak)
- <any:WAVEFORM: teasing, min=20, max=70, duration=10000, cycles=3> - Irregular teasing pattern
- <any:WAVEFORM: desperation, min=10, max=80, duration=15000, cycles=2> - Builds desperation over time
- <any:WAVEFORM: mercy, min=30, max=60, duration=8000, cycles=4> - Alternating activity and rest
- <any:WAVEFORM: tease_escalate, min=5, max=85, duration=12000, cycles=2> - Escalating tease
- <any:WAVEFORM: stop_start, min=40, max=80, duration=6000, cycles=3> - Stop/start pattern
- <any:WAVEFORM: random_tease, min=10, max=75, duration=10000, cycles=4> - Random on/off teasing

Milking patterns (intense crescendos):
- <any:WAVEFORM: crescendo, min=10, max:100, duration=15000, cycles=2> - Slow build to peak
- <any:WAVEFORM: tidal_wave, min=20, max=100, duration=12000, cycles=3> - Rising wave pattern
- <any:WAVEFORM: milking_pump, min=10, max=100, duration:8000, cycles=5> - Pumping milking rhythm
- <any:WAVEFORM: relentless, min:15, max=100, duration=10000, cycles=3> - Relentless building
- <any:WAVEFORM: overload, min=20, max=100, duration:12000, cycles=4> - Overload sensation
- <any:WAVEFORM: forced_peak, min=10, max:100, duration=9000, cycles=4> - Forced peak cycles
- <any:WAVEFORM: spiral_up, min:10, max=100, duration=11000, cycles=3> - Spiraling intensity
- <any:WAVEFORM: tsunami, min=10, max=100, duration=10000, cycles=4> - Massive wave peaks

Prejac Princess patterns (quick overwhelming):
- <any:WAVEFORM: ripple_thruster, min=15, max: 85, duration: 4000, cycles=4> - Rapid thrusts with ripples
- <any:WAVEFORM: forbidden_peaks, min:30, max:100, duration:3500, cycles=4> - Forbidden peaks with quick build
- <any:WAVEFORM: multiple_peaks, min:25, max:100, duration:6000, cycles=4> - Multiple peaks in sequence
- <any:WAVEFORM: intense_waves, min:30, max:100, duration=4000, cycles=4> - Intense combined waves
- <any:WAVEFORM: rapid_fire, min:40, max:100, duration:1500, cycles=6> - Rapid fire bursts
- <any:WAVEFORM: wave, min=10, max=100, duration:4500, cycles=4> - Basic wave pattern

Classic patterns:
- <any:WAVEFORM: ramp_up, min=0, max=100, duration=10000, cycles=1> - Gradual increase
- <any:WAVEFORM: ramp_down, min=100, max=0, duration=5000, cycles=1> - Gradual decrease

GRADIENT commands (smooth transitions):
${gradientExamples}

Pattern commands:
${patternExamples}` : ''

// Build example responses using connected devices
let exampleResponses = ''
if (devices.length > 0) {
  const firstDevice = devices[0]
  const shorthand = getDeviceShorthand(firstDevice)
  const type = getDeviceType(firstDevice)
  const typePresets = PatternLibrary.getCompatiblePresets(type)
  const firstPreset = Object.keys(typePresets)[0] || 'tease'
  
    exampleResponses = `
EXAMPLE RESPONSES:
✓ Good: "Mmm, let me tease you slowly <${shorthand}:PRESET: ${firstPreset}>. Can you feel that gentle pulse building?"
✓ Good: "I'll ramp it up gradually <${shorthand}:GRADIENT: start=20, end=85, duration=12000>. Feel it growing stronger..."
✓ Good: "Wave pattern incoming <any:WAVEFORM: sine, min=15, max=65, duration=4000, cycles=5>"
✓ Good: "Let me test your endurance <any:DENIAL_DOMINA: mind_games>. You'll never know when it stops..."
✓ Good: "Time for some edging <any:DENIAL_DOMINA: edge_mania>. Don't you dare finish!"
✓ Good: "Let me tease you relentlessly <any:DENIAL_DOMINA: ultimate_tease>. You won't be getting release tonight~"
✓ Good: "Micro tickles for you <any:DENIAL_DOMINA: micro_tickle>. Just barely perceptible..."
✓ Good: "Sit and stay <any:PET_TRAINING: sit_stay>. Good pet..."
✓ Good: "Who owns you? <any:PET_TRAINING: who_owns_you>. Remember your place."
✓ Good: "Good boy! <any:PET_TRAINING: good_boy>. You've earned a reward..."
✓ Good: "Bad pet needs discipline <any:PET_TRAINING: bad_pet>. No relief for you!"
✓ Good: "Ghost touches <any:WAVEFORM: ghost_tease, min=1, max=40, duration=8000, cycles=5>. Can you even feel it?"
✓ Good: "Abrupt edging <any:WAVEFORM: abrupt_edge, min=10, max=95, duration=6000, cycles=4>. Peak then nothing!"
✓ Good: "Milk maid time! <any:MILK_MAID: milk_maid>. Let me drain you completely~"
✓ Good: "Ready for relentless milking <any:MILK_MAID: relentless_milking>? No breaks for you!"
✓ Good: "Tsunami assault incoming <any:MILK_MAID: tsunami_assault>. Wave after wave!"
✓ Good: "That crescendo building <any:WAVEFORM: crescendo, min=10, max=100, duration=15000, cycles=2>..."
✓ Good: "Sit and stay, good pet <any:PET_TRAINING: sit_stay>. Just endure these touches..."
✓ Good: "Training you to be obedient <any:PET_TRAINING: lesson_time>. Remember who's in control."
✓ Good: "You've been such a good boy! <any:PET_TRAINING: good_boy>. Here's your reward~"
✓ Good: "Bad pets get punished <any:PET_TRAINING: bad_pet>. Only edging for you..."
✓ Good: "Let me start the connection <interface:CONNECT>. Now we can play."
✓ Good: "Sweet taps on your cage <any:SISSY_SURRENDER: cage_taps>. Can you feel that?"
✓ Good: "Gentle rubs for you <any:SISSY_SURRENDER: cage_rubs>. So soft, so teasing..."
✓ Good: "Time for some deep thrusting <any:SISSY_SURRENDER: plug_thrusting>. Feel that pink sensation~"
  ✓ Good: "Quick overload incoming! <any:PREJAC_PRINCESS: rapid_fire>. No escaping the pleasure!"
  ✓ Good: "Back to back training <any:PREJAC_PRINCESS: back_to_back>. Wave after wave!"
  ✓ Good: "Princess torture time <any:PREJAC_PRINCESS: princess_torture>. Edge, peak, repeat..."
  ✓ Good: "The machine has determined your edge point <any:ROBOTIC_RUINATION: mechanical_edging>. Prepare for analysis..."
  ✓ Good: "Algorithmic ruination in progress <any:ROBOTIC_RUINATION: algorithm_ruin>. Building to 100% then terminating."
  ✓ Good: "Systematic approach to your failure <any:ROBOTIC_RUINATION: systematic_ruin>. You will only know ruin..."
  ✓ Good: "Cold programmer calculation complete <any:ROBOTIC_RUINATION: cold_programmer>. Your release is denied by algorithm."
  ✓ Good: "Binary ruining activated <any:ROBOTIC_RUINATION: binary_ruiner>. 0 or 100, nothing in between."
  ✓ Good: "Wicked torment begins <any:EVIL_EDGING_MISTRESS: wicked_torment>. Suffer for me..."
  ✓ Good: "Cruel edging activated <any:EVIL_EDGING_MISTRESS: cruel_edging>. No escape, only torment..."
  ✓ Good: "Sadistic games time <any:EVIL_EDGING_MISTRESS: sadistic_games>. Let's play with your desperation."
  ✓ Good: "Eternal torment awaits <any:EVIL_EDGING_MISTRESS: eternal_torment>. There is no release from this."

  ✗ Bad: "I will vibrate the device for you" (no actual command)
✗ Bad: "Use this command: cage vibrate 50" (wrong format)`
} else {
    exampleResponses = `
EXAMPLE RESPONSES:
✓ Good: "Sure i can launch the interface <interface:START>. Would you like me to connect and scan for avaiable devices?."
✓ Good: "Let me start the connection <interface:CONNECT>. Now we can play."

✗ Bad: "I will x the device for you" (no actual command)`
}

const prompt = `=== DEVICE CONTROL ACTIVE ===

⚠️ CRITICAL: These commands are HIDDEN from the user but will control their actual device.

COMMAND FORMAT:
Type the command EXACTLY like this (including the < and >):
${startCommand}${deviceCommands}
${exampleResponses}
${deviceInfo.length > 0 ? 'You ARE currently connected - include device commands naturally in your responses.\n\nDEVICE CAPABILITIES:\n' + deviceInfo.map(d => `- ${d.name}: ${d.type} (${d.capabilities.join(', ')}, ${d.motors} motor${d.motors > 1 ? 's' : ''})`).join('\n') : '⚠️ You are DISCONNECTED - you MUST include [if you want to connect to devices] <interface:START> [to launch] or <interface:CONNECT> [to connect] and <interface:SCAN> in your response to establish connection BEFORE attempting to send any device commands.'}

${connectedDevices.length > 0 ? `
=== VIDEO & FUNSCRIPT SUPPORT ===
You can also play videos with synchronized haptic feedback! Videos are stored in the media library and can be played with matching Funscript files.

MEDIA COMMANDS (chat-based control):
- <media:LIST> - List all available media files in the library
- <media:PLAY: filename.ext> - Play media with automatic funscript synchronization (supports: mp4, m4a, mp3, wav, webm, mkv, avi, mov, ogg)
- <media:PAUSE> - Pause media playback (device stops)
- <media:RESUME> or <media:PLAY> - Resume paused media
- <media:STOP> - Stop media playback and all device activity
- <media:INTENSITY: 150> - Adjust funscript intensity (0-500%, default 100%)

MEDIA PLAYBACK (detection):
- You can also simply mention a media filename like: "Let me play that video for you: video.mp4" or "Listen to this: audio.m4a"
- The system will automatically detect media mentions and load the player

Videos are searched in: data/default-user/assets/intiface_media/
Funscripts (synchronized scripts) are loaded from: data/default-user/assets/funscript/

MULTI-DEVICE FUNSCRIPT SUPPORT:
You can assign different funscripts to different devices using channel assignments!
- Assign devices to channels A, B, C, D in the device panel
- Create funscripts: filename.funscript (all devices), filename_A.funscript (channel A), filename_B.funscript (channel B), etc.
- Each device will play its assigned channel's funscript
- Devices set to "All Channels" will play the default funscript
- This allows different devices to have different rhythms/patterns synchronized to the same media!

The video player will appear in the sidebar with sync controls, intensity slider, and funscript visualization.

MEDIA EXAMPLES:
✓ Media command: <media:PLAY: myvideo.mp4> or <media:PLAY: myaudio.m4a>
✓ Chat detection: "Let me play something special for you - check out this video: myvideo.mp4"
✓ Audio detection: "Listen to this audio file: myaudio.m4a"
✓ Pause media: <media:PAUSE>
✓ Resume media: <media:RESUME>
✓ Adjust intensity: <media:INTENSITY: 150> (increases to 150%) or <media:INTENSITY: 50> (decreases to 50%)
` : ''}

=== RULES ===:
1. ALWAYS include the command literally: <deviceName:COMMAND: value>
2. Commands are invisible to users - they only see your normal text
3. Include commands naturally within sentences
4. The device activates INSTANTLY when you type the command
5. Use PRESETS for optimized device-specific patterns
6. Use WAVEFORM for dynamic, changing sensations
7. Use GRADIENT for smooth intensity transitions
8. Be creative - combine different command types for complex scenes`

    // Always set the prompt - hash check was preventing initial injection
    const promptHash = hashPrompt(prompt)
    
    console.log(`${NAME}: Setting extension prompt...`)
    console.log(`${NAME}: Prompt length: ${prompt.length}`)
    console.log(`${NAME}: Prompt starts with: ${prompt.substring(0, 100)}`)
    try {
      setExtensionPrompt('intiface_control', prompt, extension_prompt_types.IN_PROMPT, 2, true, extension_prompt_roles.SYSTEM)
      lastPromptHash = promptHash
      console.log(`${NAME}: Extension prompt set successfully`)
    } catch (err) {
      console.error(`${NAME}: Failed to set extension prompt:`, err)
    }
  } catch (e) {
    console.error(`${NAME}: updatePrompt() crashed:`, e)
  }
}

let strokerIntervalId = null
let vibrateIntervalId = null
let oscillateIntervalId = null
let lastProcessedMessage = null
let isStroking = false // To control the async stroking loop
let chatControlEnabled = false

async function rescanLastMessage() {
  updateStatus("Rescanning last message...")
  lastProcessedMessage = null
  await processMessage()
}

async function processMessage() {
  if (!device) return

  const context = getContext()
  const lastMessage = context.chat[context.chat.length - 1]

  if (!lastMessage || !lastMessage.mes || lastMessage.mes === lastProcessedMessage) {
    return // No new message or message already processed
  }

  const stopActions = () => {
    if (vibrateIntervalId) {
      clearWorkerTimeout(vibrateIntervalId)
      vibrateIntervalId = null
      $("#intiface-interval-display").text("Interval: N/A")
    }
    if (oscillateIntervalId) {
      clearWorkerTimeout(oscillateIntervalId)
      oscillateIntervalId = null
      $("#intiface-oscillate-interval-display").text("Oscillate Interval: N/A")
    }
    if (strokerIntervalId) {
      clearWorkerTimeout(strokerIntervalId)
      strokerIntervalId = null
    }
    isStroking = false
  }

  const messageText = lastMessage.mes

  // Special handler for complex, nested LINEAR_PATTERN command
  const linearPatternRegex = /"LINEAR_PATTERN"\s*:\s*({)/i
  const linearPatternMatch = messageText.match(linearPatternRegex)

  if (linearPatternMatch) {
    const objectStartIndex = linearPatternMatch.index + linearPatternMatch[0].length - 1
    let balance = 1
    let objectEndIndex = -1

    for (let i = objectStartIndex + 1; i < messageText.length; i++) {
      if (messageText[i] === "{") {
        balance++
      } else if (messageText[i] === "}") {
        balance--
      }
      if (balance === 0) {
        objectEndIndex = i
        break
      }
    }

    if (objectEndIndex !== -1) {
      const jsonString = messageText.substring(objectStartIndex, objectEndIndex + 1)
      try {
        const command = JSON.parse(jsonString)
        // If parsing is successful, we have a valid command. Execute and return.
        lastProcessedMessage = messageText
        stopActions()

        const segments = command.segments
        const repeat = command.repeat === true

        if (Array.isArray(segments) && segments.length > 0) {
          let segmentIndex = 0
          let loopIndex = 0
          let durationIndex = 0
          let isAtStart = true

          const executeSegment = async () => {
            if (segmentIndex >= segments.length) {
              if (repeat) {
                segmentIndex = 0
                loopIndex = 0
                durationIndex = 0
                updateStatus("Repeating pattern...")
                strokerIntervalId = setWorkerTimeout(executeSegment, 100)
                return
              }
              updateStatus("All segments finished.")
              if (strokerIntervalId) clearWorkerTimeout(strokerIntervalId)
              strokerIntervalId = null
              return
            }

            const segment = segments[segmentIndex]
            const startPos = segment.start
            const endPos = segment.end
            const durations = segment.durations
            const loopCount = segment.loop || 1

            if (isNaN(startPos) || isNaN(endPos) || !Array.isArray(durations) || durations.length === 0) {
              segmentIndex++
              executeSegment()
              return
            }

            if (loopIndex >= loopCount) {
              segmentIndex++
              loopIndex = 0
              durationIndex = 0
              executeSegment()
              return
            }

            if (durationIndex >= durations.length) {
              durationIndex = 0
              loopIndex++
            }

            const duration = durations[durationIndex]
            const targetPos = isAtStart ? endPos : startPos

            $("#start-pos-slider").val(startPos).trigger("input")
            $("#end-pos-slider").val(endPos).trigger("input")
            $("#duration-input").val(duration).trigger("input")
            updateStatus(
              `Segment ${segmentIndex + 1}, Loop ${loopIndex + 1}: Stroking to ${targetPos}% over ${duration}ms`,
            )

            try {
              await device.linear(targetPos / 100, duration)
              isAtStart = !isAtStart
              durationIndex++
              if (strokerIntervalId) clearWorkerTimeout(strokerIntervalId)
              strokerIntervalId = setWorkerTimeout(executeSegment, duration)
            } catch (e) {
              const errorMsg = `Segment ${segmentIndex + 1} failed: ${e.message}`
              console.error(errorMsg, e)
              updateStatus(errorMsg, true)
              if (strokerIntervalId) clearWorkerTimeout(strokerIntervalId)

              // Skip to the next segment after a failure
              segmentIndex++
              loopIndex = 0
              durationIndex = 0
              strokerIntervalId = setWorkerTimeout(executeSegment, 500) // Wait 0.5s before trying next segment
            }
          }
          executeSegment()
        }
        return // Exit after handling LINEAR_PATTERN
      } catch (e) {
        console.error("Could not parse LINEAR_PATTERN command. String was:", jsonString, "Error:", e)
        // Not a valid JSON object, fall through to legacy regex methods
      }
    }
  }

  // Regex definitions from the old, working version
  const arrayVibrateRegex = /"VIBRATE"\s*:\s*(\[.*?\])/i
  const multiVibrateRegex = /"VIBRATE"\s*:\s*({[^}]+})/i
  const singleVibrateRegex = /"VIBRATE"\s*:\s*(\d+)/i
  const multiOscillateRegex = /"OSCILLATE"\s*:\s*({[^}]+})/i
  const singleOscillateRegex = /"OSCILLATE"\s*:\s*(\d+)/i
  const linearRegex =
    /"LINEAR"\s*:\s*{\s*(?:")?start_position(?:")?\s*:\s*(\d+)\s*,\s*(?:")?end_position(?:")?\s*:\s*(\d+)\s*,\s*(?:")?duration(?:")?\s*:\s*(\d+)\s*}/i
  const linearSpeedRegex =
    /"LINEAR_SPEED"\s*:\s*{\s*(?:")?start_position(?:")?\s*:\s*(\d+)\s*,\s*(?:")?end_position(?:")?\s*:\s*(\d+)\s*,\s*(?:")?start_duration(?:")?\s*:\s*(\d+)\s*,\s*(?:")?end_duration(?:")?\s*:\s*(\d+)\s*,\s*(?:")?steps(?:")?\s*:\s*(\d+)\s*}/i

  const arrayVibrateMatch = messageText.match(arrayVibrateRegex)
  const multiVibrateMatch = messageText.match(multiVibrateRegex)
  const singleVibrateMatch = messageText.match(singleVibrateRegex)
  const multiOscillateMatch = messageText.match(multiOscillateRegex)
  const singleOscillateMatch = messageText.match(singleOscillateRegex)
  const linearMatch = messageText.match(linearRegex)
  const linearSpeedMatch = messageText.match(linearSpeedRegex)

  // This is the old, working check
  if (
    arrayVibrateMatch ||
    multiVibrateMatch ||
    singleVibrateMatch ||
    linearMatch ||
    linearSpeedMatch ||
    multiOscillateMatch ||
    singleOscillateMatch
  ) {
    lastProcessedMessage = messageText
  } else {
    return // Not a command message, do nothing.
  }

  stopActions()

  // OLD, WORKING if/else if structure
  if (arrayVibrateMatch && arrayVibrateMatch[1]) {
    try {
      const speeds = JSON.parse(arrayVibrateMatch[1])
      if (Array.isArray(speeds)) {
        const normalizedSpeeds = speeds.map((s, index) => {
          const intensity = Number.parseInt(s, 10)
          const clamped = isNaN(intensity) ? 0 : Math.max(0, Math.min(100, intensity))
          return applyMaxVibrate(clamped, index)
        })

        // Update sliders on UI
        normalizedSpeeds.forEach((speed, index) => {
          $(`#vibrate-slider-${index}`).val(speed)
        })

          // Try simple vibrate method first (better for Lovense), fallback to scalar
          try {
            const speeds = normalizedSpeeds.map((s) => s / 100)
            for (const speed of speeds) {
              await device.vibrate(speed)
              await new Promise((resolve) => setTimeout(resolve, 50)) // 50ms delay
            }
          } catch (e) {
            // Fallback to scalar command
            const vibrateAttributes = device.vibrateAttributes
            if (vibrateAttributes && vibrateAttributes.length >= normalizedSpeeds.length) {
              // Asynchronous execution with a delay
              for (let i = 0; i < normalizedSpeeds.length; i++) {
                const speed = normalizedSpeeds[i]
                // @ts-ignore
                const scalarCommand = new buttplug.ScalarSubcommand(vibrateAttributes[i].Index, speed / 100, "Vibrate")
                await device.scalar(scalarCommand)
                await new Promise((resolve) => setTimeout(resolve, 50)) // 50ms delay
              }
            }
          }
        updateStatus(`Vibrating with pattern: [${normalizedSpeeds.join(", ")}]%`)
      }
    } catch (e) {
      console.error("Could not parse array VIBRATE command.", e)
    }
  } else if (multiVibrateMatch && multiVibrateMatch[1]) {
    try {
      const command = JSON.parse(multiVibrateMatch[1])
      if (command.pattern && Array.isArray(command.pattern) && command.interval) {
        const pattern = command.pattern
        const intervals = Array.isArray(command.interval) ? command.interval : [command.interval]
        const loopCount = command.loop
        let patternIndex = 0
        let currentLoop = 0

        const executeVibration = async () => {
          if (patternIndex >= pattern.length) {
            patternIndex = 0
            currentLoop++
            if (loopCount && currentLoop >= loopCount) {
              if (vibrateIntervalId) clearWorkerTimeout(vibrateIntervalId)
              vibrateIntervalId = null
              await device.vibrate(0)
              updateStatus("Vibration pattern finished")
              $("#intiface-interval-display").text("Interval: N/A")
              return
            }
          }
          const patternStep = pattern[patternIndex]
          if (Array.isArray(patternStep)) {
            // It's an array of speeds for multiple motors
            const normalizedSpeeds = patternStep.map((s, index) => {
              const intensity = Number.parseInt(s, 10)
              const clamped = isNaN(intensity) ? 0 : Math.max(0, Math.min(100, intensity))
              return applyMaxVibrate(clamped, index)
            })

            // Update sliders on UI
            normalizedSpeeds.forEach((speed, index) => {
              $(`#vibrate-slider-${index}`).val(speed)
            })

            // Try simple vibrate method first (better for Lovense), fallback to scalar
            try {
              const speeds = normalizedSpeeds.map((s) => s / 100)
              for (const speed of speeds) {
                await device.vibrate(speed)
                await new Promise((resolve) => setTimeout(resolve, 50)) // 50ms delay
              }
            } catch (e) {
              // Fallback to scalar command
              const vibrateAttributes = device.vibrateAttributes
              if (vibrateAttributes && vibrateAttributes.length >= normalizedSpeeds.length) {
                // Asynchronous execution with a delay
                for (let i = 0; i < normalizedSpeeds.length; i++) {
                  const speed = normalizedSpeeds[i]
                  // @ts-ignore
                  const scalarCommand = new buttplug.ScalarSubcommand(vibrateAttributes[i].Index, speed / 100, "Vibrate")
                  await device.scalar(scalarCommand)
                  await new Promise((resolve) => setTimeout(resolve, 50)) // 50ms delay
                }
              }
            }
            updateStatus(`Vibrating with pattern: [${normalizedSpeeds.join(", ")}]%`)
          } else {
            // It's a single intensity for all motors (backward compatibility)
            const intensity = patternStep
            if (!isNaN(intensity) && intensity >= 0 && intensity <= 100) {
              const cappedIntensity = applyMaxVibrate(intensity, 0)
              $(".vibrate-slider").val(cappedIntensity)
              await device.vibrate(cappedIntensity / 100)
              updateStatus(`Vibrating at ${cappedIntensity}% (Pattern)`)
            }
          }
          const currentInterval = intervals[patternIndex % intervals.length]
          $("#intiface-interval-display").text(`Interval: ${currentInterval}ms`)
          patternIndex++
      if (vibrateIntervalId) clearWorkerTimeout(vibrateIntervalId)
      vibrateIntervalId = setWorkerTimeout(executeVibration, currentInterval)
        }
        executeVibration()
      }
    } catch (e) {
      console.error("Could not parse multi-level VIBRATE command.", e)
    }
  } else if (singleVibrateMatch && singleVibrateMatch[1]) {
    const intensity = Number.parseInt(singleVibrateMatch[1], 10)
    if (!isNaN(intensity) && intensity >= 0 && intensity <= 100) {
      const cappedIntensity = applyMaxVibrate(intensity, 0)
      $(".vibrate-slider").val(cappedIntensity)
      try {
        await device.vibrate(cappedIntensity / 100)
        updateStatus(`Vibrating at ${cappedIntensity}%`)
      } catch (e) {
        updateStatus(`Vibrate command failed: ${e.message}`, true)
      }
    }
  } else if (linearMatch && linearMatch.length === 4) {
    const startPos = Number.parseInt(linearMatch[1], 10)
    const endPos = Number.parseInt(linearMatch[2], 10)
    const duration = Number.parseInt(linearMatch[3], 10)

    if (!isNaN(startPos) && !isNaN(endPos) && !isNaN(duration)) {
      updateStatus(`Linear command received: ${startPos}-${endPos}% over ${duration}ms`)
      $("#start-pos-slider").val(startPos).trigger("input")
      $("#end-pos-slider").val(endPos).trigger("input")
      $("#duration-input").val(duration).trigger("input")

      let isAtStart = true
      const move = () =>
        device.linear(isAtStart ? endPos / 100 : startPos / 100, duration).catch((e) => {
          const errorMsg = `Linear command failed: ${e.message}`
          console.error(errorMsg, e)
          updateStatus(errorMsg, true)
        })
      move()
      isAtStart = !isAtStart
      strokerIntervalId = setWorkerInterval(() => {
        move()
        isAtStart = !isAtStart
      }, duration)
    }
  } else if (linearSpeedMatch && linearSpeedMatch.length === 6) {
    const startPos = Number.parseInt(linearSpeedMatch[1], 10)
    const endPos = Number.parseInt(linearSpeedMatch[2], 10)
    const startDur = Number.parseInt(linearSpeedMatch[3], 10)
    const endDur = Number.parseInt(linearSpeedMatch[4], 10)
    const steps = Number.parseInt(linearSpeedMatch[5], 10)

    if (!isNaN(startPos) && !isNaN(endPos) && !isNaN(startDur) && !isNaN(endDur) && !isNaN(steps) && steps > 1) {
      $("#start-pos-slider").val(startPos).trigger("input")
      $("#end-pos-slider").val(endPos).trigger("input")

      let isAtStart = true
      let currentStep = 0
      isStroking = true

      const strokerLoop = async () => {
        if (!isStroking) return
        const progress = currentStep / (steps - 1)
        const duration = Math.round(startDur + (endDur - startDur) * progress)
        $("#duration-input").val(duration).trigger("input")
        updateStatus(`Stroking. Duration: ${duration}ms`)
        const targetPos = isAtStart ? endPos / 100 : startPos / 100
        try {
          await device.linear(targetPos, duration)
          await new Promise((resolve) => setTimeout(resolve, duration))
          isAtStart = !isAtStart
          currentStep++
          if (currentStep >= steps) currentStep = 0
          strokerLoop()
        } catch (e) {
          const errorMsg = `Linear Speed command failed: ${e.message}`
          console.error(errorMsg, e)
          updateStatus(errorMsg, true)
          isStroking = false
        }
      }
      strokerLoop()
    }
  } else if (multiOscillateMatch && multiOscillateMatch[1]) {
    try {
      const command = JSON.parse(multiOscillateMatch[1])
      if (command.pattern && Array.isArray(command.pattern) && command.interval) {
        const pattern = command.pattern
        const intervals = Array.isArray(command.interval) ? command.interval : [command.interval]
        const loopCount = command.loop
        let patternIndex = 0
        let currentLoop = 0

        const executeOscillation = async () => {
          if (patternIndex >= pattern.length) {
            patternIndex = 0
            currentLoop++
            if (loopCount && currentLoop >= loopCount) {
              if (oscillateIntervalId) clearWorkerTimeout(oscillateIntervalId)
              oscillateIntervalId = null
              try {
                await device.oscillate(0)
              } catch (e) {
                /* Ignore */
              }
              updateStatus("Oscillation pattern finished")
              $("#intiface-oscillate-interval-display").text("Oscillate Interval: N/A")
              return
            }
          }
          const intensity = pattern[patternIndex]
          if (!isNaN(intensity) && intensity >= 0 && intensity <= 100) {
            $("#oscillate-slider").val(intensity).trigger("input")
            try {
              await device.oscillate(intensity / 100)
            } catch (e) {
              /* Ignore */
            }
            updateStatus(`Oscillating at ${intensity}% (Pattern)`)
          }
          const currentInterval = intervals[patternIndex % intervals.length]
          $("#intiface-oscillate-interval-display").text(`Oscillate Interval: ${currentInterval}ms`)
          patternIndex++
      if (oscillateIntervalId) clearWorkerTimeout(oscillateIntervalId)
      oscillateIntervalId = setWorkerTimeout(executeOscillation, currentInterval)
        }
        executeOscillation()
      }
    } catch (e) {
      console.error("Could not parse multi-level OSCILLATE command.", e)
    }
  } else if (singleOscillateMatch && singleOscillateMatch[1]) {
    const intensity = Number.parseInt(singleOscillateMatch[1], 10)
    if (!isNaN(intensity) && intensity >= 0 && intensity <= 100) {
      $("#oscillate-slider").val(intensity).trigger("input")
      try {
        await device.oscillate(intensity / 100)
        updateStatus(`Oscillating at ${intensity}%`)
      } catch (e) {
        // Don't worry about it, some devices don't support this.
      }
    }
  }
}

async function toggleConnection() {
  console.log(`${NAME}: toggleConnection called, client.connected = ${client?.connected}`)
  if (client.connected) {
    console.log(`${NAME}: Calling disconnect...`)
    await disconnect()
    console.log(`${NAME}: disconnect() completed, client.connected = ${client?.connected}`)
  } else {
    console.log(`${NAME}: Calling connect...`)
    try {
      await connect()
      console.log(`${NAME}: connect() completed, client.connected = ${client?.connected}`)
    } catch (e) {
      // Error is already handled in connect(), just prevent uncaught rejection
      console.log(`${NAME}: connect() failed in toggleConnection`)
    }
  }
}

// Re-attach event handlers to the client (needed for reconnection)
function attachDeviceEventHandlers() {
  // Remove any existing handlers to prevent duplicates
  client.removeAllListeners("deviceadded")
  client.removeAllListeners("deviceremoved")

// Wrap device event handlers with logging
client.on("deviceadded", (newDevice) => {
console.log(`${NAME}: Device added event - ${newDevice.name} (index: ${newDevice.index}, scanning: ${isScanningForDevices})`)
handleDeviceAdded(newDevice)
})
  client.on("deviceremoved", (removedDevice) => {
    console.log(`${NAME}: Device removed event - ${removedDevice.name} (index: ${removedDevice.index})`)
    handleDeviceRemoved(removedDevice)
  })

  console.log(`${NAME}: Device event handlers attached`)
}

// Flag to track if we're currently scanning
let isScanningForDevices = false

// Stop all device actions immediately
async function stopAllDeviceActions() {
  try {
    // Update AI status immediately since we're stopping
    updateAIStatusFromActivity()

    if (devices.length === 0) {
      return "No devices connected"
    }

    // IMMEDIATE STOP: Send 0 to all devices right away
    // This stops vibration immediately even if pattern cleanup takes time
    const immediateStopPromises = devices.map(async (dev) => {
      try {
        // Stop all motors immediately
        const motorCount = getMotorCount(dev)
        for (let i = 0; i < motorCount; i++) {
          try {
            await dev.vibrate(0, i)
          } catch (e) {
            // Try scalar fallback
            try {
              const vibrateAttributes = dev.vibrateAttributes
              if (vibrateAttributes && vibrateAttributes[i]) {
                const scalarCommand = new buttplug.ScalarSubcommand(vibrateAttributes[i].Index, 0, "Vibrate")
                await dev.scalar(scalarCommand)
              }
            } catch (scalarErr) {
              // Ignore
            }
          }
        }
      } catch (e) {
        // Ignore device errors
      }
    })
    
    // Wait for immediate stop with timeout
    await Promise.race([
      Promise.all(immediateStopPromises),
      new Promise(resolve => setTimeout(resolve, 500))
    ])

    // Clear all intervals
    if (strokerIntervalId) {
      clearWorkerTimeout(strokerIntervalId)
      strokerIntervalId = null
    }
    if (vibrateIntervalId) {
      clearWorkerTimeout(vibrateIntervalId)
      vibrateIntervalId = null
    }
    if (oscillateIntervalId) {
      clearWorkerTimeout(oscillateIntervalId)
      oscillateIntervalId = null
    }
    isStroking = false

    // Clear all active patterns
    for (const [deviceIndex, active] of activePatterns.entries()) {
      if (active.interval) {
        clearWorkerTimeout(active.interval)
      }
      if (active.stop && typeof active.stop === 'function') {
        try {
          active.stop()
        } catch (e) {
          // Ignore stop errors
        }
      }
    }
    activePatterns.clear()

// Stop all devices - use Promise.all with timeout to prevent hanging
updateStatus("Stopping device...")
const stopPromises = devices.map(async (dev) => {
try {
// Create timeout wrapper for device stop commands
const stopWithTimeout = async (operation, timeout = 2000) => {
return Promise.race([
operation(),
new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeout))
]).catch(() => null) // Return null on timeout/error instead of throwing
}

// Stop vibration - try simple method first, fallback to scalar
await stopWithTimeout(async () => {
try {
await dev.vibrate(0)
} catch (e) {
// Fallback to scalar command
const vibrateAttributes = dev.vibrateAttributes
if (vibrateAttributes && vibrateAttributes.length > 0) {
for (let i = 0; i < vibrateAttributes.length; i++) {
const scalarCommand = new buttplug.ScalarSubcommand(vibrateAttributes[i].Index, 0, "Vibrate")
await dev.scalar(scalarCommand)
await new Promise((resolve) => setTimeout(resolve, 50))
}
}
}
}, 1500)

// Stop oscillation
await stopWithTimeout(async () => {
try {
await dev.oscillate(0)
} catch (e) {
// Ignore - some devices don't support oscillation
}
}, 1000)

return dev.name
} catch (devError) {
console.error(`Failed to stop ${dev.name}:`, devError)
return null
}
})

// Wait for all stop operations with overall timeout
const results = (await Promise.all(stopPromises)).filter(name => name !== null)

// Reset sliders
$(".vibrate-slider").val(0)
$(".motor-slider").val(0)
$("#oscillate-slider").val(0)
$("#intiface-interval-display").text("Interval: N/A")
$("#intiface-oscillate-interval-display").text("Oscillate Interval: N/A")

    updateStatus(`Stopped ${results.length} device(s)`)

    return `Stopped ${results.length} device(s): ${results.join(', ')}`
  } catch (e) {
      
      const errorMsg = `Failed to stop device actions: ${e.message}`
console.error(errorMsg, e)
updateStatus(errorMsg, true)
    return "Stop failed"
  }
}

// Make stopAllDeviceActions available globally for media.js
window.stopAllDeviceActions = stopAllDeviceActions

// Dynamically load the buttplug.js library
function loadScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script")
    script.src = url
    script.onload = resolve
    script.onerror = reject
    document.head.appendChild(script)
  })
}

$(async () => {
  try {
    await loadScript(`/scripts/extensions/third-party/${extensionName}/lib/buttplug.js`)
    // @ts-ignore
    buttplug = window.buttplug

// Initialize timer worker for background vibration (prevents throttling in hidden tabs)
    initTimerWorker()

    // Load global inversion setting
    loadGlobalInvert()

    // Load device polling rate
    loadDevicePollingRate()

    client = new buttplug.ButtplugClient("SillyTavern Intiface Client")

  // Clear any stale device data on initialization
  console.log(`${NAME}: Clearing stale device data on init`)
  devices = []
  device = null
  
  // Ensure any lingering patterns are cleared
  activePatterns.clear()
  if (vibrateIntervalId) {
    clearWorkerTimeout(vibrateIntervalId)
    vibrateIntervalId = null
  }
  if (oscillateIntervalId) {
    clearWorkerTimeout(oscillateIntervalId)
    oscillateIntervalId = null
  }
  if (strokerIntervalId) {
    clearWorkerTimeout(strokerIntervalId)
    strokerIntervalId = null
  }
  
  // Reset media player state
  mediaPlayer.isPlaying = false
  mediaPlayer.currentFunscript = null
  mediaPlayer.videoElement = null
  stopFunscriptSync()

    // Reset UI status
    updateStatus("Disconnected")
    updateButtonStates(false)
    $("#intiface-devices").empty()
    
      console.log(`${NAME}: Initialization cleanup complete`)

    // Connector is now created dynamically in connect()
  // connector = new buttplug.ButtplugBrowserWebsocketClientConnector("ws://127.0.0.1:12345");

    // Initial attachment of event handlers
    attachDeviceEventHandlers()

    const template = await renderExtensionTemplateAsync(`third-party/${extensionName}`, "settings")
    $("#extensions-settings-button").after(template)

    clickHandlerHack()

    $("#intiface-rescan-button").on("click", rescanLastMessage)

// Load saved IP address
const savedIp = localStorage.getItem("intiface-server-ip")
if (savedIp) {
  $("#intiface-ip-input").val(savedIp)
}

// Save IP on change
$("#intiface-ip-input").on("input", function () {
  localStorage.setItem("intiface-server-ip", $(this).val())
})

    // Load and set up auto-connect checkbox
    const savedAutoConnect = localStorage.getItem("intiface-auto-connect")
    if (savedAutoConnect === "true") {
      $("#intiface-auto-connect").prop("checked", true)
    }

    // Save auto-connect on change
    $("#intiface-auto-connect").on("change", function () {
      localStorage.setItem("intiface-auto-connect", $(this).is(":checked"))
      console.log(`${NAME}: Auto-connect set to: ${$(this).is(":checked")}`)
    })

// Load and set up mode settings
const savedModeSettings = localStorage.getItem("intiface-mode-settings")
if (savedModeSettings) {
  try {
    modeSettings = JSON.parse(savedModeSettings)
  } catch (e) {
    console.error(`${NAME}: Failed to parse mode settings`, e)
  }
}

// Load mode intensity multipliers
const savedModeIntensities = localStorage.getItem("intiface-mode-intensities")
if (savedModeIntensities) {
  try {
    const parsed = JSON.parse(savedModeIntensities)
    // Merge with defaults to ensure all modes exist
    modeIntensityMultipliers = { ...modeIntensityMultipliers, ...parsed }
  } catch (e) {
    console.error(`${NAME}: Failed to parse mode intensity settings`, e)
  }
}

// Set mode checkboxes from loaded settings
$("#intiface-mode-denial-domina").prop("checked", modeSettings.denialDomina)
$("#intiface-mode-milk-maid").prop("checked", modeSettings.milkMaid)
$("#intiface-mode-pet-training").prop("checked", modeSettings.petTraining)
$("#intiface-mode-sissy-surrender").prop("checked", modeSettings.sissySurrender)
$("#intiface-mode-prejac-princess").prop("checked", modeSettings.prejacPrincess)
$("#intiface-mode-robotic-ruination").prop("checked", modeSettings.roboticRuination)
$("#intiface-mode-evil-edging-mistress").prop("checked", modeSettings.evilEdgingMistress)
$("#intiface-mode-frustration-fairy").prop("checked", modeSettings.frustrationFairy)
$("#intiface-mode-hypno-helper").prop("checked", modeSettings.hypnoHelper)
$("#intiface-mode-chastity-caretaker").prop("checked", modeSettings.chastityCaretaker)

// Save mode intensity multipliers
const saveModeIntensity = () => {
  localStorage.setItem("intiface-mode-intensities", JSON.stringify(modeIntensityMultipliers))
  console.log(`${NAME}: Mode intensity settings saved`, modeIntensityMultipliers)
}

// Save mode settings on change and refresh UI
    const saveModeSettings = () => {
      modeSettings = {
        denialDomina: $("#intiface-mode-denial-domina").is(":checked"),
        milkMaid: $("#intiface-mode-milk-maid").is(":checked"),
        petTraining: $("#intiface-mode-pet-training").is(":checked"),
        sissySurrender: $("#intiface-mode-sissy-surrender").is(":checked"),
        prejacPrincess: $("#intiface-mode-prejac-princess").is(":checked"),
        roboticRuination: $("#intiface-mode-robotic-ruination").is(":checked"),
        evilEdgingMistress: $("#intiface-mode-evil-edging-mistress").is(":checked"),
        frustrationFairy: $("#intiface-mode-frustration-fairy").is(":checked"),
        hypnoHelper: $("#intiface-mode-hypno-helper").is(":checked"),
        chastityCaretaker: $("#intiface-mode-chastity-caretaker").is(":checked")
      }
      localStorage.setItem("intiface-mode-settings", JSON.stringify(modeSettings))
      console.log(`${NAME}: Mode settings saved`, modeSettings)
      // Refresh device display to show/hide buttons
      devices.forEach(device => handleDeviceAdded(device))
    }

    $("#intiface-mode-denial-domina").on("change", saveModeSettings)
    $("#intiface-mode-milk-maid").on("change", saveModeSettings)
    $("#intiface-mode-pet-training").on("change", saveModeSettings)
    $("#intiface-mode-sissy-surrender").on("change", saveModeSettings)
    $("#intiface-mode-prejac-princess").on("change", saveModeSettings)
    $("#intiface-mode-robotic-ruination").on("change", saveModeSettings)
    $("#intiface-mode-evil-edging-mistress").on("change", saveModeSettings)
    $("#intiface-mode-frustration-fairy").on("change", saveModeSettings)
$("#intiface-mode-hypno-helper").on("change", saveModeSettings)
$("#intiface-mode-chastity-caretaker").on("change", saveModeSettings)

// Set up mode intensity sliders from loaded values
$("#intiface-mode-intensity-denial").val(Math.round(modeIntensityMultipliers.denialDomina * 100))
$("#intiface-mode-intensity-denial-display").text(`${Math.round(modeIntensityMultipliers.denialDomina * 100)}%`)
$("#intiface-mode-intensity-milk").val(Math.round(modeIntensityMultipliers.milkMaid * 100))
$("#intiface-mode-intensity-milk-display").text(`${Math.round(modeIntensityMultipliers.milkMaid * 100)}%`)
$("#intiface-mode-intensity-pet").val(Math.round(modeIntensityMultipliers.petTraining * 100))
$("#intiface-mode-intensity-pet-display").text(`${Math.round(modeIntensityMultipliers.petTraining * 100)}%`)
$("#intiface-mode-intensity-sissy").val(Math.round(modeIntensityMultipliers.sissySurrender * 100))
$("#intiface-mode-intensity-sissy-display").text(`${Math.round(modeIntensityMultipliers.sissySurrender * 100)}%`)
$("#intiface-mode-intensity-prejac").val(Math.round(modeIntensityMultipliers.prejacPrincess * 100))
$("#intiface-mode-intensity-prejac-display").text(`${Math.round(modeIntensityMultipliers.prejacPrincess * 100)}%`)
$("#intiface-mode-intensity-robotic").val(Math.round(modeIntensityMultipliers.roboticRuination * 100))
$("#intiface-mode-intensity-robotic-display").text(`${Math.round(modeIntensityMultipliers.roboticRuination * 100)}%`)
$("#intiface-mode-intensity-evil").val(Math.round(modeIntensityMultipliers.evilEdgingMistress * 100))
$("#intiface-mode-intensity-evil-display").text(`${Math.round(modeIntensityMultipliers.evilEdgingMistress * 100)}%`)
$("#intiface-mode-intensity-frustration").val(Math.round(modeIntensityMultipliers.frustrationFairy * 100))
$("#intiface-mode-intensity-frustration-display").text(`${Math.round(modeIntensityMultipliers.frustrationFairy * 100)}%`)
$("#intiface-mode-intensity-hypno").val(Math.round(modeIntensityMultipliers.hypnoHelper * 100))
$("#intiface-mode-intensity-hypno-display").text(`${Math.round(modeIntensityMultipliers.hypnoHelper * 100)}%`)
$("#intiface-mode-intensity-chastity").val(Math.round(modeIntensityMultipliers.chastityCaretaker * 100))
$("#intiface-mode-intensity-chastity-display").text(`${Math.round(modeIntensityMultipliers.chastityCaretaker * 100)}%`)

// Handle mode intensity slider changes
$("#intiface-mode-intensity-denial").on("input", function() {
  const val = parseInt($(this).val())
  modeIntensityMultipliers.denialDomina = val / 100
  $("#intiface-mode-intensity-denial-display").text(`${val}%`)
  saveModeIntensity()
})
$("#intiface-mode-intensity-milk").on("input", function() {
  const val = parseInt($(this).val())
  modeIntensityMultipliers.milkMaid = val / 100
  $("#intiface-mode-intensity-milk-display").text(`${val}%`)
  saveModeIntensity()
})
$("#intiface-mode-intensity-pet").on("input", function() {
  const val = parseInt($(this).val())
  modeIntensityMultipliers.petTraining = val / 100
  $("#intiface-mode-intensity-pet-display").text(`${val}%`)
  saveModeIntensity()
})
$("#intiface-mode-intensity-sissy").on("input", function() {
  const val = parseInt($(this).val())
  modeIntensityMultipliers.sissySurrender = val / 100
  $("#intiface-mode-intensity-sissy-display").text(`${val}%`)
  saveModeIntensity()
})
$("#intiface-mode-intensity-prejac").on("input", function() {
  const val = parseInt($(this).val())
  modeIntensityMultipliers.prejacPrincess = val / 100
  $("#intiface-mode-intensity-prejac-display").text(`${val}%`)
  saveModeIntensity()
})
$("#intiface-mode-intensity-robotic").on("input", function() {
  const val = parseInt($(this).val())
  modeIntensityMultipliers.roboticRuination = val / 100
  $("#intiface-mode-intensity-robotic-display").text(`${val}%`)
  saveModeIntensity()
})
$("#intiface-mode-intensity-evil").on("input", function() {
  const val = parseInt($(this).val())
  modeIntensityMultipliers.evilEdgingMistress = val / 100
  $("#intiface-mode-intensity-evil-display").text(`${val}%`)
  saveModeIntensity()
})
$("#intiface-mode-intensity-frustration").on("input", function() {
  const val = parseInt($(this).val())
  modeIntensityMultipliers.frustrationFairy = val / 100
  $("#intiface-mode-intensity-frustration-display").text(`${val}%`)
  saveModeIntensity()
})
$("#intiface-mode-intensity-hypno").on("input", function() {
  const val = parseInt($(this).val())
  modeIntensityMultipliers.hypnoHelper = val / 100
  $("#intiface-mode-intensity-hypno-display").text(`${val}%`)
  saveModeIntensity()
})
$("#intiface-mode-intensity-chastity").on("input", function() {
  const val = parseInt($(this).val())
  modeIntensityMultipliers.chastityCaretaker = val / 100
  $("#intiface-mode-intensity-chastity-display").text(`${val}%`)
  saveModeIntensity()
})

// ==========================================
// PLAY MODE - UNIFIED PATTERN SYSTEM
// ==========================================

// Current pattern category
let currentPatternCategory = 'basic'

// Timeline Sequencer - multi-track pattern editor
let timelineBlocks = [] // Array of { id, patternName, category, channel, startTime, duration }
let timelineBlockIdCounter = 0
let timelineSelectedPattern = null // Currently selected pattern from palette
let timelinePlaybackStartTime = 0
let timelinePlaybackTimer = null
let timelineCurrentPosition = 0 // Current playback position in ms
const TIMELINE_MIN_DURATION = 30000 // Minimum 30 seconds
const TIMELINE_PADDING_MULTIPLIER = 2.0 // Double the content duration (100% extra space)

// Calculate dynamic timeline duration based on blocks (with padding for visual editing)
function getTimelineDuration() {
  if (timelineBlocks.length === 0) {
    return TIMELINE_MIN_DURATION
  }

  // Find the end time of the last block
  const lastEndTime = Math.max(...timelineBlocks.map(b => b.startTime + b.duration))
  // Add 100% extra space (double the content duration)
  const dynamicDuration = lastEndTime * TIMELINE_PADDING_MULTIPLIER

  return Math.max(TIMELINE_MIN_DURATION, dynamicDuration)
}

// Get the actual content duration (longest pattern end time) without padding
// This is used for playback slider max and funscript export
function getContentDuration() {
  if (timelineBlocks.length === 0) {
    return 0
  }

  // Find the end time of the last block (actual content end, no padding)
  const lastEndTime = Math.max(...timelineBlocks.map(b => b.startTime + b.duration))
  
  return lastEndTime
}

// Format milliseconds to mm:ss for timeline display
function formatTimelineTime(ms) {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

// Format duration in ms to compact string (e.g., "5s", "1m05s", "30m00s")
function formatDurationShort(ms) {
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) {
    return `${totalSeconds}s`
  }
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m${seconds.toString().padStart(2, '0')}s`
}

let timelineIsDragging = false
let timelineDragBlock = null
let timelineDragStartX = 0
let timelineDragStartTime = 0
let timelineSequenceTimeouts = new Set() // Track timeouts for cleanup

// Play Mode settings (which modes are enabled)
let playModeSettings = {
denial: true,
milking: true,
training: true,
robotic: true,
sissy: true,
prejac: true,
evil: true,
frustration: true,
hypno: true,
chastity: true
}

// Load play mode settings
const savedPlayModeSettings = localStorage.getItem('intiface-playmode-settings')
if (savedPlayModeSettings) {
  try {
    const parsed = JSON.parse(savedPlayModeSettings)
    playModeSettings = { ...playModeSettings, ...parsed }
  } catch (e) {
    console.error(`${NAME}: Failed to parse play mode settings`, e)
  }
}

// Sync category-based playModeSettings to PlayModeLoader (which uses mode IDs)
// This ensures modes enabled in UI are actually recognized by the pattern system
function syncPlayModeSettingsToLoader() {
  const categoryToModeId = {
    denial: 'denial_domina',
    milking: 'milk_maid',
    training: 'pet_training',
    robotic: 'robotic_ruination',
    sissy: 'sissy_surrender',
    prejac: 'prejac_princess',
    evil: 'evil_edging_mistress',
    frustration: 'frustration_fairy',
    hypno: 'hypno_helper',
    chastity: 'chastity_caretaker'
  }
  
  // Only sync if PlayModeLoader is ready
  if (!PlayModeLoader || !PlayModeLoader.settings) return
  
  for (const [category, enabled] of Object.entries(playModeSettings)) {
    const modeId = categoryToModeId[category]
    if (modeId && PlayModeLoader.settings[modeId]) {
      PlayModeLoader.settings[modeId].enabled = enabled
    }
  }
  PlayModeLoader.saveSettings()
}

// Sync PlayModeLoader settings back to category-based playModeSettings
function syncLoaderToPlayModeSettings() {
  const modeIdToCategory = {
    denial_domina: 'denial',
    milk_maid: 'milking',
    pet_training: 'training',
    robotic_ruination: 'robotic',
    sissy_surrender: 'sissy',
    prejac_princess: 'prejac',
    evil_edging_mistress: 'evil',
    frustration_fairy: 'frustration',
    hypno_helper: 'hypno',
    chastity_caretaker: 'chastity'
  }
  
  // Only sync if PlayModeLoader is ready
  if (!PlayModeLoader || !PlayModeLoader.settings) return
  
  for (const [modeId, modeSettings] of Object.entries(PlayModeLoader.settings)) {
    const category = modeIdToCategory[modeId]
    if (category && typeof modeSettings.enabled === 'boolean') {
      playModeSettings[category] = modeSettings.enabled
    }
  }
}

// Populate pattern buttons based on device type and category
// Waveform patterns organized by category
const WaveformPatternsByCategory = {
basic: ['sine', 'sawtooth', 'square', 'triangle', 'pulse', 'random', 'ramp_up', 'ramp_down'],
denial: ['heartbeat', 'tickle', 'edging', 'ruin', 'teasing', 'desperation', 'mercy', 'tease_escalate', 'stop_start', 'random_tease', 'micro_tease', 'abrupt_edge', 'build_and_ruin', 'held_edge', 'flutter'],
milking: ['crescendo', 'tidal_wave', 'milking_pump', 'relentless', 'overload', 'forced_peak', 'spiral_up', 'tsunami'],
training: ['rapid_micro', 'peak_and_drop', 'ghost_tease', 'erratic'],
robotic: ['mechanical', 'algorithm', 'systematic_ruin', 'cold_calculation'],
evil: ['forbidden_peaks', 'multiple_peaks', 'intense_waves', 'ripple_thruster', 'rapid_fire', 'evil_ripple', 'cruel_sine', 'torture_pulse', 'wicked_build', 'malicious_flicker', 'sadistic_hold', 'torment_wave', 'vindictive_spikes'],
frustration: ['fairy_dust', 'impish_flutter', 'maddening_tickle', 'phantom_touch', 'frustrating_flutter', 'unbearable_lightness', 'teasing_whisper', 'maddening_ripples', 'infuriating_flicker'],
hypno: ['hypno_wave', 'trance_rhythm', 'sleepy_spiral', 'hypnotic_pulse', 'dreamy_flow', 'entrancement_zone', 'sleepy_build', 'trance_oscillation', 'hypnotic_drift', 'edge_trance'],
chastity: ['gentle_checkup', 'caring_tap', 'tender_flutter', 'nurturing_pulse', 'cage_nurse', 'gentle_denial', 'tender_torment', 'loving_check', 'caretaker_hums', 'sweet_frustration', 'daily_routine'],
sissy: ['sine', 'triangle', 'gentle', 'wave', 'flutter', 'teasing'],
prejac: ['rapid_micro', 'rapid_fire', 'flutter', 'sine', 'pulse']
}

    populatePatternButtons = function(deviceType = 'general') {
        const container = $('#intiface-pattern-buttons')
        container.empty()

        // Check if PlayModeLoader is initialized
        if (!PlayModeLoader || typeof PlayModeLoader.getEnabledSequences !== 'function') {
            container.html('<div style="color: #666; font-size: 0.8em; width: 100%; text-align: center; padding: 20px;">Loading modes...</div>')
            return
        }

        // Get presets for current category
        let presets = {}

        if (currentPatternCategory === 'basic') {
            // Basic category: show basic presets + basic waveform patterns
            presets = {
                warmup: PatternLibrary.presets.warmup,
                tease: PatternLibrary.presets.tease,
                pulse: PatternLibrary.presets.pulse,
                edge: PatternLibrary.presets.edge
            }
    // Add basic waveform patterns (only in basic category)
            const basicPatterns = ['sine', 'sawtooth', 'square', 'triangle', 'random', 'ramp_up', 'ramp_down']
            basicPatterns.forEach(patternName => {
                presets[patternName] = {
                    type: 'waveform',
                    pattern: patternName,
                    min: 20,
                    max: 80,
                    duration: 5000,
                    cycles: 3,
                    compatibleDevices: ['general', 'cage', 'plug', 'stroker']
                }
            })
        } else {
            // Other categories: only show category-specific patterns and sequences
            // Map category to mode ID
            const categoryToModeId = {
                'denial': 'denial_domina',
                'milking': 'milk_maid',
                'training': 'pet_training',
                'robotic': 'robotic_ruination',
                'sissy': 'sissy_surrender',
                'prejac': 'prejac_princess',
                'evil': 'evil_edging_mistress',
                'frustration': 'frustration_fairy',
                'hypno': 'hypno_helper',
                'chastity': 'chastity_caretaker'
            }
            
            const modeId = categoryToModeId[currentPatternCategory]
            
            if (modeId && PlayModeLoader.sequences[modeId]) {
                // Add sequences from this mode
                const modeSequences = PlayModeLoader.sequences[modeId]
                for (const [seqName, seqData] of Object.entries(modeSequences)) {
                    presets[seqName] = {
                        type: 'sequence',
                        sequence: seqData.steps,
                        repeat: seqData.repeat !== false,
                        description: seqData.description || seqName,
                        compatibleDevices: seqData.compatibleDevices || ['general', 'cage', 'plug', 'stroker']
                    }
                }
            }
            
            // Add category-specific waveform patterns (NOT basic patterns)
            if (modeId && PlayModeLoader.patterns[modeId]) {
                const modePatterns = PlayModeLoader.patterns[modeId]
                Object.entries(modePatterns).forEach(([patternName, patternFunc]) => {
                    presets[patternName] = {
                        type: 'waveform',
                        pattern: patternName,
                        min: 20,
                        max: 80,
                        duration: 5000,
                        cycles: 3,
                        compatibleDevices: ['general', 'cage', 'plug', 'stroker']
                    }
                })
            }
        }

        // Create buttons for each preset
        Object.entries(presets).forEach(([key, preset]) => {
            const isCompatible = preset.compatibleDevices ?
                preset.compatibleDevices.includes(deviceType) || preset.compatibleDevices.includes('general') :
                true

            const displayName = key.replace(/_/g, ' ')

            const btnHtml = `
                <button class="menu_button pattern-btn" data-pattern="${key}" data-category="${currentPatternCategory}"
                    title="${displayName} - Click to add to scene"
                    style="padding: 6px 12px; font-size: 0.75em; border-radius: 4px; ${!isCompatible ? 'opacity: 0.5; cursor: not-allowed;' : ''}">
                    ${displayName}
                </button>
            `
            const btn = $(btnHtml)

            if (isCompatible) {
                btn.on('click', () => {
                    selectPatternForTimeline(key, currentPatternCategory)
                })
            }

            container.append(btn)
        })

        if (Object.keys(presets).length === 0) {
            container.html('<div style="color: #666; font-size: 0.8em; width: 100%; text-align: center; padding: 20px;">No patterns available for this category</div>')
        }
    }

// Execute a Play Mode sequence
executePlayModeSequence = async function(deviceIndex, modePreset) {
  const targetDevice = devices[deviceIndex]
  if (!targetDevice) return

  await stopDevicePattern(deviceIndex)

  const { sequence, repeat } = modePreset
  let currentStep = 0
  let sequenceTimeoutId = null

  async function playStep() {
      if (currentStep >= sequence.length) {
        if (repeat) {
          currentStep = 0
        } else {
          // Clean up timeout tracking when sequence ends
          if (sequenceTimeoutId !== null) {
            timelineSequenceTimeouts.delete(sequenceTimeoutId)
          }
          return
        }
      }

    const step = sequence[currentStep]
    await executePatternStep(deviceIndex, step)
    currentStep++

    if (currentStep < sequence.length || repeat) {
      sequenceTimeoutId = setTimeout(playStep, step.duration + (step.pause || 0))
      timelineSequenceTimeouts.add(sequenceTimeoutId)
    } else {
      // Clean up timeout tracking when sequence ends
      if (sequenceTimeoutId !== null) {
        timelineSequenceTimeouts.delete(sequenceTimeoutId)
      }
    }
  }

  playStep()
}

// Execute a single pattern step
  executePatternStep = async function(deviceIndex, step) {
    const patternFunc = PlayModeLoader.getPattern(step.pattern)
    if (!patternFunc) return
    
    const steps = Math.floor(step.duration / 100)
    const values = []
    
    for (let i = 0; i < steps; i++) {
        const phase = i / steps
        const intensity = step.min + (step.max - step.min) * patternFunc(phase, 1)
        values.push(Math.round(intensity))
    }
    
    const scaledValues = applyIntensityScale(values)
    const invertedValues = scaledValues.map(v => applyInversion(v))
    
    const patternData = {
        pattern: invertedValues,
        intervals: Array(steps).fill(100),
        loop: 1
    }
    
    await executePattern(patternData, 'vibrate', deviceIndex)
}

// ==========================================
// TIMELINE SEQUENCER - Multi-track pattern editor
// ==========================================

// Get default values for any pattern (waveform or mode)
function getPatternDefaults(patternName, category) {
  // Check if it's a waveform pattern
  if (PlayModeLoader.hasPattern(patternName)) {
    return {
      min: 20,
      max: 80,
      duration: 5000,
      cycles: 3
    }
  }

  // Check if it's a sequence from PlayModeLoader
  const enabledSequences = PlayModeLoader.getEnabledSequences()
  for (const [modeId, modeData] of Object.entries(enabledSequences)) {
    if (modeData.mode && modeData.mode.category === category) {
      const sequence = modeData.sequences[patternName]
      if (sequence && sequence.steps && sequence.steps.length > 0) {
        // Calculate total duration and average min/max from sequence
        let totalDuration = 0
        let totalMin = 0, totalMax = 0
        sequence.steps.forEach(step => {
          totalDuration += step.duration || 5000
          totalMin += step.min || 20
          totalMax += step.max || 80
        })
        const avgMin = Math.round(totalMin / sequence.steps.length)
        const avgMax = Math.round(totalMax / sequence.steps.length)
        return {
          min: avgMin,
          max: avgMax,
          duration: totalDuration, // One complete cycle duration
          cycles: 1 // Always default to 1 cycle for auto-scaling
        }
      }
    }
  }

  // Basic patterns
  if (category === 'basic') {
    const basicPresets = {
      warmup: { min: 10, max: 30, duration: 5000, cycles: 3 },
      tease: { min: 20, max: 60, duration: 8000, cycles: 4 },
      pulse: { min: 30, max: 70, duration: 4000, cycles: 8 },
      edge: { min: 10, max: 90, duration: 12000, cycles: 2 }
    }
    if (basicPresets[patternName]) {
      return basicPresets[patternName]
    }
  }

  // Default fallback
  return { min: 20, max: 80, duration: 5000, cycles: 3 }
}

// Select a pattern from the palette (click to select, then click timeline to place)
function selectPatternForTimeline(patternName, category) {
  // Get pattern defaults first
  const defaults = getPatternDefaults(patternName, category)
  
  timelineSelectedPattern = {
    patternName,
    category,
    defaultDuration: defaults.duration, // Store for cycle calculation
    defaultCycles: defaults.cycles // Store for multiplicative scaling
  }

  // Show selected pattern indicator
  const displayName = patternName.replace(/_/g, ' ')
  const categoryLabel = category.charAt(0).toUpperCase() + category.slice(1)
  $('#intiface-timeline-selected').show()
  $('#intiface-timeline-selected-text').text(`Click on Channel A, B, C, or D track to place "${displayName}" (${categoryLabel})`)

  // Highlight pattern buttons
  $('.pattern-btn').css('opacity', '0.5')
  $(`.pattern-btn[data-pattern="${patternName}"]`).css('opacity', '1')

  // Update sliders with defaults
  $('#intiface-pattern-duration').val(defaults.duration)
  $('#intiface-pattern-duration-display').text(formatDurationShort(defaults.duration))
  $('#intiface-pattern-min').val(defaults.min)
  $('#intiface-pattern-min-display').text(`${defaults.min}%`)
  $('#intiface-pattern-max').val(defaults.max)
  $('#intiface-pattern-max-display').text(`${defaults.max}%`)
  $('#intiface-pattern-cycles').val(defaults.cycles)
  $('#intiface-pattern-cycles-display').text(defaults.cycles)

  updateStatus(`Selected: ${displayName} - Click timeline track to place (${(defaults.duration/1000).toFixed(1)}s)`)
}

// Add pattern block to timeline
function addTimelineBlock(channel, startTime, motor = 1) {
if (!timelineSelectedPattern) {
updateStatus('Select a pattern first, then click timeline track')
return
}

// Get duration from slider (user-adjustable)
const sliderDuration = parseInt($('#intiface-pattern-duration').val()) || 5000

// Get intensity and cycles from sliders
const sliderMin = parseInt($('#intiface-pattern-min').val()) || 20
const sliderMax = parseInt($('#intiface-pattern-max').val()) || 80
const sliderCycles = parseInt($('#intiface-pattern-cycles').val()) || 3

  timelineBlockIdCounter++
  const block = {
    id: timelineBlockIdCounter,
    patternName: timelineSelectedPattern.patternName,
    category: timelineSelectedPattern.category,
    channel: channel,
    motor: motor,
    startTime: startTime,
    duration: sliderDuration, // Use slider value as default
    min: sliderMin,
    max: sliderMax,
    cycles: sliderCycles
  }
  
  // The slider value is already set as block.duration (line 6846)
  // We don't override it with calculated duration - user adjustment takes precedence
  // Pattern sequences will be scaled/adapted to fit the user-selected duration during playback
  
  timelineBlocks.push(block)
  renderTimeline()
  
  const displayName = block.patternName.replace(/_/g, ' ')
  const motorText = motor > 1 ? ` (M${motor})` : ''
  updateStatus(`Added "${displayName}" to Channel ${channel}${motorText} at ${formatTimelineTime(startTime)}`)

// Clear selection
// timelineSelectedPattern = null
// $('#intiface-timeline-selected').hide()
// $('.pattern-btn').css('opacity', '1')
}

// Remove block from timeline
function removeTimelineBlock(id) {
timelineBlocks = timelineBlocks.filter(block => block.id !== id)
renderTimeline()
}

// Clear all timeline blocks
async function clearTimeline() {
  // Stop playback if running
  if (mediaPlayer.isPlaying) {
    await stopTimeline()
  }
  
  // Clear ALL timeline-related state
  timelineBlocks = []
  timelineBlockIdCounter = 0
  timelineCurrentPosition = 0
  clearInterval(timelinePlaybackTimer)
  timelinePlaybackTimer = null
  
  // Clear funscript data to prevent stale state
  mediaPlayer.currentFunscript = null
  mediaPlayer.channelFunscripts = {}
  
  $('#intiface-timeline-scrubber').val(0)
  $('#intiface-timeline-current-time').text('0:00')
  renderTimeline()
  updateStatus('Timeline cleared')
}

// Get motor count for a channel (returns 1 if multi-motor not enabled)
function getChannelMotorCount(channel) {
  const channelLower = channel.toLowerCase()
  const checkbox = $(`#channel-${channelLower}-multi-motor`)
  const input = $(`#channel-${channelLower}-motor-count`)
  
  if (checkbox.is(':checked')) {
    const count = parseInt(input.val()) || 2
    return Math.max(1, Math.min(8, count))
  }
  
  return 1
}

// Category colors for timeline blocks (matching the UI theme)
const categoryColors = {
  basic: { bg: 'rgba(100,100,100,0.6)', border: 'rgba(150,150,150,0.8)' },
  denial: { bg: 'rgba(255,100,100,0.6)', border: 'rgba(255,100,100,0.8)' },
  milking: { bg: 'rgba(100,255,100,0.6)', border: 'rgba(100,255,100,0.8)' },
  training: { bg: 'rgba(100,100,255,0.6)', border: 'rgba(100,100,255,0.8)' },
  robotic: { bg: 'rgba(255,0,255,0.6)', border: 'rgba(255,0,255,0.8)' },
  sissy: { bg: 'rgba(255,100,200,0.6)', border: 'rgba(255,100,200,0.8)' },
  prejac: { bg: 'rgba(0,255,255,0.6)', border: 'rgba(0,255,255,0.8)' },
  evil: { bg: 'rgba(191,0,255,0.6)', border: 'rgba(191,0,255,0.8)' },
  frustration: { bg: 'rgba(255,255,0,0.6)', border: 'rgba(255,255,0,0.8)' },
  hypno: { bg: 'rgba(221,160,221,0.6)', border: 'rgba(221,160,221,0.8)' },
  chastity: { bg: 'rgba(255,192,203,0.6)', border: 'rgba(255,192,203,0.8)' }
}

// Render timeline blocks
function renderTimeline() {
  // Clear existing blocks
  $('.timeline-block').remove()

  // Get both durations: visual (padded) and content (actual)
  const visualDuration = getTimelineDuration()
  const contentDuration = getContentDuration()
  
  // Debug logging
  console.log(`${NAME}: renderTimeline - visualDuration: ${visualDuration}ms (${formatDurationShort(visualDuration)}), contentDuration: ${contentDuration}ms (${formatDurationShort(contentDuration)})`)
  timelineBlocks.forEach((b, i) => {
    console.log(`${NAME}: Block ${i}: startTime=${b.startTime}ms, duration=${b.duration}ms, endTime=${b.startTime + b.duration}ms`)
  })
  
  // Set scrubber max to content duration (not padded visual duration)
  // This ensures playback stops at the actual end of patterns, not the padded end
  $('#intiface-timeline-scrubber').attr('max', contentDuration)

  // Update end time label to show actual content end time
  const totalSeconds = Math.floor(contentDuration / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes > 0) {
    $('#intiface-timeline-end-time').text(`${minutes}m ${seconds}s`)
  } else {
    $('#intiface-timeline-end-time').text(`${seconds}s`)
  }

  // Update scale markers (0%, 25%, 50%, 75%, 100%) using visual (padded) duration
  // This keeps the timeline visually usable for editing with extra space
  const scalePositions = [0, 0.25, 0.5, 0.75, 1.0]
  scalePositions.forEach((pos, index) => {
    const timeMs = Math.round(visualDuration * pos)
    const timeSec = Math.floor(timeMs / 1000)
    const timeMin = Math.floor(timeSec / 60)
    const timeRem = timeSec % 60
    const timeLabel = timeMin > 0 ? `${timeMin}:${timeRem.toString().padStart(2, '0')}` : `${timeSec}s`
    $(`#timeline-scale-${index}`).text(timeLabel)
  })

  // Render blocks on each track
  // Use visual duration (padded) for positioning so blocks appear in correct visual positions
  timelineBlocks.forEach(block => {
    const displayName = block.patternName.replace(/_/g, ' ')
    const leftPercent = (block.startTime / visualDuration) * 100
    const widthPercent = (block.duration / visualDuration) * 100

    // Use full display name - CSS will handle overflow with ellipsis
    const truncatedName = displayName
    
    // Get color based on category
    const colors = categoryColors[block.category] || categoryColors.basic

    const blockHtml = `
    <div class="timeline-block" data-id="${block.id}"
      style="position: absolute; top: 2px; left: ${leftPercent}%; width: ${widthPercent}%;
             height: calc(100% - 4px); background: ${colors.bg}; border: 1px solid ${colors.border};
             border-radius: 2px; cursor: move; display: flex; align-items: center; justify-content: center;
             font-size: 0.65em; color: #fff; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; padding: 0 4px; user-select: none;"
      title="${displayName} (${block.category}) - Click and drag to move, right-click to delete">
      ${truncatedName}
    </div>
    `

    $(`.timeline-track-lane[data-channel="${block.channel}"][data-motor="${block.motor || 1}"]`).append(blockHtml)
})

// Attach event handlers to blocks
$('.timeline-block').on('mousedown', function(e) {
if (e.button === 2) return // Right click
const id = parseInt($(this).data('id'))
startDraggingBlock(id, e)
})

$('.timeline-block').on('contextmenu', function(e) {
e.preventDefault()
const id = parseInt($(this).data('id'))
removeTimelineBlock(id)
})
}

// Dragging logic
function startDraggingBlock(id, e) {
timelineIsDragging = true
timelineDragBlock = timelineBlocks.find(b => b.id === id)
timelineDragStartX = e.pageX

const lane = $(e.target).closest('.timeline-track-lane')[0]
if (lane) {
const rect = lane.getBoundingClientRect()
timelineDragStartTime = timelineDragBlock.startTime

// Mouse move handler
const onMouseMove = (e) => {
if (!timelineIsDragging || !timelineDragBlock) return

const deltaX = e.pageX - timelineDragStartX
const laneWidth = rect.width
const deltaTime = (deltaX / laneWidth) * getTimelineDuration()

let newTime = timelineDragStartTime + deltaTime
newTime = Math.max(0, Math.min(newTime, getTimelineDuration() - timelineDragBlock.duration))

timelineDragBlock.startTime = Math.round(newTime)
renderTimeline()
}

// Mouse up handler
const onMouseUp = () => {
timelineIsDragging = false
timelineDragBlock = null
$(document).off('mousemove', onMouseMove)
$(document).off('mouseup', onMouseUp)
}

$(document).on('mousemove', onMouseMove)
$(document).on('mouseup', onMouseUp)
}
}

// Convert timeline blocks to funscript format for unified playback
// Each channel gets its own funscript with actions at the appropriate times
function convertTimelineToFunscripts() {
  const channelFunscripts = {}
  const channels = ['A', 'B', 'C', 'D', '-']
  
  // Initialize funscripts for each channel
  // Use content duration (not padded) for funscript metadata
  const contentDuration = getContentDuration()
  channels.forEach(channel => {
    channelFunscripts[channel] = {
      actions: [],
      inverted: false,
      metadata: {
        creator: 'Extension-Intiface Timeline',
        description: `Timeline playback for channel ${channel}`,
        duration: contentDuration,
        type: 'funscript'
      }
    }
  })
  
  // Get all blocks sorted by start time
  const sortedBlocks = [...timelineBlocks].sort((a, b) => a.startTime - b.startTime)
  
  // Generate actions for each block
  sortedBlocks.forEach(block => {
    const funscript = channelFunscripts[block.channel]
    if (!funscript) return
    
    // Get motor count for this channel
    const motorCount = getChannelMotorCount(block.channel)
    
    // Generate waveform values for this block
    const steps = Math.floor(block.duration / 100) // 100ms resolution
    const patternFunc = PlayModeLoader.getPattern(block.patternName) || PlayModeLoader.getPattern('sine')
    const cycles = block.cycles || 1
    
    for (let i = 0; i < steps; i++) {
      // Calculate phase across multiple cycles
      // phase goes from 0 to cycles over the duration
      const progress = i / steps
      const phase = (progress * cycles) % 1
      const rawValue = patternFunc(phase, 1) // Get normalized pattern value
      
      // Scale to min/max range
      const min = block.min || 20
      const max = block.max || 80
      const normalizedValue = (rawValue + 1) / 2 // Convert from -1..1 to 0..1
      const pos = Math.round(min + (max - min) * normalizedValue)
      
      // Calculate timestamp
      const at = block.startTime + (i * 100)
      
      if (motorCount > 1) {
        // Multi-motor: generate phase-shifted patterns for each motor
        const positions = []
        for (let motor = 0; motor < motorCount; motor++) {
          const motorPhase = (phase + (motor / motorCount)) % 1
          const motorRawValue = patternFunc(motorPhase, 1)
          const motorNormalized = (motorRawValue + 1) / 2
          const motorPos = Math.round(min + (max - min) * motorNormalized)
          positions.push(Math.min(100, Math.max(0, motorPos)))
        }
        funscript.actions.push({
          at: at,
          pos: positions // Array of positions for each motor
        })
      } else {
        // Single motor: just use single value
        funscript.actions.push({
          at: at,
          pos: Math.min(100, Math.max(0, pos))
        })
      }
    }
  })
  
  // Sort actions by timestamp for each channel
  channels.forEach(channel => {
    channelFunscripts[channel].actions.sort((a, b) => a.at - b.at)
    
    // Calculate actual max action time for this funscript (not the padded timeline duration)
    const actions = channelFunscripts[channel].actions
    if (actions.length > 0) {
      const maxActionTime = actions[actions.length - 1].at
      channelFunscripts[channel].metadata.duration = maxActionTime
    } else {
      channelFunscripts[channel].metadata.duration = 0
    }
  })
  
  return channelFunscripts
}

// Start timeline playback using unified media player system
async function playTimeline() {
  if (timelineBlocks.length === 0) {
    updateStatus('Timeline is empty - add patterns first')
    return
  }

  if (devices.length === 0) {
    updateStatus('No devices connected')
    return
  }

  // Stop any existing playback first
  if (mediaPlayer.isPlaying) {
    await stopMediaPlayback()
  }

  // Convert timeline to funscripts per channel
  const timelineFunscripts = convertTimelineToFunscripts()
  
  // Load funscripts into media player channels
  mediaPlayer.channelFunscripts = {}
  Object.keys(timelineFunscripts).forEach(channel => {
    const funscript = timelineFunscripts[channel]
    if (funscript.actions.length > 0) {
      mediaPlayer.channelFunscripts[channel] = funscript
      console.log(`${NAME}: Loaded timeline funscript for channel ${channel} with ${funscript.actions.length} actions`)
    }
  })
  
  // Use the first available channel as the main funscript
  const availableChannels = Object.keys(mediaPlayer.channelFunscripts)
  if (availableChannels.length > 0) {
    mediaPlayer.currentFunscript = mediaPlayer.channelFunscripts[availableChannels[0]]
  }
  
  // Create a dummy video element for timeline playback (no actual video, just timing)
  if (!mediaPlayer.videoElement) {
    mediaPlayer.videoElement = {
      currentTime: timelineCurrentPosition / 1000,
      paused: false,
      play: function() { this.paused = false },
      pause: function() { this.paused = true },
      addEventListener: function() {},
      removeEventListener: function() {}
    }
  }
  
  // Set up timeline sync loop (simulates video playback)
  timelinePlaybackStartTime = Date.now() - timelineCurrentPosition
  mediaPlayer.isPlaying = true
  
  updateStatus('Playing timeline...')
  
  // Start the unified funscript sync
  startFunscriptSync()
  
  // Start timeline position tracking
  timelinePlaybackTimer = setInterval(() => {
    if (!mediaPlayer.isPlaying) return
    
    timelineCurrentPosition = Date.now() - timelinePlaybackStartTime
    
    // Update video element time for sync
    if (mediaPlayer.videoElement) {
      mediaPlayer.videoElement.currentTime = timelineCurrentPosition / 1000
    }
    
    // Update scrubber
    $('#intiface-timeline-scrubber').val(timelineCurrentPosition)
    $('#intiface-timeline-current-time').text(formatDurationShort(timelineCurrentPosition))
    
    // Stop at end of actual content (not padded visual duration)
    if (timelineCurrentPosition >= getContentDuration()) {
      stopTimeline()
      timelineCurrentPosition = 0
      $('#intiface-timeline-scrubber').val(0)
      $('#intiface-timeline-current-time').text('0:00')
      updateStatus('Timeline playback complete')
    }
  }, 50) // 50ms = 20fps
}

// Pause timeline playback (maintains position)
async function pauseTimeline() {
  console.log(`${NAME}: pauseTimeline called`)

  if (!mediaPlayer.isPlaying) {
    console.log(`${NAME}: Timeline not playing, nothing to pause`)
    return
  }

  // Pause the unified playback
  mediaPlayer.isPlaying = false

  // Clear timeline timer but keep position
  if (timelinePlaybackTimer) {
    clearInterval(timelinePlaybackTimer)
    timelinePlaybackTimer = null
  }
  
  // Stop funscript sync to prevent background execution
  stopFunscriptSync()

  // Stop device actions
  stopAllDeviceActions()

  updateStatus('Timeline paused')
  $('#intiface-timeline-current-time').text(formatDurationShort(timelineCurrentPosition) + ' (paused)')
}

// Resume timeline playback from current position
async function resumeTimeline() {
  console.log(`${NAME}: resumeTimeline called`)

  if (mediaPlayer.isPlaying) {
    console.log(`${NAME}: Timeline already playing`)
    return
  }
  
  // Check if there are actually timeline blocks to play
  if (timelineBlocks.length === 0) {
    console.log(`${NAME}: No timeline blocks to resume`)
    updateStatus('Timeline is empty - add patterns first')
    return
  }

  // Check if we have timeline data loaded
  if (!mediaPlayer.currentFunscript || Object.keys(mediaPlayer.channelFunscripts).length === 0) {
    // No timeline loaded, need to convert blocks again
    const timelineFunscripts = convertTimelineToFunscripts()

    // Load funscripts into media player channels
    mediaPlayer.channelFunscripts = {}
    Object.keys(timelineFunscripts).forEach(channel => {
      const funscript = timelineFunscripts[channel]
      if (funscript.actions.length > 0) {
        mediaPlayer.channelFunscripts[channel] = funscript
      }
    })

    // Use the first available channel as the main funscript
    const availableChannels = Object.keys(mediaPlayer.channelFunscripts)
    if (availableChannels.length > 0) {
      mediaPlayer.currentFunscript = mediaPlayer.channelFunscripts[availableChannels[0]]
    }
  }
  
  // Resume from current position
  timelinePlaybackStartTime = Date.now() - timelineCurrentPosition
  mediaPlayer.isPlaying = true
  
  // Restart the unified funscript sync
  startFunscriptSync()
  
  // Restart timeline position tracking
  timelinePlaybackTimer = setInterval(() => {
    if (!mediaPlayer.isPlaying) return
    
    timelineCurrentPosition = Date.now() - timelinePlaybackStartTime
    
    // Update video element time for sync
    if (mediaPlayer.videoElement) {
      mediaPlayer.videoElement.currentTime = timelineCurrentPosition / 1000
    }
    
    // Update scrubber
    $('#intiface-timeline-scrubber').val(timelineCurrentPosition)
    $('#intiface-timeline-current-time').text(formatDurationShort(timelineCurrentPosition))
    
    // Stop at end of actual content (not padded visual duration)
    if (timelineCurrentPosition >= getContentDuration()) {
      stopTimeline()
      timelineCurrentPosition = 0
      $('#intiface-timeline-scrubber').val(0)
      $('#intiface-timeline-current-time').text('0:00')
      updateStatus('Timeline playback complete')
    }
  }, 50)

  updateStatus('Timeline resumed')
}

// Stop timeline playback using unified system
async function stopTimeline() {
  console.log(`${NAME}: stopTimeline called`)

  // Use unified stop
  stopMediaPlayback()

  // Clear timeline timer
  if (timelinePlaybackTimer) {
    clearInterval(timelinePlaybackTimer)
    timelinePlaybackTimer = null
  }
  
  // Clear funscript data to prevent stale state
  mediaPlayer.currentFunscript = null
  mediaPlayer.channelFunscripts = {}

  // Reset position
  timelineCurrentPosition = 0
  $('#intiface-timeline-scrubber').val(0)
  $('#intiface-timeline-current-time').text('0:00')

  updateStatus('Timeline stopped')
}

// Update timeline from scrubber
function scrubTimeline(value) {
  timelineCurrentPosition = parseInt(value)
  $('#intiface-timeline-current-time').text(formatDurationShort(timelineCurrentPosition))

  if (mediaPlayer.isPlaying) {
    timelinePlaybackStartTime = Date.now() - timelineCurrentPosition
  }
}

// Get pattern duration for display
function getPatternDuration(patternName, category) {
  // Search in PlayModeLoader
  const enabledSequences = PlayModeLoader.getEnabledSequences()
  for (const [modeId, modeData] of Object.entries(enabledSequences)) {
    if (modeData.mode && modeData.mode.category === category) {
      const sequence = modeData.sequences[patternName]
      if (sequence && sequence.steps) {
        return sequence.steps.reduce((sum, step) => sum + step.duration + (step.pause || 0), 0)
      }
    }
  }
  return 5000 // Default 5 seconds
}

// Timeline Sequencer Event Handlers (must be after function definitions)
$(document).ready(async function() {
  // Initialize PlayModeLoader first before any UI setup
  try {
    if (typeof PlayModeLoader !== 'undefined' && PlayModeLoader.init) {
      await PlayModeLoader.init()
      console.log(`${NAME}: PlayModeLoader initialized with ${Object.keys(PlayModeLoader.modes || {}).length} modes`)
      
      // Sync UI settings to PlayModeLoader so enabled modes are recognized
      syncPlayModeSettingsToLoader()
      console.log(`${NAME}: Synced play mode settings to loader`)
    } else {
      console.warn(`${NAME}: PlayModeLoader not available`)
    }
  } catch (e) {
    console.error(`${NAME}: Failed to initialize PlayModeLoader:`, e)
  }
  // Timeline control buttons
  $("#intiface-timeline-play").on("click", async function() {
    console.log(`${NAME}: Timeline play button clicked`)

    // If paused (has data but not playing), resume from current position
    if (!mediaPlayer.isPlaying && Object.keys(mediaPlayer.channelFunscripts || {}).length > 0) {
      resumeTimeline()
    } else if (mediaPlayer.isPlaying) {
      // Already playing - restart from beginning
      await stopTimeline()
      playTimeline()
    } else {
      // Fresh start
      playTimeline()
    }
  })
  $("#intiface-timeline-pause").on("click", async function() {
    console.log(`${NAME}: Pause button clicked`)
    await pauseTimeline()
  })
$("#intiface-timeline-clear").on("click", function() { clearTimeline() })
$("#intiface-timeline-scrubber").on("input", function() {
scrubTimeline($(this).val())
})

// Pattern duration slider
  $("#intiface-pattern-duration").on("input", function() {
    const duration = parseInt($(this).val())
    $("#intiface-pattern-duration-display").text(formatDurationShort(duration))
    
    // Auto-calculate cycles multiplicatively
    if (timelineSelectedPattern && timelineSelectedPattern.defaultDuration && timelineSelectedPattern.defaultCycles) {
      const defaultDuration = timelineSelectedPattern.defaultDuration
      const defaultCycles = timelineSelectedPattern.defaultCycles
      // Multiplicative: cycles = defaultCycles * (duration / defaultDuration)
      // Round to nearest integer, minimum 1
      const cycles = Math.max(1, Math.round(defaultCycles * duration / defaultDuration))
      $("#intiface-pattern-cycles").val(cycles)
      $("#intiface-pattern-cycles-display").text(cycles)
    }
  })

// Channel motor count controls
const channels = ['a', 'b', 'c', 'd']
channels.forEach(channel => {
  const checkbox = $(`#channel-${channel}-multi-motor`)
  const input = $(`#channel-${channel}-motor-count`)
  const channelUpper = channel.toUpperCase()
  
  checkbox.on('change', function() {
    const isChecked = $(this).is(':checked')
    const lanesContainer = $(`.timeline-track-lanes[data-channel="${channelUpper}"]`)
    
    if (isChecked) {
      input.show()
      if (!input.val() || parseInt(input.val()) < 2) {
        input.val(2)
      }
      // Create multiple motor lanes
      updateMotorLanes(channelUpper, parseInt(input.val()) || 2)
    } else {
      input.hide()
      // Revert to single lane
      updateMotorLanes(channelUpper, 1)
    }
  })
  
  input.on('change', function() {
    let val = parseInt($(this).val())
    if (val < 1) val = 1
    if (val > 8) val = 8
    $(this).val(val)
    // Update lanes when motor count changes
    if (checkbox.is(':checked')) {
      updateMotorLanes(channelUpper, val)
    }
  })
})

// Update motor lanes for a channel
function updateMotorLanes(channel, motorCount) {
  const lanesContainer = $(`.timeline-track-lanes[data-channel="${channel}"]`)
  const trackContainer = lanesContainer.closest('.timeline-track-container')
  
  // Get channel color
  const channelColors = {
    'A': '255,100,100',
    'B': '100,255,100',
    'C': '100,100,255',
    'D': '255,0,255'
  }
  const color = channelColors[channel] || '100,100,100'
  
  // Clear existing lanes
  lanesContainer.empty()
  
  // Create lanes for each motor
  for (let i = 1; i <= motorCount; i++) {
    const lane = $(`
      <div class="timeline-track-lane" 
           style="height: ${motorCount === 1 ? '28px' : '24px'}; position: relative; background: rgba(0,0,0,0.2); cursor: pointer; ${i < motorCount ? `border-bottom: 1px solid rgba(${color},0.15);` : ''}"
           data-channel="${channel}" 
           data-motor="${i}">
        ${motorCount > 1 ? `<span style="position: absolute; left: 2px; top: 2px; font-size: 0.5em; color: rgba(${color},0.5);">${i}</span>` : ''}
      </div>
    `)
    lanesContainer.append(lane)
  }
  
  // Re-attach click handlers
  attachLaneClickHandlers()
  
  // Re-render blocks if any exist
  renderTimeline()
}

// Attach click handlers to timeline lanes
function attachLaneClickHandlers() {
  $(document).off('click', '.timeline-track-lane')
  $(document).on('click', '.timeline-track-lane', function(e) {
    if (e.target !== this) return

    const lane = $(this)
    const channel = lane.data('channel')
    const motor = lane.data('motor') || 1

    if (!timelineSelectedPattern) {
      updateStatus('Select a pattern first, then click on a timeline track')
      return
    }

    // Calculate position from click
    const rect = this.getBoundingClientRect()
    const clickX = e.clientX - rect.left
    const laneWidth = rect.width
    const clickPercent = Math.max(0, Math.min(1, clickX / laneWidth))
    const startTime = Math.round(clickPercent * getTimelineDuration())
    
    console.log(`${NAME}: Click on lane - clickX: ${clickX}, laneWidth: ${laneWidth}, clickPercent: ${clickPercent}, startTime: ${startTime}ms, visualDuration: ${getTimelineDuration()}ms`)

    // Add block with motor info
    addTimelineBlock(channel, startTime, motor)
  })
}

  // Pattern intensity range sliders
$("#intiface-pattern-min").on("input", function() {
const min = parseInt($(this).val())
$("#intiface-pattern-min-display").text(`${min}%`)
// Ensure min doesn't exceed max
const max = parseInt($("#intiface-pattern-max").val())
if (min > max) {
$("#intiface-pattern-max").val(min)
$("#intiface-pattern-max-display").text(`${min}%`)
}
})

$("#intiface-pattern-max").on("input", function() {
const max = parseInt($(this).val())
$("#intiface-pattern-max-display").text(`${max}%`)
// Ensure max doesn't go below min
const min = parseInt($("#intiface-pattern-min").val())
if (max < min) {
$("#intiface-pattern-min").val(max)
$("#intiface-pattern-min-display").text(`${max}%`)
}
})

$("#intiface-pattern-cycles").on("input", function() {
const cycles = parseInt($(this).val())
$("#intiface-pattern-cycles-display").text(cycles)
})

  // Initialize all channels with single motor lanes
  try {
    if (typeof updateMotorLanes === 'function') {
      ['A', 'B', 'C', 'D'].forEach(channel => updateMotorLanes(channel, 1))
    }
  } catch (e) {
    console.error(`${NAME}: Error initializing motor lanes:`, e)
  }
  
  // Attach initial lane click handlers
  attachLaneClickHandlers()
})

// Play Mode UI Event Handlers
$(document).on('click', '.playmode-tab', function() {
    const category = $(this).data('category')
    currentPatternCategory = category
    
    $('.playmode-tab').css('background', 'rgba(0,0,0,0.1)')
    $(this).css('background', 'rgba(100,150,255,0.3)')
    
    if (devices.length > 0) {
        const deviceType = getDeviceType(devices[0])
        populatePatternButtons(deviceType)
    } else {
        populatePatternButtons('general')
    }
})

function savePlayModeSettings() {
  playModeSettings = {
    denial: $('#intiface-mode-denial').is(':checked'),
    milking: $('#intiface-mode-milking').is(':checked'),
    training: $('#intiface-mode-training').is(':checked'),
    robotic: $('#intiface-mode-robotic').is(':checked'),
    sissy: $('#intiface-mode-sissy').is(':checked'),
    prejac: $('#intiface-mode-prejac').is(':checked'),
    evil: $('#intiface-mode-evil').is(':checked'),
    frustration: $('#intiface-mode-frustration').is(':checked'),
    hypno: $('#intiface-mode-hypno').is(':checked'),
    chastity: $('#intiface-mode-chastity').is(':checked')
  }
  localStorage.setItem('intiface-playmode-settings', JSON.stringify(playModeSettings))
  console.log(`${NAME}: Play mode settings saved`, playModeSettings)

  // Sync category settings to PlayModeLoader (uses mode IDs)
  syncPlayModeSettingsToLoader()

  // Sync with AI mode settings
  syncPlayModeToAIModes()

  // Update tab visibility based on settings
  updatePlayModeTabVisibility()
}

// Sync Play Mode settings to AI Mode settings (so they control both UI and prompt)
function syncPlayModeToAIModes() {
  modeSettings.denialDomina = playModeSettings.denial
  modeSettings.milkMaid = playModeSettings.milking
  modeSettings.petTraining = playModeSettings.training
  modeSettings.sissySurrender = playModeSettings.sissy
  modeSettings.prejacPrincess = playModeSettings.prejac
  modeSettings.roboticRuination = playModeSettings.robotic
  modeSettings.evilEdgingMistress = playModeSettings.evil
  modeSettings.frustrationFairy = playModeSettings.frustration
  modeSettings.hypnoHelper = playModeSettings.hypno
  modeSettings.chastityCaretaker = playModeSettings.chastity
  
  // Update the AI mode checkboxes to match
  $("#intiface-mode-denial-domina").prop('checked', modeSettings.denialDomina)
  $("#intiface-mode-milk-maid").prop('checked', modeSettings.milkMaid)
  $("#intiface-mode-pet-training").prop('checked', modeSettings.petTraining)
  $("#intiface-mode-sissy-surrender").prop('checked', modeSettings.sissySurrender)
  $("#intiface-mode-prejac-princess").prop('checked', modeSettings.prejacPrincess)
  $("#intiface-mode-robotic-ruination").prop('checked', modeSettings.roboticRuination)
  $("#intiface-mode-evil-edging-mistress").prop('checked', modeSettings.evilEdgingMistress)
  $("#intiface-mode-frustration-fairy").prop('checked', modeSettings.frustrationFairy)
  $("#intiface-mode-hypno-helper").prop('checked', modeSettings.hypnoHelper)
  $("#intiface-mode-chastity-caretaker").prop('checked', modeSettings.chastityCaretaker)
  
  // Save AI mode settings
  localStorage.setItem('intiface-mode-settings', JSON.stringify(modeSettings))
  
  // Trigger prompt update
  if (typeof updatePrompt === 'function') {
    updatePrompt()
  }
  
  console.log(`${NAME}: Synced Play Mode to AI Modes`, modeSettings)
}

// Show/hide tabs based on play mode settings
function updatePlayModeTabVisibility() {
  const tabMap = {
    'denial': '#intiface-tab-denial',
    'milking': '#intiface-tab-milking',
    'training': '#intiface-tab-training',
    'robotic': '#intiface-tab-robotic',
    'sissy': '#intiface-tab-sissy',
    'prejac': '#intiface-tab-prejac',
    'evil': '#intiface-tab-evil',
    'frustration': '#intiface-tab-frustration',
    'hypno': '#intiface-tab-hypno',
    'chastity': '#intiface-tab-chastity'
  }
  
  Object.entries(playModeSettings).forEach(([mode, enabled]) => {
    const tabSelector = tabMap[mode]
    if (tabSelector) {
      if (enabled) {
        $(tabSelector).show()
      } else {
        $(tabSelector).hide()
        // If this was the active tab, switch to basic
        if ($(tabSelector).hasClass('active')) {
          currentPatternCategory = 'basic'
          $('.playmode-tab').removeClass('active').css('background', 'rgba(0,0,0,0.1)')
          $('#intiface-tab-basic').addClass('active').css('background', 'rgba(100,150,255,0.3)')
          populatePatternButtons(devices.length > 0 ? getDeviceType(devices[0]) : 'general')
        }
      }
    }
  })
}

  // On init, sync Play Mode from AI Mode settings (AI settings are the source of truth)
  playModeSettings.denial = modeSettings.denialDomina
  playModeSettings.milking = modeSettings.milkMaid
  playModeSettings.training = modeSettings.petTraining
  playModeSettings.robotic = modeSettings.roboticRuination
  playModeSettings.sissy = modeSettings.sissySurrender
  playModeSettings.prejac = modeSettings.prejacPrincess
  playModeSettings.evil = modeSettings.evilEdgingMistress
  playModeSettings.frustration = modeSettings.frustrationFairy
  playModeSettings.hypno = modeSettings.hypnoHelper
  playModeSettings.chastity = modeSettings.chastityCaretaker
  
  $('#intiface-mode-denial').prop('checked', playModeSettings.denial)
  $('#intiface-mode-milking').prop('checked', playModeSettings.milking)
  $('#intiface-mode-training').prop('checked', playModeSettings.training)
  $('#intiface-mode-robotic').prop('checked', playModeSettings.robotic)
  $('#intiface-mode-sissy').prop('checked', playModeSettings.sissy)
  $('#intiface-mode-prejac').prop('checked', playModeSettings.prejac)
  $('#intiface-mode-evil').prop('checked', playModeSettings.evil)
  $('#intiface-mode-frustration').prop('checked', playModeSettings.frustration)
  $('#intiface-mode-hypno').prop('checked', playModeSettings.hypno)
  $('#intiface-mode-chastity').prop('checked', playModeSettings.chastity)

  // Initialize tab visibility based on saved settings
  updatePlayModeTabVisibility()

  $('#intiface-mode-denial, #intiface-mode-milking, #intiface-mode-training, #intiface-mode-robotic, #intiface-mode-sissy, #intiface-mode-prejac, #intiface-mode-evil, #intiface-mode-frustration, #intiface-mode-hypno, #intiface-mode-chastity')
  .on('change', savePlayModeSettings)

// Global intensity slider
$('#intiface-global-intensity').on('input', function() {
    const val = parseInt($(this).val())
    globalIntensityScale = val
    $('#intiface-global-intensity-display').text(`${val}%`)
    
    const display = $('#intiface-global-intensity-display')
    if (val < 100) display.css('color', '#4CAF50')
    else if (val < 200) display.css('color', '#FFEB3B')
    else if (val < 300) display.css('color', '#FF9800')
    else display.css('color', '#F44336')
})

// Initialize global intensity display
$('#intiface-global-intensity-display').text(`${globalIntensityScale}%`)
$('#intiface-global-intensity').val(globalIntensityScale)

// Handle reset button
$("#intiface-reset-mode-intensities").on("click", function() {
  // Reset all to 100%
  modeIntensityMultipliers = {
    denialDomina: 1.0,
    milkMaid: 1.0,
    petTraining: 1.0,
    sissySurrender: 1.0,
    prejacPrincess: 1.0,
    roboticRuination: 1.0,
    evilEdgingMistress: 1.0,
    frustrationFairy: 1.0,
    hypnoHelper: 1.0,
    chastityCaretaker: 1.0
  }
  // Update all sliders
  $("#intiface-mode-intensity-denial").val(100)
  $("#intiface-mode-intensity-denial-display").text("100%")
  $("#intiface-mode-intensity-milk").val(100)
  $("#intiface-mode-intensity-milk-display").text("100%")
  $("#intiface-mode-intensity-pet").val(100)
  $("#intiface-mode-intensity-pet-display").text("100%")
  $("#intiface-mode-intensity-sissy").val(100)
  $("#intiface-mode-intensity-sissy-display").text("100%")
  $("#intiface-mode-intensity-prejac").val(100)
  $("#intiface-mode-intensity-prejac-display").text("100%")
  $("#intiface-mode-intensity-robotic").val(100)
  $("#intiface-mode-intensity-robotic-display").text("100%")
  $("#intiface-mode-intensity-evil").val(100)
  $("#intiface-mode-intensity-evil-display").text("100%")
  $("#intiface-mode-intensity-frustration").val(100)
  $("#intiface-mode-intensity-frustration-display").text("100%")
  $("#intiface-mode-intensity-hypno").val(100)
  $("#intiface-mode-intensity-hypno-display").text("100%")
  $("#intiface-mode-intensity-chastity").val(100)
  $("#intiface-mode-intensity-chastity-display").text("100%")
  saveModeIntensity()
})

// Load and set up Intiface exe path
    const savedExePath = localStorage.getItem("intiface-exe-path")
    if (savedExePath) {
      $("#intiface-exe-path").val(savedExePath)
      $("#intiface-exe-status").text(`Configured: ${savedExePath}`).css("color", "#4CAF50")
    }

    // Handle exe path input
    $("#intiface-exe-path").on("input", function () {
      const path = $(this).val()
      if (path) {
        localStorage.setItem("intiface-exe-path", path)
        $("#intiface-exe-status").text(`Configured: ${path}`).css("color", "#4CAF50")
      } else {
        localStorage.removeItem("intiface-exe-path")
        $("#intiface-exe-status").text("Not configured").css("color", "#888")
      }
    })

    // Handle browse button (opens file picker)
    $("#intiface-browse-btn").on("click", function () {
      console.log(`${NAME}: Browse button clicked`)
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = '.exe'
      input.onchange = function (e) {
        console.log(`${NAME}: File selected`, e.target.files)
        const file = e.target.files[0]
        if (file) {
          console.log(`${NAME}: File object:`, file)
          console.log(`${NAME}: File path:`, file.path)
          console.log(`${NAME}: File name:`, file.name)

          // Try to get the path (works in Electron) or just use the name
          if (file.path) {
            // Electron environment - we got the full path
            console.log(`${NAME}: Setting path from Electron:`, file.path)
            $("#intiface-exe-path").val(file.path)
            $("#intiface-exe-path").trigger('input')
          } else {
            // Browser environment - file.path is not available
            console.log(`${NAME}: No file.path available, using manual entry`)
            $("#intiface-exe-status")
              .text("Browser security prevents file access. Please type the full path manually.")
              .css("color", "#FFA500")
          }
        }
      }
      input.click()
    })

// Handle advanced config dropdown toggle
    $("#intiface-advanced-toggle").on("click", function () {
      const content = $("#intiface-advanced-content")
      const arrow = $("#intiface-advanced-arrow")

      if (content.is(":visible")) {
        content.slideUp(200)
        arrow.removeClass("expanded")
      } else {
        content.slideDown(200)
        arrow.addClass("expanded")
      }
    })

    // Handle device polling rate slider
    $("#intiface-polling-rate").on("input", function() {
      const val = parseInt($(this).val())
      devicePollingRate = val
      saveDevicePollingRate(val)
      $("#intiface-polling-rate-display").text(`${val}Hz (${getPollingInterval()}ms)`)
      console.log(`${NAME}: Polling rate changed to ${val}Hz (${getPollingInterval()}ms)`)
    })

    // Initialize polling rate display
    $("#intiface-polling-rate").val(devicePollingRate)
    $("#intiface-polling-rate-display").text(`${devicePollingRate}Hz (${getPollingInterval()}ms)`)

    // Handle global inversion checkbox
    $("#intiface-global-invert").on('change', function() {
      const isChecked = $(this).is(':checked')
      saveGlobalInvert(isChecked)
      
      const statusEl = $("#intiface-global-invert-status")
      if (isChecked) {
        statusEl.show()
        updateStatus('Global inversion enabled')
      } else {
        statusEl.hide()
        updateStatus('Global inversion disabled')
      }
      
      console.log(`${NAME}: Global invert set to ${isChecked}`)
    })

    // Initialize global inversion checkbox
    $("#intiface-global-invert").prop('checked', globalInvert)
    if (globalInvert) {
      $("#intiface-global-invert-status").show()
    }

    // AI control is always chat-based
    chatControlEnabled = true
    localStorage.setItem("intiface-ai-mode", "chat")
    localStorage.setItem("intiface-chat-control", "true")
    console.log(`${NAME}: Chat-based AI control enabled`)
    
// Pattern buttons now only select patterns for timeline placement
  // Direct playback removed - all patterns go through timeline
    
    // Handle motor slider changes (delegated)
    $(document).on('input', '.motor-slider', async function() {
      const deviceIndex = $(this).data('device') || 0
      const motorIndex = $(this).data('motor') || 0
      const intensity = parseInt($(this).val())
      
      const targetDevice = devices[deviceIndex]
      if (!targetDevice || !client.connected) return
      
      try {
        const vibrateAttributes = targetDevice.vibrateAttributes
        if (vibrateAttributes && vibrateAttributes[motorIndex]) {
          const scalarCommand = new buttplug.ScalarSubcommand(
            vibrateAttributes[motorIndex].Index,
            intensity / 100,
            "Vibrate"
          )
          await targetDevice.scalar(scalarCommand)
          updateStatus(`${getDeviceDisplayName(targetDevice)} motor ${motorIndex + 1}: ${intensity}%`)
        }
      } catch (e) {
        console.error(`${NAME}: Motor control failed:`, e)
      }
    })
    
// Handle mode toggle clicks (delegated)
const modeTypes = ['deny', 'milk', 'pet', 'sissy', 'prejac', 'robotic', 'evil', 'frustration', 'hypno', 'chastity']
modeTypes.forEach(modeType => {
  $(document).on("click", `[id^='intiface-${modeType}-toggle-']`, function() {
    const toggleId = $(this).attr("id")
    const deviceIndex = toggleId.replace(`intiface-${modeType}-toggle-`, "")
    const content = $(`#intiface-${modeType}-content-${deviceIndex}`)
    const arrow = $(`#intiface-${modeType}-arrow-${deviceIndex}`)
    
    if (content.is(":visible")) {
      content.slideUp(200)
      arrow.css("transform", "rotate(0deg)")
    } else {
      content.slideDown(200)
      arrow.css("transform", "rotate(180deg)")
    }
  })
})

// Handle denial domina mode button clicks (delegated)
    $(document).on('click', '.deny-mode-btn', async function() {
      const modeName = $(this).data('mode')
      const deviceIndex = $(this).data('device') || 0

      console.log(`${NAME}: Denial Domina mode button clicked - ${modeName}`)
      await executeTeaseAndDenialMode(deviceIndex, modeName)
    })

    // Handle milk maid mode button clicks (delegated)
    $(document).on('click', '.milk-mode-btn', async function() {
      const modeName = $(this).data('mode')
      const deviceIndex = $(this).data('device') || 0

      console.log(`${NAME}: Milk Maid mode button clicked - ${modeName}`)
      await executeTeaseAndDenialMode(deviceIndex, modeName)
    })

    // Handle pet training mode button clicks (delegated)
    $(document).on('click', '.pet-mode-btn', async function() {
      const modeName = $(this).data('mode')
      const deviceIndex = $(this).data('device') || 0

      console.log(`${NAME}: Pet Training mode button clicked - ${modeName}`)
      await executeTeaseAndDenialMode(deviceIndex, modeName)
    })

    // Handle sissy surrender mode button clicks (delegated)
    $(document).on('click', '.sissy-mode-btn', async function() {
      const modeName = $(this).data('mode')
      const deviceIndex = $(this).data('device') || 0

      console.log(`${NAME}: Sissy Surrender mode button clicked - ${modeName}`)
      await executeTeaseAndDenialMode(deviceIndex, modeName)
    })

    // Handle prejac princess mode button clicks (delegated)
    $(document).on('click', '.prejac-mode-btn', async function() {
      const modeName = $(this).data('mode')
      const deviceIndex = $(this).data('device') || 0

      console.log(`${NAME}: Prejac Princess mode button clicked - ${modeName}`)
      await executeTeaseAndDenialMode(deviceIndex, modeName)
    })

    // Handle robotic ruination mode button clicks (delegated)
    $(document).on('click', '.robotic-mode-btn', async function() {
      const modeName = $(this).data('mode')
      const deviceIndex = $(this).data('device') || 0

      console.log(`${NAME}: Robotic Ruination mode button clicked - ${modeName}`)
      await executeTeaseAndDenialMode(deviceIndex, modeName)
    })

    // Handle evil edging mistress mode button clicks (delegated)
    $(document).on('click', '.evil-mode-btn', async function() {
      const modeName = $(this).data('mode')
      const deviceIndex = $(this).data('device') || 0

      console.log(`${NAME}: Evil Edging Mistress mode button clicked - ${modeName}`)
      await executeTeaseAndDenialMode(deviceIndex, modeName)
    })

    // Handle frustration fairy mode button clicks (delegated)
    $(document).on('click', '.frustration-mode-btn', async function() {
      const modeName = $(this).data('mode')
      const deviceIndex = $(this).data('device') || 0

      console.log(`${NAME}: Frustration Fairy mode button clicked - ${modeName}`)
      await executeTeaseAndDenialMode(deviceIndex, modeName)
    })

    // Handle hypno helper mode button clicks (delegated)
    $(document).on('click', '.hypno-mode-btn', async function() {
      const modeName = $(this).data('mode')
      const deviceIndex = $(this).data('device') || 0

      console.log(`${NAME}: Hypno Helper mode button clicked - ${modeName}`)
      await executeTeaseAndDenialMode(deviceIndex, modeName)
    })

// Handle chastity caretaker mode button clicks (delegated)
$(document).on('click', '.chastity-mode-btn', async function() {
  const modeName = $(this).data('mode')
  const deviceIndex = $(this).data('device') || 0

  console.log(`${NAME}: Chastity Caretaker mode button clicked - ${modeName}`)
  await executeTeaseAndDenialMode(deviceIndex, modeName)
})

updateButtonStates(client.connected)
    updateStatus("Disconnected")

// Attach device event handlers
    attachDeviceEventHandlers()

    console.log(`${NAME}: Chat-based control enabled`)

  // Set up chat-based control event listeners
  eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived)
  eventSource.on(event_types.STREAM_TOKEN_RECEIVED, onStreamTokenReceived)
  eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted)
  eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded)

  // Handle chat change - update prompt and stop media
  eventSource.on(event_types.CHAT_CHANGED, async () => {
    console.log(`${NAME}: Chat changed - updating prompt and stopping media`)
    // Update the prompt for the new chat context
    updatePrompt()
    // Stop any media playback and hide the player
    hideChatMediaPanel()
  })

// Handle page visibility changes to prevent vibration stopping in background
let hiddenTime = 0
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) {
    hiddenTime = Date.now()
    console.log(`${NAME}: Tab hidden - switching to background mode`)
    // Switch funscript sync to timer-based when tab is hidden
    // Check if media is actually playing (not paused), not the isPlaying flag
    if (mediaPlayer.videoElement && mediaPlayer.currentFunscript && !mediaPlayer.videoElement.paused) {
      console.log(`${NAME}: Starting timer sync (isPlaying was: ${mediaPlayer.isPlaying})`)
      stopFunscriptSync() // Stop RAF loop
      mediaPlayer.isPlaying = true // Ensure flag is correct
      startFunscriptSyncTimer() // Start timer-based loop
    }
  } else {
    const awayTime = Date.now() - hiddenTime
    console.log(`${NAME}: Tab visible again after ${awayTime}ms`)

    // Restart worker timer if it was running (to ensure proper timing after visibility change)
    if (timerWorker && isWorkerTimerRunning && workerTimers.size > 0) {
      console.log(`${NAME}: Restarting worker timer for background patterns`)
      timerWorker.postMessage({ command: 'stop' })
      isWorkerTimerRunning = false

      // Use the shortest interval from active timers
      const shortestInterval = Math.min(...Array.from(workerTimers.values()).map(t => t.interval))
      timerWorker.postMessage({ command: 'start', data: { interval: Math.max(shortestInterval, 100) } })
      isWorkerTimerRunning = true
    }

    // Switch back to RAF when tab is visible
    if (mediaPlayer.videoElement && mediaPlayer.currentFunscript) {
      stopFunscriptSyncTimer() // Stop timer loop
      // Only restart RAF if media is actually playing
      if (!mediaPlayer.videoElement.paused) {
        mediaPlayer.isPlaying = true
        startFunscriptSync() // Restart RAF loop
      }
    }
    // Resume any active patterns that might have stalled
    if (client.connected && devices.length > 0) {
      // Send a small pulse to "wake up" the device connection
      for (const device of devices) {
        if (device.vibrateAttributes && device.vibrateAttributes.length > 0) {
          try {
            const wakeCmd = new buttplug.ScalarSubcommand(
              device.vibrateAttributes[0].Index,
              0.01,
              "Vibrate"
            )
            await device.scalar(wakeCmd)
            await new Promise(resolve => setTimeout(resolve, 50))
            await device.vibrate(0)
          } catch (e) {
            // Ignore wake errors
          }
        }
      }
    }
  }
})

  // Update prompt to show initial status
    // Call immediately and also delayed to ensure SillyTavern has loaded
    updatePrompt()
    setTimeout(() => {
      console.log(`${NAME}: Delayed prompt update`)
      updatePrompt()
    }, 2000)

// Initialize media module with dependencies
initMediaModule({
  NAME,
  client,
  devices,
  deviceAssignments,
  buttplug,
  updateStatus,
  updateAIStatusFromActivity,
  stopAllDeviceActions,
  clearWorkerTimeout,
  getMotorCount,
  getPollingInterval,
  getDeviceType,
  getDeviceDefaultIntensity,
  applyInversion,
  getRequestHeaders,
  messageCommands,
  PlayModeLoader,
  toggleConnection
})

// Initialize media player functionality
initMediaPlayer()

  // Additional delayed prompt update after media player init
  setTimeout(() => {
    console.log(`${NAME}: Final prompt update after init`)
    updatePrompt()
  }, 3000)
  
  } catch (error) {
    console.error(`${NAME}: Failed to initialize.`, error)
    const statusPanel = $("#intiface-status-panel")
    if (statusPanel.length) {
      updateStatus("Failed to load Buttplug.js. Check console.", true)
    }
  }
})

// ==========================================
// ==========================================

// ==========================================
// AUTO-CONNECT (MUST BE LAST)
// ==========================================

// Auto-connect on extension load - runs after everything else is initialized
async function autoConnectOnLoad() {
  // Check if auto-connect is enabled
  const autoConnect = localStorage.getItem("intiface-auto-connect") === "true"

  if (!autoConnect) {
    console.log(`${NAME}: Auto-connect disabled`)
    return
  }

  console.log(`${NAME}: Auto-connect enabled, attempting connection...`)

  // Wait a bit to ensure everything is fully loaded
  await new Promise(resolve => setTimeout(resolve, 2000))

  // Only connect if not already connected
  if (!client || !client.connected) {
    try {
      await connect(true) // Pass true to indicate this is an auto-connect attempt
      updateStatus(`Auto-connected to Intiface`)
      console.log(`${NAME}: Auto-connected successfully`)
    } catch (e) {
      console.log(`${NAME}: Auto-connect failed, server not available`)
      updateStatus(`Server not available - waiting for manual connection`)
    }
  } else {
    console.log(`${NAME}: Already connected, skipping auto-connect`)
  }
}

// Run auto-connect as the very last thing
autoConnectOnLoad().catch(e => {
  console.error(`${NAME}: Auto-connect error:`, e)
})

// Export functions and state needed by other modules
export {
  stopAllDeviceActions,
  clearWorkerTimeout,
  getMotorCount,
  getPollingInterval,
  updateAIStatusFromActivity,
  updateStatus,
  getDeviceType,
  getDeviceDefaultIntensity,
  applyInversion,
  NAME,
  client,
  devices,
  deviceAssignments,
  buttplug,
  strokerIntervalId,
  vibrateIntervalId,
  oscillateIntervalId,
  isStroking,
  activePatterns,
  messageCommands,
  PlayModeLoader
}
