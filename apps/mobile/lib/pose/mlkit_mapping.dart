import 'package:google_mlkit_pose_detection/google_mlkit_pose_detection.dart' as ml;
import 'package:trainer_engine/trainer_engine.dart';

/// ML Kit landmark type -> canonical engine landmark name (same names as MediaPipe BlazePose).
String landmarkName(ml.PoseLandmarkType t) => t.name;

/// Converts an ML Kit pose (pixel coordinates in the upright image) into an engine PoseFrame.
/// [uprightWidth]/[uprightHeight] are the image size after applying the sensor rotation.
PoseFrame poseFrameFromMlKit({
  required ml.Pose? pose,
  required double timestampMs,
  required double uprightWidth,
  required double uprightHeight,
  required CameraFacing facing,
  double? inferenceMs,
  double? brightness,
}) {
  final landmarks = <String, Landmark>{};
  var conf = 0.0;
  if (pose != null) {
    for (final e in pose.landmarks.entries) {
      final name = landmarkName(e.key);
      if (!landmarkNames.contains(name)) continue;
      final l = e.value;
      landmarks[name] = Landmark(
        x: l.x / uprightWidth,
        y: l.y / uprightHeight,
        z: l.z / uprightWidth,
        visibility: l.likelihood,
      );
      conf += l.likelihood;
    }
    if (landmarks.isNotEmpty) conf /= landmarks.length;
  }
  return PoseFrame(
    timestamp: timestampMs,
    landmarks: landmarks,
    modelConfidence: conf,
    cameraMetadata: CameraMetadata(
      width: uprightWidth,
      height: uprightHeight,
      // ML Kit works on the raw (non-mirrored) sensor image; only the preview is mirrored.
      mirrored: false,
      facing: facing,
      rotation: 0,
      brightness: brightness,
    ),
    source: 'mlkit-pose',
    inferenceMs: inferenceMs,
  );
}
