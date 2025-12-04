const { v4: uuidv4 } = require('uuid')
const axios = require('axios')
const AWS = require('aws-sdk')
const { DateTime } = require('luxon')
const dynamoDB = new AWS.DynamoDB.DocumentClient()
const authHeader = ''
const hostHeader = ''
AWS.config.update({ region: 'us-east-1' })

const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
const secret_name = '';
const region = "us-east-1"; 
const client = new SecretsManagerClient({ region });

exports.handler = async (event) => {
    console.log("************GoHighLevel Webhook ****************************")

    const secret = await getGoldtuxSecret()
    const goldtuxSecrets = JSON.parse(secret)
    const GOLDTUX_KEY = goldtuxSecrets['goldtux_secret']

    console.log(event);
    let parsedBody = JSON.parse(event.body);
    const workflowType = parsedBody.workflow.name
    console.log(parsedBody)
    let authCode = event.headers.Authorization;
    let hostLoc = event.headers.Host;

    if (authCode === authHeader && hostLoc === hostHeader) {
        console.log("JSON BODY")
        console.log(parsedBody)
        const ghl_contact_id = parsedBody.contact_id
        //Created/Update Contact Workflow
        console.log('workflow type: ', workflowType)

        if (workflowType === 'Developers - Contact Created') {
            // Add a unique primary key
            const primaryKey = uuidv4();

            // Prepare the data for DynamoDB
            const item = {
                customer_uuid: primaryKey,
                ...parsedBody
            };

            // Save the data to DynamoDB
            const result = await saveToDynamoDB(item);
            console.log("New Contact added to database!")
        }
        if (workflowType === 'Contact Changed') {
            //Search the contact based on customer ID
            const main_uuid = await findByContactId(ghl_contact_id)

            const uuid_result = main_uuid[0].customer_uuid;
            console.log('customerUuid ', uuid_result)
        }
        if (workflowType === 'Developers - Pickup & Delivery Scheduled') {
            const pickupWindow = parsedBody['Recurring Pickup Window']
            const pickupDay = parsedBody['Recurring Pickup Day']
            const deliveryWindow = parsedBody['Recurring Delivery Window']
            const deliveryDay = parsedBody['Recurring Delivery Day']

            console.log(' Pickup Day', pickupDay)
            console.log('Delivery Day', deliveryDay)
            const pickupDayNumber = getDayNumber(pickupDay)
            const deliveryDayNumber = getDayNumber(deliveryDay)

            console.log("***PICKUP WINDOW ")
            console.log('pickup day number ', pickupDayNumber)
            const convertedPickupWindow = extractAndConvertTime(pickupWindow)
            console.log('pickup winodow time ', convertedPickupWindow)

            const { pickupDateFlag, scheduledPickupDate } = getNextDatePickup(pickupDayNumber, convertedPickupWindow);
            console.log(`FINAL PICKUPDATE ${scheduledPickupDate}.`);

            console.log("******DELIVERY WINDOW*********");
            const convertedDeliveryWindow = extractAndConvertTime(deliveryWindow)
            console.log("***Delivery WINDOW ")
            console.log("delivery window time ", convertedDeliveryWindow)
            console.log("delivery day number ", deliveryDayNumber)

            const scheduledDeliveryDate = getNextDateDelivery(scheduledPickupDate, deliveryDayNumber, convertedDeliveryWindow)
            console.log("FINAL DELIVERY DATE", scheduledDeliveryDate)

            const pickup_uuid = await findByContactId(ghl_contact_id)
            const uuid_string = pickup_uuid[0].customer_uuid;
            console.log('customerUuid ', uuid_string)
            // First, try to get the item from DynamoDB using the customer_uuid
            const tableItem = await getItem(uuid_string);

            const putPayloadPickup = {
                selectedSlot: scheduledPickupDate,
                selectedTimezone: 'America/New_York',
            }
            const postPayloadPickup = {
                email: parsedBody.email,
                selectedSlot: scheduledPickupDate,
                selectedTimezone: 'America/New_York',
                calendarId: 'PO5Ut3fBdLrCB5psILte'
            }
            const emailPayload = {
                email: parsedBody.email
            }

            const putPayloadDelivery = {
                selectedSlot: scheduledDeliveryDate,
                selectedTimezone: 'America/New_York',
            }

            const postPayloadDelivery = {
                email: parsedBody.email,
                selectedSlot: scheduledDeliveryDate,
                selectedTimezone: 'America/New_York',
                calendarId: 'qbSmbkHVcUEw40G8oCBl'
            }

            //Good Pickup Bad Delivery
            if (pickupDateFlag === true && scheduledDeliveryDate === -1) {
                await sendGoodPickupBadDelivery(emailPayload, GOLDTUX_KEY)
            }
            //Bad Pickup Good Delivery
            else if (pickupDateFlag === false && scheduledDeliveryDate != -1) {
                await sendBadPickupGoodDelivery(emailPayload, GOLDTUX_KEY)
            }
            //Bad Pickup Bad Delivery
            else if (pickupDateFlag === false && scheduledDeliveryDate === -1) {
                await sendBadPickupBadDelivery(emailPayload, GOLDTUX_KEY)
            }
            else {
                // Check if the 'pickup_appointment_id' field exists
                if (tableItem && tableItem.hasOwnProperty('pickup_appointment_id')) {
                    // If it exists, send a PUT request with the payload
                    const putAppointmentResponse = await sendAppointmentPutRequest(tableItem.pickup_appointment_id, putPayloadPickup, GOLDTUX_KEY);
                    console.log('putAppointmentResponse: ', putAppointmentResponse)
                    if (putAppointmentResponse === -1) {
                        //send out incoming webhook to message user to change appointment
                        console.log('error at pickup Appointment')
                        await sendPickupErrorWebhook(emailPayload, GOLDTUX_KEY)
                    }
                } else {
                    // If it doesn't exist, send a POST request with the payload
                    const appointmentIdResponse = await sendAppointmentPostRequest(postPayloadPickup, GOLDTUX_KEY);
                    console.log("Appointment Response", appointmentIdResponse)
                    if (appointmentIdResponse === -1) {
                        //send out incoming webhook to message user to change appointment
                        console.log('error at pickup Appointment')
                        await sendPickupErrorWebhook(emailPayload, GOLDTUX_KEY)
                    }
                    else {
                        pickup_appointment_id = appointmentIdResponse.data.id
                        console.log('appointmentID ', pickup_appointment_id)
                        // Insert the response's value into the new 'pickup_appointment_id' field
                        await updateItemWithPickupAppointmentId(uuid_string, pickup_appointment_id);
                    }
                }

                if (tableItem && tableItem.hasOwnProperty('delivery_appointment_id')) {
                    // If it exists, send a PUT request with the payload
                    const appointmentDeliveryIdResponse = await sendAppointmentPutRequest(tableItem.delivery_appointment_id, putPayloadDelivery, GOLDTUX_KEY);
                    if (appointmentDeliveryIdResponse === -1) {
                        console.log('error at delivery Appointment')
                        await sendDeliveryErrorWebhook(emailPayload, GOLDTUX_KEY)
                    }
                } else {
                    // If it doesn't exist, send a POST request with the payload
                    const appointmentDeliveryIdResponse = await sendAppointmentPostRequest(postPayloadDelivery, GOLDTUX_KEY);
                    if (appointmentDeliveryIdResponse === -1) {
                        console.log('error at delivery Appointment')
                        await sendDeliveryErrorWebhook(emailPayload, GOLDTUX_KEY)
                    }
                    else {
                        delivery_appointment_id = appointmentDeliveryIdResponse.data.id
                        console.log('deliveryappointmentID ', delivery_appointment_id)
                        // Insert the response's value into the new 'pickup_appointment_id' field
                        await updateItemWithDeliveryAppointmentId(uuid_string, delivery_appointment_id);
                    }
                }

                await sendConfirmationEmail(emailPayload, GOLDTUX_KEY)
                //update pickup and delivery date/time in DynamoDB
                await updateItemWithPickupDeliveryDate(uuid_string, pickupDayNumber, convertedPickupWindow, deliveryDayNumber, convertedDeliveryWindow)
            }

        }
        if (workflowType === 'Developers - Pipeline Stage Changed - Customer Won') {
            let primary_uuid = await findByContactId(ghl_contact_id)
            const customerUuid = primary_uuid[0].customer_uuid;
            // First, try to get the item from DynamoDB using the customer_uuid
            const existingItem = await getItem(customerUuid);

            const pickup_day = existingItem.pickup_day
            const pickup_hour = existingItem.pickup_time
            const delivery_day = existingItem.delivery_day
            const delivery_hour = existingItem.delivery_time

            const current_pickup_id = existingItem.pickup_appointment_id
            const current_delivery_id = existingItem.delivery_appointment_id

            console.log('pickup_day: ', pickup_day)
            console.log('pickup_hour: ', pickup_hour)
            console.log('delivery_day: ', delivery_day)
            console.log('delivery_hour: ', delivery_hour)

            console.log('current_pickup_id: ', current_pickup_id)
            console.log('current_delivery_id: ', current_delivery_id)
            const emailPayload = {
                email: parsedBody.email
            }

            const { pickupDateFlag, scheduledPickupDate } = getNextDatePickup(pickup_day, pickup_hour);
            const scheduledDeliveryDate = getNextDateDelivery(scheduledPickupDate, delivery_day, delivery_hour)

            console.log('SCHEDULED PICKUP DATE ', scheduledPickupDate)
            console.log('SCHEDULED Delivery Date', scheduledDeliveryDate)

            const putPayloadPickup = {
                selectedSlot: scheduledPickupDate,
                selectedTimezone: 'America/New_York',
            }

            const putPayloadDelivery = {
                selectedSlot: scheduledDeliveryDate,
                selectedTimezone: 'America/New_York',
            }

            const putAppointmentResponse = await sendAppointmentPutRequest(current_pickup_id, putPayloadPickup, GOLDTUX_KEY);
            console.log('putAppointmentResponse: ', putAppointmentResponse)
            if (putAppointmentResponse === -1) {
                //send out incoming webhook to message user to change appointment
                console.log('error at pickup Appointment')
                await sendPickupErrorWebhook(emailPayload, GOLDTUX_KEY)
            }

            const appointmentDeliveryIdResponse = await sendAppointmentPutRequest(current_delivery_id, putPayloadDelivery, GOLDTUX_KEY);
            if (appointmentDeliveryIdResponse === -1) {
                console.log('error at delivery Appointment')
                await sendDeliveryErrorWebhook(emailPayload, GOLDTUX_KEY)
            }
           
        }
        if (workflowType === 'Developers - Bad Pickup Good Delivery') {

            let primary_uuid = await findByContactId(ghl_contact_id)
            const customerUuid = primary_uuid[0].customer_uuid;
            // First, try to get the item from DynamoDB using the customer_uuid
            const tableItem = await getItem(customerUuid);

            const pickup_day = tableItem.pickup_day
            const pickup_hour = tableItem.pickup_time
            const delivery_day = tableItem.delivery_day
            const delivery_hour = tableItem.delivery_time

            const { pickupDateFlag, scheduledPickupDate } = getNextDatePickup(pickup_day, pickup_hour);
            const scheduledDeliveryDate = getNextDateDelivery(scheduledPickupDate, delivery_day, delivery_hour)

            const putPayloadPickup = {
                selectedSlot: scheduledPickupDate,
                selectedTimezone: 'America/New_York',
            }
            const postPayloadPickup = {
                email: parsedBody.email,
                selectedSlot: scheduledPickupDate,
                selectedTimezone: 'America/New_York',
                calendarId: 'PO5Ut3fBdLrCB5psILte'
            }
            const emailPayload = {
                email: parsedBody.email
            }

            const putPayloadDelivery = {
                selectedSlot: scheduledDeliveryDate,
                selectedTimezone: 'America/New_York',
            }

            const postPayloadDelivery = {
                email: parsedBody.email,
                selectedSlot: scheduledDeliveryDate,
                selectedTimezone: 'America/New_York',
                calendarId: 'qbSmbkHVcUEw40G8oCBl'
            }

            // Check if the 'pickup_appointment_id' field exists
            if (tableItem && tableItem.hasOwnProperty('pickup_appointment_id')) {
                // If it exists, send a PUT request with the payload
                const putAppointmentResponse = await sendAppointmentPutRequest(tableItem.pickup_appointment_id, putPayloadPickup, GOLDTUX_KEY);
                console.log('putAppointmentResponse: ', putAppointmentResponse)
                if (putAppointmentResponse === -1) {
                    //send out incoming webhook to message user to change appointment
                    console.log('error at pickup Appointment')
                    await sendPickupErrorWebhook(emailPayload)
                }
            } else {
                // If it doesn't exist, send a POST request with the payload
                const appointmentIdResponse = await sendAppointmentPostRequest(postPayloadPickup);
                console.log("Appointment Response", appointmentIdResponse)
                if (appointmentIdResponse === -1) {
                    //send out incoming webhook to message user to change appointment
                    console.log('error at pickup Appointment')
                    await sendPickupErrorWebhook(emailPayload)
                }
                else {
                    pickup_appointment_id = appointmentIdResponse.data.id
                    console.log('appointmentID ', pickup_appointment_id)
                    // Insert the response's value into the new 'pickup_appointment_id' field
                    await updateItemWithPickupAppointmentId(customerUuid, pickup_appointment_id);
                }
            }

            if (tableItem && tableItem.hasOwnProperty('delivery_appointment_id')) {
                // If it exists, send a PUT request with the payload
                const appointmentDeliveryIdResponse = await sendAppointmentPutRequest(tableItem.delivery_appointment_id, putPayloadDelivery, GOLDTUX_KEY);
                if (appointmentDeliveryIdResponse === -1) {
                    console.log('error at delivery Appointment')
                    await sendDeliveryErrorWebhook(emailPayload)
                }
            } else {
                // If it doesn't exist, send a POST request with the payload
                const appointmentDeliveryIdResponse = await sendAppointmentPostRequest(postPayloadDelivery);
                if (appointmentDeliveryIdResponse === -1) {
                    console.log('error at delivery Appointment')
                    await sendDeliveryErrorWebhook(emailPayload)
                }
                else {
                    delivery_appointment_id = appointmentDeliveryIdResponse.data.id
                    console.log('deliveryappointmentID ', delivery_appointment_id)
                    // Insert the response's value into the new 'pickup_appointment_id' field
                    await updateItemWithDeliveryAppointmentId(customerUuid, delivery_appointment_id);
                }
            }

            await sendConfirmationEmail(emailPayload, GOLDTUX_KEY)
        }
        const response = {
            statusCode: 200,
            body: JSON.stringify('Successful!'),
        };
        return response;
    }
    else {
        return response = {
            statusCode: 403,
            body: JSON.stringify('Forbidden')
        }
    }
};

