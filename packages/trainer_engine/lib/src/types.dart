import 'geometry.dart';
import 'landmarks.dart';

/// Landmark in normalized image coordinates (x, y in [0, 1], y down).
class Landmark {
  final double x;
  final double y;
  final double? z;
  final double visibility;
  final double? presence;
  const Landmark({required this.x, required this.y, this.z, required this.visibility, this.presence});

  factory Landmark.fromJson(Map<String, dynamic> j) => Landmark(
        x: (j['x'] as num).toDouble(),
        y: (j['y'] as num).toDouble(),
        z: (j['z'] as num?)?.toDouble(),
        visibility: (j['visibility'] as num?)?.toDouble() ?? 1,
        presence: (j['presence'] as num?)?.toDouble(),
      );
}

enum CameraFacing { user, environment, unknown }

class CameraMetadata {
  final double width;
  final double height;
  final bool mirrored;
  final CameraFacing facing;

  /// Clockwise rotation (0/90/180/270) that makes the image upright.
  final int rotation;
  final double? brightness;
  final bool sceneCut;
  const CameraMetadata({
    required this.width,
    required this.height,
    this.mirrored = false,
    this.facing = CameraFacing.unknown,
    this.rotation = 0,
    this.brightness,
    this.sceneCut = false,
  });

  factory CameraMetadata.fromJson(Map<String, dynamic> j) => CameraMetadata(
        width: (j['width'] as num).toDouble(),
        height: (j['height'] as num).toDouble(),
        mirrored: j['mirrored'] as bool? ?? false,
        facing: CameraFacing.values.firstWhere((f) => f.name == j['facing'], orElse: () => CameraFacing.unknown),
        rotation: (j['rotation'] as num?)?.toInt() ?? 0,
        brightness: (j['brightness'] as num?)?.toDouble(),
        sceneCut: j['sceneCut'] as bool? ?? false,
      );
}

class PoseFrame {
  /// Monotonic timestamp in milliseconds.
  final double timestamp;
  final Map<String, Landmark> landmarks;
  final double modelConfidence;
  final CameraMetadata cameraMetadata;
  final String? source;
  final double? inferenceMs;
  const PoseFrame({
    required this.timestamp,
    required this.landmarks,
    required this.modelConfidence,
    required this.cameraMetadata,
    this.source,
    this.inferenceMs,
  });

  factory PoseFrame.fromJson(Map<String, dynamic> j) => PoseFrame(
        timestamp: (j['timestamp'] as num).toDouble(),
        landmarks: {
          for (final e in (j['landmarks'] as Map<String, dynamic>).entries)
            e.key: Landmark.fromJson(e.value as Map<String, dynamic>),
        },
        modelConfidence: (j['modelConfidence'] as num?)?.toDouble() ?? 1,
        cameraMetadata: CameraMetadata.fromJson(j['cameraMetadata'] as Map<String, dynamic>),
        source: j['source'] as String?,
        inferenceMs: (j['inferenceMs'] as num?)?.toDouble(),
      );
}

/// A point in aspect-corrected camera space (units = image heights).
class Point extends V2 {
  final double? z;
  final double confidence;
  final bool interpolated;
  const Point(super.x, super.y, {this.z, required this.confidence, this.interpolated = false});

  Point withConfidence(double c) => Point(x, y, z: z, confidence: c, interpolated: interpolated);
}

typedef Pose = Map<String, Point>;

class NormalizedFrame {
  final double timestamp;
  final Pose points;
  final double aspect;
  final double modelConfidence;
  final CameraMetadata cameraMetadata;
  final double? inferenceMs;
  const NormalizedFrame({
    required this.timestamp,
    required this.points,
    required this.aspect,
    required this.modelConfidence,
    required this.cameraMetadata,
    this.inferenceMs,
  });
}

enum CameraView {
  side('side'),
  front('front'),
  rear('rear'),
  frontSide('front-side'),
  unknown('unknown');

  final String id;
  const CameraView(this.id);
}

class Measurement {
  final double value;
  final double confidence;
  const Measurement(this.value, this.confidence);
}

typedef FeatureMap = Map<String, Measurement>;

