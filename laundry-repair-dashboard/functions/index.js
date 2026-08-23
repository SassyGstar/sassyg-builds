/**
 * 24 Hour Laundry Equipment — QuickBooks Online integration
 * Firebase Cloud Functions (Node 20, firebase-functions v2)
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The Intuit client secret and the OAuth refresh token can never live in the
 * browser. Every QuickBooks call the dashboard makes lands here first: this
 * process holds the credentials, attaches the access token, and talks to Intuit.
 * The front end never sees a token. If someone proposes calling the Intuit API
 * directly from React to "keep it simple", that is a security failure and a
 * rework three months later.
 *
 * SECRETS (set once, never committed):
 *   firebase functions:secrets:set QBO_CLIENT_ID
 *   firebase functions:secrets:set QBO_CLIENT_SECRET
 *   firebase functions:secrets:set QBO_REDIRECT_URI
 *
 * The refresh token lives in Firestore at  integrations/quickbooks  under rules
 * that deny every client read. Only this service account can see it.
 */

const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

const QBO_CLIENT_ID     = defineSecret("QBO_CLIENT_ID");
const QBO_CLIENT_SECRET = defineSecret("QBO_CLIENT_SECRET");
const QBO_REDIRECT_URI  = defineSecret("QBO_REDIRECT_URI");

// Sandbox until the invoice push has been verified end to end at least twenty
// times. Flip via the environment, never by editing this line under pressure.
const USE_SANDBOX = process.env.QBO_ENV !== "production";
const API_BASE = USE_SANDBOX
  ? "https://sandbox-quickbooks.api.intuit.com"
  : "https://quickbooks.api.intuit.com";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const MINOR_VERSION = "75";

const TOKEN_DOC = db.collection("integrations").doc("quickbooks");

/* ------------------------------------------------------------------ tokens */

async function readTokens() {
  const snap = await TOKEN_DOC.get();
  if (!snap.exists) throw new Error("QuickBooks is not connected. Run the /qboConnect flow first.");
  return snap.data();
}

