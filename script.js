// SPDX-License-Identifier: AGPL-3.0-or-later

import { renderExtensionTemplateAsync } from "../../../extensions.js"
import { eventSource, event_types, setExtensionPrompt, extension_prompt_types, extension_prompt_roles, getRequestHeaders } from "../../../../script.js"

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
let intervalId

// Chat-based control variables
let messageCommands = [] // Commands from current AI message
let executedCommands = new Set() // Track executed commands
let streamingText = '' // Accumulate streaming text
let commandQueueInterval = null // Interval for sequential execution
let isExecutingCommands = false
let chatControlEnabled = false // Toggle for chat-based control
let isStartingIntiface = false // Prevent multiple simultaneous start attempts

// Waveform pattern generator
const WaveformPatterns = {
  sine: (phase, intensity) => Math.sin(phase * Math.PI * 2) * intensity,
  sawtooth: (phase, intensity) => (phase < 0.5 ? phase * 2 : (1 - phase) * 2) * intensity,
  square: (phase, intensity) => (phase < 0.5 ? intensity : 0),
  triangle: (phase, intensity) => (phase < 0.5 ? phase * 2 : (1 - phase) * 2) * intensity,
  pulse: (phase, intensity) => (phase < 0.1 ? intensity : phase < 0.2 ? intensity * 0.3 : 0),
  random: (_, intensity) => Math.random() * intensity,
  ramp_up: (phase, intensity) => phase * intensity,
  ramp_down: (phase, intensity) => (1 - phase) * intensity
}

// Device-specific preset patterns
const DevicePresets = {
  cage: {
    tease: { type: 'waveform', pattern: 'pulse', min: 10, max: 40, duration: 5000, cycles: 3 },
    denial: { type: 'waveform', pattern: 'ramp_up', min: 5, max: 80, duration: 10000, cycles: 1 },
    pulse: { type: 'waveform', pattern: 'square', min: 20, max: 60, duration: 2000, cycles: 10 },
    edge: { type: 'gradient', start: 0, end: 90, duration: 15000, hold: 5000, release: 3000 },
    random: { type: 'waveform', pattern: 'random', min: 15, max: 50, duration: 8000, cycles: 2 }
  },
  plug: {
    gentle: { type: 'waveform', pattern: 'sine', min: 10, max: 30, duration: 3000, cycles: 5 },
    pulse: { type: 'waveform', pattern: 'pulse', min: 20, max: 70, duration: 1500, cycles: 8 },
    wave: { type: 'waveform', pattern: 'sawtooth', min: 15, max: 55, duration: 4000, cycles: 4 },
    intense: { type: 'waveform', pattern: 'square', min: 40, max: 90, duration: 2500, cycles: 6 }
  },
  stroker: {
    slow: { type: 'linear_waveform', pattern: 'sine', positions: [10, 90], duration: 3000, cycles: 5 },
    medium: { type: 'linear_waveform', pattern: 'sawtooth', positions: [20, 80], duration: 2000, cycles: 8 },
    fast: { type: 'linear_waveform', pattern: 'square', positions: [15, 85], duration: 1000, cycles: 15 },
    edge: { type: 'linear_gradient', positions: [10, 95], duration: 8000, hold: 3000 },
    tease: { type: 'linear_waveform', pattern: 'pulse', positions: [30, 70], duration: 1500, cycles: 12 }
  },
  general: {
    warmup: { type: 'gradient', start: 0, end: 50, duration: 10000 },
    build: { type: 'waveform', pattern: 'ramp_up', min: 30, max: 80, duration: 12000, cycles: 1 },
    peak: { type: 'waveform', pattern: 'square', min: 70, max: 100, duration: 3000, cycles: 3 },
    cooldown: { type: 'gradient', start: 60, end: 10, duration: 8000 }
  }
}

// Active pattern tracking
let activePatterns = new Map() // deviceIndex -> { pattern, interval, controls }

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
  const generator = WaveformPatterns[pattern] || WaveformPatterns.sine
  const range = max - min
  
  for (let i = 0; i < steps; i++) {
    const phase = i / steps
    const normalized = generator(phase, 1)
    const value = min + (normalized * range)
    values.push(Math.max(0, Math.min(100, Math.round(value))))
  }
  return values
}

