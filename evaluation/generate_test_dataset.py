import cv2
import os
import shutil
import subprocess
import numpy as np
from pathlib import Path


SOURCE = "videos/dashcam_test.mp4"
OUTPUT = "evaluation/dataset"


def create_folders():
    folders = [
        "authentic",
        "temporal",
        "transformed",
        "other"
    ]

    for folder in folders:
        os.makedirs(
            os.path.join(OUTPUT, folder),
            exist_ok=True
        )


def copy_authentic():
    destination = os.path.join(
        OUTPUT,
        "authentic",
        "authentic.mp4"
    )

    shutil.copy2(SOURCE, destination)

    print("Created:", destination)


def create_trimmed_video(
    output_path,
    start_seconds,
    duration_seconds
):
    cap = cv2.VideoCapture(SOURCE)

    if not cap.isOpened():
        raise Exception("Could not open source video.")

    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(
        cap.get(cv2.CAP_PROP_FRAME_WIDTH)
    )
    height = int(
        cap.get(cv2.CAP_PROP_FRAME_HEIGHT)
    )

    start_frame = int(
        start_seconds * fps
    )

    end_frame = start_frame + int(
        duration_seconds * fps
    )

    cap.set(
        cv2.CAP_PROP_POS_FRAMES,
        start_frame
    )

    writer = cv2.VideoWriter(
        output_path,
        cv2.VideoWriter_fourcc(*"mp4v"),
        fps,
        (width, height)
    )

    frame_number = start_frame

    while frame_number < end_frame:

        success, frame = cap.read()

        if not success:
            break

        writer.write(frame)

        frame_number += 1

    cap.release()
    writer.release()

    print("Created:", output_path)


def create_brightness_video(
    output_path,
    brightness
):
    cap = cv2.VideoCapture(SOURCE)

    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(
        cap.get(cv2.CAP_PROP_FRAME_WIDTH)
    )
    height = int(
        cap.get(cv2.CAP_PROP_FRAME_HEIGHT)
    )

    writer = cv2.VideoWriter(
        output_path,
        cv2.VideoWriter_fourcc(*"mp4v"),
        fps,
        (width, height)
    )

    while True:

        success, frame = cap.read()

        if not success:
            break

        modified = cv2.convertScaleAbs(
            frame,
            alpha=1.0,
            beta=brightness
        )

        writer.write(modified)

    cap.release()
    writer.release()

    print("Created:", output_path)


def create_contrast_video(
    output_path,
    contrast
):
    cap = cv2.VideoCapture(SOURCE)

    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(
        cap.get(cv2.CAP_PROP_FRAME_WIDTH)
    )
    height = int(
        cap.get(cv2.CAP_PROP_FRAME_HEIGHT)
    )

    writer = cv2.VideoWriter(
        output_path,
        cv2.VideoWriter_fourcc(*"mp4v"),
        fps,
        (width, height)
    )

    while True:

        success, frame = cap.read()

        if not success:
            break

        modified = cv2.convertScaleAbs(
            frame,
            alpha=contrast,
            beta=0
        )

        writer.write(modified)

    cap.release()
    writer.release()

    print("Created:", output_path)


def create_noise_video(
    output_path
):
    cap = cv2.VideoCapture(SOURCE)

    if not cap.isOpened():
        raise Exception("Could not open source video.")

    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(
        cap.get(cv2.CAP_PROP_FRAME_WIDTH)
    )
    height = int(
        cap.get(cv2.CAP_PROP_FRAME_HEIGHT)
    )

    writer = cv2.VideoWriter(
        output_path,
        cv2.VideoWriter_fourcc(*"mp4v"),
        fps,
        (width, height)
    )

    while True:

        success, frame = cap.read()

        if not success:
            break

        # Generate moderate Gaussian noise
        noise = np.random.normal(
            0,
            15,
            frame.shape
        ).astype(np.float32)

        noisy_frame = (
            frame.astype(np.float32)
            + noise
        )

        noisy_frame = np.clip(
            noisy_frame,
            0,
            255
        ).astype(np.uint8)

        writer.write(noisy_frame)

    cap.release()
    writer.release()

    print("Created:", output_path)


