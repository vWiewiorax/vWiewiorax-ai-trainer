/// Canonical, model-independent landmark set. Pose models are mapped onto these
/// names by adapters, so the rest of the engine never depends on a model topology.
const landmarkNames = <String>[
  'nose',
  'leftEye',
  'rightEye',
  'leftEar',
  'rightEar',
  'leftShoulder',
  'rightShoulder',
  'leftElbow',
  'rightElbow',
  'leftWrist',
  'rightWrist',
  'leftIndex',
  'rightIndex',
  'leftHip',
  'rightHip',
  'leftKnee',
  'rightKnee',
  'leftAnkle',
  'rightAnkle',
  'leftHeel',
  'rightHeel',
  'leftFootIndex',
  'rightFootIndex',
];

enum Side { left, right }

Side otherSide(Side s) => s == Side.left ? Side.right : Side.left;

/// e.g. sided(Side.left, 'Knee') == 'leftKnee'
String sided(Side side, String base) => '${side.name}$base';

/// Pairs swapped when an image is mirrored.
const mirrorPairs = <(String, String)>[
  ('leftEye', 'rightEye'),
  ('leftEar', 'rightEar'),
  ('leftShoulder', 'rightShoulder'),
  ('leftElbow', 'rightElbow'),
  ('leftWrist', 'rightWrist'),
  ('leftIndex', 'rightIndex'),
  ('leftHip', 'rightHip'),
  ('leftKnee', 'rightKnee'),
  ('leftAnkle', 'rightAnkle'),
  ('leftHeel', 'rightHeel'),
  ('leftFootIndex', 'rightFootIndex'),
];

/// Bones drawn by skeleton overlays.
const skeletonConnections = <(String, String)>[
  ('leftShoulder', 'rightShoulder'),
  ('leftShoulder', 'leftElbow'),
  ('leftElbow', 'leftWrist'),
  ('rightShoulder', 'rightElbow'),
  ('rightElbow', 'rightWrist'),
  ('leftShoulder', 'leftHip'),
  ('rightShoulder', 'rightHip'),
  ('leftHip', 'rightHip'),
  ('leftHip', 'leftKnee'),
  ('leftKnee', 'leftAnkle'),
  ('rightHip', 'rightKnee'),
  ('rightKnee', 'rightAnkle'),
  ('leftAnkle', 'leftHeel'),
  ('leftHeel', 'leftFootIndex'),
  ('leftAnkle', 'leftFootIndex'),
  ('rightAnkle', 'rightHeel'),
  ('rightHeel', 'rightFootIndex'),
  ('rightAnkle', 'rightFootIndex'),
  ('leftEar', 'leftShoulder'),
  ('rightEar', 'rightShoulder'),
];
