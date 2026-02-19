/**
 * Timeline Sequencer Module
 * Multi-track pattern editor for organizing and playing back patterns over time
 */

// Timeline Sequencer state
let timelineBlocks = [] // Array of { id, patternName, category, channel, startTime, duration }
let timelineBlockIdCounter = 0
let timelineSelectedPattern = null // Currently selected pattern from palette
let timelinePlaybackStartTime = 0
let timelinePlaybackTimer = null
let timelineCurrentPosition = 0 // Current playback position in ms
const TIMELINE_MIN_DURATION = 30000 // Minimum 30 seconds
const TIMELINE_PADDING_MULTIPLIER = 2.0 // Double the content duration (100% extra space)

// Timeline dragging state
let timelineIsDragging = false
let timelineDragBlock = null
let timelineDragStartX = 0
let timelineDragStartTime = 0
let timelineSequenceTimeouts = new Set() // Track timeouts for cleanup

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

// External dependencies (will be injected via initTimelineModule)
let deps = {
  NAME: 'intiface-connect',
  devices: [],
  mediaPlayer: null,
  PlayModeLoader: null,
  updateStatus: () => {},
  stopMediaPlayback: () => {},
  startFunscriptSync: () => {},
  stopFunscriptSync: () => {},
  stopAllDeviceActions: () => {},
  applyIntensityScale: (values) => values,
  applyInversion: (value) => value,
  getMotorCount: () => 1,
  executePattern: () => {},
  clearWorkerTimeout: (id) => clearTimeout(id)
}

/**
 * Initialize the timeline module with required dependencies
 * @param {Object} dependencies - Object containing all required dependencies
 */
export function initTimelineModule(dependencies) {
  deps = { ...deps, ...dependencies }
  console.log(`${deps.NAME}: Timeline module initialized`)
}

/**
 * Calculate dynamic timeline duration based on blocks (with padding for visual editing)
 * @returns {number} Duration in milliseconds
 */
export function getTimelineDuration() {
  if (timelineBlocks.length === 0) {
    return TIMELINE_MIN_DURATION
  }

  // Find the end time of the last block
  const lastEndTime = Math.max(...timelineBlocks.map(b => b.startTime + b.duration))
  // Add 100% extra space (double the content duration)
  const dynamicDuration = lastEndTime * TIMELINE_PADDING_MULTIPLIER

  return Math.max(TIMELINE_MIN_DURATION, dynamicDuration)
}

/**
 * Get the actual content duration (longest pattern end time) without padding
 * This is used for playback slider max and funscript export
 * @returns {number} Duration in milliseconds
 */
export function getContentDuration() {
  if (timelineBlocks.length === 0) {
    return 0
  }

  // Find the end time of the last block (actual content end, no padding)
  const lastEndTime = Math.max(...timelineBlocks.map(b => b.startTime + b.duration))

  return lastEndTime
}

/**
 * Format milliseconds to mm:ss for timeline display
 * @param {number} ms - Milliseconds
 * @returns {string} Formatted time string
 */
export function formatTimelineTime(ms) {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

/**
 * Format duration in ms to compact string (e.g., "5s", "1m05s", "30m00s")
 * @param {number} ms - Milliseconds
 * @returns {string} Formatted duration string
 */
export function formatDurationShort(ms) {
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) {
    return `${totalSeconds}s`
  }
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m${seconds.toString().padStart(2, '0')}s`
}

/**
 * Get motor count for a channel (returns 1 if multi-motor not enabled)
 * @param {string} channel - Channel letter (A, B, C, D)
 * @returns {number} Motor count
 */
export function getChannelMotorCount(channel) {
  const channelLower = channel.toLowerCase()
  const checkbox = $(`#channel-${channelLower}-multi-motor`)
  const input = $(`#channel-${channelLower}-motor-count`)

  if (checkbox.is(':checked')) {
    const count = parseInt(input.val()) || 2
    return Math.max(1, Math.min(8, count))
  }

  return 1
}

/**
 * Get default values for any pattern (waveform or mode)
 * @param {string} patternName - Name of the pattern
 * @param {string} category - Category of the pattern
 * @returns {Object} Default values for min, max, duration, cycles
 */
