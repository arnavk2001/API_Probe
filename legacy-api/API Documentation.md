# Legacy Fixture API Reference (Phase 1)

This API is intentionally designed to represent a legacy system while still being fully and correctly documented.

## Base URL

`http://localhost:4011`

## Authentication

All endpoints except `GET /health` require the header:

- `x-api-key: legacy-test-key`

You can override the key with the `LEGACY_API_KEY` environment variable.

## Supported Versions

- `v1.1`
- `v1.2`

Version is part of each path: `/api/{version}/...`

## Version Difference Summary

Order payload field naming differs by version:

- `v1.1`: uses `commodity_id`
- `v1.2`: uses `commodity_code_id`

This difference applies to both request and response bodies for order operations.

## Endpoint Reference

### 1) Health Check

- Method: `GET`
- Path: `/health`
- Auth required: No

Response `200`:

```json
{
  "status": "ok"
}
```

### 2) System Info

- Method: `GET`
- Path: `/api/{version}/system/info`
- Auth required: Yes

Response `200`:

```json
{
  "system": "Legacy Freight Suite",
  "version": "v1.1",
  "auth": { "header": "x-api-key" },
  "orderCreateFlow": [
    "GET /api/{version}/orders/template?customer_id={id}",
    "PUT /api/{version}/orders/{order_id}"
  ],
  "notes": "Order payload uses commodity_id"
}
```

### 3) Get Order Template (Required Pre-step)

- Method: `GET`
- Path: `/api/{version}/orders/template`
- Query parameters:
  - `customer_id` (required)
- Auth required: Yes

Response `200`:

```json
{
  "template_token": "tpl_xxxxx",
  "customer_id": "cust_a",
  "expires_at": "2026-03-14T10:30:00.000Z",
  "default_currency": "USD",
  "required_fields": [
    "template_token",
    "customer_id",
    "pickup_date",
    "commodity_id",
    "line_items"
  ]
}
```

Notes:

- `template_token` expires after 5 minutes.
- The token is bound to the `customer_id` used to request it.

### 4) Create or Update Order

- Method: `PUT`
- Path: `/api/{version}/orders/{orderId}`
- Auth required: Yes

Behavior:

- Returns `201` when creating a new order.
- Returns `200` when updating an existing order.

Required body fields for `v1.1`:

```json
{
  "template_token": "tpl_xxxxx",
  "customer_id": "cust_a",
  "pickup_date": "2026-03-14",
  "commodity_id": "metal",
  "line_items": [
    { "sku": "sku-01", "quantity": 2, "unit_price": 150.25 }
  ]
}
```

Required body fields for `v1.2`:

```json
{
  "template_token": "tpl_xxxxx",
  "customer_id": "cust_a",
  "pickup_date": "2026-03-14",
  "commodity_code_id": "metal",
  "line_items": [
    { "sku": "sku-01", "quantity": 2, "unit_price": 150.25 }
  ]
}
```

Optional field:

- `currency` (defaults to `USD` if omitted)

Validation rules:

- `template_token` must exist.
- `template_token` must not be expired.
- `template_token` customer must match `customer_id` in body.
- `line_items` must be a non-empty array.
- Each line item requires:
  - `sku` string
  - `quantity` number > 0
  - `unit_price` number >= 0

### 5) Get Order

- Method: `GET`
- Path: `/api/{version}/orders/{orderId}`
- Auth required: Yes

Response `200` (v1.1 example):

```json
{
  "order_id": "ord_1001",
  "customer_id": "cust_a",
  "pickup_date": "2026-03-14",
  "commodity_id": "metal",
  "currency": "USD",
  "line_items": [
    { "sku": "sku-01", "quantity": 2, "unit_price": 150.25 }
  ],
  "created_at": "2026-03-14T10:00:00.000Z",
  "updated_at": "2026-03-14T10:00:00.000Z"
}
```

### 6) Create Invoice

- Method: `POST`
- Path: `/api/{version}/invoices`
- Auth required: Yes

Required body:

```json
{
  "invoice_id": "inv_5001",
  "customer_id": "cust_a",
  "total": 325.75,
  "currency": "USD",
  "issued_at": "2026-03-14T09:30:00.000Z"
}
```

Optional:

- `notes` string

Response `201` mirrors the created invoice payload.

### 7) Get Invoice

- Method: `GET`
- Path: `/api/{version}/invoices/{invoiceId}`
- Auth required: Yes

Response `200`:

```json
{
  "invoice_id": "inv_5001",
  "customer_id": "cust_a",
  "total": 325.75,
  "currency": "USD",
  "issued_at": "2026-03-14T09:30:00.000Z",
  "notes": "optional text"
}
```

### 8) Monthly Expense Summary

- Method: `GET`
- Path: `/api/{version}/expenses/summary`
- Query parameters:
  - `customer_id` (required)
  - `month` (required, format `YYYY-MM`)
- Auth required: Yes

Response `200`:

```json
{
  "customer_id": "cust_a",
  "month": "2026-02",
  "invoice_count": 2,
  "total_amount": 1650.5,
  "currency": "USD"
}
```

## Error Format

Errors are returned as:

```json
{
  "error": "validation_error",
  "message": "human-readable explanation"
}
```

Common statuses:

- `400` validation failure
- `401` missing/invalid API key
- `404` unsupported version or missing resource

## Quick Start

1. Install dependencies: `npm install`
2. Run API: `npm run dev`
3. Probe with header: `x-api-key: legacy-test-key`
