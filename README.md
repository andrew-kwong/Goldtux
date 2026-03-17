# Goldtux — Backend & Operations System

A full-stack backend system powering Goldtux's laundry service platform. It integrates Stripe payments, GoHighLevel (GHL) CRM, AWS DynamoDB, S3, and NFC hardware to automate the entire customer lifecycle — from subscription signup to laundry pickup, delivery scheduling, and video documentation.

---

## Table of Contents

- [System Overview](#system-overview)
- [Components](#components)
- [Architecture](#architecture)
- [AWS Infrastructure](#aws-infrastructure)
- [Customer Lifecycle](#customer-lifecycle)
- [Setup & Configuration](#setup--configuration)
- [Dependencies](#dependencies)

---

## System Overview

The Goldtux system is composed of three interconnected components:

| File | Type | Role |
|---|---|---|
| `index-2.js` | AWS Lambda | Stripe webhook handler — processes payments and triggers new member onboarding |
| `index.js` | AWS Lambda | GoHighLevel webhook handler — manages scheduling, appointments, and CRM pipeline events |
| `nfc_reader.py` | Python CLI | On-site staff tool — scans NFC tags, verifies membership, records and uploads laundry videos |

Together, these components automate the full customer journey from first payment through recurring pickup and delivery scheduling, with on-site video documentation at each service visit.

---

## Components

### 1. `index-2.js` — Stripe Payment Lambda

Triggered by Stripe webhook events. Handles new customer onboarding when a subscription payment succeeds:

- Fetches the GoHighLevel contact ID by email/phone
- Writes membership status, Stripe IDs, and subscription data to DynamoDB
- Generates and sends NFC tag provisioning data to GHL
- Creates a dedicated S3 folder for the customer's video storage

**Key Stripe event:** `invoice.payment_succeeded`

---

### 2. `index.js` — GoHighLevel Workflow Lambda

Triggered by GoHighLevel CRM workflow webhooks. Routes logic based on the `workflow.name` field:

| Workflow | Action |
|---|---|
| `Developers - Contact Created` | Creates a new DynamoDB customer record with a UUID |
| `Contact Changed` | Looks up an existing customer by GHL contact ID |
| `Developers - Pickup & Delivery Scheduled` | Calculates next pickup/delivery dates, books or updates GHL calendar appointments |
| `Developers - Pipeline Stage Changed - Customer Won` | Re-schedules appointments using stored recurring schedule |
| `Developers - Bad Pickup Good Delivery` | Handles edge-case rescheduling when only the pickup slot was invalid |

All requests are authenticated via `Authorization` and `Host` header validation.

---

### 3. `nfc_reader.py` — On-Site NFC Staff Tool

A bilingual (English/Spanish) command-line application for Goldtux staff. Run at the point of service:

- Scans an NTAG215 NFC tag on the customer's laundry bag
- Reads customer identity data (name, email, phone, Stripe ID, GHL ID)
- Verifies active membership status via DynamoDB
- Records a 720p MP4 video of the laundry items (up to 10 minutes)
- Uploads the video to the customer's S3 folder
- Loops continuously for the next customer

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      CUSTOMER SIGNUP                      │
│  Stripe Payment → index-2.js Lambda                      │
│  • Writes membership to DynamoDB                         │
│  • Sends NFC provisioning data to GHL                    │
│  • Creates S3 video folder                               │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│                    CRM & SCHEDULING                       │
│  GHL Workflow → index.js Lambda                          │
│  • Creates/updates customer records in DynamoDB          │
│  • Books pickup & delivery appointments via GHL API      │
│  • Sends scheduling notifications via GHL webhooks       │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│                   ON-SITE OPERATIONS                      │
│  Staff runs nfc_reader.py                                │
│  • Scans NFC tag → reads customer identity               │
│  • Verifies membership in DynamoDB                       │
│  • Records laundry video → uploads to S3                 │
└─────────────────────────────────────────────────────────┘
```

---

## AWS Infrastructure

| Resource | Name | Used By |
|---|---|---|
| DynamoDB Table | `GoldtuxCustomers` | All three components |
| DynamoDB GSI | `GHLContactIndex` (on `contact_id`) | All three components |
| S3 Bucket | `goldtux-video-insurance` | `index-2.js`, `nfc_reader.py` |
| S3 Key Pattern | `customers/{ghl_contact_id}/` | `index-2.js`, `nfc_reader.py` |
| Secrets Manager | `StripeLive` → `stripe_secret_live` | `index-2.js` |
| Secrets Manager | `GoldtuxKey` → `goldtux_secret` | `index.js`, `index-2.js` |
| AWS Region | `us-east-1` | All three components |

### DynamoDB Customer Record

Key fields stored across all components:

| Field | Set By | Description |
|---|---|---|
| `customer_uuid` | `index.js` | Primary key (UUID v4) |
| `contact_id` | `index.js` | GoHighLevel contact ID (GSI key) |
| `stripe_id` | `index-2.js` | Stripe customer ID |
| `stripe_transaction_id` | `index-2.js` | Stripe event ID |
| `subscription_id` | `index-2.js` | Stripe subscription ID |
| `current_membership_status` | `index-2.js` | Active plan name |
| `pickup_day` / `pickup_time` | `index.js` | Recurring pickup schedule |
| `delivery_day` / `delivery_time` | `index.js` | Recurring delivery schedule |
| `pickup_appointment_id` | `index.js` | GHL calendar appointment ID |
| `delivery_appointment_id` | `index.js` | GHL calendar appointment ID |

---

## Customer Lifecycle

```
1. Customer signs up and pays via Stripe
        │
        ▼
2. index-2.js processes invoice.payment_succeeded
   → Resolves GHL contact ID
   → Updates DynamoDB with membership & Stripe fields
   → Sends NFC provisioning payload to GHL
   → Creates S3 folder for video storage
        │
        ▼
3. GHL workflow fires "Developers - Contact Created"
   → index.js creates DynamoDB record with UUID
        │
        ▼
4. GHL workflow fires "Developers - Pickup & Delivery Scheduled"
   → index.js calculates next pickup/delivery dates
   → Books appointments on GHL calendars
   → Saves schedule to DynamoDB
        │
        ▼
5. Customer arrives for service
   → Staff scans NFC tag with nfc_reader.py
   → Membership verified via DynamoDB
   → Laundry video recorded and uploaded to S3
        │
        ▼
6. On renewal / pipeline changes
   → index.js re-schedules appointments as needed
   → Sends notification webhooks to customer via GHL
```

---

## Setup & Configuration

### Lambda Functions (`index.js`, `index-2.js`)

Both functions require the following to be configured before deployment:

**`index.js`** — set directly in the file:
```javascript
const authHeader = ''  // Expected Authorization header value
const hostHeader = ''  // Expected Host header value
const secret_name = '' // Secrets Manager secret name for GoldtuxKey
```

**`index-2.js`** — uses named Secrets Manager secrets:
- `StripeLive` containing `{ "stripe_secret_live": "sk_live_..." }`
- `GoldtuxKey` containing `{ "goldtux_secret": "..." }`

**IAM Role** — the Lambda execution role must have permissions for:
- `dynamodb:Query`, `dynamodb:GetItem`, `dynamodb:PutItem`, `dynamodb:UpdateItem`
- `s3:ListBucket`, `s3:PutObject`
- `secretsmanager:GetSecretValue`

### NFC Reader (`nfc_reader.py`)

Set AWS credentials directly in `main()`:
```python
AWS_PUBLIC = ''  # AWS Access Key ID
AWS_SECRET = ''  # AWS Secret Access Key
```

Alternatively, use a `.env` file (the `python-dotenv` import is already present but commented out).

---

## Dependencies

### Lambda Functions (Node.js)

```json
{
  "axios": "^1.x",
  "aws-sdk": "^2.x",
  "@aws-sdk/client-secrets-manager": "^3.x",
  "stripe": "^14.x",
  "uuid": "^9.x",
  "luxon": "^3.x"
}
```

```bash
npm install
```

### NFC Reader (Python)

```txt
nfcpy
opencv-python
boto3
python-dotenv
```

```bash
pip install nfcpy opencv-python boto3 python-dotenv
```

> **Note:** `nfcpy` requires system-level USB drivers for the NFC reader. On Windows, use [Zadig](https://zadig.akeo.ie/) to install the WinUSB driver for ACR122U readers.
