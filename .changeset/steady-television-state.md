---
"@hyjk2000/homebridge-bravia": patch
---

Prevent delayed TV status reads from rolling back successful HomeKit power and input changes. Keep the last known input when Sony cannot identify playing content, and update it when playback is identified or the TV enters standby.