async function writeTokens(patch) {
  await TOKEN_DOC.set(
    { ...patch, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
}

function basicAuth(id, secret) {
  return "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
}

/**
 * Exchange a refresh token for a new access token.
 *
 * Intuit rotates the refresh token on most refreshes, so whatever comes back
 * MUST be written down. Losing the rotated token is the single most common way
 * these integrations quietly die.
 */
async function refreshAccessToken() {
  const tokens = await readTokens();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuth(QBO_CLIENT_ID.value(), QBO_CLIENT_SECRET.value()),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    // A dead refresh token needs a human to reauthorize. Say so loudly rather
    // than retrying into the void.
    await writeTokens({ lastError: body, healthy: false });
    throw new Error(
      `QuickBooks refused the refresh (${res.status}). ` +
      `If this says invalid_grant the refresh token is dead and someone has to ` +
      `reauthorize at /qboConnect.`
    );
  }
  await writeTokens({
    accessToken: body.access_token,
    refreshToken: body.refresh_token || tokens.refreshToken,
    accessTokenExpiresAt: Date.now() + body.expires_in * 1000,
    refreshTokenRefreshedAt: Date.now(),
    healthy: true,
    lastError: null,
  });
  return body.access_token;
}

async function getAccessToken() {
  const tokens = await readTokens();
  // Refresh a minute early rather than discovering expiry mid-invoice.
  if (!tokens.accessToken || Date.now() > (tokens.accessTokenExpiresAt || 0) - 60_000) {
    return refreshAccessToken();
  }
  return tokens.accessToken;
}

/* ------------------------------------------------------- Intuit API helper */

async function qboFetch(path, options = {}, attempt = 0) {
  const tokens = await readTokens();
  const accessToken = await getAccessToken();
  const url = `${API_BASE}/v3/company/${tokens.realmId}${path}` +
    (path.includes("?") ? "&" : "?") + `minorversion=${MINOR_VERSION}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  // Intuit throttles per minute per company. Back off exponentially; do not
  // hammer, and do not silently give up either.
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    const wait = Math.min(16_000, 500 * 2 ** attempt);
    await new Promise((r) => setTimeout(r, wait));
    return qboFetch(path, options, attempt + 1);
  }
  if (res.status === 401 && attempt < 1) {
    await refreshAccessToken();
    return qboFetch(path, options, attempt + 1);
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Intuit's errors are specific and actionable ("Invalid Reference Id",
    // "Object Not Found"). Pass the real message up so the office user can read
    // it instead of a generic failure.
    const fault = body?.Fault?.Error?.[0];
    const err = new Error(
      fault ? `${fault.Message}${fault.Detail ? " — " + fault.Detail : ""}` : `QuickBooks error ${res.status}`
    );
    err.status = res.status;
    err.intuit = body;
    throw err;
  }
  return body;
}

/* ----------------------------------------------------------------- caller  */

/** Verify the Firebase ID token and require an office or owner claim. */
async function requireOfficeUser(req) {
  const header = req.get("Authorization") || "";
  const idToken = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!idToken) throw new HttpsError("unauthenticated", "Sign in first.");
  const decoded = await admin.auth().verifyIdToken(idToken);
  const role = decoded.role;
  if (role !== "office" && role !== "owner") {
    // Technicians must never reach the money endpoints, and hiding the buttons
    // in the interface is not a control.
    throw new HttpsError("permission-denied", "Invoicing is limited to office and owner accounts.");
  }
  return decoded;
}

function sendError(res, e) {
  const status = e instanceof HttpsError ? 403 : (e.status || 500);
  res.status(status).json({ message: e.message, intuit: e.intuit || null });
}

const CORS = (res) => {
  res.set("Access-Control-Allow-Origin", process.env.APP_ORIGIN || "*");
  res.set("Access-Control-Allow-Headers", "Authorization,Content-Type");
  res.set("Access-Control-Allow-Methods", "POST,OPTIONS");
};

const withSecrets = { secrets: [QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REDIRECT_URI] };

/* ------------------------------------------------------------ OAuth set-up */

/** Step 1 — send the owner to Intuit to authorize. Open this in a browser. */
exports.qboConnect = onRequest(withSecrets, (req, res) => {
  const state = Math.random().toString(36).slice(2);
  const url =
    "https://appcenter.intuit.com/connect/oauth2?" +
    new URLSearchParams({
      client_id: QBO_CLIENT_ID.value(),
      response_type: "code",
      scope: "com.intuit.quickbooks.accounting",
      redirect_uri: QBO_REDIRECT_URI.value(),
      state,
    });
  res.redirect(url);
});

/** Step 2 — Intuit redirects back here with the authorization code. */
exports.qboCallback = onRequest(withSecrets, async (req, res) => {
  try {
    const { code, realmId } = req.query;
    if (!code || !realmId) throw new Error("Intuit did not return a code and realmId.");
    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: basicAuth(QBO_CLIENT_ID.value(), QBO_CLIENT_SECRET.value()),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: String(code),
        redirect_uri: QBO_REDIRECT_URI.value(),
      }),
    });
    const body = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(JSON.stringify(body));
    await writeTokens({
      realmId: String(realmId),
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      accessTokenExpiresAt: Date.now() + body.expires_in * 1000,
      refreshTokenRefreshedAt: Date.now(),
      environment: USE_SANDBOX ? "sandbox" : "production",
      healthy: true,
    });
    res.send(
      `<h2>QuickBooks connected</h2><p>Company ${realmId} (${USE_SANDBOX ? "sandbox" : "production"}).` +
      ` You can close this window.</p>`
    );
  } catch (e) {
    res.status(500).send("Could not connect to QuickBooks: " + e.message);
  }
});

/**
 * Keep the refresh token alive.
 *
 * A refresh token expires after 100 days of disuse. A quiet business over the
 * holidays is enough to kill it, and then invoicing simply stops working one
 * morning with no warning. Refresh proactively instead of waiting for failure.
 */
exports.qboKeepAlive = onSchedule(
  { schedule: "every 24 hours", ...withSecrets },
  async () => {
    try {
      await refreshAccessToken();
      console.log("QuickBooks token refreshed.");
    } catch (e) {
      console.error("QuickBooks token refresh FAILED — invoicing will break:", e.message);
      await writeTokens({ healthy: false, lastError: e.message });
    }
  }
);

/* --------------------------------------------------------------- endpoints */

/**
 * Create an invoice from a completed work order.
 *
 * Validation runs on the client so the office can see and fix problems before
 * anything is sent, and again here because a client-side check is a courtesy,
 * not a control.
 */
exports.qboCreateInvoice = onRequest(withSecrets, async (req, res) => {
  CORS(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  try {
    const user = await requireOfficeUser(req);
    const { workOrderId, invoice } = req.body || {};
    if (!workOrderId || !invoice) throw new Error("workOrderId and invoice are both required.");

    const woRef = db.collection("workOrders").doc(workOrderId);
    const wo = (await woRef.get()).data();
    if (!wo) throw new Error("Work order not found.");
    if (wo.qboInvoiceId) throw new Error(`${workOrderId} was already invoiced as #${wo.qboInvoiceDocNumber}.`);
    if (wo.status !== "complete") throw new Error("Only completed work orders can be invoiced.");
    if (wo.warrantyClaim && !wo.warrantyDisposition) {
      throw new Error("This is a warranty claim with no decision recorded about who pays. Resolve that first.");
    }
    if (!invoice.CustomerRef?.value) throw new Error("No QuickBooks customer on this invoice.");
    for (const line of invoice.Line || []) {
      if (!line.SalesItemLineDetail?.ItemRef?.value) {
        throw new Error(`Invoice line "${line.Description || ""}" has no QuickBooks item reference.`);
      }
    }

    const created = await qboFetch("/invoice", { method: "POST", body: JSON.stringify(invoice) });
    const inv = created.Invoice;

    await woRef.update({
      qboInvoiceId: inv.Id,
      qboInvoiceDocNumber: inv.DocNumber,
      qboPushedAt: admin.firestore.FieldValue.serverTimestamp(),
      qboPushedBy: user.uid,
      status: "invoiced",
    });

    res.json({ invoiceId: inv.Id, docNumber: inv.DocNumber, total: inv.TotalAmt });
  } catch (e) {
    // No silent retry. The office user reads the real reason and fixes it.
    sendError(res, e);
  }
});

