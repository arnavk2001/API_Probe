PHASE 1 OUTPUT (LEGACY API FIXTURE + CORRECT DOCUMENTATION)

What has been added:

- Runnable legacy-style API fixture in legacy-api/src/server.ts
- Human-readable reference documentation in legacy-api/API Documentation.md
- Machine-readable OpenAPI contract in legacy-api/openapi.yaml

How to run:

1. npm install
2. npm run dev

Base URL:

- http://localhost:4011

Authentication:

- Header: x-api-key: legacy-test-key
- Optional override: LEGACY_API_KEY environment variable

Supported API versions:

- v1.1
- v1.2

Core behavior intentionally included for probing tests:

- Multi-step order creation flow (template token required before PUT order)
- Version-specific payload differences:
	- v1.1 uses commodity_id
	- v1.2 uses commodity_code_id
- Read/write coverage for orders and invoices
- Read validation endpoint for monthly expense summaries

This Phase 1 fixture is correctly documented and will be treated as the baseline "known-correct" legacy API for later probing and SDK generation phases.

Our agents integrate with many legacy systems on behalf of our customers. Creating effective integrations with legacy system API’s is time-consuming for engineers and the resulting code we’ve written is brittle.

Here are common situations we face:

A legacy system may have many versions, and if it has an API, the behavior/surface of its API may also differ between versions.
Many legacy API’s are poorly documented or incorrectly documented. While most use REST, some use XML instead of JSON. Some require 2FA, or OAUTH, some require tokens, some require special headers, some use a combination of all three.
Even within a single version of an legacy API, custom configurations of the legacy software may cause it to behave differently between customers using the same version of the legacy software API.
After an integration is created, the customer may upgrade the legacy software version, creating a need to update our agent’s integration to match the new version of the legacy API for just that customer. If our agent is also connecting to the same legacy system on behalf of another customer who has not upgraded, we then need to retain the integration code for the older legacy software API version alongside new integration code.
Currently, we laboriously code and test these integrations by hand, working with the customer to check on outcomes, but that’s not sustainable. One legacy system we work with, McLeod, has over 40 versions in customer use across our customer base.

We need to develop a “API probing” tool that can:

research all known public documentation (or privately hosted documentation) regarding a legacy system’s API
understand the ways we will need to interact with the legacy API (the tool will receive these needs as a list, for instance, “create orders and read them back”, or “read an invoice, retrieve an end-of-month expenses summary, and post a new invoice”.) Given the list, you can tell if you need read-only access to the legacy API or whether you need write access, and at what levels. (We can ensure we have the right access to the client's legacy API for the probing tool to use.)
The tool must then “probe” a customer’s installation to test varying approaches to accomplishing the interaction goals.
Finally, the tool must validate that its approaches have worked. For instance, if we need to write an order into a system, the tool would also read the order back to validate that all the fields on the order were inserted properly.
The tool can be rerun at any time to identify changes to the API that might engender changes to the integration.
Your goal:

Develop a tool that can accomplish the goals above. 
The tool would create a callable, custom typescript SDK that could be used to interface with the legacy API.
Develop tests that can show the probing tool will work, even if the API changes over time.
Hint: you should probably build a test API (or several), along with some (probably inaccurate) API documentation. Your tool can then probe this to ensure the probing tool will work. Show that the SDK the tool outputs would support multiple versions of a legacy system’s API, as we add customers with different versions and configurations of a legacy API. For example, suppose the tool is run on customer A’s legacy system with API v1.1 and then customer A upgrades to v1.2 . Meanwhile customer B remains on v1.1 for the same legacy system. The tool should upgrade its originally outputted SDK, after probing customer A’s installation and seeing it has changed. Ideally, our agents using the tools’ outputted SDK would still function fine for both customer A and customer B’s legacy systems without significant changes.
Include complete documentation on how to use the tool and how the tool is architected/functions.
As an example of some of the documentation we face every day, look at this McLeod documentation. Some of the endpoints in this documentation, for instance, are documented as POST when actually a PUT is needed, and sometimes a previous parameter name in a POST call has changed in this version without it being documented (e.g. commodity_code_id became commodity_id in a later version but this change didn’t make it into the documentation, OR, the documentation says it’s now commodity_code_id but that’s false, the endpoint still actually expects commodity_id). The tool should be able to talk to frontier models with deep knowledge of all the available documentation on all versions of a legacy system’s API to suggest alternatives to try when probing. For instance, suppose the prober tool were to try to create an order with commodity_code_id and this didn’t work; it could then try again with commodity_id and check that instead). Keep in mind, sometimes accomplishing a single task requires two or more steps at a legacy API. For instance, to create an order in this system you must first call a GET endpoint, then use the response to form a PUT payload.