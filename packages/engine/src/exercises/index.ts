import type { ExerciseDefinition } from "../core/types";
import { deadlift } from "./deadlift";

export { deadlift };

export const EXERCISES: Record<string, ExerciseDefinition> = {
  [deadlift.id]: deadlift,
};

export function getExercise(id: string): ExerciseDefinition | undefined {
  return EXERCISES[id];
}