/**
 * Create a customer in QuickBooks and hand back the ID.
 *
 * Identity flows one way only: QuickBooks issues the ID, the dashboard stores
 * it. Never the reverse. This is what prevents the duplicate-customer mess that
 * kills these integrations.
 */
exports.qboCreateCustomer = onRequest(withSecrets, async (req, res) => {
  CORS(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  try {
    await requireOfficeUser(req);
    const { customerId } = req.body || {};
    const ref = db.collection("customers").doc(customerId);
    const c = (await ref.get()).data();
    if (!c) throw new Error("Customer not found.");
    if (c.qboCustomerId) throw new Error("This customer already exists in QuickBooks.");

    // Guard against creating a near-duplicate of an existing QuickBooks record.
    const escaped = c.companyName.replace(/'/g, "\\'");
    const existing = await qboFetch(
      `/query?query=${encodeURIComponent(`select * from Customer where DisplayName = '${escaped}'`)}`
    );
    if (existing.QueryResponse?.Customer?.length) {
      const found = existing.QueryResponse.Customer[0];
      await ref.update({ qboCustomerId: found.Id });
      return res.json({ qboCustomerId: found.Id, matchedExisting: true });
    }

    const created = await qboFetch("/customer", {
      method: "POST",
      body: JSON.stringify({
        DisplayName: c.companyName,
        CompanyName: c.companyName,
        PrimaryEmailAddr: c.email ? { Address: c.email } : undefined,
        PrimaryPhone: c.phone ? { FreeFormNumber: c.phone } : undefined,
        BillAddr: c.billingAddress ? { Line1: c.billingAddress } : undefined,
      }),
    });
    await ref.update({ qboCustomerId: created.Customer.Id });
    res.json({ qboCustomerId: created.Customer.Id });
  } catch (e) {
    sendError(res, e);
  }
});

/**
 * Open receivables for the aging panel.
 *
 * Polling, not webhooks. Polling is far simpler and thirty minutes of staleness
 * has never lost anyone a payment. Move to webhooks only if freshness becomes a
 * real complaint from a real person.
 */
exports.qboOpenInvoices = onRequest(withSecrets, async (req, res) => {
  CORS(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  try {
    await requireOfficeUser(req);
    const cached = await db.collection("cache").doc("qboOpenInvoices").get();
    const data = cached.data();
    // Cache aggressively: the customer and item lists especially should not be
    // refetched on every page load, or the rate limit will find you.
    if (data && Date.now() - data.fetchedAt < 15 * 60_000) {
      return res.json({ invoices: data.invoices, cached: true });
    }
    const q = "select * from Invoice where Balance > '0' maxresults 1000";
    const out = await qboFetch(`/query?query=${encodeURIComponent(q)}`);
    const invoices = (out.QueryResponse?.Invoice || []).map((i) => ({
      id: i.Id,
      docNumber: i.DocNumber,
      qboCustomerId: i.CustomerRef?.value,
      txnDate: i.TxnDate,
      dueDate: i.DueDate,
      total: i.TotalAmt,
      balance: i.Balance,
    }));
    await db.collection("cache").doc("qboOpenInvoices")
      .set({ invoices, fetchedAt: Date.now() });
    res.json({ invoices, cached: false });
  } catch (e) {
    sendError(res, e);
  }
});

/** Connection health, for a status light in Settings. */
exports.qboStatus = onRequest(withSecrets, async (req, res) => {
  CORS(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  try {
    await requireOfficeUser(req);
    const t = await readTokens();
    const daysSinceRefresh = (Date.now() - (t.refreshTokenRefreshedAt || 0)) / 86_400_000;
    res.json({
      connected: !!t.refreshToken,
      healthy: t.healthy !== false,
      environment: t.environment,
      realmId: t.realmId,
      daysSinceRefresh: Math.round(daysSinceRefresh),
      // 100 days of disuse kills the refresh token.
      daysUntilRefreshTokenDies: Math.max(0, Math.round(100 - daysSinceRefresh)),
      lastError: t.lastError || null,
    });
  } catch (e) {
    sendError(res, e);
  }
});

/** Grant a role. Run once per person; roles are claims, not database rows. */
exports.setUserRole = onCall(async (request) => {
  if (request.auth?.token?.role !== "owner") {
    throw new HttpsError("permission-denied", "Only the owner can set roles.");
  }
  const { uid, role } = request.data;
  if (!["technician", "office", "owner"].includes(role)) {
    throw new HttpsError("invalid-argument", "Unknown role.");
  }
  await admin.auth().setCustomUserClaims(uid, { role });
  return { ok: true };
});
