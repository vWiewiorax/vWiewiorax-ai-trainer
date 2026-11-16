
import 'package:flutter_test/flutter_test.dart';
import 'package:google_mlkit_pose_detection/google_mlkit_pose_detection.dart' as ml;
import 'package:ai_trainer_mobile/pose/mlkit_mapping.dart';
import 'package:trainer_engine/trainer_engine.dart';

void main() {
  test('every canonical engine landmark has an ML Kit counterpart', () {
    final mlNames = ml.PoseLandmarkType.values.map(landmarkName).toSet();
    for (final n in landmarkNames) {
      expect(mlNames, contains(n));
    }
  });

  test('ML Kit pixels are normalized to [0, 1] in the upright image', () {
    final pose = ml.Pose(landmarks: {
      ml.PoseLandmarkType.leftHip: ml.PoseLandmark(type: ml.PoseLandmarkType.leftHip, x: 240, y: 320, z: 0, likelihood: 0.9),
      ml.PoseLandmarkType.leftEyeInner: ml.PoseLandmark(type: ml.PoseLandmarkType.leftEyeInner, x: 1, y: 1, z: 0, likelihood: 1),
    });
    final f = poseFrameFromMlKit(
      pose: pose,
      timestampMs: 100,
      uprightWidth: 480,
      uprightHeight: 640,
      facing: CameraFacing.user,
    );
    expect(f.landmarks.keys, ['leftHip']);
    expect(f.landmarks['leftHip']!.x, 0.5);
    expect(f.landmarks['leftHip']!.y, 0.5);
    expect(f.landmarks['leftHip']!.visibility, 0.9);
    expect(f.cameraMetadata.mirrored, isFalse);
    expect(f.modelConfidence, 0.9);
  });

  test('no person yields an empty frame the engine treats as noPerson', () {
    final f = poseFrameFromMlKit(pose: null, timestampMs: 0, uprightWidth: 480, uprightHeight: 640, facing: CameraFacing.environment);
    final s = ExerciseAnalyzer(exercises.values.first).processFrame(f);
    expect(f.landmarks, isEmpty);
    expect(s.status, AnalyzerStatus.noPerson);
  });
}
