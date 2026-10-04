# NEXUS

**A to-do app that sorts your tasks by priority, with all your calendars in one place.**
On the web, on your Mac, on Windows and on Android. Free, and your data stays in your own Google Drive.

<p align="center">
  <img src="https://github.com/user-attachments/assets/27d8d266-e9fe-4d86-bfca-61ac682b4e07" width="220" alt="Nexus priority matrix">
</p>

---

## Get Nexus

| Where | How |
| --- | --- |
| **Web** (any device) | Open **[rsng-phoenix.github.io/Nexus](https://rsng-phoenix.github.io/Nexus/)**. Works in the browser, or install it like an app on iPhone, iPad, Android, Mac and Windows. |
| **Mac app** | Paste one line into **Terminal** (see below). |
| **Windows app** | Paste one line into **PowerShell** (see below). |
| **Android app** | [Download Nexus.apk](https://github.com/Rsng-Phoenix/Nexus/releases/latest/download/Nexus.apk) (latest release) |

### Mac: install in one line

Open **Terminal** (press `⌘ Space`, type *Terminal*, press Enter), paste this and press Enter:

```bash
curl -fsSL https://rsng-phoenix.github.io/Nexus/desktop/install-mac.sh | bash
```

That's it. **Nexus Desk** appears in your menu bar and in `~/Applications`, and starts when you log in.
No admin password, no App Store, nothing else to download. Run the same line again to update.

Remove it: `curl -fsSL https://rsng-phoenix.github.io/Nexus/desktop/install-mac.sh | bash -s -- --uninstall`

### Windows: install in one line

Open **PowerShell**, paste this and press Enter:

```powershell
irm https://rsng-phoenix.github.io/Nexus/desktop/install-windows.ps1 | iex
```

---

## What it does

**Priority matrix.** Every task sits in one of four boxes: High, Medium, Low or No priority. Drag tasks between them, pin the important ones, swipe to finish. You always see what matters first.

**All your calendars together.** Google, Zoho, iCloud, Outlook or any iCal link, next to your own deadlines. One-tap **Join** for Meet, Zoom and Teams, and **Clash radar** warns you when two meetings overlap.

**Reminders that actually reach you.** Deadlines, exact-time reminders, all-day repeats and date-range reminders, with **Done / Snooze / Open** right on the notification.

**Rich notes.** Checklists, bullet and numbered lists that start as you type, and pictures in any task.

**Linked Google Sheets.** Link a sheet and its rows become tasks that keep updating as the sheet changes. Excel, CSV and calendar files import too.

**Quick add from anywhere.** Type *"call CA tomorrow 5pm !1"* and Nexus sets the date, reminder and priority for you. `⌘K` / `Ctrl K` opens a command palette, and the whole matrix works from the keyboard (`?` lists every shortcut).

**Private by design.** Tasks sync through a private folder in **your own Google Drive**. Nothing is stored on a Nexus server. Works offline and syncs when you're back.

---

## The Mac app (Nexus Desk)

A real Mac app, not a browser tab:

- **Menu bar icon** and a full Nexus window, with the same sign-in and data as the web app
- **Quick Add panel** from any app with `⌃ ⌥ N` (change it to any shortcut you like)
- **Hot corner:** move the mouse to a screen corner to show or hide Nexus
- Float on top, sit on the desktop, or act as a normal window
- **Real macOS notifications** with Done, Snooze and Open
- Select text in any app → right-click → **Services → Add to Nexus**
- `nexus://add?text=…` links for Shortcuts, Raycast and Alfred
- Starts at login

Windows gets the same Desk window, hot corner and `Ctrl Alt N` quick add.

## The Android app

- Home-screen widgets: Matrix, Today, Quick add, Next up and a single quadrant
- Reminders that survive a restart, with actions on the notification
- Share any task as text, an image card or a PDF

## Moving between devices

Sign in with Google on each device and your tasks follow you. **Scan to set up** copies your linked calendars, sheets and settings to a new device with a QR code.

---

## Screenshots

<p align="center">
  <img src="https://github.com/user-attachments/assets/8c26c6b6-d90b-4b00-a0a1-797954d1d756" width="200" alt="Create a task" hspace="6">
  <img src="https://github.com/user-attachments/assets/bb5f6707-e568-429a-84b0-f41bb92daa88" width="200" alt="Tasks in priority quadrants" hspace="6">
  <img src="https://github.com/user-attachments/assets/16382977-c0d9-4f0a-9175-e950f8155850" width="200" alt="Task editor" hspace="6">
</p>
<p align="center">
  <img src="https://github.com/user-attachments/assets/698f47a8-fb7f-4354-8a17-2ce67d72398b" width="200" alt="Rich notes" hspace="6">
  <img src="https://github.com/user-attachments/assets/6f99f2ca-84a6-4812-a9fc-ce1bb8cc0046" width="200" alt="Dragging a task" hspace="6">
  <img src="https://github.com/user-attachments/assets/931d4c71-1551-4214-a769-c650dd897b57" width="200" alt="Task moved to a new priority" hspace="6">
</p>
<p align="center"><em>Create, organise, write notes and drag tasks between priorities.</em></p>

---

<details>
<summary><b>Built with</b></summary>

- **Android:** Kotlin, Jetpack Compose, Material 3, Room, WorkManager, Glance widgets
- **Web:** Preact + Signals, TypeScript, Vite, installable PWA (offline), IndexedDB, Google Drive sync
- **Mac / Windows Desk:** native macOS app (JavaScript for Automation + WebKit), PowerShell on Windows
- **Notifications relay:** Cloudflare Worker + D1 (web push, linked calendars)

</details>

## License

GNU GPL v3. You're free to use, study, change and share Nexus, as long as you credit the author,
keep changes open source and keep the same license.

**Author:** Priyanshu Pradhan
