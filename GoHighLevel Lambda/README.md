# GoHighLevel Webhook — AWS Lambda Handler

An AWS Lambda function that receives and processes webhook events from [GoHighLevel (GHL)](https://www.gohighlevel.com/) / LeadConnector. It manages customer records in DynamoDB and orchestrates pickup & delivery appointment scheduling via the GHL and Goldtux APIs.

---

## Table of Contents

- [Overview](#overview)
- [Workflow Types](#workflow-types)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Environment & Configuration](#environment--configuration)
- [DynamoDB Schema](#dynamodb-schema)
- [Scheduling Logic](#scheduling-logic)
- [Webhook Notifications](#webhook-notifications)
- [Helper Functions](#helper-functions)
- [Error Handling](#error-handling)
- [Dependencies](#dependencies)

---

## Overview

This Lambda function acts as the backend processor for a GoHighLevel CRM integration. It:

1. Authenticates incoming webhook requests via `Authorization` and `Host` headers.
2. Routes processing logic based on the `workflow.name` field in the webhook payload.
3. Stores and updates customer records in a DynamoDB table (`GoldtuxCustomers`).
4. Calculates and books recurring pickup and delivery appointments through the GHL appointments API.
5. Sends notification webhooks back to GHL when scheduling succeeds, fails, or requires customer action.

---

## Workflow Types

The handler branches on `parsedBody.workflow.name` and supports the following workflows:

| Workflow Name | Description |
|---|---|
| `Developers - Contact Created` | Creates a new customer record in DynamoDB with a generated UUID. |
| `Contact Changed` | Looks up an existing customer record by GHL contact ID. |
| `Developers - Pickup & Delivery Scheduled` | Calculates the next available pickup and delivery dates, creates or updates GHL appointments, and saves scheduling data to DynamoDB. |
| `Developers - Pipeline Stage Changed - Customer Won` | Re-schedules existing pickup and delivery appointments using the stored recurring schedule. |
| `Developers - Bad Pickup Good Delivery` | Handles the edge case where only the pickup slot was invalid; re-attempts pickup booking while updating the delivery appointment. |

---

## Architecture

```
GoHighLevel Workflow
        │
        ▼
AWS API Gateway (HTTP trigger)
        │
        ▼
Lambda Handler (index.js)
        │
   ┌────┴────┐
   │         │
DynamoDB    GHL / Goldtux APIs
(GoldtuxCustomers)   (Appointments + Webhooks)
```

**AWS Services used:**
- **AWS Lambda** — function runtime
- **Amazon DynamoDB** — customer record persistence
- **AWS Secrets Manager** — secure storage for the Goldtux API key

---

## Prerequisites

- Node.js 18.x or later (Lambda runtime)
- AWS account with:
  - A Lambda function configured with the appropriate IAM role
  - A DynamoDB table named `GoldtuxCustomers`
  - A Secrets Manager secret containing `{ "goldtux_secret": "<API_KEY>" }`
- A GoHighLevel account with configured workflows and webhooks pointing to this Lambda's API Gateway URL

---

## Environment & Configuration

The following constants must be set directly in `index.js` before deployment (or moved to environment variables):

| Constant | Description |
|---|---|
| `authHeader` | Expected `Authorization` header value for request validation |
| `hostHeader` | Expected `Host` header value for request validation |
| `secret_name` | The AWS Secrets Manager secret name containing the Goldtux API key |
| `region` | AWS region (default: `us-east-1`) |

> **Note:** For production use, it is strongly recommended to move `authHeader` and `hostHeader` to AWS Secrets Manager or Lambda environment variables rather than hardcoding them.

---

## DynamoDB Schema

**Table name:** `GoldtuxCustomers`  
**Primary key:** `customer_uuid` (String, UUID v4)  
**GSI:** `GHLContactIndex` on `contact_id` — used to look up records by GHL contact ID

| Attribute | Type | Description |
|---|---|---|
| `customer_uuid` | String | Primary key, UUID v4 |
| `contact_id` | String | GoHighLevel contact ID (GSI key) |
| `email` | String | Customer email address |
| `pickup_day` | Number | Day of week (1=Mon … 7=Sun) for recurring pickup |
| `pickup_time` | Number | Hour (24h) for recurring pickup |
| `delivery_day` | Number | Day of week for recurring delivery |
| `delivery_time` | Number | Hour (24h) for recurring delivery |
| `pickup_appointment_id` | String | GHL appointment ID for the pickup slot |
| `delivery_appointment_id` | String | GHL appointment ID for the delivery slot |

---

## Scheduling Logic

### Pickup Date (`getNextDatePickup`)
- Finds the next upcoming occurrence of the configured weekday and hour (Eastern Time).
- If the next occurrence is within **27 hours**, it is skipped to the following week and a `pickupDateFlag = false` is returned to signal the near-miss condition.

### Delivery Date (`getNextDateDelivery`)
- Calculated relative to the confirmed pickup date.
- If the delivery slot falls within **33 hours** of the pickup, it is considered invalid and `-1` is returned.

### Appointment Booking
- If a `pickup_appointment_id` or `delivery_appointment_id` already exists in DynamoDB, a **PUT** request is issued to update the existing GHL appointment.
- If no appointment ID exists, a **POST** request creates a new appointment and the returned ID is saved back to DynamoDB.

**Calendar IDs:**
| Calendar | ID |
|---|---|
| Pickup | `PO5Ut3fBdLrCB5psILte` |
| Delivery | `qbSmbkHVcUEw40G8oCBl` |

---

## Webhook Notifications

The function fires outbound webhooks to GoHighLevel LeadConnector to notify customers of scheduling outcomes:

| Scenario | Function |
|---|---|
| Pickup OK, Delivery invalid | `sendGoodPickupBadDelivery` |
| Pickup invalid, Delivery OK | `sendBadPickupGoodDelivery` |
| Both Pickup and Delivery invalid | `sendBadPickupBadDelivery` |
| Pickup appointment booking error | `sendPickupErrorWebhook` |
| Delivery appointment booking error | `sendDeliveryErrorWebhook` |
| Successful scheduling confirmation | `sendConfirmationEmail` |

All outbound webhooks POST to `https://services.leadconnectorhq.com/hooks/...` with a Bearer token from Secrets Manager.

---

## Helper Functions

| Function | Description |
|---|---|
| `getGoldtuxSecret()` | Retrieves the Goldtux API key from AWS Secrets Manager |
| `saveToDynamoDB(item)` | Inserts a new customer item into DynamoDB |
| `findByContactId(contact_id)` | Queries DynamoDB by GHL contact ID using the GSI |
| `getItem(customer_uuid)` | Fetches a single customer record by primary key |
| `updateItemWithPickupAppointmentId(...)` | Stores the pickup appointment ID on the customer record |
| `updateItemWithDeliveryAppointmentId(...)` | Stores the delivery appointment ID on the customer record |
| `updateItemWithPickupDeliveryDate(...)` | Persists the recurring pickup/delivery day and time values |
| `sendAppointmentPostRequest(payload, key)` | Creates a new GHL appointment via POST |
| `sendAppointmentPutRequest(id, payload, key)` | Updates an existing GHL appointment via PUT |
| `extractAndConvertTime(str)` | Parses a time string (e.g. `"9am"`, `"2pm"`) and returns a 24h hour integer |
| `getDayNumber(day)` | Maps a day name (e.g. `"Monday"`) to its Luxon weekday number (1–7) |

---

## Error Handling

- All external API calls (GHL, Goldtux webhooks) return `-1` on failure and log the error to CloudWatch.
- Invalid `Authorization` or `Host` headers result in a `403 Forbidden` response with no processing.
- Successful processing returns `200 OK` with `"Successful!"`.

---

## Dependencies

```json
{
  "uuid": "^9.x",
  "axios": "^1.x",
  "aws-sdk": "^2.x",
  "@aws-sdk/client-secrets-manager": "^3.x",
  "luxon": "^3.x"
}
```

Install with:

```bash
npm install
```
