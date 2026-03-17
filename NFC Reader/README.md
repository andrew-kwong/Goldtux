# NFC Upload Utility Tool — Goldtux

A Python command-line utility that reads customer data from NFC tags, verifies membership status via AWS DynamoDB, records a laundry inspection video via webcam, and uploads the footage to an S3 bucket — all in a single automated workflow.

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Prerequisites](#prerequisites)
- [Configuration](#configuration)
- [NFC Tag Format](#nfc-tag-format)
- [AWS Resources](#aws-resources)
- [Usage](#usage)
- [Workflow](#workflow)
- [Functions](#functions)
- [Dependencies](#dependencies)

---

## Overview

This tool is designed for Goldtux laundry service staff. When a customer presents their NFC-enabled tag at drop-off or pickup, the operator scans it to instantly pull up customer details, confirm their active membership, record a video of the laundry items, and upload the recording to secure cloud storage — all without manual data entry.

The UI supports both **English** and **Spanish**.

---

## Features

- 🏷️ Reads NTAG215 NFC tags containing customer identity data
- 🔍 Looks up membership status from DynamoDB in real time
- 🎥 Records a 720p MP4 video via webcam (up to 10 minutes)
- ☁️ Uploads recorded video to a private S3 bucket organized by customer ID
- 🌐 Bilingual interface (English / Español)
- 🔁 Loops continuously — ready for the next customer immediately after each session

---

## Prerequisites

- Python 3.8+
- A compatible USB NFC reader (ACR122U or similar)
- A webcam accessible via OpenCV (`cv2.VideoCapture(0)`)
- AWS credentials with access to:
  - DynamoDB table `GoldtuxCustomers`
  - S3 bucket `goldtux-video-insurance`
- NFC tags programmed in NTAG215 format (see [NFC Tag Format](#nfc-tag-format))

---

## Configuration

AWS credentials are currently set as empty string constants in `main()`:

```python
AWS_PUBLIC = ''   # AWS Access Key ID
AWS_SECRET = ''   # AWS Secret Access Key
```

The credentials are popuulated in `python-dotenv` (the import is already present but commented out).

```bash
# .env example
AWS_PUBLIC=your_access_key_id
AWS_SECRET=your_secret_access_key
```

---

## NFC Tag Format

Each NTAG215 tag must contain a single NDEF text record with comma-separated values in this exact order:

```
stripe_customer_id,ghl_contact_id,first_name,last_name,phone,email
```

**Example:**
```
cus_ABC123,abc456xyz,John,Doe,5551234567,john@example.com
```

The fields map to:

| Position | Field | Description |
|---|---|---|
| 1 | `StripeID` | Stripe customer ID |
| 2 | `HighlevelID` | GoHighLevel contact ID |
| 3 | `FirstName` | Customer first name |
| 4 | `LastName` | Customer last name |
| 5 | `Phone` | Phone number |
| 6 | `Email` | Email address |

---

## AWS Resources

| Resource | Name | Purpose |
|---|---|---|
| DynamoDB Table | `GoldtuxCustomers` | Customer records and membership status |
| DynamoDB GSI | `GHLContactIndex` | Lookup by `contact_id` |
| S3 Bucket | `goldtux-video-insurance` | Video storage |
| S3 Key Pattern | `customers/{ghl_contact_id}/{filename}` | Per-customer video organization |

---

## Usage

```bash
python nfc_reader.py
```

On launch, the tool displays a language selection prompt:

```
Choose your language display by typing in 1 or 2 and hit enter:

1) English
2) Español
```

After selecting a language, the tool enters a continuous loop waiting for NFC tag scans.

---

## Workflow

```
1. Operator launches the script and selects language
        │
2. Script waits for an NFC tag to be scanned
        │
3. Customer data is read from the NTAG215 tag
        │
4. Membership status is fetched from DynamoDB
        │
5. If membership is active:
        │
        ├─ Webcam opens and video recording begins
        │         (up to 10 min, or press Q to stop early)
        │
        ├─ Video saved locally as {LastName},{FirstName}_{timestamp}.mp4
        │
        ├─ Video uploaded to S3 under customers/{ghl_contact_id}/
        │
        └─ "Process Completed" message shown → loops back to step 2
```

If the membership status is `None` (customer not found or inactive), the video recording step is skipped.

---

## Functions

| Function | Description |
|---|---|
| `main()` | Entry point. Handles language selection and the main scan-record-upload loop. |
| `on_connect(tag)` | NFC callback. Reads NDEF records from an NTAG215 tag and populates `tag_info`. |
| `find_membership_status_by_contact_id(contact_id, access_key, secret_key)` | Queries DynamoDB by GHL contact ID and returns the `current_membership_status` field. |
| `record_video(first_name, last_name, ghl_id, lang_select)` | Opens the webcam, records video at 1280×720 @ 30fps, and saves it as an MP4. Returns the filename. |
| `upload_video_to_s3(video_file_path, customer_id, access_key, secret_key)` | Uploads a local video file to the `goldtux-video-insurance` S3 bucket under the customer's folder. |

---

## Dependencies

```txt
nfcpy
opencv-python
boto3
python-dotenv  # optional, for .env support
```

Install with:

```bash
pip install nfcpy opencv-python boto3 python-dotenv
```

> **Note:** `nfcpy` may require additional system-level drivers for your NFC reader. On Windows, [Zadig](https://zadig.akeo.ie/) is commonly used to install the WinUSB driver for ACR122U readers.
