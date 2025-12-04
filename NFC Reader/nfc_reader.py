import sys
import nfc
import time
import os
import cv2
import boto3
from botocore.exceptions import ClientError
from datetime import datetime
#from dotenv import load_dotenv

tag_info = {}  

def find_membership_status_by_contact_id(contact_id, access_key, secret_key): 
    session = boto3.Session(
        aws_access_key_id= access_key,
        aws_secret_access_key= secret_key,
        region_name= 'us-east-1'
    )

    dynamodb = session.resource('dynamodb')
    table = dynamodb.Table('GoldtuxCustomers')

    response = table.query(
        IndexName='GHLContactIndex',
        KeyConditionExpression='contact_id = :contactIdValue',
        ExpressionAttributeValues={
            ':contactIdValue': contact_id
        }
    )
        
    item = response['Items'][0] if response['Items'] else None

    if item is not None:
        customer_uuid = item['customer_uuid']
        #print(f'Customer UUID: {customer_uuid}')
        table_response = table.get_item(
            Key = {
                'customer_uuid': customer_uuid
            }
        )

        if 'Item' in table_response: 
            current_member_status = table_response['Item'].get('current_membership_status', None)
            return current_member_status
        else: 
            return None
    else:
        print(f'No item found with contact_id: {contact_id}')
        return None


def upload_video_to_s3(video_file_path, customer_id, access_key, secret_key):
    bucket_name = 'goldtux-video-insurance'

    # Create a session and S3 client
    session = boto3.Session(
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key
    )
    s3_client = session.client('s3')

    # Generate the S3 key using the customer ID
    s3_key = f'customers/{customer_id}/{os.path.basename(video_file_path)}'

    # Upload the video file to S3
    try:
        s3_client.upload_file(video_file_path, bucket_name, s3_key)
        print(f'Successfully uploaded {video_file_path} to s3://{bucket_name}/{s3_key}')
    except Exception as e:
        print(f'Error uploading {video_file_path}: {e}')


def record_video(first_name, last_name, ghl_id, lang_select):
    record_msg = ["RECORDING LAUNDRY VIDEO FOR: ","GRABACION DE VIDEO DE LAVANDERIA PARA: " ]
    quit_msg = ["PRESS Q TO QUIT!", "PRESIONA Q PARA SALIR!"]
    # Open a video capture object
    cap = cv2.VideoCapture(0, cv2.CAP_DSHOW)

    # Set resolution to 720p
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)

    # Set frame rate to 30 fps
    cap.set(cv2.CAP_PROP_FPS, 30)

    # Define the codec and create VideoWriter object
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    date_time = datetime.now().strftime("%Y%m%d_%H%M%S")
    video_name = f"{last_name},{first_name}_{date_time}.mp4"
    out = cv2.VideoWriter(video_name, fourcc, 30.0, (1280, 720))

    start_time = time.time()
    while cap.isOpened():
        ret, frame = cap.read()
        if ret:
            # Write the frame to the output file
            out.write(frame)

            # Display the frame
            cv2.imshow(f"{record_msg[lang_select]}{first_name} {last_name}... {quit_msg[lang_select]}", frame)
            #pyautogui.click(200, 200) 
            #if more than 10 minutes has passed, stop recording
            if time.time() - start_time > 600:
                break

            # Break the loop if a key is pressed
            if cv2.waitKey(1) & 0xFF == ord('q'):
                break
        else:
            break

    cap.release()
    out.release()
    cv2.destroyAllWindows()
    return video_name


def on_connect(tag):
    global tag_info 

    #print("Connected to tag:", tag)
    try:
        # Check if the tag is an NTAG215
        if tag.type == "Type2Tag" and tag.__class__.__name__ == "NTAG215":
            assert tag.ndef is not None
            ndef_records = list(tag.ndef.records)
            if ndef_records:
                text = ndef_records[0].text
                stripe_customer_id, ghl_contact_id, first_name, last_name, phone, email = text.split(',')
                tag_info = {"StripeID": stripe_customer_id, "HighlevelID": ghl_contact_id, "FirstName": first_name, "LastName": last_name, "Phone": phone, "Email": email}
            else:
                print("No Text Records found on tag")

        else:
            print("Tag is not an NTAG215")
    except Exception as e:
        print("Error reading tag:", e)
    return False  # Close connection

