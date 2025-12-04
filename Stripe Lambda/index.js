const axios = require('axios')
const AWS = require('aws-sdk')
const dynamoDB = new AWS.DynamoDB.DocumentClient();

const s3 = new AWS.S3()
AWS.config.update({ region: 'us-east-1' })

const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
const secret_stripe_name = "StripeLive";
const secret_goldtux_name = "GoldtuxKey"
const region = "us-east-1";  
const client = new SecretsManagerClient({ region });


exports.handler = async (event) => {

  const stripe_secret = await getStripeSecret()
  const stripeSecrets = JSON.parse(stripe_secret)
  const stripeApiKey = stripeSecrets['stripe_secret_live']
  const STRIPE_KEY = require('stripe')(stripeApiKey);

  const goldtux_secret = await getGoldtuxSecret()
  const goldtuxSecrets = JSON.parse(goldtux_secret)
  const GOLDTUX_KEY = goldtuxSecrets['goldtux_secret']

  console.log('event', event)
  let stripeEvent = JSON.parse(event.body)


  switch (stripeEvent.type) {
    case 'invoice.payment_succeeded':
      console.log('Invoice Payment Triggered')
      console.log(stripeEvent.data.object)
      const stripe_transaction_id = stripeEvent.id
      const customerID = stripeEvent.data.object.customer
      const customerName = stripeEvent.data.object.customer_name
      const customerEmail = stripeEvent.data.object.customer_email
      const customerPhone = stripeEvent.data.object.customer_phone
      const description = stripeEvent.data.object.lines.data[0].description
      let currentMembershipStatus = ''
      console.log('data payload: ', description)

      if (description === 'Free Trial') {
        currentMembershipStatus = 'Goldtux Platinum - Lifetime Individual Membership'
      }
      else {
        currentMembershipStatus = stripeEvent.data.object.lines.data[0].plan.nickname
      }


      const subscriptionID = stripeEvent.data.object.subscription

      const getHighlevelResponse = await getHighlevelContactId(customerEmail, customerPhone, GOLDTUX_KEY)
      console.log('GHL GET RESPONSE', getHighlevelResponse.data.contacts)
      const ghl_contact_id = getHighlevelResponse.data.contacts[0].id
      console.log('highelvelcustomerId', ghl_contact_id)

      const primary_uuid = await findByContactId(ghl_contact_id)
      const customerUuid = primary_uuid[0].customer_uuid;
      console.log('customerUuid ', customerUuid)
      const customerData = await getItem(customerUuid);

      //if subscription ID doesn't exist in the database
      if (!customerData.subscription_id) {

        const orderQuantity = parseInt(stripeEvent.data.object.lines.data[0].quantity)

        let fullName = customerName.split(' ')
        const firstName = fullName[0]
        const lastName = fullName[fullName.length - 1]

        console.log(`CustomerID: ${customerID}`)
        console.log(`Customer Name: ${customerName}`)
        console.log(`Customer Email: ${customerEmail}`)
        console.log(`Customer Phone: ${customerPhone}`)
        console.log(`SubQuantity: ${orderQuantity}`)

        const nfc_payload = generateNfcData(
          customerID,
          firstName,
          lastName,
          customerEmail,
          customerPhone,
          orderQuantity
        )

        //Send NFC data to webhook 
        await sendNFCPayload(nfc_payload, GOLDTUX_KEY)
        //update stripe_transaction_id, stripeID, membership status, and subscriptionID fields
        await updateItemFields(customerUuid, stripe_transaction_id, customerID, currentMembershipStatus, subscriptionID)
        //Check if AWS S3 folder is created and if not creates one
        await createUniqueS3Folder(ghl_contact_id)
      }

      break

    case 'balance.available':
      const balance = stripeEvent.data.object.available[0].amount
      console.log('Goldtux balance:' + balance)
      /* if (balance >= 100) {
        //transfer 50% amount to Maverick Spirit: acct_1LxHKGR7HevGNyDY
        const transferPlotduo = await stripe.transfers.create({
          amount: balance * 0.5,
          currency: 'usd',
          destination: 'acct_1LxHKGR7HevGNyDY',
        })
      } */

      break
    // ... handle other event types
    default:
      console.log(`Unhandled event type ${stripeEvent.type}`)
  }

  const response = {
    statusCode: 200,
    body: JSON.stringify('200 - OK, successful request!'),
  }
  return response
}

