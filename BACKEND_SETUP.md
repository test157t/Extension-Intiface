# Backend Setup for Intiface Central Auto-Start

This extension can automatically start Intiface Central via a SillyTavern server plugin.

## Setup Instructions

### Step 1: Enable Server Plugins

Edit your `config.yaml` file in the SillyTavern root directory and add:

```yaml
enableServerPlugins: true
```

If the file doesn't exist, create it with this content.

### Step 2: Install the Plugin

Copy the file `plugins/intiface-launcher.js` from this extension to SillyTavern's plugins folder:

```
SillyTavern/
├── plugins/
│   └── intiface-launcher.js    <-- Copy this file here
├── src/
├── public/
└── ...
```

**Source location:** `public/scripts/extensions/third-party/Intiface_Central-Sillytavern-plugin/plugins/intiface-launcher.js`

**Destination:** `plugins/intiface-launcher.js` (in your SillyTavern root)

### Step 3: Restart SillyTavern

Restart SillyTavern completely. You should see this message in the console:

```
Initializing plugin from D:\Github\SillyTavern\plugins\intiface-launcher.js
[Intiface Launcher Plugin] Initialized - endpoint: POST /api/plugins/intiface-launcher/start
```

### Step 4: Configure the Extension

1. Open SillyTavern in your browser
2. Open the Intiface extension panel
3. Scroll down to "Intiface Central Configuration"
4. Click "Browse..." and select your `IntifaceCentral.exe`
   - Default Windows location: `C:\Program Files\Intiface\IntifaceCentral.exe`
5. The path will be saved automatically

## Usage

Now the AI can use the function:

**Function:** `start_intiface_central`

**When to use:** When Intiface is not running and needs to be launched

**What happens:**
1. The extension will call the backend to spawn Intiface Central
2. Wait 3 seconds for it to initialize
3. Attempt to connect automatically

## How It Works

The system uses SillyTavern's official plugin system:

1. **Plugin File** (`intiface-launcher.js`) - Runs in the Node.js backend
2. **Endpoint** - Creates `/api/plugins/intiface-launcher/start`
3. **Security** - Only spawns the executable at the configured path
4. **Process** - Runs independently (closing SillyTavern won't close Intiface)

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