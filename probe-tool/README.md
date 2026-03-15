# API Probe Tool

This project is a production-style probing system for legacy APIs. It takes business goals in natural language, probes a target installation, adapts to documentation drift, validates outcomes, stores learned behavior, and generates a callable TypeScript SDK for multi-customer and multi-version use.

The tool is designed for real-world legacy integration problems where docs are stale, methods drift between versions, fields are renamed, and multi-step prerequisites are undocumented.

## What Problem This Tool Solves

Legacy integration work is expensive and brittle because:
1. API behavior differs across versions.
2. API behavior differs across customers on the same version.
3. Documentation can be incomplete or wrong.
4. Customers upgrade at different times, so old and new behaviors must coexist.

The probe tool solves this by discovering behavior empirically and persisting capability profiles per installation.

## High-Level Workflow

For one probe run, the flow is:
1. Load documentation context (local files and optional remote URLs).
2. Parse natural-language goals into structured goals and required access levels.
3. Generate an execution plan with the LLM.
4. Execute plan steps against target API.
5. If a step fails, classify failure and retry with adapted plan up to max attempts.
6. Validate goal outcomes with deterministic and LLM-assisted checks.
7. Build and save capability profile for that installation.
8. Compare with prior profile and emit drift report.
9. Generate per-installation SDK and unified callable SDK.

## Repository Structure

Key project folders:
1. legacy-api
This is the baseline documented legacy API fixture.

2. legacy-api/src/server2.ts
This is the drifted customer-installation variant with undocumented behavioral differences.

3. legacy-api/src/server3.ts
This is the XML-response drifted installation variant with undocumented behavior differences and field/method drift.

3. probe-tool
This is the probing product itself.

Inside probe-tool:
1. src
Runtime implementation.

2. configs
Scenario configs used by test harness.

3. profiles
Learned installation profiles produced by probe runs.

4. generated-sdk
Generated per-profile and unified TypeScript SDK artifacts.

5. probe-results-session_*.json
Full run traces and validation outputs.

## Architecture

Main modules in src:
1. cli.ts
End-to-end runner for one probe session.

2. goalParser.ts
Parses goal text and infers access scope.

3. probeOrchestrator.ts
Coordinates plan generation, execution, diagnostics, and retries.

4. executionEngine.ts
Per-step HTTP execution, variable extraction, interpolation, and canonical alias injection.

5. diagnostics.ts
Classifies failure causes such as method mismatch, parameter mismatch, missing prerequisites.

6. validationEngine.ts
Validates goal outcomes, including write-then-read-back and alias-aware field checks.

7. discoveryEngine.ts
Builds capability signatures from successful attempts.

8. profileStore.ts
Persists and loads installation-scoped profiles.

9. driftAnalyzer.ts
Compares old vs new profiles and classifies drift severity.

10. sdkGenerator.ts
Generates:
- per-profile client at generated-sdk/customer/version/client.ts
- unified callable SDK at generated-sdk/index.ts

11. knowledgeContext.ts
Loads docs from files and URLs, builds context block for planning.

12. testHarness.ts
Runs full matrix validation across customers, versions, and installations.

## Installation and Setup

From repository root:
1. npm install

From probe-tool:
1. ensure probe-tool/.env exists and has GEMINI_API_KEY
2. npm install
3. npm run build

Environment knobs:
1. GEMINI_API_KEY
Required for LLM calls.

2. GEMINI_MODEL
Optional model override.

3. MAX_PROBE_ATTEMPTS
Retry cap per goal (for example 3).

4. LLM_JSON_RETRIES
Retry cap for malformed JSON LLM outputs.

## Running Legacy Fixtures

From repository root:
1. npm run dev
Starts baseline server on port 4011.

2. npm run dev:server2
Starts drifted installation on port 4012.

3. npm run dev:server3
Starts XML drifted installation on port 4013.

Authentication for both fixtures:
1. header name: x-api-key
2. default value: legacy-test-key

## Probe Configuration

Minimum config fields:
1. goals
2. apiBaseUrl
3. authHeader
4. apiVersion
5. customerId
6. documentation source via docPath and or docUrls

Optional fields:
1. openApiPath