// Execute waveform pattern on device
async function executeWaveformPattern(deviceIndex, presetName, options = {}) {
  const targetDevice = devices[deviceIndex] || devices[0]
  if (!targetDevice) {
    console.error(`${NAME}: No device found for waveform pattern`)
    return
  }
  
  // Determine device type
  const devName = (targetDevice.displayName || targetDevice.name || '').toLowerCase()
  let deviceType = 'general'
  if (devName.includes('cage')) deviceType = 'cage'
  else if (devName.includes('plug')) deviceType = 'plug'
  else if (devName.includes('solace') || devName.includes('stroker') || devName.includes('launch')) deviceType = 'stroker'
  
  // Get preset
  const presets = DevicePresets[deviceType] || DevicePresets.general
  const preset = presets[presetName] || presets.warmup || { type: 'waveform', pattern: 'sine', min: 20, max: 60, duration: 3000, cycles: 3 }
  
  // Merge with options
  const config = { ...preset, ...options }
  
  // Stop existing pattern for this device
  await stopDevicePattern(deviceIndex)
  
  const deviceName = getDeviceDisplayName(targetDevice)
  
  if (config.type === 'waveform') {
    const steps = Math.floor(config.duration / 100) // 100ms resolution
    const values = generateWaveformValues(config.pattern, steps, config.min, config.max)
    const intervals = Array(steps).fill(100)
    
    await executePattern({
      pattern: values,
      intervals: intervals,
      loop: config.cycles || 1
    }, 'vibrate', deviceIndex)
    
    updateStatus(`${deviceName}: ${presetName} pattern (${config.pattern})`)
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
  const values = []
  const intervals = []
  
  // Ramp up
  for (let i = 0; i < steps; i++) {
    const progress = i / steps
    values.push(Math.round(start + (end - start) * progress))
    intervals.push(50)
  }
  
  // Hold
  if (hold > 0) {
    const holdSteps = Math.floor(hold / 100)
    for (let i = 0; i < holdSteps; i++) {
      values.push(end)
      intervals.push(100)
    }
  }
  
  // Release
  if (release > 0) {
    const releaseSteps = Math.floor(release / 50)
    for (let i = 0; i < releaseSteps; i++) {
      const progress = i / releaseSteps
      values.push(Math.round(end - (end * progress)))
      intervals.push(50)
    }
  }
  
  await executePattern({ pattern: values, intervals }, 'vibrate', deviceIndex)
}

// Execute linear waveform (position-based)
async function executeLinearWaveform(deviceIndex, config) {
  const { pattern, positions, duration, cycles } = config
  const [startPos, endPos] = positions
  const steps = Math.floor(duration / 100)
  const generator = WaveformPatterns[pattern] || WaveformPatterns.sine
  
  const targetDevice = devices[deviceIndex] || devices[0]
  if (!targetDevice) return
  
  let currentCycle = 0
  let currentStep = 0
  
  const executeStep = async () => {
    if (currentCycle >= cycles || !client.connected) return
    
    const phase = currentStep / steps
    const normalized = generator(phase, 1)
    const position = Math.round(startPos + (endPos - startPos) * normalized)
    
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
    
    if (currentCycle < cycles) {
      setTimeout(executeStep, 100)
    }
  }
  
  executeStep()
}

// Execute linear gradient
async function executeLinearGradient(deviceIndex, config) {
  const { positions, duration, hold = 0 } = config
  const [startPos, endPos] = positions
  const steps = Math.floor(duration / 50)
  
  const targetDevice = devices[deviceIndex] || devices[0]
  if (!targetDevice) return
  
  for (let i = 0; i < steps; i++) {
    const progress = i / steps
    const position = Math.round(startPos + (endPos - startPos) * progress)
    try {
      await targetDevice.linear(position / 100, 50)
    } catch (e) {
      console.error(`${NAME}: Linear gradient step failed:`, e)
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  
  if (hold > 0) {
    await new Promise(resolve => setTimeout(resolve, hold))
  }
}

// Stop pattern for specific device
async function stopDevicePattern(deviceIndex) {
  if (activePatterns.has(deviceIndex)) {
    const active = activePatterns.get(deviceIndex)
    if (active.interval) {
      clearTimeout(active.interval)
    }
    activePatterns.delete(deviceIndex)
  }
  
  // Stop the device
  const targetDevice = devices[deviceIndex]
  if (targetDevice) {
    try {
      const vibrateAttributes = targetDevice.vibrateAttributes
      if (vibrateAttributes && vibrateAttributes.length > 0) {
        for (let i = 0; i < vibrateAttributes.length; i++) {
          const scalarCommand = new buttplug.ScalarSubcommand(vibrateAttributes[i].Index, 0, "Vibrate")
          await targetDevice.scalar(scalarCommand)
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
// <plug:OSCILLATE: 75> - Matches devices with "plug" in name
// <any:VIBRATE: 50> - Matches any device (first available)
// <solace:LINEAR: start=10, end=90, duration=1000>
// <toy:PATTERN: [20, 40, 60], interval=[1000, 500, 1000], loop=3>
// <cage:PRESET: tease> - Use device-specific preset
// <any:WAVEFORM: sine, min=10, max=80, duration=5000>
// <cage:GRADIENT: start=0, end=90, duration=10000>
function parseDeviceCommands(text) {
  const commands = []
  
  console.log(`${NAME}: Parsing commands from text:`, text.substring(0, 100) + '...')
  
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
    
    // Check for INTIFACE system commands (start, connect, disconnect)
    if (deviceType === 'intiface' || deviceType === 'system') {
      if (commandText === 'START') {
        commands.push({ type: 'intiface_start' })
        continue
      }
      if (commandText === 'CONNECT') {
        commands.push({ type: 'intiface_connect' })
        continue
      }
      if (commandText === 'DISCONNECT') {
        commands.push({ type: 'intiface_disconnect' })
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
  console.log(`${NAME}: Executing command type: ${cmd.type}`)
  
  // System commands can run without connection
  if (cmd.type === 'intiface_start' || cmd.type === 'intiface_connect' || cmd.type === 'intiface_disconnect') {
    try {
      switch (cmd.type) {
        case 'intiface_start':
          await handleIntifaceStart()
          break
        case 'intiface_connect':
          await handleIntifaceConnect()
          break
        case 'intiface_disconnect':
          await handleIntifaceDisconnect()
          break
      }
    } catch (e) {
      console.error(`${NAME}: System command execution failed:`, e)
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
      
      case 'vibrate':
        const vibrateAttrs = targetDevice.vibrateAttributes
        if (vibrateAttrs && vibrateAttrs[cmd.motorIndex]) {
          const scalarCmd = new buttplug.ScalarSubcommand(
            vibrateAttrs[cmd.motorIndex].Index,
            cmd.intensity / 100,
            "Vibrate"
          )
          await targetDevice.scalar(scalarCmd)
          updateStatus(`${deviceName} vibrating at ${cmd.intensity}%`)
        }
        break
      
      case 'oscillate':
        await targetDevice.oscillate(cmd.intensity / 100)
        updateStatus(`${deviceName} oscillating at ${cmd.intensity}%`)
        break
      
      case 'linear':
        await targetDevice.linear(cmd.endPos / 100, cmd.duration)
        updateStatus(`${deviceName} linear stroke ${cmd.startPos}% to ${cmd.endPos}%`)
        break
      
      case 'stop':
        await stopAllDeviceActions()
        break
      
      case 'vibrate_pattern':
        // Execute pattern
        executePattern(cmd, 'vibrate', deviceIndex)
        break
      
      case 'oscillate_pattern':
        executePattern(cmd, 'oscillate', deviceIndex)
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

// Execute pattern commands with intervals
async function executePattern(cmd, actionType, deviceIndex = 0) {
  const pattern = cmd.pattern || [50]
  const intervals = cmd.intervals || [1000]
  const loopCount = cmd.loop || 1
  
  let currentLoop = 0
  let patternIndex = 0
  
  const executeStep = async () => {
    if (!client.connected || currentLoop >= loopCount) return
    
    const intensity = pattern[patternIndex % pattern.length]
    const interval = intervals[patternIndex % intervals.length]
    
    if (actionType === 'vibrate') {
      await executeCommand({ type: 'vibrate', intensity, motorIndex: 0, deviceIndex })
    } else if (actionType === 'oscillate') {
      await executeCommand({ type: 'oscillate', intensity, deviceIndex })
    }
    
    patternIndex++
    if (patternIndex >= pattern.length) {
      patternIndex = 0
      currentLoop++
    }
    
    if (currentLoop < loopCount || cmd.loop === undefined) {
      commandQueueInterval = setTimeout(executeStep, interval)
    }
  }
  
  executeStep()
}

// Process command queue sequentially
async function processCommandQueue() {
  if (isExecutingCommands || messageCommands.length === 0) return
  
  isExecutingCommands = true
  
  while (messageCommands.length > 0) {
    const cmd = messageCommands.shift()
    
    // Skip system commands - they should have been handled immediately
    if (cmd.type === 'intiface_start' || cmd.type === 'intiface_connect' || cmd.type === 'intiface_disconnect') {
      console.log(`${NAME}: Skipping system command in queue (should have been executed immediately): ${cmd.type}`)
      continue
    }
    
    // Device commands require connection
    if (client.connected) {
      await executeCommand(cmd)
    } else {
      console.log(`${NAME}: Skipping device command - not connected`)
    }
  }
  
  isExecutingCommands = false
}

// Handle streaming token received
async function onStreamTokenReceived(data) {
  if (!chatControlEnabled) return
  
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
  
  const commands = parseDeviceCommands(streamingText)
  
  for (const cmd of commands) {
    // Create a unique key for deduplication
    const cmdKey = JSON.stringify({ type: cmd.type, deviceIndex: cmd.deviceIndex })
    
    if (!executedCommands.has(cmdKey)) {
      executedCommands.add(cmdKey)
      console.log(`${NAME}: New command detected: ${cmd.type}`)
      
      // Execute system commands immediately (don't add to queue)
      if (cmd.type === 'intiface_start' || cmd.type === 'intiface_connect' || cmd.type === 'intiface_disconnect') {
        console.log(`${NAME}: Executing system command immediately: ${cmd.type}`)
        executeCommand(cmd)
      } else {
        // Device commands go to queue
        messageCommands.push(cmd)
      }
    }
  }
}

// Handle message received (fallback for non-streaming)
async function onMessageReceived(data) {
  if (!chatControlEnabled) return
  
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
    cmd.type === 'intiface_start' ||
    cmd.type === 'intiface_connect' ||
    cmd.type === 'intiface_disconnect'
  )
  const deviceCommandsList = commands.filter(cmd =>
    cmd.type !== 'intiface_start' &&
    cmd.type !== 'intiface_connect' &&
    cmd.type !== 'intiface_disconnect'
  )
  
  // Execute system commands immediately (even if not connected)
  for (const cmd of systemCommands) {
    await executeCommand(cmd)
  }
  
  // Only process device commands if connected
  if (!client.connected && !videoFilename) return
  
  // Clear previous commands and stop current activity (unless we're playing video)
  if (!mediaPlayer.isPlaying) {
    messageCommands = []
    executedCommands.clear()
    streamingText = ''
    
    if (commandQueueInterval) {
      clearTimeout(commandQueueInterval)
      commandQueueInterval = null
    }
    
    await stopAllDeviceActions()
  }
  
  // Queue new device commands
  messageCommands = deviceCommandsList
  executedCommands = new Set(deviceCommandsList.map(cmd => JSON.stringify(cmd)))
  
  // Start processing
  processCommandQueue()
}

// Handle generation started
function onGenerationStarted() {
  executedCommands.clear()
  streamingText = ''
}

// Handle generation ended
function onGenerationEnded() {
  streamingText = ''
  // Process any remaining commands
  processCommandQueue()
}

// Get device display name (prefer displayName over name)
function getDeviceDisplayName(dev) {
  if (!dev) return 'Unknown'
  return dev.displayName || dev.name || 'Unknown Device'
}

// Get device type classification
function getDeviceType(dev) {
  const devName = (dev.displayName || dev.name || '').toLowerCase()
  if (devName.includes('cage')) return 'cage'
  if (devName.includes('plug')) return 'plug'
  if (devName.includes('solace') || devName.includes('stroker') || devName.includes('launch')) return 'stroker'
  if (devName.includes('lush') || devName.includes('hush')) return 'vibrator'
  if (devName.includes('nora') || devName.includes('max') || devName.includes('domi')) return 'vibrator'
  return 'general'
}

// Get shorthand for device
function getDeviceShorthand(dev) {
  const devName = (dev.displayName || dev.name || '').toLowerCase()
  if (devName.includes('cage')) return 'cage'
  if (devName.includes('plug')) return 'plug'
  if (devName.includes('solace')) return 'solace'
  if (devName.includes('lush')) return 'lush'
  if (devName.includes('hush')) return 'hush'
  if (devName.includes('nora')) return 'nora'
  if (devName.includes('max')) return 'max'
  if (devName.includes('domi')) return 'domi'
  if (devName.includes('edge')) return 'edge'
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

async function connect() {
  try {
    const serverIp = $("#intiface-ip-input").val()
    const serverUrl = `ws://${serverIp}`
    localStorage.setItem("intiface-server-ip", serverIp) // Save on connect
    connector = new buttplug.ButtplugBrowserWebsocketClientConnector(serverUrl)
    updateStatus("Connecting...")
    await client.connect(connector)
    updateStatus("Connected")
    $("#intiface-status-panel").removeClass("disconnected").addClass("connected")
    updateButtonStates(true)
    intervalId = setInterval(processMessage, 1000) // Start processing messages

    // Re-attach device event handlers
    attachDeviceEventHandlers()

    // Re-register function tools after connection (if enabled)
    const functionCallingEnabled = localStorage.getItem("intiface-function-calling-enabled") !== "false"
    if (functionCallingEnabled) {
      registerFunctionTools()
    }

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
    updateStatus(`Error connecting: ${e.message}`, true)
    // Update prompt even on failure
    updatePrompt()
  }
}

async function disconnect() {
  try {
    await client.disconnect()
    updateStatus("Disconnected")
    $("#intiface-status-panel").removeClass("connected").addClass("disconnected")
    updateButtonStates(false)
    $("#intiface-devices").empty()
    devices = [] // Clear devices array
    device = null
    if (intervalId) {
      clearInterval(intervalId) // Stop processing messages
      intervalId = null
    }
    if (strokerIntervalId) {
      clearInterval(strokerIntervalId)
      strokerIntervalId = null
    }
    isStroking = false
    if (vibrateIntervalId) {
      clearTimeout(vibrateIntervalId)
      vibrateIntervalId = null
    }
    if (oscillateIntervalId) {
      clearTimeout(oscillateIntervalId)
      oscillateIntervalId = null
    }

    // Unregister function tools
    unregisterFunctionTools()

    // Update prompt to show disconnection status
    updatePrompt()
  } catch (e) {
    updateStatus(`Error disconnecting: ${e.message}`, true)
    // Update prompt even on failure
    updatePrompt()
  }
}

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

  // List all connected devices
  devices.forEach((dev, idx) => {
    const deviceListItem = $(`<div style="padding: 5px; margin: 2px 0; background: rgba(100,100,100,0.2); border-radius: 3px; font-size: 0.9em;">
      ${idx + 1}. ${dev.name} ${idx === 0 ? '(active)' : ''}
    </div>`)
    devicesEl.append(deviceListItem)
  })

  // Add separator
  devicesEl.append('<hr style="margin: 10px 0; opacity: 0.3;">')

  // Show active device info
  const deviceDiv = $(`<div id="device-${device.index}"></div>`)
  deviceDiv.html(`<h3>${device.name}</h3>`)

  // Check device capabilities from message attributes
  const messageAttrs = device.messageAttributes
  const hasVibration = device.vibrateAttributes && device.vibrateAttributes.length > 0
  const hasOscillate = messageAttrs?.OscillateCmd !== undefined
  const hasLinear = messageAttrs?.LinearCmd !== undefined
  
  // Get device type
  const deviceType = getDeviceType(device)

  // Show supported features info
  const featuresList = []
  if (hasVibration) featuresList.push(`Vibrate (${device.vibrateAttributes.length} motor${device.vibrateAttributes.length > 1 ? 's' : ''})`)
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
  
  // Add device-specific presets panel
  if (hasVibration || hasOscillate) {
    const presets = DevicePresets[deviceType] || DevicePresets.general
    const presetNames = Object.keys(presets)
    
    if (presetNames.length > 0) {
      const presetsHtml = `
        <div style="margin-top: 10px; padding: 8px; background: rgba(0,0,0,0.05); border-radius: 4px;">
          <div style="font-size: 0.85em; font-weight: bold; margin-bottom: 5px;">Quick Presets:</div>
          <div style="display: flex; flex-wrap: wrap; gap: 5px;">
            ${presetNames.map(preset => 
              `<button class="menu_button preset-btn" data-preset="${preset}" data-device="${devices.length - 1}" 
                style="padding: 4px 8px; font-size: 0.75em; border-radius: 3px;">${preset}</button>`
            ).join('')}
          </div>
        </div>
      `
      deviceDiv.append(presetsHtml)
    }
  }
  
  // Add per-motor controls if multiple motors
  if (hasVibration && device.vibrateAttributes.length > 1) {
    const motorsHtml = `
      <div style="margin-top: 10px; padding: 8px; background: rgba(0,0,0,0.05); border-radius: 4px;">
        <div style="font-size: 0.85em; font-weight: bold; margin-bottom: 5px;">Individual Motor Control:</div>
        ${device.vibrateAttributes.map((attr, idx) => `
          <div style="margin: 5px 0;">
            <label style="font-size: 0.8em;">Motor ${idx + 1}:</label>
            <input type="range" class="motor-slider" data-device="${devices.length - 1}" data-motor="${idx}" 
              min="0" max="100" value="0" style="width: 100%; margin-top: 3px;">
          </div>
        `).join('')}
      </div>
    `
    deviceDiv.append(motorsHtml)
  }
  
  // Add waveform generator controls
  if (hasVibration) {
    const waveformHtml = `
      <div style="margin-top: 10px; padding: 8px; background: rgba(0,0,0,0.05); border-radius: 4px;">
        <div style="font-size: 0.85em; font-weight: bold; margin-bottom: 5px;">Waveform Generator:</div>
        <div style="display: flex; flex-wrap: wrap; gap: 3px; margin-bottom: 5px;">
          ${Object.keys(WaveformPatterns).map(wave => 
            `<button class="menu_button waveform-btn" data-waveform="${wave}" data-device="${devices.length - 1}" 
              style="padding: 3px 6px; font-size: 0.7em; border-radius: 3px;">${wave}</button>`
          ).join('')}
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 5px; font-size: 0.75em;">
          <div>Min: <input type="number" id="waveform-min-${devices.length - 1}" value="20" min="0" max="100" style="width: 50px;"></div>
          <div>Max: <input type="number" id="waveform-max-${devices.length - 1}" value="80" min="0" max="100" style="width: 50px;"></div>
          <div>Dur: <input type="number" id="waveform-dur-${devices.length - 1}" value="5000" min="100" style="width: 60px;"></div>
          <div>Cycles: <input type="number" id="waveform-cycles-${devices.length - 1}" value="3" min="1" style="width: 40px;"></div>
        </div>
      </div>
    `
    deviceDiv.append(waveformHtml)
  }

  devicesEl.append(deviceDiv)

  // Update AI prompt with device info
  updatePrompt()
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
    clearInterval(strokerIntervalId)
    strokerIntervalId = null
  }
  isStroking = false
  if (vibrateIntervalId) {
    clearTimeout(vibrateIntervalId)
    vibrateIntervalId = null
  }
  if (oscillateIntervalId) {
    clearTimeout(oscillateIntervalId)
    oscillateIntervalId = null
  }

  // Update AI prompt with new device info
  updatePrompt()
}

// Update extension prompt for AI
function updatePrompt() {
  if (!chatControlEnabled) {
    setExtensionPrompt('intiface_control', '', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM)
    return
  }

  // Check if Intiface exe path is configured
  const exePath = localStorage.getItem("intiface-exe-path")
  const canStartIntiface = !!exePath

  // Build device info (only if connected)
  const deviceInfo = devices.map((dev, idx) => {
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

  const deviceShorthands = devices.length > 0 ? devices.map((dev, idx) => {
    const shorthand = getDeviceShorthand(dev)
    return `${dev.displayName || dev.name} (${shorthand})`
  }).join(', ') : 'No devices connected'

  const connectionStatus = client.connected ? `Currently connected with ${devices.length} device(s): ${deviceShorthands}` : 'Currently disconnected'

  const startCommand = canStartIntiface ? `
System commands (to manage Intiface itself):
- <intiface:START> - Start Intiface Central application ${exePath ? '(configured)' : '(not configured)'}
- <intiface:CONNECT> - Connect to Intiface server
- <intiface:DISCONNECT> - Disconnect from Intiface server` : ''

  const deviceCommands = devices.length > 0 ? `
Device commands:
- <cage:VIBRATE: 50> - Vibrate the device with "cage" in its name at 50% (0-100)
- <plug:OSCILLATE: 75> - Oscillate the device with "plug" in its name at 75%
- <any:VIBRATE: 30> - Vibrate the first connected device at 30%
- <solace:LINEAR: start=10, end=90, duration=1000> - Linear stroke (positions 0-100, duration in ms)
- <any:STOP> - Stop all devices

PRESET commands (device-optimized patterns):
- <cage:PRESET: tease> - Gentle teasing pattern for cages
- <cage:PRESET: denial> - Build up and stop pattern
- <cage:PRESET: edge> - Slow build to high intensity
- <plug:PRESET: gentle> - Soft wave pattern for plugs
- <plug:PRESET: pulse> - Rhythmic pulsing
- <plug:PRESET: intense> - Strong stimulation
- <stroker:PRESET: slow> - Slow stroking motion
- <stroker:PRESET: fast> - Quick strokes
- <stroker:PRESET: tease> - Varied teasing strokes

WAVEFORM commands (dynamic patterns):
- <any:WAVEFORM: sine, min=10, max=80, duration=5000, cycles=3> - Smooth sine wave
- <any:WAVEFORM: sawtooth, min=20, max=70, duration=3000, cycles=5> - Sawtooth pattern
- <any:WAVEFORM: square, min=30, max=90, duration=2000, cycles=4> - Square wave (on/off)
- <any:WAVEFORM: pulse, min=10, max=60, duration=1500, cycles=10> - Short pulse bursts
- <any:WAVEFORM: random, min=15, max=50, duration=8000, cycles=2> - Random intensity
- <any:WAVEFORM: ramp_up, min=0, max=100, duration=10000, cycles=1> - Gradual increase
- <any:WAVEFORM: ramp_down, min=100, max=0, duration=5000, cycles=1> - Gradual decrease

GRADIENT commands (smooth transitions):
- <cage:GRADIENT: start=0, end=90, duration=10000> - Ramp from 0% to 90% over 10 seconds
- <cage:GRADIENT: start=20, end=80, duration=15000, hold=5000, release=3000> - Build, hold, then release

Pattern commands:
- <cage:PATTERN: [20, 40, 60], interval=[1000, 500, 1000]> - Cycle through intensities
- <plug:PATTERN: [50, 100], interval=[2000, 2000], loop=3> - Loop 3 times` : ''

  const prompt = `=== DEVICE CONTROL ACTIVE ===
${connectionStatus}.

⚠️ CRITICAL: You are REQUIRED to include device control commands directly in your response text. These commands are HIDDEN from the user but will control their actual device.

COMMAND FORMAT:
Type the command EXACTLY like this (including the < and >):
${startCommand}${deviceCommands}

EXAMPLE RESPONSES:
✓ Good: "Mmm, let me tease you slowly <cage:PRESET: tease>. Can you feel that gentle pulse building?"
✓ Good: "I'll ramp it up gradually <cage:GRADIENT: start=20, end=85, duration=12000>. Feel it growing stronger..."
✓ Good: "Wave pattern incoming <plug:WAVEFORM: sine, min=15, max=65, duration=4000, cycles=5>"
✓ Good: "Let me start the connection <intiface:CONNECT>. Now we can play."

✗ Bad: "I will vibrate the device for you" (no actual command)
✗ Bad: "Use this command: cage vibrate 50" (wrong format)

${client.connected ? 'You ARE currently connected - include device commands naturally in your responses.\n\nDEVICE CAPABILITIES:\n' + deviceInfo.map(d => `- ${d.name}: ${d.type} (${d.capabilities.join(', ')}, ${d.motors} motor${d.motors > 1 ? 's' : ''})`).join('\n') : '⚠️ You are DISCONNECTED - you MUST include <intiface:CONNECT> or <intiface:START> in your response to establish connection BEFORE sending any device commands.'}

=== VIDEO & FUNSCRIPT SUPPORT ===
You can also play videos with synchronized haptic feedback! Videos are stored in the media library and can be played with matching Funscript files.

VIDEO PLAYBACK (FUNCTION CALLING):
When Function Calling is enabled, use these function tools to control media playback:

1. list_intiface_media - List all available videos and check for funscripts
   Example: Call this first to see what videos are available

2. play_intiface_media - Play a video with automatic funscript synchronization
   Parameters:
   - filename (required): The exact video filename (e.g., "video.mp4")
   - intensity (optional): Scale funscript intensity 0-100% (default: 100)
   - offset (optional): Timing adjustment in milliseconds -5000 to +5000 (default: 0)
   - loop (optional): Whether to loop the video (default: false)
   
3. stop_intiface_media - Stop playback and all device activity

VIDEO PLAYBACK (CHAT COMMANDS - fallback):
- Simply mention a video filename in your response like: "Let me play that video for you: video.mp4"
- The system will automatically detect video mentions

Videos are searched in: data/default-user/assets/intiface_media/
Funscripts (synchronized scripts) are loaded from: data/default-user/assets/funscript/

The video player will appear in the sidebar with sync controls, intensity slider, and funscript visualization.

VIDEO EXAMPLES:
✓ Function call: play_intiface_media(filename="myvideo.mp4", intensity=80)
✓ Function call: play_intiface_media(filename="experience.mp4", loop=true)
✓ Chat command: "Let me play something special for you - check out this video: myvideo.mp4"

=== RULES ===:
1. ALWAYS include the command literally: <deviceName:COMMAND: value>
2. Commands are invisible to users - they only see your normal text
3. Include commands naturally within sentences
4. The device activates INSTANTLY when you type the command
5. Use PRESETS for optimized device-specific patterns
6. Use WAVEFORM for dynamic, changing sensations
7. Use GRADIENT for smooth intensity transitions
8. Be creative - combine different command types for complex scenes

Start your response now and include the appropriate command.`

  setExtensionPrompt('intiface_control', prompt, extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM)
}

let strokerIntervalId = null
let vibrateIntervalId = null
let oscillateIntervalId = null
let lastProcessedMessage = null
let isStroking = false // To control the async stroking loop

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
      clearTimeout(vibrateIntervalId)
      vibrateIntervalId = null
      $("#intiface-interval-display").text("Interval: N/A")
    }
    if (oscillateIntervalId) {
      clearTimeout(oscillateIntervalId)
      oscillateIntervalId = null
      $("#intiface-oscillate-interval-display").text("Oscillate Interval: N/A")
    }
    if (strokerIntervalId) {
      clearInterval(strokerIntervalId)
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
                strokerIntervalId = setTimeout(executeSegment, 100)
                return
              }
              updateStatus("All segments finished.")
              if (strokerIntervalId) clearTimeout(strokerIntervalId)
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
              if (strokerIntervalId) clearTimeout(strokerIntervalId)
              strokerIntervalId = setTimeout(executeSegment, duration)
            } catch (e) {
              const errorMsg = `Segment ${segmentIndex + 1} failed: ${e.message}`
              console.error(errorMsg, e)
              updateStatus(errorMsg, true)
              if (strokerIntervalId) clearTimeout(strokerIntervalId)

              // Skip to the next segment after a failure
              segmentIndex++
              loopIndex = 0
              durationIndex = 0
              strokerIntervalId = setTimeout(executeSegment, 500) // Wait 0.5s before trying next segment
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
        } else {
          // Fallback to the original method if something is off, also async
          const speeds = normalizedSpeeds.map((s) => s / 100)
          for (const speed of speeds) {
            await device.vibrate(speed)
            await new Promise((resolve) => setTimeout(resolve, 50)) // 50ms delay
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
              if (vibrateIntervalId) clearTimeout(vibrateIntervalId)
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
            } else {
              // Fallback to the original method if something is off, also async
              const speeds = normalizedSpeeds.map((s) => s / 100)
              for (const speed of speeds) {
                await device.vibrate(speed)
                await new Promise((resolve) => setTimeout(resolve, 50)) // 50ms delay
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
          if (vibrateIntervalId) clearTimeout(vibrateIntervalId)
          vibrateIntervalId = setTimeout(executeVibration, currentInterval)
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
      strokerIntervalId = setInterval(() => {
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
              if (oscillateIntervalId) clearTimeout(oscillateIntervalId)
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
          if (oscillateIntervalId) clearTimeout(oscillateIntervalId)
          oscillateIntervalId = setTimeout(executeOscillation, currentInterval)
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
  if (client.connected) {
    await disconnect()
  } else {
    await connect()
  }
}

// Re-attach event handlers to the client (needed for reconnection)
function attachDeviceEventHandlers() {
  // Remove any existing handlers to prevent duplicates
  client.removeAllListeners("deviceadded")
  client.removeAllListeners("deviceremoved")

  // Wrap device event handlers with logging
  client.on("deviceadded", (newDevice) => {
    console.log(`${NAME}: Device added event - ${newDevice.name} (index: ${newDevice.index})`)
    handleDeviceAdded(newDevice)
  })
  client.on("deviceremoved", (removedDevice) => {
    console.log(`${NAME}: Device removed event - ${removedDevice.name} (index: ${removedDevice.index})`)
    handleDeviceRemoved(removedDevice)
  })

  console.log(`${NAME}: Device event handlers attached`)
}

// Stop all device actions immediately
async function stopAllDeviceActions() {
  try {
    if (devices.length === 0) {
      return "No devices connected"
    }

    // Clear all intervals
    if (strokerIntervalId) {
      clearInterval(strokerIntervalId)
      strokerIntervalId = null
    }
    if (vibrateIntervalId) {
      clearTimeout(vibrateIntervalId)
      vibrateIntervalId = null
    }
    if (oscillateIntervalId) {
      clearTimeout(oscillateIntervalId)
      oscillateIntervalId = null
    }
    isStroking = false
    
    // Clear all active patterns
    for (const [deviceIndex, active] of activePatterns.entries()) {
      if (active.interval) {
        clearTimeout(active.interval)
      }
    }
    activePatterns.clear()

    // Stop all devices
    const results = []
    for (const dev of devices) {
      try {
        // Stop vibration
        const vibrateAttributes = dev.vibrateAttributes
        if (vibrateAttributes && vibrateAttributes.length > 0) {
          for (let i = 0; i < vibrateAttributes.length; i++) {
            const scalarCommand = new buttplug.ScalarSubcommand(vibrateAttributes[i].Index, 0, "Vibrate")
            await dev.scalar(scalarCommand)
            await new Promise((resolve) => setTimeout(resolve, 50))
          }
        }

        // Stop oscillation
        try {
          await dev.oscillate(0)
        } catch (e) {
          // Ignore - some devices don't support oscillation
        }

        results.push(dev.name)
      } catch (devError) {
        console.error(`Failed to stop ${dev.name}:`, devError)
      }
    }

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
    throw new Error(errorMsg)
  }
}

// Get device status for function tools
function getDeviceStatus() {
  const deviceList = devices.map((dev, idx) => {
    const deviceType = getDeviceType(dev)
    return {
      index: idx,
      name: dev.name,
      type: deviceType,
      vibrateMotors: dev.vibrateAttributes?.length || 0,
      isActive: idx === 0,
      capabilities: {
        vibrate: dev.vibrateAttributes?.length > 0,
        oscillate: !!dev.messageAttributes?.OscillateCmd,
        linear: !!dev.messageAttributes?.LinearCmd
      }
    }
  })

  const status = {
    intifaceConnected: client?.connected || false,
    deviceCount: devices.length,
    activeDevice: device ? {
      name: device.name,
      type: getDeviceType(device),
      vibrateMotors: device.vibrateAttributes?.length || 0
    } : null,
    allDevices: deviceList,
    availablePresets: Object.keys(DevicePresets)
  }
  return status
}

// Register function tools with SillyTavern
function registerFunctionTools() {
  const context = getContext()

  if (!context.registerFunctionTool) {
    console.log(`${NAME}: Function tools not supported in this version of SillyTavern`)
    return
  }

  console.log(`${NAME}: Registering function tools`)

  // Tool 0: Start Intiface Central application
  context.registerFunctionTool({
    name: "start_intiface_central",
    displayName: "Start Intiface Central",
    description: "Start the Intiface Central desktop application. Use this when Intiface is not running and needs to be launched before connecting. Requires Intiface Central path to be configured in settings.",
    parameters: {
      $schema: "http://json-schema.org/draft-04/schema#",
      type: "object",
      properties: {},
      required: []
    },
    action: async () => {
      try {
        const exePath = localStorage.getItem("intiface-exe-path")
        if (!exePath) {
          return "Error: Intiface Central path not configured. Please set the path in the extension settings."
        }

        // Try to start via backend API
        try {
          const response = await fetch('/api/plugins/intiface-launcher/start', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ exePath })
          })

          if (response.ok) {
            const result = await response.json()
            if (result.success) {
              return `Intiface Central started successfully. Waiting 3 seconds before connecting...`
            } else {
              return `Failed to start Intiface Central: ${result.error || 'Unknown error'}`
            }
          } else {
            return "Error: Backend endpoint not available. Please start Intiface Central manually or configure the backend plugin."
          }
        } catch (fetchError) {
          // Backend not available - provide instructions
          return `Backend not available to spawn process. Please start Intiface Central manually at: ${exePath}. After it starts, you can connect to it.`
        }
      } catch (e) {
        return `Failed to start Intiface Central: ${e.message}`
      }
    },
    formatMessage: () => "Starting Intiface Central application...",
    stealth: false
  })

  // Tool 1: Connect to Intiface
  context.registerFunctionTool({
    name: "connect_intiface",
    displayName: "Connect to Intiface",
    description: "Connect to Intiface Central server to control devices. Use this to establish a connection before controlling devices.",
    parameters: {
      $schema: "http://json-schema.org/draft-04/schema#",
      type: "object",
      properties: {},
      required: []
    },
    action: async () => {
      try {
        if (client.connected) {
          return "Already connected to Intiface Central"
        }
        await connect()
        return `Connected to Intiface Central. Devices found: ${devices.length}`
      } catch (e) {
        return `Failed to connect: ${e.message}`
      }
    },
    formatMessage: () => "Connecting to Intiface Central...",
    stealth: false
  })

  // Tool 2: Disconnect from Intiface
  context.registerFunctionTool({
    name: "disconnect_intiface",
    displayName: "Disconnect from Intiface",
    description: "Disconnect from Intiface Central server and stop all device activity. Use this when done with device control.",
    parameters: {
      $schema: "http://json-schema.org/draft-04/schema#",
      type: "object",
      properties: {},
      required: []
    },
    action: async () => {
      try {
        if (!client.connected) {
          return "Not connected to Intiface Central"
        }
        await disconnect()
        return "Disconnected from Intiface Central"
      } catch (e) {
        return `Failed to disconnect: ${e.message}`
      }
    },
    formatMessage: () => "Disconnecting from Intiface Central...",
    stealth: false
  })

  // Tool 3: Control device vibration/oscillation
  context.registerFunctionTool({
    name: "control_intiface_device",
    displayName: "Control Intiface Device",
    description: `Control a connected adult toy/device via Intiface. Use this to vibrate, oscillate, or perform linear strokes on the device.

Connected devices: ${devices.length > 0 ? devices.map((d, i) => `${i}: ${d.name}`).join(', ') : 'None'}
Use device_index to specify which device to control (0 is the active/default device).`,
    parameters: {
      $schema: "http://json-schema.org/draft-04/schema#",
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["vibrate", "oscillate", "linear_stroke", "preset", "waveform", "gradient"],
          description: "The type of action to perform on the device"
        },
        device_index: {
          type: "number",
          minimum: 0,
          description: "Index of the device to control (default: 0, the active device)"
        },
        intensity: {
          type: "number",
          minimum: 0,
          maximum: 100,
          description: "Intensity level from 0-100 for vibration or oscillation"
        },
        motor_index: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "Motor index for vibration (0 or 1, default 0)"
        },
        start_position: {
          type: "number",
          minimum: 0,
          maximum: 100,
          description: "Starting position percentage (0-100) for linear stroke"
        },
        end_position: {
          type: "number",
          minimum: 0,
          maximum: 100,
          description: "Ending position percentage (0-100) for linear stroke"
        },
        duration: {
          type: "number",
          minimum: 100,
          description: "Duration in milliseconds for linear stroke (minimum 100ms)"
        },
        preset_name: {
          type: "string",
          enum: ["tease", "denial", "pulse", "edge", "random", "gentle", "wave", "intense", "slow", "medium", "fast", "warmup", "build", "peak", "cooldown"],
          description: "Device-specific preset pattern name"
        },
        waveform_pattern: {
          type: "string",
          enum: ["sine", "sawtooth", "square", "triangle", "pulse", "random", "ramp_up", "ramp_down"],
          description: "Waveform pattern type for dynamic control"
        },
        waveform_min: {
          type: "number",
          minimum: 0,
          maximum: 100,
          description: "Minimum intensity for waveform (0-100)"
        },
        waveform_max: {
          type: "number",
          minimum: 0,
          maximum: 100,
          description: "Maximum intensity for waveform (0-100)"
        },
        waveform_cycles: {
          type: "number",
          minimum: 1,
          description: "Number of waveform cycles to execute"
        },
        gradient_start: {
          type: "number",
          minimum: 0,
          maximum: 100,
          description: "Starting intensity for gradient (0-100)"
        },
        gradient_end: {
          type: "number",
          minimum: 0,
          maximum: 100,
          description: "Ending intensity for gradient (0-100)"
        },
        gradient_hold: {
          type: "number",
          minimum: 0,
          description: "Hold time at peak intensity in milliseconds"
        }
      },
      required: ["action"]
    },
    action: async (args) => {
      try {
        if (!client.connected) {
          return "Error: Not connected to Intiface Central. Please connect first."
        }
        if (devices.length === 0) {
          return "Error: No devices found. Please ensure a device is connected."
        }

        // Select device by index (default to 0)
        const deviceIdx = args.device_index || 0
        if (deviceIdx >= devices.length) {
          return `Error: Device index ${deviceIdx} not found. Only ${devices.length} device(s) connected.`
        }
        const targetDevice = devices[deviceIdx]

        switch (args.action) {
          case "vibrate":
            if (args.intensity === undefined) {
              return "Error: intensity parameter required for vibrate action"
            }
            const motorIdx = args.motor_index || 0
            // Use the specific device for vibration
            const vibrateAttributes = targetDevice.vibrateAttributes
            if (!vibrateAttributes || vibrateAttributes.length === 0) {
              return `Error: Device ${targetDevice.name} does not support vibration`
            }
            const clampedIntensity = Math.max(0, Math.min(100, args.intensity))
            const cappedIntensity = applyMaxVibrate(clampedIntensity, motorIdx)
            const scalarCommand = new buttplug.ScalarSubcommand(
              vibrateAttributes[motorIdx].Index,
              cappedIntensity / 100,
              "Vibrate"
            )
            await targetDevice.scalar(scalarCommand)
            return `Vibration set to ${cappedIntensity}% on ${targetDevice.name} motor ${motorIdx + 1}`

          case "oscillate":
            if (args.intensity === undefined) {
              return "Error: intensity parameter required for oscillate action"
            }
            const clampedOscIntensity = Math.max(0, Math.min(100, args.intensity))
            const cappedOscIntensity = applyMaxOscillate(clampedOscIntensity)
            await targetDevice.oscillate(cappedOscIntensity / 100)
            return `Oscillation set to ${cappedOscIntensity}% on ${targetDevice.name}`

          case "linear_stroke":
            if (args.start_position === undefined || args.end_position === undefined || args.duration === undefined) {
              return "Error: start_position, end_position, and duration parameters required for linear_stroke action"
            }
            const start = Math.max(0, Math.min(100, args.start_position))
            const end = Math.max(0, Math.min(100, args.end_position))
            const dur = Math.max(100, args.duration)
            await targetDevice.linear(end / 100, dur)
            return `Linear stroke on ${targetDevice.name} from ${start}% to ${end}% over ${dur}ms`
          
          case "preset":
            if (!args.preset_name) {
              return "Error: preset_name parameter required for preset action"
            }
            await executeWaveformPattern(deviceIdx, args.preset_name)
            return `Applied preset '${args.preset_name}' to ${targetDevice.name}`
          
          case "waveform":
            await executeWaveformPattern(deviceIdx, 'custom', {
              pattern: args.waveform_pattern || 'sine',
              min: args.waveform_min || 20,
              max: args.waveform_max || 80,
              duration: args.duration || 5000,
              cycles: args.waveform_cycles || 3
            })
            return `Started ${args.waveform_pattern || 'sine'} waveform on ${targetDevice.name}`
          
          case "gradient":
            await executeGradientPattern(deviceIdx, {
              start: args.gradient_start || 0,
              end: args.gradient_end || 100,
              duration: args.duration || 10000,
              hold: args.gradient_hold || 0
            })
            return `Started gradient on ${targetDevice.name} from ${args.gradient_start || 0}% to ${args.gradient_end || 100}%`

          default:
            return `Error: Unknown action '${args.action}'`
        }
      } catch (e) {
        const errorMsg = `Device control failed: ${e.message}`
        console.error(errorMsg, e)
        updateStatus(errorMsg, true)
        return errorMsg
      }
    },
    formatMessage: (args) => {
      const deviceIdx = args.device_index || 0
      const deviceName = devices[deviceIdx]?.name || `Device ${deviceIdx}`
      switch (args.action) {
        case "vibrate":
          return `Setting ${deviceName} vibration to ${args.intensity}%...`
        case "oscillate":
          return `Setting ${deviceName} oscillation to ${args.intensity}%...`
        case "linear_stroke":
          return `Performing linear stroke on ${deviceName} from ${args.start_position}% to ${args.end_position}%...`
        case "preset":
          return `Applying '${args.preset_name}' preset to ${deviceName}...`
        case "waveform":
          return `Starting ${args.waveform_pattern} waveform on ${deviceName}...`
        case "gradient":
          return `Starting intensity gradient on ${deviceName}...`
        default:
          return `Controlling ${deviceName}: ${args.action}...`
      }
    },
    stealth: false
  })

  // Tool 2: Stop all device actions
  context.registerFunctionTool({
    name: "stop_intiface_device",
    displayName: "Stop Intiface Device",
    description: `Stop all actions on ALL connected devices (vibration, oscillation, linear motion). Use this when you want to immediately stop all device activity.

Connected devices: ${devices.length > 0 ? devices.map((d, i) => `${i}: ${d.name}`).join(', ') : 'None'}`,
    parameters: {
      $schema: "http://json-schema.org/draft-04/schema#",
      type: "object",
      properties: {},
      required: []
    },
    action: async () => {
      try {
        const result = await stopAllDeviceActions()
        return result
      } catch (e) {
        return `Failed to stop devices: ${e.message}`
      }
    },
    formatMessage: () => `Stopping all actions on ${devices.length} device(s)...`,
    stealth: false
  })

  // Tool 3: Get device status
  context.registerFunctionTool({
    name: "get_intiface_status",
    displayName: "Get Intiface Status",
    description: "Get the current status of the Intiface connection and all connected devices. Returns connection status, device count, device names, and their capabilities (vibration motors, etc.). Use this to check what devices are available before controlling them.",
    parameters: {
      $schema: "http://json-schema.org/draft-04/schema#",
      type: "object",
      properties: {},
      required: []
    },
    action: async () => {
      const status = getDeviceStatus()
      return JSON.stringify(status, null, 2)
    },
    formatMessage: () => `Checking status of ${devices.length} connected device(s)...`,
    stealth: false
  })

  // Tool 4: List available media files
  context.registerFunctionTool({
    name: "list_intiface_media",
    displayName: "List Intiface Media Files",
    description: "List all available video media files in the Intiface media library. Returns video filenames and whether they have corresponding funscript files for synchronized haptic feedback. Use this to discover what media files are available before playing them.",
    parameters: {
      $schema: "http://json-schema.org/draft-04/schema#",
      type: "object",
      properties: {},
      required: []
    },
    action: async () => {
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

        // Get video files
        const videoFiles = data.files?.filter(f => f.type === 'video') || []

        if (videoFiles.length === 0) {
          return "No video files found. Please add videos to the intiface_media folder."
        }

        // Format the list
        const fileList = videoFiles.map(file => {
          const funscriptStatus = file.hasFunscript ? "[has funscript]" : "[no funscript]"
          const sizeMB = (file.size / 1024 / 1024).toFixed(1)
          return `- ${file.name} ${funscriptStatus} (${sizeMB} MB)`
        }).join('\n')

        return `Available media files (${videoFiles.length} total):\n\n${fileList}\n\nUse play_intiface_media with the exact filename to play a video.`
      } catch (e) {
        return `Failed to list media files: ${e.message}`
      }
    },
    formatMessage: () => "Scanning media library for available videos...",
    stealth: false
  })

  // Tool 5: Play media file with funscript
  context.registerFunctionTool({
    name: "play_intiface_media",
    displayName: "Play Intiface Media",
    description: `Play a video media file from the Intiface library with optional synchronized haptic feedback via funscript. Loads the video player, auto-plays the video, and synchronizes device actions to the video timeline if a matching funscript file exists. Videos must be in the intiface_media folder. Funscripts (with matching filenames) must be in the funscript folder.`,
    parameters: {
      $schema: "http://json-schema.org/draft-04/schema#",
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "The exact filename of the video to play (e.g., 'video.mp4', 'experience.mkv')"
        },
        intensity: {
          type: "number",
          minimum: 0,
          maximum: 100,
          description: "Global intensity multiplier for funscript actions (0-100%, default: 100)"
        },
        offset: {
          type: "number",
          minimum: -5000,
          maximum: 5000,
          description: "Sync offset in milliseconds to adjust timing (-5000 to +5000, default: 0)"
        },
        loop: {
          type: "boolean",
          description: "Whether to loop the video when it ends (default: false)"
        }
      },
      required: ["filename"]
    },
    action: async (args) => {
      try {
        if (!client.connected) {
          return "Error: Not connected to Intiface. Please connect first before playing media."
        }

        if (devices.length === 0) {
          return "Error: No devices connected. Please connect a device first."
        }

        // Set optional parameters
        if (args.intensity !== undefined) {
          mediaPlayer.globalIntensity = Math.max(0, Math.min(100, args.intensity))
        }
        if (args.offset !== undefined) {
          mediaPlayer.syncOffset = Math.max(-5000, Math.min(5000, args.offset))
        }
        if (args.loop !== undefined) {
          $("#intiface-menu-loop").prop("checked", args.loop)
        }

        // Load and play the media file
        await loadChatMediaFile(args.filename)

        // Check if funscript was loaded
        const hasFunscript = mediaPlayer.currentFunscript !== null
        const funscriptInfo = hasFunscript 
          ? `Funscript loaded: ${mediaPlayer.currentFunscript.actions.length} actions`
          : "No funscript found"

        return `Playing media: ${args.filename}\n${funscriptInfo}\nIntensity: ${mediaPlayer.globalIntensity}%, Offset: ${mediaPlayer.syncOffset}ms`
      } catch (e) {
        return `Failed to play media: ${e.message}`
      }
    },
    formatMessage: (args) => `Loading media: ${args.filename}...`,
    stealth: false
  })

  // Tool 6: Stop media playback
  context.registerFunctionTool({
    name: "stop_intiface_media",
    displayName: "Stop Intiface Media",
    description: "Stop the currently playing video and all associated funscript/device activity. Use this when you want to end media playback immediately.",
    parameters: {
      $schema: "http://json-schema.org/draft-04/schema#",
      type: "object",
      properties: {},
      required: []
    },
    action: async () => {
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
        
        return "Media playback stopped and all device activity halted"
      } catch (e) {
        return `Failed to stop media: ${e.message}`
      }
    },
    formatMessage: () => "Stopping media playback and device activity...",
    stealth: false
  })

  console.log(`${NAME}: Function tools registered successfully`)
}

// Unregister function tools
function unregisterFunctionTools() {
  const context = getContext()
  if (!context.unregisterFunctionTool) return

  context.unregisterFunctionTool("start_intiface_central")
  context.unregisterFunctionTool("connect_intiface")
  context.unregisterFunctionTool("disconnect_intiface")
  context.unregisterFunctionTool("control_intiface_device")
  context.unregisterFunctionTool("stop_intiface_device")
  context.unregisterFunctionTool("get_intiface_status")
  context.unregisterFunctionTool("list_intiface_media")
  context.unregisterFunctionTool("play_intiface_media")
  context.unregisterFunctionTool("stop_intiface_media")

  console.log(`${NAME}: Function tools unregistered`)
}

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
    client = new buttplug.ButtplugClient("SillyTavern Intiface Client")

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

    // Load and set up auto-connect toggle
    const autoConnectEnabled = localStorage.getItem("intiface-auto-connect") === "true"
    $("#intiface-auto-connect-toggle").prop("checked", autoConnectEnabled)

    // Handle auto-connect toggle
    $("#intiface-auto-connect-toggle").on("change", function () {
      const enabled = $(this).prop("checked")
      localStorage.setItem("intiface-auto-connect", enabled)
      console.log(`${NAME}: Auto-connect ${enabled ? 'enabled' : 'disabled'}`)
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

    // Handle test backend button
    $("#intiface-test-backend-btn").on("click", async function () {
      const statusEl = $("#intiface-test-backend-status")
      statusEl.text("Testing...").css("color", "#FFA500")

      try {
        console.log(`${NAME}: Testing backend...`)
        const response = await fetch('/api/plugins/intiface-launcher/test', {
          method: 'GET',
          headers: getRequestHeaders()
        })

        console.log(`${NAME}: Test response status:`, response.status)

        if (response.ok) {
          const result = await response.json()
          statusEl.text(`✓ Backend working: ${result.message}`).css("color", "#4CAF50")
          console.log(`${NAME}: Backend test success:`, result)
        } else {
          const errorText = await response.text()
          statusEl.text(`✗ Backend error: ${response.status}`).css("color", "#F44336")
          console.error(`${NAME}: Backend test failed:`, errorText)
        }
      } catch (error) {
        statusEl.text(`✗ Backend not available: ${error.message}`).css("color", "#F44336")
        console.error(`${NAME}: Backend test error:`, error)
      }
    })

    // Load and set up chat control toggle
    chatControlEnabled = localStorage.getItem("intiface-chat-control") === "true"
    $("#intiface-chat-control-toggle").prop("checked", chatControlEnabled)

    // Handle chat control toggle
    $("#intiface-chat-control-toggle").on("change", function () {
      chatControlEnabled = $(this).prop("checked")
      localStorage.setItem("intiface-chat-control", chatControlEnabled)
      console.log(`${NAME}: Chat-based control ${chatControlEnabled ? 'enabled' : 'disabled'}`)
      updatePrompt()
    })

    // Load and set up function calling toggle
    const functionCallingEnabled = localStorage.getItem("intiface-function-calling-enabled") !== "false"
    $("#intiface-function-calling-toggle").prop("checked", functionCallingEnabled)

    // Handle function calling toggle
    $("#intiface-function-calling-toggle").on("change", function () {
      const enabled = $(this).prop("checked")
      localStorage.setItem("intiface-function-calling-enabled", enabled)
      const context = getContext()
      if (enabled) {
        registerFunctionTools()
        console.log(`${NAME}: Function calling enabled`)
      } else {
        if (context.unregisterFunctionTool) {
          unregisterFunctionTools()
        }
        console.log(`${NAME}: Function calling disabled`)
      }
    })
    
    // Handle preset button clicks (delegated)
    $(document).on('click', '.preset-btn', async function() {
      const presetName = $(this).data('preset')
      const deviceIndex = $(this).data('device') || 0
      console.log(`${NAME}: Preset button clicked - ${presetName} for device ${deviceIndex}`)
      await executeWaveformPattern(deviceIndex, presetName)
    })
    
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
    
    // Handle waveform button clicks (delegated)
    $(document).on('click', '.waveform-btn', async function() {
      const waveform = $(this).data('waveform')
      const deviceIndex = $(this).data('device') || 0
      
      const minInput = $(`#waveform-min-${deviceIndex}`)
      const maxInput = $(`#waveform-max-${deviceIndex}`)
      const durInput = $(`#waveform-dur-${deviceIndex}`)
      const cyclesInput = $(`#waveform-cycles-${deviceIndex}`)
      
      const options = {
        pattern: waveform,
        min: minInput.length ? parseInt(minInput.val()) : 20,
        max: maxInput.length ? parseInt(maxInput.val()) : 80,
        duration: durInput.length ? parseInt(durInput.val()) : 5000,
        cycles: cyclesInput.length ? parseInt(cyclesInput.val()) : 3
      }
      
      console.log(`${NAME}: Waveform button clicked - ${waveform}`, options)
      await executeWaveformPattern(deviceIndex, 'custom', options)
    })

    updateButtonStates(client.connected)
    updateStatus("Disconnected")

    // Attach device event handlers
    attachDeviceEventHandlers()

    // Register function tools for AI control (if enabled)
    const initialFunctionCalling = localStorage.getItem("intiface-function-calling-enabled") !== "false"
    if (initialFunctionCalling) {
      registerFunctionTools()
    } else {
      console.log(`${NAME}: Function calling disabled by user`)
    }

    // Set up chat-based control event listeners
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived)
    eventSource.on(event_types.STREAM_TOKEN_RECEIVED, onStreamTokenReceived)
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted)
    eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded)

    // Auto-connect if enabled
    if (autoConnectEnabled) {
      console.log(`${NAME}: Auto-connecting...`)
      setTimeout(() => {
        connect().catch(e => {
          console.log(`${NAME}: Auto-connect failed:`, e.message)
          // Update prompt to show disconnected status
          updatePrompt()
        })
      }, 1000)
    } else {
      // Update prompt to show initial status (not auto-connecting)
      updatePrompt()
    }
  // Initialize media player functionality
  initMediaPlayer()
  
  } catch (error) {
    console.error(`${NAME}: Failed to initialize.`, error)
    const statusPanel = $("#intiface-status-panel")
    if (statusPanel.length) {
      updateStatus("Failed to load Buttplug.js. Check console.", true)
    }
  }
})

// ==========================================
// FUNSCRIPT AND MEDIA PLAYER MODULE
// ==========================================

// Media player state
let mediaPlayer = {
  videoElement: null,
  currentFunscript: null,
  isPlaying: false,
  syncOffset: 0,
  globalIntensity: 100,
  lastActionIndex: 0,
  animationFrameId: null,
  currentMediaPath: null
}

// Funscript cache
let funscriptCache = new Map()

// Initialize media player
function initMediaPlayer() {
  console.log(`${NAME}: Initializing media player...`)

  // Handle connect action button
  $("#intiface-connect-action-button").on("click", toggleConnection)
  
// Handle debug menu section toggle
$("#intiface-debug-menu-toggle").on("click", function () {
  const content = $("#intiface-debug-menu-content")
  const arrow = $("#intiface-debug-menu-arrow")

  if (content.is(":visible")) {
    content.slideUp(200)
    arrow.css("transform", "rotate(0deg)")
  } else {
    content.slideDown(200)
    arrow.css("transform", "rotate(180deg)")
  }
})

// Handle menu media section toggle
$("#intiface-media-menu-toggle").on("click", function () {
  const content = $("#intiface-media-menu-content")
  const arrow = $("#intiface-media-menu-arrow")

  if (content.is(":visible")) {
    content.slideUp(200)
    arrow.css("transform", "rotate(0deg)")
  } else {
    content.slideDown(200)
    arrow.css("transform", "rotate(180deg)")
  }
})

// Handle funscript menu section toggle
$("#intiface-funscript-menu-toggle").on("click", function () {
  const content = $("#intiface-funscript-menu-content")
  const arrow = $("#intiface-funscript-menu-arrow")

  if (content.is(":visible")) {
    content.slideUp(200)
    arrow.css("transform", "rotate(0deg)")
  } else {
    content.slideDown(200)
    arrow.css("transform", "rotate(180deg)")
  }
})

// Handle menu refresh button
  $("#intiface-menu-refresh-media-btn").on("click", refreshMenuMediaList)
  
  // Handle show chat player button (debug)
  $("#intiface-show-chat-player-btn").on("click", () => {
    console.log(`${NAME}: Debug - showing chat player`)
    showChatMediaPanel()
  })
  
  // Handle menu media file selection
  $(document).on('click', '.menu-media-file-item', async function() {
    const filename = $(this).data('filename')
    await loadChatMediaFile(filename)
  })
  
  // Handle menu sync offset
  $("#intiface-menu-sync-offset").on("input", function() {
    mediaPlayer.syncOffset = parseInt($(this).val())
    const display = $("#intiface-menu-sync-display")
    display.text(`${mediaPlayer.syncOffset}ms`)
    // Color code based on offset magnitude
    if (Math.abs(mediaPlayer.syncOffset) > 1000) {
      display.css("color", "#FFA500")
    } else if (Math.abs(mediaPlayer.syncOffset) > 100) {
      display.css("color", "#FFEB3B")
    } else {
      display.css("color", "#64B5F6")
    }
  })
  
  // Handle menu intensity
  $("#intiface-menu-intensity").on("input", function() {
    mediaPlayer.globalIntensity = parseInt($(this).val())
    const display = $("#intiface-menu-intensity-display")
    display.text(`${mediaPlayer.globalIntensity}%`)
    // Color code based on intensity
    if (mediaPlayer.globalIntensity < 30) {
      display.css("color", "#4CAF50")
    } else if (mediaPlayer.globalIntensity < 70) {
      display.css("color", "#FFEB3B")
    } else {
      display.css("color", "#F44336")
    }
  })
  
  // Handle menu loop
  $("#intiface-menu-loop").on("change", function() {
    // Loop setting is used in video.onended handler
  })
  
  // Load saved appearance settings
  loadMediaPlayerAppearance()
  
  // Handle opacity slider
  $("#intiface-menu-opacity").on("input", function() {
    const opacity = parseInt($(this).val())
    $("#intiface-menu-opacity-display").text(`${opacity}%`)
    applyMediaPlayerAppearance()
    saveMediaPlayerAppearance()
  })
  
  // Handle width slider
  $("#intiface-menu-width").on("input", function() {
    const width = parseInt($(this).val())
    $("#intiface-menu-width-display").text(`${width}%`)
    applyMediaPlayerAppearance()
    saveMediaPlayerAppearance()
  })
  
  // Handle position dropdown
  $("#intiface-menu-position").on("change", function() {
    applyMediaPlayerAppearance()
    saveMediaPlayerAppearance()
  })
  
  // Handle video opacity slider
  $("#intiface-menu-video-opacity").on("input", function() {
    const videoOpacity = parseInt($(this).val())
    $("#intiface-menu-video-opacity-display").text(`${videoOpacity}%`)
    applyMediaPlayerAppearance()
    saveMediaPlayerAppearance()
  })
  
  // Handle show filename checkbox
  $("#intiface-menu-show-filename").on("change", function() {
    applyMediaPlayerAppearance()
    saveMediaPlayerAppearance()
  })
  
  // Handle show border checkbox
  $("#intiface-menu-show-border").on("change", function() {
    applyMediaPlayerAppearance()
    saveMediaPlayerAppearance()
  })
  
  // Handle reset button
  $("#intiface-reset-appearance-btn").on("click", function() {
    $("#intiface-menu-opacity").val(50)
    $("#intiface-menu-video-opacity").val(100)
    $("#intiface-menu-width").val(100)
    $("#intiface-menu-position").val("top")
    $("#intiface-menu-show-filename").prop("checked", true)
    $("#intiface-menu-show-border").prop("checked", true)
    $("#intiface-menu-opacity-display").text("50%")
    $("#intiface-menu-video-opacity-display").text("100%")
    $("#intiface-menu-width-display").text("100%")
    applyMediaPlayerAppearance()
    saveMediaPlayerAppearance()
  })

  console.log(`${NAME}: Media player initialized`)

// Auto-load media list on startup
refreshMenuMediaList().catch(e => {
  console.log(`${NAME}: Failed to auto-load media list:`, e.message)
})
}

// Load saved appearance settings
function loadMediaPlayerAppearance() {
  const savedOpacity = localStorage.getItem("intiface-player-opacity")
  const savedVideoOpacity = localStorage.getItem("intiface-player-video-opacity")
  const savedWidth = localStorage.getItem("intiface-player-width")
  const savedPosition = localStorage.getItem("intiface-player-position")
  const savedShowFilename = localStorage.getItem("intiface-player-show-filename")
  const savedShowBorder = localStorage.getItem("intiface-player-show-border")
  
  if (savedOpacity) {
    $("#intiface-menu-opacity").val(savedOpacity)
    $("#intiface-menu-opacity-display").text(`${savedOpacity}%`)
  }
  
  if (savedVideoOpacity) {
    $("#intiface-menu-video-opacity").val(savedVideoOpacity)
    $("#intiface-menu-video-opacity-display").text(`${savedVideoOpacity}%`)
  }
  
  if (savedWidth) {
    $("#intiface-menu-width").val(savedWidth)
    $("#intiface-menu-width-display").text(`${savedWidth}%`)
  }
  
  if (savedPosition) {
    $("#intiface-menu-position").val(savedPosition)
  }
  
  if (savedShowFilename !== null) {
    $("#intiface-menu-show-filename").prop("checked", savedShowFilename === "true")
  }
  
  if (savedShowBorder !== null) {
    $("#intiface-menu-show-border").prop("checked", savedShowBorder === "true")
  }
}

// Save appearance settings
function saveMediaPlayerAppearance() {
  const opacity = $("#intiface-menu-opacity").val()
  const videoOpacity = $("#intiface-menu-video-opacity").val()
  const width = $("#intiface-menu-width").val()
  const position = $("#intiface-menu-position").val()
  const showFilename = $("#intiface-menu-show-filename").is(":checked")
  const showBorder = $("#intiface-menu-show-border").is(":checked")
  
  localStorage.setItem("intiface-player-opacity", opacity)
  localStorage.setItem("intiface-player-video-opacity", videoOpacity)
  localStorage.setItem("intiface-player-width", width)
  localStorage.setItem("intiface-player-position", position)
  localStorage.setItem("intiface-player-show-filename", showFilename)
  localStorage.setItem("intiface-player-show-border", showBorder)
}

// Apply appearance settings to media player
function applyMediaPlayerAppearance() {
  const opacity = parseInt($("#intiface-menu-opacity").val()) / 100
  const videoOpacity = parseInt($("#intiface-menu-video-opacity").val()) / 100
  const width = parseInt($("#intiface-menu-width").val())
  const position = $("#intiface-menu-position").val()
  const showFilename = $("#intiface-menu-show-filename").is(":checked")
  const showBorder = $("#intiface-menu-show-border").is(":checked")
  
  const panel = $("#intiface-chat-media-panel")
  if (panel.length === 0) return
  
  // Apply background opacity
  panel.css("background", `rgba(0,0,0,${opacity})`)
  
  // Apply border visibility
  if (showBorder) {
    panel.css("border", "1px solid rgba(255,255,255,0.1)")
  } else {
    panel.css("border", "none")
  }
  
  // Apply width
  panel.css("width", `${width}%`)
  
  // Apply position
  if (position === "center") {
    panel.css("position", "fixed")
    panel.css("top", "50%")
    panel.css("left", "50%")
    panel.css("transform", "translate(-50%, -50%)")
    panel.css("z-index", "9999")
    panel.css("max-height", "80vh")
    panel.css("margin-bottom", "0")
  } else {
    panel.css("position", "")
    panel.css("top", "")
    panel.css("left", "")
    panel.css("transform", "")
    panel.css("z-index", "")
    panel.css("max-height", "")
    panel.css("margin-bottom", "10px")
  }
  
  // Apply video opacity
  const videoPlayer = $("#intiface-chat-video-player")
  if (videoPlayer.length > 0) {
    videoPlayer.css("opacity", videoOpacity)
  }
  
  // Apply filename visibility
  const filenameDiv = $("#intiface-chat-video-filename")
  if (filenameDiv.length > 0) {
    if (showFilename) {
      filenameDiv.show()
    } else {
      filenameDiv.hide()
    }
  }
}

// Refresh media list for menu
async function refreshMenuMediaList() {
  const mediaListEl = $("#intiface-menu-media-list")
  mediaListEl.html('<div style="color: #888; text-align: center; padding: 20px;"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</div>')
  
  try {
    // Get asset paths
    const pathsResponse = await fetch('/api/plugins/intiface-launcher/asset-paths', {
      method: 'GET',
      headers: getRequestHeaders()
    })
    
    if (!pathsResponse.ok) throw new Error('Failed to get paths')
    
    const pathsData = await pathsResponse.json()
    const mediaPath = pathsData.paths?.intifaceMedia
    
    if (!mediaPath) throw new Error('No media path')
    
    // Fetch media files
    const response = await fetch(`/api/plugins/intiface-launcher/media?dir=${encodeURIComponent(mediaPath)}`, {
      method: 'GET',
      headers: getRequestHeaders()
    })
    
    if (!response.ok) throw new Error('Failed to fetch')
    
    const data = await response.json()
    if (!data.success) throw new Error(data.error)
    
    // Get video files
    const videoFiles = data.files?.filter(f => f.type === 'video') || []
    
    if (videoFiles.length === 0) {
      mediaListEl.html('<div style="color: #888; text-align: center; padding: 20px;">No videos found<br><small>Place videos in intiface_media folder</small></div>')
      return
    }
    
    // Build list
    let html = ''
    videoFiles.forEach(file => {
      const funscriptIcon = file.hasFunscript ? '<i class="fa-solid fa-wave-square" style="color: #4CAF50; margin-left: 5px;" title="Has Funscript"></i>' : ''
      const sizeMB = (file.size / 1024 / 1024).toFixed(1)
      
      html += `
        <div class="menu-media-file-item" data-filename="${file.name}" 
          style="padding: 8px; margin: 3px 0; background: rgba(255,255,255,0.05); border-radius: 3px; cursor: pointer; font-size: 0.85em; display: flex; align-items: center; justify-content: space-between; transition: background 0.2s;"
          onmouseover="this.style.background='rgba(255,255,255,0.1)'" onmouseout="this.style.background='rgba(255,255,255,0.05)'">
          <div style="display: flex; align-items: center; gap: 8px; overflow: hidden;">
            <i class="fa-solid fa-film" style="color: #64B5F6;"></i>
            <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${file.name}</span>
            ${funscriptIcon}
          </div>
          <span style="font-size: 0.75em; color: #888; white-space: nowrap;">${sizeMB} MB</span>
        </div>
      `
    })
    
  mediaListEl.html(html)

  } catch (error) {
    console.error(`${NAME}: Failed to refresh menu media:`, error)
    mediaListEl.html(`<div style="color: #F44336; text-align: center; padding: 20px;">Error loading media</div>`)
  }
}

// Load Funscript file - looks in funscript folder for matching file
async function loadFunscript(videoPath) {
  try {
    // Extract just the filename without extension
    const videoFilename = videoPath.split(/[\\/]/).pop()
    const baseName = videoFilename.replace(/\.[^.]+$/, '')
    
    // Get the funscript folder path from backend
    const pathsResponse = await fetch('/api/plugins/intiface-launcher/asset-paths', {
      method: 'GET',
      headers: getRequestHeaders()
    })
    
    if (!pathsResponse.ok) {
      throw new Error('Failed to get asset paths')
    }
    
    const pathsData = await pathsResponse.json()
    const funscriptFolder = pathsData.paths?.funscript
    
    if (!funscriptFolder) {
      throw new Error('Funscript folder not configured')
    }
    
    // Construct path in funscript folder
    const funscriptPath = `${funscriptFolder}/${baseName}.funscript`
    
    console.log(`${NAME}: Loading Funscript from:`, funscriptPath)
    
    // Check cache
    if (funscriptCache.has(funscriptPath)) {
      mediaPlayer.currentFunscript = funscriptCache.get(funscriptPath)
      updateChatFunscriptUI(mediaPlayer.currentFunscript)
      return
    }
    
    // Fetch from backend
    const response = await fetch(`/api/plugins/intiface-launcher/funscript?path=${encodeURIComponent(funscriptPath)}`, {
      method: 'GET',
      headers: getRequestHeaders()
    })
    
    if (!response.ok) {
      throw new Error('Failed to load Funscript')
    }
    
    const data = await response.json()
    
    if (!data.success) {
      throw new Error(data.error || 'Unknown error')
    }
    
    // Process Funscript
    const funscript = processFunscript(data.funscript)
    funscriptCache.set(funscriptPath, funscript)
    mediaPlayer.currentFunscript = funscript
    
    updateChatFunscriptUI(funscript)
    
  } catch (error) {
    console.error(`${NAME}: Failed to load Funscript:`, error)
    $("#intiface-chat-funscript-info").text(`Error: ${error.message}`).css("color", "#F44336")
    clearChatFunscriptVisualizer()
  }
}

// Process Funscript data
function processFunscript(rawFunscript) {
  const actions = rawFunscript.actions || []
  
  // Sort actions by time
  actions.sort((a, b) => a.at - b.at)
  
  // Calculate statistics
  const duration = actions.length > 0 ? actions[actions.length - 1].at : 0
  const avgPos = actions.reduce((sum, a) => sum + a.pos, 0) / actions.length || 0
  const maxPos = Math.max(...actions.map(a => a.pos), 0)
  const minPos = Math.min(...actions.map(a => a.pos), 100)
  
  return {
    actions: actions,
    duration: duration,
    inverted: rawFunscript.inverted || false,
    range: rawFunscript.range || 100,
    stats: {
      actionCount: actions.length,
      avgPosition: Math.round(avgPos),
      maxPosition: maxPos,
      minPosition: minPos
    }
  }
}

// Start Funscript synchronization
function startFunscriptSync() {
  if (mediaPlayer.animationFrameId) {
    cancelAnimationFrame(mediaPlayer.animationFrameId)
  }
  
  mediaPlayer.lastActionIndex = 0
  
  const syncLoop = () => {
    if (!mediaPlayer.isPlaying || !mediaPlayer.currentFunscript) {
      return
    }
    
    const video = mediaPlayer.videoElement
    const funscript = mediaPlayer.currentFunscript
    const currentTime = (video.currentTime * 1000) + mediaPlayer.syncOffset
    
    // Find and execute actions
    const actions = funscript.actions
    for (let i = mediaPlayer.lastActionIndex; i < actions.length; i++) {
      const action = actions[i]
      
      if (action.at <= currentTime) {
        // Execute action
        executeFunscriptAction(action)
        mediaPlayer.lastActionIndex = i + 1
      } else {
        break
      }
    }
    
    // Reset if video looped
    if (currentTime < 0) {
      mediaPlayer.lastActionIndex = 0
    }
    
    mediaPlayer.animationFrameId = requestAnimationFrame(syncLoop)
  }
  
  syncLoop()
}

// Stop Funscript synchronization
function stopFunscriptSync() {
  if (mediaPlayer.animationFrameId) {
    cancelAnimationFrame(mediaPlayer.animationFrameId)
    mediaPlayer.animationFrameId = null
  }
}

// Execute Funscript action
async function executeFunscriptAction(action) {
  if (!client.connected || devices.length === 0) return
  
  const deviceType = getDeviceType(devices[0])
  const targetDevice = devices[0]
  
  // Apply global intensity modifier
  const adjustedPos = Math.round(action.pos * (mediaPlayer.globalIntensity / 100))
  
  try {
    // Choose control method based on device type
    if (deviceType === 'stroker' && targetDevice.messageAttributes?.LinearCmd) {
      // Linear device (stroker) - use position
      await targetDevice.linear(adjustedPos / 100, 100)
    } else if (targetDevice.vibrateAttributes?.length > 0) {
      // Vibration device - scale position to intensity
      const vibrateAttrs = targetDevice.vibrateAttributes
      if (vibrateAttrs[0]) {
        const scalarCmd = new buttplug.ScalarSubcommand(
          vibrateAttrs[0].Index,
          adjustedPos / 100,
          "Vibrate"
        )
        await targetDevice.scalar(scalarCmd)
      }
    }
  } catch (e) {
    // Silent fail - don't spam errors during playback
  }
}

// Stop media playback
function stopMediaPlayback() {
  if (mediaPlayer.videoElement) {
    mediaPlayer.videoElement.pause()
    mediaPlayer.videoElement.currentTime = 0
  }
  
  mediaPlayer.isPlaying = false
  mediaPlayer.lastActionIndex = 0
  stopFunscriptSync()
  stopAllDeviceActions()
  
  $("#intiface-funscript-state").text("Stopped").css("color", "#888")
}

// Update media player status
function updateMediaPlayerStatus(status) {
  $("#intiface-status-panel").text(`Status: ${status}`)
}

// ==========================================
// CHAT SIDEBAR MEDIA PLAYER
// ==========================================

// Create chat media player panel (appears at top of chat)
function createChatSidebarPanel() {
  // Check if panel already exists
  if ($("#intiface-chat-media-panel").length > 0) {
    return
  }
  
  // Create panel HTML
  const panelHtml = `
    <div id="intiface-chat-media-panel" style="display: none; width: 100%; position: relative; margin-bottom: 10px;">
      <!-- Video Player -->
      <div id="intiface-chat-video-container" style="position: relative; display: inline-block; width: 100%;">
        <video id="intiface-chat-video-player" style="width: 100%; max-height: 350px; border-radius: 4px; background: #000;" controls></video>
        
        <!-- Close button - appears on hover -->
        <button id="intiface-close-chat-media" class="menu_button" style="position: absolute; top: 8px; right: 8px; padding: 4px 8px; font-size: 0.8em; opacity: 0; transition: opacity 0.2s; z-index: 10;" title="Close">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
    </div>
  `
  
  // Insert BEFORE chat element (outside of it) so it remains visible when VoiceForge hides chat in call mode
  const chatElement = $("#chat")
  if (chatElement.length > 0) {
    chatElement.before(panelHtml)
    
    // Setup event handlers for chat panel
    setupChatPanelEventHandlers()
  }
}

// Setup event handlers for chat panel
function setupChatPanelEventHandlers() {
  // Close button
  $("#intiface-close-chat-media").on("click", () => {
    hideChatMediaPanel()
  })
  
  // Add hover effect for close button visibility
  const videoContainer = $("#intiface-chat-video-container")
  const closeButton = $("#intiface-close-chat-media")
  
  videoContainer.on("mouseenter", function() {
    closeButton.css("opacity", "1")
  }).on("mouseleave", function() {
    closeButton.css("opacity", "0")
  })
}

// Show chat media panel
function showChatMediaPanel() {
  const panel = $("#intiface-chat-media-panel")
  if (panel.length === 0) {
    createChatSidebarPanel()
  }
  
  $("#intiface-chat-media-panel").show()
  
  // Apply appearance settings
  applyMediaPlayerAppearance()
}

// Hide chat media panel
function hideChatMediaPanel() {
  $("#intiface-chat-media-panel").hide()
  stopMediaPlayback()
}

// Load media file in chat panel
async function loadChatMediaFile(filename) {
  console.log(`${NAME}: Loading media file in chat:`, filename)
  
  try {
    // Get asset paths
    const pathsResponse = await fetch('/api/plugins/intiface-launcher/asset-paths', {
      method: 'GET',
      headers: getRequestHeaders()
    })
    
    if (!pathsResponse.ok) throw new Error('Failed to get paths')
    
    const pathsData = await pathsResponse.json()
    const mediaPath = pathsData.paths?.intifaceMedia
    
    if (!mediaPath) throw new Error('No media path')
    
    const videoPath = `${mediaPath}/${filename}`
    const videoUrl = `/assets/intiface_media/${encodeURIComponent(filename)}`
    
    // Show panel
    showChatMediaPanel()
    
    // Update UI
    $("#intiface-chat-video-filename").text(filename)
    
    // Set video source
    const videoPlayer = $("#intiface-chat-video-player")
    videoPlayer.attr('src', videoUrl)
    
    // Store reference
    mediaPlayer.videoElement = videoPlayer[0]
    mediaPlayer.currentMediaPath = videoPath
    
    // Check for funscript (look in funscript folder)
    const baseName = filename.replace(/\.[^.]+$/, '')
    const funscriptPath = `${pathsData.paths?.funscript}/${baseName}.funscript`
    
    // Try to load funscript
    try {
      const funscriptResponse = await fetch(`/api/plugins/intiface-launcher/funscript?path=${encodeURIComponent(funscriptPath)}`, {
        method: 'GET',
        headers: getRequestHeaders()
      })
      
      if (funscriptResponse.ok) {
        const funscriptData = await funscriptResponse.json()
        if (funscriptData.success) {
          const funscript = processFunscript(funscriptData.funscript)
          funscriptCache.set(funscriptPath, funscript)
          mediaPlayer.currentFunscript = funscript
          updateChatFunscriptUI(funscript)
        }
      } else {
        mediaPlayer.currentFunscript = null
        clearChatFunscriptVisualizer()
      }
    } catch (e) {
      mediaPlayer.currentFunscript = null
      clearChatFunscriptVisualizer()
    }
    
    // Setup video event listeners
    setupChatVideoEventListeners()
    
    // Auto-play
    videoPlayer[0].play().catch(e => {
      console.log(`${NAME}: Auto-play prevented, user must click play`)
    })
    
  } catch (error) {
    console.error(`${NAME}: Failed to load media:`, error)
    updateStatus(`Media load failed: ${error.message}`, true)
  }
}

// Setup video event listeners for chat panel
function setupChatVideoEventListeners() {
  const video = mediaPlayer.videoElement
  if (!video) return
  
  // Remove old listeners
  video.onplay = null
  video.onpause = null
  video.onended = null
  
  // Add new listeners
  video.onplay = () => {
    mediaPlayer.isPlaying = true
    startFunscriptSync()
    $("#intiface-chat-funscript-info").text("Playing - Funscript active").css("color", "#4CAF50")
  }
  
  video.onpause = () => {
    mediaPlayer.isPlaying = false
    stopFunscriptSync()
    $("#intiface-chat-funscript-info").text("Paused").css("color", "#FFA500")
  }
  
  video.onended = () => {
    mediaPlayer.isPlaying = false
    stopFunscriptSync()
    
    if ($("#intiface-menu-loop").is(":checked")) {
      video.currentTime = 0
      mediaPlayer.lastActionIndex = 0
      video.play()
    } else {
      $("#intiface-chat-funscript-info").text("Finished").css("color", "#888")
      stopAllDeviceActions()
    }
  }
}

// Update Funscript UI in chat panel
function updateChatFunscriptUI(funscript) {
  if (!funscript) return
  
  // Update chat panel
  $("#intiface-chat-funscript-duration").text(`${(funscript.duration / 1000).toFixed(1)}s`)
  $("#intiface-chat-funscript-info").html(`
    ${funscript.stats.actionCount} actions | 
    Range: ${funscript.stats.minPosition}-${funscript.stats.maxPosition}%
  `).css("color", "#888")
  
  // Update menu panel
  $("#intiface-menu-funscript-duration").text(`${(funscript.duration / 1000).toFixed(1)}s`)
  $("#intiface-menu-funscript-info").html(`
    ${funscript.stats.actionCount} actions | 
    Range: ${funscript.stats.minPosition}-${funscript.stats.maxPosition}%
  `).css("color", "#888")
  
  // Draw visualizer in menu (chat visualizer was removed)
  drawMenuFunscriptVisualizer(funscript)
}

// Draw Funscript visualizer for menu panel
function drawMenuFunscriptVisualizer(funscript) {
  const canvas = document.getElementById('intiface-menu-funscript-canvas')
  if (!canvas || !funscript) return
  
  const ctx = canvas.getContext('2d')
  const width = canvas.width = canvas.offsetWidth
  const height = canvas.height = canvas.offsetHeight
  
  const actions = funscript.actions
  if (actions.length === 0) return
  
  const duration = funscript.duration || 1
  
  // Clear
  ctx.fillStyle = 'rgba(0,0,0,0.2)'
  ctx.fillRect(0, 0, width, height)
  
  // Draw grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.1)'
  ctx.lineWidth = 1
  for (let i = 0; i <= 4; i++) {
    const y = (height / 4) * i
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(width, y)
    ctx.stroke()
  }
  
  // Draw waveform
  ctx.strokeStyle = '#4CAF50'
  ctx.lineWidth = 2
  ctx.beginPath()
  
  actions.forEach((action, index) => {
    const x = (action.at / duration) * width
    const y = height - ((action.pos / 100) * height)
    
    if (index === 0) {
      ctx.moveTo(x, y)
    } else {
      ctx.lineTo(x, y)
    }
  })
  
  ctx.stroke()
  
  // Draw position points
  ctx.fillStyle = '#81C784'
  actions.forEach(action => {
    const x = (action.at / duration) * width
    const y = height - ((action.pos / 100) * height)
    
    ctx.beginPath()
    ctx.arc(x, y, 2, 0, Math.PI * 2)
    ctx.fill()
  })
}

// Clear Funscript visualizer
function clearChatFunscriptVisualizer() {
  // Clear menu canvas
  const menuCanvas = document.getElementById('intiface-menu-funscript-canvas')
  if (menuCanvas) {
    const ctx = menuCanvas.getContext('2d')
    ctx.fillStyle = 'rgba(0,0,0,0.2)'
    ctx.fillRect(0, 0, menuCanvas.width, menuCanvas.height)
  }
  
  // Clear info displays
  $("#intiface-menu-funscript-duration").text('--')
  $("#intiface-menu-funscript-info").text('No Funscript loaded').css("color", "#666")
}

// Check for video/MP4 mentions in chat messages
function checkForVideoMentions(text) {
  // Match various patterns:
  // - "plays filename.mp4"
  // - "filename.mp4"
  // - <video:filename.mp4>
  // - "playing filename.mp4"
  // - "load filename.mp4"
  
  const patterns = [
    /(?:play|playing|loads?|show|watch)\s+(?:the\s+)?(?:video\s+)?["']?([^"'\s<>]+\.mp4)["']?/i,
    /["']?([^"'\s<>]+\.mp4)["']?/i,
    /<video[:\s]+([^>]+\.mp4)>/i
  ]
  
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match) {
      const filename = match[1].trim()
      console.log(`${NAME}: Detected video mention:`, filename)
      return filename
    }
  }
  
  return null
}

// ==========================================
// END FUNSCRIPT AND MEDIA PLAYER MODULE
// ==========================================