def create_salt_pepper_video(
    output_path
):
    cap = cv2.VideoCapture(SOURCE)

    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(
        cap.get(cv2.CAP_PROP_FRAME_WIDTH)
    )
    height = int(
        cap.get(cv2.CAP_PROP_FRAME_HEIGHT)
    )

    writer = cv2.VideoWriter(
        output_path,
        cv2.VideoWriter_fourcc(*"mp4v"),
        fps,
        (width, height)
    )

    while True:

        success, frame = cap.read()

        if not success:
            break

        modified = frame.copy()

        amount = 0.01

        total_pixels = int(
            frame.shape[0]
            * frame.shape[1]
            * amount
        )

        for _ in range(total_pixels):

            y = __import__("random").randint(
                0,
                frame.shape[0] - 1
            )

            x = __import__("random").randint(
                0,
                frame.shape[1] - 1
            )

            if __import__("random").random() < 0.5:
                modified[y, x] = 0
            else:
                modified[y, x] = 255

        writer.write(modified)

    cap.release()
    writer.release()

    print("Created:", output_path)


def create_crop_video(
    output_path
):
    cap = cv2.VideoCapture(SOURCE)

    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(
        cap.get(cv2.CAP_PROP_FRAME_WIDTH)
    )
    height = int(
        cap.get(cv2.CAP_PROP_FRAME_HEIGHT)
    )

    crop_x = int(width * 0.10)
    crop_y = int(height * 0.10)

    new_width = width - 2 * crop_x
    new_height = height - 2 * crop_y

    writer = cv2.VideoWriter(
        output_path,
        cv2.VideoWriter_fourcc(*"mp4v"),
        fps,
        (new_width, new_height)
    )

    while True:

        success, frame = cap.read()

        if not success:
            break

        modified = frame[
            crop_y:height - crop_y,
            crop_x:width - crop_x
        ]

        writer.write(modified)

    cap.release()
    writer.release()

    print("Created:", output_path)


def create_duplicate_frame_video(
    output_path
):
    cap = cv2.VideoCapture(SOURCE)

    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(
        cap.get(cv2.CAP_PROP_FRAME_WIDTH)
    )
    height = int(
        cap.get(cv2.CAP_PROP_FRAME_HEIGHT)
    )

    writer = cv2.VideoWriter(
        output_path,
        cv2.VideoWriter_fourcc(*"mp4v"),
        fps,
        (width, height)
    )

    frame_number = 0
    previous_frame = None

    while True:

        success, frame = cap.read()

        if not success:
            break

        if (
            previous_frame is not None
            and frame_number % 30 == 0
        ):
            writer.write(previous_frame)
        else:
            writer.write(frame)

        previous_frame = frame.copy()

        frame_number += 1

    cap.release()
    writer.release()

    print("Created:", output_path)


def create_missing_frame_video(
    output_path
):
    cap = cv2.VideoCapture(SOURCE)

    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(
        cap.get(cv2.CAP_PROP_FRAME_WIDTH)
    )
    height = int(
        cap.get(cv2.CAP_PROP_FRAME_HEIGHT)
    )

    writer = cv2.VideoWriter(
        output_path,
        cv2.VideoWriter_fourcc(*"mp4v"),
        fps,
        (width, height)
    )

    frame_number = 0

    while True:

        success, frame = cap.read()

        if not success:
            break

        # Skip every 30th frame
        if frame_number % 30 != 0:
            writer.write(frame)

        frame_number += 1

    cap.release()
    writer.release()

    print("Created:", output_path)


