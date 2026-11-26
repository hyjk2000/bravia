# @hyjk2000/homebridge-bravia

## 0.0.5

### Patch Changes

- Updated dependencies [df11888]
  - @hyjk2000/bravia-sdk@0.1.0

## 0.0.4

### Patch Changes

- 758c6af: Prevent delayed TV status reads from rolling back successful HomeKit power and input changes. Keep the last known input when Sony cannot identify playing content, and update it when playback is identified or the TV enters standby.

## 0.0.3

### Patch Changes

- 5868575: Use the current input URI as the single source of selection state so input and application rescans do not restore the previous HomeKit selection.
- a9d2ff5: Prepopulate the Homebridge setup form with the default input source categories for newly added TVs.
