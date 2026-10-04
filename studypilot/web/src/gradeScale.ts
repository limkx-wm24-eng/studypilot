export const GRADE_SCALE = {
  A: 4.0000,
  'A−': 3.7500,
  'B+': 3.5000,
  B: 3.0000,
  'B−': 2.7500,
  'C+': 2.5000,
  C: 2.0000,
} as const;

export type LetterGrade = keyof typeof GRADE_SCALE;
export const LETTER_GRADES = Object.keys(GRADE_SCALE) as LetterGrade[];
