// SillyTavern Server Plugin for Intiface Central Launcher
// Place this file in: SillyTavern/plugins/intiface-launcher.js

const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const express = require('express');

const info = {
  id: 'intiface-launcher',
  name: 'Intiface Central Launcher',
  description: 'Allows starting Intiface Central from the browser extension and browsing media assets'
};

// Get user's home directory for constructing default paths
function getUserHome() {
  return process.env.HOME || process.env.USERPROFILE;
}

// Asset directories for media serving
let assetPaths = {
    intifaceMedia: null,
    funscript: null
};

// WebSocket Proxy process tracking
let proxyProcess = null;
const PROXY_PORT = 12346;
const INFACE_PORT = 12345;

// Start the internal WebSocket proxy
async function startProxy() {
    if (proxyProcess) {
        console.log('[Intiface Launcher] Proxy already running');
        return { success: true, port: PROXY_PORT, pid: proxyProcess.pid };
    }

    const proxyScriptPath = path.join(__dirname, 'intiface-proxy.js');
    
    if (!fs.existsSync(proxyScriptPath)) {
        throw new Error('Proxy script not found: ' + proxyScriptPath);
    }

    return new Promise((resolve, reject) => {
        try {
            console.log(`[Intiface Launcher] Starting proxy: ${proxyScriptPath}`);
            
            proxyProcess = spawn('node', [proxyScriptPath], {
                detached: false,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let stdout = '';
            let stderr = '';

            proxyProcess.stdout.on('data', (data) => {
                stdout += data.toString();
                console.log(`[Intiface Proxy] ${data.toString().trim()}`);
            });

            proxyProcess.stderr.on('data', (data) => {
                stderr += data.toString();
                console.error(`[Intiface Proxy Error] ${data.toString().trim()}`);
            });

            proxyProcess.on('error', (err) => {
                console.error('[Intiface Launcher] Proxy process error:', err);
                proxyProcess = null;
                reject(err);
            });

            proxyProcess.on('exit', (code) => {
                if (code !== 0) {
                    console.error(`[Intiface Launcher] Proxy exited with code ${code}`);
                }
                proxyProcess = null;
            });

            // Wait a moment for the proxy to start
            setTimeout(() => {
                if (proxyProcess && proxyProcess.pid) {
                    console.log(`[Intiface Launcher] Proxy started with PID ${proxyProcess.pid}`);
                    resolve({ success: true, port: PROXY_PORT, pid: proxyProcess.pid });
                } else {
                    reject(new Error('Proxy failed to start'));
                }
            }, 1000);

        } catch (err) {
            reject(err);
        }
    });
}

// Stop the internal WebSocket proxy
async function stopProxy() {
    if (!proxyProcess) {
        console.log('[Intiface Launcher] Proxy not running');
        return { success: true, message: 'Proxy not running' };
    }

    return new Promise((resolve) => {
        console.log(`[Intiface Launcher] Stopping proxy (PID ${proxyProcess.pid})`);
        
        // Try graceful kill first
        proxyProcess.kill('SIGTERM');
        
        // Force kill after 2 seconds if still running
        setTimeout(() => {
            if (proxyProcess) {
                try {
                    proxyProcess.kill('SIGKILL');
                } catch (e) {
                    // Process might already be dead
                }
                proxyProcess = null;
            }
            resolve({ success: true, message: 'Proxy stopped' });
        }, 2000);
    });
}

async function init(router) {
    console.log('[Intiface Launcher Plugin] Initializing...');

  // Setup asset paths
  const basePath = process.cwd();
  assetPaths.intifaceMedia = path.join(basePath, 'data', 'default-user', 'assets', 'intiface_media');
  assetPaths.funscript = path.join(basePath, 'data', 'default-user', 'assets', 'funscript');
  
  // Create asset directories if they don't exist
  [assetPaths.intifaceMedia, assetPaths.funscript].forEach(dir => {
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`[Intiface Launcher] Created directory: ${dir}`);
      } catch (e) {
        console.error(`[Intiface Launcher] Failed to create directory: ${dir}`, e);
      }
    }
  });

  // Middleware to log all requests
  router.use((req, res, next) => {
    console.log(`[Intiface Launcher] ${req.method} ${req.path}`);
    next();
  });
  
