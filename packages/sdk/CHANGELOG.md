# @hyjk2000/bravia-sdk

## 0.1.0

### Minor Changes

- df11888: Replace ky with native fetch, retaining HTTP status errors, authentication cookies,
  and no automatic retries. Add a configurable timeoutMs client option, defaulting
  to a 10-second deadline for requests and JSON body reads.
