# Privacy Policy — X Follow Grow

**Last updated: May 24, 2026**

X Follow Grow ("the Extension," "we," "us") is a Chrome extension that helps you follow accounts on X (formerly Twitter) using two modes — a pasted queue of handles and a live-page walker — with human-like pacing and a built-in safety pulse.

This policy explains what the Extension does and does not do with your information. The short version: **everything stays on your own device. We do not collect, transmit, sell, or share any of your data.**

---

## 1. Our core privacy commitment

- **Local-only data.** All data the Extension uses is stored locally in your browser. Nothing is sent to us or to any third-party server we control.
- **No telemetry.** We do not run analytics, tracking pixels, fingerprinting, crash reporting, or any usage-monitoring of any kind.
- **No accounts.** There is no sign-up, no login to our service, and no API keys. You never create an account with us.
- **No selling or sharing.** We have no servers that receive your data, so there is nothing for us to sell, rent, or share with advertisers or data brokers.
- **Follow only.** The Extension performs follow actions only. It does not unfollow, post, message, or read your direct messages.

---

## 2. What the Extension stores (and where)

All of the following is kept on your device using Chrome's `storage` API (`chrome.storage.local` and `chrome.storage.sync`). You can clear it at any time (see Section 7).

| Data | Purpose | Where it lives |
|------|---------|----------------|
| Handle / profile lists you paste or extract | To build and run your follow queue | Local browser storage |
| Your settings (delays, caps, filters, pause cycles, smart-targeting options) | To remember how you want the Extension to behave | Browser storage (may sync across your own Chrome profile if Chrome Sync is enabled) |
| Session activity (counts followed, skipped, failed; timestamps; progress) | To show your dashboard, safety pulse, and 14-day trend | Local browser storage |
| Mode and UI preferences | To restore your last view | Local browser storage |

If you have **Chrome Sync** turned on in your browser, settings saved via `chrome.storage.sync` may be synchronized across your own signed-in Chrome instances by Google. That synchronization is handled entirely by Google under [Google's Privacy Policy](https://policies.google.com/privacy) — it does not pass through us.

---

## 3. What the Extension does *not* collect

- We do **not** collect your name, email, phone number, or X/Twitter password.
- We do **not** collect, log, or transmit your browsing history.
- We do **not** read or store the content of your timeline, direct messages, or private account data.
- We do **not** use cookies for tracking.
- We do **not** build advertising profiles or share data with advertisers.

---

## 4. Permissions and why they're needed

The Extension requests only the permissions required for its features to function. Each is used **on your device** to operate the follow engine — never to exfiltrate data.

- **Access to x.com / twitter.com pages** — to read profile rows and click the Follow button on your behalf in the modes you choose.
- **Scripting / active tab** — to run the follow logic on the X page you're using.
- **Storage** — to save your lists, settings, and session history locally (see Section 2).
- **Tabs / background operation** — to keep a queue running and to walk a page, including in background tabs.
- **Alarms** — to schedule paced actions and "coffee break" pauses.

The Extension does not request permissions to access other websites for the purpose of collecting data.

---

## 5. Network activity

The Extension's follow actions interact directly with X (x.com / twitter.com) through your own logged-in browser session, exactly as if you clicked Follow yourself. Those interactions are governed by [X's Privacy Policy](https://x.com/en/privacy) and terms.

We operate **no backend server** for this Extension. The Extension does not phone home, check in, or transmit your data to us.

---

## 6. Third parties

- **X (Twitter):** Your follow actions occur on X's platform under your account. Your use of X is subject to X's own policies.
- **Google / Chrome Web Store:** Distribution and optional settings sync are handled by Google under Google's policies.
- **No one else:** We do not integrate third-party analytics, advertising, or data-broker SDKs.

---

## 7. Your control and choices

- **View or clear data:** You can clear your stored lists and history from within the Extension, or remove all stored data by uninstalling the Extension.
- **Disable settings sync:** Turn off Chrome Sync in your browser settings if you do not want settings synchronized across your own devices.
- **Uninstall:** Removing the Extension from `chrome://extensions` deletes its locally stored data from that browser profile.
- **Stop at any time:** Pause, resume, or stop the Extension's activity whenever you like.

---

## 8. Data retention

Because all data is local, retention is entirely under your control. Data persists in your browser until you clear it or uninstall the Extension. We hold no copies because we never receive your data.

---

## 9. Children's privacy

The Extension is not directed to children under 13 (or the minimum age of digital consent in your jurisdiction) and is intended for use only by people who meet the minimum age required to hold an X account.

---

## 10. Security

Your data never leaves your device through the Extension, which removes an entire class of transmission and server-breach risks. Locally stored data is protected by your operating system and browser's standard security model. You are responsible for the security of the device and browser profile where the Extension is installed.

---

## 11. Account and platform risk disclaimer

X Follow Grow automates actions on the X platform. Automated activity may carry account risk and could conflict with X's terms of service. This Extension is independent and is **not affiliated with, endorsed by, or sponsored by X Corp.** You use the Extension at your own discretion and risk.

---

## 12. Changes to this policy

We may update this Privacy Policy to reflect changes to the Extension or legal requirements. When we do, we will revise the "Last updated" date at the top. Material changes will be reflected in the Chrome Web Store listing. Continued use of the Extension after an update constitutes acceptance of the revised policy.

---

## 13. Contact

If you have questions about this Privacy Policy or the Extension, contact the developer:

- **Developer:** Shahriar Ahmed
- **Telegram:** [@igfrostt](https://t.me/igfrostt)

---

*X Follow Grow stores your data locally, runs no telemetry, and operates no server. Your information stays with you.*
