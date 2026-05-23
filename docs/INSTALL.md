# Installing X Follow Grow

X Follow Grow is currently distributed as an unpacked Chrome extension. Installation takes about 60 seconds.

## Prerequisites

- Google Chrome (110+) or any Chromium-based browser (Brave, Edge, Arc, Vivaldi, Opera).
- The unzipped `x-follow-suite/` folder somewhere stable on your computer (don't put it in Downloads — moving or deleting it later breaks the extension).

## Step-by-step

### 1. Get the files

Download the latest ZIP from your distribution channel and unzip it.

**Important:** put the resulting `x-follow-suite/` folder somewhere permanent — for example:

- macOS / Linux: `~/Library/ChromeExtensions/x-follow-suite/` or `~/extensions/x-follow-suite/`
- Windows: `C:\Users\<you>\ChromeExtensions\x-follow-suite\`

### 2. Open Chrome's extensions page

In a new Chrome tab, go to:

```
chrome://extensions
```

### 3. Enable Developer mode

In the top-right corner of the extensions page, flip the **Developer mode** toggle on. New buttons will appear in the top-left.

### 4. Load the extension

Click **Load unpacked**.

In the file picker, navigate to and select the `x-follow-suite/` folder (the one containing `manifest.json`).

The extension should appear in the list as **X Follow Grow** with a green "Inspect views" link.

### 5. Pin it to the toolbar

Click the puzzle-piece icon in Chrome's toolbar, find X Follow Grow, and click the pin icon. The extension's icon will now sit beside your address bar.

### 6. Open x.com

Make sure you're logged into x.com. Open any page (home, profile, followers list, search). Click the X Follow Grow icon — the popup opens.

That's it. Read the **README** for usage notes.

---

## Updating to a new version

1. Replace the contents of your `x-follow-suite/` folder with the new files (keep the folder in the same location).
2. Go to `chrome://extensions`.
3. Click the circular reload icon on the X Follow Grow card.

Your settings, queue, and analytics all persist.

---

## Uninstalling

Two ways:

- **Soft remove:** Toggle the extension off on `chrome://extensions`. Settings & data are preserved.
- **Full uninstall:** Click **Remove** on the X Follow Grow card. Everything is deleted from this profile.

---

## Troubleshooting

### The popup is blank or shows "Background not ready"

The service worker hasn't finished initializing. Open `chrome://extensions`, click the reload icon on X Follow Grow, then reopen the popup.

### "Open x.com first" warning in the Discover tab

The list-walker mode needs an active x.com tab. Click an x.com tab so it becomes the active tab, then reopen the popup.

### Follow button is grayed out / "No handles loaded"

Switch to the Queue tab and either paste handles + click **Load handles**, or use **Extract from current tab** while on an x.com followers/following/search page.

### Automation pauses with "Safety halt"

Either you hit your hourly/daily cap, or the extension detected a captcha / lockout / rate-limit page on x.com. Reload x.com in a normal tab, dismiss any captcha or notification, then click **Resume** in the popup.

### Settings don't seem to persist between devices

Settings sync uses `chrome.storage.sync`, which depends on Chrome's account sync. Make sure you're signed into the same Google account on each device and that sync is enabled (`chrome://settings/syncSetup`).

### I lost my queue after a browser restart

Queue data is in `chrome.storage.local`, which **does** survive restarts. If it's gone, you may have clicked **Reset all** or uninstalled and reinstalled. Use **Settings → Export settings** periodically to back up.

---

## Permissions explained

The extension declares these permissions in `manifest.json`:

| Permission | Why it's needed |
| --- | --- |
| `activeTab` | To act on the current tab when you click "Extract from current tab" |
| `scripting` | To inject the human-like read/follow scripts during profile-queue mode |
| `storage` | To save settings, queue, results, logs, and analytics |
| `tabs` | To open profile pages during profile-queue mode |
| `alarms` | To schedule the next action across long delays without keeping the SW awake |
| `downloads` | To save the exported settings JSON file |
| `notifications` | To show "Run complete" / "Safety halt" desktop notifications |

Host permissions are limited to `x.com`, `twitter.com`, and `mobile.twitter.com`. The extension never accesses any other site.
