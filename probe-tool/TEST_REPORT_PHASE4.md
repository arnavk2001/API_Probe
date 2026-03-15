# Phase 4 Test Report (XML + JSON Probing)

## 1. Objective

Validate that Phase 4 is correctly implemented by proving:
1. Blind probing still adapts to undocumented JSON drift (server2).
2. Blind probing adapts to undocumented XML drift (server3).
3. XML responses are parsed into structured objects usable by extraction and validation.
4. Full multi-scenario regression still passes.

## 2. Blind Testing Strategy Used

For each drifted installation, run in blind mode with no prior learned profile:
1. Delete installation profile cache.
2. Probe using shared docs (same baseline docs/openapi).
3. Set `MAX_PROBE_ATTEMPTS=3`.
4. Expect first attempt failures due to drift.
5. Expect adaptation and eventual success.

## 3. Executed Blind Runs

## 3.1 Server2 blind run (JSON drift)

Command:
- `MAX_PROBE_ATTEMPTS=3 npm run probe -- --config=configs/cust_a_v11_server2.json --skip-sdk`

Evidence session:
- `probe-results-session_1qrcxvxe.json`

Result summary:
1. Overall success: true
2. Goal 1: first attempt failed, succeeded on attempt 2
3. Goal 2: first attempt failed, succeeded on attempt 2
4. Goal 3: first attempt failed, succeeded on attempt 3

## 3.2 Server3 blind run (XML drift)

Command:
- `MAX_PROBE_ATTEMPTS=3 npm run probe -- --config=configs/cust_a_v11_server3.json --skip-sdk`

Evidence session:
- `probe-results-session_nkdswxqk.json`

Result summary:
1. Overall success: true
2. Goal 1: first attempt failed, succeeded on attempt 2
3. Goal 2: first attempt failed, succeeded on attempt 2
4. Goal 3: first attempt failed, succeeded on attempt 3

## 4. XML Parsing Verification

From `probe-results-session_nkdswxqk.json` step traces:
1. XML responses were recorded as object bodies (not raw text strings).
2. Parsed response keys include expected fields such as:
   - `preflight_token`
   - `template_token`
   - `order_id`
   - `invoice_ref`
   - `error`, `message` for validation failures
3. Goal-level validations succeeded for write-readback checks and read-only checks.

This demonstrates that XML normalization and extraction compatibility are working.

## 5. Regression Harness Run

Command:
- `npm run phase3:test`

Observed output:
1. Harness completed all 5 scenarios.
2. Final line: `Phase 3 validation succeeded.`
3. Sessions executed: 5
4. Unified SDK generated successfully.

## 6. Conclusion

Phase 4 implementation is validated.

Pass conditions met:
1. Blind strategy succeeds for server2 and server3 after expected first-attempt failures.
2. XML responses are parsed and validated correctly.
3. No regression in end-to-end matrix harness behavior.