async function getGoldtuxSecret() {
    let secretValue;
    try {
        const response = await client.send(new GetSecretValueCommand({ SecretId: secret_name }));
        secretValue = response.SecretString;
    } catch (error) {
        console.error(error);
        throw error;
    }
    return secretValue;
}

async function saveToDynamoDB(item) {
    const params = {
        TableName: 'GoldtuxCustomers',
        Item: item
    };

    try {
        await dynamoDB.put(params).promise();
        return { success: true, message: 'Item saved', itemId: item.id };
    } catch (error) {
        console.error('Error saving to DynamoDB:', error);
        return { success: false, message: 'Error saving item', error: error.message };
    }
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

async function getItem(customer_uuid) {
    const params = {
        TableName: 'GoldtuxCustomers',
        Key: { customer_uuid }
    };

    const result = await dynamoDB.get(params).promise();
    return result.Item;
}

async function sendConfirmationEmail(payload, key) {
    console.log(`Sending POST request with payload:`, payload);
    try {
        const response = await axios.post('https://services.leadconnectorhq.com/hooks/xh4YUIhuK8hmcqxtL52V/webhook-trigger/73d30804-ea35-4af8-aed9-2bc6dd6cd379', payload,
            {
                headers: {
                    'Authorization': `Bearer ${key}`,
                    'Content-Type': 'application/json'
                }
            })

        return response
    } catch (error) {
        console.log('ERROR', error)
        return -1
    }
}

async function sendAppointmentPutRequest(appointment_id, payload, key) {
    console.log(`Sending PUT request for appointment_id ${appointment_id} with payload:`, payload);
    try {
        const response = await axios.put(`https://rest.gohighlevel.com/v1/appointments/${appointment_id}`, payload,
            {
                headers: {
                    'Authorization': `Bearer ${key}`,
                    'Content-Type': 'application/json',
                },
            });
        return response
    } catch (error) {
        console.log('ERROR', error)
        return -1
    }
}

async function sendAppointmentPostRequest(payload, key) {
    console.log(`Sending POST request with payload:`, payload);
    try {
        const response = await axios.post('https://rest.gohighlevel.com/v1/appointments/', payload,
            {
                headers: {
                    'Authorization': `Bearer ${key}`,
                    'Content-Type': 'application/json'
                }
            })

        return response
    } catch (error) {
        console.log('ERROR', error)
        return -1
    }
}

async function sendPickupErrorWebhook(payload, key) {
    console.log(`Sending POST request with payload:`, payload);
    try {
        const response = await axios.post('https://services.leadconnectorhq.com/hooks/xh4YUIhuK8hmcqxtL52V/webhook-trigger/Su94s5Iqjv4tSmAdxg8L', payload,
            {
                headers: {
                    'Authorization': `Bearer ${key}`,
                    'Content-Type': 'application/json'
                }
            })

        return response
    } catch (error) {
        console.log('ERROR', error)
        return -1
    }
}

async function sendGoodPickupBadDelivery(payload, key) {
    console.log(`Sending POST request with payload:`, payload);
    try {
        const response = await axios.post('https://services.leadconnectorhq.com/hooks/xh4YUIhuK8hmcqxtL52V/webhook-trigger/edfe5fd3-a909-4ce7-90f2-d4a8dfcd28e9', payload,
            {
                headers: {
                    'Authorization': `Bearer ${key}`,
                    'Content-Type': 'application/json'
                }
            })

        return response
    } catch (error) {
        console.log('ERROR', error)
        return -1
    }
}

async function sendBadPickupGoodDelivery(payload, key) {
    console.log(`Sending POST request with payload:`, payload);
    try {
        const response = await axios.post('https://services.leadconnectorhq.com/hooks/xh4YUIhuK8hmcqxtL52V/webhook-trigger/a085ce49-3687-474d-a5ff-59252560e674', payload,
            {
                headers: {
                    'Authorization': `Bearer ${key}`,
                    'Content-Type': 'application/json'
                }
            })

        return response
    } catch (error) {
        console.log('ERROR', error)
        return -1
    }
}

async function sendBadPickupBadDelivery(payload, key) {
    console.log(`Sending POST request with payload:`, payload);
    try {
        const response = await axios.post('https://services.leadconnectorhq.com/hooks/xh4YUIhuK8hmcqxtL52V/webhook-trigger/3d6bfc56-d407-4fa6-8a8c-6a8b912b8d3c', payload,
            {
                headers: {
                    'Authorization': `Bearer ${key}`,
                    'Content-Type': 'application/json'
                }
            })

        return response
    } catch (error) {
        console.log('ERROR', error)
        return -1
    }
}

async function sendDeliveryErrorWebhook(payload, key) {
    console.log(`Sending POST request with payload:`, payload);
    try {
        const response = await axios.post('https://services.leadconnectorhq.com/hooks/xh4YUIhuK8hmcqxtL52V/webhook-trigger/90525009-7de5-4568-8137-614363ff36ba', payload,
            {
                headers: {
                    'Authorization': `Bearer ${key}`,
                    'Content-Type': 'application/json'
                }
            })

        return response
    } catch (error) {
        console.log('ERROR', error)
        return -1
    }
}

async function updateItemWithPickupDeliveryDate(customer_uuid, pickup_day, pickup_time, delivery_day, delivery_time) {
    const params = {
        TableName: 'GoldtuxCustomers',
        Key: { customer_uuid },
        UpdateExpression: 'SET pickup_day = :pickup_day, pickup_time = :pickup_time, delivery_day = :delivery_day, delivery_time = :delivery_time',
        ExpressionAttributeValues: {
            ':pickup_day': pickup_day,
            ':pickup_time': pickup_time,
            ':delivery_day': delivery_day,
            ':delivery_time': delivery_time
        },
        ReturnValues: 'UPDATED_NEW'
    };

    await dynamoDB.update(params).promise();
    console.log('added pickup/delivery dates/times to database');
}

async function updateItemWithPickupAppointmentId(customer_uuid, pickup_appointment_id) {
    const params = {
        TableName: 'GoldtuxCustomers',
        Key: { customer_uuid },
        UpdateExpression: 'SET pickup_appointment_id = :pickup_appointment_id',
        ExpressionAttributeValues: {
            ':pickup_appointment_id': pickup_appointment_id
        },
        ReturnValues: 'UPDATED_NEW'
    };

    await dynamoDB.update(params).promise();
    console.log('added pickup_appointment_id to database');
}

async function updateItemWithDeliveryAppointmentId(customer_uuid, delivery_appointment_id) {
    const params = {
        TableName: 'GoldtuxCustomers',
        Key: { customer_uuid },
        UpdateExpression: 'SET delivery_appointment_id = :delivery_appointment_id',
        ExpressionAttributeValues: {
            ':delivery_appointment_id': delivery_appointment_id
        },
        ReturnValues: 'UPDATED_NEW'
    };

    await dynamoDB.update(params).promise();
    console.log('added delivery_appointment_id to database');
}

function getNextDatePickup(dayOfWeek, hour) {
    const now = DateTime.local().setZone('America/New_York');
    let flag = true
    // Create a DateTime object representing the next pickup date
    let nextPickup = now.set({ weekday: dayOfWeek, hour: hour, minute: 0, second: 0, millisecond: 0 });

    // If the next pickup date is earlier than or equal to the current date/time, add one week
    if (nextPickup <= now) {
        nextPickup = nextPickup.plus({ weeks: 1 });
    }

    // Check if the next pickup date is within 27 hours of the current date/time
    const diff = nextPickup.diff(now, 'hours').hours;

    // If the next pickup date is within 27 hours of the current date/time, add one week
    console.log("diff", diff)
    if (diff < 27) {
        flag = false
        nextPickup = nextPickup.plus({ weeks: 1 });
    }

    // Return the next pickup date in ISO format with milliseconds suppressed
    let dateString = nextPickup.toISO({ suppressMilliseconds: true });
    return {
        pickupDateFlag: flag,
        scheduledPickupDate: dateString,
    };

}

function getNextDateDelivery(nextPickupIso, dayOfWeek, hour) {
    let nextPickup = DateTime.fromISO(nextPickupIso, { zone: 'America/New_York' });
    let nextDelivery = nextPickup.set({ weekday: dayOfWeek, hour: hour, minute: 0, second: 0, millisecond: 0 });

    if (nextDelivery <= nextPickup) {
        nextDelivery = nextDelivery.plus({ weeks: 1 });
    }

    const diff = nextDelivery.diff(nextPickup, 'hours').hours;
    // if difference is 33 hours
    if (diff < 33) {
        return -1
    }

    return nextDelivery.toISO({ suppressMilliseconds: true });
}

function extractAndConvertTime(inputStr) {
    // Extract the first time part
    const match = inputStr.match(/(\d+)(?::\d+)?\s*(am|pm)/i);
    if (!match) {
        throw new Error('Invalid time range format');
    }

    // Convert the extracted time to 24-hour format
    let hours = parseInt(match[1], 10);
    const amPm = match[2].toLowerCase();

    if (amPm === 'pm' && hours !== 12) {
        hours += 12;
    } else if (amPm === 'am' && hours === 12) {
        hours = 0;
    }

    return hours;
}

function getDayNumber(day) {
    const daysMapping = {
        'Monday': 1,
        'Tuesday': 2,
        'Wednesday': 3,
        'Thursday': 4,
        'Friday': 5,
        'Saturday': 6,
        'Sunday': 7,

    };

    return daysMapping[day] ?? -1; // Returns -1 if the day is not found in the mapping
}