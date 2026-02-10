// SillyTavern Server Plugin for Intiface Central Launcher
// Place this file in: SillyTavern/plugins/intiface-launcher.js

const { spawn } = require('child_process');

const info = {
    id: 'intiface-launcher',
    name: 'Intiface Central Launcher',
    description: 'Allows starting Intiface Central from the browser extension'
};

async function init(router) {
  console.log('[Intiface Launcher Plugin] Initializing...');
  
  // Middleware to log all requests
  router.use((req, res, next) => {
    console.log(`[Intiface Launcher] ${req.method} ${req.path}`);
    next();
  });
  
  // Test endpoint - just returns success
  router.get('/test', (req, res) => {
    console.log('[Intiface Launcher] Test endpoint called');
    res.json({ success: true, message: 'Plugin is working' });
  });
  
  // Endpoint to start Intiface Central
  router.post('/start', async (req, res) => {
        try {
            const { exePath } = req.body;
            
            if (!exePath) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'No executable path provided' 
                });
            }

            // Validate it's an executable
            if (!exePath.endsWith('.exe') && !exePath.endsWith('.app')) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Path must point to an executable file' 
                });
            }

            console.log(`[Intiface Launcher] Starting: ${exePath}`);

            // Spawn Intiface Central
            const intifaceProcess = spawn(exePath, [], {
                detached: true,
                stdio: 'ignore',
                windowsHide: true
            });

            // Handle errors
            intifaceProcess.on('error', (err) => {
                console.error(`[Intiface Launcher] Failed to start: ${err.message}`);
            });

            intifaceProcess.on('exit', (code) => {
                if (code !== 0 && code !== null) {
                    console.error(`[Intiface Launcher] Process exited with code ${code}`);
                }
            });

            // Unref so Node doesn't wait for this process
            intifaceProcess.unref();

            // Give it a moment to start
            await new Promise(resolve => setTimeout(resolve, 500));

            // Check if it started
            if (intifaceProcess.pid && !intifaceProcess.killed) {
                console.log(`[Intiface Launcher] Started with PID ${intifaceProcess.pid}`);
                return res.json({ 
                    success: true, 
                    message: 'Intiface Central started',
                    pid: intifaceProcess.pid 
                });
            } else {
                return res.status(500).json({ 
                    success: false, 
                    error: 'Process failed to start' 
                });
            }

        } catch (error) {
            console.error('[Intiface Launcher] Error:', error);
            return res.status(500).json({ 
                success: false, 
                error: error.message 
            });
        }
    });

    console.log('[Intiface Launcher Plugin] Initialized - endpoint: POST /api/plugins/intiface-launcher/start');
}

module.exports = { info, init };
