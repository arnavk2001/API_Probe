# Phase 3 Test Report

## 1. Test Objective

This test validates that the Phase 3 API probe tool can:
- operate in a blind mode against an undocumented installation variant,
- recover from documentation drift through retries and adaptive planning,
- validate write outcomes by reading data back,
- persist learned capability profiles and drift evidence,
- generate a callable TypeScript SDK,
- support multi-customer and multi-version scenarios.

## 2. Test Strategy

### 2.1 Blind Test (Server 2)

The blind test enforces that the tool does not rely on pre-learned server2 profile data:
1. Remove server2 profile cache:
   - `rm -f profiles/cust_a__v1.1__http___localhost_4012.json`
2. Use config that points to shared server1 documentation only:
   - `configs/cust_a_v11_server2.json`
3. Run probing with retry cap:
   - `MAX_PROBE_ATTEMPTS=3 npm run probe -- --config=configs/cust_a_v11_server2.json --skip-sdk`

### 2.2 Matrix Harness Test

Run the full Phase 3 harness:
- `npm run phase3:test`

Harness scenarios:
1. Customer A, v1.1, server1 baseline
2. Customer A, v1.1, server2 drifted installation
3. Customer A, v1.2, server1 upgrade scenario
4. Customer B, v1.1, server1 unchanged scenario

The harness verifies scenario success, drift behavior, profile persistence, and unified SDK generation.

## 3. Pass Criteria

A test run is considered **passed** when all conditions below hold:
1. Blind server2 run starts without server2 profile cache.
2. First attempts fail on server2 for drifted flows (expected mismatch behavior).
3. Retry logic succeeds within max 3 attempts.
4. Goal validation returns success for all requested tasks.
5. Capability profile is written for server2 installation.
6. Matrix harness completes all scenarios successfully.
7. Unified SDK file is generated and callable.

## 4. Executed Tests and Outcomes

### 4.1 Blind Server2 Probe Outcome

Evidence session:
- `probe-results-session_epwexck9.json`

Observed outcomes:
1. `goal_1` (order create + readback):
   - Attempt 1 failed (missing preflight token)
   - Attempt 2 succeeded
2. `goal_2` (invoice write + readback):
   - Attempt 1 failed (POST not supported)
   - Attempt 2 succeeded (method/field adaptation)
3. `goal_3` (expense summary read):
   - Attempt 1 failed (missing `customer_ref`)
   - Attempt 2 failed (missing `period`)
   - Attempt 3 succeeded

Final status:
- `Goals succeeded: 3 / 3`
- `Overall: SUCCESS`

### 4.2 Full Phase 3 Harness Outcome

Command output summary:
- Scenario execution completed for all four matrix cases.
- Harness final line:
  - `Phase 3 validation succeeded.`
- Sessions executed:
  - `4`
- Unified SDK generated:
  - `generated-sdk/index.ts`

Final status:
- **PASS**

## 5. Capabilities Validated by These Tests

The test suite validates the following project capabilities:
1. Natural-language task parsing to executable goals.
2. Access mode inference (`read-only`, `write`, `read-write`).
3. Blind probing using shared docs with no server2-specific docs.
4. Adaptive retries for method mismatch and parameter drift.
5. Multi-step workflow recovery (hidden preflight/token requirement).
6. Write-readback field validation.
7. Installation-scoped profile persistence (`customer + version + baseUrl`).
8. Drift-aware behavior capture over reruns.
9. Multi-customer, multi-version compatibility support.
10. Callable TypeScript SDK generation (unified and profile-based artifacts).

## 6. How We Determine the Tests Passed

Pass determination uses objective checks from command outputs and artifacts:
1. Command exits are successful for blind run and harness run.
2. Blind run JSON session reports `overallSuccess: true` and all goals success.
3. Harness reports `Phase 3 validation succeeded` and executes 4 scenarios.
4. Generated SDK artifact exists at `generated-sdk/index.ts`.
5. Installation profiles exist under `profiles/` for tested customer/version/baseUrl combinations.

## 7. Conclusion

Phase 3 testing passed under both:
- a strict blind server2 recovery test, and
- a full customer/version matrix harness test.

Based on these results, the implementation is ready for formal testing/review and demonstrates the intended end-to-end probing + adaptive recovery + callable SDK workflow.
