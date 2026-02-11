// SPDX-License-Identifier: AGPL-3.0-or-later

import { renderExtensionTemplateAsync } from "../../../extensions.js"
import { eventSource, event_types, setExtensionPrompt, extension_prompt_types, extension_prompt_roles, getRequestHeaders, messageFormatting, appendMediaToMessage, addCopyToCodeBlocks } from "../../../../script.js"

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
let isStartingIntiface = false // Prevent multiple simultaneous start attempts

// Timer worker for background vibration (avoids setTimeout throttling in hidden tabs)
let timerWorker = null
let workerTimers = new Map() // timerId -> { callback, interval }
let workerTimerId = 0
let isWorkerTimerRunning = false

// Initialize timer worker
function initTimerWorker() {
  try {
    const workerUrl = new URL('timer-worker.js', import.meta.url).href
    timerWorker = new Worker(workerUrl)
    
    timerWorker.onmessage = (e) => {
      const { type, drift } = e.data
      if (type === 'tick') {
        // Execute all registered callbacks
        for (const [id, timer] of workerTimers) {
          if (timer.callback) {
            try {
              timer.callback()
            } catch (err) {
              console.error(`${NAME}: Timer callback error:`, err)
            }
          }
        }
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
    workerTimers.set(id, { callback, interval: delay })
    
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

// Clear worker timeout
function clearWorkerTimeout(id) {
  if (typeof id === 'number' && workerTimers.has(id)) {
    workerTimers.delete(id)
    
    // If no more timers, stop the worker
    if (timerWorker && workerTimers.size === 0 && isWorkerTimerRunning) {
      timerWorker.postMessage({ command: 'stop' })
      isWorkerTimerRunning = false
    }
  } else if (typeof id === 'object' && id !== null) {
    // It's a regular timeout ID
    clearTimeout(id)
  }
}

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
          setWorkerTimeout(executeStep, 100)
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
      clearWorkerTimeout(active.interval)
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
// <media:PLAY: filename.mp4> - Play a media file with optional funscript sync
// <media:STOP> - Stop media playback
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
    
    // Check for INTERFACE system commands (start, connect, disconnect)
    if (deviceType === 'interface' || deviceType === 'system') {
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
      // Parse PLAY command with filename
      // Format: PLAY: filename.mp4 or PLAY filename.mp4
      const playMatch = commandText.match(/PLAY[\s:]+(.+)/i)
      if (playMatch) {
        commands.push({
          type: 'media_play',
          filename: playMatch[1].trim()
        })
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

  // Media commands
  if (cmd.type === 'media_list' || cmd.type === 'media_play' || cmd.type === 'media_stop') {
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
      
      case 'vibrate':
        const vibrateAttrs = targetDevice.vibrateAttributes
        if (vibrateAttrs && vibrateAttrs[cmd.motorIndex]) {
          const intensity = cmd.intensity / 100
          // Try simple vibrate method first (better for Lovense), fallback to scalar
          try {
            await targetDevice.vibrate(intensity)
          } catch (e) {
            // Fallback to scalar command
            const scalarCmd = new buttplug.ScalarSubcommand(
              vibrateAttrs[cmd.motorIndex].Index,
              intensity,
              "Vibrate"
            )
            await targetDevice.scalar(scalarCmd)
          }
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
        mediaListBlock = `\n\n---\n**Media Library** (0 media files found)\n\n\`\`\`\nNo media files available in the media library.\nPlace videos/audio in: ${mediaPath}\n\`\`\``
      } else {
        const fileList = mediaFiles.map(file => {
          const funscriptStatus = file.hasFunscript ? '[has funscript]' : '[no funscript]'
          const typeLabel = file.type === 'audio' ? '[audio]' : '[video]'
          return `${file.name} ${typeLabel} ${funscriptStatus}`
        }).join('\n')

        mediaListBlock = `\n\n---\n**Media Library** (${mediaFiles.length} media files available)\n\n\`\`\`\n${fileList}\n\`\`\`\n\nUse <media:PLAY: filename.mp4> to play media with funscript sync.`
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
        // Save chat
        context.saveChat()
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
          appendMediaToMessage(lastMessage, messageElement)
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
      commandQueueInterval = setWorkerTimeout(executeStep, interval)
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

    // Skip AI device commands when media player is open (funscript/media has priority until player is closed)
    const playerPanel = $("#intiface-chat-media-panel")
    if (playerPanel.length > 0 && playerPanel.is(":visible")) {
      console.log(`${NAME}: Skipping AI command - media player is open: ${cmd.type}`)
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
  console.log(`${NAME}: connect() called`)
  try {
    const serverIp = $("#intiface-ip-input").val()
    const serverUrl = `ws://${serverIp}`
    console.log(`${NAME}: Connecting to ${serverUrl}`)
    localStorage.setItem("intiface-server-ip", serverIp) // Save on connect
    connector = new buttplug.ButtplugBrowserWebsocketClientConnector(serverUrl)
    updateStatus("Connecting...")
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
    const errorMsg = e?.message || e?.toString?.() || String(e) || 'Unknown error'
    console.error(`${NAME}: Connect error details:`, e, typeof e, JSON.stringify(e))
    updateStatus(`Error connecting: ${errorMsg}`, true)
    // Update prompt even on failure
    updatePrompt()
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
<div>Min: <input type="number" id="waveform-min-${devices.length - 1}" value="20" min="0" max="100" style="width: 50px; background: #000; color: #fff;"></div>
<div>Max: <input type="number" id="waveform-max-${devices.length - 1}" value="80" min="0" max="100" style="width: 50px; background: #000; color: #fff;"></div>
<div>Dur: <input type="number" id="waveform-dur-${devices.length - 1}" value="5000" min="100" style="width: 60px; background: #000; color: #fff;"></div>
<div>Cycles: <input type="number" id="waveform-cycles-${devices.length - 1}" value="3" min="1" style="width: 40px; background: #000; color: #fff;"></div>
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
  try {
    console.log(`${NAME}: updatePrompt() called, devices.length=${devices?.length ?? 'undefined'}, client.connected=${client?.connected ?? 'undefined'}`)

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
- <interface:DISCONNECT> - Disconnect from Intiface server`

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
      const typePresets = DevicePresets[type] || DevicePresets.general
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

WAVEFORM commands (dynamic patterns):
- <any:WAVEFORM: sine, min=10, max=80, duration=5000, cycles=3> - Smooth sine wave
- <any:WAVEFORM: sawtooth, min=20, max=70, duration=3000, cycles=5> - Sawtooth pattern
- <any:WAVEFORM: square, min=30, max=90, duration=2000, cycles=4> - Square wave (on/off)
- <any:WAVEFORM: pulse, min=10, max=60, duration=1500, cycles=10> - Short pulse bursts
- <any:WAVEFORM: random, min=15, max=50, duration=8000, cycles=2> - Random intensity
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
  const typePresets = DevicePresets[type] || DevicePresets.general
  const firstPreset = Object.keys(typePresets)[0] || 'tease'
  
    exampleResponses = `
EXAMPLE RESPONSES:
✓ Good: "Mmm, let me tease you slowly <${shorthand}:PRESET: ${firstPreset}>. Can you feel that gentle pulse building?"
✓ Good: "I'll ramp it up gradually <${shorthand}:GRADIENT: start=20, end=85, duration=12000>. Feel it growing stronger..."
✓ Good: "Wave pattern incoming <any:WAVEFORM: sine, min=15, max=65, duration=4000, cycles=5>"
✓ Good: "Let me start the connection <interface:CONNECT>. Now we can play."

✗ Bad: "I will vibrate the device for you" (no actual command)
✗ Bad: "Use this command: cage vibrate 50" (wrong format)`
} else {
    exampleResponses = `
EXAMPLE RESPONSES:
✓ Good: "Let me start the connection <interface:CONNECT>. Now we can play."

✗ Bad: "I will vibrate the device for you" (no actual command)`
}

const prompt = `=== DEVICE CONTROL ACTIVE ===

⚠️ CRITICAL: You are REQUIRED to include device control commands directly in your response text. These commands are HIDDEN from the user but will control their actual device.

COMMAND FORMAT:
Type the command EXACTLY like this (including the < and >):
${startCommand}${deviceCommands}
${exampleResponses}
${deviceInfo.length > 0 ? 'You ARE currently connected - include device commands naturally in your responses.\n\nDEVICE CAPABILITIES:\n' + deviceInfo.map(d => `- ${d.name}: ${d.type} (${d.capabilities.join(', ')}, ${d.motors} motor${d.motors > 1 ? 's' : ''})`).join('\n') : '⚠️ You are DISCONNECTED - you MUST include <interface:CONNECT> or <interface:START> in your response to establish connection BEFORE sending any device commands.'}

=== VIDEO & FUNSCRIPT SUPPORT ===
You can also play videos with synchronized haptic feedback! Videos are stored in the media library and can be played with matching Funscript files.

MEDIA COMMANDS (chat-based control):
- <media:LIST> - List all available videos in the media library
- <media:PLAY: filename.mp4> - Play a video with automatic funscript synchronization
- <media:STOP> - Stop media playback and all device activity

VIDEO PLAYBACK (detection):
- You can also simply mention a video filename like: "Let me play that video for you: video.mp4"
- The system will automatically detect video mentions and load the player

Videos are searched in: data/default-user/assets/intiface_media/
Funscripts (synchronized scripts) are loaded from: data/default-user/assets/funscript/

The video player will appear in the sidebar with sync controls, intensity slider, and funscript visualization.

VIDEO EXAMPLES:
✓ Media command: <media:PLAY: myvideo.mp4>
✓ Chat detection: "Let me play something special for you - check out this video: myvideo.mp4"

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

  console.log(`${NAME}: Setting extension prompt...`)
  console.log(`${NAME}: Prompt length: ${prompt.length}`)
  console.log(`${NAME}: Prompt content:\n`, prompt)
  try {
    setExtensionPrompt('intiface_control', prompt, extension_prompt_types.IN_PROMPT, 2, true, extension_prompt_roles.SYSTEM)
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
                strokerIntervalId = setWorkerTimeout(executeSegment, 100)
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
              if (strokerIntervalId) clearWorkerTimeout(strokerIntervalId)
              strokerIntervalId = setWorkerTimeout(executeSegment, duration)
            } catch (e) {
              const errorMsg = `Segment ${segmentIndex + 1} failed: ${e.message}`
              console.error(errorMsg, e)
              updateStatus(errorMsg, true)
              if (strokerIntervalId) clearTimeout(strokerIntervalId)

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
    await connect()
    console.log(`${NAME}: connect() completed, client.connected = ${client?.connected}`)
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
  }
  activePatterns.clear()

    // Stop all devices
    const results = []
    for (const dev of devices) {
      try {
        // Stop vibration - try simple method first, fallback to scalar
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
    // Update prompt to reflect stopped state
    updatePrompt()
    return `Stopped ${results.length} device(s): ${results.join(', ')}`
  } catch (e) {
    const errorMsg = `Failed to stop device actions: ${e.message}`
    console.error(errorMsg, e)
    updateStatus(errorMsg, true)
    throw new Error(errorMsg)
  }
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

    // Initialize timer worker for background vibration (prevents throttling in hidden tabs)
    initTimerWorker()

  client = new buttplug.ButtplugClient("SillyTavern Intiface Client")

  // Clear any stale device data on initialization
  console.log(`${NAME}: Clearing stale device data on init`)
  devices = []
  device = null
  
  // Ensure any lingering patterns are cleared
  activePatterns.clear()
  if (vibrateIntervalId) {
    clearTimeout(vibrateIntervalId)
    vibrateIntervalId = null
  }
  if (oscillateIntervalId) {
    clearTimeout(oscillateIntervalId)
    oscillateIntervalId = null
  }
  if (strokerIntervalId) {
    clearInterval(strokerIntervalId)
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
    
    // Update prompt with cleared state
    updatePrompt()
    
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

// AI control is always chat-based
    chatControlEnabled = true
    localStorage.setItem("intiface-ai-mode", "chat")
    localStorage.setItem("intiface-chat-control", "true")
    console.log(`${NAME}: Chat-based AI control enabled`)
    
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
  syncTimerId: null,
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
    const width = $(this).val()
    const scale = (width / 100).toFixed(1)
    $("#intiface-menu-width-display").text(`${scale}x`)
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
    $("#intiface-menu-width-display").text("1.0x")
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
    const scale = (savedWidth / 100).toFixed(1)
    $("#intiface-menu-width-display").text(`${scale}x`)
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
    
      // Get video and audio files
      const mediaFiles = data.files?.filter(f => f.type === 'video' || f.type === 'audio') || []

      if (mediaFiles.length === 0) {
        mediaListEl.html('<div style="color: #888; text-align: center; padding: 20px;">No media files found<br><small>Place videos/audio in intiface_media folder</small></div>')
        return
      }

      // Build list
      let html = ''
      mediaFiles.forEach(file => {
        const funscriptIcon = file.hasFunscript ? '<i class="fa-solid fa-wave-square" style="color: #4CAF50; margin-left: 5px;" title="Has Funscript"></i>' : ''
        const sizeMB = (file.size / 1024 / 1024).toFixed(1)
        const iconClass = file.type === 'audio' ? 'fa-music' : 'fa-film'
        const iconColor = file.type === 'audio' ? '#9C27B0' : '#64B5F6'

        html += `
        <div class="menu-media-file-item" data-filename="${file.name}"
        style="padding: 8px; margin: 3px 0; background: rgba(255,255,255,0.05); border-radius: 3px; cursor: pointer; font-size: 0.85em; display: flex; align-items: center; justify-content: space-between; transition: background 0.2s;"
        onmouseover="this.style.background='rgba(255,255,255,0.1)'" onmouseout="this.style.background='rgba(255,255,255,0.05)'">
          <div style="display: flex; align-items: center; gap: 8px; overflow: hidden;">
            <i class="fa-solid ${iconClass}" style="color: ${iconColor};"></i>
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
  stopFunscriptSyncTimer()
}

// Timer-based Funscript sync for background tab operation
function startFunscriptSyncTimer() {
  if (!mediaPlayer.videoElement || !mediaPlayer.currentFunscript) {
    console.log(`${NAME}: Cannot start timer sync - videoElement: ${!!mediaPlayer.videoElement}, funscript: ${!!mediaPlayer.currentFunscript}`)
    return
  }
  
  // Clear any existing timer first
  stopFunscriptSyncTimer()
  
  // If media is not paused, ensure isPlaying is true
  if (!mediaPlayer.videoElement.paused) {
    mediaPlayer.isPlaying = true
  }
  
  console.log(`${NAME}: Starting timer-based funscript sync`)
  
  // Store last execution time to handle browser throttling
  let lastExecutionTime = Date.now()

  const syncLoop = () => {
    // Only run while hidden and playing
    if (!mediaPlayer.isPlaying || !mediaPlayer.currentFunscript || !document.hidden) {
      console.log(`${NAME}: Timer sync stopping - isPlaying: ${mediaPlayer.isPlaying}, hasFunscript: ${!!mediaPlayer.currentFunscript}, hidden: ${document.hidden}`)
      return
    }

    const video = mediaPlayer.videoElement
    const funscript = mediaPlayer.currentFunscript
    const currentTime = (video.currentTime * 1000) + mediaPlayer.syncOffset
    
    // Calculate time delta to catch up on missed actions due to throttling
    const now = Date.now()
    const timeDelta = now - lastExecutionTime
    lastExecutionTime = now

    // Find and execute actions - process ALL actions up to current time
    // to catch up if browser throttled us
    const actions = funscript.actions
    const targetTime = currentTime + timeDelta // Look ahead by the time that passed
    
    for (let i = mediaPlayer.lastActionIndex; i < actions.length; i++) {
      const action = actions[i]

      if (action.at <= targetTime) {
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

    // Continue loop only if still hidden
    if (document.hidden && mediaPlayer.isPlaying) {
      // Use 50ms interval - browsers typically allow this in background
      // and it won't be as choppy as 16ms when throttled to 1000ms
      mediaPlayer.syncTimerId = setTimeout(syncLoop, 50)
    }
  }

  syncLoop()
}

function stopFunscriptSyncTimer() {
  if (mediaPlayer.syncTimerId) {
    clearTimeout(mediaPlayer.syncTimerId)
    mediaPlayer.syncTimerId = null
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
  if (!video) {
    console.log(`${NAME}: No video element found, cannot setup event listeners`)
    return
  }

  console.log(`${NAME}: Setting up video event listeners`)

  // Remove old listeners
  video.onplay = null
  video.onpause = null
  video.onended = null

  // Add new listeners
  video.onplay = () => {
    console.log(`${NAME}: Video onplay event fired`)
    mediaPlayer.isPlaying = true
    startFunscriptSync()
    $("#intiface-chat-funscript-info").text("Playing - Funscript active").css("color", "#4CAF50")
  }

  video.onpause = () => {
    console.log(`${NAME}: Video onpause triggered - hidden: ${document.hidden}, devices: ${devices.length}, connected: ${client.connected}`)
    // Don't stop if tab is hidden - let visibility handler manage background mode
    if (document.hidden) {
      console.log(`${NAME}: Video/audio paused but tab is hidden - continuing in background mode`)
      // Keep isPlaying true so background sync can work
      return
    }
    console.log(`${NAME}: Video/audio paused - stopping funscript sync and device`)
    mediaPlayer.isPlaying = false
    stopFunscriptSync()
    // Stop device when paused - don't keep running
    if (devices.length > 0 && client.connected) {
      console.log(`${NAME}: Calling stopAllDeviceActions...`)
      stopAllDeviceActions().then(() => {
        console.log(`${NAME}: Device stopped on pause`)
      }).catch((e) => {
        console.error(`${NAME}: Failed to stop device on pause:`, e)
      })
    } else {
      console.log(`${NAME}: Not stopping device - devices: ${devices.length}, connected: ${client.connected}`)
    }
    $("#intiface-chat-funscript-info").text("Paused - Device stopped").css("color", "#FFA500")
  }

  video.onended = () => {
    console.log(`${NAME}: Video onended event fired`)
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

  console.log(`${NAME}: Video event listeners setup complete`)
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
  // Use fixed dimensions since the canvas might be in a hidden section
  const width = canvas.width = 400
  const height = canvas.height = 80

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
  // - "filename.mp4" (no spaces in filename)
  // - <video:filename.mp4>
  // - <media:PLAY: filename with spaces.mp4>
  // - "playing filename.mp4"
  // - "load filename.mp4"

  const patterns = [
    // Match <media:PLAY: filename.mp4> format (handles spaces in filename)
    /<media:PLAY:\s*([^>]+\.mp4)>/i,
    // Match <video:filename.mp4> format
    /<video:\s*([^>]+\.mp4)>/i,
    // Match play/load commands with quoted filenames (handles spaces)
    /(?:play|playing|loads?|show|watch)\s+(?:the\s+)?(?:video\s+)?["']([^"']+\.mp4)["']/i,
    // Match play commands with unquoted filenames (no spaces)
    /(?:play|playing|loads?|show|watch)\s+(?:the\s+)?(?:video\s+)?["']?([^"'\s<>]+\.mp4)["']?/i,
    // Match standalone quoted filenames
    /["']([^"']+\.mp4)["']/i,
    // Match standalone unquoted filenames (no spaces, no angle brackets)
    /\b([^"'\s<>]+\.mp4)\b/i
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
  if (!client.connected) {
    try {
      await connect()
      updateStatus(`Auto-connected to Intiface`)
      console.log(`${NAME}: Auto-connected successfully`)
    } catch (e) {
      console.log(`${NAME}: Auto-connect failed:`, e.message)
      updateStatus(`Auto-connect failed: ${e.message}`, true)
    }
  } else {
    console.log(`${NAME}: Already connected, skipping auto-connect`)
  }
}

// Run auto-connect as the very last thing
autoConnectOnLoad().catch(e => {
  console.error(`${NAME}: Auto-connect error:`, e)
})
