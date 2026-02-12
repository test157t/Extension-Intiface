# Backend Setup for Intiface Extension

This extension provides a backend plugin that enables:
1. **Auto-start Intiface Central** - Launch Intiface from the browser
2. **Media Library** - Browse and play videos with synchronized haptic feedback
3. **Funscript Support** - Load and execute Funscript files for synchronized device control

## Setup Instructions

### Step 1: Enable Server Plugins

Edit your `config.yaml` file in the SillyTavern root directory and add:

```yaml
enableServerPlugins: true
```

If the file doesn't exist, create it with this content.

### Step 2: Install the Plugin

Copy the file `intiface-launcher.js` from this extension to SillyTavern's plugins folder:

```
SillyTavern/
├── plugins/
│   └── intiface-launcher.js <-- Copy this file here
├── src/
├── public/
└── ...
```

**Source location:** `public/scripts/extensions/third-party/Extension-Intiface/intiface-launcher.js`

**Destination:** `plugins/intiface-launcher.js` (in your SillyTavern root)

### Step 3: Restart SillyTavern

Restart SillyTavern completely. You should see messages like these in the console:

```
Initializing plugin from D:\Github\SillyTavern\plugins\intiface-launcher.js
[Intiface Launcher Plugin] Initialized
[Intiface Launcher] Serving static files from:
  /assets/intiface_media -> D:\Github\SillyTavern\data\default-user\assets\intiface_media
  /assets/funscript -> D:\Github\SillyTavern\data\default-user\assets\funscript
```

### Step 4: Configure the Extension

1. Open SillyTavern in your browser
2. Open the Intiface extension panel (heart pulse icon)
3. Click "Advanced Configuration" to expand
4. Enter the path to your `IntifaceCentral.exe`
   - Default Windows location: `C:\Program Files\Intiface\IntifaceCentral.exe`
5. Click "Test Backend Connection" to verify everything is working

## Features

### 1. Intiface Central Auto-Start

The AI can now use the function `start_intiface_central` to launch Intiface Central automatically.

**What happens:**
1. The extension calls the backend to spawn Intiface Central
2. Waits 3 seconds for initialization
3. Attempts to connect automatically

### 2. Media Player with Funscript Support

Play videos with synchronized haptic feedback!

**Supported formats:** MP4, WebM, OGV, MKV, AVI, MOV

**How to use:**

1. **Prepare your files:**
   - Place video files in: `SillyTavern/data/default-user/assets/intiface_media/`
   - Place matching Funscript files in the same directory (same filename, `.funscript` extension)
   - Example: `video.mp4` + `video.funscript`

2. **Access the Media Player:**
   - Open the Intiface extension panel
   - Click "Media Player & Funscripts" to expand
   - Click "Refresh Media List" to see your files

3. **Play with Synchronization:**
   - Click on a video file to load it
   - If a matching Funscript exists, it will load automatically
   - Use the video player controls to play/pause
   - The device will synchronize with the Funscript actions in real-time

**Playback Controls:**
- **Sync Offset:** Adjust timing if video and haptics are out of sync (±5000ms)
- **Intensity:** Scale all Funscript actions (0-100%)
- **Loop:** Automatically restart video when finished

**Funscript Visualizer:**
- Shows a preview of the Funscript waveform
- Green line shows intensity over time
- Dots show individual actions

### 3. Funscript Format

Funscripts are JSON files that contain timed actions for haptic devices.

**Example Funscript structure:**
```json
{
  "version": "1.0",
  "inverted": false,
  "range": 90,
  "actions": [
    {"pos": 0, "at": 0},
    {"pos": 50, "at": 500},
    {"pos": 100, "at": 1000},
    {"pos": 0, "at": 1500}
  ]
}
```

- `pos`: Position/intensity (0-100)
- `at`: Time in milliseconds
- `inverted`: Whether to invert positions
- `range`: Maximum position range

**How it works:**
- For **strokers/linear devices**: Position maps directly to stroke position
- For **vibrators**: Position maps to vibration intensity
- Actions are interpolated between keyframes for smooth motion

## How It Works

The system uses SillyTavern's official plugin system:

1. **Plugin File** (`intiface-launcher.js`) - Runs in the Node.js backend
2. **API Endpoints:**
   - `POST /api/plugins/intiface-launcher/start` - Launch Intiface Central
   - `GET /api/plugins/intiface-launcher/media` - Browse media files
   - `GET /api/plugins/intiface-launcher/funscript` - Load Funscript data
   - `GET /api/plugins/intiface-launcher/asset-paths` - Get asset directory paths
3. **Static File Serving** - Serves media files from asset directories
4. **Security** - Only allows access to configured asset directories
5. **Process Management** - Intiface runs independently (won't close with SillyTavern)

## Troubleshooting

### "Backend not available" error

1. Check that `enableServerPlugins: true` is in `config.yaml`
2. Verify the plugin file is in the correct location: `plugins/intiface-launcher.js`
3. Look for plugin initialization messages in the SillyTavern console
4. Restart SillyTavern completely

### Plugin not loading

Check the console for error messages like:
- "Failed to load plugin module; plugin info not found" - File is corrupted
- "Failed to load plugin module; invalid plugin ID" - ID format is wrong
- "Failed to load plugin module; no init function" - File structure is wrong

### Process fails to start

1. Verify the path is correct in the extension settings
2. Make sure `IntifaceCentral.exe` exists at that location
3. Check Windows Defender/antivirus isn't blocking the spawn
4. Try running Intiface Central manually to ensure it works

### Security Warning

The backend will only spawn executables at the path you configure. Make sure to:
- Only set trusted executable paths
- Don't share your configuration with untrusted parties
- The spawned process runs with the same permissions as SillyTavern

## Manual Alternative

If you can't get the plugin working, the AI will automatically provide manual instructions when trying to use `start_intiface_central`. You can also:

1. Start Intiface Central manually
2. Enable "Auto-connect on load" in the extension settings
3. The extension will connect automatically when SillyTavern loads