def run_ffmpeg(
    output_name,
    arguments
):
    output_path = os.path.join(
        OUTPUT,
        "transformed",
        output_name
    )

    command = [
        "ffmpeg",
        "-y",
        "-i",
        SOURCE
    ]

    command.extend(arguments)
    command.append(output_path)

    try:

        subprocess.run(
            command,
            check=True
        )

        print(
            "Created:",
            output_path
        )

    except FileNotFoundError:

        print(
            "FFmpeg not found."
        )

    except subprocess.CalledProcessError:

        print(
            "FFmpeg failed:",
            output_name
        )



def create_shifted_video(input_path, output_path, shift_seconds=3):
    cap=cv2.VideoCapture(input_path)
    if not cap.isOpened(): raise Exception(f"Could not open source video: {input_path}")
    fps=cap.get(cv2.CAP_PROP_FPS); width=int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)); height=int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)); shift_frames=int(round(fps*shift_seconds))
    writer=cv2.VideoWriter(output_path,cv2.VideoWriter_fourcc(*"mp4v"),fps,(width,height))
    if not writer.isOpened(): cap.release(); raise RuntimeError(f"Could not create video: {output_path}")
    n=0
    while True:
        ok,frame=cap.read()
        if not ok: break
        if n>=shift_frames: writer.write(frame)
        n+=1
    cap.release(); writer.release(); print("Created:",output_path)


def create_speed_video(input_path, output_path, speed_factor):
    cap=cv2.VideoCapture(input_path)
    if not cap.isOpened(): raise Exception(f"Could not open source video: {input_path}")
    width=int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)); height=int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)); frames=[]
    while True:
        ok,frame=cap.read()
        if not ok: break
        frames.append(frame)
    cap.release()
    output_fps=30.0
    writer=cv2.VideoWriter(output_path,cv2.VideoWriter_fourcc(*"mp4v"),output_fps,(width,height))
    if not writer.isOpened(): raise RuntimeError(f"Could not create video: {output_path}")
    if speed_factor>1.0:
        index=0.0
        while int(index)<len(frames): writer.write(frames[int(index)]); index+=speed_factor
    elif speed_factor<1.0:
        index=0.0
        while int(index)<len(frames): writer.write(frames[int(index)]); index+=speed_factor
    else:
        for frame in frames: writer.write(frame)
    writer.release(); print("Created:",output_path)


def create_fps_video(input_path, output_path, target_fps):
    cap=cv2.VideoCapture(input_path)
    if not cap.isOpened(): raise Exception(f"Could not open source video: {input_path}")
    original_fps=cap.get(cv2.CAP_PROP_FPS); width=int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)); height=int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)); frames=[]
    while True:
        ok,frame=cap.read()
        if not ok: break
        frames.append(frame)
    cap.release()
    if not frames: raise Exception("No frames found in source video.")
    duration=len(frames)/original_fps; target_count=max(1,int(round(duration*target_fps)))
    writer=cv2.VideoWriter(output_path,cv2.VideoWriter_fourcc(*"mp4v"),float(target_fps),(width,height))
    if not writer.isOpened(): raise RuntimeError(f"Could not create video: {output_path}")
    for i in range(target_count): writer.write(frames[min(len(frames)-1,int(round(i*original_fps/target_fps)))])
    writer.release(); print("Created:",output_path)


def create_reordered_video(input_path, output_path):
    cap=cv2.VideoCapture(input_path)
    if not cap.isOpened(): raise Exception(f"Could not open source video: {input_path}")
    fps=cap.get(cv2.CAP_PROP_FPS); width=int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)); height=int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)); frames=[]
    while True:
        ok,frame=cap.read()
        if not ok: break
        frames.append(frame)
    cap.release()
    block_size=30
    for start in range(0,len(frames),block_size):
        end=min(start+block_size,len(frames))
        if end-start==block_size: frames[start:end]=list(reversed(frames[start:end]))
    writer=cv2.VideoWriter(output_path,cv2.VideoWriter_fourcc(*"mp4v"),fps,(width,height))
    if not writer.isOpened(): raise RuntimeError(f"Could not create video: {output_path}")
    for frame in frames: writer.write(frame)
    writer.release(); print("Created:",output_path)