class BiomechanicalFrame {
  final double timestamp;
  final FeatureMap jointAngles;
  final FeatureMap alignmentMetrics;
  final FeatureMap movementVelocities;
  final Map<String, Point> trajectories;
  final double confidence;
  final CameraView view;
  final Side nearSide;
  final FeatureMap features;
  const BiomechanicalFrame({
    required this.timestamp,
    required this.jointAngles,
    required this.alignmentMetrics,
    required this.movementVelocities,
    required this.trajectories,
    required this.confidence,
    required this.view,
    required this.nearSide,
    required this.features,
  });
}

/* ---------------- Exercise definitions ---------------- */

enum Severity { low, moderate, high }

const severityRank = {Severity.low: 1, Severity.moderate: 2, Severity.high: 3};

enum PhaseKind { start, concentric, end, eccentric }

class PhaseDefinition {
  final String id;
  final PhaseKind kind;
  final String label;
  const PhaseDefinition(this.id, this.kind, this.label);
}

class RepPhases {
  final String low;
  final String rising;
  final String high;
  final String falling;
  const RepPhases({required this.low, required this.rising, required this.high, required this.falling});

  String byState(String state) => switch (state) { 'low' => low, 'rising' => rising, 'high' => high, _ => falling };
}

class RepetitionConfig {
  final String signal;

  /// 'low' | 'high'
  final String startPosition;
  final double highThreshold;
  final double lowThreshold;
  final double hysteresis;
  final double minPhaseMs;
  final double minRepMs;
  final double maxRepMs;
  final double minRange;
  final RepPhases phases;

  /// 'low' | 'high'
  final String countAt;
  final bool requireReturn;
  final String? onsetFeature;
  final double? onsetEpsilon;
  const RepetitionConfig({
    required this.signal,
    required this.startPosition,
    required this.highThreshold,
    required this.lowThreshold,
    required this.hysteresis,
    required this.minPhaseMs,
    required this.minRepMs,
    required this.maxRepMs,
    required this.minRange,
    required this.phases,
    required this.countAt,
    this.requireReturn = false,
    this.onsetFeature,
    this.onsetEpsilon,
  });
}

/// Rule condition; [kind] selects which fields are used:
/// stat, duration, deltaRatio, asymmetry, tempoConsistency, baseline.
class RuleCondition {
  final String kind;

  /// Phase id, or 'rep' for the whole repetition.
  final String phase;
  final (double, double)? window;
  final String? feature;

  /// min | max | mean | range | start | end | delta | maxAbsDiff | meanAbsDiff
  final String? stat;

  /// '>' | '<'
  final String? compare;
  final double threshold;
  final double thresholdMs;
  final (double, double) bands;
  final String? numerator;
  final String? denominator;
  final double minDenominator;
  final double? minNumerator;
  final String? left;
  final String? right;
  final double tolerance;
  final int minPreviousReps;

  const RuleCondition({
    required this.kind,
    required this.phase,
    this.window,
    this.feature,
    this.stat,
    this.compare,
    this.threshold = 0,
    this.thresholdMs = 0,
    required this.bands,
    this.numerator,
    this.denominator,
    this.minDenominator = 0,
    this.minNumerator,
    this.left,
    this.right,
    this.tolerance = 0,
    this.minPreviousReps = 0,
  });

  const RuleCondition.stat({
    required this.phase,
    required String this.feature,
    required String this.stat,
    required String this.compare,
    required this.threshold,
    required this.bands,
    this.window,
  })  : kind = 'stat',
        thresholdMs = 0,
        numerator = null,
        denominator = null,
        minDenominator = 0,
        minNumerator = null,
        left = null,
        right = null,
        tolerance = 0,
        minPreviousReps = 0;
}

/// Instant per-frame check of a min/max "stat" rule while the repetition is running.
class LiveCheck {
  final String rule;
  final List<String> phases;
  final double persistMs;
  const LiveCheck(this.rule, this.phases, this.persistMs);
}

class Adjustable {
  final double min;
  final double max;
  const Adjustable(this.min, this.max);
}

class ErrorDefinition {
  final String type;
  final String category;
  final double importance;
  final List<CameraView> views;
  final double reliability;
  final double minConfidence;
  final RuleCondition condition;
  final String description;
  final String correction;
  final String voice;
  final String? recommendedAction;
  final bool safetyCritical;
  final Adjustable? adjustable;
  final String label;
  const ErrorDefinition({
    required this.type,
    required this.label,
    required this.category,
    required this.importance,
    required this.views,
    required this.reliability,
    required this.minConfidence,
    required this.condition,
    required this.description,
    required this.correction,
    required this.voice,
    this.recommendedAction,
    this.safetyCritical = false,
    this.adjustable,
  });
}