// Serve static files from asset directories
// This allows the browser to access videos directly
console.log(`[Intiface Launcher] Setting up static file serving:`);
console.log(` /assets/intiface_media -> ${assetPaths.intifaceMedia}`);
console.log(` /assets/funscript -> ${assetPaths.funscript}`);
console.log(`[Intiface Launcher] Checking if funscript directory exists:`, fs.existsSync(assetPaths.funscript));
if (fs.existsSync(assetPaths.funscript)) {
const files = fs.readdirSync(assetPaths.funscript);
console.log(`[Intiface Launcher] Files in funscript dir:`, files.slice(0, 10));
}

// Custom middleware for funscript files to add logging
router.use('/assets/funscript', (req, res, next) => {
console.log(`[Intiface Launcher] Funscript request: ${req.url}`);
const fullPath = path.join(assetPaths.funscript, decodeURIComponent(req.url));
console.log(`[Intiface Launcher] Looking for file: ${fullPath}`);
console.log(`[Intiface Launcher] File exists:`, fs.existsSync(fullPath));
next();
}, express.static(assetPaths.funscript));

router.use('/assets/intiface_media', express.static(assetPaths.intifaceMedia));

// Test endpoint - just returns success
    router.get('/test', (req, res) => {
        console.log('[Intiface Launcher] Test endpoint called');
        res.json({ success: true, message: 'Plugin is working' });
    });

    // Endpoint to start WebSocket proxy
    router.post('/proxy/start', async (req, res) => {
        try {
            const result = await startProxy();
            res.json(result);
        } catch (error) {
            console.error('[Intiface Launcher] Proxy start error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Endpoint to stop WebSocket proxy
    router.post('/proxy/stop', async (req, res) => {
        try {
            const result = await stopProxy();
            res.json(result);
        } catch (error) {
            console.error('[Intiface Launcher] Proxy stop error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Endpoint to get proxy status
    router.get('/proxy/status', (req, res) => {
        res.json({
            success: true,
            running: proxyProcess !== null,
            port: PROXY_PORT
        });
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

  // Endpoint to list media files in asset directories
  router.get('/media', async (req, res) => {
    try {
      const { dir } = req.query;
      
      // Validate directory path
      if (!dir) {
        return res.status(400).json({
          success: false,
          error: 'No directory specified'
        });
      }

      // Security: Ensure the path is within allowed directories
      const allowedPaths = [
        path.join(process.cwd(), 'data', 'default-user', 'assets', 'funscript'),
        path.join(process.cwd(), 'data', 'default-user', 'assets', 'intiface_media'),
        path.join(process.cwd(), 'public', 'assets', 'funscript'),
        path.join(process.cwd(), 'public', 'assets', 'intiface_media')
      ];
      
      const requestedPath = path.resolve(dir);
      const isAllowed = allowedPaths.some(allowed => requestedPath.startsWith(allowed));
      
      if (!isAllowed) {
        return res.status(403).json({
          success: false,
          error: 'Access denied: Path not in allowed directories'
        });
      }

      // Check if directory exists
      if (!fs.existsSync(requestedPath)) {
        return res.json({
          success: true,
          files: [],
          directories: [],
          message: 'Directory does not exist yet'
        });
      }

      // Read directory contents
      const items = fs.readdirSync(requestedPath, { withFileTypes: true });
      
      const videoExtensions = ['.mp4', '.webm', '.ogv', '.mkv', '.avi', '.mov'];
      const funscriptExtensions = ['.funscript', '.json'];
      const audioExtensions = ['.mp3', '.wav', '.ogg', '.flac', '.m4a'];
      
      const files = items
        .filter(item => item.isFile())
        .map(item => {
          const ext = path.extname(item.name).toLowerCase();
          let type = 'unknown';
          if (videoExtensions.includes(ext)) type = 'video';
          else if (funscriptExtensions.includes(ext)) type = 'funscript';
          else if (audioExtensions.includes(ext)) type = 'audio';
          
          // Check for matching funscript in both media directory and dedicated funscript directory
          const baseName = path.basename(item.name, ext);
          const funscriptInMediaDir = fs.existsSync(path.join(requestedPath, `${baseName}.funscript`));
          const funscriptInFunscriptDir = fs.existsSync(path.join(assetPaths.funscript, `${baseName}.funscript`));
          const hasFunscript = funscriptInMediaDir || funscriptInFunscriptDir;
          
          return {
            name: item.name,
            type: type,
            size: fs.statSync(path.join(requestedPath, item.name)).size,
            hasFunscript: hasFunscript
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

      const directories = items
        .filter(item => item.isDirectory())
        .map(item => ({
          name: item.name,
          type: 'directory'
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      res.json({
        success: true,
        path: requestedPath,
        files: files,
        directories: directories
      });

    } catch (error) {
      console.error('[Intiface Launcher] Media listing error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

// Endpoint to read Funscript file
router.get('/funscript', async (req, res) => {
try {
const { path: filePath } = req.query;

if (!filePath) {
return res.status(400).json({
success: false,
error: 'No file path specified'
});
}

console.log('[Intiface Launcher] Funscript request:', filePath);

// Security: Ensure the path is within allowed directories
const allowedPaths = [
path.join(process.cwd(), 'data', 'default-user', 'assets'),
path.join(process.cwd(), 'public', 'assets')
];

const requestedPath = path.resolve(filePath);
console.log('[Intiface Launcher] Resolved path:', requestedPath);
console.log('[Intiface Launcher] Allowed paths:', allowedPaths);

const isAllowed = allowedPaths.some(allowed => requestedPath.startsWith(allowed));

if (!isAllowed) {
console.log('[Intiface Launcher] Path not allowed:', requestedPath);
}
      
      if (!isAllowed) {
        return res.status(403).json({
          success: false,
          error: 'Access denied: Path not in allowed directories'
        });
      }

      // Check file extension
      const ext = path.extname(requestedPath).toLowerCase();
      if (ext !== '.funscript' && ext !== '.json') {
        return res.status(400).json({
          success: false,
          error: 'Invalid file type. Must be .funscript or .json'
        });
      }

// Read and parse the file - check requested path first, then funscript directory
let fileToRead = requestedPath;
console.log('[Intiface Launcher] Checking if file exists:', requestedPath);
console.log('[Intiface Launcher] File exists:', fs.existsSync(requestedPath));

if (!fs.existsSync(requestedPath)) {
// Try the dedicated funscript directory
const baseName = path.basename(requestedPath, '.funscript');
const funscriptDirPath = path.join(assetPaths.funscript, `${baseName}.funscript`);
console.log('[Intiface Launcher] Trying funscript directory:', funscriptDirPath);
console.log('[Intiface Launcher] Funscript dir exists:', fs.existsSync(funscriptDirPath));

if (fs.existsSync(funscriptDirPath)) {
fileToRead = funscriptDirPath;
console.log('[Intiface Launcher] Found file in funscript directory');
} else {
console.log('[Intiface Launcher] File not found in either location');
return res.status(404).json({
success: false,
error: 'File not found'
});
}
}

console.log('[Intiface Launcher] Reading file:', fileToRead);

      const content = fs.readFileSync(fileToRead, 'utf8');
      const funscript = JSON.parse(content);

      // Validate funscript format
      if (!funscript.actions || !Array.isArray(funscript.actions)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid Funscript format: missing actions array'
        });
      }

      res.json({
        success: true,
        funscript: funscript
      });

    } catch (error) {
      console.error('[Intiface Launcher] Funscript reading error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // Endpoint to get default asset paths
  router.get('/asset-paths', (req, res) => {
    const basePath = process.cwd();
    res.json({
      success: true,
      paths: {
        funscript: path.join(basePath, 'data', 'default-user', 'assets', 'funscript'),
        intifaceMedia: path.join(basePath, 'data', 'default-user', 'assets', 'intiface_media')
      }
    });
  });

    console.log('[Intiface Launcher Plugin] Initialized');
    console.log('[Intiface Launcher] Endpoints:');
    console.log(' POST /api/plugins/intiface-launcher/start');
    console.log(' POST /api/plugins/intiface-launcher/proxy/start');
    console.log(' POST /api/plugins/intiface-launcher/proxy/stop');
    console.log(' GET  /api/plugins/intiface-launcher/proxy/status');
    console.log(' GET  /api/plugins/intiface-launcher/media');
    console.log(' GET  /api/plugins/intiface-launcher/funscript');
    console.log(' GET  /api/plugins/intiface-launcher/asset-paths');
}

module.exports = { info, init };
