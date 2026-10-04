import cv2

camera = cv2.VideoCapture(0)

if not camera.isOpened():
    print("❌ Camera could not be opened.")
    exit()

print("📷 Camera started.")
print("Press Q to stop recording.")

fourcc = cv2.VideoWriter_fourcc(*"mp4v")
video = cv2.VideoWriter(
    "dashcam_test.mp4",
    fourcc,
    20.0,
    (640, 480)
)

while True:
    ret, frame = camera.read()

    if not ret:
        print("❌ Could not read camera frame.")
        break

    video.write(frame)

    cv2.imshow("Dashcam Test Recording", frame)

    if cv2.waitKey(1) & 0xFF == ord("q"):
        break

camera.release()
video.release()
cv2.destroyAllWindows()

print("✅ Video saved as dashcam_test.mp4")