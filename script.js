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

function applyMaxVibrate(value, motorIndex = 0) {
  // No max limit anymore, just return the value clamped to 0-100
  return Math.min(value, 100)
}

// Parse device commands from AI text
// Supports self-closing format with device type matching:
// <cage:VIBRATE: 50> - Matches devices with "cage" in name
// <plug:OSCILLATE: 75> - Matches devices with "plug" in name
// <any:VIBRATE: 50> - Matches any device (first available)
// <solace:LINEAR: start=10, end=90, duration=1000>
// <toy:PATTERN: [20, 40, 60], interval=[1000, 500, 1000], loop=3>
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
  const commands = parseDeviceCommands(messageText)

  if (commands.length === 0) return

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
  if (!client.connected) return

  // Clear previous commands and stop current activity
  messageCommands = []
  executedCommands.clear()
  streamingText = ''

  if (commandQueueInterval) {
    clearTimeout(commandQueueInterval)
    commandQueueInterval = null
  }

  await stopAllDeviceActions()

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

  // Show supported features info
  const featuresList = []
  if (hasVibration) featuresList.push(`Vibrate (${device.vibrateAttributes.length} motor${device.vibrateAttributes.length > 1 ? 's' : ''})`)
  if (hasOscillate) featuresList.push('Oscillate')
  if (hasLinear) featuresList.push('Linear')

  if (featuresList.length > 0) {
    const featuresHtml = `<div style="margin: 5px 0; font-size: 0.85em; color: #888;">
      <strong>Supported:</strong> ${featuresList.join(', ')}
    </div>`
    deviceDiv.append(featuresHtml)
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
    return {
      name: dev.displayName || dev.name,
      index: idx,
      capabilities: caps
    }
  })

  const deviceShorthands = devices.length > 0 ? devices.map((dev, idx) => {
    const devName = (dev.displayName || dev.name || '').toLowerCase()
    let shorthand = 'any'
    if (devName.includes('cage')) shorthand = 'cage'
    else if (devName.includes('plug')) shorthand = 'plug'
    else if (devName.includes('solace')) shorthand = 'solace'
    else if (devName.includes('lush')) shorthand = 'lush'
    else if (devName.includes('hush')) shorthand = 'hush'
    else if (devName.includes('nora')) shorthand = 'nora'
    else if (devName.includes('max')) shorthand = 'max'
    else if (devName.includes('domi')) shorthand = 'domi'
    else if (devName.includes('edge')) shorthand = 'edge'
    else shorthand = devName.split(' ')[0] // Use first word as shorthand
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
✓ Good: "Mmm, let me tease you slowly <cage:VIBRATE: 20>. Can you feel that gentle pulse?"
✓ Good: "Now I'll turn it up <cage:VIBRATE: 75>. Much better, isn't it?"
✓ Good: "Let me start the connection <intiface:CONNECT>. Now we can play."

✗ Bad: "I will vibrate the device for you" (no actual command)
✗ Bad: "Use this command: cage vibrate 50" (wrong format)

${client.connected ? 'You ARE currently connected - include device commands naturally in your responses.' : '⚠️ You are DISCONNECTED - you MUST include <intiface:CONNECT> or <intiface:START> in your response to establish connection BEFORE sending any device commands.'}

RULES:
1. ALWAYS include the command literally: <deviceName:COMMAND: value>
2. Commands are invisible to users - they only see your normal text
3. Include commands naturally within sentences
4. The device activates INSTANTLY when you type the command

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
  const deviceList = devices.map((dev, idx) => ({
    index: idx,
    name: dev.name,
    vibrateMotors: dev.vibrateAttributes?.length || 0,
    isActive: idx === 0
  }))

  const status = {
    intifaceConnected: client?.connected || false,
    deviceCount: devices.length,
    activeDevice: device ? {
      name: device.name,
      vibrateMotors: device.vibrateAttributes?.length || 0
    } : null,
    allDevices: deviceList
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
          enum: ["vibrate", "oscillate", "linear_stroke"],
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
} catch (error) {
  console.error(`${NAME}: Failed to initialize.`, error)
    const statusPanel = $("#intiface-status-panel")
    if (statusPanel.length) {
      updateStatus("Failed to load Buttplug.js. Check console.", true)
    }
  }
})
