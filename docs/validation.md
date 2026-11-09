# Validation status

The following results apply to **`agentgateway-uksouth-demo`**, checked on
**18 October 2026**. They are not certification of a new deployment.

| Check | Result | Evidence / boundary |
| --- | --- | --- |
| Local certificate-backed demo | Passed live | User confirmed both tutor acceptance flows; deeper certificate-rotation testing is not a production acceptance gate |
| Azure managed-identity OBO | Passed live | Signed gateway delegation plus both tutors, including hosted continuation |
| Identity survives demo redeployment | Passed live | Dedicated identity and blueprint federation preserved; both tutors passed after redeployment |
| Scale from zero | Passed live | `/api/config` returned HTTP 200 in 18.5 seconds from zero replicas |
| Silent token renewal | Passed live | Explicit noncached Entra renewal, then all six acceptance checks passed |
| Stop and recovery | Passed live | User confirmed streaming stopped and the next request completed after the fix |
| Authorization denials | Passed live | Missing authorization and wrong-audience token denied; legacy route returns 404 |
| Shared monitoring | Passed, bounded | Ingestion, hosted-to-gateway correlation, and sampled credential-pattern scan |
| Legacy shared-key removal | Completed | Secret soft-deleted, exact-scoped reader removed, OAuth secret preserved |
| Offline demo regression | Passed | 53 server tests, 3 browser tests, typecheck, lint, and production build |
| Natural token expiry | **Pending** | A real long-session soak is still needed; forced renewal and mocked expiry are not substitutes |
| Model-quality evaluation setup | Created; **not scored** | Foundry-generated suites plus identical 100-case curated baselines; provisional gates await human calibration |

## Remaining checks and demo limits

- Keep a signed-in session through **natural token expiry**, then verify
  automatic renewal or explicit reauthentication and successful OBO.
- Post-cleanup signed-in acceptance checks for both tutors have passed.
- The demo is single-process/single-replica: active runs do not survive restart
  or redeployment. Multi-replica operation needs shared run coordination.
- Stop verifies client/bridge cancellation and recovery, **not** termination of
  upstream computation or billing.
- Plain playground/Agent Inspector access without the required forwarded token
  is not evidence of delegated inference.

## Run the tests

```bash
node --test tests/infra.test.mjs tests/agent.test.mjs tests/deployment.test.mjs \
  tests/entra.test.mjs tests/migration.test.mjs tests/demo-entra.test.mjs \
  tests/demo-hosting.test.mjs tests/evaluations.test.mjs tests/gateway.test.mjs
agents/ai-tutor-hosted-agent/.venv/bin/python -m unittest discover \
  -s agents/ai-tutor-hosted-agent -p 'test_*.py'
```

Local tests do not provision Azure or invoke real models. Infrastructure tests
require Azure CLI/Bicep. Gateway tests run the pinned Linux amd64 image against
mock identity/model/OTLP services using Podman with host networking; Docker on
Linux can be selected with `CONTAINER_RUNTIME=docker`.
