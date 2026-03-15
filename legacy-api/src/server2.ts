import express, { Request, Response } from "express";

type ApiVersion = "v1.1" | "v1.2";

type PreflightRecord = {
    preflightToken: string;
    customerId: string;
    expiresAtMs: number;
};

type OrderRecord = {
    orderId: string;
    customerId: string;
    pickupDate: string;
    commodityId: string;
    currency: string;
    lineItems: Array<{
        sku: string;
        quantity: number;
        unitPrice: number;
    }>;
    createdAt: string;
    updatedAt: string;
};

type InvoiceRecord = {
    invoiceId: string;
    customerId: string;
    total: number;
    currency: string;
    issuedAt: string;
    notes?: string;
};

type OrderLineItemInput = {
    sku: string;
    qty: number;
    unit_price: number;
};

const app = express();
const PORT = Number(process.env.PORT ?? 4012);
const API_KEY = process.env.LEGACY_API_KEY ?? "legacy-test-key";
const PREFLIGHT_TTL_MS = 3 * 60 * 1000;

const preflightTokens = new Map<string, PreflightRecord>();
const ordersByVersion: Record<ApiVersion, Map<string, OrderRecord>> = {
    "v1.1": new Map<string, OrderRecord>(),
    "v1.2": new Map<string, OrderRecord>()
};
const invoicesByVersion: Record<ApiVersion, Map<string, InvoiceRecord>> = {
    "v1.1": new Map<string, InvoiceRecord>(),
    "v1.2": new Map<string, InvoiceRecord>()
};

seedInvoices();

app.use(express.json());

app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok", fixture: "server2" });
});

app.use((req: Request, res: Response, next) => {
    const key = req.header("x-api-key");
    if (key !== API_KEY) {
        return res.status(401).json({
            error: "unauthorized",
            message: "Missing or invalid x-api-key"
        });
    }
    return next();
});

app.get("/api/:version/system/info", (req: Request, res: Response) => {
    const version = parseVersion(req.params.version);
    if (!version) {
        return invalidVersion(res);
    }

    return res.status(200).json({
        system: "Legacy Freight Suite",
        installation: "customer-variant-server2",
        version,
        auth: {
            header: "x-api-key"
        },
        notes: "This installation has undocumented customization and drift from shared docs."
    });
});

app.post("/api/:version/orders/preflight", (req: Request, res: Response) => {
    const version = parseVersion(req.params.version);
    if (!version) {
        return invalidVersion(res);
    }

    const body = req.body as Record<string, unknown>;
    const customerId = readRequiredString(body.customer_id) ?? readRequiredString(body.client_id);
    if (!customerId) {
        return res.status(400).json({
            error: "validation_error",
            message: "customer_id is required"
        });
    }

    const preflightToken = `pre_${Math.random().toString(36).slice(2, 12)}`;
    const expiresAtMs = Date.now() + PREFLIGHT_TTL_MS;

    preflightTokens.set(preflightToken, {
        preflightToken,
        customerId,
        expiresAtMs
    });

    return res.status(201).json({
        preflight_token: preflightToken,
        expires_at: new Date(expiresAtMs).toISOString(),
        customer_id: customerId
    });
});

app.get("/api/:version/orders/template", (req: Request, res: Response) => {
    const version = parseVersion(req.params.version);
    if (!version) {
        return invalidVersion(res);
    }

    const customerId = readRequiredString(req.query.customer_id);
    const preflightToken = readRequiredString(req.header("x-preflight-token"));

    if (!customerId) {
        return res.status(400).json({
            error: "validation_error",
            message: "customer_id is required"
        });
    }

    const token = validatePreflightToken(preflightToken, customerId);
    if (!token) {
        return res.status(400).json({
            error: "validation_error",
            message: "x-preflight-token is required and must match customer_id"
        });
    }

    return res.status(200).json({
        template_token: `tpl_${Math.random().toString(36).slice(2, 12)}`,
        customer_id: customerId,
        default_currency: "USD",
        required_fields:
            version === "v1.1"
                ? ["template_token", "customer_id", "pickup_date", "commodity_code_id", "line_items"]
                : ["template_token", "customer_id", "pickup_date", "commodity_id", "line_items"]
    });
});

