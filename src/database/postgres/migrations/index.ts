/**
 * Every migration, oldest first. Add new migration classes at the end.
 */
import { InitSchema1761000000000 } from './1761000000000-init-schema.js';

/** Loaded by the data source; pending ones run on API startup. */
export const MIGRATIONS = [InitSchema1761000000000];
