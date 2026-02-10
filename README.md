# Extension-Intiface for SillyTavern

This is an extension for SillyTavern that allows you to connect and control Intiface-compatible devices (Lovense, Kiiroo, etc.) using the [Buttplug.io](https://buttplug.io/) protocol.

## Features

* **Connect to Intiface:** Easily connect to your toys via the Buttplug protocol through Intiface Central or a local server.
* **Manual Control:** Simple sliders and input fields in the UI allow you to manually control vibration intensity, oscillation, linear position, and movement duration.
* **Chat-Driven Control:** The extension listens for specific device commands in AI messages and executes them automatically.
* **Auto-connect:** Option to automatically connect when SillyTavern starts.

## Installation

1. Open SillyTavern.
2. Click the "Extensions" button in the top toolbar.
3. Click "Install Extension".
4. Copy this URL into the input field: https://github.com/test157t/Extension-Intiface
5. Click "Install just for me" or "Install for all users".

## How to Use

1. **Start Intiface Central:** Launch Intiface Central or start the server.
2. **Open SillyTavern:** Navigate to your SillyTavern instance.
3. **Configure:**
   * Click the electrocardiogram icon in the top-right to open the control panel.
   * Enter your Intiface server IP address (default: `ws://127.0.0.1:12345`).
   * Optionally enable "Auto-connect".
4. **Connect:** Click the **Connect** button. The status should change to "Connected".
5. **Scan for Devices:** Click **Scan** to find your Bluetooth devices.
6. **Control:** Use the UI or chat commands to control your devices.

## Chat Command Format

Commands are embedded in AI messages using XML-style tags:

```
<deviceType:COMMAND: parameters>
```

- **deviceType**: Match devices by name (`cage`, `plug`, `solace`, etc.) or use `any` for the first available device.
- **COMMAND**: VIBRATE, OSCILLATE, LINEAR, PATTERN, or STOP.
- **parameters**: Command-specific values.

### Command Examples

**Vibrate:**
```
<cage:VIBRATE: 50>      - Vibrate matching device at 50%
<any:VIBRATE: 80>        - Vibrate any device at 80%
```

**Oscillate:**
```
<plug:OSCILLATE: 75>    - Oscillate matching device at 75%
```

**Linear Movement:**
```
<solace:LINEAR: start=10, end=90, duration=1000>
```

**Pattern (Vibration):**
```
<toy:PATTERN: [20, 60, 100, 60], interval=[500, 1000], loop=3>
```

**Stop:**
```
<cage:STOP>
<intiface:CONNECT>
<intiface:DISCONNECT>
<intiface:START>
```

### Device Type Matching

The extension matches `deviceType` to your device's display name (case-insensitive):
- `cage` matches devices with "cage" in the name
- `plug` matches devices with "plug" in the name
- `solace` matches devices with "solace" in the name
- `any` or `device` matches the first available device

## Settings

- **IP Address**: WebSocket server address (default: `ws://127.0.0.1:12345`)
- **Auto-connect**: Automatically connect on startup
- **Intiface.exe Path**: Path to Intiface Central executable (for auto-start)
- **Chat Control**: Enable/disable chat-based device control
- **Function Calling**: Enable/disable AI function tools
