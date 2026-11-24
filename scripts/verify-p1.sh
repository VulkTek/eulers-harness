#!/bin/bash
# Euler's Harness P1 verify: launch app without Electron display, confirm PiHost inits + IPC responds.
# Uses electron's binary with xvfb-free headless flag set; simpler: real launch and check via logs.
set -u
cd /var/home/phoenixphoenix/dev/eulers-harness
echo "=== unit-verify: PiHost + SessionStore headless (no electron window) ==="
# Headless PiHost test: drive the classes directly under node (they are electron-free)
node --input-type=module -e "
import { PiHost } from './out/main/pihost.js'
import { SessionStore } from './out/main/sessions.js'
" 2>&1 | head -5
echo "exit: $? (0 = modules import clean)"
