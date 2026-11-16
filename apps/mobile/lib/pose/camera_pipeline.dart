import 'dart:async';
import 'dart:io';

import 'package:camera/camera.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:google_mlkit_pose_detection/google_mlkit_pose_detection.dart';
import 'package:trainer_engine/trainer_engine.dart' as eng;

import 'mlkit_mapping.dart';

/// Live camera -> on-device ML Kit pose detection -> engine [eng.PoseFrame]s.
/// Frames arriving while the previous one is still being processed are dropped.
class CameraPipeline {
  final CameraDescription camera;
  final ResolutionPreset resolution;
  final bool accurateModel;
  late final CameraController controller;
  late final PoseDetector _detector;
  bool _busy = false;
  bool _running = false;
  final _sw = Stopwatch()..start();
  void Function(eng.PoseFrame frame)? onFrame;

  CameraPipeline(this.camera, {this.resolution = ResolutionPreset.medium, this.accurateModel = false});

  bool get isFront => camera.lensDirection == CameraLensDirection.front;

  Future<void> initialize() async {
    controller = CameraController(
      camera,
      resolution,
      enableAudio: false,
      imageFormatGroup: Platform.isAndroid ? ImageFormatGroup.nv21 : ImageFormatGroup.bgra8888,
    );
    await controller.initialize();
    _detector = PoseDetector(
      options: PoseDetectorOptions(
        mode: PoseDetectionMode.stream,
        model: accurateModel ? PoseDetectionModel.accurate : PoseDetectionModel.base,
      ),
    );
  }

  Future<void> start() async {
    if (_running) return;
    _running = true;
    await controller.startImageStream(_onImage);
  }

  Future<void> stop() async {
    if (!_running) return;
    _running = false;
    if (controller.value.isStreamingImages) await controller.stopImageStream();
  }

  Future<void> dispose() async {
    await stop();
    await controller.dispose();
    await _detector.close();
  }

  Future<void> _onImage(CameraImage image) async {
    if (_busy || !_running) return;
    _busy = true;
    try {
      final rotation = _rotation();
      final input = _toInputImage(image, rotation);
      if (input == null) return;
      final ts = _sw.elapsedMicroseconds / 1000;
      final t0 = _sw.elapsedMicroseconds;
      final poses = await _detector.processImage(input);
      final inferMs = (_sw.elapsedMicroseconds - t0) / 1000;
      final quarter = rotation == InputImageRotation.rotation90deg || rotation == InputImageRotation.rotation270deg;
      final w = (quarter ? image.height : image.width).toDouble();
      final h = (quarter ? image.width : image.height).toDouble();
      onFrame?.call(poseFrameFromMlKit(
        pose: poses.isEmpty ? null : poses.first,
        timestampMs: ts,
        uprightWidth: w,
        uprightHeight: h,
        facing: isFront ? eng.CameraFacing.user : eng.CameraFacing.environment,
        inferenceMs: inferMs,
        brightness: _brightness(image),
      ));
    } catch (e) {
      debugPrint('pose detection failed: $e');
    } finally {
      _busy = false;
    }
  }

  static const _orientationDeg = {
    DeviceOrientation.portraitUp: 0,
    DeviceOrientation.landscapeLeft: 90,
    DeviceOrientation.portraitDown: 180,
    DeviceOrientation.landscapeRight: 270,
  };

  /// Rotation needed to make the sensor image upright for the current device orientation.
  InputImageRotation _rotation() {
    final sensor = camera.sensorOrientation;
    if (Platform.isIOS) return InputImageRotationValue.fromRawValue(sensor) ?? InputImageRotation.rotation0deg;
    final device = _orientationDeg[controller.value.deviceOrientation] ?? 0;
    final deg = isFront ? (sensor + device) % 360 : (sensor - device + 360) % 360;
    return InputImageRotationValue.fromRawValue(deg) ?? InputImageRotation.rotation0deg;
  }

  InputImage? _toInputImage(CameraImage image, InputImageRotation rotation) {
    final format = InputImageFormatValue.fromRawValue(image.format.raw as int);
    if (format == null) return null;
    if (Platform.isAndroid && format != InputImageFormat.nv21) return null;
    if (Platform.isIOS && format != InputImageFormat.bgra8888) return null;
    if (image.planes.length != 1) return null;
    final plane = image.planes.first;
    return InputImage.fromBytes(
      bytes: plane.bytes,
      metadata: InputImageMetadata(
        size: Size(image.width.toDouble(), image.height.toDouble()),
        rotation: rotation,
        format: format,
        bytesPerRow: plane.bytesPerRow,
      ),
    );
  }

  /// Mean luma in [0, 1] from a sparse sample (NV21: Y plane first; BGRA: green channel).
  double? _brightness(CameraImage image) {
    final b = image.planes.first.bytes;
    if (b.isEmpty) return null;
    final bgra = Platform.isIOS;
    final n = image.width * image.height;
    var sum = 0, count = 0;
    for (var i = 0; i < n; i += 997) {
      final idx = bgra ? i * 4 + 1 : i;
      if (idx >= b.length) break;
      sum += b[idx];
      count++;
    }
    return count == 0 ? null : sum / count / 255;
  }
}
