# F.E.A.R. UX/UI Direction

This document defines the first interface direction for F.E.A.R.

## Product feeling

F.E.A.R. should feel less like a chatbot page and more like a quiet desktop presence.

Keywords:

- silent
- aware
- precise
- dark
- minimal
- responsive
- personal
- cinematic, but still usable

## Core UX principles

1. The assistant should not fight for attention.
2. Status should always be visible: listening, thinking, speaking, offline.
3. Voice, text, memory, Spotify, and gestures should feel like one system.
4. The user should understand what F.E.A.R. is doing without reading logs.
5. Dangerous or private information should never be shown loudly by default.

## Main screen layout

The first UI is a local web dashboard with four zones:

### 1. Presence area

A central orb / pulse element showing assistant state.

States:

- Idle: dim breathing pulse
- Listening: brighter pulse
- Thinking: rotating ring
- Speaking: wave animation
- Error: amber/red small warning state

### 2. Command console

A compact text box for manual commands.

Actions:

- send command
- choose speaker
- enable/disable spoken response
- start voice capture
- capture one 5-second chunk

### 3. Memory panel

Shows recent memories for the current speaker.

The memory panel should be quiet and collapsible later, because personal memory can be sensitive.

### 4. System panel

Status cards:

- OpenRouter model
- Spotify
- Obsidian watcher
- Voice listener
- TTS mode
- Chroma memory

## Visual language

### Colors

- Background: near-black navy
- Surface: dark blue-gray
- Primary accent: electric cyan
- Secondary accent: soft violet
- Warning: amber
- Error: soft red
- Text: cool white
- Muted text: blue-gray

### Typography

Use system fonts first for speed and cross-platform reliability.

Suggested stack:

- Inter
- Segoe UI
- system-ui
- sans-serif

### Motion

Motion should be subtle.

- breathing pulse for idle state
- small ring animation for processing
- message fade-ins
- no excessive neon flicker

## First useful screens

### Dashboard

Purpose: control the assistant.

Contains:

- presence orb
- command composer
- response display
- status cards
- event timeline

### Memory explorer

Purpose: inspect what F.E.A.R. remembers.

Contains:

- speaker filter
- recent facts
- source filter
- delete/edit actions later

### Integrations

Purpose: connect Spotify, OpenRouter, ElevenLabs, Obsidian.

Contains:

- missing config warnings
- local-only explanation
- safe `.env` guidance

## Initial frontend files

The first frontend is intentionally plain HTML/CSS/JS. It should run locally without a build step.

Files:

- `frontend/index.html`
- `frontend/styles.css`
- `frontend/app.js`

Future upgrade path:

- Vite + React
- Tauri desktop shell
- Electron only if necessary
- WebSocket voice stream
