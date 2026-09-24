# NEXUS

A priority-driven productivity app built around the matrix, with every calendar you use in one place.

Unlike to-do apps that give you an endless list, Nexus sorts tasks into priority quadrants so you always see what matters first. It pulls in your Google, Zoho, iCloud and Outlook calendars next to your tasks, with meeting links one tap away.

**Use it now:** [rsng-phoenix.github.io/Nexus](https://rsng-phoenix.github.io/Nexus/) (web app, installable on iPhone, Android, Mac and Windows) · Android app from [Releases](https://github.com/Rsng-Phoenix/Nexus/releases)

---

## Highlights

- **Priority matrix:** High, Medium, Low and No priority quadrants, with drag and drop between them
- **One calendar for everything:** your deadlines and reminders, plus linked Google, Zoho, iCloud and Outlook calendars, each labelled with where it came from
- **Meeting heads-ups:** an optional alert before meetings, with a Join button for Google Meet, Zoom and Teams
- **Sync with your own Google Drive:** tasks go to a private Nexus folder in your Drive and are never stored on a Nexus server
- **Works offline:** everything saves on the device first and syncs when you're back online
- **Nexus Desk:** a floating Nexus window with a hot corner for Mac and Windows, installed with one command

---

## Matrix-Based Task Management

- Create, edit, archive and delete tasks
- Four quadrants: High, Medium, Low and No priority
- Drag and drop between quadrants, and reorder within one, with haptics
- Swipe to complete or delete
- Pin important tasks
- "Delete all" in a quadrant, with Undo
- Recently deleted: restore anything, kept for as long as you choose
- Archive: find, restore or delete old tasks from Settings

---

## Calendar

- Month and day views of your deadlines and reminders
- **Linked calendars:** Google, Zoho, iCloud, Outlook or any private iCal (.ics) link
- Every item shows where it came from; tap a calendar in the legend to hide or show it
- Checked every 15 minutes by default (you choose from 5 minutes to 6 hours) and whenever you open Nexus
- **Join** button on events with a Google Meet, Zoom or Teams link
- Turn any event into a task, with the meeting link included
- Add any task with a deadline to Google, Apple or Outlook Calendar in one tap
- Import and export calendar (.ics) files
- Import deadlines from Excel or CSV: every dated row becomes a task
- Choose whether Nexus opens on the Matrix or the Calendar

> Nexus doesn't replace your calendars. Events stay in Google, Zoho, iCloud or Outlook; Nexus shows them all together.

---

## Deadlines & Reminders

- **Deadlines:** pick a due day and get alerts days before, on the day or after
- **Exact reminders** at a date and time; the notification opens the task
- **All-day reminders** that repeat through the day (every hour, every 2 hours, or your own interval)
- **Date-range reminders** across several days, for exam prep, workout plans or habits
- **Meeting heads-ups** from linked calendars, from 30 minutes before up to when they start
- Pinned tasks can stay in your notifications until done
- Notification actions: **Done**, **Snooze**, **Open**
- Reminders survive a phone restart and clear themselves after ringing
- **Full control:** pause notifications, turn each type on or off, group them, and set an hourly safety limit
- Web reminders ring even when the tab is closed (web push)

---

## Notes

Every task can hold rich notes:

- Plain text and multi-line descriptions
- Checklists
- Bullet and numbered lists
- Nested content
- Long-form planning notes

Good for study plans, project tracking, journals and meeting notes.

---

## Sync & Backup

- **Nexus Sync** through your own Google Drive: Android ↔ Android, Android ↔ Web, Web ↔ Web
- Stays signed in: no more reconnecting every hour
- Automatic conflict handling: the newest change wins, and deletions sync too
- Switching Google accounts asks what to do with the tasks on this device
- Local backup files, and restore from backup
- Nothing is stored on a Nexus server: your tasks live on your devices and in your Drive

---

## Everywhere You Work

- **Android app** with home-screen widgets: Matrix, Today, Quick add, Next up and a single quadrant
- **Web app** that installs like an app on iPhone, iPad, Android, Mac and Windows, with notifications
- **Nexus Desk** for Mac and Windows: a small always-at-hand Nexus window
  - Float on top, sit on the desktop, or behave like a normal window
  - Hot corner: move the mouse to a screen corner to show or hide Nexus
  - Starts at login
  - Mac: `curl -fsSL https://rsng-phoenix.github.io/Nexus/desktop/install-mac.sh | bash`
  - Windows (PowerShell): `irm https://rsng-phoenix.github.io/Nexus/desktop/install-windows.ps1 | iex`

---

## Personalization

- Light, dark and system themes
- Text size and layout controls
- Choose your start screen (Matrix or Calendar) and the first day of the week
- You set the numbers: check-in delay, snooze length, reminder hours and trash retention
- Settings grouped into clear categories
- A hands-on tour: you try each step yourself instead of reading slides

---

## Technology Stack

**Android**
- Kotlin, Jetpack Compose, Material Design 3
- Room, ViewModel, StateFlow, Coroutines
- WorkManager, AlarmManager, BroadcastReceiver, NotificationCompat
- Glance home-screen widgets

**Web**
- Preact + Signals, TypeScript, Vite
- Installable PWA with a service worker, working offline
- IndexedDB storage
- Google Drive (app data folder) sync

**Notifications relay**
- Cloudflare Worker + D1 for web push and fetching linked calendars

---

## Screenshots
### 🏠 Matrix Dashboard

<p align="center">
  <img src="https://github.com/user-attachments/assets/27d8d266-e9fe-4d86-bfca-61ac682b4e07" width="220" alt="Nexus Home Screen">
</p>

<p align="center">
  <em>
    Priority Matrix dashboard featuring High, Medium, Low and None quadrants.
  </em>
</p>

---

### ➕ Quick Task Creation

<p align="center">
  <img src="https://github.com/user-attachments/assets/8c26c6b6-d90b-4b00-a0a1-797954d1d756" width="220" alt="Create Task">
</p>

<p align="center">
  <em>
    Create tasks instantly using the + button or by dragging it to any of the matrix.
  </em>
</p>

---

### 📋 Matrix Organization

<p align="center">
  <img src="https://github.com/user-attachments/assets/bb5f6707-e568-429a-84b0-f41bb92daa88" width="220" alt="Tasks Organized">
</p>

<p align="center">
  <em>
    Tasks organized into priority quadrants for better focus and planning.
  </em>
</p>

---

### 📝 Rich Task Editor & Notes

<p align="center">
  <img src="https://github.com/user-attachments/assets/16382977-c0d9-4f0a-9175-e950f8155850" width="220" alt="Task Editor" hspace="8">
  <img src="https://github.com/user-attachments/assets/698f47a8-fb7f-4354-8a17-2ce67d72398b" width="220" alt="Rich Notes" hspace="8">
</p>

<p align="center">
  <em>
    Advanced note editor with checklists, bullet lists, numbered lists and structured note-taking.
  </em>
</p>

---

### 🔄 Drag & Drop Prioritization

<p align="center">
  <img src="https://github.com/user-attachments/assets/6f99f2ca-84a6-4812-a9fc-ce1bb8cc0046" width="220" alt="Dragging Task" hspace="8">
  <img src="https://github.com/user-attachments/assets/931d4c71-1551-4214-a769-c650dd897b57" width="220" alt="Task Reprioritized" hspace="8">
</p>

<p align="center">
  <em>
    Move tasks between quadrants using intuitive drag & drop interactions.
  </em>
</p>

---

## License

Licensed under GNU GPL v3.

### What this means

You are free to:

- Use
- Modify
- Study
- Share

Under the following conditions:

- Credit must be given to the original author
- Modified versions must remain open source
- GPL v3 license must be preserved

### Author

Priyanshu Pradhan

Please respect the original work and contribute back whenever possible.