async function getStripeSecret() {
  let secretValue;
  try {
    const response = await client.send(new GetSecretValueCommand({ SecretId: secret_stripe_name }));
    secretValue = response.SecretString;
  } catch (error) {
    console.error(error);
    throw error;
  }
  return secretValue;
}

async function getGoldtuxSecret() {
  let secretValue;
  try {
    const response = await client.send(new GetSecretValueCommand({ SecretId: secret_goldtux_name }));
    secretValue = response.SecretString;
  } catch (error) {
    console.error(error);
    throw error;
  }
  return secretValue;
}

async function createUniqueS3Folder(customerID) {
  const bucket = 'goldtux-video-insurance'
  const folderKey = `customers/${customerID}/`

  // Check if the folder exists
  const params = {
    Bucket: bucket,
    Prefix: folderKey
  }
  const response = await s3.listObjectsV2(params).promise()
  if (response.Contents.length > 0) {
    console.log('Folder already exists.')
    return
  }

  // Create a unique folder
  const putParams = {
    Bucket: bucket,
    Key: folderKey,
  }
  await s3.putObject(putParams).promise()
  console.log('Folder created.')
}

async function getHighlevelContactId(email, phone, key) {
  console.log(`Sending Get request with payload:`);
  const getHighLevelId = await axios.get(`https://rest.gohighlevel.com/v1/contacts/lookup?email=${email}&phone=${phone}`,
    {
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      }
    })

  return getHighLevelId;
}

function generateNfcData(id, firstName, lastName, fullEmail, fullPhone, orderQty) {
  const nfcPayload = {
    stripe_id: id,
    first_name: firstName,
    last_name: lastName,
    email: fullEmail,
    phone: fullPhone,
    quantity: orderQty
  }
  console.log('NFC PAYLOAD')
  console.log(JSON.stringify(nfcPayload))
  return JSON.stringify(nfcPayload)
}

function storeCustomerInfo(id, firstName, lastName, fullEmail, fullPhone, productId) {
  const customerPayload = {
    customer_id: id,
    first_name: firstName,
    last_name: lastName,
    email: fullEmail,
    phone: fullPhone,
    product_id: productId
  }
  console.log('Customer PAYLOAD')
  console.log(JSON.stringify(customerPayload))
  return customerPayload
}

async function findByContactId(contact_id) {
  const queryParameters = {
    TableName: 'GoldtuxCustomers',
    IndexName: 'GHLContactIndex',
    KeyConditionExpression: 'contact_id = :contactIdValue',
    ExpressionAttributeValues: {
      ':contactIdValue': contact_id
    }
  };

  try {
    const result = await dynamoDB.query(queryParameters).promise();
    if (result.Items.length === 0) {
      console.log('No matching items found');
      return null;
    } else {
      console.log('Primary key(s) retrieved:', result.Items);
      return result.Items;
    }
  } catch (error) {
    console.error('Error retrieving primary key:', error);
    throw error;
  }
}

async function updateItemFields(customer_uuid, stripe_transaction_id, stripe_id, current_membership_status, subscription_id) {
  const params = {
    TableName: 'GoldtuxCustomers',
    Key: { customer_uuid },
    UpdateExpression: 'SET stripe_transaction_id = :stripe_transaction_id, stripe_id = :stripe_id, current_membership_status = :current_membership_status, subscription_id = :subscription_id',
    ExpressionAttributeValues: {
      ':stripe_transaction_id': stripe_transaction_id,
      ':stripe_id': stripe_id,
      ':current_membership_status': current_membership_status,
      ':subscription_id': subscription_id
    },
    ReturnValues: 'UPDATED_NEW'
  };

  try {
    const result = await dynamoDB.update(params).promise();
    console.log('Item updated successfully:', result);
    console.log('added current_membership_status to database');
    // Handle the result or return it as per your requirement
  } catch (error) {
    console.error('Error updating item:', error);
    // Handle the error appropriately
  }

}

async function getItem(customer_uuid) {
  const params = {
    TableName: 'GoldtuxCustomers',
    Key: { customer_uuid }
  };

  const result = await dynamoDB.get(params).promise();
  return result.Item;
}

async function sendNFCPayload(payload, key) {
  console.log(`Sending POST request with payload:`, payload);
  const pickupResponse = await axios.post('https://services.leadconnectorhq.com/hooks/xh4YUIhuK8hmcqxtL52V/webhook-trigger/ae06b5be-20cf-42ae-bac2-a1939cf77501', payload,
    {
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      }
    })

  return pickupResponse;
}