export function getPatternDefaults(patternName, category) {
  // Check if it's a waveform pattern
  if (deps.PlayModeLoader && deps.PlayModeLoader.hasPattern && deps.PlayModeLoader.hasPattern(patternName)) {
    return {
      min: 20,
      max: 80,
      duration: 5000,
      cycles: 3
    }
  }

  // Check if it's a sequence from PlayModeLoader
  const enabledSequences = deps.PlayModeLoader?.getEnabledSequences ? deps.PlayModeLoader.getEnabledSequences() : {}
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
          duration: totalDuration,
          cycles: 1
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

/**
 * Get pattern duration for display
 * @param {string} patternName - Name of the pattern
 * @param {string} category - Category of the pattern
 * @returns {number} Duration in milliseconds
 */
export function getPatternDuration(patternName, category) {
  // Search in PlayModeLoader
  const enabledSequences = deps.PlayModeLoader?.getEnabledSequences ? deps.PlayModeLoader.getEnabledSequences() : {}
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

/**
 * Select a pattern from the palette (click to select, then click timeline to place)
 * @param {string} patternName - Name of the pattern
 * @param {string} category - Category of the pattern
 */
export function selectPatternForTimeline(patternName, category) {
  // Get pattern defaults first
  const defaults = getPatternDefaults(patternName, category)

  timelineSelectedPattern = {
    patternName,
    category,
    defaultDuration: defaults.duration,
    defaultCycles: defaults.cycles
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

  deps.updateStatus(`Selected: ${displayName} - Click timeline track to place (${(defaults.duration/1000).toFixed(1)}s)`)
}

/**
 * Add pattern block to timeline
 * @param {string} channel - Channel letter (A, B, C, D)
 * @param {number} startTime - Start time in milliseconds
 * @param {number} motor - Motor number (default 1)
 */
export function addTimelineBlock(channel, startTime, motor = 1) {
  if (!timelineSelectedPattern) {
    deps.updateStatus('Select a pattern first, then click timeline track')
    return
  }

  timelineBlockIdCounter++

  // Get duration from slider or use default
  const durationSlider = $('#intiface-pattern-duration').val()
  const duration = durationSlider ? parseInt(durationSlider) : timelineSelectedPattern.defaultDuration

  // Get other parameters from sliders
  const min = parseInt($('#intiface-pattern-min').val()) || 20
  const max = parseInt($('#intiface-pattern-max').val()) || 80
  const cycles = parseInt($('#intiface-pattern-cycles').val()) || 1

  const block = {
    id: timelineBlockIdCounter,
    patternName: timelineSelectedPattern.patternName,
    category: timelineSelectedPattern.category,
    channel: channel,
    motor: motor,
    startTime: startTime,
    duration: duration,
    min: min,
    max: max,
    cycles: cycles
  }

  timelineBlocks.push(block)

  // Render the timeline
  renderTimeline()

  deps.updateStatus(`Added "${timelineSelectedPattern.patternName}" to channel ${channel}`)

  // Keep pattern selected for multiple placements
  // timelineSelectedPattern = null
  // $('#intiface-timeline-selected').hide()
}

/**
 * Remove block from timeline
 * @param {number} id - Block ID to remove
 */
export function removeTimelineBlock(id) {
  timelineBlocks = timelineBlocks.filter(block => block.id !== id)
  renderTimeline()
}

/**
 * Clear all timeline blocks
 */
export function clearTimeline() {
  // Clear ALL timeline-related state
  timelineBlocks = []
  timelineBlockIdCounter = 0
  timelineCurrentPosition = 0
  clearInterval(timelinePlaybackTimer)
  timelinePlaybackTimer = null

  // Clear sequence timeouts
  timelineSequenceTimeouts.forEach(id => clearTimeout(id))
  timelineSequenceTimeouts.clear()

  // Reset playback
  if (deps.mediaPlayer) {
    deps.mediaPlayer.isPlaying = false
    deps.mediaPlayer.currentFunscript = null
    deps.mediaPlayer.channelFunscripts = {}
  }

  $('#intiface-timeline-scrubber').val(0)
  $('#intiface-timeline-current-time').text('0:00')

  renderTimeline()
  deps.updateStatus('Timeline cleared')
}

/**
 * Render timeline blocks
 */
export function renderTimeline() {
  // Clear existing blocks
  $('.timeline-block').remove()

  // Get both durations: visual (padded) and content (actual)
  const visualDuration = getTimelineDuration()
  const contentDuration = getContentDuration()

  // Debug logging
  console.log(`${deps.NAME}: renderTimeline - visualDuration: ${visualDuration}ms (${formatDurationShort(visualDuration)}), contentDuration: ${contentDuration}ms (${formatDurationShort(contentDuration)})`)
  timelineBlocks.forEach((b, i) => {
    console.log(`${deps.NAME}: Block ${i}: startTime=${b.startTime}ms, duration=${b.duration}ms, endTime=${b.startTime + b.duration}ms`)
  })

  // Set scrubber max to content duration (not padded visual duration)
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
  timelineBlocks.forEach(block => {
    const displayName = block.patternName.replace(/_/g, ' ')
    const leftPercent = (block.startTime / visualDuration) * 100
    const widthPercent = (block.duration / visualDuration) * 100

    // Get color based on category
    const colors = categoryColors[block.category] || categoryColors.basic

    const blockHtml = `
      <div class="timeline-block" data-id="${block.id}"
        style="position: absolute; top: 2px; left: ${leftPercent}%; width: ${widthPercent}%;
        height: calc(100% - 4px); background: ${colors.bg}; border: 1px solid ${colors.border};
        border-radius: 2px; cursor: move; display: flex; align-items: center; justify-content: center;
        font-size: 0.65em; color: #fff; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; padding: 0 4px; user-select: none;"
        title="${displayName} (${block.category}) - Click and drag to move, right-click to delete">
        ${displayName}
      </div>
    `

    $(`.timeline-track-lane[data-channel="${block.channel}"][data-motor="${block.motor || 1}"]`).append(blockHtml)
  })

  // Attach event handlers to blocks
  attachBlockEventHandlers()
}

/**
 * Attach event handlers to timeline blocks
 */
function attachBlockEventHandlers() {
  $('.timeline-block').on('mousedown', function(e) {
    if (e.button !== 0) return // Only left click
    const id = $(this).data('id')
    timelineIsDragging = true
    timelineDragBlock = timelineBlocks.find(b => b.id === id)
    timelineDragStartX = e.pageX

    const lane = $(e.target).closest('.timeline-track-lane')[0]
    if (lane) {
      timelineDragStartTime = timelineDragBlock.startTime
    }

    // Mouse move handler
    const onMouseMove = (e) => {
      if (!timelineIsDragging || !timelineDragBlock) return

      const deltaX = e.pageX - timelineDragStartX

      // Convert pixel delta to time delta (approximate)
      const laneWidth = $('.timeline-track-lanes').first().width() || 800
      const visualDuration = getTimelineDuration()
      const deltaTime = (deltaX / laneWidth) * visualDuration

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
  })

  // Right-click to remove
  $('.timeline-block').on('contextmenu', function(e) {
    e.preventDefault()
    const id = $(this).data('id')
    removeTimelineBlock(id)
  })
}

/**
 * Convert timeline blocks to funscript format for unified playback
 * Each channel gets its own funscript with actions at the appropriate times
 * @returns {Object} Channel funscripts object
 */
export function convertTimelineToFunscripts() {
  const channelFunscripts = {}
  const channels = ['A', 'B', 'C', 'D', '-']

  // Initialize funscripts for each channel
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
    const patternFunc = deps.PlayModeLoader?.getPattern ? 
      (deps.PlayModeLoader.getPattern(block.patternName) || deps.PlayModeLoader.getPattern('sine')) :
      () => 0
    const cycles = block.cycles || 1

    for (let i = 0; i < steps; i++) {
      // Calculate phase across multiple cycles
      const progress = i / steps
      const phase = (progress * cycles) % 1
      const rawValue = patternFunc(phase, 1)

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
          pos: positions
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

    // Calculate actual max action time for this funscript
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

/**
 * Start timeline playback using unified media player system
 */
export async function playTimeline() {
  if (timelineBlocks.length === 0) {
    deps.updateStatus('Timeline is empty - add patterns first')
    return
  }

  if (deps.devices.length === 0) {
    deps.updateStatus('No devices connected')
    return
  }

  // Stop any existing playback first
  if (deps.mediaPlayer && deps.mediaPlayer.isPlaying) {
    await deps.stopMediaPlayback()
  }

  // Convert timeline to funscripts per channel
  const timelineFunscripts = convertTimelineToFunscripts()

  // Load funscripts into media player channels
  if (deps.mediaPlayer) {
    deps.mediaPlayer.channelFunscripts = {}
    Object.keys(timelineFunscripts).forEach(channel => {
      const funscript = timelineFunscripts[channel]
      if (funscript.actions.length > 0) {
        deps.mediaPlayer.channelFunscripts[channel] = funscript
        console.log(`${deps.NAME}: Loaded timeline funscript for channel ${channel} with ${funscript.actions.length} actions`)
      }
    })

    // Use the first available channel as the main funscript
    const availableChannels = Object.keys(deps.mediaPlayer.channelFunscripts)
    if (availableChannels.length > 0) {
      deps.mediaPlayer.currentFunscript = deps.mediaPlayer.channelFunscripts[availableChannels[0]]
    }

    // Create a dummy video element for timeline playback (no actual video, just timing)
    if (!deps.mediaPlayer.videoElement) {
      deps.mediaPlayer.videoElement = {
        currentTime: timelineCurrentPosition / 1000,
        paused: false,
        play: function() { this.paused = false },
        pause: function() { this.paused = true },
        addEventListener: function() {},
        removeEventListener: function() {}
      }
    }
  }

  // Set up timeline sync loop
  timelinePlaybackStartTime = Date.now() - timelineCurrentPosition
  if (deps.mediaPlayer) {
    deps.mediaPlayer.isPlaying = true
  }

  deps.updateStatus('Playing timeline...')

  // Start the unified funscript sync
  if (deps.startFunscriptSync) {
    deps.startFunscriptSync()
  }

  // Start timeline position tracking
  timelinePlaybackTimer = setInterval(() => {
    if (!deps.mediaPlayer || !deps.mediaPlayer.isPlaying) return

    timelineCurrentPosition = Date.now() - timelinePlaybackStartTime

    // Update video element time for sync
    if (deps.mediaPlayer.videoElement) {
      deps.mediaPlayer.videoElement.currentTime = timelineCurrentPosition / 1000
    }

    // Update scrubber
    $('#intiface-timeline-scrubber').val(timelineCurrentPosition)
    $('#intiface-timeline-current-time').text(formatDurationShort(timelineCurrentPosition))

    // Stop at end of actual content
    if (timelineCurrentPosition >= getContentDuration()) {
      stopTimeline()
      timelineCurrentPosition = 0
      $('#intiface-timeline-scrubber').val(0)
      $('#intiface-timeline-current-time').text('0:00')
      deps.updateStatus('Timeline playback complete')
    }
  }, 50) // 50ms = 20fps
}

/**
 * Pause timeline playback (maintains position)
 */
export async function pauseTimeline() {
  console.log(`${deps.NAME}: pauseTimeline called`)

  if (!deps.mediaPlayer || !deps.mediaPlayer.isPlaying) {
    console.log(`${deps.NAME}: Timeline not playing, nothing to pause`)
    return
  }

  // Pause the unified playback
  deps.mediaPlayer.isPlaying = false

  // Pause the video element if it exists (real video, not dummy)
  if (deps.mediaPlayer.videoElement && deps.mediaPlayer.videoElement.pause && !deps.mediaPlayer.videoElement.paused) {
    deps.mediaPlayer.videoElement.pause()
  }

  // Clear timeline timer but keep position
  if (timelinePlaybackTimer) {
    clearInterval(timelinePlaybackTimer)
    timelinePlaybackTimer = null
  }

  // Stop funscript sync to prevent background execution
  if (deps.stopFunscriptSync) {
    deps.stopFunscriptSync()
  }

  // Stop device actions
  if (deps.stopAllDeviceActions) {
    await deps.stopAllDeviceActions()
  }

  deps.updateStatus('Timeline paused')
  $('#intiface-timeline-current-time').text(formatDurationShort(timelineCurrentPosition) + ' (paused)')
}

/**
 * Resume timeline playback from current position
 */
export async function resumeTimeline() {
  console.log(`${deps.NAME}: resumeTimeline called`)

  if (!deps.mediaPlayer || deps.mediaPlayer.isPlaying) {
    console.log(`${deps.NAME}: Timeline already playing`)
    return
  }

  // Check if there are actually timeline blocks to play
  if (timelineBlocks.length === 0) {
    console.log(`${deps.NAME}: No timeline blocks to resume`)
    deps.updateStatus('Timeline is empty - add patterns first')
    return
  }

  // Check if we have timeline data loaded
  if (!deps.mediaPlayer.currentFunscript || Object.keys(deps.mediaPlayer.channelFunscripts || {}).length === 0) {
    // No timeline loaded, need to convert blocks again
    const timelineFunscripts = convertTimelineToFunscripts()

    // Load funscripts into media player channels
    deps.mediaPlayer.channelFunscripts = {}
    Object.keys(timelineFunscripts).forEach(channel => {
      const funscript = timelineFunscripts[channel]
      if (funscript.actions.length > 0) {
        deps.mediaPlayer.channelFunscripts[channel] = funscript
      }
    })

    // Use the first available channel as the main funscript
    const availableChannels = Object.keys(deps.mediaPlayer.channelFunscripts)
    if (availableChannels.length > 0) {
      deps.mediaPlayer.currentFunscript = deps.mediaPlayer.channelFunscripts[availableChannels[0]]
    }
  }

  // Resume from current position
  timelinePlaybackStartTime = Date.now() - timelineCurrentPosition
  deps.mediaPlayer.isPlaying = true

  // Resume the video element if it exists (real video, not dummy)
  if (deps.mediaPlayer.videoElement && deps.mediaPlayer.videoElement.play && deps.mediaPlayer.videoElement.paused) {
    deps.mediaPlayer.videoElement.play()
  }

  // Restart the unified funscript sync
  if (deps.startFunscriptSync) {
    deps.startFunscriptSync()
  }

  // Restart timeline position tracking
  timelinePlaybackTimer = setInterval(() => {
    if (!deps.mediaPlayer || !deps.mediaPlayer.isPlaying) return

    timelineCurrentPosition = Date.now() - timelinePlaybackStartTime

    // Update video element time for sync
    if (deps.mediaPlayer.videoElement) {
      deps.mediaPlayer.videoElement.currentTime = timelineCurrentPosition / 1000
    }

    // Update scrubber
    $('#intiface-timeline-scrubber').val(timelineCurrentPosition)
    $('#intiface-timeline-current-time').text(formatDurationShort(timelineCurrentPosition))

    // Stop at end of actual content
    if (timelineCurrentPosition >= getContentDuration()) {
      stopTimeline()
      timelineCurrentPosition = 0
      $('#intiface-timeline-scrubber').val(0)
      $('#intiface-timeline-current-time').text('0:00')
      deps.updateStatus('Timeline playback complete')
    }
  }, 50)

  deps.updateStatus('Timeline resumed')
}

/**
 * Stop timeline playback using unified system
 */
export async function stopTimeline() {
  console.log(`${deps.NAME}: stopTimeline called`)

  // Use unified stop
  if (deps.stopMediaPlayback) {
    deps.stopMediaPlayback()
  }

  // Clear timeline timer
  if (timelinePlaybackTimer) {
    clearInterval(timelinePlaybackTimer)
    timelinePlaybackTimer = null
  }

  // Clear funscript data to prevent stale state
  if (deps.mediaPlayer) {
    deps.mediaPlayer.currentFunscript = null
    deps.mediaPlayer.channelFunscripts = {}
  }

  // Reset position
  timelineCurrentPosition = 0
  $('#intiface-timeline-scrubber').val(0)
  $('#intiface-timeline-current-time').text('0:00')

  deps.updateStatus('Timeline stopped')
}

/**
 * Update timeline from scrubber
 * @param {number} value - New position in milliseconds
 */
export function scrubTimeline(value) {
  timelineCurrentPosition = parseInt(value)
  $('#intiface-timeline-current-time').text(formatDurationShort(timelineCurrentPosition))

  if (deps.mediaPlayer && deps.mediaPlayer.isPlaying) {
    timelinePlaybackStartTime = Date.now() - timelineCurrentPosition
  }
}

/**
 * Update motor lanes for a channel
 * @param {string} channel - Channel letter (A, B, C, D)
 * @param {number} motorCount - Number of motors
 */
export function updateMotorLanes(channel, motorCount) {
  const lanesContainer = $(`.timeline-track-lanes[data-channel="${channel}"]`)

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

/**
 * Attach click handlers to timeline lanes
 */
export function attachLaneClickHandlers() {
  $(document).off('click', '.timeline-track-lane')
  $(document).on('click', '.timeline-track-lane', function(e) {
    if (e.target !== this) return

    const lane = $(this)
    const channel = lane.data('channel')
    const motor = lane.data('motor') || 1

    if (!timelineSelectedPattern) {
      deps.updateStatus('Select a pattern first, then click on a timeline track')
      return
    }

    // Calculate position from click
    const rect = this.getBoundingClientRect()
    const clickX = e.clientX - rect.left
    const laneWidth = rect.width
    const clickPercent = Math.max(0, Math.min(1, clickX / laneWidth))
    const startTime = Math.round(clickPercent * getTimelineDuration())

    console.log(`${deps.NAME}: Click on lane - clickX: ${clickX}, laneWidth: ${laneWidth}, clickPercent: ${clickPercent}, startTime: ${startTime}ms, visualDuration: ${getTimelineDuration()}ms`)

    // Add block with motor info
    addTimelineBlock(channel, startTime, motor)
  })
}

/**
 * Setup timeline event handlers
 * This should be called after the DOM is ready
 */
export function setupTimelineEventHandlers() {
  // Timeline control buttons
  $("#intiface-timeline-play").on("click", async function() {
    console.log(`${deps.NAME}: Timeline play button clicked`)

    // If paused (has data but not playing), resume from current position
    if (deps.mediaPlayer && !deps.mediaPlayer.isPlaying && Object.keys(deps.mediaPlayer.channelFunscripts || {}).length > 0) {
      resumeTimeline()
    } else if (deps.mediaPlayer && deps.mediaPlayer.isPlaying) {
      // Already playing - restart from beginning
      await stopTimeline()
      playTimeline()
    } else {
      // Fresh start
      playTimeline()
    }
  })

  $("#intiface-timeline-pause").on("click", async function() {
    console.log(`${deps.NAME}: Pause button clicked`)
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
        updateMotorLanes(channelUpper, parseInt(input.val()) || 2)
      } else {
        input.hide()
        updateMotorLanes(channelUpper, 1)
      }
    })

    input.on('change', function() {
      let val = parseInt($(this).val())
      if (val < 1) val = 1
      if (val > 8) val = 8
      $(this).val(val)
      if (checkbox.is(':checked')) {
        updateMotorLanes(channelUpper, val)
      }
    })
  })

  // Pattern intensity range sliders
  $("#intiface-pattern-min").on("input", function() {
    const min = parseInt($(this).val())
    $("#intiface-pattern-min-display").text(`${min}%`)
    const max = parseInt($("#intiface-pattern-max").val())
    if (min > max) {
      $("#intiface-pattern-max").val(min)
      $("#intiface-pattern-max-display").text(`${min}%`)
    }
  })

  $("#intiface-pattern-max").on("input", function() {
    const max = parseInt($(this).val())
    $("#intiface-pattern-max-display").text(`${max}%`)
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
    ['A', 'B', 'C', 'D'].forEach(channel => updateMotorLanes(channel, 1))
  } catch (e) {
    console.error(`${deps.NAME}: Error initializing motor lanes:`, e)
  }

  // Attach initial lane click handlers
  attachLaneClickHandlers()
}

// Export timeline state getters for external access
export function getTimelineBlocks() { return timelineBlocks }
export function getTimelineCurrentPosition() { return timelineCurrentPosition }
export function isTimelinePlaying() { return timelinePlaybackTimer !== null }

// Export category colors for external use
export { categoryColors }
