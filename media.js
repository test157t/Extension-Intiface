// ==========================================
// FUNSCRIPT AND MEDIA PLAYER MODULE
// ==========================================

// Dependencies (set by initMediaModule function)
let moduleDeps = null

// Initialize module with dependencies from main script
export function initMediaModule(dependencies) {
  moduleDeps = dependencies
  console.log(`${moduleDeps.NAME || 'Intiface'}: Media module initialized`)
}

// Helper to access dependencies
const d = (name) => moduleDeps?.[name]

// Media player state
let mediaPlayer = {
  videoElement: null,
  currentFunscript: null,
  channelFunscripts: {}, // Map of channel letter -> funscript (A, B, C, D, - for all)
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
  console.log(`${d("NAME") || "Intiface"}: Initializing media player...`)

  // Handle connect action button
  $("#intiface-connect-action-button").on("click", d("toggleConnection"))
  
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

// Handle play mode menu section toggle
$("#intiface-playmode-menu-toggle").on("click", function () {
const content = $("#intiface-playmode-menu-content")
const arrow = $("#intiface-playmode-menu-arrow")

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
  const newIntensity = parseInt($(this).val())
  // Update both funscript intensity AND global intensity scale
  mediaPlayer.globalIntensity = newIntensity
  globalIntensityScale = newIntensity
  const display = $("#intiface-menu-intensity-display")
  display.text(`${newIntensity}%`)
  // Color code based on intensity scale (0-400%)
  if (newIntensity < 100) {
    display.css("color", "#4CAF50") // Green: Reduced intensity
  } else if (newIntensity < 200) {
    display.css("color", "#FFEB3B") // Yellow: Slight boost
  } else if (newIntensity < 300) {
    display.css("color", "#FF9800") // Orange: Moderate boost
  } else {
    display.css("color", "#F44336") // Red: Maximum boost
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

    // Handle z-index slider
    $("#intiface-menu-zindex").on("input", function() {
        const zindex = parseInt($(this).val())
        $("#intiface-menu-zindex-display").text(zindex)
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

// Handle internal proxy checkbox
$("#intiface-use-internal-proxy").on("change", function() {
    const useProxy = $(this).is(":checked")
    if (useProxy) {
        startInternalProxy()
    } else {
        stopInternalProxy()
    }
    saveMediaPlayerAppearance()
})
  
// Handle reset button
$("#intiface-reset-appearance-btn").on("click", function() {
    $("#intiface-menu-opacity").val(50)
    $("#intiface-menu-video-opacity").val(100)
    $("#intiface-menu-width").val(100)
    $("#intiface-menu-position").val("top")
    $("#intiface-menu-zindex").val(1)
    $("#intiface-menu-show-filename").prop("checked", true)
    $("#intiface-menu-show-border").prop("checked", true)
    $("#intiface-use-internal-proxy").prop("checked", false)
    $("#intiface-menu-opacity-display").text("50%")
    $("#intiface-menu-video-opacity-display").text("100%")
    $("#intiface-menu-width-display").text("1.0x")
    $("#intiface-menu-zindex-display").text("1")
    // Stop proxy if running
    stopInternalProxy()
    applyMediaPlayerAppearance()
    saveMediaPlayerAppearance()
})

  console.log(`${d("NAME") || "Intiface"}: Media player initialized`)

// Auto-load media list on startup
refreshMenuMediaList().catch(e => {
  console.log(`${d("NAME") || "Intiface"}: Failed to auto-load media list:`, e.message)
})
}

// Load saved appearance settings
function loadMediaPlayerAppearance() {
    const savedOpacity = localStorage.getItem("intiface-player-opacity")
    const savedVideoOpacity = localStorage.getItem("intiface-player-video-opacity")
    const savedWidth = localStorage.getItem("intiface-player-width")
    const savedPosition = localStorage.getItem("intiface-player-position")
    const savedZIndex = localStorage.getItem("intiface-player-zindex")
    const savedShowFilename = localStorage.getItem("intiface-player-show-filename")
    const savedShowBorder = localStorage.getItem("intiface-player-show-border")
    const savedUseProxy = localStorage.getItem("intiface-player-use-proxy")

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

    if (savedZIndex) {
        $("#intiface-menu-zindex").val(savedZIndex)
        $("#intiface-menu-zindex-display").text(savedZIndex)
    }

    if (savedShowFilename !== null) {
        $("#intiface-menu-show-filename").prop("checked", savedShowFilename === "true")
    }

    if (savedShowBorder !== null) {
        $("#intiface-menu-show-border").prop("checked", savedShowBorder === "true")
    }

    if (savedUseProxy === "true") {
        $("#intiface-use-internal-proxy").prop("checked", true)
        // Auto-start proxy on load if enabled
        startInternalProxy().catch(e => {
            console.log(`${d("NAME") || "Intiface"}: Failed to auto-start proxy:`, e.message)
            $("#intiface-use-internal-proxy").prop("checked", false)
        })
    }
}

// Save appearance settings
function saveMediaPlayerAppearance() {
    const opacity = $("#intiface-menu-opacity").val()
    const videoOpacity = $("#intiface-menu-video-opacity").val()
    const width = $("#intiface-menu-width").val()
    const position = $("#intiface-menu-position").val()
    const zindex = $("#intiface-menu-zindex").val()
    const showFilename = $("#intiface-menu-show-filename").is(":checked")
    const showBorder = $("#intiface-menu-show-border").is(":checked")
    const useProxy = $("#intiface-use-internal-proxy").is(":checked")

    localStorage.setItem("intiface-player-opacity", opacity)
    localStorage.setItem("intiface-player-video-opacity", videoOpacity)
    localStorage.setItem("intiface-player-width", width)
    localStorage.setItem("intiface-player-position", position)
    localStorage.setItem("intiface-player-zindex", zindex)
    localStorage.setItem("intiface-player-show-filename", showFilename)
    localStorage.setItem("intiface-player-show-border", showBorder)
    localStorage.setItem("intiface-player-use-proxy", useProxy)
}

// Apply appearance settings to media player
function applyMediaPlayerAppearance() {
    const opacity = parseInt($("#intiface-menu-opacity").val()) / 100
    const videoOpacity = parseInt($("#intiface-menu-video-opacity").val()) / 100
    const width = parseInt($("#intiface-menu-width").val())
    const position = $("#intiface-menu-position").val()
    const zindex = parseInt($("#intiface-menu-zindex").val())
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
  
// Apply scale to both width and height
    panel.css("width", `${width}%`)
    
    // Scale the video player - width controls the size
    const videoPlayer = $("#intiface-chat-video-player")
    const videoContainer = $("#intiface-chat-video-container")
    if (videoContainer.length > 0) {
        // Scale the container width
        videoContainer.css("width", `${width}%`)
        videoContainer.css("margin", "0 auto")
    }
    // Video will scale naturally with height: auto
  
    // Apply position
    if (position === "center") {
        panel.css("position", "fixed")
        panel.css("top", "50%")
        panel.css("left", "50%")
        panel.css("transform", "translate(-50%, -50%)")
        panel.css("z-index", Math.max(9999, zindex))
        panel.css("max-height", "80vh")
        panel.css("margin-bottom", "0")
    } else {
        panel.css("position", "")
        panel.css("top", "")
        panel.css("left", "")
        panel.css("transform", "")
        panel.css("z-index", zindex)
        panel.css("max-height", "")
        panel.css("margin-bottom", "10px")
    }

    // Apply video opacity (videoPlayer already declared above)
    if (videoPlayer.length > 0) {
        videoPlayer.css("opacity", videoOpacity)
        // Also set as style attribute for fullscreen persistence
        videoPlayer[0].style.setProperty('opacity', videoOpacity, 'important')
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

// ==========================================
// WEBSOCKET PROXY MANAGEMENT
// ==========================================

let proxyProcess = null // Track the proxy subprocess

// Start the internal WebSocket proxy
async function startInternalProxy() {
    if (proxyProcess) {
        console.log(`${d("NAME") || "Intiface"}: Proxy already running`)
        updateProxyStatus(true)
        return
    }

    try {
        const response = await fetch('/api/plugins/intiface-launcher/proxy/start', {
            method: 'POST',
            headers: d("getRequestHeaders")()
        })

        const data = await response.json()
    if (data.success) {
      console.log(`${d("NAME") || "Intiface"}: Proxy started on port ${data.port}`)
      proxyProcess = { pid: data.pid, port: data.port }
      updateProxyStatus(true)
      // Note: The IP input field is NOT changed - proxy runs internally
    }
    } catch (err) {
        console.error(`${d("NAME") || "Intiface"}: Failed to start proxy:`, err)
        updateProxyStatus(false, err.message)
        throw err
    }
}

// Stop the internal WebSocket proxy
async function stopInternalProxy() {
    if (!proxyProcess) {
        console.log(`${d("NAME") || "Intiface"}: Proxy not running`)
        updateProxyStatus(false)
        return
    }

    try {
        const response = await fetch('/api/plugins/intiface-launcher/proxy/stop', {
            method: 'POST',
            headers: d("getRequestHeaders")()
        })

    const data = await response.json()
    if (data.success) {
      console.log(`${d("NAME") || "Intiface"}: Proxy stopped`)
      proxyProcess = null
      updateProxyStatus(false)
      // Note: The IP input field is NOT changed - proxy runs internally
    }
  } catch (err) {
    console.error(`${d("NAME") || "Intiface"}: Failed to stop proxy:`, err)
    // Force reset even if error
    proxyProcess = null
    updateProxyStatus(false)
    // Note: The IP input field is NOT changed - proxy runs internally
  }
}

// Update the proxy status display
function updateProxyStatus(running, errorMessage = null) {
    const statusEl = $("#intiface-proxy-status")
    if (running) {
        statusEl.show()
        statusEl.html('<i class="fa-solid fa-circle" style="color: #4CAF50; font-size: 0.6em; margin-right: 5px;"></i>Proxy running on port 12346')
    } else if (errorMessage) {
        statusEl.show()
        statusEl.html(`<i class="fa-solid fa-circle-exclamation" style="color: #f44336; font-size: 0.6em; margin-right: 5px;"></i>Error: ${errorMessage}`)
    } else {
        statusEl.hide()
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
      headers: d("getRequestHeaders")()
    })
    
    if (!pathsResponse.ok) throw new Error('Failed to get paths')
    
    const pathsData = await pathsResponse.json()
    const mediaPath = pathsData.paths?.intifaceMedia
    
    if (!mediaPath) throw new Error('No media path')
    
    // Fetch media files
    const response = await fetch(`/api/plugins/intiface-launcher/media?dir=${encodeURIComponent(mediaPath)}`, {
      method: 'GET',
      headers: d("getRequestHeaders")()
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
            </div>
          <span style="font-size: 0.75em; color: #888; white-space: nowrap;">${sizeMB} MB</span>
        </div>
      `
      })
    
  mediaListEl.html(html)

  } catch (error) {
    console.error(`${d("NAME") || "Intiface"}: Failed to refresh menu media:`, error)
    mediaListEl.html(`<div style="color: #F44336; text-align: center; padding: 20px;">Error loading media</div>`)
  }
}

// Load Funscript file - looks in funscript folder for matching file
async function loadFunscript(videoPath) {
try {
// Extract just the filename without extension
const videoFilename = videoPath.split(/[\\/]/).pop()
const baseName = videoFilename.replace(/\.[^.]+$/, '')

// Construct direct URL to funscript
const funscriptFilename = `${baseName}.funscript`
const funscriptUrl = `/assets/funscript/${encodeURIComponent(funscriptFilename)}`

console.log(`${d("NAME") || "Intiface"}: Loading Funscript from:`, funscriptUrl)

// Check cache
if (funscriptCache.has(funscriptUrl)) {
mediaPlayer.currentFunscript = funscriptCache.get(funscriptUrl)
updateChatFunscriptUI(mediaPlayer.currentFunscript)
return
}

// Fetch directly from static assets
const response = await fetch(funscriptUrl, {
method: 'GET',
headers: d("getRequestHeaders")()
})

if (!response.ok) {
if (response.status === 404) {
console.log(`${d("NAME") || "Intiface"}: No funscript found for:`, funscriptFilename)
return
}
throw new Error('Failed to load Funscript')
}

const rawFunscript = await response.json()

// Process Funscript
const funscript = processFunscript(rawFunscript)
funscriptCache.set(funscriptUrl, funscript)
    
    mediaPlayer.currentFunscript = funscript
    updateChatFunscriptUI(funscript)

  } catch (error) {
    console.error(`${d("NAME") || "Intiface"}: Failed to load Funscript:`, error)
    $("#intiface-chat-funscript-info").text(`Error: ${error.message}`).css("color", "#F44336")
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

  // Track last processed time to detect time jumps
  let lastProcessedTime = (mediaPlayer.videoElement?.currentTime || 0) * 1000

  const syncLoop = () => {
    if (!mediaPlayer.isPlaying || !mediaPlayer.currentFunscript) {
      // Still need to reschedule the loop even when not playing
      if (mediaPlayer.isPlaying) {
        const interval = d("getPollingInterval")()
        mediaPlayer.animationFrameId = setTimeout(syncLoop, interval)
      }
      return
    }

    const video = mediaPlayer.videoElement
    const funscript = mediaPlayer.currentFunscript
    const currentTime = (video.currentTime * 1000) + mediaPlayer.syncOffset
    
    // Detect large time jumps (>2 seconds) - user likely seeked
    const timeDelta = currentTime - lastProcessedTime
    if (Math.abs(timeDelta) > 2000) {
      console.log(`${d("NAME") || "Intiface"}: Time jump detected (${timeDelta}ms), recalculating action index`)
      
      // Recalculate lastActionIndex based on current time
      const actions = funscript.actions
      let newIndex = 0
      for (let i = 0; i < actions.length; i++) {
        if (actions[i].at <= currentTime) {
          newIndex = i + 1
        } else {
          break
        }
      }
      mediaPlayer.lastActionIndex = newIndex
      
      // If seeking backwards, execute the action at the new position immediately
      if (timeDelta < 0 && newIndex > 0) {
        const actionToReplay = actions[newIndex - 1]
        if (actionToReplay) {
          console.log(`${d("NAME") || "Intiface"}: Replaying action at ${actionToReplay.at}ms after backward jump`)
          executeFunscriptAction(actionToReplay)
        }
      }
    }
    
    lastProcessedTime = currentTime

    // Find and execute actions
    const actions = funscript.actions
    if (!actions || actions.length === 0) {
      console.log(`${d("NAME") || "Intiface"}: syncLoop - no actions in funscript`)
    }
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
      lastProcessedTime = 0
    }

    // Use polling rate interval instead of requestAnimationFrame for consistent timing
    const interval = d("getPollingInterval")()
    mediaPlayer.animationFrameId = setTimeout(syncLoop, interval)
  }

  syncLoop()
}

// Stop Funscript synchronization
function stopFunscriptSync() {
  if (mediaPlayer.animationFrameId) {
    clearTimeout(mediaPlayer.animationFrameId)
    mediaPlayer.animationFrameId = null
  }
  stopFunscriptSyncTimer()
}

// Timer-based Funscript sync for background tab operation
function startFunscriptSyncTimer() {
  if (!mediaPlayer.videoElement || !mediaPlayer.currentFunscript) {
    console.log(`${d("NAME") || "Intiface"}: Cannot start timer sync - videoElement: ${!!mediaPlayer.videoElement}, funscript: ${!!mediaPlayer.currentFunscript}`)
    return
  }
  
  // Clear any existing timer first
  stopFunscriptSyncTimer()
  
  // If media is not paused, ensure isPlaying is true
  if (!mediaPlayer.videoElement.paused) {
    mediaPlayer.isPlaying = true
  }
  
  console.log(`${d("NAME") || "Intiface"}: Starting timer-based funscript sync`)
  
  // Store last execution time to handle browser throttling
  let lastExecutionTime = Date.now()
  let lastProcessedTimeTimer = (mediaPlayer.videoElement?.currentTime || 0) * 1000

  const syncLoop = () => {
    // Only run while hidden and playing
    if (!mediaPlayer.isPlaying || !mediaPlayer.currentFunscript || !document.hidden) {
      console.log(`${d("NAME") || "Intiface"}: Timer sync stopping - isPlaying: ${mediaPlayer.isPlaying}, hasFunscript: ${!!mediaPlayer.currentFunscript}, hidden: ${document.hidden}`)
      return
    }

    const video = mediaPlayer.videoElement
    const funscript = mediaPlayer.currentFunscript
    const currentTime = (video.currentTime * 1000) + mediaPlayer.syncOffset

    // Calculate time delta to catch up on missed actions due to throttling
    const now = Date.now()
    const executionDelta = now - lastExecutionTime
    lastExecutionTime = now
    
    // Detect large time jumps (>2 seconds) - user likely seeked
    const timeDelta = currentTime - lastProcessedTimeTimer
    if (Math.abs(timeDelta) > 2000) {
      console.log(`${d("NAME") || "Intiface"}: Timer sync - Time jump detected (${timeDelta}ms), recalculating action index`)
      
      // Recalculate lastActionIndex based on current time
      const actions = funscript.actions
      let newIndex = 0
      for (let i = 0; i < actions.length; i++) {
        if (actions[i].at <= currentTime) {
          newIndex = i + 1
        } else {
          break
        }
      }
      mediaPlayer.lastActionIndex = newIndex
      
      // If seeking backwards, execute the action at the new position immediately
      if (timeDelta < 0 && newIndex > 0) {
        const actionToReplay = actions[newIndex - 1]
        if (actionToReplay) {
          console.log(`${d("NAME") || "Intiface"}: Timer sync - Replaying action at ${actionToReplay.at}ms after backward jump`)
          executeFunscriptAction(actionToReplay)
        }
      }
    }
    
    lastProcessedTimeTimer = currentTime

    // Find and execute actions - process ALL actions up to current time
    // to catch up if browser throttled us
    const actions = funscript.actions
    const targetTime = currentTime + executionDelta // Look ahead by the time that passed

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
      lastProcessedTimeTimer = 0
    }

    // Continue loop only if still hidden
    if (document.hidden && mediaPlayer.isPlaying) {
      // Use polling rate interval for consistent device timing
      const interval = d("getPollingInterval")()
      mediaPlayer.syncTimerId = setTimeout(syncLoop, interval)
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
  // Check if media is still playing before executing
  if (!mediaPlayer.isPlaying || !mediaPlayer.videoElement) {
    console.log(`${d("NAME") || "Intiface"}: executeFunscriptAction - not playing or no video`)
    return
  }
  if (!d("client")?.connected || d("devices")?.length === 0) {
    console.log(`${d("NAME") || "Intiface"}: executeFunscriptAction - not connected or no devices`)
    return
  }
  
  console.log(`${d("NAME") || "Intiface"}: Executing action at ${action.at} with pos ${JSON.stringify(action.pos)}`)

  // Send to devices based on their channel assignments
  const promises = []
  console.log(`${d("NAME") || "Intiface"}: Processing ${d("devices")?.length || 0} devices for action`)
  
  for (let i = 0; i < d("devices")?.length; i++) {
    const targetDevice = d("devices")[i]
    const deviceIndex = targetDevice.index
    const deviceType = d("getDeviceType")(targetDevice)

    // Get device channel assignment
    const channel = d("deviceAssignments")[deviceIndex] || '-'
    
    console.log(`${d("NAME") || "Intiface"}: Device ${i} (index ${deviceIndex}) on channel '${channel}', type: ${deviceType}`)
    console.log(`${d("NAME") || "Intiface"}: Device vibrateAttributes:`, targetDevice.vibrateAttributes)

    // Get the appropriate funscript for this device
    let deviceFunscript = mediaPlayer.currentFunscript
    if (mediaPlayer.channelFunscripts[channel]) {
      deviceFunscript = mediaPlayer.channelFunscripts[channel]
      console.log(`${d("NAME") || "Intiface"}: Using channel-specific funscript for ${channel}`)
    }

    // If no device-specific funscript and channel is not '-', skip this device
    if (channel !== '-' && !mediaPlayer.channelFunscripts[channel]) {
      console.log(`${d("NAME") || "Intiface"}: Skipping device ${deviceIndex} - no funscript for channel ${channel}`)
      continue // Device has specific channel but no funscript for it
    }

    // Handle multi-motor arrays
    const isMultiMotor = Array.isArray(action.pos)
    const positions = isMultiMotor ? action.pos : [action.pos]
    
    // Get motor count for this device
    const motorCount = d("getMotorCount")(targetDevice)
    
    // Apply global intensity modifier using MultiFunPlayer's approach:
    // Scale the deviation from default (50%), not the raw value
    const defaultValue = 50 // Neutral point (50%)
    const scale = mediaPlayer.globalIntensity / 100 // Convert percentage to multiplier
    
    try {
      // Choose control method based on device type
      console.log(`${d("NAME") || "Intiface"}: Device ${deviceIndex} - checking capabilities: LinearCmd=${!!targetDevice.messageAttributes?.LinearCmd}, vibrateAttributes=${targetDevice.vibrateAttributes?.length || 0}`)
      
      if (deviceType === 'stroker' && targetDevice.messageAttributes?.LinearCmd) {
        // Linear device (stroker) - use first motor position
        const scriptValue = positions[0] || 50
        const scaledValue = defaultValue + (scriptValue - defaultValue) * scale
        let adjustedPos = Math.min(100, Math.max(0, Math.round(scaledValue)))
        adjustedPos = d("applyInversion")(adjustedPos)
        console.log(`${d("NAME") || "Intiface"}: Sending linear command to device ${deviceIndex}`)
        promises.push(targetDevice.linear(adjustedPos / 100, 100))
      } else if (targetDevice.vibrateAttributes?.length > 0) {
        // Vibration device - can have multiple motors
        console.log(`${d("NAME") || "Intiface"}: Sending vibration to device ${deviceIndex} with ${targetDevice.vibrateAttributes.length} motors, action pos=${JSON.stringify(action.pos)}`)
        const vibrateAttrs = targetDevice.vibrateAttributes
        
        console.log(`${d("NAME") || "Intiface"}: vibrateAttrs length: ${vibrateAttrs.length}, positions length: ${positions.length}`)

        for (let motorIndex = 0; motorIndex < Math.min(vibrateAttrs.length, positions.length); motorIndex++) {
          const scriptValue = positions[motorIndex]
          const scaledValue = defaultValue + (scriptValue - defaultValue) * scale
          let adjustedPos = Math.min(100, Math.max(0, Math.round(scaledValue)))
          adjustedPos = d("applyInversion")(adjustedPos)

          console.log(`${d("NAME") || "Intiface"}: Motor ${motorIndex} - vibrateAttr exists: ${!!vibrateAttrs[motorIndex]}, Index: ${vibrateAttrs[motorIndex]?.Index}`)

          if (vibrateAttrs[motorIndex]) {
            const ButtplugModule = d("buttplug")
            const scalarCmd = new ButtplugModule.ScalarSubcommand(
              vibrateAttrs[motorIndex].Index,
              adjustedPos / 100,
              "Vibrate"
            )
            console.log(`${d("NAME") || "Intiface"}: Pushing command for motor ${motorIndex} with pos ${adjustedPos}`)
            promises.push(targetDevice.scalar(scalarCmd))
          }
        }
      } else {
        console.log(`${d("NAME") || "Intiface"}: Device ${deviceIndex} has no supported capabilities (not stroker, no vibrateAttributes)`)
      }
    } catch (e) {
      console.error(`${d("NAME") || "Intiface"}: Error executing action for device ${deviceIndex}:`, e)
    }
  }

  // Execute all device commands in parallel
  if (promises.length > 0) {
    console.log(`${d("NAME") || "Intiface"}: Executing ${promises.length} device commands`)
    await Promise.all(promises)
  } else {
    console.log(`${d("NAME") || "Intiface"}: No device commands to execute`)
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
  d("stopAllDeviceActions")()
  
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
    <div id="intiface-chat-media-panel" style="display: none; width: 100%; position: relative; margin-bottom: 10px; padding: 0;">
        <!-- Video Player -->
        <div id="intiface-chat-video-container" style="position: relative; width: 100%; line-height: 0;">
            <video id="intiface-chat-video-player" style="width: 100%; height: auto; border-radius: 4px; background: #000; display: block;" controls>
                Your browser does not support the video tag.
            </video>
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
  console.log(`${d("NAME") || "Intiface"}: Loading media file in chat:`, filename)
  
  try {
    // Get asset paths
    const pathsResponse = await fetch('/api/plugins/intiface-launcher/asset-paths', {
      method: 'GET',
      headers: d("getRequestHeaders")()
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

// Check if this is an audio file
const audioExtensions = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.opus']
const isAudioFile = audioExtensions.some(ext => filename.toLowerCase().endsWith(ext))

// Adjust styling for audio files to remove extra padding
if (isAudioFile) {
videoPlayer.css({
'height': '54px',
'max-height': '54px',
'object-fit': 'none',
'background': 'transparent',
'border': 'none',
'padding': '0',
'margin': '0',
'display': 'block'
})
$("#intiface-chat-video-container").css({
'height': '54px',
'max-height': '54px',
'line-height': '1',
'margin-bottom': '0',
'padding': '0',
'overflow': 'hidden'
})
// Add class for future reference
videoPlayer.addClass('audio-mode')
} else {
// Reset to video styling
videoPlayer.css({
'height': 'auto',
'max-height': 'none',
'object-fit': 'contain',
'background': '#000',
'border': '',
'padding': '',
'margin': ''
})
$("#intiface-chat-video-container").css({
'height': '',
'max-height': '',
'line-height': '0',
'margin-bottom': '0',
'padding': '',
'overflow': ''
})
videoPlayer.removeClass('audio-mode')
}
    
    // Store reference
    mediaPlayer.videoElement = videoPlayer[0]
    mediaPlayer.currentMediaPath = videoPath
    
// Check for funscripts (look in funscript folder)
// Support multiple funscripts: filename.funscript, filename_A.funscript, filename_B.funscript, etc.
const baseName = filename.replace(/\.[^.]+$/, '')
const funscriptFolder = pathsData.paths?.funscript

// Clear previous channel funscripts
mediaPlayer.channelFunscripts = {}

// Get list of channels that actually have devices assigned
const activeChannels = new Set(['-']) // Always include base channel
for (const device of d("devices") || []) {
const channel = d("deviceAssignments")[device.index] || '-'
activeChannels.add(channel)
}

console.log(`${d("NAME") || "Intiface"}: Active channels: ${Array.from(activeChannels).join(', ')}`)

// Load funscripts only for active channels
const loadPromises = Array.from(activeChannels).map(async (channel) => {
const suffix = channel === '-' ? '' : `_${channel}`
const funscriptFilename = `${baseName}${suffix}.funscript`
const funscriptUrl = `/assets/funscript/${encodeURIComponent(funscriptFilename)}`

try {
const funscriptResponse = await fetch(funscriptUrl, {
method: 'GET',
headers: d("getRequestHeaders")()
})

if (funscriptResponse.ok) {
const funscriptData = await funscriptResponse.json()
const funscript = processFunscript(funscriptData)
funscriptCache.set(funscriptUrl, funscript)
mediaPlayer.channelFunscripts[channel] = funscript
console.log(`${d("NAME") || "Intiface"}: Loaded funscript for channel ${channel}: ${funscriptFilename}`)
return { channel, success: true }
} else if (funscriptResponse.status === 404) {
console.log(`${d("NAME") || "Intiface"}: Funscript not found for channel ${channel}: ${funscriptFilename}`)
return { channel, success: false }
} else {
console.error(`${d("NAME") || "Intiface"}: Failed to load funscript for channel ${channel}: ${funscriptResponse.status}`)
return { channel, success: false }
}
} catch (e) {
console.error(`${d("NAME") || "Intiface"}: Error loading funscript for channel ${channel}:`, e)
return { channel, success: false }
}
})

const results = await Promise.all(loadPromises)

// Set current funscript (base channel takes priority)
if (mediaPlayer.channelFunscripts['-']) {
mediaPlayer.currentFunscript = mediaPlayer.channelFunscripts['-']
updateChatFunscriptUI(mediaPlayer.currentFunscript)
} else {
// Use first available channel
const firstChannel = results.find(r => r.success)?.channel
if (firstChannel) {
mediaPlayer.currentFunscript = mediaPlayer.channelFunscripts[firstChannel]
updateChatFunscriptUI(mediaPlayer.currentFunscript)
    } else {
      mediaPlayer.currentFunscript = null
    }
}
    
    // Setup video event listeners
    setupChatVideoEventListeners()
    
    // Auto-play
    videoPlayer[0].play().catch(e => {
      console.log(`${d("NAME") || "Intiface"}: Auto-play prevented, user must click play`)
    })
    
  } catch (error) {
    console.error(`${d("NAME") || "Intiface"}: Failed to load media:`, error)
    d("updateStatus")(`Media load failed: ${error.message}`, true)
  }
}

// Setup video event listeners for chat panel
function setupChatVideoEventListeners() {
  const video = mediaPlayer.videoElement
  if (!video) {
    console.log(`${d("NAME") || "Intiface"}: No video element found, cannot setup event listeners`)
    return
  }

  console.log(`${d("NAME") || "Intiface"}: Setting up video event listeners`)

  // Remove old listeners
  video.onplay = null
  video.onpause = null
  video.onended = null

// Add new listeners
video.onplay = async () => {
console.log(`${d("NAME") || "Intiface"}: Video onplay event fired`)

// Wait a moment for device to finish stopping if it was just paused
await new Promise(resolve => setTimeout(resolve, 50))

mediaPlayer.isPlaying = true

// Reset last action index to ensure we start from current position
if (mediaPlayer.videoElement) {
const currentTime = mediaPlayer.videoElement.currentTime * 1000
// Find the correct starting position in the funscript
if (mediaPlayer.currentFunscript && mediaPlayer.currentFunscript.actions) {
const actions = mediaPlayer.currentFunscript.actions
for (let i = 0; i < actions.length; i++) {
if (actions[i].at > currentTime) {
mediaPlayer.lastActionIndex = Math.max(0, i - 1)
break
}
}
}
}

      // Clear any pending AI commands when video starts playing
      const msgCmds = d("messageCommands")
      if (msgCmds && msgCmds.length > 0) {
        console.log(`${d("NAME") || "Intiface"}: Clearing ${msgCmds.length} pending AI commands - video playback has priority`)
        msgCmds.length = 0
executedCommands.clear()
}

startFunscriptSync()
d("updateStatus")(`Playing funscript on ${d("devices")?.length} device(s)`)
$("#intiface-chat-funscript-info").text("Playing - Funscript active").css("color", "#4CAF50")
}

video.onpause = async () => {
console.log(`${d("NAME") || "Intiface"}: Video onpause triggered - hidden: ${document.hidden}, devices: ${d("devices")?.length}, connected: ${d("client")?.connected}`)
// Don't stop if tab is hidden - let visibility handler manage background mode
if (document.hidden) {
console.log(`${d("NAME") || "Intiface"}: Video/audio paused but tab is hidden - continuing in background mode`)
// Keep isPlaying true so background sync can work
return
}
console.log(`${d("NAME") || "Intiface"}: Video/audio paused - stopping funscript sync and device`)
// Set isPlaying false FIRST to prevent any new commands from being sent
mediaPlayer.isPlaying = false
// Stop sync loops immediately
stopFunscriptSync()
// Small delay to let any in-flight commands complete, then stop device
await new Promise(resolve => setTimeout(resolve, 100))
await d("stopAllDeviceActions")()
$("#intiface-chat-funscript-info").text("Paused").css("color", "#FFA500")
}

  video.onended = () => {
    console.log(`${d("NAME") || "Intiface"}: Video onended event fired`)
    mediaPlayer.isPlaying = false
    stopFunscriptSync()

    if ($("#intiface-menu-loop").is(":checked")) {
      video.currentTime = 0
      mediaPlayer.lastActionIndex = 0
      video.play()
    } else {
      $("#intiface-chat-funscript-info").text("Finished").css("color", "#888")
      d("stopAllDeviceActions")()
    }
  }

  // Handle video seeking - recalculate lastActionIndex to prevent sync loss
  video.onseeked = () => {
    console.log(`${d("NAME") || "Intiface"}: Video seeked to ${video.currentTime}s`)
    
    if (!mediaPlayer.currentFunscript || !mediaPlayer.currentFunscript.actions) {
      return
    }
    
    const currentTimeMs = video.currentTime * 1000
    const actions = mediaPlayer.currentFunscript.actions
    
    // Find the correct action index for the new time position
    // We want the last action that should have been executed by this time
    let newIndex = 0
    for (let i = 0; i < actions.length; i++) {
      if (actions[i].at <= currentTimeMs) {
        newIndex = i + 1
      } else {
        break
      }
    }
    
    const oldIndex = mediaPlayer.lastActionIndex
    mediaPlayer.lastActionIndex = newIndex
    
    console.log(`${d("NAME") || "Intiface"}: Seek corrected - lastActionIndex ${oldIndex} -> ${newIndex} at ${currentTimeMs}ms`)
    
    // If seeking backwards, we need to re-execute the action at the new position
    // to ensure the device is at the correct intensity
    if (newIndex < oldIndex && newIndex > 0) {
      const actionToReplay = actions[newIndex - 1]
      if (actionToReplay) {
        console.log(`${d("NAME") || "Intiface"}: Replaying action at ${actionToReplay.at}ms after backward seek`)
        executeFunscriptAction(actionToReplay)
      }
    }
  }

  console.log(`${d("NAME") || "Intiface"}: Video event listeners setup complete`)
}

// Update Funscript UI in chat panel
function updateChatFunscriptUI(funscript) {
if (!funscript) return

// Get available channels
const availableChannels = Object.keys(mediaPlayer.channelFunscripts || {})
const channelInfo = availableChannels.length > 1 
? `<div style="font-size: 0.7em; color: #64B5F6; margin-top: 2px;">
<i class="fa-solid fa-layer-group"></i> Channels: ${availableChannels.filter(c => c !== '-').join(', ')}
</div>`
: ''

// Update chat panel
$("#intiface-chat-funscript-duration").text(`${(funscript.duration / 1000).toFixed(1)}s`)
$("#intiface-chat-funscript-info").html(`
${funscript.stats.actionCount} actions |
Range: ${funscript.stats.minPosition}-${funscript.stats.maxPosition}%
${channelInfo}
`).css("color", "#888")

}



// View funscript details (for AI to see the data)
async function handleFunscriptView() {
  if (!mediaPlayer.currentFunscript) {
    console.log(`${d("NAME") || "Intiface"}: No funscript loaded to view`)
    return false
  }

  const funscript = mediaPlayer.currentFunscript
  const summary = {
    actionCount: funscript.stats.actionCount,
    duration: `${(funscript.duration / 1000).toFixed(1)}s`,
    avgPosition: funscript.stats.avgPosition,
    minPosition: funscript.stats.minPosition,
    maxPosition: funscript.stats.maxPosition
  }

  console.log(`${d("NAME") || "Intiface"}: Funscript view requested:`, summary)
  d("updateStatus")(`Funscript: ${summary.actionCount} actions, ${summary.duration}`)

  return true
}

// Check for video/MP4 mentions in chat messages
function checkForVideoMentions(text) {
  // Match various patterns:
  // - "plays filename.mp4|.m4a|.mp3|.wav|.webm|.mkv|.avi|.mov|.ogg"
  // - "filename.ext" (no spaces in filename)
  // - <video:filename.ext>
  // - <media:PLAY: filename with spaces.ext>
  // - "playing filename.ext"
  // - "load filename.ext"

  const mediaExtensions = 'mp4|m4a|mp3|wav|webm|mkv|avi|mov|ogg|oga|ogv';
  const patterns = [
    // Match <media:PLAY: filename.ext> format (handles spaces in filename, non-greedy)
    new RegExp(`<media:PLAY:\\s*([^<>]+?\\.(${mediaExtensions}))>`, 'i'),
    // Match <video:filename.ext> format
    new RegExp(`<video:\\s*([^<>]+?\\.(${mediaExtensions}))>`, 'i'),
    // Match play/load commands with quoted filenames (handles spaces)
    new RegExp(`(?:play|playing|loads?|show|watch)\\s+(?:the\\s+)?(?:video|audio|media)?\\s*["']([^"']+\\.(${mediaExtensions}))["']`, 'i'),
    // Match play commands with unquoted filenames (no spaces)
    new RegExp(`(?:play|playing|loads?|show|watch)\\s+(?:the\\s+)?(?:video|audio|media)?\\s*["']?([^"'\\s<>]+\\.(${mediaExtensions}))["']?`, 'i'),
    // Match standalone quoted filenames
    new RegExp(`["']([^"']+\\.(${mediaExtensions}))["']`, 'i'),
    // Match standalone unquoted filenames (no spaces, no angle brackets)
    new RegExp(`\\b([^"'\\s<>]+\\.(${mediaExtensions}))\\b`, 'i')
  ]

  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match) {
      const filename = match[1].trim()
      console.log(`${d("NAME") || "Intiface"}: Detected video mention:`, filename)
      return filename
    }
  }

  return null
}

// ==========================================
// EXPORTS
// ==========================================

// State exports
export { mediaPlayer, funscriptCache }

// Function exports  
export {
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
}

// ==========================================
// END FUNSCRIPT AND MEDIA PLAYER MODULE
// ==========================================
