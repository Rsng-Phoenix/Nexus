# NEXUS v2.5(Stable)
Not a Normal To-do app its Priority Based { Matrix Lisitng }

## Features

### Task Management
- Create, edit, and delete tasks with a title and description
- Organize tasks by **priority**: High, Medium, and Low
- **Drag and drop** to reorder tasks within or across priority levels
- **Pin tasks** to keep critical items persistently visible
- Mark tasks as **completed**

### Reminders & Notifications
- Set **exact date and time** reminders for any task
- **All-Day Reminder Mode**: get notified every 1 hour, 2 hours, or a custom interval throughout the selected day
- **Date Range Reminders**: schedule recurring reminders across a span of dates (e.g., from exam start to exam end)
- **Pinned Task Alerts**: pinned tasks with reminders show a persistent, non-dismissible notification until the task is completed
- **Alarm Mode**: triggers a real device alarm sound for time-sensitive tasks when date+time or time+pin is configured
- Snooze reminders for 10 minutes directly from the notification
- Dismiss reminders with a "Mark Done" action from the notification
- Notifications are tappable — opens directly to the related task

### UI & Experience
- Clean, minimal task card design
- Smooth animated task edit view that slides up without covering the camera cutout
- Edit view stays expanded after keyboard dismissal
- Fluid swipe-down gesture to close the edit view
- Persistent local storage using **Room database**
- Data survives app restarts and device reboots

### Tech Stack
- Kotlin
- Jetpack Room (local database)
- ViewModel + StateFlow (reactive UI)
- AlarmManager with exact alarms
- BroadcastReceiver for notification handling
- NotificationCompat with action buttons
