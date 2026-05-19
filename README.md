# Spotify A-B Loop

A lightweight patcher for the **Spotify Windows desktop client** that adds an **A-B loop** feature — set a start and end point on any track and Spotify will loop that section indefinitely.

Works by injecting a JavaScript file directly into Spotify's bundled web app (`xpui.spa`), the same technique used by [SpotX](https://github.com/SpotX-Official/SpotX) and [BlockTheSpot](https://github.com/mrpond/BlockTheSpot). No third-party frameworks required.

> **Tested on:** Spotify `1.2.83.461` · Windows 11 x64

---

## Preview

The A-B loop controls appear inline in the player bar, right after the repeat button:

```
[shuffle] [prev] [play] [next] [repeat]  A  B  ✕  loop  1:04 – 2:31
```

- **A / B** buttons turn green when a point is set
- **loop** turns green with a tinted background when active
- Timestamp label shows your current loop range
- All styling matches Spotify's native design tokens (SpotifyMixUI font, `#1ed760` green, Spotify easing curves)

---

## Requirements

- Spotify for Windows (downloaded from [spotify.com](https://spotify.com/download), **not** the Microsoft Store version)
- Windows 10 or 11
- PowerShell 5.1 or later (built into Windows)

---

## Installation

### 1. Download

Download these two files and place them in the **same folder**:

- `install.ps1`
- `ab-loop.js`

### 2. Unblock the script

Windows marks downloaded PowerShell scripts as untrusted. Open PowerShell in your download folder and run:

```powershell
Unblock-File .\install.ps1
```

### 3. Allow local scripts to run (one-time)

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

Press `Y` to confirm.

### 4. Run the installer

```powershell
.\install.ps1
```

The installer will:
1. Stop Spotify if it's running
2. Back up `xpui.spa` → `xpui.spa.bak`
3. Inject `ab-loop.js` into the Spotify app bundle
4. Patch `index.html` to load it

### 5. Launch Spotify

Start Spotify normally. The **A B ✕ loop** controls will appear in the player bar within a few seconds of the player loading.

---

## Usage

| Button | Action |
|--------|--------|
| **A** | Mark the current playback position as the **loop start** |
| **B** | Mark the current playback position as the **loop end** |
| **✕** | Clear both points and stop looping |
| **loop** | Toggle the A-B loop on/off |

**Workflow:**
1. Play a track and let it reach your desired start point
2. Click **A** — it turns green
3. Let the track play to your desired end point
4. Click **B** — it turns green
5. Click **loop** — it turns green and the loop activates
6. Spotify will now jump back to A every time it reaches B

> **Tip:** You can click A or B again at any time to update the points while the loop is active. Clicking ✕ clears everything and stops the loop.

---

## Uninstallation

Run the uninstaller to restore Spotify to its original state:

```powershell
.\uninstall.ps1
```

This restores `xpui.spa` from the backup created during installation.

**Manual uninstall:** Navigate to `%AppData%\Spotify\Apps\` and rename `xpui.spa.bak` back to `xpui.spa`.

---

## After a Spotify Update

Spotify updates overwrite `xpui.spa`, removing the patch. To re-apply:

1. Close Spotify
2. Re-run `install.ps1`

The installer detects an existing backup and skips re-creating it. If Spotify updated, delete the old `xpui.spa.bak` first so a fresh backup is made.

---

## Enabling DevTools (optional)

If you want to inspect the injected script or debug issues, you can enable Spotify's built-in DevTools (`Ctrl+Shift+I`).

Close Spotify, then run these commands in PowerShell:

```powershell
Get-Process -Name Spotify -ErrorAction SilentlyContinue | Stop-Process -Force

$f = "$env:LOCALAPPDATA\Spotify\offline.bnk"
$enc = [System.Text.Encoding]::GetEncoding(1251)
$c = [System.IO.File]::ReadAllText($f, $enc)
$c = $c.Replace('<app-developer>0</app-developer>', '<app-developer>2</app-developer>')
$c = $c -replace '(app-developer..)(2|1|0)', '${1}2'
[System.IO.File]::WriteAllText($f, $c, $enc)
```

Launch Spotify and press `Ctrl+Shift+I`.

> **Note:** Spotify resets this setting periodically. Re-run the commands whenever you need DevTools again.

---

## How It Works

Spotify's desktop client is an [Electron](https://www.electronjs.org/) app that bundles its entire frontend (React + webpack) into a ZIP archive at:

```
%AppData%\Spotify\Apps\xpui.spa
```

The installer:
1. Opens `xpui.spa` as a ZIP file using .NET's `System.IO.Compression`
2. Adds `ab-loop.js` as a new entry inside the ZIP
3. Patches `index.html` (also inside the ZIP) to load it via a `<script>` tag

At runtime, `ab-loop.js`:
- Waits for Spotify's React player to mount via `MutationObserver`
- Injects the A/B loop UI into the controls row using `position: grid` to preserve centering
- Reads playback position from the progress bar's React fiber props (`props.value` in ms)
- Seeks by calling `props.onDragEnd(fraction, { wasDraggedBeforeReleased: false })` — the same internal handler Spotify uses when you drag the scrubber
- Polls every 150ms and seeks to A when position reaches B - 300ms

---

## Compatibility

| Spotify Version | Status |
|----------------|--------|
| 1.2.83.x | ✅ Tested and working |
| 1.2.6x – 1.2.8x | ✅ Should work |
| Microsoft Store version | ❌ Not supported |

> Versions below 1.2.62 have a different `xpui.spa` structure and may need minor adjustments.

---

## Troubleshooting

**Buttons don't appear after launching Spotify**
- Wait 5–10 seconds for the player to fully load
- Try playing a track first, then check if the buttons appear
- Re-run `install.ps1` to ensure the patch is applied

**A/B buttons don't respond**
- Make sure a track is actively playing (not paused before starting)
- Open DevTools (`Ctrl+Shift+I` after enabling) and check the Console for `[AB Loop]` errors

**Loop triggers slightly early**
- This is by design — the loop fires 300ms before point B to compensate for polling lag
- If the timing feels off, this value can be adjusted in `ab-loop.js` (search for `300`)

**Spotify updated and the patch is gone**
- Re-run `install.ps1`

**`xpui.spa` not found**
- Make sure you installed Spotify from [spotify.com](https://spotify.com/download), not the Microsoft Store

---

## Contributing

Issues and PRs welcome. If Spotify updates and breaks something, the most useful thing to share is:
- Your Spotify version (`Help → About Spotify`)
- The output of the debug snippet from the DevTools console

---

## Disclaimer

This project is not affiliated with or endorsed by Spotify. Modifying the Spotify client may violate Spotify's [Terms of Service](https://www.spotify.com/legal/end-user-agreement/). Use at your own risk.

This patcher does not bypass any DRM, remove ads, unlock premium features, or make any network requests. It only adds a local UI feature on top of the existing client.