def main():

    create_folders()

    print("\nCreating authentic video...")
    copy_authentic()

    print("\nCreating temporal test videos...")

    create_trimmed_video(
        os.path.join(
            OUTPUT,
            "temporal",
            "trimmed_beginning.mp4"
        ),
        3,
        10
    )

    create_trimmed_video(
        os.path.join(
            OUTPUT,
            "temporal",
            "extracted_segment.mp4"
        ),
        5,
        8
    )

    print("\nCreating additional temporal test videos...")
    temporal_dir=os.path.join(OUTPUT,"temporal")
    os.makedirs(temporal_dir,exist_ok=True)
    create_shifted_video(SOURCE,os.path.join(temporal_dir,"shifted_3_seconds.mp4"),3)
    create_speed_video(SOURCE,os.path.join(temporal_dir,"slower_playback.mp4"),0.8)
    create_speed_video(SOURCE,os.path.join(temporal_dir,"faster_playback.mp4"),1.1)
    create_fps_video(SOURCE,os.path.join(temporal_dir,"different_fps_15.mp4"),15)
    create_reordered_video(SOURCE,os.path.join(temporal_dir,"reordered_frames.mp4"))

    print("\nCreating transformation videos...")

    create_brightness_video(
        os.path.join(
            OUTPUT,
            "transformed",
            "brightness.mp4"
        ),
        30
    )

    create_contrast_video(
        os.path.join(
            OUTPUT,
            "transformed",
            "contrast.mp4"
        ),
        1.4
    )

    create_noise_video(
        os.path.join(
            OUTPUT,
            "transformed",
            "moderate_noise.mp4"
        )
    )

    create_salt_pepper_video(
        os.path.join(
            OUTPUT,
            "transformed",
            "salt_pepper.mp4"
        )
    )

    create_crop_video(
        os.path.join(
            OUTPUT,
            "transformed",
            "cropped.mp4"
        )
    )

    create_duplicate_frame_video(
        os.path.join(
            OUTPUT,
            "transformed",
            "duplicated_frames.mp4"
        )
    )

    create_missing_frame_video(
        os.path.join(
            OUTPUT,
            "transformed",
            "missing_frames.mp4"
        )
    )

    print("\nCreating FFmpeg transformation videos...")

    run_ffmpeg(
        "reencoded_h264.mp4",
        [
            "-c:v",
            "libx264",
            "-crf",
            "28"
        ]
    )

    run_ffmpeg(
        "low_bitrate.mp4",
        [
            "-c:v",
            "libx264",
            "-b:v",
            "500k"
        ]
    )

    run_ffmpeg(
        "high_compression.mp4",
        [
            "-c:v",
            "libx264",
            "-crf",
            "38"
        ]
    )

    run_ffmpeg(
        "resolution_half.mp4",
        [
            "-vf",
            "scale=iw/2:ih/2",
            "-c:v",
            "libx264",
            "-crf",
            "23"
        ]
    )

    run_ffmpeg(
        "fps_15.mp4",
        [
            "-vf",
            "fps=15",
            "-c:v",
            "libx264",
            "-crf",
            "23"
        ]
    )

    run_ffmpeg(
        "fps_60.mp4",
        [
            "-vf",
            "fps=60",
            "-c:v",
            "libx264",
            "-crf",
            "23"
        ]
    )

    run_ffmpeg(
        "watermark.mp4",
        [
            "-vf",
            "drawtext=text='TEST-WATERMARK':x=20:y=20:fontsize=32:fontcolor=white",
            "-c:v",
            "libx264",
            "-crf",
            "23"
        ]
    )

    run_ffmpeg(
        "h265_hevc.mp4",
        [
            "-c:v",
            "libx265",
            "-crf",
            "30"
        ]
    )

    print("\n========================================")
    print("DATASET CREATION COMPLETE")
    print("========================================")
    print(
        "Location:",
        os.path.abspath(OUTPUT)
    )


if __name__ == "__main__":
    main()