class RecognitionPredicate {
  final String feature;
  final String stat;
  final double? min;
  final double? max;
  final double weight;
  const RecognitionPredicate({required this.feature, required this.stat, this.min, this.max, required this.weight});
}

class ExerciseDefinition {
  final String id;
  final String name;
  final String family;
  final List<String> requiredLandmarks;

  /// 'near' | 'both'
  final String requireSides;
  final CameraView preferredCameraAngle;
  final List<CameraView> allowedCameraAngles;
  final String cameraSetup;

  /// 'standing' | 'any'
  final String calibrationPose;
  final List<String> occludableLandmarks;
  final List<PhaseDefinition> movementPhases;
  final RepetitionConfig repetition;
  final List<ErrorDefinition> evaluationRules;
  final Map<String, double> scoringConfiguration;
  final List<RecognitionPredicate> recognition;
  final List<String> comparisonFeatures;
  final List<LiveCheck> liveChecks;
  final List<String> keyCheckpoints;
  const ExerciseDefinition({
    required this.id,
    required this.name,
    required this.family,
    required this.requiredLandmarks,
    required this.requireSides,
    required this.preferredCameraAngle,
    required this.allowedCameraAngles,
    required this.cameraSetup,
    required this.calibrationPose,
    this.occludableLandmarks = const [],
    required this.movementPhases,
    required this.repetition,
    required this.evaluationRules,
    required this.scoringConfiguration,
    required this.recognition,
    required this.comparisonFeatures,
    this.liveChecks = const [],
    required this.keyCheckpoints,
  });

  ErrorDefinition? rule(String type) {
    for (final r in evaluationRules) {
      if (r.type == type) return r;
    }
    return null;
  }

  PhaseDefinition? phase(String id) {
    for (final p in movementPhases) {
      if (p.id == id) return p;
    }
    return null;
  }
}

/* ---------------- Results ---------------- */

class MeasuredValue {
  final double value;
  final double threshold;
  final String unit;
  const MeasuredValue(this.value, this.threshold, this.unit);
}

class TechniqueError {
  final String id;
  final String type;
  final String exercise;
  final String phase;
  final Severity severity;
  final double confidence;
  final double startTimestamp;
  final double endTimestamp;
  final String description;
  final String correctiveFeedback;
  final String voiceCue;
  final String? recommendedAction;
  final String category;
  final MeasuredValue? measured;
  final int? repIndex;
  const TechniqueError({
    required this.id,
    required this.type,
    required this.exercise,
    required this.phase,
    required this.severity,
    required this.confidence,
    required this.startTimestamp,
    required this.endTimestamp,
    required this.description,
    required this.correctiveFeedback,
    required this.voiceCue,
    this.recommendedAction,
    required this.category,
    this.measured,
    this.repIndex,
  });

  TechniqueError copyWith({String? id, int? repIndex, double? confidence, Severity? severity}) => TechniqueError(
        id: id ?? this.id,
        type: type,
        exercise: exercise,
        phase: phase,
        severity: severity ?? this.severity,
        confidence: confidence ?? this.confidence,
        startTimestamp: startTimestamp,
        endTimestamp: endTimestamp,
        description: description,
        correctiveFeedback: correctiveFeedback,
        voiceCue: voiceCue,
        recommendedAction: recommendedAction,
        category: category,
        measured: measured,
        repIndex: repIndex ?? this.repIndex,
      );
}

class PhaseSpan {
  final String id;
  final PhaseKind kind;
  final double startTimestamp;
  double endTimestamp;
  PhaseSpan(this.id, this.kind, this.startTimestamp, this.endTimestamp);
}

class CategoryScore {
  final String category;
  final double weight;
  final double score;
  final bool measured;
  final String? reason;
  const CategoryScore(
      {required this.category, required this.weight, required this.score, required this.measured, this.reason});
}

class Unmeasured {
  final String rule;
  final String reason;
  const Unmeasured(this.rule, this.reason);
}

class ScoreBreakdown {
  final int? score;
  final int? scoreUncertainty;
  final double analysisConfidence;
  final List<CategoryScore> categories;
  final List<Unmeasured> unmeasured;
  const ScoreBreakdown({
    required this.score,
    required this.scoreUncertainty,
    required this.analysisConfidence,
    required this.categories,
    required this.unmeasured,
  });
}

