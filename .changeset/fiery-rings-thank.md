---
"@hyjk2000/bravia-sdk": minor
---

Replace ky with native fetch, retaining HTTP status errors, authentication cookies,
and no automatic retries. Add a configurable timeoutMs client option, defaulting
to a 10-second deadline for requests and JSON body reads.