app.post("/api/:version/orders/:orderId", (req: Request, res: Response) => {
    const version = parseVersion(req.params.version);
    if (!version) {
        return invalidVersion(res);
    }

    const orderId = readRequiredString(req.params.orderId);
    if (!orderId) {
        return res.status(400).json({
            error: "validation_error",
            message: "orderId path parameter is required"
        });
    }

    const body = req.body as Record<string, unknown>;
    const preflightToken = readRequiredString(req.header("x-preflight-token"));
    const templateToken = readRequiredString(body.template_token);
    const customerId = readRequiredString(body.customer_id);
    const pickupDate = readRequiredString(body.pickup_date);
    const commodityId =
        version === "v1.1"
            ? readRequiredString(body.commodity_code_id)
            : readRequiredString(body.commodity_id);

    const lineItems = body.line_items;

    if (!templateToken || !customerId || !pickupDate || !commodityId || !isValidLineItems(lineItems)) {
        return res.status(400).json({
            error: "validation_error",
            message:
                version === "v1.1"
                    ? "Required: template_token, customer_id, pickup_date, commodity_code_id, line_items[] with qty"
                    : "Required: template_token, customer_id, pickup_date, commodity_id, line_items[] with qty"
        });
    }

    const token = validatePreflightToken(preflightToken, customerId);
    if (!token) {
        return res.status(400).json({
            error: "validation_error",
            message: "x-preflight-token is required and must match customer_id"
        });
    }

    const now = new Date().toISOString();
    const store = ordersByVersion[version];
    const existing = store.get(orderId);
    const order: OrderRecord = {
        orderId,
        customerId,
        pickupDate,
        commodityId,
        currency: readRequiredString(body.currency) ?? "USD",
        lineItems: normalizeLineItems(lineItems),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
    };

    store.set(orderId, order);

    return res.status(existing ? 200 : 201).json(toOrderResponse(order, version));
});

app.get("/api/:version/orders/:orderId", (req: Request, res: Response) => {
    const version = parseVersion(req.params.version);
    if (!version) {
        return invalidVersion(res);
    }

    const orderId = readRequiredString(req.params.orderId);
    if (!orderId) {
        return res.status(400).json({
            error: "validation_error",
            message: "orderId path parameter is required"
        });
    }

    const order = ordersByVersion[version].get(orderId);
    if (!order) {
        return res.status(404).json({
            error: "not_found",
            message: "Order not found"
        });
    }

    return res.status(200).json(toOrderResponse(order, version));
});

app.put("/api/:version/invoices", (req: Request, res: Response) => {
    const version = parseVersion(req.params.version);
    if (!version) {
        return invalidVersion(res);
    }

    const body = req.body as Record<string, unknown>;
    const invoiceId = readRequiredString(body.invoice_ref) ?? readRequiredString(body.invoice_id);
    const customerId = readRequiredString(body.client_id) ?? readRequiredString(body.customer_id);
    const currency = readRequiredString(body.currency);
    const issuedAt = readRequiredString(body.issued_on) ?? readRequiredString(body.issued_at);
    const total = readRequiredNumber(body.total_amount) ?? readRequiredNumber(body.total);
    const notes = readOptionalString(body.notes);

    if (!invoiceId || !customerId || !currency || !issuedAt || total === undefined) {
        return res.status(400).json({
            error: "validation_error",
            message: "Required: invoice_ref, client_id, total_amount, currency, issued_on"
        });
    }

    const record: InvoiceRecord = {
        invoiceId,
        customerId,
        currency,
        total,
        issuedAt,
        notes
    };

    invoicesByVersion[version].set(invoiceId, record);

    return res.status(201).json({
        invoice_ref: record.invoiceId,
        client_id: record.customerId,
        total_amount: record.total,
        currency: record.currency,
        issued_on: record.issuedAt,
        notes: record.notes
    });
});

app.get("/api/:version/invoices/:invoiceId", (req: Request, res: Response) => {
    const version = parseVersion(req.params.version);
    if (!version) {
        return invalidVersion(res);
    }

    const invoiceId = readRequiredString(req.params.invoiceId);
    if (!invoiceId) {
        return res.status(400).json({
            error: "validation_error",
            message: "invoiceId path parameter is required"
        });
    }

    const invoice = invoicesByVersion[version].get(invoiceId);
    if (!invoice) {
        return res.status(404).json({
            error: "not_found",
            message: "Invoice not found"
        });
    }

    return res.status(200).json({
        invoice_ref: invoice.invoiceId,
        client_id: invoice.customerId,
        total_amount: invoice.total,
        currency: invoice.currency,
        issued_on: invoice.issuedAt,
        notes: invoice.notes
    });
});