def main():

    global tag_info 
    #load_dotenv()
    AWS_PUBLIC = ''
    AWS_SECRET = ''
    user_input = ''


    name_msg = ["NAME: ", "NOMBRE: "]
    phone_msg = ["PHONE: ", "TELÉFONO: "]
    email_msg = ["EMAIL: ", "CORREO ELECTRÓNICO: "]
    customer_header = ["📋 CUSTOMER DETAILS", "📋 DETALLES DEL CLIENTE"]
    nfc_msg = ["❌  Unable to open NFC device, please unplug and replug in the USB Reader\n","❌  No se puede abrir el dispositivo NFC, desconecte y vuelva a conectar el lector USB\n"]
    tag_msg = ["⏰ WAITING FOR A TAG TO BE SCANNED...\n","⏰ ESPERANDO QUE SE ESCANEE UNA ETIQUETA...\n"]
    current_status_msg = ["➡️ CURRENT MEMBERSHIP STATUS: ","➡️ ESTADO ACTUAL DE MEMBRESÍA: "]
    record_msg = ["🔴 RECORDING VIDEO...PRESS Q TO STOP RECORDING!","🔴 GRABANDO VÍDEO... ¡PRESIONE Q PARA DETENER LA GRABACIÓN!"]
    record_finish_msg = ["📹 VIDEO RECORDING COMPLETED!","📹 ¡GRABACIÓN DE VÍDEO COMPLETADA!"]
    s3_msg = ["☁️ UPLOADING VIDEO ONLINE...","☁️ SUBIR VÍDEO EN LÍNEA..."]
    finish_msg = ["✅ PROCESS COMPLETED. READY FOR NEXT CUSTOMER!\n","✅ PROCESO COMPLETADO. ¡LISTO PARA EL PRÓXIMO CLIENTE!\n"]

    print("🫧🫧🫧🫧🫧🫧🫧🫧🫧🫧🫧🫧🫧🫧🫧🫧🫧🫧🫧🫧🫧🫧🫧🫧🫧")
    print("🫧      NFC Upload Utility Tool by Goldtux      🫧")
    print("🫧           Developed by Andrew Kwong          🫧")
    print("🫧🫧🫧🫧🫧🫧🫧🫧🫧🫧🫧🫧🫧🫧🫧🫧🫧🫧🫧🫧🫧🫧🫧🫧🫧")

    print("\nChoose your language display by typing in 1 or 2 and hit enter: \n")
    print("1) English")
    print("2) Español\n") 


    while True:
        user_input = input('Your choice: ')

        if user_input == '1':
            break
            
        elif user_input == '2':
            break
        else:
            print('Invalid selection, please type in 1 or 2')
            continue
    
    select = int(user_input) - 1
    print('\n')

    while True: 
        clf = nfc.ContactlessFrontend("usb")

        if not clf:
            print(nfc_msg[select])
            sys.exit(1) 

        # Scan user tag
        print(tag_msg[select])
        clf.connect(rdwr={"on-connect": on_connect})
        clf.close()

        print(customer_header[select])
        print("----------------------------------------------------------------------------------")
        print(f'{name_msg[select]}{tag_info["FirstName"]} {tag_info["LastName"]}')
        print(f'{phone_msg[select]}{tag_info["Phone"]}')
        print(f'{email_msg[select]}{tag_info["Email"]}')
        print(f'STRIPE ID: {tag_info["StripeID"]}')
        print(f'HIGHLEVEL ID: {tag_info["HighlevelID"]}')

        # Return current membership status
        member_status = find_membership_status_by_contact_id(tag_info["HighlevelID"], AWS_PUBLIC, AWS_SECRET)
        if (member_status != None): 
            print(f"{current_status_msg[select]}{member_status}\n")
        
            # Recording video in progress
            print(record_msg[select])
            video_file = record_video(tag_info["FirstName"], tag_info["LastName"], tag_info["HighlevelID"], select)

            time.sleep(1)

            # Recording is finished, prints file location
            print(record_finish_msg[select])
            #print(video_file)

            time.sleep(1)

            # Upload video to S3 bucket
            print(s3_msg[select])
            upload_video_to_s3(video_file, tag_info["HighlevelID"], AWS_PUBLIC, AWS_SECRET)

            print(finish_msg[select])
            print("----------------------------------------------------------------------------------")
            time.sleep(1) 


if __name__ == "__main__":
    main()
