// ==========================================
// UNIFIED PLAYBACK SYSTEM
// ==========================================
// Handles waveform patterns, device pattern execution, and tease/denial modes

// Dependencies (injected via initPlaybackSystem)
let deps = null

// Initialize playback system with dependencies
export function initPlaybackSystem(dependencies) {
  deps = dependencies
  console.log(`${deps.NAME || 'Intiface'}: Playback system initialized`)
}

// Helper to access dependencies
const d = (name) => {
  // Special cases: check window object first for values that get reassigned
  if (name === 'devices') {
    return (typeof window !== 'undefined' && window.devices) || deps?.[name] || []
  }
  if (name === 'client') {
    return (typeof window !== 'undefined' && window.client) || deps?.[name]
  }
  return deps?.[name]
}

// Active pattern tracking
let activePatterns = new Map() // deviceIndex -> { pattern, interval, controls }

// Device compatibility metadata for patterns
const PatternLibrary = {
  // Device type to waveform pattern mappings - which patterns work best with which device types
  // All device types default to 'general' patterns if not specified here
  compatibility: {
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

  // Device type detection - now uses generic capability-based detection
  // All devices are treated as generic vibration devices with capabilities
  // The system dynamically detects capabilities from device attributes
  devices: {
    // All patterns work with all devices
    typePatterns: {
      general: [] // All devices use generic patterns
    },
    // Default intensities - simplified, user adjustable
    defaultIntensities: {
      default: 100
    },
    // Simplified shorthand - extracts first word or identifier
    getShorthand: (devName) => devName.split(' ')[0].toLowerCase()
  },

  // Presets are now loaded dynamically from play_modes folders via PlayModeLoader
  // No hardcoded presets - all patterns come from modular play mode system

  // Presets are now loaded dynamically from PlayModeLoader - no hardcoded presets
  // All patterns from play_modes folders are compatible with all devices
  getCompatiblePresets(deviceType) {
    // Return empty object - presets are now handled by PlayModeLoader
    return {}
  },

  // All patterns are compatible with all devices in the modular system
  isCompatible(patternName, deviceType) {
    return true // All patterns compatible with all devices
  }
}

// Get active patterns map (for external access)
export function getActivePatterns() {
  return activePatterns
}

// Check if device has multiple motors
export function getMotorCount(device) {
  if (!device || !device.vibrateAttributes) return 1
  return device.vibrateAttributes.length || 1
}

// Apply max vibrate (clamped to 0-100)
export function applyMaxVibrate(value, motorIndex = 0) {
  return Math.min(value, 100)
}

// Apply max oscillate (clamped to 0-100)
export function applyMaxOscillate(value) {
  return Math.min(value, 100)
}

// Generate waveform pattern values
export function generateWaveformValues(pattern, steps, min, max) {
  const PlayModeLoader = d('PlayModeLoader')
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
export function generateDualMotorWaveform(pattern, steps, min, max) {
  const PlayModeLoader = d('PlayModeLoader')
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

// Execute waveform pattern on device
export async function executeWaveformPattern(deviceIndex, presetName, options = {}) {
  const devices = d('devices') || (typeof window !== 'undefined' && window.devices) || []
  const targetDevice = devices[deviceIndex] || devices[0]
  if (!targetDevice) {
    console.error(`${d('NAME')}: No device found for waveform pattern`)
    return
  }

  // Get pattern function from PlayModeLoader
  const PlayModeLoader = d('PlayModeLoader')
  const patternFunc = PlayModeLoader.getPattern(presetName)
  if (!patternFunc) {
    console.error(`${d('NAME')}: Pattern ${presetName} not found`)
    return
  }

  const applyIntensityScale = d('applyIntensityScale')
  const applyInversion = d('applyInversion')
  // executePattern is hoisted, call directly

  // Determine device type using PatternLibrary configuration
  const deviceType = getDeviceType(targetDevice)

  // Get preset from PlayModeLoader if available, otherwise use fallback
  let preset = null

  // Try to find preset in any enabled mode
  const enabledModes = PlayModeLoader.getEnabledModes()
  for (const modeId of enabledModes) {
    const modeSequences = PlayModeLoader.getSequence(modeId, presetName)
    if (modeSequences) {
      // Found a sequence with this name, use it as preset
      preset = {
        type: 'waveform',
        pattern: modeSequences.steps?.[0]?.pattern || 'sine',
        min: modeSequences.steps?.[0]?.min || 20,
        max: modeSequences.steps?.[0]?.max || 60,
        duration: modeSequences.steps?.[0]?.duration || 3000,
        cycles: 3
      }
      break
    }
  }

  // Fall back to default warmup pattern if no preset found
  if (!preset) {
    preset = { type: 'waveform', pattern: 'sine', min: 20, max: 60, duration: 3000, cycles: 3 }
  }

  // Merge with options
  const config = { ...preset, ...options }

  // Stop existing pattern for this device
  await stopDevicePattern(deviceIndex)

  const deviceName = getDeviceDisplayName(targetDevice)
  const globalIntensityScale = d('globalIntensityScale')

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
export async function executeGradientPattern(deviceIndex, config) {
  const devices = d('devices') || (typeof window !== 'undefined' && window.devices) || []
  const targetDevice = devices[deviceIndex] || devices[0]
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

  const motorCount = getMotorCount(targetDevice)
  const applyIntensityScale = d('applyIntensityScale')
  const applyInversion = d('applyInversion')
  // executePattern is hoisted, call directly

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
export async function executeLinearWaveform(deviceIndex, config) {
  const devices = d('devices') || (typeof window !== 'undefined' && window.devices) || []
  const client = d('client')
  const { pattern, positions, duration, cycles } = config
  const [startPos, endPos] = positions
  const steps = Math.floor(duration / 100)
  const PlayModeLoader = d('PlayModeLoader')
  const generator = PlayModeLoader.getPattern(pattern) || PlayModeLoader.getPattern('sine')

  const targetDevice = devices[deviceIndex] || devices[0]
  if (!targetDevice) return

  const applyInversion = d('applyInversion')
  const setWorkerTimeout = d('setWorkerTimeout')

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
      console.error(`${d('NAME')}: Linear waveform step failed:`, e)
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
export async function executeLinearGradient(deviceIndex, config) {
  const devices = d('devices') || (typeof window !== 'undefined' && window.devices) || []
  const client = d('client')
  const { positions, duration, hold = 0 } = config
  const [startPos, endPos] = positions
  const steps = Math.floor(duration / 50)

  const targetDevice = devices[deviceIndex] || devices[0]
  if (!targetDevice) return

  const applyInversion = d('applyInversion')

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
      console.error(`${d('NAME')}: Linear gradient step failed:`, e)
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
export async function executeTeaseAndDenialMode(deviceIndex, modeName) {
  // Get devices from deps or fallback to global window.devices (handles reassignment)
  const devices = d('devices') || (typeof window !== 'undefined' && window.devices) || []
  const client = d('client')
  const PlayModeLoader = d('PlayModeLoader')
  
  console.log(`${d('NAME') || 'Intiface'}: executeTeaseAndDenialMode - deviceIndex: ${deviceIndex}, devices count: ${devices?.length || 0}, modeName: ${modeName}`)
  
  const targetDevice = devices[deviceIndex] || devices[0]
  if (!targetDevice) {
    console.error(`${d('NAME') || 'Intiface'}: No device found for mode - devices array has ${devices?.length || 0} devices`)
    return
  }

  // Search for sequence across all enabled modes
  let mode = null
  let foundModeId = null
  const enabledModes = PlayModeLoader.getEnabledModes()

  console.log(`${d('NAME')}: executeTeaseAndDenialMode - Looking for "${modeName}" in enabled modes:`, enabledModes)

  for (const modeId of enabledModes) {
    console.log(`${d('NAME')}: Checking mode "${modeId}" for sequence "${modeName}"`)
    const sequence = PlayModeLoader.getSequence(modeId, modeName)
    console.log(`${d('NAME')}: PlayModeLoader.getSequence("${modeId}", "${modeName}") returned:`, sequence ? 'FOUND' : 'NOT FOUND')
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

  const updateStatus = d('updateStatus')
  const deviceName = getDeviceDisplayName(targetDevice)
  const sequence = mode.steps || mode.sequence
  const repeat = mode.repeat !== false
  const applyIntensityScale = d('applyIntensityScale')
  const applyInversion = d('applyInversion')
  const setWorkerTimeout = d('setWorkerTimeout')
  // executePattern is hoisted in ES modules, so we can reference it directly

  updateStatus(`${deviceName}: ${modeName} mode (${mode.description})`)

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
      console.error(`${d('NAME')}: Step failed:`, e)
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
export async function stopDevicePattern(deviceIndex) {
  const buttplug = d('buttplug')
  const devices = d('devices') || (typeof window !== 'undefined' && window.devices) || []
  const clearWorkerTimeout = d('clearWorkerTimeout')

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

// Execute pattern commands with intervals
export async function executePattern(cmd, actionType, deviceIndex = 0) {
  const pattern = cmd.pattern || [50]
  const intervals = cmd.intervals || [1000]
  const loopCount = cmd.loop || 1
  const devices = d('devices') || (typeof window !== 'undefined' && window.devices) || []
  const client = d('client')
  const mediaPlayer = d('mediaPlayer')
  const executeCommand = d('executeCommand')
  const setWorkerTimeout = d('setWorkerTimeout')

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

// Stop all device patterns
export async function stopAllDevicePatterns() {
  const devices = d('devices') || (typeof window !== 'undefined' && window.devices) || []
  for (let i = 0; i < devices.length; i++) {
    await stopDevicePattern(i)
  }
}

// Helper function to get device display name
function getDeviceDisplayName(dev) {
  if (!dev) return 'Unknown'
  return dev.displayName || dev.name || 'Unknown Device'
}

// Helper function to get device type
function getDeviceType(dev) {
  // All devices use generic type - capabilities are detected dynamically
  return 'general'
}

// ==========================================
// EXPORTS
// ==========================================

export {
  PatternLibrary,
  activePatterns
}
