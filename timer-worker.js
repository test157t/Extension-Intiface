// Timer Worker for Intiface Extension
// This worker runs independently of the main thread and is not throttled when tab is hidden

let timerId = null;
let startTime = 0;
let expectedTime = 0;
let interval = 1000;
let isRunning = false;
let heartbeatId = null;
let lastTickTime = 0;

self.onmessage = function(e) {
  const { command, data } = e.data;

  switch (command) {
    case 'start':
      interval = data.interval || 1000;

      // Only start if not already running
      if (!isRunning) {
        startTime = Date.now();
        expectedTime = startTime + interval;
        isRunning = true;
        lastTickTime = startTime;

        function step() {
          if (!isRunning) return;

          const now = Date.now();
          const drift = now - expectedTime;

          // Send tick to main thread
          self.postMessage({ type: 'tick', timestamp: now, drift: drift });
          lastTickTime = now;

          // Calculate next expected time
          expectedTime += interval;

          // Schedule next tick
          const nextDelay = Math.max(0, interval - drift);
          timerId = setTimeout(step, nextDelay);
        }

        timerId = setTimeout(step, interval);

        // Start heartbeat to keep worker alive
        startHeartbeat();
      }
      break;

    case 'stop':
      isRunning = false;
      if (timerId) {
        clearTimeout(timerId);
        timerId = null;
      }
      if (heartbeatId) {
        clearInterval(heartbeatId);
        heartbeatId = null;
      }
      break;

    case 'interval':
      // Update interval for next cycle
      interval = data.interval || 1000;
      expectedTime = Date.now() + interval;
      break;
  }
};

function startHeartbeat() {
  // Send periodic heartbeat to ensure worker stays active
  heartbeatId = setInterval(() => {
    if (!isRunning) return;

    const now = Date.now();
    const timeSinceLastTick = now - lastTickTime;

    // If we haven't sent a tick in a while, send a heartbeat
    if (timeSinceLastTick > 5000) {
      self.postMessage({ type: 'heartbeat', timestamp: now });
    }
  }, 3000); // Check every 3 seconds
}

// Keep worker alive
self.onerror = function(e) {
  console.error('Timer worker error:', e);
};

