import cv2
import os
import shutil
import subprocess
import numpy as np
from pathlib import Path
import random
import json
import hashlib
from fractions import Fraction


SOURCE = "videos/dashcam_test.mp4"
OUTPUT = "evaluation/dataset"
RANDOM_SEED = 20261004
OTHER_TRIP_SOURCE = "synthetic test video"


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
        if shutil.which("ffmpeg"):
            subprocess.run(command, check=True)
        else:
            create_transcoded_video(output_path, output_name)

        print(
            "Created:",
            output_path
        )

    except subprocess.CalledProcessError:

        print(
            "FFmpeg failed:",
            output_name
        )

    except Exception as exc:
        print(f"Codec scenario unavailable ({output_name}): {exc}")


def create_transcoded_video(output_path, output_name):
    """PyAV fallback for common FFmpeg scenarios, using installed codec support."""
    import av

    name = output_name.lower()
    codec = "libx265" if "h265" in name or "hevc" in name else "libx264"
    options = {}
    bitrate = None
    scale = 1.0
    target_fps = None
    watermark = "watermark" in name
    if "low_bitrate" in name: bitrate = 500_000
    elif "high_compression" in name: options["crf"] = "38"
    elif "reencoded" in name: options["crf"] = "28"
    elif "h265" in name: options["crf"] = "30"
    elif "resolution_half" in name: scale = .5
    elif "fps_15" in name: target_fps = 15
    elif "fps_60" in name: target_fps = 60

    source = av.open(str(SOURCE))
    input_stream = next((stream for stream in source.streams if stream.type == "video"), None)
    if input_stream is None:
        source.close()
        raise RuntimeError("The source has no video stream.")
    source_fps = float(input_stream.average_rate or 30)
    fps = target_fps or max(1, round(source_fps))
    width = max(2, int(input_stream.width * scale) // 2 * 2)
    height = max(2, int(input_stream.height * scale) // 2 * 2)
    output = av.open(str(output_path), mode="w", format="mp4")
    stream = output.add_stream(codec, rate=fps)
    stream.width, stream.height, stream.pix_fmt = width, height, "yuv420p"
    if bitrate is not None:
        stream.bit_rate = bitrate
    stream.options = options
    stream.time_base = Fraction(1, fps)
    output_index = 0
    try:
        for input_index, decoded in enumerate(source.decode(input_stream)):
            # Nearest-frame rate conversion, deterministic with no interpolation.
            target_count = round((input_index + 1) * fps / source_fps)
            while output_index < target_count:
                frame = decoded
                if (frame.width, frame.height) != (width, height):
                    frame = frame.reformat(width=width, height=height)
                if watermark:
                    image = frame.to_ndarray(format="bgr24")
                    cv2.putText(image, "TEST-WATERMARK", (20, 42), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 255), 2)
                    frame = av.VideoFrame.from_ndarray(image, format="bgr24")
                frame = frame.reformat(format="yuv420p")
                frame.pts = output_index
                frame.time_base = Fraction(1, fps)
                for packet in stream.encode(frame): output.mux(packet)
                output_index += 1
        for packet in stream.encode(): output.mux(packet)
    finally:
        source.close(); output.close()
    if not Path(output_path).exists() or Path(output_path).stat().st_size == 0:
        raise RuntimeError("Encoder did not create a playable output.")
    print("Created with PyAV:", output_path)



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


def create_end_trimmed_video(output_path, trim_seconds=3):
    """Create a clip with its ending removed (leave the beginning intact)."""
    cap = cv2.VideoCapture(SOURCE)
    if not cap.isOpened():
        raise RuntimeError(f"Could not open source video: {SOURCE}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.release()
    duration = frame_count / fps
    if duration <= trim_seconds + 1:
        raise ValueError("Source video is too short for end trimming.")
    create_trimmed_video(output_path, 0, duration - trim_seconds)


def create_synthetic_other_trip(output_path, seconds=8, fps=15):
    """Make a deterministic, visibly distinct test scene without outside data."""
    width, height = 640, 360
    writer = cv2.VideoWriter(output_path, cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))
    if not writer.isOpened():
        raise RuntimeError(f"Could not create synthetic test video: {output_path}")
    rng = np.random.default_rng(RANDOM_SEED)
    for index in range(seconds * fps):
        frame = np.zeros((height, width, 3), dtype=np.uint8)
        frame[:] = (30, 45, 100)
        cv2.rectangle(frame, (0, 220), (width, height), (45, 95, 40), -1)
        x = int((index * 9) % (width + 120)) - 60
        cv2.rectangle(frame, (x, 120), (x + 120, 235), (int(rng.integers(80, 240)), 90, 30), -1)
        cv2.putText(frame, "SYNTHETIC OTHER TRIP", (24, 45), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
        cv2.putText(frame, f"TEST FRAME {index:04d}", (24, 80), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (210, 230, 255), 1)
        writer.write(frame)
    writer.release()


def create_partially_modified_video(output_path, other_path):
    """Keep most original frames but replace the central 30% with another scene."""
    primary = cv2.VideoCapture(SOURCE)
    secondary = cv2.VideoCapture(other_path)
    if not primary.isOpened() or not secondary.isOpened():
        primary.release(); secondary.release()
        raise RuntimeError("Could not open source(s) for partial modification.")
    fps = primary.get(cv2.CAP_PROP_FPS) or 30.0
    width = int(primary.get(cv2.CAP_PROP_FRAME_WIDTH)); height = int(primary.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total = int(primary.get(cv2.CAP_PROP_FRAME_COUNT))
    start, end = int(total * .35), int(total * .65)
    writer = cv2.VideoWriter(output_path, cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))
    if not writer.isOpened():
        primary.release(); secondary.release()
        raise RuntimeError(f"Could not create partial video: {output_path}")
    index = 0
    while True:
        ok, frame = primary.read()
        if not ok: break
        if start <= index < end:
            other_ok, replacement = secondary.read()
            if other_ok:
                frame = cv2.resize(replacement, (width, height))
            else:
                # If the secondary clip ends, apply an obvious reproducible alteration.
                frame = cv2.convertScaleAbs(frame, alpha=.35, beta=80)
        writer.write(frame)
        index += 1
    primary.release(); secondary.release(); writer.release()
    if index == 0:
        raise RuntimeError("No source frames were read for partial modification.")


def find_distinct_trip_source():
    """Prefer another valid local trip; ignore byte-identical opening frames."""
    source_path = Path(SOURCE).resolve()
    source = cv2.VideoCapture(str(source_path))
    ok, source_frame = source.read() if source.isOpened() else (False, None)
    source.release()
    if not ok:
        return None
    source_digest = hashlib.sha256(source_frame.tobytes()).digest()
    for candidate in sorted(Path("videos").glob("*.mp4")):
        if candidate.resolve() == source_path:
            continue
        cap = cv2.VideoCapture(str(candidate))
        valid, frame = cap.read() if cap.isOpened() else (False, None)
        cap.release()
        if valid and hashlib.sha256(frame.tobytes()).digest() != source_digest:
            return candidate
    return None


def write_manifest():
    """Record which generated files exist and how synthetic trips were sourced."""
    scenarios = []
    for path in sorted(Path(OUTPUT).rglob("*.mp4")):
        if path.name == "authentic.mp4":
            continue
        rel = path.relative_to(OUTPUT).as_posix()
        lower = path.stem.lower()
        category = ("another_trip" if "other_trip" in lower else
                    "partially_modified" if "partially_modified" in lower else
                    "end_trimmed" if "trimmed_end" in lower else
                    "missing_frames" if "missing" in lower else
                    "modified" if any(x in lower for x in ("noise", "watermark", "modified")) else
                    "transformed" if path.parent.name == "transformed" else "temporal")
        scenarios.append({"file": rel, "category": category})
    manifest = {
        "format_version": 1,
        "reference": "authentic/authentic.mp4",
        "source": str(Path(SOURCE).as_posix()),
        "random_seed": RANDOM_SEED,
        "other_trip_source": OTHER_TRIP_SOURCE,
        "scenarios": scenarios,
        "limitations": ["The synthetic other-trip clip is not real dashcam footage.", "Optional FFmpeg codec cases are absent when their encoder is unavailable."],
    }
    Path(OUTPUT, "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

def main():

    global OTHER_TRIP_SOURCE

    random.seed(RANDOM_SEED)
    np.random.seed(RANDOM_SEED)

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

    create_end_trimmed_video(os.path.join(OUTPUT, "temporal", "trimmed_end.mp4"))

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

    print("\nCreating other-trip and partially modified scenarios...")
    other_path = os.path.join(OUTPUT, "other", "other_trip_synthetic.mp4")
    os.makedirs(os.path.dirname(other_path), exist_ok=True)
    trip_source = find_distinct_trip_source()
    if trip_source:
        shutil.copy2(trip_source, other_path)
        OTHER_TRIP_SOURCE = str(trip_source)
        print("Using distinct local trip as other-trip scenario:", trip_source)
    else:
        create_synthetic_other_trip(other_path)
    create_partially_modified_video(os.path.join(OUTPUT, "transformed", "partially_modified.mp4"), other_path)

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

    write_manifest()


if __name__ == "__main__":
    main()