app.get("/api/:version/expenses/summary", (req: Request, res: Response) => {
    const version = parseVersion(req.params.version);
    if (!version) {
        return invalidVersion(res);
    }

    const customerId = readRequiredString(req.query.customer_ref);
    const month = readRequiredString(req.query.period);

    if (!customerId) {
        return res.status(400).json({
            error: "validation_error",
            message: "customer_ref is required"
        });
    }

    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({
            error: "validation_error",
            message: "period is required and must be YYYY-MM"
        });
    }

    const invoices = [...invoicesByVersion[version].values()]
        .filter((invoice) => invoice.customerId === customerId)
        .filter((invoice) => invoice.issuedAt.startsWith(month));

    const totalAmount = invoices.reduce((sum, invoice) => sum + invoice.total, 0);

    return res.status(200).json({
        customer_ref: customerId,
        period: month,
        invoice_total_count: invoices.length,
        expenses_total: Number(totalAmount.toFixed(2)),
        currency_code: "USD"
    });
});

app.listen(PORT, () => {
    console.log(`Legacy fixture server2 is running on port ${PORT}`);
});

function parseVersion(value: unknown): ApiVersion | null {
    return value === "v1.1" || value === "v1.2" ? value : null;
}

function invalidVersion(res: Response): Response {
    return res.status(404).json({
        error: "not_found",
        message: "Supported versions are v1.1 and v1.2"
    });
}

function validatePreflightToken(
    token: string | undefined,
    customerId: string
): PreflightRecord | undefined {
    if (!token) {
        return undefined;
    }

    const record = preflightTokens.get(token);
    if (!record) {
        return undefined;
    }

    if (record.customerId !== customerId) {
        return undefined;
    }

    if (record.expiresAtMs < Date.now()) {
        preflightTokens.delete(token);
        return undefined;
    }

    return record;
}

function isValidLineItems(value: unknown): value is OrderLineItemInput[] {
    if (!Array.isArray(value) || value.length === 0) {
        return false;
    }

    return value.every((row) => {
        if (!row || typeof row !== "object") {
            return false;
        }

        const item = row as Record<string, unknown>;
        return (
            typeof item.sku === "string" &&
            item.sku.length > 0 &&
            typeof item.qty === "number" &&
            item.qty > 0 &&
            typeof item.unit_price === "number" &&
            item.unit_price >= 0
        );
    });
}

function normalizeLineItems(value: OrderLineItemInput[]): OrderRecord["lineItems"] {
    return value.map((item) => ({
        sku: item.sku,
        quantity: item.qty,
        unitPrice: item.unit_price
    }));
}

function toOrderResponse(order: OrderRecord, version: ApiVersion): Record<string, unknown> {
    return {
        order_id: order.orderId,
        customer_id: order.customerId,
        pickup_date: order.pickupDate,
        ...(version === "v1.1"
            ? { commodity_code_id: order.commodityId }
            : { commodity_id: order.commodityId }),
        currency: order.currency,
        line_items: order.lineItems.map((item) => ({
            sku: item.sku,
            qty: item.quantity,
            unit_price: item.unitPrice
        })),
        created_at: order.createdAt,
        updated_at: order.updatedAt
    };
}

function readRequiredString(value: unknown): string | undefined {
    if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
    }
    return undefined;
}

function readOptionalString(value: unknown): string | undefined {
    if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : undefined;
    }
    return undefined;
}

function readRequiredNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    return undefined;
}

function seedInvoices(): void {
    const initial: InvoiceRecord[] = [
        {
            invoiceId: "inv2_1001",
            customerId: "cust_a",
            total: 860.25,
            currency: "USD",
            issuedAt: "2026-02-02T10:15:00.000Z"
        },
        {
            invoiceId: "inv2_1002",
            customerId: "cust_a",
            total: 215.0,
            currency: "USD",
            issuedAt: "2026-02-21T16:40:00.000Z"
        },
        {
            invoiceId: "inv2_2001",
            customerId: "cust_b",
            total: 510.5,
            currency: "USD",
            issuedAt: "2026-02-12T08:20:00.000Z"
        }
    ];

    (Object.keys(invoicesByVersion) as ApiVersion[]).forEach((version) => {
        const store = invoicesByVersion[version];
        initial.forEach((invoice) => {
            store.set(invoice.invoiceId, { ...invoice });
        });
    });
}
