# Full Blind Validation Report (2026-03-16)

## 1. Objective

Validate end-to-end project behavior in one fresh blind run:
1. No pre-learned profile knowledge before execution.
2. Successful probing across baseline, JSON drift, XML drift, version upgrade, and multi-customer scenarios.
3. Generated SDK correctness validation after probing.
4. Evidence artifacts collected for reproducibility.

## 2. Run Metadata

1. Run timestamp: 2026-03-16 22:00:19 PDT
2. Harness command: npm run phase3:test
3. Working directory: probe-tool

## 3. Blind Preconditions (Verified)

Before running the harness, the state was reset:
1. Deleted profiles directory contents.
2. Deleted generated-sdk directory contents.
3. Deleted all probe-results-session_*.json files.
4. Verified session file count before run was 0.

This ensured server2 and server3 were unknown to the probe tool at run start.

## 4. End-to-End Harness Result

Harness completed successfully with all required scenarios:
1. cust_a v1.1 on server1 (baseline)
2. cust_a v1.1 on server2 (JSON drift)
3. cust_a v1.1 on server3 (XML drift)
4. cust_a v1.2 on server1 (upgrade)
5. cust_b v1.1 on server1 (parallel customer)

Final harness status:
1. Phase 3 validation succeeded.
2. Sessions executed: 5.
3. Unified SDK generated.

## 5. Probe Session Evidence

Produced sessions from this run:
1. probe-results-session_ey0x4te8.json | cust_a | v1.1 | http://localhost:4011 | overall=true | goals=3 | firstAttemptFailAllGoals=false
2. probe-results-session_oj8rmtz0.json | cust_a | v1.1 | http://localhost:4012 | overall=true | goals=3 | firstAttemptFailAllGoals=true
3. probe-results-session_zimxmj8u.json | cust_a | v1.1 | http://localhost:4013 | overall=true | goals=3 | firstAttemptFailAllGoals=true
4. probe-results-session_xmu4xkhi.json | cust_a | v1.2 | http://localhost:4011 | overall=true | goals=3 | firstAttemptFailAllGoals=false
5. probe-results-session_l1ks6xl0.json | cust_b | v1.1 | http://localhost:4011 | overall=true | goals=3 | firstAttemptFailAllGoals=false

Blind drift condition was met as expected:
1. Server2: first attempts failed for all goals, then adapted to success.
2. Server3: first attempts failed for all goals, then adapted to success.

## 6. XML Handling Evidence (Server3)

From successful server3 session probe-results-session_zimxmj8u.json:
1. successfulStepCount=7
2. objectResponseBodies=7
3. parsed response keys include: preflight_token, order_id, invoice_ref, required_fields, customer_id, currency_code, notes, line_items

This confirms XML responses were parsed and normalized into object form consumable by extraction and validation logic.

## 7. SDK Correctness Evidence

Integrated runtime SDK validation executed inside harness after generation:
1. Profiles validated: 5
2. Total passed: 20
3. Total failed: 0
4. Validator result: All replay-based SDK checks passed.

Generated SDK artifacts:
1. generated-sdk/index.ts
2. generated-sdk/cust_a/v1.1/client.ts
3. generated-sdk/cust_a/v1.2/client.ts
4. generated-sdk/cust_b/v1.1/client.ts

## 8. Conclusion

This run passed all required criteria for a full blind validation:
1. Server2 and server3 behavior was discovered from scratch.
2. Probe adapted to undocumented drift and completed all goals.
3. XML and JSON responses were both handled correctly.
4. Generated SDK was validated successfully in runtime checks.
