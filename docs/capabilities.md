# Jarv Genie — Capability Catalog

Every manual thing a person can do on this Mac, mapped to how Jarv does it.
The goal: *anything you can do manually, Jarv can do — from anywhere, with
consent, safely.* Status: `[x]` live · `[~]` needs one-time setup · `[ ]` aspirational.

Legend for consent: **R** = read-only (never prompts) · **C** = consent-gated
(one approval per round, batched).

## Apps (open, quit, drive)

| Manual ability | Jarv command | Consent |
| --- | --- | --- |
| Open / quit any app | `app_command` open / quit (Spotify, Music, Notes, Messages, Safari, Chrome, Calendar, Calculator, Clock, Preview, Finder, Terminal, VSCodium, System Settings, Photos, Mail, FaceTime, TextEdit, Stickies, Contacts, Activity Monitor, Podcasts, Maps) | C |
| Play / pause / next / prev music | `app_command` spotify|music play/playPause/next/prev | C |
| Play a playlist / Liked Songs | `app_command` spotify play uri=spotify:likedsongs; music play playlist= | C |
| What's playing / is it running | `app_status` (read-only) | R |
| Take a note | `app_command` notes newNote | C |
| Send a text | `app_command` messages send (real contact required; placeholder/test buddies blocked at the reflex) | C |
| Open a URL / new tab / back / forward | `app_command` safari|chrome openUrl/newTab/back/forward | C |
| Add a calendar event | `app_command` calendar addEvent(title, date) | C |
| List running apps | `process_list` | R |

## System

| Manual ability | Jarv command | Consent |
| --- | --- | --- |
| Sleep / restart / lock / display sleep | `app_command` system sleep/restart/lock/displaySleep | C |
| Lock the screen | `app_command` system lock | C |
| Sleep the display | `app_command` system displaySleep | C |
| Set volume (exact / up / down / mute) | `app_command` system volumeSet/volumeUp/volumeDown/mute/unmute | C |
| Brightness up / down | `app_command` system brightnessUp/brightnessDown | C |
| Copy to clipboard / read clipboard | `app_command` system clipboardSet · `clipboard_get` | C / R |
| Toggle Wi-Fi | `app_command` system wifiOn/wifiOff | C (needs setup) |
| Toggle Bluetooth | `app_command` system bluetoothOn/bluetoothOff | C (needs setup) |
| Wi-Fi / Bluetooth / volume status | `app_status` system | R |
| Do Not Disturb on / off | `app_command` system dndOn/dndOff | C |
| Empty the Trash | `app_command` system emptyTrash | C |
| Take a screenshot (saved) | `app_command` system screenshot | C |

## Files

| Manual ability | Jarv command | Consent |
| --- | --- | --- |
| Browse / read / write / delete | `file_read_any` · `file_list_any` · `file_write_any` · `file_delete_any` | R / R / C / C |
| Move / rename / copy | `file_move_any` · `file_copy_any` | C |
| Find files (Spotlight) | `file_find` | R |
| Zip / unzip | `file_zip` · `file_unzip` | C |
| Open a file in its app | `open_file` | C |
| Reveal in Finder | `reveal_in_finder` | C |
| Run a command | `run_shell` | C |

## Everything else

| Manual ability | Jarv command | Consent |
| --- | --- | --- |
| Web search / read a page | `web_search` · `web_read` | R |
| Email send / read | `email_send` · `email_read` | C / R |
| Reminders create / list / delete | `reminder_create/list/delete` | C / R / C |
| Schedule recurring tasks | `schedule_add/list/remove` | C / R / C |
| Screenshot the screen | `screen_capture` | R |
| Draw / open an image | `draw_shape` | C |
| Shut down / restart the Mac | `shutdown_mac` | C |
| Review / optimize itself | `self_review` | R |
| Talk (voice) / hear | `speak_text`, voice pipeline | R |
| Web (search + read) | `web_search`/`web_read` | R (hosted) |

## Proactive & inventive

| Manual ability | Jarv command | Consent |
| --- | --- | --- |
| Invent opportunities / ideas on a cadence | daily 09:00 scan (web + capabilities → `initiative_propose`) | n/a (notifies you) |
| Track ideas through approval → execution | `initiative_propose/list/status`; 15:00 check starts approved ones | R / C |
| Review & improve itself | `self_review` | R |

## One-time setups needed

1. `bash scripts/setup-shutdown.sh` — passwordless `shutdown` (done).
2. `bash scripts/setup-controls.sh` — passwordless `networksetup` (Wi-Fi) and
   `blueutil` (Bluetooth).
3. `jarv-genie perms` — Accessibility / Screen Recording / Automation grants.

## Honest limits (aspirational)

- Phone calls, AirDrop, drag-and-drop, hardware control — out of scope on this
  Mac.
- Focus/DND is best-effort via system defaults (macOS has no stable CLI).
- Screen *video* recording needs interactive stop — not wired for remote use yet.