Important rule:
At least one documentation source is required.

Example configs:
1. configs/cust_a_v11_server1.json
2. configs/cust_a_v11_server2.json
3. configs/cust_a_v11_server3.json
4. configs/cust_a_v12_server1.json
5. configs/cust_b_v11_server1.json

## Running the Probe Tool

From probe-tool:
1. MAX_PROBE_ATTEMPTS=3 npm run probe -- --config=probe-config.example.json

To skip SDK generation for a run:
1. npm run probe -- --config=probe-config.example.json --skip-sdk

Blind server2 style run:
1. rm -f profiles/cust_a__v1.1__http___localhost_4012.json
2. MAX_PROBE_ATTEMPTS=3 npm run probe -- --config=configs/cust_a_v11_server2.json --skip-sdk

## Output Artifacts

After each probe run:
1. probe-results-session_<id>.json
Full execution trace, attempts, diagnostics, validation, summary.

2. profiles/<customer>__<version>__<baseUrl>.json
Learned capability profile for that installation.

3. generated-sdk/customer/version/client.ts
Per-profile callable SDK client.

4. generated-sdk/index.ts
Unified callable SDK across all saved profiles.

## Generated SDK Usage

Unified SDK entry points:
1. createProbeSdk
2. forInstallation with customerId, apiVersion, optional apiBaseUrl, authHeader
3. call with capabilityId and optional request override

Typical usage pattern:
1. Load unified SDK module.
2. Create ProbeSdk instance.
3. Select installation via forInstallation.
4. Inspect available capabilities or call one directly.

## Drift and Rerun Behavior

Rerunning probing for the same installation:
1. loads prior profile if present,
2. compares new profile to prior profile,
3. reports drift as added, removed, modified,
4. classifies severity as compatible, warning, breaking,
5. regenerates SDK with latest profile set.

This is what supports customer upgrades while preserving old-customer behavior in parallel.

## End-to-End Test Harness

Run from probe-tool:
1. npm run phase3:test

What it validates:
1. Customer A v1.1 baseline installation.
2. Customer A v1.1 drifted installation.
3. Customer A v1.1 XML drifted installation.
4. Customer A upgrade to v1.2.
5. Customer B remains on v1.1.
6. Unified SDK artifact generation.

Pass condition:
All scenarios complete with expected outcomes and artifacts.

Detailed results:
See TEST_REPORT_PHASE3.md.

Phase 4 XML and blind-drift validation:
See TEST_REPORT_PHASE4.md.

## Capabilities Verified by Project Tests

1. Goal parsing and access-level inference.
2. Blind probing against mismatched documentation.
3. Retry adaptation for method drift and field drift.
4. Recovery of hidden multi-step prerequisite flows.
5. Write-readback validation.
6. Installation-scoped learning and profile persistence.
7. Drift detection across reruns.
8. Multi-customer and multi-version coexistence.
9. XML response parsing, normalization, and validation.
10. Callable TypeScript SDK generation.

## Operational Notes

1. The tool is JSON-first with XML response fallback parsing.
2. It supports custom headers, token workflows, and multi-step API flows.
3. XML payloads are normalized to object form for dot-path extraction and validation.
4. Turnkey OAuth or 2FA protocol modules are still future extension points.

## Troubleshooting

1. LLM auth error
Check GEMINI_API_KEY in probe-tool/.env.

2. Port already in use
Stop existing process on 4011, 4012, or 4013 before launching fixtures.

3. Probe fails on first attempt against drifted installation
This is expected in blind tests. Ensure MAX_PROBE_ATTEMPTS is greater than 1.

4. No profile generated
Check probe session output and run summary file for fatal errors before profile write stage.

5. Unified SDK not generated
Do not pass --skip-sdk, and ensure at least one profile exists.

## Quick Start For New Users

1. Start baseline API from repository root:
npm run dev

2. In another terminal, run probe tool:
cd probe-tool
npm run build
MAX_PROBE_ATTEMPTS=3 npm run probe -- --config=probe-config.example.json

3. Inspect outputs:
profiles folder, generated-sdk folder, and latest probe-results-session file.

4. Run full validation:
npm run phase3:test
