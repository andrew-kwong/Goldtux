# Stripe Webhook — AWS Lambda Handler

An AWS Lambda function that listens for Stripe webhook events and automates post-payment onboarding for Goldtux customers. On a successful invoice payment, it resolves the customer's GoHighLevel contact, updates their membership record in DynamoDB, generates NFC tag data, and provisions their video storage folder in S3.

---

## Table of Contents

- [Overview](#overview)
- [Stripe Events Handled](#stripe-events-handled)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Configuration](#configuration)
- [DynamoDB Schema](#dynamodb-schema)
- [AWS Resources](#aws-resources)
- [Workflow](#workflow)
- [Functions](#functions)
- [Dependencies](#dependencies)

---

## Overview

This Lambda is triggered by Stripe webhooks via API Gateway. It handles two event types:

- **`invoice.payment_succeeded`** — the core onboarding flow triggered whenever a customer's subscription payment goes through.
- **`balance.available`** — logs the current Goldtux Stripe balance (transfer logic is currently commented out).

All secrets (Stripe API key, Goldtux API key) are stored in AWS Secrets Manager and fetched at runtime.

---

## Stripe Events Handled

| Event | Action |
|---|---|
| `invoice.payment_succeeded` | Resolves GHL contact, updates DynamoDB membership fields, sends NFC payload, creates S3 folder |
| `balance.available` | Logs available balance (optional payout transfer logic is commented out) |
| All others | Logged as unhandled, returns `200 OK` |

---

## Architecture

```
Stripe Webhook
      │
      ▼
AWS API Gateway (HTTP trigger)
      │
      ▼
Lambda Handler (index-2.js)
      │
   ┌──┴───────────────────┐
   │                       │
DynamoDB              External APIs
(GoldtuxCustomers)    ├─ Stripe API
                      ├─ GoHighLevel REST API
                      └─ GHL LeadConnector Webhook

      │
      ▼
   AWS S3
(goldtux-video-insurance)
```

---

## Prerequisites

- Node.js 18.x or later (Lambda runtime)
- AWS account with:
  - A Lambda function with an IAM role granting access to DynamoDB, S3, and Secrets Manager
  - A DynamoDB table named `GoldtuxCustomers`
  - An S3 bucket named `goldtux-video-insurance`
  - Two Secrets Manager secrets (see [Configuration](#configuration))
- A Stripe account with a webhook endpoint pointing to this Lambda's API Gateway URL, subscribed to at least `invoice.payment_succeeded`

---

## Configuration

Two secrets must exist in AWS Secrets Manager (region `us-east-1`):

| Secret Name | Key | Description |
|---|---|---|
| `StripeLive` | `stripe_secret_live` | Stripe live-mode secret API key |
| `GoldtuxKey` | `goldtux_secret` | Goldtux / GoHighLevel Bearer token |

No environment variables or hardcoded credentials are required beyond what Secrets Manager provides.

---

## DynamoDB Schema

**Table name:** `GoldtuxCustomers`  
**Primary key:** `customer_uuid` (String)  
**GSI:** `GHLContactIndex` on `contact_id`

Fields written by this Lambda:

| Attribute | Type | Description |
|---|---|---|
| `stripe_transaction_id` | String | Stripe event ID from the payment event |
| `stripe_id` | String | Stripe customer ID (`cus_...`) |
| `current_membership_status` | String | Plan nickname or `"Goldtux Platinum - Lifetime Individual Membership"` for free trials |
| `subscription_id` | String | Stripe subscription ID |

Fields read by this Lambda:

| Attribute | Type | Description |
|---|---|---|
| `customer_uuid` | String | Primary key, looked up via GSI |
| `subscription_id` | String | Checked for existence to prevent duplicate onboarding |

---

## AWS Resources

| Resource | Name | Purpose |
|---|---|---|
| DynamoDB Table | `GoldtuxCustomers` | Customer record storage |
| DynamoDB GSI | `GHLContactIndex` | Lookup by `contact_id` |
| S3 Bucket | `goldtux-video-insurance` | Per-customer video storage |
| S3 Key Pattern | `customers/{ghl_contact_id}/` | Folder provisioned on first payment |
| Secrets Manager | `StripeLive` | Stripe live API key |
| Secrets Manager | `GoldtuxKey` | Goldtux/GHL API key |

---

## Workflow

The `invoice.payment_succeeded` flow only runs the full onboarding sequence if the customer does **not** already have a `subscription_id` in DynamoDB, preventing duplicate processing on renewal payments.

```
Stripe fires invoice.payment_succeeded
        │
        ▼
Fetch customer email + phone from event payload
        │
        ▼
Look up GHL contact ID via GoHighLevel /contacts/lookup
        │
        ▼
Query DynamoDB GSI (GHLContactIndex) → resolve customer_uuid
        │
        ▼
Check if subscription_id already exists in DynamoDB
        │
   ┌────┴──────────────────────────────────┐
   │ First payment (no subscription_id)    │ Renewal (skip)
   ▼                                       ▼
Generate NFC payload                    Return 200 OK
        │
        ▼
POST NFC payload to GHL LeadConnector webhook
        │
        ▼
Update DynamoDB with:
  stripe_transaction_id, stripe_id,
  current_membership_status, subscription_id
        │
        ▼
Create S3 folder: customers/{ghl_contact_id}/
  (skipped if folder already exists)
        │
        ▼
Return 200 OK
```

### Membership Status Logic

| Stripe description | `current_membership_status` value |
|---|---|
| `"Free Trial"` | `"Goldtux Platinum - Lifetime Individual Membership"` |
| Anything else | Plan nickname from `lines.data[0].plan.nickname` |

---

## Functions

| Function | Description |
|---|---|
| `handler(event)` | Main Lambda entry point. Parses the Stripe event and routes by type. |
| `getStripeSecret()` | Fetches the Stripe live API key from Secrets Manager (`StripeLive`). |
| `getGoldtuxSecret()` | Fetches the Goldtux Bearer token from Secrets Manager (`GoldtuxKey`). |
| `getHighlevelContactId(email, phone, key)` | Calls the GHL `/contacts/lookup` endpoint to resolve a contact ID by email and phone. |
| `findByContactId(contact_id)` | Queries DynamoDB via the `GHLContactIndex` GSI to find a customer record. |
| `getItem(customer_uuid)` | Fetches a full customer record from DynamoDB by primary key. |
| `updateItemFields(...)` | Updates `stripe_transaction_id`, `stripe_id`, `current_membership_status`, and `subscription_id` on a customer record. |
| `generateNfcData(...)` | Builds and returns a JSON string payload containing customer data for NFC tag provisioning. |
| `storeCustomerInfo(...)` | Builds a customer info payload object (currently defined but not called in the handler). |
| `createUniqueS3Folder(customerID)` | Checks for and creates a `customers/{id}/` folder in the S3 bucket if it doesn't already exist. |
| `sendNFCPayload(payload, key)` | POSTs the NFC payload to the GHL LeadConnector webhook. |

---

## Dependencies

```json
{
  "axios": "^1.x",
  "aws-sdk": "^2.x",
  "@aws-sdk/client-secrets-manager": "^3.x",
  "stripe": "^14.x"
}
```

Install with:

```bash
npm install
```
