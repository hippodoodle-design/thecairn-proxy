/**
 * Companion Zoo-life logic — personality draws, daily moods, zoo-keeper letters,
 * and the communal Visit Log. Pure functions; no DB or Redis. Wired into the
 * web pick/upload endpoints and the daily worker jobs.
 */
export {
  TRAITS,
  MOODS,
  GENERIC_UPLOAD_DISTRIBUTION,
  drawPersonality,
  drawUploadedPersonality,
  drawMood,
  traitsOf,
} from './personality.js';

export { petReference, generateLetter } from './letters.js';
export { generateDailyActivities } from './activities.js';