class MetricSummary {
  final double min;
  final double max;
  final double mean;
  const MetricSummary(this.min, this.max, this.mean);
}

class RepSeries {
  final List<double> t;
  final Map<String, List<double?>> features;
  const RepSeries(this.t, this.features);
}

class ExerciseRepetition {
  final String id;
  final int index;
  final double startTimestamp;
  final double endTimestamp;
  final double durationMs;
  final List<PhaseSpan> phases;
  final Map<String, MetricSummary> biomechanicalMetrics;
  final List<TechniqueError> detectedErrors;
  final int? techniqueScore;
  final double analysisConfidence;
  final ScoreBreakdown breakdown;
  final bool incomplete;
  final RepSeries series;
  const ExerciseRepetition({
    required this.id,
    required this.index,
    required this.startTimestamp,
    required this.endTimestamp,
    required this.durationMs,
    required this.phases,
    required this.biomechanicalMetrics,
    required this.detectedErrors,
    required this.techniqueScore,
    required this.analysisConfidence,
    required this.breakdown,
    required this.incomplete,
    required this.series,
  });
}

enum CalibrationStatus { notStarted, positioning, calibrating, ready, insufficientVisibility, incorrectCameraAngle }

class CameraQuality {
  final CameraView view;
  final double viewConfidence;
  final double meanVisibility;
  final double usableFrameRatio;
  final double? brightness;
  final List<String> issues;
  const CameraQuality({
    required this.view,
    required this.viewConfidence,
    required this.meanVisibility,
    required this.usableFrameRatio,
    this.brightness,
    required this.issues,
  });
}

class ProcessingMetrics {
  final int framesReceived;
  final int framesAnalysed;
  final double meanEngineMs;
  final double p95EngineMs;
  final double? meanInferenceMs;
  final double effectiveFps;
  const ProcessingMetrics({
    required this.framesReceived,
    required this.framesAnalysed,
    required this.meanEngineMs,
    required this.p95EngineMs,
    this.meanInferenceMs,
    required this.effectiveFps,
  });
}

class AggregatedError {
  final String type;
  final String label;
  final String category;
  final int count;
  final List<int> repIndices;
  final Severity maxSeverity;
  final double meanConfidence;
  final String correction;
  final String description;
  const AggregatedError({
    required this.type,
    required this.label,
    required this.category,
    required this.count,
    required this.repIndices,
    required this.maxSeverity,
    required this.meanConfidence,
    required this.correction,
    required this.description,
  });
}

class RecognitionAlternative {
  final String exercise;
  final double confidence;
  const RecognitionAlternative(this.exercise, this.confidence);
}

class RecognitionResult {
  final String? detectedExercise;
  final double confidence;
  final List<RecognitionAlternative> alternatives;
  final bool? matchesExpected;
  const RecognitionResult(
      {required this.detectedExercise,
      required this.confidence,
      required this.alternatives,
      required this.matchesExpected});
}

class Tempo {
  final double? meanConcentricMs;
  final double? meanEccentricMs;
  final double? meanRepMs;
  const Tempo(this.meanConcentricMs, this.meanEccentricMs, this.meanRepMs);
}

class TechniqueAnalysis {
  final String exerciseId;
  final int repetitionCount;
  final int partialRepetitions;
  final List<ExerciseRepetition> repetitions;
  final int? averageTechniqueScore;
  final double analysisConfidence;
  final List<AggregatedError> detectedErrors;
  final int? bestRepetition;
  final int? worstRepetition;
  final int? consistency;
  final Tempo tempo;
  final List<String> recommendations;
  final CameraQuality cameraQuality;
  final ProcessingMetrics processingMetrics;
  final RecognitionResult recognition;
  final List<String> safetyNotes;
  final String engineVersion;
  const TechniqueAnalysis({
    required this.exerciseId,
    required this.repetitionCount,
    required this.partialRepetitions,
    required this.repetitions,
    required this.averageTechniqueScore,
    required this.analysisConfidence,
    required this.detectedErrors,
    required this.bestRepetition,
    required this.worstRepetition,
    required this.consistency,
    required this.tempo,
    required this.recommendations,
    required this.cameraQuality,
    required this.processingMetrics,
    required this.recognition,
    required this.safetyNotes,
    required this.engineVersion,
  });
}
